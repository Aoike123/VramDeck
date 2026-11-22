import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type {
  DeviceProvider,
  HardwareSnapshot,
  PoolAllocation,
  PoolStatus,
  ResourceSpec,
} from '../../../platforms/workbench/lib/types.ts';
import { assertNoImportCycles, assertPoolAllocation, assertPoolStatus } from '../lib/assertions.ts';
import { findFirstExisting, REPO_ROOT, requireDeliverable } from '../lib/env.ts';
import {
  createMockGpuDevice,
  createMockHardwareSnapshot,
  createResourceSpec,
} from '../lib/fixtures.ts';

interface PoolAcquireResult {
  allocation: PoolAllocation;
  token: string;
  gpu_ids: string[];
  release: () => Promise<void>;
}

interface PoolCoordinatorHandle {
  acquire: (
    engine: string,
    opts?: {
      timeout?: number;
      signal?: AbortSignal;
      enqueuedAt?: number;
      exclusive?: boolean;
      key?: string;
    },
  ) => Promise<PoolAcquireResult>;
  release: (tokenOrId: string) => Promise<void>;
  status: () => PoolStatus;
}

async function getPoolCoordinatorEntry(): Promise<string | null> {
  return findFirstExisting([
    'platforms/workbench/lib/scheduler/pool-coordinator.ts',
    'platforms/workbench/lib/scheduler/pool-coordinator.mjs',
    'platforms/workbench/lib/scheduler/index.ts',
    'platforms/workbench/lib/scheduler/index.mjs',
  ]);
}

