import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ComputeBackend,
  EngineManifestV2,
  GpuDevice,
  HardwareSnapshot,
  HubEngineEntry,
  HubModelEntry,
  ResourceSpec,
  RuntimeDriverSpec,
} from '../../../platforms/workbench/lib/types.ts';

export type HardwarePreset =
  'cpu-only' | 'single-gpu-24g' | 'dual-heterogeneous-24g-12g' | 'quad-24g' | 'apple-silicon-64g';

export function createMockGpuDevice(overrides: Partial<GpuDevice> = {}): GpuDevice {
  const total = overrides.vram_total_mb ?? 24576;
  const used = overrides.vram_used_mb ?? 1024;
  const free = overrides.vram_free_mb ?? Math.max(0, total - used);
  return {
    id: 'gpu-0',
    index: 0,
    vendor: 'nvidia',
    backend: 'cuda',
    name: 'Mock GPU 24G',
    unified_memory: false,
    vram_total_mb: total,
    vram_used_mb: used,
    vram_free_mb: free,
    utilization_pct: 5,
    temperature_c: 42,
    power_w: 38,
    ...overrides,
  };
}

export function createMockHardwareSnapshot(
  preset: HardwarePreset,
  overrides: Partial<HardwareSnapshot> = {},
): HardwareSnapshot {
  const baseHost = {
    os: process.platform,
    arch: process.arch,
    ram_total_mb: 65536,
    ram_free_mb: 49152,
  };

  let gpus: GpuDevice[] = [];
  if (preset === 'single-gpu-24g') {
    gpus = [createMockGpuDevice()];
  } else if (preset === 'dual-heterogeneous-24g-12g') {
    gpus = [
      createMockGpuDevice({
        id: 'gpu-0',
        index: 0,
        vendor: 'nvidia',
        backend: 'cuda',
        name: 'Mock GPU A 24G',
        vram_total_mb: 24576,
        vram_used_mb: 1024,
        vram_free_mb: 23552,
      }),
      createMockGpuDevice({
        id: 'gpu-1',
        index: 1,
        vendor: 'amd',
        backend: 'vulkan',
        name: 'Mock GPU B 12G',
        vram_total_mb: 12288,
        vram_used_mb: 512,
        vram_free_mb: 11776,
      }),
    ];
  } else if (preset === 'quad-24g') {
    gpus = [0, 1, 2, 3].map((index) =>
      createMockGpuDevice({
        id: `gpu-${index}`,
        index,
        vendor: 'nvidia',
        backend: 'cuda',
        name: `Mock Quad GPU ${index}`,
        vram_total_mb: 24576,
        vram_used_mb: 512,
        vram_free_mb: 24064,
      }),
    );
  } else if (preset === 'apple-silicon-64g') {
    gpus = [
      createMockGpuDevice({
        id: 'gpu-0',
        index: 0,
        vendor: 'apple',
        backend: 'metal',
        name: 'Mock Apple Silicon Unified',
        unified_memory: true,
        vram_total_mb: 49152,
        vram_used_mb: 4096,
        vram_free_mb: 45056,
        temperature_c: null,
        power_w: null,
      }),
    ];
  }

  return {
    collected_at: Date.now(),
    host: baseHost,
    gpus,
    ...overrides,
  };
}

export function createResourceSpec(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return {
    backends: ['cuda', 'rocm', 'vulkan'],
    gpu_count: 1,
    vram_mb: 8192,
    vram_mode: 'shared',
    concurrency: 2,
    affinity: 'any',
    cold_start_weight: 'medium',
    ...overrides,
  };
}

export interface EngineManifestOverrides {
  name?: string;
  category?: EngineManifestV2['category'];
  deployment_id?: string;
  version?: string;
  engine?: string;
  default_enabled?: boolean;
  port?: number;
  resources?: ResourceSpec;
  runtime?: Partial<RuntimeDriverSpec>;
  models?: EngineManifestV2['platform']['models'];
  surface?: Record<string, unknown>;
  panel?: 'llm' | 'media';
}

