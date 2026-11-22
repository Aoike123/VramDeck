import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ComputeBackend, HardwareSnapshot, HubEngineEntry, HubModelEntry } from '../types.ts';

export type VramFitTier = 'fits' | 'tight' | 'too_large';

export interface ModelRecommendation extends HubModelEntry {
  fit: VramFitTier;
  fits: boolean;
  available_vram_mb: number;
}

export interface MirrorSourceInput {
  mirror: string;
  repo: string;
  file?: string;
}

export interface LinkLocalModelOptions {
  id: string;
  engine_id?: string;
  dir?: string;
  path?: string;
  dataDir?: string;
}

const HUB_ENGINES: readonly HubEngineEntry[] = [
  {
    id: 'llama-cpp',
    name: 'llama.cpp Server',
    category: 'llm',
    driver: 'process',
    backends: ['cuda', 'rocm', 'metal', 'vulkan', 'cpu'],
    min_vram_mb: 0,
    description: 'Cross-platform GGUF LLM runtime via native llama-server process',
    homepage: 'https://github.com/ggml-org/llama.cpp',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'llm',
    driver: 'external',
    backends: ['cuda', 'rocm', 'metal', 'cpu'],
    min_vram_mb: 0,
    description: 'Adopt or connect a local Ollama daemon over HTTP',
    homepage: 'https://ollama.com',
  },
  {
    id: 'vllm',
    name: 'vLLM (OpenAI Server)',
    category: 'llm',
    driver: 'docker',
    backends: ['cuda', 'rocm'],
    min_vram_mb: 8192,
    description: 'High-throughput OpenAI-compatible PagedAttention container',
    homepage: 'https://docs.vllm.ai',
  },
  {
    id: 'comfyui',
    name: 'ComfyUI (Generic)',
    category: 'image',
    driver: 'external',
    backends: ['cuda', 'rocm', 'metal', 'vulkan', 'cpu'],
    min_vram_mb: 4096,
    description: 'Node-based image & video generation workflow engine',
    homepage: 'https://github.com/comfyanonymous/ComfyUI',
  },
  {
    id: 'whisper-cpp',
    name: 'whisper.cpp Server',
    category: 'audio',
    driver: 'process',
    backends: ['cuda', 'rocm', 'metal', 'vulkan', 'cpu'],
    min_vram_mb: 0,
    description: 'Lightweight cross-platform speech recognition server',
    homepage: 'https://github.com/ggml-org/whisper.cpp',
  },
  {
    id: 'kokoro',
    name: 'Kokoro / Fish-Speech TTS',
    category: 'audio',
    driver: 'process',
    backends: ['cuda', 'rocm', 'metal', 'cpu'],
    min_vram_mb: 0,
    description: 'Lightweight multilingual text-to-speech server',
    homepage: 'https://github.com/hexgrad/kokoro',
  },
  // ROCm Pro Pack (optional AMD R9700 optimized engines)
  {
    id: 'pation-model-qwen38-27b-w3a4',
    name: 'Qwen3.8 27B W3A4 (ROCm Pro)',
    category: 'llm',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 24576,
    description: 'AMD ROCm vLLM W3A4 long-context (256K) quantized LLM pack',
    pack: 'rocm-pro',
  },
  {
    id: 'pation-model-qwen38-27b-mxfp4',
    name: 'Qwen3.8 27B MXFP4 (ROCm Pro)',
    category: 'llm',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 24576,
    description: 'AMD ROCm MXFP4 alternate Qwen3.8 LLM package',
    pack: 'rocm-pro',
  },
  {
    id: 'pation-model-qwen-image-21',
    name: 'Qwen-Image 21 (ROCm Pro)',
    category: 'image',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 16384,
    description: 'AMD ROCm high-resolution image synthesis container',
    pack: 'rocm-pro',
  },
  {
    id: 'anima',
    name: 'Anima · ComfyUI (ROCm Pro)',
    category: 'image',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 12288,
    description: 'AMD ROCm ComfyUI anime/illustration image package',
    pack: 'rocm-pro',
  },
  {
    id: 'pation-model-minimax-h3',
    name: 'Goldfish / MiniMax H3 (ROCm Pro)',
    category: 'video',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 24576,
    description: 'AMD ROCm ComfyUI reference-guided video generation package',
    pack: 'rocm-pro',
  },
  {
    id: 'fish-drama3',
    name: 'Fish Drama 3 (ROCm Pro)',
    category: 'audio',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 8192,
    description: 'AMD ROCm voice cloning and multi-speaker drama TTS package',
    pack: 'rocm-pro',
  },
  {
    id: 'bs-roformer',
    name: 'BS-RoFormer (ROCm Pro)',
    category: 'audio',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 4096,
    description: 'AMD ROCm vocal/instrumental audio source separation package',
    pack: 'rocm-pro',
  },
  {
    id: 'qwen3-asr',
    name: 'Qwen3-ASR 1.7B (ROCm Pro)',
    category: 'audio',
    driver: 'docker',
    backends: ['rocm'],
    min_vram_mb: 4096,
    description: 'AMD ROCm multilingual speech transcription package',
    pack: 'rocm-pro',
  },
];