async function createPoolInstance(
  entryRel: string,
  snapshot: HardwareSnapshot,
  resources: Record<string, ResourceSpec>,
  opts: {
    clock?: () => number;
    engineScheduling?: Record<string, unknown>;
    groupOf?: (engine: string) => string;
    idleMap?: Record<string, boolean>;
    onEnsure?: (engine: string, gpuIds: string[]) => Promise<void> | void;
    onStop?: (engine: string, gpuIds: string[]) => Promise<void> | void;
  } = {},
): Promise<PoolCoordinatorHandle> {
  const mod = (await import(pathToFileURL(path.join(REPO_ROOT, entryRel)).href)) as Record<
    string,
    unknown
  >;

  const deviceProvider: DeviceProvider = {
    id: 'mock',
    detect: async () => snapshot,
  };

  const backend = {
    models: Object.fromEntries(Object.keys(resources).map((k) => [k, []])),
    resources,
    async ensure(
      engine: string,
      _deadline?: number,
      _clock?: () => number,
      _p?: unknown,
      _cb?: unknown,
      gpuIds: string[] = [],
    ) {
      await opts.onEnsure?.(engine, gpuIds);
    },
    async start(engine: string, gpuIds: string[] = []) {
      await opts.onEnsure?.(engine, gpuIds);
    },
    async stop(engine: string, gpuIds: string[] = []) {
      await opts.onStop?.(engine, gpuIds);
    },
    async unload(engine: string, gpuIds: string[] = []) {
      await opts.onStop?.(engine, gpuIds);
    },
    async idle(engine: string) {
      return opts.idleMap?.[engine] ?? true;
    },
    async ready() {
      return true;
    },
  };

  const backendArg = {
    ...backend,
    deviceProvider,
    provider: deviceProvider,
    snapshot,
    engines: resources,
    clock: opts.clock ?? (() => performance.now() / 1000),
    engineScheduling: opts.engineScheduling ?? {},
    groupOf: opts.groupOf,
    runtimeFor: opts.groupOf,
    onEnsure: opts.onEnsure,
    onStop: opts.onStop,
  };

  const config = {
    deviceProvider,
    provider: deviceProvider,
    snapshot,
    resources,
    engines: resources,
    backend,
    clock: opts.clock ?? (() => performance.now() / 1000),
    engineScheduling: opts.engineScheduling ?? {},
    groupOf: opts.groupOf,
    runtimeFor: opts.groupOf,
    onEnsure: opts.onEnsure,
    onStop: opts.onStop,
  };

  let instance: Record<string, unknown>;
  if (typeof mod.createPoolCoordinator === 'function') {
    instance = (await (
      mod.createPoolCoordinator as (a: unknown, b?: unknown) => Promise<Record<string, unknown>>
    )(config, backend)) as Record<string, unknown>;
  } else if (typeof mod.GpuPoolCoordinator === 'function') {
    const Ctor = mod.GpuPoolCoordinator as new (a: unknown, b?: unknown) => Record<string, unknown>;
    instance = new Ctor(backendArg, config);
  } else if (typeof mod.PoolCoordinator === 'function') {
    const Ctor = mod.PoolCoordinator as new (a: unknown, b?: unknown) => Record<string, unknown>;
    instance = new Ctor(backendArg, config);
  } else if (typeof mod.default === 'function') {
    const Ctor = mod.default as new (a: unknown, b?: unknown) => Record<string, unknown>;
    instance = new Ctor(backendArg, config);
  } else {
    throw new Error(`No GpuPoolCoordinator factory/class export found in ${entryRel}`);
  }

  if (typeof instance.init === 'function') {
    await (instance.init as () => Promise<void>)();
  } else if (typeof instance.refreshDevices === 'function') {
    await (instance.refreshDevices as () => Promise<void>)();
  }

  const releaseFn = instance.release as (token: string) => Promise<void>;
  const acquireFn = instance.acquire as (
    engine: string,
    o?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  const statusFn = instance.status as () => PoolStatus;

  return {
    async acquire(engine, acquireOpts = {}) {
      const raw = await acquireFn.call(instance, engine, acquireOpts);
      let allocation: PoolAllocation | undefined;
      if (raw.allocation && typeof raw.allocation === 'object') {
        allocation = raw.allocation as PoolAllocation;
      } else if (Array.isArray(raw.slots)) {
        allocation = raw as unknown as PoolAllocation;
      } else {
        const st = statusFn.call(instance);
        assertPoolStatus(st);
        const rawAllocId = typeof raw.allocation_id === 'string' ? raw.allocation_id : null;
        allocation =
          st.allocations.find((a) =>
            rawAllocId ? a.allocation_id === rawAllocId : a.engine === engine,
          ) ?? st.allocations.find((a) => a.engine === engine);
      }
      if (!allocation) {
        allocation = raw as unknown as PoolAllocation;
      }
      assertPoolAllocation(allocation);
      const token =
        typeof raw.token === 'string'
          ? raw.token
          : typeof raw.lease_id === 'string'
            ? raw.lease_id
            : allocation.allocation_id;
      const gpuIds = Array.isArray(raw.gpu_ids)
        ? (raw.gpu_ids as string[])
        : allocation.slots.map((s) => s.gpu_id);
      return {
        allocation,
        token,
        gpu_ids: gpuIds,
        release: async () => {
          if (typeof raw.release === 'function') {
            await (raw.release as () => Promise<void>)();
          } else {
            await releaseFn.call(instance, token);
          }
        },
      };
    },
    async release(tokenOrId) {
      await releaseFn.call(instance, tokenOrId);
    },
    status() {
      const st = statusFn.call(instance);
      assertPoolStatus(st);
      return st;
    },
  };
}

describe('FA4 Tier 1: GpuPoolCoordinator 1-4 GPU placement & single-GPU equivalence', () => {
  it('fa04.t1.1 places heterogeneous 1-4 GPU workloads via Best-Fit while preserving larger GPUs', async (t) => {
    const entry = await getPoolCoordinatorEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #14): platforms/workbench/lib/scheduler/pool-coordinator.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const snapshot: HardwareSnapshot = {
      collected_at: Date.now(),
      host: { os: process.platform, arch: process.arch, ram_total_mb: 65536, ram_free_mb: 49152 },
      gpus: [
        createMockGpuDevice({
          id: 'gpu-0',
          index: 0,
          vendor: 'nvidia',
          backend: 'cuda',
          vram_total_mb: 24576,
          vram_used_mb: 0,
          vram_free_mb: 24576,
        }),
        createMockGpuDevice({
          id: 'gpu-1',
          index: 1,
          vendor: 'nvidia',
          backend: 'cuda',
          vram_total_mb: 12288,
          vram_used_mb: 0,
          vram_free_mb: 12288,
        }),
        createMockGpuDevice({
          id: 'gpu-2',
          index: 2,
          vendor: 'amd',
          backend: 'rocm',
          vram_total_mb: 32768,
          vram_used_mb: 0,
          vram_free_mb: 32768,
        }),
      ],
    };

    const resources: Record<string, ResourceSpec> = {
      'small-cuda': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 1,
        vram_mb: 8192,
        vram_mode: 'shared',
        concurrency: 2,
        affinity: 'any',
      }),
      'large-cuda': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 1,
        vram_mb: 20480,
        vram_mode: 'exclusive',
        concurrency: 1,
        affinity: 'any',
      }),
      'rocm-llm': createResourceSpec({
        backends: ['rocm'],
        gpu_count: 1,
        vram_mb: 16384,
        vram_mode: 'shared',
        concurrency: 2,
        affinity: 'prefer:gpu-2',
      }),
    };

    const pool = await createPoolInstance(entry!, snapshot, resources);
    const smallLease = await pool.acquire('small-cuda', { timeout: 2 });
    assert.deepEqual(
      smallLease.gpu_ids,
      ['gpu-1'],
      'Best-Fit must place 8192MB CUDA workload onto 12288MB gpu-1 instead of fragmenting 24576MB gpu-0',
    );

    const largeLease = await pool.acquire('large-cuda', { timeout: 2 });
    assert.deepEqual(largeLease.gpu_ids, ['gpu-0']);

    const rocmLease = await pool.acquire('rocm-llm', { timeout: 2 });
    assert.deepEqual(rocmLease.gpu_ids, ['gpu-2']);

    const st = pool.status();
    assert.equal(st.allocations.length, 3);

    await smallLease.release();
    await largeLease.release();
    await rocmLease.release();
  });

  it('fa04.t1.2 allows multiple shared models to coexist on one GPU without mutual eviction', async (t) => {
    const entry = await getPoolCoordinatorEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #14): platforms/workbench/lib/scheduler/pool-coordinator.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const snapshot = createMockHardwareSnapshot('single-gpu-24g', {
      gpus: [
        createMockGpuDevice({
          id: 'gpu-0',
          index: 0,
          vendor: 'nvidia',
          backend: 'cuda',
          vram_total_mb: 24576,
          vram_used_mb: 0,
          vram_free_mb: 24576,
        }),
      ],
    });
    const evictions: string[] = [];
    const pool = await createPoolInstance(
      entry!,
      snapshot,
      {
        embed: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 4096,
          vram_mode: 'shared',
          concurrency: 2,
        }),
        tts: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 6144,
          vram_mode: 'shared',
          concurrency: 2,
        }),
      },
      {
        onStop(engine) {
          evictions.push(engine);
        },
      },
    );

    const e1 = await pool.acquire('embed', { timeout: 2 });
    const e2 = await pool.acquire('embed', { timeout: 2 });
    const t1 = await pool.acquire('tts', { timeout: 2 });

    assert.deepEqual(e1.gpu_ids, ['gpu-0']);
    assert.deepEqual(e2.gpu_ids, ['gpu-0']);
    assert.deepEqual(t1.gpu_ids, ['gpu-0']);
    assert.equal(evictions.length, 0, 'Coexisting shared models must not evict each other');

    const st = pool.status();
    assert.equal(st.allocations.length, 2);
    const totalReserved = st.allocations.reduce(
      (sum, a) => sum + a.slots.reduce((s, slot) => s + slot.reserved_mb, 0),
      0,
    );
    assert.equal(totalReserved, 10240);

    await e1.release();
    await e2.release();
    await t1.release();
  });

  it('fa04.t1.3 reserves multi-GPU TP atomically across distinct GPUs alongside 1-GPU workload', async (t) => {
    const entry = await getPoolCoordinatorEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #14): platforms/workbench/lib/scheduler/pool-coordinator.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const snapshot = createMockHardwareSnapshot('quad-24g');
    const pool = await createPoolInstance(entry!, snapshot, {
      'tp-llm': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 2,
        vram_mb: 16384,
        vram_mode: 'exclusive',
        concurrency: 2,
        affinity: 'any',
      }),
      'audio-1gpu': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 1,
        vram_mb: 4096,
        vram_mode: 'shared',
        concurrency: 2,
        affinity: 'any',
      }),
    });

    const tpLease = await pool.acquire('tp-llm', { timeout: 2 });
    assert.equal(tpLease.gpu_ids.length, 2);
    assert.equal(new Set(tpLease.gpu_ids).size, 2, 'TP slots must span 2 distinct GPUs');

    const audioLease = await pool.acquire('audio-1gpu', { timeout: 2 });
    assert.equal(audioLease.gpu_ids.length, 1);
    assert.ok(
      !tpLease.gpu_ids.includes(audioLease.gpu_ids[0]),
      '1-GPU workload must run on a remaining non-TP GPU',
    );

    const st = pool.status();
    assert.equal(st.allocations.length, 2);

    await tpLease.release();
    await audioLease.release();
  });

  it('fa04.t1.4 evicts gracefully by idle -> batch_eligible -> lowest cold_start_weight', async (t) => {
    const entry = await getPoolCoordinatorEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #14): platforms/workbench/lib/scheduler/pool-coordinator.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const snapshot = createMockHardwareSnapshot('single-gpu-24g', {
      gpus: [
        createMockGpuDevice({
          id: 'gpu-0',
          index: 0,
          vendor: 'nvidia',
          backend: 'cuda',
          vram_total_mb: 24576,
          vram_used_mb: 0,
          vram_free_mb: 24576,
        }),
      ],
    });

    // Phase A: idle -> batch_eligible (batch_eligible=true evicted before batch_eligible=false at equal cold_start_weight)
    let fakeNow = 0;
    const idleMap: Record<string, boolean> = {
      'busy-low': true,
      'idle-aged': true,
      'idle-fresh': true,
      challenger: true,
    };
    const stoppedA: string[] = [];
    const poolA = await createPoolInstance(
      entry!,
      snapshot,
      {
        'busy-low': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 6144,
          vram_mode: 'shared',
          concurrency: 1,
          cold_start_weight: 'low',
        }),
        'idle-aged': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 8192,
          vram_mode: 'shared',
          concurrency: 1,
          cold_start_weight: 'medium',
        }),
        'idle-fresh': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 8192,
          vram_mode: 'shared',
          concurrency: 1,
          cold_start_weight: 'medium',
        }),
        challenger: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 8192,
          vram_mode: 'shared',
          concurrency: 1,
          affinity: 'pin:gpu-0',
          cold_start_weight: 'high',
        }),
      },
      {
        clock: () => fakeNow,
        engineScheduling: {
          minBatchRequests: 2,
          maxBatchRequests: 4,
          maxBatchSeconds: 120,
          maxWaitSeconds: 300,
        },
        idleMap,
        onStop(engine) {
          stoppedA.push(engine);
        },
      },
    );

    const busyLease = await poolA.acquire('busy-low', { timeout: 2, enqueuedAt: 0 });
    await busyLease.release();
    idleMap['busy-low'] = false;

    // idle-aged completes minBatchRequests=2 and ages >= maxBatchSeconds (120s) -> batch_eligible: true
    for (let i = 0; i < 2; i += 1) {
      fakeNow = i;
      const l = await poolA.acquire('idle-aged', { timeout: 2, enqueuedAt: fakeNow });
      await l.release();
    }

    // idle-fresh has only 1 request (< minBatchRequests=2) and 0s elapsed -> batch_eligible: false
    fakeNow = 200;
    const freshLease = await poolA.acquire('idle-fresh', { timeout: 2, enqueuedAt: fakeNow });
    await freshLease.release();

    const challengerLease = await poolA.acquire('challenger', { timeout: 2, enqueuedAt: fakeNow });
    assert.deepEqual(challengerLease.gpu_ids, ['gpu-0']);
    assert.ok(
      !stoppedA.includes('busy-low'),
      'Non-idle allocation (idle() === false) must never be evicted before idle allocations',
    );
    assert.ok(
      stoppedA.includes('idle-aged'),
      'batch_eligible=true idle allocation must be evicted before batch_eligible=false at equal cold_start_weight',
    );
    assert.ok(
      !stoppedA.includes('idle-fresh'),
      'batch_eligible=false idle allocation must remain resident when batch_eligible=true satisfies VRAM need',
    );
    idleMap['busy-low'] = true;
    await challengerLease.release();

    // Phase B: lowest cold_start_weight (low evicted before high when both are idle & batch_eligible)
    let fakeNowB = 0;
    const stoppedB: string[] = [];
    const poolB = await createPoolInstance(
      entry!,
      snapshot,
      {
        light: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 10240,
          vram_mode: 'shared',
          concurrency: 1,
          cold_start_weight: 'low',
        }),
        heavy: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 10240,
          vram_mode: 'shared',
          concurrency: 1,
          cold_start_weight: 'high',
        }),
        big: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 14336,
          vram_mode: 'shared',
          concurrency: 1,
          affinity: 'pin:gpu-0',
          cold_start_weight: 'medium',
        }),
      },
      {
        clock: () => fakeNowB,
        engineScheduling: {
          minBatchRequests: 2,
          maxBatchRequests: 4,
          maxBatchSeconds: 120,
          maxWaitSeconds: 300,
        },
        onStop(engine) {
          stoppedB.push(engine);
        },
      },
    );

    for (let i = 0; i < 2; i += 1) {
      fakeNowB = i;
      const l = await poolB.acquire('light', { timeout: 2, enqueuedAt: fakeNowB });
      await l.release();
    }
    for (let i = 2; i < 4; i += 1) {
      fakeNowB = i;
      const h = await poolB.acquire('heavy', { timeout: 2, enqueuedAt: fakeNowB });
      await h.release();
    }
    fakeNowB = 200;

    const bigLease = await poolB.acquire('big', { timeout: 2, enqueuedAt: fakeNowB });
    assert.deepEqual(bigLease.gpu_ids, ['gpu-0']);
    assert.ok(
      stoppedB.includes('light'),
      'Lowest cold_start_weight idle allocation must evict first',
    );
    assert.ok(
      !stoppedB.includes('heavy'),
      'Higher cold_start_weight allocation must remain resident',
    );

    const activeEngines = poolB.status().allocations.map((a) => a.engine);
    assert.ok(activeEngines.includes('big'));
    assert.ok(activeEngines.includes('heavy'));
    await bigLease.release();
  });

  it('fa04.t1.5 preserves 100% single-GPU exclusive batching, runtime grouping, and anti-starvation equivalence', async (t) => {
    const poolEntry = await getPoolCoordinatorEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(poolEntry),
        'Pending M3 (Feature #14): GpuPoolCoordinator 1-GPU exclusive equivalence requires pool-coordinator',
      )
    ) {
      return;
    }

    const schedRel = await findFirstExisting([
      'platforms/workbench/lib/scheduler/engine-scheduling.ts',
      'platforms/workbench/lib/scheduler/engine-scheduling.mjs',
      'platforms/workbench/lib/engine-scheduling.ts',
      'platforms/workbench/lib/engine-scheduling.mjs',
    ]);
    assert.ok(schedRel, 'Expected engine-scheduling module');
    const schedMod = (await import(pathToFileURL(path.join(REPO_ROOT, schedRel)).href)) as {
      EngineScheduling: new (
        policy?: Record<string, number>,
        opts?: { groupOf?: (engine: string) => string },
      ) => {
        choose: (
          requests: Array<{ engine: string; enqueuedAt: number }>,
          current: string | null,
          now: number,
        ) => { request: { engine: string; enqueuedAt: number } | null; reason: string };
        granted: (engine: string, now: number) => void;
      };
    };

    // Verify authoritative single-GPU baseline (anti-starvation + runtime grouping + thresholds)
    const runtimeMap: Record<string, string> = {
      llm: 'llm',
      anima: 'comfy',
      h3: 'comfy',
      tts: 'tts',
    };
    const policy = {
      minBatchRequests: 2,
      maxBatchRequests: 4,
      maxBatchSeconds: 120,
      maxWaitSeconds: 300,
    };
    const sched = new schedMod.EngineScheduling(policy, {
      groupOf: (e) => runtimeMap[e] ?? e,
    });
    const oldReq = { engine: 'llm', enqueuedAt: 0 };
    const siblingReq = { engine: 'anima', enqueuedAt: 5 };
    sched.granted('h3', 400);
    // Must finish minBatchRequests=2 via sibling anima on same comfy runtime even though llm is >300s aged
    assert.equal(sched.choose([oldReq, siblingReq], 'h3', 401).reason, 'minimum_engine_batch');
    sched.granted('anima', 401);
    // Now minBatchRequests=2 is satisfied and llm is aged >= 300s -> waiting_engine_aged
    assert.equal(sched.choose([oldReq, siblingReq], 'anima', 402).reason, 'waiting_engine_aged');

    // Verify batch_request_limit=4 and batch_time_limit=120
    const schedLimits = new schedMod.EngineScheduling(policy);
    for (let i = 0; i < 4; i += 1) schedLimits.granted('llm', 10);
    assert.equal(
      schedLimits.choose(
        [
          { engine: 'tts', enqueuedAt: 10 },
          { engine: 'llm', enqueuedAt: 11 },
        ],
        'llm',
        15,
      ).reason,
      'batch_request_limit',
    );
    assert.equal(
      schedLimits.choose(
        [
          { engine: 'tts', enqueuedAt: 10 },
          { engine: 'llm', enqueuedAt: 11 },
        ],
        'llm',
        130,
      ).reason,
      'batch_time_limit',
    );

    // Derive deterministic expected order from EngineScheduling with 'tts' between 'anima' and 'h3'
    const seq = ['anima', 'tts', 'h3', 'llm'];
    const refSched = new schedMod.EngineScheduling(policy, {
      groupOf: (e) => runtimeMap[e] ?? e,
    });
    refSched.granted('llm', 0);
    let refCurrent: string | null = 'llm';
    const waiting = seq.map((engine, idx) => ({ engine, enqueuedAt: 1 + idx }));
    const expectedOrder: string[] = [];
    while (waiting.length > 0) {
      const decision = refSched.choose(waiting, refCurrent, 1);
      assert.ok(decision.request, 'Expected EngineScheduling to select a waiting request');
      expectedOrder.push(decision.request.engine);
      refSched.granted(decision.request.engine, 1);
      refCurrent = decision.request.engine;
      const removeIdx = waiting.indexOf(decision.request);
      waiting.splice(removeIdx, 1);
    }
    // Comfy runtime grouping must jump 'h3' ahead of 'tts' after 'anima'
    assert.deepEqual(expectedOrder, ['llm', 'anima', 'h3', 'tts']);

    const singleGpuSnapshot = createMockHardwareSnapshot('single-gpu-24g');
    const poolOrder: string[] = [];
    let fakeNow = 0;
    const pool = await createPoolInstance(
      poolEntry!,
      singleGpuSnapshot,
      {
        llm: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 16384,
          vram_mode: 'exclusive',
          concurrency: 1,
        }),
        anima: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 16384,
          vram_mode: 'exclusive',
          concurrency: 1,
        }),
        h3: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 16384,
          vram_mode: 'exclusive',
          concurrency: 1,
        }),
        tts: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 16384,
          vram_mode: 'exclusive',
          concurrency: 1,
        }),
      },
      {
        clock: () => fakeNow,
        engineScheduling: policy,
        groupOf: (e) => runtimeMap[e] ?? e,
      },
    );

    const poolHold = await pool.acquire('llm', { timeout: 3, enqueuedAt: 0 });
    fakeNow = 1;
    const poolPending = seq.map((m, idx) =>
      pool.acquire(m, { timeout: 4, enqueuedAt: 1 + idx }).then(async (lease) => {
        poolOrder.push(m);
        await lease.release();
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    await poolHold.release();
    await Promise.all(poolPending);
    assert.deepEqual(poolOrder, expectedOrder);
  });

  it('fa04.t1.6 verifies LLM policy slots and paiton-qwen38 container leaks decoupled from generic core/backend/http/server with zero cycles', async (t) => {
    const poolEntry = await getPoolCoordinatorEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(poolEntry),
        'Pending M3 (Feature #15): LLM policy slots & paiton-qwen38 decoupling lands with pool-coordinator',
      )
    ) {
      return;
    }

    const libDir = path.join(REPO_ROOT, 'platforms', 'workbench', 'lib');
    await assertNoImportCycles(libDir);

    const genericFiles = [
      'core.ts',
      'core.mjs',
      'backend.ts',
      'backend.mjs',
      'http.ts',
      'http.mjs',
      'server.ts',
      'server.mjs',
      'scheduler/pool-coordinator.ts',
      'scheduler/pool-coordinator.mjs',
    ];

    for (const rel of genericFiles) {
      const baseDir = rel.startsWith('server.')
        ? path.join(REPO_ROOT, 'platforms', 'workbench')
        : libDir;
      const abs = path.join(baseDir, rel);
      if (!existsSync(abs)) continue;
      const src = await readFile(abs, 'utf8');
      assert.doesNotMatch(
        src,
        /['"](?:192k|256k|64k)['"]/,
        `${rel} must not hardcode LLM policy slots 192k/256k/64k`,
      );
      assert.doesNotMatch(src, /selectedLlmMode/, `${rel} must not hardcode selectedLlmMode`);
      assert.doesNotMatch(
        src,
        /paiton-qwen38/,
        `${rel} must not hardcode paiton-qwen38 container name`,
      );
    }

    const enginesDir = path.join(REPO_ROOT, 'engines');
    const categories = await readdir(enginesDir, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory() || cat.name === 'shared') continue;
      const pkgs = await readdir(path.join(enginesDir, cat.name), { withFileTypes: true });
      for (const pkg of pkgs) {
        if (!pkg.isDirectory()) continue;
        for (const adapterFile of ['adapter.ts', 'adapter.mjs']) {
          const adapterPath = path.join(enginesDir, cat.name, pkg.name, adapterFile);
          if (!existsSync(adapterPath)) continue;
          const src = await readFile(adapterPath, 'utf8');
          assert.doesNotMatch(
            src,
            /platforms\/workbench\/lib\/(?!engine-sdk\.(?:mjs|ts))/,
            `${adapterPath} must import only engine-sdk`,
          );
        }
      }
    }
  });
});
