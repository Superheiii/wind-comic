import { API_CONFIG } from '@/lib/config';
import { FetchTimeoutError, fetchWithTimeout } from '@/lib/fetch-timeout';
import { normalizeBaseURL } from '@/lib/base-url';
import { ImageProviderError } from './errors';
import type {
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGenerationResult,
  ImageProviderCapabilities,
  ProviderHealthResult,
  UnifiedImageProvider,
} from './types';

const QWEN_GENERATION_PATH = '/services/aigc/multimodal-generation/generation';
const QWEN_MODELS_PATH = '/models';
const GENERATION_TIMEOUT_MS = 90_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

export const SUPPORTED_QWEN_IMAGE_MODELS = [
  'qwen-image-3.0',
  'qwen-image-3.0-pro',
  'qwen-image-2.0',
] as const;

/** 2.0 的固定画幅兼容映射，保留既有试拍输出行为。 */
const QWEN_2_SIZE_BY_ASPECT: Record<string, string> = {
  '16:9': '2688*1536',
  '9:16': '1536*2688',
  '1:1': '2048*2048',
  '4:3': '2368*1728',
  '3:4': '1728*2368',
  '2.35:1': '2048*872',
};

/** 3.0 仅在调用方指定画幅时传入尺寸；未指定时交由模型自动推荐。 */
const QWEN_3_SIZE_BY_ASPECT: Record<string, string> = {
  '16:9': '1920*1080',
  '9:16': '1080*1920',
  '1:1': '1536*1536',
  '4:3': '1920*1440',
  '3:4': '1440*1920',
  '2.35:1': '2048*872',
};

type QwenConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

type QwenResponse = {
  request_id?: string;
  code?: string;
  message?: string;
  output?: {
    rewrite_status?: string;
    models?: Array<{ model?: string }>;
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: Array<{ image?: string }>;
      };
    }>;
  };
  usage?: {
    width?: number;
    height?: number;
    image_count?: number;
    output_width?: number;
    output_height?: number;
    output_image_count?: number;
    input_image_count?: number;
  };
};

function currentConfig(): QwenConfig {
  return API_CONFIG.image.qwen;
}

/**
 * DashScope 原生 API 基址必须以 /api/v1 结束。
 * 兼容用户填写域名根路径或完整原生 API 基址，避免意外拼出 /api/v1/api/v1。
 */
function qwenApiBaseURL(baseURL: string): string {
  const normalized = normalizeBaseURL(baseURL);
  return /\/api\/v1$/i.test(normalized) ? normalized : `${normalized}/api/v1`;
}

/** Provider 只在已归一化的原生 API 基址后拼官方资源路径。 */
function endpoint(baseURL: string, path: string): string {
  return `${qwenApiBaseURL(baseURL)}${path}`;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function isQwenImageInput(value: unknown): value is string {
  return isHttpUrl(value) || (typeof value === 'string' && /^data:image\/[^;]+;base64,/i.test(value));
}

function isQwen3Model(model: string): boolean {
  return model === 'qwen-image-3.0' || model === 'qwen-image-3.0-pro';
}

/** 统一将上游 HTTP/业务错误折叠为项目现有的图片 Provider 错误体系。 */
function qwenError(status: number, body: QwenResponse | undefined): ImageProviderError {
  const upstreamCode = body?.code || '';
  if (status === 401 || status === 403 || /InvalidApiKey|AccessDenied|Unauthorized/i.test(upstreamCode)) {
    return new ImageProviderError('AUTH_FAILED', 'Qwen 图片服务鉴权失败，请检查 API Key、地域与服务地址是否匹配。', 'qwen');
  }
  if (status === 429 || /Throttling|RateLimit/i.test(upstreamCode)) {
    return new ImageProviderError('RATE_LIMITED', 'Qwen 图片服务当前限流，请稍后再试。', 'qwen');
  }
  if (status >= 500) {
    return new ImageProviderError('IMAGE_PROVIDER_UNAVAILABLE', 'Qwen 图片服务暂时不可用，请稍后重试。', 'qwen');
  }
  return new ImageProviderError('IMAGE_GENERATION_FAILED', 'Qwen 图片生成失败，请检查提示词和模型配置后重试。', 'qwen');
}

async function readJson(response: Response): Promise<QwenResponse | undefined> {
  try {
    return await response.json() as QwenResponse;
  } catch {
    return undefined;
  }
}

function requestedSize(request: ImageGenerateRequest, model: string): string | undefined {
  if (Number.isInteger(request.width) && Number.isInteger(request.height) && request.width! > 0 && request.height! > 0) {
    return `${request.width}*${request.height}`;
  }
  const sizes = isQwen3Model(model) ? QWEN_3_SIZE_BY_ASPECT : QWEN_2_SIZE_BY_ASPECT;
  if (!request.aspectRatio) return undefined;
  return sizes[request.aspectRatio] || undefined;
}

function requestedCount(count: number | undefined): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(6, Math.floor(count!)));
}

