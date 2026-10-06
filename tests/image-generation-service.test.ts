import { describe, expect, it, vi } from 'vitest';
import { ImageGenerationService } from '@/services/image-generation.service';
import { ImageProviderError } from '@/lib/image-providers/errors';
import type { UnifiedImageProvider } from '@/lib/image-providers/types';

const capabilities = {
  textToImage: true, imageToImage: false, imageEdit: false,
  referenceImages: false, multiReference: false, characterReference: false,
  styleReference: false, controlNet: false, lora: false, supportsSeed: false,
  supportsNegativePrompt: false,
};

function provider(id: string, configured = true): UnifiedImageProvider {
  return {
    id, name: id, models: () => [`${id}-model`], isConfigured: () => configured,
    getCapabilities: () => capabilities,
    generate: vi.fn(async (request) => ({
      provider: id, model: request.model || `${id}-model`, images: [{ url: `https://images.example/${id}.png` }],
    })),
  };
}

describe('ImageGenerationService', () => {
  it('uses only the explicitly selected provider/model', async () => {
    const qwen = provider('qwen');
    const seedream = provider('seedream');
    const registry = {
      get: (id: string) => ({ qwen, seedream } as Record<string, UnifiedImageProvider>)[id],
      getAvailableProviders: () => [qwen, seedream],
    };
    const service = new ImageGenerationService(registry);
    const result = await service.generate({ prompt: 'test', provider: 'seedream', model: 'seedream-model' });
    expect(result.provider).toBe('seedream');
    expect(seedream.generate).toHaveBeenCalledOnce();
    expect(qwen.generate).not.toHaveBeenCalled();
  });

  it('reports the unified not-configured error when no provider is available', () => {
    const service = new ImageGenerationService({ get: () => undefined, getAvailableProviders: () => [] });
    expect(() => service.resolve()).toThrow(ImageProviderError);
    expect(() => service.resolve()).toThrow('尚未配置可用的图片模型');
  });
});
