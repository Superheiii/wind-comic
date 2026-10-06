import { API_CONFIG } from '@/lib/config';
import { ComfyUIService, hasComfyUI } from '@/services/comfyui.service';
import { MidjourneyService, hasMidjourney } from '@/services/midjourney.service';
import { ImageProviderError } from './errors';
import { QwenImageProvider } from './qwen-image-provider';
import { imageProviderRegistry } from './registry';
import type { ImageGenerateRequest, ImageGenerationResult, ImageProviderCapabilities, UnifiedImageProvider } from './types';

const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '2.35:1'];
const basicCapabilities = (): ImageProviderCapabilities => ({
  textToImage: true, imageToImage: false, imageEdit: false,
  referenceImages: false, multiReference: false, characterReference: false,
  styleReference: false, controlNet: false, lora: false, supportsSeed: false,
  supportsNegativePrompt: false, supportedAspectRatios: RATIOS,
});

function single(provider: string, model: string, url: string, raw?: unknown): ImageGenerationResult {
  if (!url || !/^https?:\/\//.test(url)) {
    throw new ImageProviderError('IMAGE_GENERATION_FAILED', `${provider} 未返回可用图片地址。`, provider);
  }
  return { provider, model, images: [{ url }], raw };
}

function pendingProvider(id: 'qwen' | 'seedream', name: string, keyPresent: () => boolean, model: () => string): UnifiedImageProvider {
  return {
    id, name, models: () => [model()], isConfigured: keyPresent,
    getCapabilities: basicCapabilities,
    async generate() {
      const code = keyPresent() ? 'API_IMPLEMENTATION_PENDING' : 'IMAGE_PROVIDER_NOT_CONFIGURED';
      const message = keyPresent()
        ? `${name} 已检测到配置，但项目中没有经过验证的 API 契约；为避免猜测 endpoint，尚未发起请求。`
        : `${name} API 密钥未配置。`;
      throw new ImageProviderError(code, message, id);
    },
  };
}

// Qwen 使用已核对的百炼同步接口；适配器负责屏蔽上游响应结构。
imageProviderRegistry.register(new QwenImageProvider());
imageProviderRegistry.register(pendingProvider(
  'seedream', 'Seedream', () => Boolean(API_CONFIG.image.seedream.apiKey), () => API_CONFIG.image.seedream.model,
));

imageProviderRegistry.register({
  id: 'comfyui', name: 'ComfyUI Local',
  models: () => [API_CONFIG.image.comfyui.model],
  isConfigured: () => hasComfyUI(),
  getCapabilities: () => ({
    ...basicCapabilities(), imageToImage: true, referenceImages: true, multiReference: false,
    characterReference: true, styleReference: true, controlNet: Boolean(process.env.COMFYUI_CONTROLNET_MODEL),
    maxReferenceImages: 1,
  }),
  async generate(request) {
    if (!hasComfyUI()) throw new ImageProviderError('IMAGE_PROVIDER_NOT_CONFIGURED', 'ComfyUI 未启用，请配置 COMFYUI_ENABLED=true。', 'comfyui');
    const refs = [...(request.characterReferences ?? []), ...(request.referenceImages ?? [])].filter(Boolean);
    try {
      const url = await new ComfyUIService().generateWithIPAdapter(request.prompt, {
        characterRefImage: refs[0], width: request.width, height: request.height,
        checkpoint: request.model || API_CONFIG.image.comfyui.model,
      });
      return single('comfyui', request.model || API_CONFIG.image.comfyui.model, url);
    } catch (error) {
      throw new ImageProviderError('IMAGE_GENERATION_FAILED', 'ComfyUI 无法生成图片，请检查服务地址与工作流。', 'comfyui');
    }
  },
});

imageProviderRegistry.register({
  id: 'midjourney', name: 'Midjourney', models: () => [API_CONFIG.image.midjourney.model],
  isConfigured: () => hasMidjourney(), getCapabilities: () => ({
    ...basicCapabilities(), referenceImages: true, characterReference: true, styleReference: true, maxReferenceImages: 2,
  }),
  async generate(request) {
    if (!hasMidjourney()) throw new ImageProviderError('IMAGE_PROVIDER_NOT_CONFIGURED', 'Midjourney 未配置。', 'midjourney');
    try {
      const url = await new MidjourneyService().generateImage(request.prompt, {
        aspectRatio: request.aspectRatio, cref: request.characterReferences?.[0], sref: request.styleReferences?.[0],
      });
      return single('midjourney', request.model || API_CONFIG.image.midjourney.model, url);
    } catch {
      throw new ImageProviderError('IMAGE_GENERATION_FAILED', 'Midjourney 图片生成失败。', 'midjourney');
    }
  },
});

for (const item of [
  ['flux', 'FLUX', () => Boolean(process.env.FAL_KEY), () => API_CONFIG.image.flux.model],
  ['openai', 'OpenAI Image', () => Boolean(process.env.OPENAI_API_KEY), () => API_CONFIG.image.openai.model],
] as const) {
  imageProviderRegistry.register({
    id: item[0], name: item[1], models: () => [item[3]()], isConfigured: item[2], getCapabilities: basicCapabilities,
    async generate() { throw new ImageProviderError('API_IMPLEMENTATION_PENDING', `${item[1]} 适配器已预留，尚未接入本图片服务。`, item[0]); },
  });
}
