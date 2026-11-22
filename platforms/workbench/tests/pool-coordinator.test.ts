import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GpuPoolCoordinator } from '../lib/scheduler/pool-coordinator.ts';
import type { GpuDevice, HardwareSnapshot, ResourceSpec } from '../lib/types.ts';

function gpu(overrides: Partial<GpuDevice> = {}): GpuDevice {
  const total = overrides.vram_total_mb ?? 24576;
  const used = overrides.vram_used_mb ?? 0;
  return {
    id: overrides.id ?? 'nvidia:0',
    index: overrides.index ?? 0,
    vendor: overrides.vendor ?? 'nvidia',
    backend: overrides.backend ?? 'cuda',
    name: overrides.name ?? 'Mock GPU',
    unified_memory: overrides.unified_memory ?? false,
    vram_total_mb: total,
    vram_used_mb: used,
    vram_free_mb: overrides.vram_free_mb ?? Math.max(0, total - used),
    utilization_pct: null,
    temperature_c: null,
    power_w: null,
  };
}

function makeSnapshot(gpus: GpuDevice[]): HardwareSnapshot {
  return {
    collected_at: Date.now(),
    gpus,
    host: { os: 'linux', arch: 'x64', ram_total_mb: 65536, ram_free_mb: 49152 },
  };
}

function makeBackend(
  specs: Record<string, ResourceSpec>,
  snapshot: HardwareSnapshot,
  events: Array<{ type: string; engine: string; gpu_ids: string[] }> = [],
  idleMap: Record<string, boolean> = {},
) {
  return {
    models: Object.fromEntries(Object.keys(specs).map((k) => [k, []])),
    specs,
    async hardwareSnapshot() {
      return snapshot;
    },
    async ensure(
      engine: string,
      _deadline: number,
      _clock: () => number,
      _policy?: unknown,
      _report?: unknown,
      gpuIds: string[] = [],
    ) {
      events.push({ type: 'start', engine, gpu_ids: gpuIds });
    },
    async stop(engine: string, gpuIds: string[] = []) {
      events.push({ type: 'stop', engine, gpu_ids: gpuIds });
    },
    async idle(engine: string) {
      return idleMap[engine] ?? true;
    },
  };
}

function spec(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return {
    backends: overrides.backends ?? ['cuda'],
    gpu_count: overrides.gpu_count ?? 1,
    vram_mb: overrides.vram_mb ?? 8192,
    vram_mode: overrides.vram_mode ?? 'shared',
    concurrency: overrides.concurrency ?? 2,
    affinity: overrides.affinity ?? 'any',
    cold_start_weight: overrides.cold_start_weight ?? 'low',
  };
}

test('Best-Fit places 1-GPU workload on smallest fitting GPU while preserving larger GPU', async () => {
  const snapshot = makeSnapshot([
    gpu({ id: 'nvidia:0', index: 0, vram_total_mb: 24576, vram_free_mb: 24576 }),
    gpu({ id: 'nvidia:1', index: 1, vram_total_mb: 12288, vram_free_mb: 12288 }),
  ]);
  const events: Array<{ type: string; engine: string; gpu_ids: string[] }> = [];
  const specs: Record<string, ResourceSpec> = {
    small: spec({ vram_mb: 10240 }),
    large: spec({ vram_mb: 20480 }),
  };
  const coord = new GpuPoolCoordinator(makeBackend(specs, snapshot, events), { resources: specs });

  const t1 = await coord.acquire('small', { timeout: 2 });
  assert.deepEqual(t1.gpu_ids, ['nvidia:1']);
  const t2 = await coord.acquire('large', { timeout: 2 });
  assert.deepEqual(t2.gpu_ids, ['nvidia:0']);
  assert.equal(coord.status().allocations.length, 2);

  await coord.release(t1.token);
  await coord.release(t2.token);
});

test('Shared coexistence keeps multiple compatible models on the same GPU without eviction', async () => {
  const snapshot = makeSnapshot([gpu({ id: 'nvidia:0', index: 0, vram_total_mb: 24576 })]);
  const events: Array<{ type: string; engine: string; gpu_ids: string[] }> = [];
  const sharedSpecs = {
    llm: spec({ vram_mb: 10000, vram_mode: 'shared' }),
    asr: spec({ vram_mb: 4000, vram_mode: 'shared' }),
  };
  const coord = new GpuPoolCoordinator(makeBackend(sharedSpecs, snapshot, events), {
    resources: sharedSpecs,
  });

  const l1 = await coord.acquire('llm', { timeout: 2 });
  const l2 = await coord.acquire('asr', { timeout: 2 });
  assert.deepEqual(l1.gpu_ids, ['nvidia:0']);
  assert.deepEqual(l2.gpu_ids, ['nvidia:0']);
  assert.equal(events.filter((e) => e.type === 'stop').length, 0);

  await coord.release(l1.token);
  await coord.release(l2.token);
});

