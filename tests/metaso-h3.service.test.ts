import { describe, expect, it, vi } from 'vitest';
import { MetaSOH3Service, isMetaSOPublicImageUrl } from '@/services/metaso-h3.service';
import { resolveEngineOrder } from '@/lib/engine-order';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function service(fetch: (input: string, init?: RequestInit) => Promise<Response>, now = () => 0) {
  return new MetaSOH3Service({
    apiKey: 'test-metaso-key-not-real', baseURL: 'https://metaso.cn/api/minimax/',
    model: 'MiniMax-H3', resolution: '768P', duration: 5, ratio: '9:16', contextIrEnabled: false,
    fetch, sleep: async () => undefined, now,
  });
}

describe('MetaSO MiniMax-H3 adapter', () => {
  it('I2V creates the documented content image_url first_frame request', async () => {
    const fetch = vi.fn(async () => response({ task_id: 'task-i2v' }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await service(fetch).createVideoTask('camera pushes in', 'https://cdn.example/frame.png');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://metaso.cn/api/minimax/v2/video_generation');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'MiniMax-H3', resolution: '768P', duration: 5, ratio: '9:16', context_ir_enabled: false });
    expect(body.content).toEqual([
      { type: 'text', text: 'camera pushes in' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/frame.png' }, role: 'first_frame' },
    ]);
    expect(info.mock.calls.flat().join(' ')).not.toContain('test-metaso-key-not-real');
    info.mockRestore();
  });

  it('T2V omits image_url and create returns task_id', async () => {
    const fetch = vi.fn(async () => response({ task_id: 'task-t2v' }));
    await expect(service(fetch).createVideoTask('storm over city')).resolves.toBe('task-t2v');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.content).toEqual([{ type: 'text', text: 'storm over city' }]);
  });

  it('polls running until succeeded and reads task.content.url', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ task_id: 'task-1' }))
      .mockResolvedValueOnce(response({ task: { id: 'task-1', status: 'running' } }))
      .mockResolvedValueOnce(response({ task: { id: 'task-1', status: 'succeeded', content: { url: 'https://cdn.example/video.mp4' } } }));
    await expect(service(fetch).generateVideo(undefined, 'rain falls')).resolves.toBe('https://cdn.example/video.mp4');
    expect(fetch.mock.calls[1][0]).toBe('https://metaso.cn/api/minimax/v2/query/video_generation/task-1');
  });

  it('reports failure and timeout without exposing the key', async () => {
    const failedFetch = vi.fn(async () => response({ task: { status: 'failed' } }));
    await expect(service(failedFetch).waitForVideoTask('bad')).rejects.toThrow('status=failed');

    let clock = 0;
    const timeoutFetch = vi.fn(async () => response({ task: { status: 'running' } }));
    const timeoutService = new MetaSOH3Service({
      apiKey: 'test-metaso-key-not-real', baseURL: 'https://metaso.cn/api/minimax', fetch: timeoutFetch,
      sleep: async () => { clock += 5_000; }, now: () => clock,
    });
    await expect(timeoutService.waitForVideoTask('slow', { timeoutMs: 5_000 })).rejects.toThrow('超时');
  });

  it('rejects local reference images before sending them to MetaSO', async () => {
    expect(isMetaSOPublicImageUrl('https://cdn.example/frame.png')).toBe(true);
    expect(isMetaSOPublicImageUrl('/api/serve-file/x')).toBe(false);
    expect(isMetaSOPublicImageUrl('http://127.0.0.1/frame.png')).toBe(false);
    const fetch = vi.fn();
    await expect(service(fetch).createVideoTask('x', 'D:\\frame.png')).rejects.toThrow('MetaSO 无法访问本地分镜图片');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an explicitly selected MetaSO task on MetaSO instead of silently billing another video provider', () => {
    expect(resolveEngineOrder('metaso-h3', ['metaso-h3', 'minimax'])).toEqual(['metaso-h3']);
  });
});
