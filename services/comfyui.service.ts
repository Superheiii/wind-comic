/**
 * ComfyUI API Service — IP-Adapter / InstantID 角色一致性
 *
 * 连接本地或远程 ComfyUI 服务器，通过 IP-Adapter 实现
 * 角色面部/全身的跨镜头一致性。
 *
 * 前置条件:
 *   1. ComfyUI 服务器运行中 (python main.py --listen 0.0.0.0 --port 8188)
 *   2. 安装 ComfyUI-IPAdapter-Plus 节点
 *   3. 下载 IP-Adapter 模型到 ComfyUI/models/ipadapter/
 *
 * 环境变量:
 *   COMFYUI_URL=http://localhost:8188   (ComfyUI 服务器地址)
 *   COMFYUI_ENABLED=true                (是否启用)
 */

const COMFYUI_URL = process.env.COMFYUI_BASE_URL || process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const COMFYUI_ENABLED = process.env.COMFYUI_ENABLED === 'true';

export function hasComfyUI(): boolean {
  return COMFYUI_ENABLED;
}

/** ControlNet 硬锁草图的 canny 模型名(safetensors),由 `COMFYUI_CONTROLNET_MODEL` 配。 */
export function comfyControlNetModel(): string | null {
  return process.env.COMFYUI_CONTROLNET_MODEL || null;
}

/**
 * v12.260:是否具备「草图 ControlNet 硬锁」能力 —— 需 ComfyUI 开启 + 配了 canny ControlNet 模型名。
 * 硬锁比 IP-Adapter 软参考更刚性:用草图的 Canny 边缘图作空间约束,严格锁构图/机位。
 * 需自托管 ComfyUI + 装 comfyui_controlnet_aux 节点 + 对应 canny 模型 —— 预备态,须 live 验证。
 */
