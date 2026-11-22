import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../api-errors.mjs';
import type {
  ColdStartWeight,
  ComputeBackend,
  DeviceProvider,
  EvictionCandidate,
  GpuDevice,
  HardwareSnapshot,
  PoolAllocation,
  PoolSlot,
  PoolStatus,
  ResourceSpec,
  VramMode,
} from '../types.ts';
import { EngineScheduling } from './engine-scheduling.ts';
import type { SchedulingPolicy } from './engine-scheduling.ts';

export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LOCAL = 'local';
const COLD_WEIGHT_SCORE: Record<ColdStartWeight, number> = { low: 0, medium: 1, high: 2 };

export interface AccessKeysLike {
  limits(key: string): { maxConcurrent: number; maxQueued: number } | null | undefined;
  settings(): { maxConcurrent: number; maxQueued: number };
}

export interface BackendLike {
  models?: Record<string, unknown>;
  resources?: Record<string, ResourceSpec>;
  deviceProvider?: DeviceProvider;
  hardwareSnapshot?: () => Promise<HardwareSnapshot>;
  ensure?: (
    engine: string,
    deadline: number,
    clock: () => number,
    policy?: Record<string, unknown>,
    report?: (phase: string, message: string, source?: string) => void,
    gpuIds?: string[],
  ) => Promise<void>;
  start?: (
    engine: string,
    options?: { gpu_ids?: string[]; policy?: Record<string, unknown> },
  ) => Promise<void>;
  stop?: (engine: string, gpuIds?: string[]) => Promise<void>;
  unload?: (engine: string, gpuIds?: string[]) => Promise<void>;
  idle?: (engine: string) => Promise<boolean>;
}

export interface PoolCoordinatorOptions {
  clock?: () => number;
  leaseSeconds?: number;
  sharedLimit?: number;
  engineScheduling?: SchedulingPolicy;
  sharedEngines?: Record<string, number> | null;
  keys?: AccessKeysLike | null;
  deviceProvider?: DeviceProvider | null;
  snapshot?: HardwareSnapshot | null;
  resources?: Record<string, ResourceSpec> | null;
  getResourceSpec?: (engine: string) => ResourceSpec | null | undefined;
  groupOf?: (engine: string) => string | null | undefined;
  runtimeFor?: (engine: string) => string | null | undefined;
  capacityOf?: (engine: string) => number | undefined;
  idleSettleMs?: number;
  mediaRecovery?: () => boolean;
}

export interface AcquireOptions {
  timeout?: number;
  key?: string;
  exclusive?: boolean;
  concurrency?: number;
  modeKey?: string;
  slot?: string;
  policy?: Record<string, unknown>;
  switchRequest?: boolean;
  signal?: AbortSignal;
  enqueuedAt?: number;
}

export interface LeaseTicket {
  token: string;
  model: string;
  engine: string;
  lease_seconds: number;
  allocation_id: string;
  gpu_ids: string[];
}

interface InternalAllocation {
  allocation_id: string;
  runtime_id: string;
  engine: string;
  slots: PoolSlot[];
  capacity: number;
  allocated_at: number;
  last_active_at: number;
  cold_start_weight: ColdStartWeight;
  vram_mode: VramMode;
  exclusive: boolean;
  modeKey: string | null;
  switching: boolean;
  evicting: boolean;
  tokens: Map<string, number>;
  keys: Map<string, string>;
  slotsMap: Map<string, string>;
  reservations: Map<string, number>;
}

interface QueuedRequest {
  engine: string;
  key: string;
  exclusive: boolean;
  concurrency: number | null;
  modeKey: string | null;
  slot: string | null;
  policy?: Record<string, unknown>;
  spec: ResourceSpec;
  hasExplicitSpec: boolean;
  enqueuedAt: number;
  signal?: AbortSignal;
  deadline: number;
  resolve: (ticket: LeaseTicket) => void;
  reject: (err: unknown) => void;
  cancel: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SwitchProgress {
  id: string;
  target: string;
  from: string | null;
  phase: string;
  started_at: number;
  finished_at?: number;
  events: Array<{ time: string; source: string; message: string }>;
}

export interface ReconfigureState {
  id: string;
  engine: string;
  target: string;
  policy: Record<string, unknown>;
  previous_container: string | null;
  started_at: number;
  finished_at?: number;
  phase: string;
  events: Array<{ time: string; source: string; message: string }>;
}

interface EvictionPlan {
  gpuSet: GpuDevice[];
  victims: InternalAllocation[];
  allBatchEligible: boolean;
  coldWeightSum: number;
  excessVramMb: number;
  oldestLastActiveAt: number;
}

function isBackendObject(value: unknown): value is BackendLike {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.ensure === 'function' ||
    typeof obj.start === 'function' ||
    typeof obj.idle === 'function' ||
    typeof obj.hardwareSnapshot === 'function' ||
    'models' in obj
  );
}

function gpuSnapshotUsedMb(gpu: GpuDevice): number {
  const fromUsed = Number.isFinite(gpu.vram_used_mb) ? gpu.vram_used_mb : 0;
  const fromFree = Number.isFinite(gpu.vram_free_mb)
    ? Math.max(0, gpu.vram_total_mb - gpu.vram_free_mb)
    : fromUsed;
  return Math.max(0, fromUsed, fromFree);
}

