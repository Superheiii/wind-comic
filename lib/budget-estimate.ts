/**
 * 管线成本动态估算(v12.172.0)—— assertBudget 的 pendingCostCny 不再拍脑袋 ¥6。
 *
 * 纯函数:镜数 × 引擎秒单价 × 每镜秒数 + 图像/音频粗项。
 * 刻意保守(宁高勿低,预算是护栏不是账单):未知引擎按最贵档;图像按每镜 1.5 张
 * (含重生均摊);TTS/BGM 合并粗项。真实记账仍走 cost_log(事后精确)。
 */

/** 引擎视频秒单价(¥/秒;与 lib/config pricing 对齐,未知引擎取最贵档)。 */
const VIDEO_CNY_PER_SEC: Record<string, number> = {
  veo: 0.3, minimax: 0.15, 'metaso-h3': 0.15, metaso: 0.15, kling: 0.2, keling: 0.2, vidu: 0.25, seedance: 0.2,
};
const MAX_VIDEO_RATE = Math.max(...Object.values(VIDEO_CNY_PER_SEC));
// v12.223 校准(🔴-6:旧估算对高清档低估 5-10 倍):4K 真机实测 ¥6/5s = ¥1.2/秒(v12.215),
// 是 std kling(0.2)的 6 倍。按 mode 分档取价,别再用 std 价蒙 4K 重度成本。
const VIDEO_MODE_MULTIPLIER: Record<string, number> = { std: 1, pro: 2, '4k': 6 };
const IMAGE_CNY_PER_SHOT = 0.45;  // 每镜 ~1.5 张(分镜+重生均摊)× ¥0.3/张
const AUDIO_CNY_PER_SHOT = 0.1;   // TTS + BGM 均摊

export interface CostEstimateInput {
  shotCount?: number | null;          // 未知(创建时剧本未出)→ 按 8 镜保守估
  videoProvider?: string | null;
  secondsPerShot?: number | null;     // 默认 6s
  videoShots?: number | null;         // 只重渲部分镜时传(批量补渲/单镜)
  skipImages?: boolean;               // 补渲不重出图
  mode?: string | null;               // v12.223:'std'|'pro'|'4k' —— 4K 单价约 std 6 倍
}

/** 单镜视频秒单价(¥/秒),含 mode 档位加成。导出供 COGS 报告复用。 */
export function videoRatePerSec(provider?: string | null, mode?: string | null): number {
  const p = (provider || '').toLowerCase();
  const base = VIDEO_CNY_PER_SEC[p] ?? MAX_VIDEO_RATE;
  const m = (mode || 'std').toLowerCase();
  return base * (VIDEO_MODE_MULTIPLIER[m] ?? 1);
}

export function estimatePipelineCostCny(input: CostEstimateInput = {}): number {
  const shots = Math.max(1, input.shotCount ?? 8);
  const videoShots = Math.max(0, input.videoShots ?? shots);
  const sec = Math.max(3, input.secondsPerShot ?? 6);
  const rate = videoRatePerSec(input.videoProvider, input.mode);
  const video = videoShots * sec * rate;
  const images = input.skipImages ? 0 : shots * IMAGE_CNY_PER_SHOT;
  const audio = shots * AUDIO_CNY_PER_SHOT;
  return Math.ceil((video + images + audio) * 10) / 10; // 保留 0.1 位,向上取
}