export function hasComfyUIControlNet(): boolean {
  return process.env.COMFYUI_ENABLED === 'true' && !!comfyControlNetModel();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * IP-Adapter 一致性模式
 */
type ConsistencyMode =
  | 'face_only'        // 仅面部一致性 (FaceID)
  | 'full_character'   // 全身一致性 (IP-Adapter Plus)
  | 'style_transfer';  // 风格迁移

interface ComfyUIGenerateOptions {
  /** 角色参考图 URL */
  characterRefImage?: string;
  /** 场景参考图 URL */
  sceneRefImage?: string;
  /** v12.260 ControlNet 硬锁:草图/控制图 URL(取其 Canny 边缘作空间硬约束) */
  controlImageUrl?: string;
  /** ControlNet 强度 0-1,默认 0.8 */
  controlStrength?: number;
  /** 一致性模式 */
  consistencyMode?: ConsistencyMode;
  /** IP-Adapter 权重 (0-1, 默认 0.85) */
  ipAdapterWeight?: number;
  /** 宽度 */
  width?: number;
  /** 高度 */
  height?: number;
  /** CFG Scale */
  cfgScale?: number;
  /** 采样步数 */
  steps?: number;
  /** 使用的 checkpoint 模型 */
  checkpoint?: string;
}

interface ComfyUIPromptResponse {
  prompt_id: string;
  number: number;
}

interface ComfyUIHistoryResponse {
  [promptId: string]: {
    status: { status_str: string; completed: boolean };
    outputs: {
      [nodeId: string]: {
        images?: Array<{ filename: string; subfolder: string; type: string }>;
      };
    };
  };
}

export class ComfyUIService {
  private baseUrl: string;

  constructor(url?: string) {
    this.baseUrl = url || COMFYUI_URL;
  }

  /**
   * 检查 ComfyUI 服务器是否在线
   */
  async isOnline(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 使用 IP-Adapter 生成角色一致性图片
   *
   * @param prompt 正向提示词
   * @param options 参考图和一致性配置
   * @returns 生成的图片 URL
   */
  async generateWithIPAdapter(
    prompt: string,
    options: ComfyUIGenerateOptions
  ): Promise<string> {
    const online = await this.isOnline();
    if (!online) {
      throw new Error(`ComfyUI server not available at ${this.baseUrl}`);
    }

    console.log(`[ComfyUI] Generating with IP-Adapter (mode: ${options.consistencyMode || 'full_character'})`);
    console.log(`[ComfyUI] Prompt: ${prompt.slice(0, 120)}...`);

    // Step 1: 如果有参考图URL, 先上传到 ComfyUI
    let charRefFilename: string | undefined;
    let sceneRefFilename: string | undefined;

    if (options.characterRefImage) {
      charRefFilename = await this.uploadImageFromUrl(options.characterRefImage, 'char_ref');
      console.log(`[ComfyUI] Character ref uploaded: ${charRefFilename}`);
    }

    if (options.sceneRefImage) {
      sceneRefFilename = await this.uploadImageFromUrl(options.sceneRefImage, 'scene_ref');
      console.log(`[ComfyUI] Scene ref uploaded: ${sceneRefFilename}`);
    }

    // Step 2: 构建 ComfyUI workflow
    const workflow = this.buildIPAdapterWorkflow(prompt, {
      ...options,
      charRefFilename,
      sceneRefFilename,
    });

    // Step 3: 提交 workflow
    const promptId = await this.queuePrompt(workflow);
    console.log(`[ComfyUI] Queued: ${promptId}`);

    // Step 4: 等待结果
    const imageFilename = await this.waitForResult(promptId);

    // Step 5: 返回图片 URL
    return `${this.baseUrl}/view?filename=${imageFilename}`;
  }

  /**
   * v12.260:草图 ControlNet 硬锁生成 —— 用控制图的 Canny 边缘作**刚性空间约束**(比 IP-Adapter 软参考更严),
   * 严格锁住构图/机位/主体位置。需 ComfyUI 装 comfyui_controlnet_aux + 配 COMFYUI_CONTROLNET_MODEL。
   */
  async generateWithControlNet(prompt: string, options: ComfyUIGenerateOptions): Promise<string> {
    if (!hasComfyUIControlNet()) throw new Error('ComfyUI ControlNet 未启用(需 COMFYUI_ENABLED + COMFYUI_CONTROLNET_MODEL)');
    if (!options.controlImageUrl) throw new Error('generateWithControlNet 需要 controlImageUrl(草图/控制图)');
    if (!(await this.isOnline())) throw new Error(`ComfyUI server not available at ${this.baseUrl}`);

    console.log(`[ComfyUI] Generating with ControlNet (canny hard-lock): ${prompt.slice(0, 100)}...`);
    const controlFilename = await this.uploadImageFromUrl(options.controlImageUrl, 'ctrl_sketch');
    const workflow = buildControlNetWorkflow(prompt, { ...options, controlFilename, controlNetModel: comfyControlNetModel()! });
    const promptId = await this.queuePrompt(workflow);
    const imageFilename = await this.waitForResult(promptId);
    return `${this.baseUrl}/view?filename=${imageFilename}`;
  }

  // ═══════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════

  /**
   * 从 URL 下载图片并上传到 ComfyUI input 目录
   */
  private async uploadImageFromUrl(imageUrl: string, prefix: string): Promise<string> {
    // 下载图片
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);

    const blob = await response.blob();
    const filename = `${prefix}_${Date.now()}.png`;

    // 上传到 ComfyUI
    const formData = new FormData();
    formData.append('image', blob, filename);
    formData.append('overwrite', 'true');

    const uploadRes = await fetch(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: formData,
    });

    if (!uploadRes.ok) {
      throw new Error(`ComfyUI upload failed: ${uploadRes.status}`);
    }

    const uploadData = await uploadRes.json();
    return uploadData.name || filename;
  }

  /**
   * 构建 IP-Adapter 工作流
   * 核心节点链: Checkpoint → IP-Adapter → KSampler → VAE Decode → Save
   */
  private buildIPAdapterWorkflow(
    prompt: string,
    options: ComfyUIGenerateOptions & { charRefFilename?: string; sceneRefFilename?: string }
  ): Record<string, any> {
    const checkpoint = options.checkpoint || 'dreamshaperXL_v21TurboDPMSDE.safetensors';
    const width = options.width || 1344;
    const height = options.height || 768;
    const steps = options.steps || 25;
    const cfgScale = options.cfgScale || 7.0;
    const ipWeight = options.ipAdapterWeight ?? 0.85;

    const workflow: Record<string, any> = {};

    // Node 1: Load Checkpoint
    workflow['1'] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: checkpoint },
    };

    // Node 2: CLIP Text Encode (positive)
    workflow['2'] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: prompt,
        clip: ['1', 1],
      },
    };

    // Node 3: CLIP Text Encode (negative)
    workflow['3'] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: 'worst quality, low quality, blurry, deformed, ugly, bad anatomy, bad hands, text, watermark',
        clip: ['1', 1],
      },
    };

    // Node 4: Empty Latent Image
    workflow['4'] = {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 },
    };

    let modelOutput: [string, number] = ['1', 0]; // model output

    // Node 5: IP-Adapter (if character reference provided)
    if (options.charRefFilename) {
      // Load reference image
      workflow['10'] = {
        class_type: 'LoadImage',
        inputs: { image: options.charRefFilename },
      };

      // IP-Adapter Unified Loader
      workflow['11'] = {
        class_type: 'IPAdapterUnifiedLoader',
        inputs: {
          preset: options.consistencyMode === 'face_only'
            ? 'FACEID PLUS V2'
            : 'PLUS (high strength)',
          model: modelOutput,
        },
      };

      // IP-Adapter Apply
      workflow['12'] = {
        class_type: 'IPAdapterAdvanced',
        inputs: {
          weight: ipWeight,
          weight_type: 'linear',
          combine_embeds: 'concat',
          start_at: 0.0,
          end_at: 1.0,
          model: ['11', 0],
          ipadapter: ['11', 1],
          image: ['10', 0],
        },
      };

      modelOutput = ['12', 0];
    }

    // Node 6: KSampler
    workflow['6'] = {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 2147483647),
        steps,
        cfg: cfgScale,
        sampler_name: 'dpmpp_2m_sde',
        scheduler: 'karras',
        denoise: 1.0,
        model: modelOutput,
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    };

    // Node 7: VAE Decode
    workflow['7'] = {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['6', 0],
        vae: ['1', 2],
      },
    };

    // Node 8: Save Image
    workflow['8'] = {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: 'comic_studio',
        images: ['7', 0],
      },
    };

    return { prompt: workflow };
  }

  /**
   * 提交 workflow 到 ComfyUI 队列
   */
  private async queuePrompt(workflow: Record<string, any>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ComfyUI queue failed (${res.status}): ${err}`);
    }

    const data: ComfyUIPromptResponse = await res.json();
    return data.prompt_id;
  }

  /**
   * 等待 ComfyUI 完成并返回图片文件名
   */
  private async waitForResult(promptId: string, maxAttempts = 120): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(2000);

      try {
        const res = await fetch(`${this.baseUrl}/history/${promptId}`);
        if (!res.ok) continue;

        const data: ComfyUIHistoryResponse = await res.json();
        const entry = data[promptId];

        if (!entry) continue;

        if (entry.status.completed) {
          // 找到输出图片
          for (const nodeOutput of Object.values(entry.outputs)) {
            if (nodeOutput.images && nodeOutput.images.length > 0) {
              const img = nodeOutput.images[0];
              console.log(`[ComfyUI] Done: ${img.filename}`);
              return img.filename;
            }
          }
          throw new Error('ComfyUI: completed but no output image');
        }

        if (entry.status.status_str === 'error') {
          throw new Error('ComfyUI workflow execution failed');
        }
      } catch (e) {
        if (i === maxAttempts - 1) throw e;
      }
    }

    throw new Error('ComfyUI timeout (4 min)');
  }
}

/**
 * v12.260:构建「Canny ControlNet 硬锁」ComfyUI 工作流(纯函数,可测)。
 *
 * 节点链:Checkpoint → CLIP(正/负) → LoadImage(草图) → CannyEdgePreprocessor(取边缘)
 *   → ControlNetLoader + ControlNetApplyAdvanced(用边缘图硬约束正/负条件)→ KSampler → VAEDecode → Save。
 * 与 buildIPAdapterWorkflow 对称,区别:IP-Adapter 改 model,ControlNet 改 conditioning(空间硬锁)。
 * 需 ComfyUI 装 comfyui_controlnet_aux(CannyEdgePreprocessor)+ 对应 canny ControlNet 模型。
 */
export function buildControlNetWorkflow(
  prompt: string,
  options: ComfyUIGenerateOptions & { controlFilename: string; controlNetModel: string; seed?: number },
): { prompt: Record<string, any> } {
  const checkpoint = options.checkpoint || 'dreamshaperXL_v21TurboDPMSDE.safetensors';
  const width = options.width || 1344;
  const height = options.height || 768;
  const steps = options.steps || 25;
  const cfgScale = options.cfgScale || 7.0;
  const strength = options.controlStrength ?? 0.8;

  const workflow: Record<string, any> = {};
  workflow['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } };
  workflow['2'] = { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } };
  workflow['3'] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'worst quality, low quality, blurry, deformed, ugly, bad anatomy, bad hands, text, watermark', clip: ['1', 1] },
  };
  workflow['4'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };

  // 控制图 → Canny 边缘
  workflow['20'] = { class_type: 'LoadImage', inputs: { image: options.controlFilename } };
  workflow['21'] = {
    class_type: 'CannyEdgePreprocessor',
    inputs: { image: ['20', 0], low_threshold: 100, high_threshold: 200, resolution: Math.max(width, height) },
  };
  workflow['22'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: options.controlNetModel } };
  workflow['23'] = {
    class_type: 'ControlNetApplyAdvanced',
    inputs: {
      positive: ['2', 0], negative: ['3', 0],
      control_net: ['22', 0], image: ['21', 0],
      strength, start_percent: 0.0, end_percent: 1.0,
    },
  };

  workflow['6'] = {
    class_type: 'KSampler',
    inputs: {
      // 注:此文件既有代码亦用 Math.random 作种子;seed 可传入以便测试确定性
      seed: options.seed ?? Math.floor(Math.random() * 2147483647),
      steps, cfg: cfgScale, sampler_name: 'dpmpp_2m_sde', scheduler: 'karras', denoise: 1.0,
      model: ['1', 0],
      positive: ['23', 0],   // ControlNet 硬约束后的正条件
      negative: ['23', 1],   // ControlNet 硬约束后的负条件
      latent_image: ['4', 0],
    },
  };
  workflow['7'] = { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } };
  workflow['8'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'comic_controlnet', images: ['7', 0] } };

  return { prompt: workflow };
}
