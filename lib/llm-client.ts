/**
 * v7.1 — 统一 LLM 调用客户端 (高可用): 主 → MiniMax 全局兜底 + 超时 + <think> 剥离.
 *
 * 各模块 (剧本润色 / 草稿对比 / 等) 之前各自 fetch, 超时/兜底/解析不一致 → 不稳定.
 * 这里收口成一个 helper: 任何主 LLM 异常/欠费/超时 → 自动落 MiniMax, 首个成功即返回.
 * 注: orchestrator 的 callLLM 走子进程 (绕 Turbopack), 逻辑相同但独立实现.
 */

import { API_CONFIG } from './config';

export interface LLMAttempt { baseURL: string; apiKey: string; model: string; label: string; }

/**
 * 构建尝试链: 主 (创意=DeepSeek / 通用=主网关) → MiniMax 全局兜底. 纯函数, 可单测.
 * fast=true 且 useCreative 时, 主用创意"快档"模型 (deepseek-v4-flash) —— 推理 token 少、秒级响应,
 * 适合"快草稿/润色basic"; 默认 false 用 creativeModel (deepseek-v4-pro, 质量优先).
 */
export function buildLLMAttempts(useCreative: boolean, cfg: any = API_CONFIG.openai, fast = false): LLMAttempt[] {
  const creativeModel = fast
    ? (cfg.creativeFastModel || cfg.creativeModel || cfg.model)
    : (cfg.creativeModel || cfg.model);
  const primary = useCreative
    ? { baseURL: cfg.creativeBaseURL || cfg.baseURL, apiKey: cfg.creativeApiKey || cfg.apiKey, model: creativeModel, label: fast ? '创意·DeepSeek快' : '创意·DeepSeek' }
    : { baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model, label: '通用' };
  const out: LLMAttempt[] = [];
  if (primary.apiKey) out.push(primary);
  // v12.61.0 P0-2:同网关备用模型 —— 主模型 429/503 时先切同网关这些健康模型(秒级、同 key),
  // 再落慢的 MiniMax 兜底(推理模型 40-100s)。与 primary 同 base/key、跳过同名/重复。
  if (primary.apiKey) {
    for (const alt of (cfg.altModels || [])) {
      if (alt && alt !== primary.model && !out.some((a: LLMAttempt) => a.model === alt && a.baseURL === primary.baseURL)) {
        out.push({ baseURL: primary.baseURL, apiKey: primary.apiKey, model: alt, label: `同网关备用·${alt}` });
      }
    }
  }
  // v12.94.0 OpenRouter 档(调研落地):70+ provider 自动健康路由(30s 故障检测 + provider failover),
  // OpenAI 兼容零改造 —— 主网关整组饱和时这档比单一兜底稳得多。配 OPENROUTER_API_KEY 即启用,
  // 模型默认 anthropic/claude-sonnet-4(OPENROUTER_MODEL 可覆盖);排在同网关备用后、MiniMax 慢兜底前。
  if (cfg.openrouterApiKey) {
    out.push({
      baseURL: cfg.openrouterBaseURL || 'https://openrouter.ai/api/v1',
      apiKey: cfg.openrouterApiKey,
      model: cfg.openrouterModel || 'anthropic/claude-sonnet-4',
      label: 'OpenRouter兜底',
    });
  }
  if (cfg.fallbackApiKey && (cfg.fallbackApiKey !== primary.apiKey || cfg.fallbackModel !== primary.model)) {
    out.push({ baseURL: cfg.fallbackBaseURL, apiKey: cfg.fallbackApiKey, model: cfg.fallbackModel, label: 'MiniMax兜底' });
  }
  return out;
}

/** 剥离 reasoning 模型的 <think>...</think> 块 (deepseek/minimax 等偶发). 纯函数. */
export function stripThink(s: string): string {
  return (s || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

type LLMResponseText = {
  content: string;
  source?: 'content' | 'reasoning_content';
  hasChoices: boolean;
  hasContent: boolean;
  hasReasoningContent: boolean;
  finishReason?: string;
};

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  // Some OpenAI-compatible gateways use multimodal content parts even for text.
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }).join('');
}

/**
 * Extract generated text from OpenAI-compatible chat responses.
 *
 * DeepSeek reasoning models may put the only text in `reasoning_content`.
 * Prefer `content` whenever it exists, so normal and non-reasoning models keep
 * their existing behaviour.
 */
export function extractLLMResponseText(payload: unknown): LLMResponseText {
  const response = payload && typeof payload === 'object' ? payload as { choices?: unknown } : {};
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] && typeof choices[0] === 'object'
    ? choices[0] as { message?: unknown; finish_reason?: unknown }
    : {};
  const message = first.message && typeof first.message === 'object'
    ? first.message as { content?: unknown; reasoning_content?: unknown }
    : {};
  const rawContent = contentToText(message.content);
  const rawReasoning = contentToText(message.reasoning_content);
  const content = stripThink(rawContent);
  const reasoningContent = stripThink(rawReasoning);
  const diagnostics = {
    hasChoices: choices.length > 0,
    hasContent: !!rawContent,
    hasReasoningContent: !!rawReasoning,
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : undefined,
  };

  if (content) return { content, source: 'content', ...diagnostics };
  return { content: reasoningContent, source: reasoningContent ? 'reasoning_content' : undefined, ...diagnostics };
}

