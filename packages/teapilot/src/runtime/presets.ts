import type { PhysicalModel, Sampling, ThinkingSampling } from '../config.js';

/**
 * Known-good deployments. A preset records what to install and load and the
 * suggested context; it never bypasses live verification, which still decides
 * what the saved model may do.
 */
interface PresetBase {
  label: string;
  role: PhysicalModel;
  /** Suggested context tokens. */
  context: number;
  /** Approximate total download, in bytes. */
  bytes: number;
  /** Decoding settings for each reasoning level. */
  sampling?: ThinkingSampling;
}

export interface OllamaPreset extends PresetBase {
  runtime: 'ollama';
  /** Ollama model name to pull. */
  id: string;
  /** GPU memory suggested (system memory without a GPU), in GiB. */
  memoryGiB: number;
  /**
   * A quantized KV cache the suggested context needs, set on the Ollama server
   * (OLLAMA_KV_CACHE_TYPE). Without it, setup suggests fallbackContext.
   */
  server?: { kvCacheType: 'q8_0'; fallbackContext: number };
}

/** A Hugging Face repository at an immutable commit, and the folder it is saved as. */
export interface PinnedRepository { repository: string; revision: string; folder: string; bytes: number }

export interface TabbyPreset extends PresetBase {
  runtime: 'tabbyapi';
  id: string;
  /** The TabbyAPI commit and dependency set this preset was prepared with. */
  runtimeRevision: string;
  model: PinnedRepository;
  drafter?: PinnedRepository;
  /** Minimum GPU, checked with nvidia-smi. */
  hardware: { minimumMemoryMiB: number; minimumDriver: string; description: string };
  /** Settings for TabbyAPI's model load, needed to reproduce the deployment. */
  load: {
    cache_mode: string; max_batch_size: number; tool_format: string;
    /** Keeps the vision weights in system memory, for a GPU with no room for them. */ visionOffload?: boolean;
    /** Drafts with the model's own multi-token prediction head instead of a separate drafter. */ mtp?: boolean;
    /** GPU memory a load must leave free, in MiB, for the desktop and other programs on the same GPU. */ reserveMiB?: number;
  };
  /** Loads the model's vision tower, so it can be sent images. */
  vision?: boolean;
  /** True only once the whole combination has passed TeaPilot's live checks on the described hardware. */
  verified: boolean;
}

export type ModelPreset = OllamaPreset | TabbyPreset;

// TabbyAPI main on 2026-09-22 ("bump exllamav3 req to v1.5.1"). Its dependency set is pinned in tabby-lock.ts.
export const tabbyRevision = 'f07131cd8fe34e449fe87cdd3a066b52b96d3cac';

// Qwen's recommended decoding. Low temperatures send Qwen3.x into repeating itself,
// and a presence penalty would penalise the repetition code needs.
const thinking: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 };
export const qwenSampling: ThinkingSampling = { off: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 }, low: thinking, medium: thinking, xhigh: thinking };

export const modelPresets: ModelPreset[] = [
  { runtime: 'ollama', label: 'Fast - Qwen3.5-9B Heretic Q4_K_M', id: 'hf.co/mradermacher/Qwen3.5-9B-heretic-GGUF:Q4_K_M', bytes: 6_600_000_000, memoryGiB: 12, context: 8192, role: 'fast', sampling: qwenSampling },
  // 16.9 GB of weights leave room on a 24 GB GPU for a 64K context only with a q8_0 KV cache
  // (16 attention layers: 4 GiB at f16, 2 GiB at q8_0).
  {
    runtime: 'ollama', label: 'Capable - Qwen3.8-27B Heretic ARA Q4_K_M', id: 'hf.co/mradermacher/Qwen3.8-27B-heretic-ara-GGUF:Q4_K_M', bytes: 16_900_000_000, memoryGiB: 24,
    context: 65536, server: { kvCacheType: 'q8_0', fallbackContext: 32768 }, role: 'capable', sampling: qwenSampling,
  },
  // hf.co/DevJac/Qwen3.8-27B-heretic declares 65 blocks but omits the MTP block
  // (blk.64), so llama-server refuses to load it. Do not restore that preset.
  {
    runtime: 'tabbyapi', id: 'qwen3.8-27b-heretic-ara-exl3-4.0bpw-mtp-112k', label: 'Capable - Qwen3.8-27B Heretic ARA (4.0 bpw) with MTP drafting', role: 'capable',
    context: 114688, sampling: qwenSampling, bytes: 17_200_000_000, runtimeRevision: tabbyRevision,
    // The same Heretic ARA weights as the Ollama preset: 4.0 bpw layers, an 8-bit head, and the vision tower kept at BF16.
    model: { repository: 'Honkware/Qwen3.8-27B-heretic-ara-exl3-4.0bpw', revision: '1d09f16a35dc3c23b9634741bf61e6c746fcce21', folder: 'Qwen3.8-27B-heretic-ara-exl3-4.0bpw', bytes: 17_200_000_000 },
    // RTX 3090 24 GB class. CUDA 12.8 wheels need a 570.65 or newer Windows driver.
    hardware: { minimumMemoryMiB: 23 * 1024, minimumDriver: '570.65', description: '24 GB NVIDIA GPU (RTX 3090 class)' },
    // One sequence at a time: speculative decoding keeps recurrent state per sequence slot. The 112K Q8
    // cache leaves no room for the DFlash2 drafter (3.85 GB plus a cache as long as the context), so the
    // model drafts with its own MTP head; drafting never changes what is generated.
    load: { cache_mode: 'Q8', max_batch_size: 1, tool_format: 'qwen3_coder', mtp: true, reserveMiB: 1536 },
    vision: true,
    // 2026-10-07, RTX 3090 (driver 610.60, ~0.9 GB used by the desktop): 21.1 GB in use once loaded and
    // 22.6 GB at most while reading prompts of 16K-110K tokens with an image; six facts planted from 2% to
    // 97% deep and the image were all recalled at every length. 42-70 tok/s generating, 530-880 tok/s
    // reading. 32K with DFlash2 managed ~110 tok/s.
    verified: false,
  },
];

export const ollamaPresets = modelPresets.filter((preset): preset is OllamaPreset => preset.runtime === 'ollama');
export const tabbyPresets = modelPresets.filter((preset): preset is TabbyPreset => preset.runtime === 'tabbyapi');
