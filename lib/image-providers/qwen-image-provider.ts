import { API_CONFIG } from '@/lib/config';
import { FetchTimeoutError, fetchWithTimeout } from '@/lib/fetch-timeout';
import { normalizeBaseURL } from '@/lib/base-url';
import { ImageProviderError } from './errors';
import type {
  ImageGenerateRequest,
  ImageGenerationResult,
  ImageProviderCapabilities,
  ProviderHealthResult,
  UnifiedImageProvider,
} from './types';

const QWEN_GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const QWEN_MODELS_PATH = '/api/v1/models';
const GENERATION_TIMEOUT_MS = 90_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

/** Qwen-Image 2.0 官方推荐的 2K 画幅，2.35:1 由项目自定义映射为同等像素级别。 */
const SIZE_BY_ASPECT: Record<string, string> = {
  '16:9': '2688*1536',
  '9:16': '1536*2688',
  '1:1': '2048*2048',
  '4:3': '2368*1728',
  '3:4': '1728*2368',
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
  };
};

function currentConfig(): QwenConfig {
  return API_CONFIG.image.qwen;
}

/** DashScope Base URL 由配置统一管理，Provider 只补官方 API 路径。 */
function endpoint(baseURL: string, path: string): string {
  return `${normalizeBaseURL(baseURL)}${path}`;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
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

function requestedSize(request: ImageGenerateRequest): string {
  if (Number.isInteger(request.width) && Number.isInteger(request.height) && request.width! > 0 && request.height! > 0) {
    return `${request.width}*${request.height}`;
  }
  return SIZE_BY_ASPECT[request.aspectRatio || ''] || SIZE_BY_ASPECT['16:9'];
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
    width: body.usage?.width,
    height: body.usage?.height,
    seed: request.seed,
    metadata: body.request_id ? { requestId: body.request_id } : undefined,
  }));
}

/**
 * Qwen-Image 2.0 的百炼同步适配器。
 * 上游的 choices/message/content 格式只在此处解析，下游始终只消费统一 images[].url。
 */
export class QwenImageProvider implements UnifiedImageProvider {
  readonly id = 'qwen';
  readonly name = 'Qwen-Image';

  models = (): string[] => [currentConfig().model];

  isConfigured = (): boolean => Boolean(currentConfig().apiKey.trim());

  getCapabilities = (): ImageProviderCapabilities => ({
    textToImage: true,
    // TODO(qwen): 图像编辑会在后续按独立官方契约接入，避免把文本生成请求错误用于参考图。
    imageToImage: false,
    imageEdit: false,
    referenceImages: false,
    multiReference: false,
    characterReference: false,
    styleReference: false,
    controlNet: false,
    lora: false,
    supportsSeed: true,
    supportsNegativePrompt: true,
    supportedAspectRatios: Object.keys(SIZE_BY_ASPECT),
  });

  /**
   * 使用官方同步接口完成文生图；Qwen-Image 2.0 无需任务轮询。
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
    if ((request.referenceImages?.length || 0) + (request.characterReferences?.length || 0) + (request.styleReferences?.length || 0) > 0) {
      throw new ImageProviderError('IMAGE_EDIT_NOT_SUPPORTED', '当前 Qwen Provider 暂未启用参考图编辑，请先使用文生图。', this.id);
    }

    const model = request.model || config.model;
    const payload = {
      model,
      input: {
        messages: [{
          role: 'user',
          content: [{ text: request.prompt }],
        }],
      },
      parameters: {
        negative_prompt: request.negativePrompt,
        size: requestedSize(request),
        n: requestedCount(request.count),
        prompt_extend: true,
        watermark: false,
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
        finishReasons: body?.output?.choices?.map((choice) => choice.finish_reason).filter(Boolean),
      },
    };
  }

  /**
   * 使用官方 models 接口做零计费连通性检查。
   * 仅回传脱敏状态，不向前端传递上游响应内容、请求头或 API Key。
   */
  async healthCheck(): Promise<ProviderHealthResult> {
    const config = currentConfig();
    if (!config.apiKey.trim()) return { status: 'not_configured', message: 'Qwen 图片服务未配置 API Key。' };
    if (!config.baseURL.trim()) return { status: 'not_configured', message: 'Qwen 图片服务地址未配置。' };

    let healthUrl: string;
    try {
      const url = new URL(endpoint(config.baseURL, QWEN_MODELS_PATH));
      url.searchParams.set('model', config.model);
      url.searchParams.set('page_no', '1');
      url.searchParams.set('page_size', '1');
      healthUrl = url.toString();
    } catch {
      return { status: 'unavailable', message: 'Qwen 图片服务地址格式无效。' };
    }

    try {
      const response = await fetchWithTimeout(healthUrl, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
      }, HEALTH_CHECK_TIMEOUT_MS);
      const body = await readJson(response);
      if (!response.ok || body?.code) {
        const error = qwenError(response.status, body);
        console.warn(`[qwen-image] health-check provider=qwen model=${config.model} status=${response.status} code=${body?.code || 'none'}`);
        return { status: 'unavailable', message: error.message };
      }
      console.info(`[qwen-image] health-check provider=qwen model=${config.model} status=${response.status}`);
      return { status: 'configured', message: 'Qwen 图片服务连接正常。' };
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';
      console.warn(`[qwen-image] health-check failed provider=qwen model=${config.model} error=${reason}`);
      return {
        status: 'unavailable',
        message: error instanceof FetchTimeoutError ? 'Qwen 图片服务连接超时。' : '无法连接 Qwen 图片服务，请检查服务地址。',
      };
    }
  }
}