function combinationsOfSize<T>(items: ReadonlyArray<T>, size: number): T[][] {
  if (size === 0) return [[]];
  if (size > items.length) return [];
  if (size === 1) return items.map((item) => [item]);
  const out: T[][] = [];
  const current: T[] = [];
  const walk = (start: number) => {
    if (current.length === size) {
      out.push([...current]);
      return;
    }
    const needed = size - current.length;
    for (let i = start; i <= items.length - needed; i++) {
      current.push(items[i]);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

export class GpuPoolCoordinator {
  backend: BackendLike;
  clock: () => number;
  leaseSeconds: number;
  sharedLimit: number;
  sharedEngines: Record<string, number> | null;
  keys: AccessKeysLike | null;
  deviceProvider: DeviceProvider | null;
  scheduling: EngineScheduling;
  mediaRecovery?: () => boolean;

  readonly #staticSnapshot: HardwareSnapshot | null;
  readonly #explicitResources: Record<string, ResourceSpec>;
  readonly #getResourceSpec?: (engine: string) => ResourceSpec | null | undefined;
  readonly #groupOfFn: (engine: string) => string | null | undefined;
  readonly #capacityOfFn?: (engine: string) => number | undefined;
  readonly #idleSettleMs: number;
  readonly #baselineUsedMb = new Map<string, number>();
  #mutationEpoch = 0;

  snapshot: HardwareSnapshot | null = null;
  allocations: InternalAllocation[] = [];
  queue: QueuedRequest[] = [];
  waiters: Array<() => void> = [];
  switchingTargets = new Set<string>();
  enginePolicies = new Map<string, Record<string, unknown>>();

  switching = false;
  target: string | null = null;
  current: string | null = null;
  error: string | null = null;
  engineSwitch: SwitchProgress | null = null;
  reconfiguring: ReconfigureState | null = null;
  pumping: Promise<void> | null = null;
  again = false;
  tick: ReturnType<typeof setInterval> | null = null;

  constructor(
    backendOrConfig: BackendLike | PoolCoordinatorOptions = {},
    maybeOptions: PoolCoordinatorOptions | BackendLike = {},
  ) {
    let backend: BackendLike;
    let options: PoolCoordinatorOptions;

    if (isBackendObject(backendOrConfig)) {
      backend = backendOrConfig;
      options = (maybeOptions as PoolCoordinatorOptions) ?? {};
    } else if (isBackendObject(maybeOptions)) {
      options = (backendOrConfig as PoolCoordinatorOptions) ?? {};
      backend = maybeOptions;
    } else {
      backend = (backendOrConfig as BackendLike) ?? {};
      options = (maybeOptions as PoolCoordinatorOptions) ?? {};
    }

    this.backend = backend;
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.sharedLimit = options.sharedLimit ?? Number.POSITIVE_INFINITY;
    this.sharedEngines = options.sharedEngines ?? null;
    this.keys = options.keys ?? null;
    this.deviceProvider = options.deviceProvider ?? backend.deviceProvider ?? null;
    this.#staticSnapshot = options.snapshot ?? null;
    this.#explicitResources = { ...(backend.resources ?? {}), ...(options.resources ?? {}) };
    this.#getResourceSpec = options.getResourceSpec;
    this.#groupOfFn = options.groupOf ?? options.runtimeFor ?? ((engine) => engine);
    this.#capacityOfFn = options.capacityOf;
    this.#idleSettleMs = options.idleSettleMs ?? 0;
    this.mediaRecovery = options.mediaRecovery;

    this.scheduling = new EngineScheduling(options.engineScheduling ?? {}, {
      groupOf: (engine) => this.#groupOfFn(engine),
    });
    this.leaseSeconds =
      options.leaseSeconds ?? Math.max(120, this.scheduling.policy.maxWaitSeconds * 2);

    if (this.#staticSnapshot) {
      this.#applySnapshot(this.#staticSnapshot);
    }
  }

  get #hasDeviceTopology(): boolean {
    return Boolean(
      this.deviceProvider ||
      this.#staticSnapshot ||
      typeof this.backend.hardwareSnapshot === 'function',
    );
  }

  // Backward-compatible getter returning the primary active or first allocation for single-GPU callers.
  get owner(): InternalAllocation | null {
    const active = this.allocations.find((a) => a.tokens.size > 0);
    return active ?? null;
  }

  async init(): Promise<this> {
    await this.refreshDevices();
    return this;
  }

  async refreshDevices(): Promise<HardwareSnapshot | null> {
    let next: HardwareSnapshot | null = null;
    if (this.deviceProvider) {
      next = await this.deviceProvider.detect();
    } else if (typeof this.backend.hardwareSnapshot === 'function') {
      next = await this.backend.hardwareSnapshot();
    } else if (this.#staticSnapshot) {
      next = this.#staticSnapshot;
    }
    if (next) {
      this.#applySnapshot(next);
    }
    return next;
  }

  #applySnapshot(snap: HardwareSnapshot): void {
    this.snapshot = snap;
    for (const gpu of snap.gpus) {
      if (this.#reservedMbForGpu(gpu.id) === 0 || !this.#baselineUsedMb.has(gpu.id)) {
        this.#baselineUsedMb.set(gpu.id, gpuSnapshotUsedMb(gpu));
      }
    }
  }

  async #ensureSnapshot(): Promise<void> {
    if (this.snapshot !== null) return;
    if (this.#hasDeviceTopology) {
      await this.refreshDevices();
    }
  }

  #reservedMbForGpu(gpuId: string): number {
    let total = 0;
    for (const alloc of this.allocations) {
      if (alloc.evicting) continue;
      for (const slot of alloc.slots) {
        if (slot.gpu_id === gpuId) total += slot.reserved_mb;
      }
    }
    return total;
  }

  #baselineMbForGpu(gpu: GpuDevice): number {
    return this.#baselineUsedMb.get(gpu.id) ?? gpuSnapshotUsedMb(gpu);
  }

  #effectiveUsedMb(gpu: GpuDevice): number {
    const snapUsed = gpuSnapshotUsedMb(gpu);
    const baseline = this.#baselineMbForGpu(gpu);
    const reserved = this.#reservedMbForGpu(gpu.id);
    return Math.max(snapUsed, baseline + reserved);
  }

  #effectiveFreeMb(gpu: GpuDevice): number {
    return Math.max(0, gpu.vram_total_mb - this.#effectiveUsedMb(gpu));
  }

  #maxAchievableFreeMb(gpu: GpuDevice): number {
    const snapUsed = gpuSnapshotUsedMb(gpu);
    const baseline = this.#baselineMbForGpu(gpu);
    const reserved = this.#reservedMbForGpu(gpu.id);
    const nonPoolUsed = Math.max(baseline, Math.max(0, snapUsed - reserved));
    return Math.max(0, gpu.vram_total_mb - nonPoolUsed);
  }

  capacity(engine: string): number {
    const cap = (n: number) =>
      Number.isFinite(this.sharedLimit) ? Math.min(this.sharedLimit, n) : n;
    const policy = this.enginePolicies.get(engine);
    if (policy && Number.isInteger(policy.concurrency) && (policy.concurrency as number) > 0) {
      return cap(policy.concurrency as number);
    }
    const fromFn = this.#capacityOfFn?.(engine);
    if (fromFn !== undefined && Number.isInteger(fromFn) && fromFn > 0) {
      return cap(fromFn);
    }
    const explicit = this.#explicitResources[engine] ?? this.#getResourceSpec?.(engine);
    if (explicit && Number.isInteger(explicit.concurrency) && explicit.concurrency > 0) {
      return cap(explicit.concurrency);
    }
    if (this.sharedEngines && Object.hasOwn(this.sharedEngines, engine)) {
      return cap(this.sharedEngines[engine]);
    }
    return 1;
  }

  #resolveSpec(
    engine: string,
    concurrencyOverride: number | null,
    exclusiveFlag: boolean,
  ): { spec: ResourceSpec; hasExplicitSpec: boolean } {
    const explicit =
      (Object.hasOwn(this.#explicitResources, engine) ? this.#explicitResources[engine] : null) ??
      this.#getResourceSpec?.(engine) ??
      null;
    if (explicit) {
      return {
        spec: {
          ...explicit,
          concurrency: concurrencyOverride ?? explicit.concurrency ?? 1,
          affinity: explicit.affinity ?? 'any',
          cold_start_weight: explicit.cold_start_weight ?? 'low',
        },
        hasExplicitSpec: true,
      };
    }
    const gpus = this.snapshot?.gpus ?? [];
    const concurrency = concurrencyOverride ?? this.capacity(engine);
    const backends: ComputeBackend[] = gpus.length
      ? [...new Set(gpus.map((g) => g.backend))]
      : ['cpu'];
    return {
      spec: {
        backends,
        gpu_count: gpus.length > 0 ? 1 : 0,
        vram_mb: 0,
        // Legacy manifests without explicit ResourceSpec keep exclusive GPU ownership
        // against other engines while sharing same-engine leases up to `concurrency`.
        vram_mode: 'exclusive',
        concurrency: exclusiveFlag ? 1 : concurrency,
        affinity: 'any',
        cold_start_weight: 'low',
      },
      hasExplicitSpec: false,
    };
  }

  #isKnownEngine(engine: string): boolean {
    if (typeof engine !== 'string' || !engine) return false;
    if (Object.hasOwn(this.#explicitResources, engine)) return true;
    if (this.#getResourceSpec?.(engine)) return true;
    if (this.backend.models) return Object.hasOwn(this.backend.models, engine);
    return !['__proto__', 'constructor', 'toString', 'valueOf'].includes(engine);
  }

  #assertSatisfiable(engine: string, spec: ResourceSpec, hasExplicitSpec: boolean): void {
    if (!this.#hasDeviceTopology || !hasExplicitSpec) return;
    const gpus = this.snapshot?.gpus ?? [];
    if (spec.gpu_count === 0) return;
    if (gpus.length === 0) {
      if (spec.backends.includes('cpu')) return;
      throw Object.assign(
        new Error(
          `No compatible GPU available for ${engine} (requires ${spec.backends.join('/')})`,
        ),
        { code: 'ENGINE_UNAVAILABLE', status: 503 },
      );
    }

    if (spec.affinity?.startsWith('pin:')) {
      const pinId = spec.affinity.slice(4);
      const pinned = gpus.find((g) => g.id === pinId);
      if (!pinned) {
        throw Object.assign(new Error(`Pinned GPU ${pinId} not found for ${engine}`), {
          code: 'ENGINE_UNAVAILABLE',
          status: 400,
        });
      }
      if (!spec.backends.includes(pinned.backend)) {
        throw Object.assign(
          new Error(`Pinned GPU ${pinId} backend ${pinned.backend} incompatible with ${engine}`),
          { code: 'ENGINE_UNAVAILABLE', status: 400 },
        );
      }
      if (this.#maxAchievableFreeMb(pinned) < spec.vram_mb) {
        throw Object.assign(
          new Error(`Pinned GPU ${pinId} lacks ${spec.vram_mb} MB VRAM for ${engine}`),
          { code: 'ENGINE_UNAVAILABLE', status: 503 },
        );
      }
      if (spec.gpu_count > 1) {
        const sameBackendFit = gpus.filter(
          (g) => g.backend === pinned.backend && this.#maxAchievableFreeMb(g) >= spec.vram_mb,
        );
        if (sameBackendFit.length < spec.gpu_count) {
          throw Object.assign(
            new Error(`Insufficient ${pinned.backend} GPUs for ${engine} (need ${spec.gpu_count})`),
            { code: 'ENGINE_UNAVAILABLE', status: 503 },
          );
        }
      }
      return;
    }

    for (const backend of spec.backends) {
      const fitting = gpus.filter(
        (g) => g.backend === backend && this.#maxAchievableFreeMb(g) >= spec.vram_mb,
      );
      if (fitting.length >= spec.gpu_count) return;
    }

    throw Object.assign(
      new Error(
        `No ${spec.gpu_count}x ${spec.backends.join('/')} GPU(s) with ${spec.vram_mb} MB VRAM for ${engine}`,
      ),
      { code: 'ENGINE_UNAVAILABLE', status: 503 },
    );
  }

  selectWaitingRequest(requests: ReadonlyArray<QueuedRequest>): QueuedRequest | null {
    return this.scheduling.choose(requests, this.target ?? this.current, this.clock()).request;
  }

  running(key?: string): number {
    let count = 0;
    for (const alloc of this.allocations) {
      for (const holder of alloc.keys.values()) {
        if (key === undefined ? holder !== LOCAL : holder === key) count++;
      }
    }
    return count;
  }

  keyActivity() {
    const byKey: Record<string, { active: number; queued: number }> = {};
    const row = (key: string) => (byKey[key] ??= { active: 0, queued: 0 });
    for (const alloc of this.allocations) {
      for (const key of alloc.keys.values()) {
        if (key !== LOCAL) row(key).active++;
      }
    }
    for (const request of this.queue) {
      if (request.key !== LOCAL) row(request.key).queued++;
    }
    return {
      active: this.running(),
      queued: this.queue.filter((r) => r.key !== LOCAL).length,
      byKey,
    };
  }

  hasActiveWork(): boolean {
    return (
      this.allocations.some((a) => a.tokens.size > 0 || a.switching || a.evicting) ||
      this.switching ||
      this.switchingTargets.size > 0 ||
      this.queue.length > 0 ||
      this.reconfiguring !== null
    );
  }

  status(): PoolStatus & Record<string, unknown> {
    const now = this.clock();
    const gpus: GpuDevice[] = this.snapshot?.gpus ?? [];
    const committed = this.allocations.filter((a) => !a.switching && !a.evicting);
    const publicAllocations: PoolAllocation[] = committed.map((a) => ({
      allocation_id: a.allocation_id,
      runtime_id: a.runtime_id,
      engine: a.engine,
      slots: a.slots.map((s) => ({ ...s })),
      active_leases: a.tokens.size,
      capacity: a.capacity,
      allocated_at: a.allocated_at,
    }));

    const activeAllocs = committed.filter((a) => a.tokens.size > 0);
    const totalActiveLeases = committed.reduce((sum, a) => sum + a.tokens.size, 0);
    const primaryActive = activeAllocs[0] ?? null;
    const leaseExpired = committed.some(
      (a) => a.tokens.size > 0 && Math.max(...a.tokens.values()) < now,
    );
    const switchingTargets = [...this.switchingTargets];
    if (this.target && !this.switchingTargets.has(this.target)) {
      switchingTargets.push(this.target);
    }

    const activeSlots: Record<string, number> = {};
    for (const alloc of committed) {
      for (const slotName of alloc.slotsMap.values()) {
        activeSlots[slotName] = (activeSlots[slotName] ?? 0) + 1;
      }
    }

    return {
      gpus,
      allocations: publicAllocations,
      queued: this.queue.length,
      switching_targets: switchingTargets,
      current: this.current,
      leased: totalActiveLeases > 0,
      lease_model: primaryActive?.engine ?? null,
      active_leases: totalActiveLeases,
      lease_capacity: primaryActive ? (primaryActive.exclusive ? 1 : primaryActive.capacity) : null,
      lease_expired: leaseExpired,
      engine_scheduling: this.scheduling.status(this.queue, this.target ?? this.current, now),
      switching: this.switching || switchingTargets.length > 0,
      switching_target: switchingTargets[0] ?? this.target ?? null,
      last_error: this.error,
      engine_switch: this.engineSwitch,
      reconfiguring: this.reconfiguring,
      active_slots: activeSlots,
    };
  }

  notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  changed(ms = 1000, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.waiters.indexOf(done);
        if (idx >= 0) this.waiters.splice(idx, 1);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.push(done);
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  #issueTicket(alloc: InternalAllocation, request: QueuedRequest): LeaseTicket {
    const now = this.clock();
    this.scheduling.granted(request.engine, now);
    const token = randomBytes(32).toString('base64url');
    alloc.tokens.set(token, now + this.leaseSeconds);
    alloc.keys.set(token, request.key);
    alloc.last_active_at = now;
    if (request.slot) alloc.slotsMap.set(token, request.slot);
    return {
      token,
      model: request.engine,
      engine: request.engine,
      lease_seconds: this.leaseSeconds,
      allocation_id: alloc.allocation_id,
      gpu_ids: alloc.slots.map((s) => s.gpu_id),
    };
  }

  #dropToken(alloc: InternalAllocation, token: string): void {
    alloc.tokens.delete(token);
    alloc.slotsMap.delete(token);
    alloc.reservations.delete(token);
    alloc.keys.delete(token);
    this.#mutationEpoch++;
  }

  async #isBackendIdle(engine: string): Promise<boolean> {
    if (typeof this.backend.idle !== 'function') return true;
    try {
      return Boolean(await this.backend.idle(engine));
    } catch {
      return false;
    }
  }

  async #stopBackend(engine: string, gpuIds: string[]): Promise<void> {
    if (typeof this.backend.stop === 'function') {
      await this.backend.stop(engine, gpuIds);
      return;
    }
    if (typeof this.backend.unload === 'function') {
      await this.backend.unload(engine, gpuIds);
    }
  }

  async #loadBackend(request: QueuedRequest, gpuIds: string[], track: boolean): Promise<void> {
    const engine = request.engine;
    const policy = request.policy ?? this.enginePolicies.get(engine);
    if (typeof this.backend.ensure === 'function') {
      await this.backend.ensure(
        engine,
        request.deadline,
        this.clock,
        policy,
        track ? (...args) => this.engineProgress(...args) : undefined,
        gpuIds,
      );
      return;
    }
    if (typeof this.backend.start === 'function') {
      await this.backend.start(engine, { gpu_ids: gpuIds, policy });
    }
  }

  async recover(): Promise<void> {
    const now = this.clock();
    for (const alloc of [...this.allocations]) {
      if (
        alloc.tokens.size > 0 &&
        !alloc.switching &&
        !alloc.evicting &&
        Math.max(...alloc.tokens.values()) < now
      ) {
        const idle = await this.#isBackendIdle(alloc.engine);
        if (
          idle &&
          this.allocations.includes(alloc) &&
          alloc.tokens.size > 0 &&
          Math.max(...alloc.tokens.values()) < this.clock()
        ) {
          alloc.tokens.clear();
          alloc.keys.clear();
          alloc.slotsMap.clear();
          alloc.reservations.clear();
          this.#mutationEpoch++;
          this.notify();
        }
      }
    }
  }

  assertAcceptingRequests(engine?: string): void {
    if (this.mediaRecovery?.()) {
      throw Object.assign(new Error('Media startup recovery in progress; inference is paused'), {
        status: 503,
      });
    }
    if (this.reconfiguring && (!engine || this.reconfiguring.engine === engine)) {
      throw Object.assign(
        new Error('Engine reconfiguration is in progress; new inference requests are paused'),
        { status: 409 },
      );
    }
  }

  beginEngineSwitch(model: string): void {
    this.engineSwitch = {
      id: randomBytes(8).toString('hex'),
      target: model,
      from: this.current,
      phase: 'preparing',
      started_at: Date.now(),
      events: [],
    };
    this.engineProgress('preparing', `准备 ${model} 引擎`);
  }

  engineProgress(phase: string, message: string, source = 'scheduler'): void {
    if (!this.engineSwitch) return;
    this.engineSwitch.phase = phase;
    this.engineSwitch.events.push({
      time: new Date().toISOString(),
      source,
      message: String(message).slice(-8192),
    });
    this.engineSwitch.events = this.engineSwitch.events.slice(-120);
    if (phase === 'ready' || phase === 'error') {
      this.engineSwitch.finished_at = Date.now();
    }
  }

  async reconfigure(
    engine: string,
    policy: Record<string, unknown>,
    options: {
      previousContainer?: string | null;
      apply?: (
        policy: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
      onComplete?: (
        policy: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (this.reconfiguring) {
      throw Object.assign(new Error('Engine reconfiguration already in progress'), { status: 409 });
    }
    this.assertAcceptingRequests(engine);

    const previousPolicy = this.enginePolicies.get(engine);
    if (
      previousPolicy &&
      JSON.stringify(policy) === JSON.stringify(previousPolicy) &&
      this.allocations.some((a) => a.engine === engine && !a.evicting)
    ) {
      return { mode: policy.mode ?? null, policy, unchanged: true };
    }

    const state: ReconfigureState = {
      id: randomBytes(8).toString('hex'),
      engine,
      target: String(policy.mode ?? engine),
      policy,
      previous_container: options.previousContainer ?? null,
      started_at: Date.now(),
      phase: 'draining',
      events: [],
    };
    const logEvent = (message: string) => {
      state.events.push({ time: new Date().toISOString(), source: 'scheduler', message });
      state.events = state.events.slice(-80);
    };
    this.reconfiguring = state;
    logEvent(`Waiting for existing ${engine} tasks before applying updated configuration`);

    const deadline = this.clock() + 900;
    let ownsSwitch = false;
    try {
      while (
        this.allocations.some((a) => a.engine === engine && a.tokens.size > 0) ||
        this.queue.some((r) => r.engine === engine) ||
        this.switchingTargets.has(engine)
      ) {
        if (this.clock() >= deadline) {
          throw new Error('Timed out waiting for existing tasks; configuration unchanged');
        }
        await this.recover();
        await this.changed(200);
      }

      this.switching = true;
      ownsSwitch = true;
      this.target = engine;
      this.switchingTargets.add(engine);
      state.phase = 'loading';
      this.beginEngineSwitch(engine);
      logEvent(`Loading ${engine} with the updated configuration`);

      const existingAlloc = this.allocations.find((a) => a.engine === engine && !a.evicting);
      const gpuIds = existingAlloc ? existingAlloc.slots.map((s) => s.gpu_id) : [];

      if (typeof this.backend.ensure === 'function') {
        await this.backend.ensure(
          engine,
          deadline,
          this.clock,
          policy,
          (...args) => this.engineProgress(...args),
          gpuIds,
        );
      }

      if (!existingAlloc) {
        const { spec } = this.#resolveSpec(engine, Number(policy.concurrency) || null, false);
        const now = this.clock();
        this.allocations.push({
          allocation_id: randomUUID(),
          runtime_id: this.#groupOfFn(engine) ?? engine,
          engine,
          slots: gpuIds.map((gpu_id) => ({
            gpu_id,
            reserved_mb: spec.vram_mb,
            mode: spec.vram_mode,
          })),
          capacity: Math.min(this.sharedLimit, Number(policy.concurrency) || spec.concurrency),
          allocated_at: now,
          last_active_at: now,
          cold_start_weight: spec.cold_start_weight ?? 'low',
          vram_mode: spec.vram_mode,
          exclusive: false,
          modeKey: null,
          switching: false,
          evicting: false,
          tokens: new Map(),
          keys: new Map(),
          slotsMap: new Map(),
          reservations: new Map(),
        });
      } else {
        existingAlloc.capacity = Math.min(
          this.sharedLimit,
          Number(policy.concurrency) || existingAlloc.capacity,
        );
      }

      this.current = engine;
      this.scheduling.resetRuntime(engine);
      this.error = null;
      state.phase = 'saving';

      const applied = (await options.apply?.(policy)) ?? (await options.onComplete?.(policy));
      this.enginePolicies.set(engine, policy);

      state.phase = 'ready';
      state.finished_at = Date.now();
      logEvent('Engine ready; updated configuration is active');
      this.engineProgress('ready', `${engine} 引擎就绪，配置已生效`);
      return {
        mode: policy.mode ?? null,
        policy,
        ...(applied && typeof applied === 'object' ? applied : {}),
      };
    } catch (e) {
      const msg = (e as Error).message;
      this.error = msg;
      state.phase = 'error';
      logEvent(`Configuration failed: ${msg}`);
      if (ownsSwitch) this.engineProgress('error', msg);
      throw e;
    } finally {
      if (ownsSwitch) {
        this.switchingTargets.delete(engine);
        this.switching = this.switchingTargets.size > 0;
        if (this.target === engine) this.target = null;
      }
      this.reconfiguring = null;
      this.pump();
    }
  }

  async reserveBudget(
    token: string,
    amount: number,
    timeout = 900,
    { signal, capacity }: { signal?: AbortSignal; capacity?: number | null } = {},
  ): Promise<void> {
    const alloc = this.allocations.find((a) => a.tokens.has(token));
    if (!alloc) throw new Error('Invalid lease token');
    if (capacity == null) return;
    if (amount > capacity) {
      throw Object.assign(
        new Error(`Request requires ${amount} units but capacity is ${capacity}`),
        { status: 400 },
      );
    }
    const deadline = this.clock() + timeout;
    while (this.allocations.includes(alloc) && alloc.tokens.has(token)) {
      if (signal?.aborted) throw new ApiError('CLIENT_REQUEST_CANCELLED');
      const used = [...alloc.reservations.values()].reduce((a, b) => a + b, 0);
      if (used + amount <= capacity) {
        alloc.reservations.set(token, amount);
        return;
      }
      if (this.clock() >= deadline) throw new ApiError('KV_CAPACITY_WAIT_TIMEOUT');
      await this.changed(Math.max(1, Math.min(1000, (deadline - this.clock()) * 1000)), signal);
    }
    throw new Error('Invalid lease token');
  }

  admitToQueue(key: string): void {
    if (key === LOCAL) return;
    const limits = this.keys?.limits(key);
    if (!limits) throw new ApiError('API_KEY_INVALID');
    const reject = (code: string, current: number, limit: number): never => {
      throw new ApiError(code, { details: { current, limit }, retryAfterSeconds: 5 });
    };
    const mine = this.running(key) + this.queue.filter((r) => r.key === key).length;
    if (mine >= limits.maxConcurrent + limits.maxQueued) {
      reject(
        limits.maxQueued ? 'API_KEY_QUEUE_FULL' : 'API_KEY_CONCURRENCY_LIMIT_EXCEEDED',
        limits.maxQueued ? mine - limits.maxConcurrent : mine,
        limits.maxQueued || limits.maxConcurrent,
      );
    }
    const global = this.keys!.settings();
    const all = this.running() + this.queue.filter((r) => r.key !== LOCAL).length;
    if (all >= global.maxConcurrent + global.maxQueued) {
      reject(
        global.maxQueued ? 'GLOBAL_QUEUE_FULL' : 'GLOBAL_CONCURRENCY_LIMIT_EXCEEDED',
        global.maxQueued ? all - global.maxConcurrent : all,
        global.maxQueued || global.maxConcurrent,
      );
    }
  }

  acquire(engine: string, options: AcquireOptions = {}): Promise<LeaseTicket> {
    const {
      timeout = 900,
      key = LOCAL,
      exclusive = false,
      concurrency = null,
      modeKey = null,
      slot = null,
      policy,
      signal,
      enqueuedAt = this.clock(),
    } = options;

    const enqueue = (): Promise<LeaseTicket> => {
      this.assertAcceptingRequests(engine);
      if (!this.#isKnownEngine(engine)) {
        throw Object.assign(new Error('Unknown or disabled engine: ' + engine), {
          code: 'ENGINE_UNAVAILABLE',
        });
      }
      if (signal?.aborted) {
        throw new ApiError('CLIENT_REQUEST_CANCELLED');
      }

      const effectiveKey = key ?? LOCAL;
      this.admitToQueue(effectiveKey);

      const { spec, hasExplicitSpec } = this.#resolveSpec(engine, concurrency, exclusive);
      this.#assertSatisfiable(engine, spec, hasExplicitSpec);

      return new Promise<LeaseTicket>((resolve, reject) => {
        const request: QueuedRequest = {
          engine,
          key: effectiveKey,
          exclusive,
          concurrency,
          modeKey,
          slot,
          policy,
          spec,
          hasExplicitSpec,
          enqueuedAt,
          signal,
          deadline: this.clock() + timeout,
          resolve,
          reject,
          cancel: () => {},
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
        };
        request.cancel = () => this.settle(request, new ApiError('CLIENT_REQUEST_CANCELLED'));
        request.timer = setTimeout(
          () =>
            this.settle(
              request,
              new ApiError(
                effectiveKey === LOCAL ? 'GPU_LEASE_QUEUE_TIMEOUT' : 'ADMISSION_QUEUE_WAIT_TIMEOUT',
                effectiveKey === LOCAL
                  ? {}
                  : { details: { wait_seconds: timeout }, retryAfterSeconds: 5 },
              ),
            ),
          Math.max(0, timeout * 1000),
        );
        signal?.addEventListener('abort', request.cancel, { once: true });
        this.queue.push(request);
        this.startTick();
        this.pump();
      });
    };

    if (this.snapshot === null && this.#hasDeviceTopology) {
      return this.#ensureSnapshot().then(enqueue);
    }
    try {
      return enqueue();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  settle(request: QueuedRequest, error: unknown, ticket?: LeaseTicket): boolean {
    const index = this.queue.indexOf(request);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.cancel);
    if (error) request.reject(error);
    else if (ticket) request.resolve(ticket);
    this.notify();
    if (error) this.pump();
    return true;
  }

  eligible(request: QueuedRequest): boolean {
    if (request.key === LOCAL) return true;
    const limits = this.keys?.limits(request.key);
    if (!limits) {
      this.settle(request, new ApiError('API_KEY_INVALID'));
      return false;
    }
    return (
      this.running(request.key) < limits.maxConcurrent &&
      this.running() < this.keys!.settings().maxConcurrent
    );
  }

  fairest(candidates: ReadonlyArray<QueuedRequest>): QueuedRequest {
    return candidates.reduce((best, r) => {
      const a = this.running(r.key);
      const b = this.running(best.key);
      return a < b || (a === b && r.enqueuedAt < best.enqueuedAt) ? r : best;
    });
  }

  pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.again = false;
          await this.dispatch();
        } while (this.again);
      } catch (e) {
        console.error('GPU dispatch failed:', (e as Error).message);
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  #allocationsOnGpu(gpuId: string): InternalAllocation[] {
    return this.allocations.filter((a) => !a.evicting && a.slots.some((s) => s.gpu_id === gpuId));
  }

  #candidateGpuSets(
    spec: ResourceSpec,
    requireImmediateFree: boolean,
    drainingGpus: ReadonlySet<string>,
    requestExclusive: boolean,
    engine?: string,
  ): GpuDevice[][] {
    const gpus = this.snapshot?.gpus ?? [];
    if (!this.#hasDeviceTopology && gpus.length === 0) {
      if (requireImmediateFree) {
        return this.allocations.some((a) => !a.evicting) ? [] : [[]];
      }
      return [[]];
    }
    if (spec.gpu_count === 0 || (gpus.length === 0 && spec.backends.includes('cpu'))) {
      const needExclusive = spec.vram_mode === 'exclusive' || requestExclusive;
      if (requireImmediateFree) {
        const conflict = this.allocations.some(
          (a) =>
            !a.evicting &&
            (a.engine === engine || needExclusive || a.exclusive || a.vram_mode === 'exclusive'),
        );
        return conflict ? [] : [[]];
      }
      return [[]];
    }

    const pinId = spec.affinity?.startsWith('pin:') ? spec.affinity.slice(4) : null;
    const preferId = spec.affinity?.startsWith('prefer:') ? spec.affinity.slice(7) : null;

    const fitsGpu = (gpu: GpuDevice): boolean => {
      if (drainingGpus.has(gpu.id)) return false;
      if (!spec.backends.includes(gpu.backend)) return false;
      const onGpu = this.#allocationsOnGpu(gpu.id);
      if (requireImmediateFree) {
        if (onGpu.some((a) => a.exclusive || a.vram_mode === 'exclusive')) return false;
        if ((spec.vram_mode === 'exclusive' || requestExclusive) && onGpu.length > 0) return false;
        return this.#effectiveFreeMb(gpu) >= spec.vram_mb;
      }
      return this.#maxAchievableFreeMb(gpu) >= spec.vram_mb;
    };

    const byBackend = new Map<ComputeBackend, GpuDevice[]>();
    for (const gpu of gpus) {
      if (!fitsGpu(gpu)) continue;
      if (spec.gpu_count === 1 && pinId && gpu.id !== pinId) continue;
      const list = byBackend.get(gpu.backend) ?? [];
      list.push(gpu);
      byBackend.set(gpu.backend, list);
    }

    const groups: GpuDevice[][] = [];
    for (const list of byBackend.values()) {
      if (list.length < spec.gpu_count) continue;
      for (const combo of combinationsOfSize(list, spec.gpu_count)) {
        if (pinId && !combo.some((g) => g.id === pinId)) continue;
        groups.push(combo);
      }
    }

    groups.sort((a, b) => {
      if (preferId) {
        const aPref = a.some((g) => g.id === preferId) ? 0 : 1;
        const bPref = b.some((g) => g.id === preferId) ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
      }
      const aFree = a.reduce((sum, g) => sum + this.#effectiveFreeMb(g), 0);
      const bFree = b.reduce((sum, g) => sum + this.#effectiveFreeMb(g), 0);
      if (aFree !== bFree) return aFree - bFree;
      const aMinIdx = Math.min(...a.map((g) => g.index));
      const bMinIdx = Math.min(...b.map((g) => g.index));
      return aMinIdx - bMinIdx;
    });

    return groups;
  }

  #findWarmHit(
    request: QueuedRequest,
    drainingAllocations: ReadonlySet<string>,
  ): InternalAllocation | null {
    for (const alloc of this.allocations) {
      if (alloc.evicting || alloc.switching || drainingAllocations.has(alloc.allocation_id)) {
        continue;
      }
      if (alloc.engine !== request.engine) continue;
      if (alloc.modeKey && request.modeKey && alloc.modeKey !== request.modeKey) continue;
      if (!request.exclusive && !alloc.exclusive && alloc.tokens.size < alloc.capacity) {
        return alloc;
      }
      if (request.exclusive && alloc.tokens.size === 0) {
        alloc.exclusive = true;
        alloc.capacity = 1;
        return alloc;
      }
    }
    return null;
  }

  async #trySiblingWarmHit(
    request: QueuedRequest,
    drainingAllocations: ReadonlySet<string>,
    drainingGpus: ReadonlySet<string>,
  ): Promise<boolean> {
    const runtimeId = this.#groupOfFn(request.engine) ?? request.engine;
    for (const alloc of this.allocations) {
      if (
        alloc.evicting ||
        alloc.switching ||
        drainingAllocations.has(alloc.allocation_id) ||
        alloc.runtime_id !== runtimeId ||
        alloc.engine === request.engine ||
        alloc.tokens.size > 0
      ) {
        continue;
      }
      if (alloc.slots.some((s) => drainingGpus.has(s.gpu_id))) continue;
      if (!(await this.#isBackendIdle(alloc.engine))) continue;
      if (alloc.tokens.size > 0 || alloc.evicting || alloc.switching) continue;

      const gpuIds = alloc.slots.map((s) => s.gpu_id);
      alloc.switching = true;
      this.switchingTargets.add(request.engine);
      this.switching = true;
      this.target = request.engine;
      try {
        await this.#loadBackend(request, gpuIds, false);
        alloc.engine = request.engine;
        alloc.capacity = request.concurrency ?? request.spec.concurrency;
        alloc.exclusive = request.exclusive;
        alloc.vram_mode = request.spec.vram_mode;
        alloc.modeKey = request.modeKey;
        alloc.switching = false;
        this.current = request.engine;
        this.error = null;
        if (this.queue.includes(request)) {
          this.settle(request, null, this.#issueTicket(alloc, request));
        }
        return true;
      } catch (e) {
        const err = e as Error & { code?: string };
        this.error = err.message;
        err.code ??= 'ENGINE_UNAVAILABLE';
        this.allocations = this.allocations.filter((a) => a !== alloc);
        this.current = null;
        this.settle(request, err);
        return true;
      } finally {
        alloc.switching = false;
        this.switchingTargets.delete(request.engine);
        this.switching = this.switchingTargets.size > 0;
        if (this.target === request.engine) this.target = null;
      }
    }
    return false;
  }

  async #placeAndLoad(request: QueuedRequest, gpuSet: GpuDevice[]): Promise<void> {
    const engine = request.engine;
    const runtimeId = this.#groupOfFn(engine) ?? engine;
    const gpuIds = gpuSet.map((g) => g.id);
    const now = this.clock();

    const slots: PoolSlot[] = gpuSet.map((g) => ({
      gpu_id: g.id,
      reserved_mb: request.spec.vram_mb,
      mode: request.spec.vram_mode,
    }));

    const pendingAlloc: InternalAllocation = {
      allocation_id: randomUUID(),
      runtime_id: runtimeId,
      engine,
      slots,
      capacity: request.exclusive ? 1 : (request.concurrency ?? request.spec.concurrency),
      allocated_at: now,
      last_active_at: now,
      cold_start_weight: request.spec.cold_start_weight ?? 'low',
      vram_mode: request.spec.vram_mode,
      exclusive: request.exclusive,
      modeKey: request.modeKey,
      switching: true,
      evicting: false,
      tokens: new Map(),
      keys: new Map(),
      slotsMap: new Map(),
      reservations: new Map(),
    };

    const previousEngine = this.current;
    const track =
      previousEngine !== engine ||
      (request.modeKey !== null &&
        this.allocations.some((a) => a.engine === engine && a.modeKey !== request.modeKey));

    this.allocations.push(pendingAlloc);
    this.switching = true;
    this.target = engine;
    this.switchingTargets.add(engine);
    if (track) this.beginEngineSwitch(engine);

    try {
      await this.#loadBackend(request, gpuIds, track);
      if (track) {
        this.engineProgress('ready', `${engine} 引擎已就绪`);
        if (this.scheduling.group(previousEngine) !== this.scheduling.group(engine)) {
          this.scheduling.turn = null;
        }
      }
      pendingAlloc.switching = false;
      this.current = engine;
      this.error = null;
      if (this.queue.includes(request)) {
        this.settle(request, null, this.#issueTicket(pendingAlloc, request));
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      if (track) this.engineProgress('error', err.message);
      this.error = err.message;
      this.current = null;
      err.code ??= 'ENGINE_UNAVAILABLE';
      this.allocations = this.allocations.filter((a) => a !== pendingAlloc);
      this.settle(request, err);
    } finally {
      this.switchingTargets.delete(engine);
      this.switching = this.switchingTargets.size > 0;
      if (this.target === engine) this.target = null;
    }
  }

  #victimsForGpuSet(
    gpuSet: GpuDevice[],
    request: QueuedRequest,
    eligibleQueue: ReadonlyArray<QueuedRequest>,
    now: number,
    idleIds: ReadonlySet<string>,
  ): { victims: InternalAllocation[] | null; busy: InternalAllocation[] } {
    // Legacy virtual single-slot mode or CPU fallback when 0 GPUs are present.
    if (
      gpuSet.length === 0 &&
      (!this.#hasDeviceTopology ||
        ((this.snapshot?.gpus?.length ?? 0) === 0 && request.spec.backends.includes('cpu')))
    ) {
      const existing = this.allocations.filter((a) => !a.evicting);
      if (!existing.length) return { victims: null, busy: [] };
      const busy = existing.filter((a) => !idleIds.has(a.allocation_id));
      if (busy.length > 0) return { victims: null, busy };
      return { victims: existing, busy: [] };
    }
    if (gpuSet.length === 0) return { victims: null, busy: [] };

    const gpuIds = new Set(gpuSet.map((g) => g.id));
    const overlapping = this.allocations.filter(
      (a) => !a.evicting && a.slots.some((s) => gpuIds.has(s.gpu_id)),
    );
    if (!overlapping.length) return { victims: null, busy: [] };

    const mustEvict = new Set<InternalAllocation>();
    const needExclusive = request.spec.vram_mode === 'exclusive' || request.exclusive;
    for (const alloc of overlapping) {
      if (needExclusive || alloc.exclusive || alloc.vram_mode === 'exclusive') {
        mustEvict.add(alloc);
      }
    }

    const busyMandatory = [...mustEvict].filter((a) => !idleIds.has(a.allocation_id));
    if (busyMandatory.length > 0) {
      return { victims: null, busy: busyMandatory };
    }

    const busyShortfall = new Set<InternalAllocation>();
    for (const gpu of gpuSet) {
      const remainingIdleOnGpu = overlapping.filter(
        (a) =>
          !mustEvict.has(a) &&
          idleIds.has(a.allocation_id) &&
          a.slots.some((s) => s.gpu_id === gpu.id),
      );
      const freedFromMandatory = overlapping
        .filter((a) => mustEvict.has(a))
        .reduce((sum, a) => sum + (a.slots.find((s) => s.gpu_id === gpu.id)?.reserved_mb ?? 0), 0);
      let freeMb = this.#effectiveFreeMb(gpu) + freedFromMandatory;
      if (freeMb >= request.spec.vram_mb) continue;

      const sortedCandidates = [...remainingIdleOnGpu].sort((a, b) => {
        const aElig = this.scheduling.isBatchEligible(a.engine, now, eligibleQueue) ? 0 : 1;
        const bElig = this.scheduling.isBatchEligible(b.engine, now, eligibleQueue) ? 0 : 1;
        if (aElig !== bElig) return aElig - bElig;
        const aW = COLD_WEIGHT_SCORE[a.cold_start_weight];
        const bW = COLD_WEIGHT_SCORE[b.cold_start_weight];
        if (aW !== bW) return aW - bW;
        return a.last_active_at - b.last_active_at;
      });

      for (const candidate of sortedCandidates) {
        if (freeMb >= request.spec.vram_mb) break;
        mustEvict.add(candidate);
        freeMb += candidate.slots.find((s) => s.gpu_id === gpu.id)?.reserved_mb ?? 0;
      }

      if (freeMb < request.spec.vram_mb) {
        for (const alloc of overlapping) {
          if (!idleIds.has(alloc.allocation_id) && alloc.slots.some((s) => s.gpu_id === gpu.id)) {
            busyShortfall.add(alloc);
          }
        }
        return { victims: null, busy: [...busyShortfall] };
      }
    }

    return mustEvict.size > 0 ? { victims: [...mustEvict], busy: [] } : { victims: null, busy: [] };
  }

  async selectEvictionCandidates(
    gpuSet: GpuDevice[],
    eligibleQueue: ReadonlyArray<QueuedRequest>,
  ): Promise<EvictionCandidate[]> {
    const now = this.clock();
    const gpuIds = new Set(gpuSet.map((g) => g.id));
    const overlapping = this.allocations.filter(
      (a) => !a.evicting && (!gpuIds.size || a.slots.some((s) => gpuIds.has(s.gpu_id))),
    );
    const out: EvictionCandidate[] = [];
    for (const alloc of overlapping) {
      const idle =
        alloc.tokens.size === 0 && !alloc.switching && (await this.#isBackendIdle(alloc.engine));
      const batchEligible = this.scheduling.isBatchEligible(alloc.engine, now, eligibleQueue);
      out.push({
        allocation_id: alloc.allocation_id,
        runtime_id: alloc.runtime_id,
        gpu_ids: alloc.slots.map((s) => s.gpu_id),
        freed_vram_mb: alloc.slots.reduce((s, slot) => s + slot.reserved_mb, 0),
        cold_start_weight: alloc.cold_start_weight,
        idle,
        batch_eligible: batchEligible,
      });
    }
    return out.sort((a, b) => {
      if (a.idle !== b.idle) return a.idle ? -1 : 1;
      if (a.batch_eligible !== b.batch_eligible) return a.batch_eligible ? -1 : 1;
      return COLD_WEIGHT_SCORE[a.cold_start_weight] - COLD_WEIGHT_SCORE[b.cold_start_weight];
    });
  }

  async #tryGracefulEviction(
    request: QueuedRequest,
    eligibleQueue: ReadonlyArray<QueuedRequest>,
    drainingGpus: Set<string>,
    drainingAllocations: Set<string>,
  ): Promise<'loaded' | 'busy' | 'none'> {
    const now = this.clock();
    const candidateSets = this.#candidateGpuSets(
      request.spec,
      false,
      drainingGpus,
      request.exclusive,
      request.engine,
    );
    if (!candidateSets.length) return 'none';

    const candidateGpuIds = new Set(candidateSets.flat().map((g) => g.id));
    const relevantAllocations = this.allocations.filter(
      (a) =>
        !a.evicting &&
        (!candidateGpuIds.size || a.slots.some((s) => candidateGpuIds.has(s.gpu_id))),
    );
    const idleIds = new Set<string>();
    for (const alloc of relevantAllocations) {
      if (
        alloc.switching ||
        alloc.evicting ||
        alloc.tokens.size > 0 ||
        drainingAllocations.has(alloc.allocation_id)
      ) {
        continue;
      }
      if ((await this.#isBackendIdle(alloc.engine)) && alloc.tokens.size === 0 && !alloc.evicting) {
        idleIds.add(alloc.allocation_id);
      }
    }

    const plans: EvictionPlan[] = [];
    const busyAllocations: InternalAllocation[] = [];

    for (const gpuSet of candidateSets) {
      const { victims, busy } = this.#victimsForGpuSet(
        gpuSet,
        request,
        eligibleQueue,
        now,
        idleIds,
      );
      if (busy.length > 0) {
        busyAllocations.push(...busy);
      }
      if (!victims || !victims.length) continue;

      const allBatchEligible = victims.every((v) =>
        this.scheduling.isBatchEligible(v.engine, now, eligibleQueue),
      );
      const coldWeightSum = victims.reduce(
        (sum, v) => sum + COLD_WEIGHT_SCORE[v.cold_start_weight],
        0,
      );
      const freedTotal = victims.reduce(
        (sum, v) => sum + v.slots.reduce((s, slot) => s + slot.reserved_mb, 0),
        0,
      );
      const excessVramMb = Math.max(
        0,
        freedTotal - request.spec.vram_mb * Math.max(1, gpuSet.length),
      );
      const oldestLastActiveAt = Math.min(...victims.map((v) => v.last_active_at));

      plans.push({
        gpuSet,
        victims,
        allBatchEligible,
        coldWeightSum,
        excessVramMb,
        oldestLastActiveAt,
      });
    }

    if (!plans.length) {
      if (busyAllocations.length > 0) {
        for (const busy of busyAllocations) {
          drainingAllocations.add(busy.allocation_id);
          for (const slot of busy.slots) {
            drainingGpus.add(slot.gpu_id);
          }
        }
        return 'busy';
      }
      return 'none';
    }

    plans.sort((a, b) => {
      if (a.allBatchEligible !== b.allBatchEligible) return a.allBatchEligible ? -1 : 1;
      if (a.coldWeightSum !== b.coldWeightSum) return a.coldWeightSum - b.coldWeightSum;
      if (a.victims.length !== b.victims.length) return a.victims.length - b.victims.length;
      if (a.excessVramMb !== b.excessVramMb) return a.excessVramMb - b.excessVramMb;
      return a.oldestLastActiveAt - b.oldestLastActiveAt;
    });

    const winner = plans[0];
    for (const v of winner.victims) v.evicting = true;
    this.switchingTargets.add(request.engine);
    this.switching = true;

    try {
      if (this.#idleSettleMs > 0) {
        await pause(this.#idleSettleMs);
      }
      for (const v of winner.victims) {
        if (v.tokens.size > 0 || !(await this.#isBackendIdle(v.engine)) || v.tokens.size > 0) {
          for (const rollback of winner.victims) rollback.evicting = false;
          this.switchingTargets.delete(request.engine);
          this.switching = this.switchingTargets.size > 0;
          drainingAllocations.add(v.allocation_id);
          for (const slot of v.slots) {
            drainingGpus.add(slot.gpu_id);
          }
          return 'busy';
        }
      }

      for (const v of winner.victims) {
        const victimGpuIds = v.slots.map((s) => s.gpu_id);
        await this.#stopBackend(v.engine, victimGpuIds);
        this.allocations = this.allocations.filter((a) => a !== v);
        this.scheduling.resetRuntime(v.engine);
        if (this.current === v.engine) this.current = null;
      }
    } catch (error) {
      for (const rollback of winner.victims) {
        if (this.allocations.includes(rollback)) rollback.evicting = false;
      }
      this.switchingTargets.delete(request.engine);
      this.switching = this.switchingTargets.size > 0;
      throw error;
    }

    await this.#placeAndLoad(request, winner.gpuSet);
    return 'loaded';
  }

  async evictEngine(engine: string): Promise<boolean> {
    const targets = this.allocations.filter((a) => a.engine === engine && !a.evicting);
    if (!targets.length) return false;
    for (const alloc of targets) {
      if (alloc.tokens.size > 0 || alloc.switching) return false;
    }
    for (const alloc of targets) {
      alloc.evicting = true;
      await this.#stopBackend(
        alloc.engine,
        alloc.slots.map((s) => s.gpu_id),
      );
      this.allocations = this.allocations.filter((a) => a !== alloc);
      this.scheduling.resetRuntime(alloc.engine);
      if (this.current === alloc.engine) this.current = null;
    }
    this.notify();
    this.pump();
    return true;
  }

  async dispatch(): Promise<void> {
    await this.recover();
    const blockedEngines = new Set<string>();
    const drainingGpus = new Set<string>();
    const drainingAllocations = new Set<string>();

    while (true) {
      const epoch = this.#mutationEpoch;
      const virtualSingleGpu = !this.#hasDeviceTopology && (this.snapshot?.gpus?.length ?? 0) === 0;
      const eligible = this.queue.filter((r) => this.eligible(r) && !blockedEngines.has(r.engine));
      const chosen = this.selectWaitingRequest(eligible);
      if (!chosen) return;

      const request = this.fairest(eligible.filter((r) => r.engine === chosen.engine));

      // Step 1: Warm Hit (exact engine or sibling runtime)
      const warmAlloc = this.#findWarmHit(request, drainingAllocations);
      if (warmAlloc) {
        this.settle(request, null, this.#issueTicket(warmAlloc, request));
        continue;
      }

      const runtimeId = this.#groupOfFn(request.engine) ?? request.engine;
      const hasSiblingCandidate = this.allocations.some(
        (a) =>
          !a.evicting &&
          !a.switching &&
          !drainingAllocations.has(a.allocation_id) &&
          a.runtime_id === runtimeId &&
          a.engine !== request.engine &&
          a.tokens.size === 0 &&
          !a.slots.some((s) => drainingGpus.has(s.gpu_id)),
      );
      if (
        hasSiblingCandidate &&
        (await this.#trySiblingWarmHit(request, drainingAllocations, drainingGpus))
      ) {
        continue;
      }
      if (epoch !== this.#mutationEpoch) {
        blockedEngines.clear();
        drainingGpus.clear();
        drainingAllocations.clear();
        continue;
      }

      const runtimeBusy = this.allocations.some(
        (a) => !a.evicting && a.runtime_id === runtimeId && (a.tokens.size > 0 || a.switching),
      );
      if (runtimeBusy) {
        if (virtualSingleGpu) return;
        blockedEngines.add(request.engine);
        continue;
      }

      // Step 2: Best-Fit / Shared Coexistence / Atomic Multi-GPU TP Placement without Eviction
      const freeGpuSets = this.#candidateGpuSets(
        request.spec,
        true,
        drainingGpus,
        request.exclusive,
        request.engine,
      );
      if (freeGpuSets.length > 0) {
        await this.#placeAndLoad(request, freeGpuSets[0]);
        continue;
      }

      // Step 3: Graceful Eviction
      const evictionResult = await this.#tryGracefulEviction(
        request,
        eligible,
        drainingGpus,
        drainingAllocations,
      );
      if (evictionResult === 'loaded') {
        continue;
      }
      if (epoch !== this.#mutationEpoch) {
        blockedEngines.clear();
        drainingGpus.clear();
        drainingAllocations.clear();
        continue;
      }
      if (virtualSingleGpu) return;

      // Cannot place or evict for this engine right now; mark blocked and check remaining engines
      // on non-draining GPUs.
      blockedEngines.add(request.engine);
    }
  }

  startTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => {
      if (!this.queue.length && !this.allocations.some((a) => a.tokens.size > 0)) {
        clearInterval(this.tick!);
        this.tick = null;
        return;
      }
      this.pump();
    }, 1000);
    this.tick.unref?.();
  }

  renew(token: string): void {
    const alloc = this.allocations.find((a) => a.tokens.has(token));
    if (!alloc) throw new Error('Invalid lease token');
    alloc.tokens.set(token, this.clock() + this.leaseSeconds);
  }

  async release(token: string): Promise<void> {
    const alloc = this.allocations.find((a) => a.tokens.has(token));
    if (!alloc) throw new Error('Invalid lease token');
    if (alloc.tokens.size > 1) {
      this.#dropToken(alloc, token);
      this.notify();
      this.pump();
      return;
    }
    if (!(await this.#isBackendIdle(alloc.engine))) {
      throw new Error('Backend still busy or status unavailable; lease retained');
    }
    if (this.allocations.includes(alloc) && alloc.tokens.has(token)) {
      this.#dropToken(alloc, token);
      alloc.last_active_at = this.clock();
      if (!alloc.tokens.size) alloc.exclusive = false;
    }
    this.notify();
    this.pump();
  }
}

export const PoolCoordinator = GpuPoolCoordinator;

export function createPoolCoordinator(
  configOrBackend: PoolCoordinatorOptions | BackendLike = {},
  backendOrOptions: BackendLike | PoolCoordinatorOptions = {},
): GpuPoolCoordinator {
  return new GpuPoolCoordinator(configOrBackend, backendOrOptions);
}

export default GpuPoolCoordinator;