function extractImages(body: QwenResponse, request: ImageGenerateRequest): ImageGenerationResult['images'] {
  const urls = (body.output?.choices || [])
    .flatMap((choice) => choice.message?.content || [])
    .map((item) => item.image)
    .filter(isHttpUrl);

  return urls.map((url) => ({
    url,
    width: body.usage?.output_width || body.usage?.width,
    height: body.usage?.output_height || body.usage?.height,
    seed: request.seed,
    metadata: body.request_id || body.output?.rewrite_status
      ? { requestId: body.request_id, rewriteStatus: body.output?.rewrite_status }
      : undefined,
  }));
}

/** 上游优先使用响应体 request_id；仅在缺失时读取安全的请求追踪响应头。 */
function responseRequestId(response: Response, body: QwenResponse | undefined): string | undefined {
  return body?.request_id || response.headers.get('x-request-id') || response.headers.get('x-dashscope-request-id') || undefined;
}

/** 模型查询是精确筛选，200 仍需确认目标模型确实在当前业务空间可用。 */
function hasModel(body: QwenResponse | undefined, model: string): boolean {
  return body?.output?.models?.some((item) => item.model === model) === true;
}

/** 健康检测的状态文案按 HTTP 状态细分，避免把配置问题伪装成生成失败。 */
function healthFailureMessage(status: number): string {
  if (status === 401) return 'Qwen API Key 无效，或 API Key 与 Region / Workspace 不匹配。';
  if (status === 403) return '当前 API Key 没有对应 Workspace 或 Qwen-Image 模型权限。';
  if (status === 404) return 'Qwen 图片服务地址或 API 路径错误。';
  if (status === 429) return 'Qwen 图片服务当前限流，请稍后重试。';
  if (status >= 500) return 'Qwen 图片服务异常，请稍后重试。';
  return `Qwen 模型查询失败（HTTP ${status}）。`;
}

/** 合并统一请求中的参考图字段，并保留调用方给出的顺序。 */
function collectReferenceImages(request: ImageGenerateRequest): string[] {
  return [
    ...(request.referenceImages || []),
    ...(request.characterReferences || []),
    ...(request.styleReferences || []),
  ];
}

/** 3.0 图生图的 content 必须先给 1–3 张图，再给唯一的一条编辑文本。 */
function buildContent(model: string, request: ImageGenerateRequest): Array<{ image?: string; text?: string }> {
  const references = collectReferenceImages(request);
  if (references.length === 0) return [{ text: request.prompt }];
  if (!isQwen3Model(model)) {
    throw new ImageProviderError('IMAGE_EDIT_NOT_SUPPORTED', 'Qwen-Image 2.0 当前仅保持文生图兼容；参考图编辑请切换到 Qwen-Image 3.0。', 'qwen');
  }
  if (references.length > 3) {
    throw new ImageProviderError('INVALID_REFERENCE_IMAGE', 'Qwen-Image 3.0 最多支持 3 张参考图。', 'qwen');
  }
  if (!references.every(isQwenImageInput)) {
    throw new ImageProviderError('INVALID_REFERENCE_IMAGE', 'Qwen 参考图必须是公网图片 URL 或 data:image Base64。', 'qwen');
  }
  return [...references.map((image) => ({ image })), { text: request.prompt }];
}