/**
 * 判断是否"瞬时可重试"错误 (上游过载/限流/5xx) —— 这类错误退避后重试同一端点往往即恢复,
 * 比立刻切到慢速兜底 (MiniMax 推理模型 40-75s) 体验好得多。
 * 注意: 故意不含 'timeout' —— 超时重试同端点代价高, 直接切兜底更划算。
 */
export function isTransientLLMError(msg: string): boolean {
  return /too busy|rate.?limit|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|overload|temporarily|try again|service unavailable|繁忙|过载|稍后/i.test(msg || '');
}

export interface LLMCallOpts {
  system: string;
  user: string;
  /** true=创意主LLM(DeepSeek), false=通用(主网关). 两者都兜底 MiniMax */
  useCreative?: boolean;
  /** true=创意快档(deepseek-v4-flash, 秒级/推理少), 仅 useCreative 时生效 */
  fast?: boolean;
  maxTokens?: number;
  /** 单次尝试超时 (ms), 默认 150s */
  timeoutMs?: number;
  temperature?: number;
  /** 要求 response_format json_object */
  jsonMode?: boolean;
  /** 每个端点遇"瞬时错误"(过载/限流/5xx)时退避重试次数, 默认 1 (即最多打 2 次该端点再切兜底) */
  retriesPerAttempt?: number;
}

export interface LLMCallResult {
  ok: boolean;
  content?: string;
  model?: string;
  error?: string;
  /** 是否走了兜底 (主失败) */
  usedFallback?: boolean;
  attemptsTried?: string[];
}

/** 调 LLM, 主→MiniMax 兜底, 首个成功即返回; 内置超时 + <think> 剥离. */
export async function callLLMWithFallback(opts: LLMCallOpts): Promise<LLMCallResult> {
  // v12.120:接入 llm-health 健康缓存(与 orchestrator 对齐)—— 网关拥堵时段
  // 广告工具端点(hook-ideas/publish-copy 等)不再每次白撞已知超时/饱和的模型。
  const { filterHealthyAttempts, markLLMDown, llmKey } = await import('@/lib/llm-health');
  // v12.127:再叠一层配额感知 —— 已破产网关(配额耗尽/欠费)整段跳过,省重复 403 往返。
  const { filterFundedAttempts, markGatewayOutOfCredits, isOutOfCreditsError } = await import('@/lib/gateway-budget');
  const attempts = filterFundedAttempts(filterHealthyAttempts(buildLLMAttempts(!!opts.useCreative, API_CONFIG.openai, !!opts.fast)));
  if (attempts.length === 0) return { ok: false, error: 'LLM 未配置 (缺 DEEPSEEK_API_KEY / OPENAI_API_KEY)' };
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const retries = Math.max(0, opts.retriesPerAttempt ?? 1);
  const tried: string[] = [];
  let lastErr = 'no attempt';

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    // 同一端点上: 遇"瞬时错误"退避重试, 退避 (attempt+1)*0.8s; 非瞬时/超时则直接切下一个端点
    for (let attempt = 0; attempt <= retries; attempt++) {
      const tag = attempt > 0 ? `${a.label}#${attempt + 1}` : a.label;
      tried.push(tag);
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const body: Record<string, any> = {
          model: a.model,
          messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
          max_tokens: opts.maxTokens ?? 4096,
        };
        if (opts.temperature != null) body.temperature = opts.temperature;
        if (opts.jsonMode) body.response_format = { type: 'json_object' };
        const r = await fetch(`${a.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${a.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        clearTimeout(tm);
        const j = await r.json().catch(() => null);
        const responseText = extractLLMResponseText(j);
        if (r.ok && responseText.content) {
          return { ok: true, content: responseText.content, model: a.model, usedFallback: i > 0, attemptsTried: tried };
        }
        const apiError = j && typeof j === 'object' && typeof (j as { error?: { message?: unknown } }).error?.message === 'string'
          ? (j as { error: { message: string } }).error.message
          : '';
        lastErr = apiError || (r.ok ? 'LLM response contained no text content' : `LLM ${r.status}`);
        // v12.127:403/402 + 配额文案 → 标记该网关破产(同 host 后续尝试整段跳过)
        console.warn(
          `[llm-client] ${tag} response diagnostics: status=${r.status} model=${a.model} ` +
          `message=${lastErr} hasChoices=${responseText.hasChoices} hasContent=${responseText.hasContent} ` +
          `hasReasoningContent=${responseText.hasReasoningContent} finishReason=${responseText.finishReason || 'none'}`,
        );
        if (r.status === 402 || r.status === 403 || isOutOfCreditsError(lastErr)) markGatewayOutOfCredits(a.baseURL);
      } catch (e: any) {
        clearTimeout(tm);
        lastErr = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
        const causeMessage = typeof e?.cause?.message === 'string' ? e.cause.message : 'none';
        const causeCode = typeof e?.cause?.code === 'string' ? e.cause.code : 'none';
        console.warn(
          `[llm-client] ${tag} exception diagnostics: model=${a.model} name=${e?.name || 'Error'} ` +
          `message=${lastErr} cause=${causeMessage} causeCode=${causeCode}`,
        );
      }
      // v12.120:瞬时错误/超时进健康缓存,同进程后续调用冷却期内跳过该端点
      if (isTransientLLMError(lastErr) || lastErr === 'timeout') markLLMDown(llmKey(a));
      // 仅"瞬时错误 + 还有重试余量"才退避重试同端点; 否则跳出去打下一个端点 (兜底)
      if (attempt < retries && isTransientLLMError(lastErr)) {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  return { ok: false, error: lastErr, attemptsTried: tried };
}
