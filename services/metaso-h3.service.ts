import { API_CONFIG } from '@/lib/config';
import { isPlaceholder } from '@/lib/provider-health';

const CREATE_PATH = '/v2/video_generation';
const QUERY_PATH = '/v2/query/video_generation';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MetaSOH3Task {
  id: string;
  status: string;
  videoUrl?: string;
}

export interface MetaSOH3Options {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  resolution?: string;
  duration?: number;
  ratio?: string;
  contextIrEnabled?: boolean;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function readJson(response: Response): Promise<any> {
  return response.json().catch(() => null);
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
      host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.') ||
      host.startsWith('192.168.') || host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

/** MetaSO MiniMax-H3 adapter. This service is server-only: never import it from a client component. */
export class MetaSOH3Service {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly resolution: string;
  private readonly duration: number;
  private readonly ratio: string;
  private readonly contextIrEnabled: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: MetaSOH3Options = {}) {
    this.apiKey = options.apiKey ?? API_CONFIG.metaso.apiKey;
    this.baseURL = normalizeBaseURL(options.baseURL ?? API_CONFIG.metaso.baseURL);
    this.model = options.model ?? API_CONFIG.metaso.model;
    this.resolution = options.resolution ?? API_CONFIG.metaso.resolution;
    this.duration = options.duration ?? API_CONFIG.metaso.duration;
    this.ratio = options.ratio ?? API_CONFIG.metaso.ratio;
    this.contextIrEnabled = options.contextIrEnabled ?? API_CONFIG.metaso.contextIrEnabled;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  isConfigured(): boolean {
    return !isPlaceholder(this.apiKey) && /^https?:\/\//i.test(this.baseURL);
  }

  async createVideoTask(prompt: string, firstFrameUrl?: string): Promise<string> {
    const text = prompt.trim();
    if (!text) throw new Error('MetaSO 视频提示词不能为空');
    if (!this.isConfigured()) throw new Error('MetaSO H3 未配置：请检查 METASO_API_KEY 与 METASO_BASE_URL');
    if (firstFrameUrl && !isPublicHttpUrl(firstFrameUrl)) {
      throw new Error('MetaSO 无法访问本地分镜图片，请使用公网图片 URL 或先上传到可公开访问的对象存储。');
    }

    const mode = firstFrameUrl ? 'i2v' : 't2v';
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
    if (firstFrameUrl) content.push({ type: 'image_url', image_url: { url: firstFrameUrl }, role: 'first_frame' });
    const body = {
      model: this.model,
      content,
      resolution: this.resolution,
      duration: this.duration,
      ratio: this.ratio,
      context_ir_enabled: this.contextIrEnabled,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}${CREATE_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`MetaSO H3 创建任务请求失败：${detail}`);
    }
    if (!response.ok) throw new Error(`MetaSO H3 创建任务失败（HTTP ${response.status}）`);

    const data = await readJson(response);
    const taskId = typeof data?.task_id === 'string' ? data.task_id : '';
    if (!taskId) throw new Error('MetaSO H3 创建任务响应缺少 task_id');
    console.info(`[metaso-h3] provider=MetaSO mode=${mode} taskId=${taskId} action=created`);
    return taskId;
  }

  async queryVideoTask(taskId: string): Promise<MetaSOH3Task> {
    if (!taskId.trim()) throw new Error('MetaSO H3 task_id 不能为空');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}${QUERY_PATH}/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`MetaSO H3 查询任务请求失败：${detail}`);
    }
    if (!response.ok) throw new Error(`MetaSO H3 查询任务失败（HTTP ${response.status}）`);

    const data = await readJson(response);
    const task = data?.task;
    const status = typeof task?.status === 'string' ? task.status.toLowerCase() : '';
    if (!status) throw new Error('MetaSO H3 查询响应缺少 task.status');
    const content = task?.content;
    const videoUrl = typeof content?.url === 'string'
      ? content.url
      : typeof content?.uri === 'string' ? content.uri : undefined;
    console.info(`[metaso-h3] provider=MetaSO taskId=${taskId} status=${status}`);
    return { id: typeof task?.id === 'string' ? task.id : taskId, status, videoUrl };
  }

  async waitForVideoTask(taskId: string, options: { pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<string> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = this.now();
    while (this.now() - startedAt <= timeoutMs) {
      const task = await this.queryVideoTask(taskId);
      if (task.status === 'succeeded') {
        if (!task.videoUrl) throw new Error(`MetaSO H3 任务 ${taskId} 已成功但未返回视频 URL`);
        console.info(`[metaso-h3] provider=MetaSO taskId=${taskId} status=succeeded elapsedMs=${this.now() - startedAt}`);
        return task.videoUrl;
      }
      if (['failed', 'error', 'cancelled', 'canceled'].includes(task.status)) {
        throw new Error(`MetaSO H3 任务 ${taskId} 失败（status=${task.status}）`);
      }
      await this.sleep(pollIntervalMs);
    }
    throw new Error(`MetaSO H3 任务 ${taskId} 超时（${timeoutMs}ms）`);
  }

  async generateVideo(firstFrameUrl: string | undefined, prompt: string): Promise<string> {
    const taskId = await this.createVideoTask(prompt, firstFrameUrl);
    return this.waitForVideoTask(taskId);
  }
}

export { isPublicHttpUrl as isMetaSOPublicImageUrl };
