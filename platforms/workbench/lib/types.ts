// Core TypeScript contracts for the Few-GPU resource pool, cross-platform hardware discovery,
// pluggable runtime drivers, engine manifests, telemetry, and model/engine hub.
// Uses strictly erasable ES2023 TypeScript syntax so Node.js 22.19+ runs `.ts` natively.

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'cpu';

export type ComputeBackend = 'cuda' | 'rocm' | 'metal' | 'vulkan' | 'cpu';

export interface GpuDevice {
  id: string;
  index: number;
  vendor: GpuVendor;
  backend: ComputeBackend;
  name: string;
  unified_memory: boolean;
  vram_total_mb: number;
  vram_used_mb: number;
  vram_free_mb: number;
  utilization_pct: number | null;
  temperature_c: number | null;
  power_w: number | null;
}

export interface HostResources {
  os: string;
  arch: string;
  ram_total_mb: number;
  ram_free_mb: number;
}

export interface HardwareSnapshot {
  collected_at: number;
  host: HostResources;
  gpus: GpuDevice[];
}

export interface DeviceProvider {
  readonly id: string;
  detect(): Promise<HardwareSnapshot>;
}

export type VramMode = 'shared' | 'exclusive';

export type ColdStartWeight = 'low' | 'medium' | 'high';

export type GpuAffinity = 'any' | `prefer:${string}` | `pin:${string}`;

export interface ResourceSpec {
  backends: ComputeBackend[];
  gpu_count: number;
  vram_mb: number;
  vram_mode: VramMode;
  concurrency: number;
  affinity?: GpuAffinity;
  cold_start_weight?: ColdStartWeight;
}

export interface PoolSlot {
  gpu_id: string;
  reserved_mb: number;
  mode: VramMode;
}

export interface PoolAllocation {
  allocation_id: string;
  runtime_id: string;
  engine: string;
  slots: PoolSlot[];
  active_leases: number;
  capacity: number;
  allocated_at: number;
}

export interface EvictionCandidate {
  allocation_id: string;
  runtime_id: string;
  gpu_ids: string[];
  freed_vram_mb: number;
  cold_start_weight: ColdStartWeight;
  idle: boolean;
  batch_eligible: boolean;
}

export interface PoolStatus {
  gpus: GpuDevice[];
  allocations: PoolAllocation[];
  queued: number;
  switching_targets: string[];
}

export type RuntimeDriverKind = 'process' | 'docker' | 'external';

export interface RuntimeDriverSpec {
  id: string;
  name: string;
  driver: RuntimeDriverKind;
  port: number;
  concurrency?: number;
  resources?: ResourceSpec;
  native_ui?: string;
  container?: string;
  extra_containers?: string[];
  launch?: string[];
  image?: string;
  volumes?: string[];
  cwd?: string;
  docker_args?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  base_url?: string;
  health_path?: string;
}

export interface RuntimeHandle {
  runtime_id: string;
  driver: RuntimeDriverKind;
  base_url: string;
  gpu_ids: string[];
  pid?: number;
  container?: string;
}

export interface RuntimeLaunchOptions {
  gpu_ids: string[];
  env?: Record<string, string>;
  args?: string[];
  cold?: boolean;
  backend?: ComputeBackend;
}

export interface RuntimeDriver {
  readonly kind: RuntimeDriverKind;
  start(spec: RuntimeDriverSpec, options: RuntimeLaunchOptions): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle): Promise<void>;
  isRunning(spec: RuntimeDriverSpec): Promise<boolean>;
  logs?(handle: RuntimeHandle, options?: { since?: string; tail?: number }): Promise<string>;
}

export interface EngineManifestV2 {
  name: string;
  category: 'llm' | 'image' | 'video' | 'audio';
  deployment_id?: string;
  version?: string;
  platform: {
    engine: string;
    default_enabled?: boolean;
    adapter: string;
    interruptible?: boolean;
    runtime: RuntimeDriverSpec;
    resources?: ResourceSpec;
    ui: {
      name: string;
      version?: string;
      full_name?: string;
      log_name?: string;
      description: string;
      summary?: string;
      symbol: string;
      accent: string;
      panel: 'llm' | 'media';
      works?: Array<{
        id: string;
        label: string;
        icon?: string;
        view?: 'gallery' | 'voices';
        capabilities: string[];
        kinds?: Array<'image' | 'video' | 'audio' | 'text'>;
      }>;
    };
    models: Array<{
      id: string;
      capabilities: string[];
      priority?: number;
      info?: Record<string, unknown>;
    }>;
    surface?: Record<string, unknown>;
    surface_files?: string[];
  };
}

export interface EngineAdapterContext {
  engine: string;
  runtime: RuntimeDriverSpec;
  base: string;
  gpu_ids?: string[];
  dataDir?: string;
  backend?: unknown;
}