/**
 * Qwen-Image 2.0 / 3.0 的百炼同步适配器。
 * 上游的 choices/message/content 格式只在此处解析，下游始终只消费统一 images[].url。
 */
export class QwenImageProvider implements UnifiedImageProvider {
  readonly id = 'qwen';
  readonly name = 'Qwen-Image';

  models = (): string[] => {
    const configured = currentConfig().model;
    return Array.from(new Set([configured, ...SUPPORTED_QWEN_IMAGE_MODELS]));
  };

  isConfigured = (): boolean => Boolean(currentConfig().apiKey.trim());

  getCapabilities = (): ImageProviderCapabilities => {
    const isThree = isQwen3Model(currentConfig().model);
    return {
      textToImage: true,
      // 3.0 系列使用同一条已核对的同步契约支持图生图和编辑；2.0 保持既有文生图兼容。
      imageToImage: isThree,
      imageEdit: isThree,
      referenceImages: isThree,
      multiReference: isThree,
      characterReference: isThree,
      styleReference: isThree,
      controlNet: false,
      lora: false,
      supportsSeed: true,
      supportsNegativePrompt: true,
      supportedAspectRatios: Object.keys(isThree ? QWEN_3_SIZE_BY_ASPECT : QWEN_2_SIZE_BY_ASPECT),
      ...(isThree ? { maxReferenceImages: 3 } : {}),
    };
  };

  /**
   * 使用官方同步接口完成文生图或 3.0 图生图；该接口无需任务轮询。
   * 任何未拿到可用 URL 的结果都会抛出统一错误，调用方自然不会继续交给 H3。
   */
  async generate(request: ImageGenerateRequest): Promise<ImageGenerationResult> {
    const config = currentConfig();
    if (!config.apiKey.trim()) {
      throw new ImageProviderError('IMAGE_PROVIDER_NOT_CONFIGURED', 'Qwen 图片服务未配置，请先设置 QWEN_IMAGE_API_KEY。', this.id);
    }
    if (!config.baseURL.trim()) {
      throw new ImageProviderError('IMAGE_PROVIDER_NOT_CONFIGURED', 'Qwen 图片服务地址未配置。', this.id);
    }
    if (!request.prompt.trim()) {
      throw new ImageProviderError('IMAGE_GENERATION_FAILED', 'Qwen 图片生成缺少提示词。', this.id);
    }
    const model = request.model || config.model;
    const content = buildContent(model, request);
    const size = requestedSize(request, model);
    const payload = {
      model,
      input: {
        messages: [{
          role: 'user',
          content,
        }],
      },
      parameters: {
        n: requestedCount(request.count),
        prompt_extend: true,
        watermark: false,
        ...(size ? { size } : {}),
        ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
        ...(Number.isInteger(request.seed) ? { seed: request.seed } : {}),
      },
    };

    let response: Response;
    try {
      console.info(`[qwen-image] submit provider=qwen model=${model}`);
      response = await fetchWithTimeout(endpoint(config.baseURL, QWEN_GENERATION_PATH), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
      }, GENERATION_TIMEOUT_MS);
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';
      console.warn(`[qwen-image] request failed provider=qwen model=${model} error=${reason}`);
      if (error instanceof FetchTimeoutError) {
        throw new ImageProviderError('IMAGE_PROVIDER_UNAVAILABLE', 'Qwen 图片生成请求超时，请稍后重试。', this.id);
      }
      throw new ImageProviderError('IMAGE_PROVIDER_UNAVAILABLE', '无法连接 Qwen 图片服务，请检查服务地址后重试。', this.id);
    }

    const body = await readJson(response);
    if (!response.ok || body?.code) {
      console.warn(`[qwen-image] response provider=qwen model=${model} status=${response.status} requestId=${body?.request_id || 'none'} code=${body?.code || 'none'}`);
      throw qwenError(response.status, body);
    }