export function createEngineManifestV2(overrides: EngineManifestOverrides = {}): EngineManifestV2 {
  const category = overrides.category ?? 'llm';
  const engine = overrides.engine ?? 'mock-llm';
  const name = overrides.name ?? engine;
  const panel = overrides.panel ?? (category === 'llm' ? 'llm' : 'media');
  const runtime: RuntimeDriverSpec = {
    id: `${engine}-rt`,
    name: `${name} Runtime`,
    driver: 'process',
    port: overrides.port ?? 18995,
    concurrency: 2,
    command: 'node',
    args: ['--version'],
    ...overrides.runtime,
  };

  const defaultModels: EngineManifestV2['platform']['models'] =
    category === 'llm'
      ? [{ id: `${engine}-model`, capabilities: ['chat.completions'], priority: 10 }]
      : [{ id: `${engine}-model`, capabilities: ['image.generate'], priority: 10 }];

  const defaultSurface: Record<string, unknown> =
    category === 'llm'
      ? {
          'chat.completions': {
            tool: 'chat_completions',
            label: 'Chat Completions',
            order: 10,
            kind: 'text',
            sync: '/v1/chat/completions',
          },
        }
      : {
          'image.generate': {
            tool: 'generate_image',
            label: 'Generate Image',
            order: 20,
            kind: 'image',
            sync: '/v1/images/generations',
          },
        };

  return {
    name,
    category,
    deployment_id: overrides.deployment_id ?? name,
    version: overrides.version ?? '1.0.0',
    platform: {
      engine,
      default_enabled: overrides.default_enabled ?? true,
      adapter: 'adapter.mjs',
      runtime,
      resources: overrides.resources ?? createResourceSpec(),
      ui: {
        name,
        description: `${name} mock engine`,
        symbol: '◆',
        accent: '#6ec3ff',
        panel,
      },
      models: overrides.models ?? defaultModels,
      surface: overrides.surface ?? defaultSurface,
    },
  };
}

export async function writeMockEnginePackage(
  enginesRoot: string,
  manifest: EngineManifestV2,
  adapterSource?: string,
): Promise<{ dir: string; manifestPath: string; adapterPath: string }> {
  const dir = path.join(enginesRoot, manifest.category, manifest.name);
  await mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, 'engine.json');
  const adapterPath = path.join(dir, manifest.platform.adapter || 'adapter.mjs');
  const source =
    adapterSource ??
    [
      'export default {',
      '  async idle() { return true; },',
      '  async ready() { return true; },',
      '};',
      '',
    ].join('\n');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(adapterPath, source, 'utf8');
  return { dir, manifestPath, adapterPath };
}

export function createPlatformConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const baseStorage = {
    state: 'auto',
    artifacts: 'auto',
    marker: '.llm-backend-artifacts',
    import_roots: ['auto'],
    quota_gib: 500,
    min_free_gib: 50,
  };
  const overrideStorage =
    overrides.storage && typeof overrides.storage === 'object'
      ? (overrides.storage as Record<string, unknown>)
      : {};
  return {
    mode: 'few-gpu-pool',
    gateway_port: 18982,
    management_port: 13000,
    control_port: 18990,
    state_file: 'workspace/config/platform-state.json',
    next_dist: '.next-workbench',
    ...overrides,
    storage: {
      ...baseStorage,
      ...overrideStorage,
    },
  };
}

export function createHubCatalogFixtures(): {
  engines: HubEngineEntry[];
  models: HubModelEntry[];
} {
  const backends: ComputeBackend[] = ['cuda', 'rocm', 'metal', 'vulkan', 'cpu'];
  const engines: HubEngineEntry[] = [
    {
      id: 'llama-cpp',
      name: 'llama.cpp',
      category: 'llm',
      driver: 'process',
      backends,
      min_vram_mb: 2048,
      description: 'Lightweight cross-platform GGUF LLM runtime',
      homepage: 'https://github.com/ggml-org/llama.cpp',
    },
    {
      id: 'ollama',
      name: 'Ollama',
      category: 'llm',
      driver: 'external',
      backends,
      min_vram_mb: 2048,
      description: 'Local Ollama daemon adoption',
    },
    {
      id: 'pation-model-qwen38-27b-w3a4',
      name: 'Qwen3.8 27B W3A4',
      category: 'llm',
      driver: 'docker',
      backends: ['rocm'],
      min_vram_mb: 24576,
      description: 'ROCm Pro Pack 27B W3A4 engine',
      pack: 'rocm-pro',
    },
  ];
  const models: HubModelEntry[] = [
    {
      id: 'qwen2.5-7b-q4_k_m',
      name: 'Qwen 2.5 7B Instruct Q4_K_M',
      engine_id: 'llama-cpp',
      quantization: 'Q4_K_M',
      size_bytes: 4_800_000_000,
      recommended_vram_mb: 6144,
      sources: [
        { mirror: 'huggingface', repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF' },
        { mirror: 'hf-mirror', repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF' },
        { mirror: 'modelscope', repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF' },
      ],
    },
  ];
  return { engines, models };
}
