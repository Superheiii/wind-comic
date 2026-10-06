import '@/lib/image-providers/unified-builtins';
import { API_CONFIG } from '@/lib/config';
import { ImageProviderError } from '@/lib/image-providers/errors';
import { imageProviderRegistry } from '@/lib/image-providers/registry';
import type { ImageGenerateRequest, ImageGenerationResult, UnifiedImageProvider } from '@/lib/image-providers/types';

export interface ImageSelection {
  provider?: string | null;
  model?: string | null;
}

type ImageRegistry = Pick<typeof imageProviderRegistry, 'get' | 'getAvailableProviders'>;

export class ImageGenerationService {
  constructor(private readonly registry: ImageRegistry = imageProviderRegistry) {}

  resolve(selection: ImageSelection = {}): UnifiedImageProvider {
    const requestedId = selection.provider || API_CONFIG.image.defaultProvider;
    if (requestedId) {
      const provider = this.registry.get(requestedId);
      if (!provider) throw new ImageProviderError('IMAGE_PROVIDER_UNAVAILABLE', `未找到图片 Provider：${requestedId}。`, requestedId);
      if (!provider.isConfigured()) throw new ImageProviderError('IMAGE_PROVIDER_NOT_CONFIGURED', `${provider.name} 未配置。`, requestedId);
      return provider;
    }
    const provider = this.registry.getAvailableProviders()[0];
    if (!provider) {
      throw new ImageProviderError('IMAGE_PROVIDER_NOT_CONFIGURED', '尚未配置可用的图片模型，请前往设置 → 图片模型。');
    }
    return provider;
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerationResult> {
    const provider = this.resolve(request);
    const model = request.model || API_CONFIG.image.defaultModel || provider.models()[0];
    if (request.model && !provider.models().includes(request.model)) {
      throw new ImageProviderError('IMAGE_MODEL_NOT_SUPPORTED', `${provider.name} 不支持所选模型。`, provider.id);
    }
    const result = await provider.generate({ ...request, provider: provider.id, model });
    if (!result.images?.[0]?.url) throw new ImageProviderError('IMAGE_GENERATION_FAILED', `${provider.name} 未返回图片。`, provider.id);
    return result;
  }
}

export const imageGenerationService = new ImageGenerationService();