    const images = body ? extractImages(body, request) : [];
    if (images.length === 0) {
      console.warn(`[qwen-image] invalid-response provider=qwen model=${model} status=${response.status} requestId=${body?.request_id || 'none'} choices=${Boolean(body?.output?.choices?.length)}`);
      throw new ImageProviderError('IMAGE_GENERATION_FAILED', 'Qwen 图片生成未返回可用图片地址。', this.id);
    }

    console.info(`[qwen-image] completed provider=qwen model=${model} status=${response.status} requestId=${body?.request_id || 'none'} images=${images.length}`);
    return {
      provider: this.id,
      model,
      images,
      // 同步接口没有 taskId，仅保留用于追踪的安全 requestId 与结束原因。
      raw: {
        requestId: body?.request_id,
        rewriteStatus: body?.output?.rewrite_status,
        finishReasons: body?.output?.choices?.map((choice) => choice.finish_reason).filter(Boolean),
      },
    };
  }

  /** 统一编辑入口复用 generate，确保下游始终只获得 ImageGenerationResult。 */
  async edit(request: ImageEditRequest): Promise<ImageGenerationResult> {
    return this.generate({
      ...request,
      referenceImages: [request.imageUrl, ...(request.referenceImages || [])],
    });
  }

  /**
   * 使用官方 models 接口做零计费连通性检查。
   * 仅回传脱敏状态，不向前端传递上游响应内容、请求头或 API Key。
   */
  async healthCheck(): Promise<ProviderHealthResult> {
    const config = currentConfig();
    const diagnostics = { provider: this.id, model: config.model };
    if (!config.apiKey.trim()) return { status: 'not_configured', message: 'Qwen 图片服务未配置 API Key。', ...diagnostics };
    if (!config.baseURL.trim()) return { status: 'not_configured', message: 'Qwen 图片服务地址未配置。', ...diagnostics };

    let healthUrl: string;
    try {
      const url = new URL(endpoint(config.baseURL, QWEN_MODELS_PATH));
      url.searchParams.set('model', config.model);
      healthUrl = url.toString();
    } catch {
      return { status: 'unavailable', message: 'Qwen 图片服务地址格式无效。', ...diagnostics };
    }

    try {
      const response = await fetchWithTimeout(healthUrl, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      }, HEALTH_CHECK_TIMEOUT_MS);
      const body = await readJson(response);
      const requestId = responseRequestId(response, body);
      if (!response.ok || body?.code) {
        console.warn(`[qwen-image] health-check provider=qwen model=${config.model} status=${response.status} requestId=${requestId || 'none'} code=${body?.code || 'none'}`);
        return { status: 'unavailable', message: healthFailureMessage(response.status), httpStatus: response.status, requestId, ...diagnostics };
      }
      if (!hasModel(body, config.model)) {
        console.warn(`[qwen-image] health-check missing-model provider=qwen model=${config.model} status=${response.status} requestId=${requestId || 'none'}`);
        return {
          status: 'unavailable',
          message: `Qwen 图片服务已响应（HTTP ${response.status}），但模型 ${config.model} 不在当前 Workspace 的可用模型列表中。`,
          httpStatus: response.status,
          requestId,
          ...diagnostics,
        };
      }
      console.info(`[qwen-image] health-check provider=qwen model=${config.model} status=${response.status} requestId=${requestId || 'none'}`);
      return { status: 'configured', message: `Qwen 图片服务连接正常（HTTP ${response.status}，模型已授权）。`, httpStatus: response.status, requestId, ...diagnostics };
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';
      console.warn(`[qwen-image] health-check failed provider=qwen model=${config.model} error=${reason}`);
      return {
        status: 'unavailable',
        message: error instanceof FetchTimeoutError ? 'Qwen 图片服务连接超时。' : '无法连接 Qwen 图片服务，请检查 DNS、TLS、代理或网络配置。',
        ...diagnostics,
      };
    }
  }
}
