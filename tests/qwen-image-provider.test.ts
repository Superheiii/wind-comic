import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageProviderError } from '@/lib/image-providers/errors';
import { QwenImageProvider } from '@/lib/image-providers/qwen-image-provider';

const originalEnv = {
  apiKey: process.env.QWEN_IMAGE_API_KEY,
  baseURL: process.env.QWEN_IMAGE_BASE_URL,
  model: process.env.QWEN_IMAGE_MODEL,
};

function configureQwen(model = 'qwen-image-3.0') {
  process.env.QWEN_IMAGE_API_KEY = 'test-qwen-key';
  process.env.QWEN_IMAGE_BASE_URL = 'https://dashscope.aliyuncs.com';
  process.env.QWEN_IMAGE_MODEL = model;
}

afterEach(() => {
  vi.unstubAllGlobals();
  const values: Record<string, string | undefined> = {
    QWEN_IMAGE_API_KEY: originalEnv.apiKey,
    QWEN_IMAGE_BASE_URL: originalEnv.baseURL,
    QWEN_IMAGE_MODEL: originalEnv.model,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('QwenImageProvider', () => {
  it('reports a missing API key through the unified error type', async () => {
    delete process.env.QWEN_IMAGE_API_KEY;
    const provider = new QwenImageProvider();

    await expect(provider.generate({ prompt: '一盏雨夜路灯' })).rejects.toMatchObject({
      code: 'IMAGE_PROVIDER_NOT_CONFIGURED',
      provider: 'qwen',
    } satisfies Partial<ImageProviderError>);
  });

  it('keeps qwen-image-2.0 text-to-image compatibility', async () => {
    configureQwen('qwen-image-2.0');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      request_id: 'req-test-001',
      output: {
        choices: [{
          finish_reason: 'stop',
          message: { content: [{ image: 'https://image.example/qwen.png' }] },
        }],
      },
      usage: { width: 1536, height: 2688, image_count: 1 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new QwenImageProvider().generate({
      prompt: '赛博城市雨夜，电影感构图',
      aspectRatio: '9:16',
      negativePrompt: '模糊',
      seed: 7,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'qwen-image-2.0',
      input: { messages: [{ role: 'user', content: [{ text: '赛博城市雨夜，电影感构图' }] }] },
      parameters: { size: '1536*2688', negative_prompt: '模糊', seed: 7, n: 1, watermark: false },
    });
    expect(result).toMatchObject({
      provider: 'qwen',
      model: 'qwen-image-2.0',
      images: [{ url: 'https://image.example/qwen.png', width: 1536, height: 2688, seed: 7 }],
      raw: { requestId: 'req-test-001' },
    });
  });

  it('sends qwen-image-3.0 text-to-image through the synchronous DashScope contract', async () => {
    configureQwen('qwen-image-3.0');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      request_id: 'req-qwen-3',
      output: { rewrite_status: 'succeeded', choices: [{ message: { content: [{ image: 'https://image.example/qwen-3.png' }] } }] },
      usage: { output_width: 1024, output_height: 1024, input_image_count: 0 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new QwenImageProvider().generate({ prompt: '未来城市海报' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'qwen-image-3.0',
      input: { messages: [{ role: 'user', content: [{ text: '未来城市海报' }] }] },
      parameters: { n: 1, prompt_extend: true, watermark: false },
    });
    expect(JSON.parse(init.body).parameters.size).toBeUndefined();
    expect(result.images[0]).toMatchObject({ url: 'https://image.example/qwen-3.png', width: 1024, height: 1024 });
  });

  it('sends qwen-image-3.0-pro text-to-image with its selected model', async () => {
    configureQwen('qwen-image-3.0-pro');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://image.example/qwen-3-pro.png' }] } }] },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new QwenImageProvider().generate({ prompt: '电影感人物肖像', aspectRatio: '16:9' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'qwen-image-3.0-pro',
      parameters: { size: '1920*1080' },
    });
    expect(result.images[0]?.url).toBe('https://image.example/qwen-3-pro.png');
  });

  it('sends one to three 3.0 reference images before the editing text', async () => {
    configureQwen('qwen-image-3.0');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://image.example/qwen-edit.png' }] } }] },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new QwenImageProvider().generate({
      prompt: '将三张角色图合成为海报',
      referenceImages: ['https://image.example/one.png'],
      characterReferences: ['https://image.example/two.png'],
      styleReferences: ['https://image.example/three.png'],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).input.messages[0].content).toEqual([
      { image: 'https://image.example/one.png' },
      { image: 'https://image.example/two.png' },
      { image: 'https://image.example/three.png' },
      { text: '将三张角色图合成为海报' },
    ]);
    expect(new QwenImageProvider().getCapabilities()).toMatchObject({
      imageToImage: true, imageEdit: true, referenceImages: true, multiReference: true, maxReferenceImages: 3,
    });
  });

  it('rejects a successful HTTP response that does not contain a usable image URL', async () => {
    configureQwen();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      request_id: 'req-test-002', output: { choices: [{ message: { content: [{}] } }] },
    }), { status: 200 })));

    await expect(new QwenImageProvider().generate({ prompt: '一片雪原' })).rejects.toMatchObject({
      code: 'IMAGE_GENERATION_FAILED',
      provider: 'qwen',
    } satisfies Partial<ImageProviderError>);
  });

  it('maps authentication, throttling, and network failures to safe unified errors', async () => {
    configureQwen();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'InvalidApiKey' }), { status: 401 })));
    await expect(new QwenImageProvider().generate({ prompt: '晨雾森林' })).rejects.toMatchObject({ code: 'AUTH_FAILED', provider: 'qwen' } satisfies Partial<ImageProviderError>);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'Throttling.RateQuota' }), { status: 429 })));
    await expect(new QwenImageProvider().generate({ prompt: '晨雾森林' })).rejects.toMatchObject({ code: 'RATE_LIMITED', provider: 'qwen' } satisfies Partial<ImageProviderError>);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    await expect(new QwenImageProvider().generate({ prompt: '晨雾森林' })).rejects.toMatchObject({ code: 'IMAGE_PROVIDER_UNAVAILABLE', provider: 'qwen' } satisfies Partial<ImageProviderError>);
  });

  it('uses the zero-cost models endpoint for the connection health check', async () => {
    configureQwen();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: { total: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new QwenImageProvider().healthCheck()).resolves.toEqual({
      status: 'configured', message: 'Qwen 图片服务连接正常。',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://dashscope.aliyuncs.com/api/v1/models?model=qwen-image-3.0&page_no=1&page_size=1');
  });

  it('lists all supported Qwen models with 3.0 as the default recommendation', () => {
    configureQwen();
    expect(new QwenImageProvider().models().slice(0, 3)).toEqual([
      'qwen-image-3.0', 'qwen-image-3.0-pro', 'qwen-image-2.0',
    ]);
  });
});