export interface EngineAdapter {
  init?(ctx: EngineAdapterContext): Promise<void> | void;
  idle(ctx: EngineAdapterContext): Promise<boolean>;
  ready(ctx: EngineAdapterContext): Promise<boolean>;
  models?(
    ctx: EngineAdapterContext,
  ): Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>>;
  resolveChatRequest?(
    ctx: EngineAdapterContext,
    body: Record<string, unknown>,
  ): Promise<boolean> | boolean;
  prepareChat?(
    ctx: EngineAdapterContext,
    body: Record<string, unknown>,
  ): Promise<{
    leaseOptions?: Record<string, unknown>;
    responseHeaders?: Record<string, string>;
    state?: unknown;
  }>;
  beforeChat?(
    ctx: EngineAdapterContext,
    body: Record<string, unknown>,
    runtime: {
      prepared: unknown;
      ticket: { token: string };
      reserveBudget: (units: number, capacity?: number | null) => Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<Record<string, unknown>>;
  validatePolicy?(policy: Record<string, unknown>): Record<string, unknown>;
  policyState?(
    ctx: EngineAdapterContext,
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  acquireOptions?(
    ctx: EngineAdapterContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  residencyStatus?(
    ctx: EngineAdapterContext,
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  matches?(ctx: EngineAdapterContext, policy?: Record<string, unknown>): Promise<boolean> | boolean;
  park?(
    ctx: EngineAdapterContext,
    report?: (phase: string, message: string, source?: string) => void,
  ): Promise<boolean> | boolean;
  parked?(ctx: EngineAdapterContext): Promise<boolean> | boolean;
  resume?(
    ctx: EngineAdapterContext,
    policy?: Record<string, unknown>,
    report?: (phase: string, message: string, source?: string) => void,
  ): Promise<boolean> | boolean;
  launchArgs?(ctx: EngineAdapterContext, policy?: Record<string, unknown>): string[];
  launchEnv?(ctx: EngineAdapterContext, options?: { cold?: boolean }): Record<string, string>;
  startupCheck?(ctx: EngineAdapterContext): Promise<void> | void;
  verify?(ctx: EngineAdapterContext, policy?: Record<string, unknown>): Promise<void> | void;
  retryCold?(ctx: EngineAdapterContext): Promise<boolean> | boolean;
  runtimeSpec?(
    ctx: EngineAdapterContext,
    policy?: Record<string, unknown>,
  ): Promise<Partial<RuntimeDriverSpec> | null> | Partial<RuntimeDriverSpec> | null;
  chat?(
    ctx: EngineAdapterContext,
    payload: Record<string, unknown>,
    options: {
      req?: unknown;
      res: unknown;
      stream: boolean;
      requestedModel?: string;
      signal?: AbortSignal;
    },
  ): Promise<boolean | void>;
  payload?(
    capability: string,
    input: Record<string, unknown>,
    helpers?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  effective?(
    capability: string,
    input: Record<string, unknown>,
    media?: Record<string, unknown>,
    job?: Record<string, unknown>,
  ): Record<string, unknown>;
  startupLogs?(
    ctx: EngineAdapterContext,
  ): Promise<{ id?: string; complete?: boolean; output?: string } | null> | null;
  logContainers?(
    ctx: EngineAdapterContext,
    rows: string[],
  ): { containers: string[]; label: string };
  execute?(
    capability: string,
    payload: Record<string, unknown>,
    ctx: EngineAdapterContext & {
      outputDirectory?: string;
      onSubmitted?: (backend: Record<string, unknown>) => Promise<void> | void;
    },
  ): Promise<{
    data?: unknown[];
    artifacts?: Array<{
      kind: string;
      file: string;
      mime: string;
      name?: string;
      media?: Record<string, unknown>;
    }>;
  }>;
  reconfigure?(
    ctx: EngineAdapterContext,
    policy: Record<string, unknown>,
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  metrics?(ctx: EngineAdapterContext): Promise<Record<string, number | null>>;
  interrupt?(ctx: EngineAdapterContext, promptId?: string): Promise<void>;
  onStop?(ctx: EngineAdapterContext): Promise<void> | void;
}

export interface TelemetrySample {
  timestamp: number;
  values: Record<string, number | null>;
}

export interface TelemetrySeries {
  metric: string;
  points: Array<[number, number | null]>;
}

export interface HubEngineEntry {
  id: string;
  name: string;
  category: 'llm' | 'image' | 'video' | 'audio';
  driver: RuntimeDriverKind;
  backends: ComputeBackend[];
  min_vram_mb: number;
  description: string;
  homepage?: string;
  pack?: string;
}

export interface HubModelEntry {
  id: string;
  name: string;
  engine_id: string;
  quantization?: string;
  size_bytes: number;
  recommended_vram_mb: number;
  sources: Array<{
    mirror: 'huggingface' | 'hf-mirror' | 'modelscope' | 'local';
    repo: string;
    files?: string[];
  }>;
}

export interface DownloadProgress {
  task_id: string;
  target: string;
  status: 'queued' | 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bps: number;
  error?: string;
}
