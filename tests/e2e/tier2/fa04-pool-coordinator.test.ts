import assert from 'node:assert/strict';
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
import { assertPoolAllocation, assertPoolStatus } from '../lib/assertions.ts';
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

describe('FA4 Tier 2: GpuPoolCoordinator boundary, rollback & negative error paths', () => {
  it('fa04.t2.1 fast-fails unsatisfiable pin:<missing> and backend mismatch without disturbing active leases', async (t) => {
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

    const snapshot = createMockHardwareSnapshot('dual-heterogeneous-24g-12g');
    const pool = await createPoolInstance(entry!, snapshot, {
      'cuda-ok': createResourceSpec({ backends: ['cuda'], gpu_count: 1, vram_mb: 8192 }),
      'bad-pin': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 1,
        vram_mb: 4096,
        affinity: 'pin:gpu-99',
      }),
      'bad-backend': createResourceSpec({
        backends: ['metal'],
        gpu_count: 1,
        vram_mb: 4096,
      }),
    });

    const active = await pool.acquire('cuda-ok', { timeout: 2 });

    const started = Date.now();
    await assert.rejects(() => pool.acquire('bad-pin', { timeout: 5 }));
    await assert.rejects(() => pool.acquire('bad-backend', { timeout: 5 }));
    assert.ok(Date.now() - started < 1500, 'Unsatisfiable specs must fail fast without waiting');

    const st = pool.status();
    assert.equal(st.queued, 0);
    assert.equal(st.allocations.length, 1);
    assert.equal(st.allocations[0].engine, 'cuda-ok');

    await active.release();
  });

  it('fa04.t2.2 rejects vram_mb > max single GPU for gpu_count=1 without evicting existing allocations', async (t) => {
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

    const snapshot = createMockHardwareSnapshot('dual-heterogeneous-24g-12g');
    const stopped: string[] = [];
    const pool = await createPoolInstance(
      entry!,
      snapshot,
      {
        resident: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 4096,
          vram_mode: 'shared',
        }),
        oversized: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 32768,
          vram_mode: 'exclusive',
        }),
      },
      {
        onStop(engine) {
          stopped.push(engine);
        },
      },
    );

    const resLease = await pool.acquire('resident', { timeout: 2 });
    await resLease.release();

    await assert.rejects(() => pool.acquire('oversized', { timeout: 2 }));
    assert.equal(stopped.length, 0, 'Impossible 1-GPU VRAM request must not evict existing models');
    assert.equal(pool.status().allocations.length, 1);
  });

  it('fa04.t2.3 rolls back atomic TP reservation on partial GPU availability without deadlocking 1-GPU work', async (t) => {
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
          vram_total_mb: 24576,
          vram_used_mb: 0,
          vram_free_mb: 24576,
        }),
      ],
    };

    const idleMap: Record<string, boolean> = { 'busy-0': false };
    const pool = await createPoolInstance(
      entry!,
      snapshot,
      {
        'busy-0': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 16384,
          vram_mode: 'exclusive',
          affinity: 'pin:gpu-0',
        }),
        'tp-2gpu': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 2,
          vram_mb: 16384,
          vram_mode: 'exclusive',
        }),
        'small-1gpu': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 8192,
          vram_mode: 'shared',
          affinity: 'pin:gpu-1',
        }),
      },
      { idleMap },
    );

    const busyLease = await pool.acquire('busy-0', { timeout: 2 });
    const completionOrder: string[] = [];
    const tpAttempt = pool.acquire('tp-2gpu', { timeout: 1.0 }).then(
      (v) => {
        completionOrder.push('tp-ok');
        return v;
      },
      (err) => {
        completionOrder.push('tp-fail');
        throw err;
      },
    );
    const oneGpuAttempt = pool.acquire('small-1gpu', { timeout: 0.2 }).then((v) => {
      completionOrder.push('1gpu-ok');
      return v;
    });

    const [tpRes, oneGpuRes] = await Promise.allSettled([tpAttempt, oneGpuAttempt]);
    assert.equal(tpRes.status, 'rejected', 'TP 2-GPU request must fail/timeout when gpu-0 is busy');
    assert.equal(
      oneGpuRes.status,
      'fulfilled',
      '1-GPU request on free gpu-1 must succeed without TP partial-hold deadlock',
    );
    assert.deepEqual(oneGpuRes.value.gpu_ids, ['gpu-1']);
    assert.deepEqual(
      completionOrder,
      ['1gpu-ok', 'tp-fail'],
      '1-GPU request on gpu-1 must fulfill BEFORE tpAttempt rejects (no partial hold on gpu-1)',
    );

    await oneGpuRes.value.release();
    idleMap['busy-0'] = true;
    await busyLease.release();
  });

  it('fa04.t2.4 never preempts busy runtime (idle() === false) mid-request', async (t) => {
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
    const idleMap: Record<string, boolean> = { 'engine-a': false };
    const stopped: string[] = [];
    const pool = await createPoolInstance(
      entry!,
      snapshot,
      {
        'engine-a': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 16384,
          vram_mode: 'shared',
        }),
        'engine-b': createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 16384,
          vram_mode: 'shared',
        }),
      },
      {
        idleMap,
        onStop(engine) {
          stopped.push(engine);
        },
      },
    );

    const leaseA = await pool.acquire('engine-a', { timeout: 2 });
    await assert.rejects(() => pool.acquire('engine-b', { timeout: 0.1 }));
    assert.equal(stopped.length, 0, 'Busy engine-a must never be stopped mid-request');

    idleMap['engine-a'] = true;
    await leaseA.release();

    const leaseB = await pool.acquire('engine-b', { timeout: 2 });
    assert.deepEqual(leaseB.gpu_ids, ['gpu-0']);
    await leaseB.release();
  });

  it('fa04.t2.5 cleans up queued slots on timeout and AbortSignal cancellation', async (t) => {
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
    const startedEngines: string[] = [];
    const pool = await createPoolInstance(
      entry!,
      snapshot,
      {
        holder: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 20480,
          vram_mode: 'exclusive',
        }),
        waiter: createResourceSpec({
          backends: ['cuda'],
          gpu_count: 1,
          vram_mb: 12288,
          vram_mode: 'shared',
        }),
      },
      {
        onEnsure(engine) {
          startedEngines.push(engine);
        },
      },
    );

    const hold = await pool.acquire('holder', { timeout: 2 });
    const ac = new AbortController();
    const abortedReq = pool.acquire('waiter', { timeout: 5, signal: ac.signal });
    const timeoutReq = pool.acquire('waiter', { timeout: 0.06 });
    setTimeout(() => ac.abort(), 20);

    await assert.rejects(() => abortedReq);
    await assert.rejects(() => timeoutReq);
    assert.equal(pool.status().queued, 0);
    assert.ok(!startedEngines.includes('waiter'));

    await hold.release();
    const ok = await pool.acquire('waiter', { timeout: 2 });
    assert.deepEqual(ok.gpu_ids, ['gpu-0']);
    await ok.release();
  });

  it('fa04.t2.6 enforces boundary concurrency=1, exact-fit vs +1MB VRAM saturation, and EngineScheduling boundary checks', async (t) => {
    const entry = await getPoolCoordinatorEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #14): GpuPoolCoordinator boundary checks require pool-coordinator',
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
      EngineScheduling: new (policy?: Record<string, number>) => unknown;
    };

    // EngineScheduling boundary validation checks
    assert.throws(
      () => new schedMod.EngineScheduling({ minBatchRequests: 5, maxBatchRequests: 4 }),
    );
    assert.throws(() => new schedMod.EngineScheduling({ maxWaitSeconds: Number.NaN }));
    assert.throws(() => new schedMod.EngineScheduling({ minBatchRequests: 0 }));

    const snapshot = createMockHardwareSnapshot('single-gpu-24g', {
      gpus: [
        createMockGpuDevice({
          id: 'gpu-0',
          index: 0,
          vendor: 'nvidia',
          backend: 'cuda',
          vram_total_mb: 24576,
          vram_used_mb: 512,
          vram_free_mb: 24064,
        }),
      ],
    });
    const pool = await createPoolInstance(entry!, snapshot, {
      exact: createResourceSpec({
        backends: ['cuda'],
        gpu_count: 1,
        vram_mb: 24064,
        vram_mode: 'shared',
        concurrency: 1,
      }),
      over: createResourceSpec({
        backends: ['cuda'],
        gpu_count: 1,
        vram_mb: 24065,
        vram_mode: 'shared',
        concurrency: 1,
      }),
    });

    // Pre-aborted AbortSignal must reject immediately on GpuPoolCoordinator
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => pool.acquire('exact', { signal: ac.signal, timeout: 2 }));

    // +1 MB over free VRAM must fail
    await assert.rejects(() => pool.acquire('over', { timeout: 0.2 }));

    // Exact fit must succeed; concurrency: 1 queues 2nd lease until 1st releases
    const first = await pool.acquire('exact', { timeout: 2 });
    assert.equal(first.allocation.capacity, 1);

    let secondDone = false;
    const secondPromise = pool.acquire('exact', { timeout: 2 }).then((lease) => {
      secondDone = true;
      return lease;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      secondDone,
      false,
      'concurrency=1 must queue second acquire while first is active',
    );
    assert.equal(pool.status().queued, 1);

    await first.release();
    const second = await secondPromise;
    assert.equal(secondDone, true);
    await second.release();
  });
});