const HUB_MODELS: readonly HubModelEntry[] = [
  {
    id: 'qwen2.5-3b-instruct-q4_k_m',
    name: 'Qwen2.5 3B Instruct (Q4_K_M)',
    engine_id: 'llama-cpp',
    quantization: 'Q4_K_M',
    size_bytes: 2_050_000_000,
    recommended_vram_mb: 3072,
    sources: [
      {
        mirror: 'huggingface',
        repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
        files: ['qwen2.5-3b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'hf-mirror',
        repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
        files: ['qwen2.5-3b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'modelscope',
        repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
        files: ['qwen2.5-3b-instruct-q4_k_m.gguf'],
      },
    ],
  },
  {
    id: 'qwen2.5-7b-instruct-q4_k_m',
    name: 'Qwen2.5 7B Instruct (Q4_K_M)',
    engine_id: 'llama-cpp',
    quantization: 'Q4_K_M',
    size_bytes: 4_680_000_000,
    recommended_vram_mb: 6144,
    sources: [
      {
        mirror: 'huggingface',
        repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
        files: ['qwen2.5-7b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'hf-mirror',
        repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
        files: ['qwen2.5-7b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'modelscope',
        repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
        files: ['qwen2.5-7b-instruct-q4_k_m.gguf'],
      },
    ],
  },
  {
    id: 'qwen2.5-14b-instruct-q4_k_m',
    name: 'Qwen2.5 14B Instruct (Q4_K_M)',
    engine_id: 'llama-cpp',
    quantization: 'Q4_K_M',
    size_bytes: 8_990_000_000,
    recommended_vram_mb: 11264,
    sources: [
      {
        mirror: 'huggingface',
        repo: 'Qwen/Qwen2.5-14B-Instruct-GGUF',
        files: ['qwen2.5-14b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'hf-mirror',
        repo: 'Qwen/Qwen2.5-14B-Instruct-GGUF',
        files: ['qwen2.5-14b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'modelscope',
        repo: 'Qwen/Qwen2.5-14B-Instruct-GGUF',
        files: ['qwen2.5-14b-instruct-q4_k_m.gguf'],
      },
    ],
  },
  {
    id: 'qwen2.5-32b-instruct-q4_k_m',
    name: 'Qwen2.5 32B Instruct (Q4_K_M)',
    engine_id: 'llama-cpp',
    quantization: 'Q4_K_M',
    size_bytes: 19_850_000_000,
    recommended_vram_mb: 22528,
    sources: [
      {
        mirror: 'huggingface',
        repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
        files: ['qwen2.5-32b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'hf-mirror',
        repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
        files: ['qwen2.5-32b-instruct-q4_k_m.gguf'],
      },
      {
        mirror: 'modelscope',
        repo: 'Qwen/Qwen2.5-32B-Instruct-GGUF',
        files: ['qwen2.5-32b-instruct-q4_k_m.gguf'],
      },
    ],
  },
  {
    id: 'whisper-large-v3-turbo-q5_0',
    name: 'Whisper Large v3 Turbo (Q5_0)',
    engine_id: 'whisper-cpp',
    quantization: 'Q5_0',
    size_bytes: 574_000_000,
    recommended_vram_mb: 1536,
    sources: [
      {
        mirror: 'huggingface',
        repo: 'ggerganov/whisper.cpp',
        files: ['ggml-large-v3-turbo-q5_0.bin'],
      },
      {
        mirror: 'hf-mirror',
        repo: 'ggerganov/whisper.cpp',
        files: ['ggml-large-v3-turbo-q5_0.bin'],
      },
      {
        mirror: 'modelscope',
        repo: 'ggerganov/whisper.cpp',
        files: ['ggml-large-v3-turbo-q5_0.bin'],
      },
    ],
  },
];

function inferBackends(options: {
  snapshot?: HardwareSnapshot;
  os?: string;
  arch?: string;
}): Set<ComputeBackend> | null {
  if (!options.snapshot && !options.os && !options.arch) return null;
  const set = new Set<ComputeBackend>();
  const gpus = options.snapshot?.gpus ?? [];
  for (const gpu of gpus) {
    if (gpu.backend) set.add(gpu.backend);
  }
  const os = options.os ?? options.snapshot?.host?.os;
  const arch = options.arch ?? options.snapshot?.host?.arch;
  if (gpus.length === 0 && os === 'darwin' && arch === 'arm64') {
    set.add('metal');
  }
  set.add('cpu');
  return set;
}

export function matchEngines(
  options: {
    snapshot?: HardwareSnapshot;
    os?: string;
    arch?: string;
    category?: HubEngineEntry['category'];
  } = {},
): HubEngineEntry[] {
  const backends = inferBackends(options);
  let items = HUB_ENGINES.map((entry) => ({ ...entry, backends: [...entry.backends] }));

  if (options.category) {
    items = items.filter((entry) => entry.category === options.category);
  }
  if (backends) {
    items = items.filter((entry) => entry.backends.some((b) => backends.has(b)));
    // Prioritize non-pack native/lightweight engines ahead of optional packs unless hardware has matching backend
    items.sort((a, b) => {
      const aScore = a.pack === 'rocm-pro' && !backends.has('rocm') ? 1 : 0;
      const bScore = b.pack === 'rocm-pro' && !backends.has('rocm') ? 1 : 0;
      if (aScore !== bScore) return aScore - bScore;
      return (a.pack ? 1 : 0) - (b.pack ? 1 : 0);
    });
  }
  return items;
}

export const listEngines = matchEngines;
export const recommendEngines = matchEngines;

export function classifyVramFit(availableVramMb: number, recommendedVramMb: number): VramFitTier {
  if (recommendedVramMb <= 0) return 'fits';
  if (availableVramMb >= recommendedVramMb * 1.1) return 'fits';
  if (availableVramMb >= recommendedVramMb * 0.85) return 'tight';
  return 'too_large';
}

function resolveAvailableVramMb(options: {
  snapshot?: HardwareSnapshot;
  vramFreeMb?: number;
  vramMb?: number;
}): number {
  if (typeof options.vramFreeMb === 'number' && Number.isFinite(options.vramFreeMb)) {
    return Math.max(0, options.vramFreeMb);
  }
  if (typeof options.vramMb === 'number' && Number.isFinite(options.vramMb)) {
    return Math.max(0, options.vramMb);
  }
  const gpus = options.snapshot?.gpus ?? [];
  if (gpus.length > 0) {
    return Math.max(...gpus.map((g) => Math.max(0, g.vram_free_mb || g.vram_total_mb)));
  }
  return Math.max(0, options.snapshot?.host?.ram_free_mb ?? 0);
}

export function recommendModels(
  options: {
    snapshot?: HardwareSnapshot;
    vramFreeMb?: number;
    vramMb?: number;
    engine_id?: string;
  } = {},
): ModelRecommendation[] {
  const availableMb = resolveAvailableVramMb(options);
  let models = HUB_MODELS.map((m) => ({
    ...m,
    sources: m.sources.map((s) => ({ ...s, files: s.files ? [...s.files] : undefined })),
  }));
  if (options.engine_id) {
    models = models.filter((m) => m.engine_id === options.engine_id);
  }
  return models.map((model) => {
    const fit = classifyVramFit(availableMb, model.recommended_vram_mb);
    return {
      ...model,
      fit,
      fits: fit !== 'too_large',
      available_vram_mb: availableMb,
    };
  });
}

export const listModels = recommendModels;
export const matchModels = recommendModels;

export function resolveMirrorUrl(source: MirrorSourceInput): string {
  const repo = String(source.repo ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!repo || repo.includes('..') || /[\r\n\0]/.test(repo)) {
    throw new Error(`Invalid repository identifier: ${source.repo}`);
  }
  const file = source.file ? String(source.file).trim().replace(/^\/+/, '') : '';
  if (file.includes('..') || /[\r\n\0]/.test(file)) {
    throw new Error(`Invalid file path: ${source.file}`);
  }

  const mirror = String(source.mirror ?? 'huggingface')
    .trim()
    .toLowerCase();
  if (mirror === 'huggingface' || mirror === 'hf') {
    return file
      ? `https://huggingface.co/${repo}/resolve/main/${file}`
      : `https://huggingface.co/${repo}`;
  }
  if (mirror === 'hf-mirror' || mirror === 'hfmirror') {
    return file
      ? `https://hf-mirror.com/${repo}/resolve/main/${file}`
      : `https://hf-mirror.com/${repo}`;
  }
  if (mirror === 'modelscope' || mirror === 'ms') {
    return file
      ? `https://modelscope.cn/models/${repo}/resolve/master/${file}`
      : `https://modelscope.cn/models/${repo}`;
  }
  if (mirror === 'local') {
    return file ? join(repo, file) : repo;
  }
  throw new Error(`Unsupported Hub mirror: ${source.mirror}`);
}

export const mirrorUrl = resolveMirrorUrl;

export async function linkLocalModel(options: LinkLocalModelOptions): Promise<{
  id: string;
  engine_id: string;
  path: string;
  files: string[];
  linked_at: string;
}> {
  const id = String(options.id ?? '').trim();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new Error(`Invalid local model id: ${options.id}`);
  }
  const rawDir = String(options.dir ?? options.path ?? '').trim();
  if (!rawDir) {
    throw new Error('Local model directory path is required');
  }
  const resolvedDir = resolve(rawDir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Local model directory does not exist: ${resolvedDir}`);
  }
  const dirStat = await stat(resolvedDir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Local model path is not a directory: ${resolvedDir}`);
  }
  const entries = await readdir(resolvedDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const record = {
    id,
    engine_id: String(options.engine_id ?? 'llama-cpp'),
    path: resolvedDir,
    files,
    linked_at: new Date().toISOString(),
  };

  if (options.dataDir) {
    const storeFile = join(options.dataDir, 'hub-local-models.json');
    await mkdir(dirname(storeFile), { recursive: true });
    let existing: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(await readFile(storeFile, 'utf8')) as unknown;
      if (Array.isArray(parsed)) existing = parsed as Array<Record<string, unknown>>;
    } catch {}
    const next = existing.filter((entry) => entry.id !== id);
    next.push(record);
    const tmp = `${storeFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    try {
      await rename(tmp, storeFile);
    } catch {
      await writeFile(storeFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  return record;
}

export const registerLocalDirectory = linkLocalModel;