test('Atomic multi-GPU TP reserves distinct GPUs and rolls back unsatisfiable TP cleanly', async () => {
  const snapshot = makeSnapshot([
    gpu({ id: 'nvidia:0', index: 0, vram_total_mb: 24576 }),
    gpu({ id: 'nvidia:1', index: 1, vram_total_mb: 24576 }),
    gpu({ id: 'nvidia:2', index: 2, vram_total_mb: 24576 }),
  ]);
  const events: Array<{ type: string; engine: string; gpu_ids: string[] }> = [];
  const tpSpecs = {
    one: spec({ gpu_count: 1, vram_mb: 8000 }),
    tp2: spec({ gpu_count: 2, vram_mb: 12000, vram_mode: 'exclusive' }),
    tp4: spec({ gpu_count: 4, vram_mb: 12000 }),
  };
  const coord = new GpuPoolCoordinator(makeBackend(tpSpecs, snapshot, events), {
    resources: tpSpecs,
  });

  const tp2 = await coord.acquire('tp2', { timeout: 2 });
  assert.equal(new Set(tp2.gpu_ids).size, 2);
  const one = await coord.acquire('one', { timeout: 2 });
  assert.equal(one.gpu_ids.length, 1);
  assert.ok(!tp2.gpu_ids.includes(one.gpu_ids[0]));

  await assert.rejects(
    coord.acquire('tp4', { timeout: 1 }),
    (e: Error & { code?: string }) =>
      e.code === 'INSUFFICIENT_RESOURCES' || /VRAM|GPU/i.test(e.message),
  );
  assert.equal(coord.status().allocations.length, 2);

  await coord.release(tp2.token);
  await coord.release(one.token);
});

test('Affinity pin:<id> / prefer:<id> and graceful eviction priority work deterministically', async () => {
  const snapshot = makeSnapshot([
    gpu({ id: 'nvidia:0', index: 0, vram_total_mb: 24576 }),
    gpu({ id: 'nvidia:1', index: 1, vram_total_mb: 24576 }),
  ]);
  const events: Array<{ type: string; engine: string; gpu_ids: string[] }> = [];
  const idleMap: Record<string, boolean> = {};
  const affSpecs = {
    pinned: spec({ vram_mb: 8000, affinity: 'pin:nvidia:1' }),
    preferred: spec({ vram_mb: 8000, affinity: 'prefer:nvidia:0' }),
    heavy: spec({ vram_mb: 12000, affinity: 'pin:nvidia:0', cold_start_weight: 'high' }),
    light: spec({ vram_mb: 12000, affinity: 'pin:nvidia:0', cold_start_weight: 'low' }),
    comer: spec({ vram_mb: 12000, affinity: 'pin:nvidia:0' }),
  };
  const coord = new GpuPoolCoordinator(makeBackend(affSpecs, snapshot, events, idleMap), {
    resources: affSpecs,
  });

  const p = await coord.acquire('pinned', { timeout: 2 });
  assert.deepEqual(p.gpu_ids, ['nvidia:1']);
  const pref = await coord.acquire('preferred', { timeout: 2 });
  assert.deepEqual(pref.gpu_ids, ['nvidia:0']);
  await coord.release(p.token);
  await coord.release(pref.token);
  await coord.evictEngine('preferred');
  await coord.evictEngine('pinned');

  const h = await coord.acquire('heavy', { timeout: 2 });
  const l = await coord.acquire('light', { timeout: 2 });
  await coord.release(h.token);
  await coord.release(l.token);
  events.length = 0;

  const c = await coord.acquire('comer', { timeout: 2 });
  const stops = events.filter((e) => e.type === 'stop').map((e) => e.engine);
  assert.deepEqual(stops, ['light']);
  assert.deepEqual(c.gpu_ids, ['nvidia:0']);
  await coord.release(c.token);
});

test('Legacy virtual single-GPU equivalence holds when HardwareSnapshot has 0 hardware GPUs and no topology', async () => {
  const events: Array<{ type: string; engine: string; gpu_ids: string[] }> = [];
  const coord = new GpuPoolCoordinator({
    models: { llm: [], anima: [], h3: [] },
    async ensure(engine: string) {
      events.push({ type: 'start', engine, gpu_ids: [] });
    },
    async stop(engine: string) {
      events.push({ type: 'stop', engine, gpu_ids: [] });
    },
    async idle() {
      return true;
    },
  });

  const a = await coord.acquire('anima', { timeout: 2 });
  assert.deepEqual(a.gpu_ids, []);
  let secondReady = false;
  const secondP = coord.acquire('h3', { timeout: 2 }).then((t) => {
    secondReady = true;
    return t;
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(secondReady, false);
  await coord.release(a.token);
  const b = await secondP;
  assert.deepEqual(
    events.map((e) => e.type),
    ['start', 'stop', 'start'],
  );
  await coord.release(b.token);
});
