import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type {
  DeviceProvider,
  DownloadProgress,
  HardwareSnapshot,
  HubModelEntry,
  PoolAllocation,
  PoolStatus,
  ResourceSpec,
} from '../../../platforms/workbench/lib/types.ts';
import {
  assertDownloadProgress,
  assertHardwareSnapshot,
  assertHubModelEntry,
  assertNoImportCycles,
  assertPoolAllocation,
  assertPoolStatus,
} from '../lib/assertions.ts';
import {
  createIsolatedWorkspace,
  deliverableExists,
  E2E_ROOT,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { createMockHardwareSnapshot, createResourceSpec } from '../lib/fixtures.ts';
import { assertStatus, httpJson, httpRequest, readSseStream } from '../lib/http-client.ts';
import {
  createMockArtifactDownloadServer,
  createMockComfyUIServer,
  createMockOllamaServer,
} from '../lib/mock-servers.ts';
import {
  runCommand,
  spawnMcpStdioClient,
  spawnWorkbenchControlPlane,
  withWorkbenchTsconfigLock,
} from '../lib/process-runner.ts';

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
      const rawSlots = (raw.allocation as { slots?: Array<{ gpu_id: string }> } | undefined)?.slots;
      const gpuIds =
        rawSlots?.map((s) => s.gpu_id) ??
        (Array.isArray(raw.slots)
          ? (raw.slots as Array<{ gpu_id: string }>).map((s) => s.gpu_id)
          : Array.isArray(raw.gpu_ids)
            ? (raw.gpu_ids as string[])
            : allocation.slots.map((s) => s.gpu_id));
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

function expectedAutoArtifactsDir(homeRoot: string): string {
  if (process.platform === 'win32') {
    return path.join(homeRoot, 'VramDeck', 'artifacts');
  }
  if (process.platform === 'darwin') {
    return path.join(homeRoot, 'Library', 'Application Support', 'VramDeck', 'artifacts');
  }
  return path.join(homeRoot, 'vramdeck', 'artifacts');
}

async function hasWorkbenchDeps(): Promise<boolean> {
  const [hasNext, hasSharp, hasUndici] = await Promise.all([
    deliverableExists('platforms/workbench/node_modules/next/package.json'),
    deliverableExists('platforms/workbench/node_modules/sharp/package.json'),
    deliverableExists('platforms/workbench/node_modules/undici/package.json'),
  ]);
  return hasNext && hasSharp && hasUndici;
}

async function hasMcpSdk(): Promise<boolean> {
  return deliverableExists('platforms/mcp/node_modules/@modelcontextprotocol/sdk/package.json');
}

async function hasM3PoolAndDrivers(): Promise<boolean> {
  const pool = await findFirstExisting([
    'platforms/workbench/lib/scheduler/pool-coordinator.ts',
    'platforms/workbench/lib/scheduler/pool-coordinator.mjs',
  ]);
  const drivers = await findFirstExisting([
    'platforms/workbench/lib/drivers/index.ts',
    'platforms/workbench/lib/drivers/index.mjs',
  ]);
  return Boolean(pool && drivers);
}

async function hasM4HubDeliverables(): Promise<boolean> {
  const scanner = await findFirstExisting([
    'platforms/workbench/lib/hub/scanner.ts',
    'platforms/workbench/lib/hub/scanner.mjs',
  ]);
  const catalog = await findFirstExisting([
    'platforms/workbench/lib/hub/catalog.ts',
    'platforms/workbench/lib/hub/catalog.mjs',
  ]);
  const downloader = await findFirstExisting([
    'platforms/workbench/lib/hub/downloader.ts',
    'platforms/workbench/lib/hub/downloader.mjs',
  ]);
  const serverRel = await findFirstExisting([
    'platforms/workbench/server.ts',
    'platforms/workbench/server.mjs',
  ]);
  if (!scanner || !catalog || !downloader || !serverRel) return false;
  const serverSrc = await readFile(path.join(REPO_ROOT, serverRel), 'utf8');
  return serverSrc.includes('/api/hub');
}

async function hasM5UiDeliverables(): Promise<boolean> {
  const layoutRel = await findFirstExisting([
    'platforms/workbench/app/layout.tsx',
    'platforms/workbench/app/layout.jsx',
  ]);
  if (!layoutRel) return false;
  const layoutSrc = await readFile(path.join(REPO_ROOT, layoutRel), 'utf8');
  return !/AI Workbench/.test(layoutSrc) && /\bVramDeck\b/.test(layoutSrc);
}

async function hasM5Installers(): Promise<boolean> {
  return (
    (await deliverableExists('scripts/install.sh')) &&
    (await deliverableExists('scripts/install.ps1'))
  );
}

async function hasM6OssLaunchDeliverables(): Promise<boolean> {
  const docsOk =
    (await deliverableExists('README.md')) &&
    (await deliverableExists('README.zh-CN.md')) &&
    (await deliverableExists('CONTRIBUTING.md')) &&
    (await deliverableExists('docs/guide/ADD_ENGINE.md')) &&
    (await deliverableExists('.github/PULL_REQUEST_TEMPLATE.md'));
  if (!docsOk) return false;
  const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const ci = await readFile(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  return /\bVramDeck\b/.test(readme) && /format:check|prettier\s+--check/.test(ci);
}

describe('Tier 4: Real-World Multi-Feature End-to-End Application Scenarios', () => {
  it('t4.01 GPU-less laptop cold start + Hub local Ollama scan/adopt + JSON & SSE chat completions', async (t) => {
    const ready =
      (await hasWorkbenchDeps()) && (await hasM3PoolAndDrivers()) && (await hasM4HubDeliverables());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3/M4 (Features #16, #18, #20): external driver & Hub scan/adopt required',
      )
    ) {
      return;
    }

    const ollama = await createMockOllamaServer({
      models: [{ name: 'qwen2.5:7b', size: 4_700_000_000 }],
      responseText: 'vramdeck-ollama-e2e-ok',
    });
    const ws = await createIsolatedWorkspace('t4-01-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ollama.close().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: {
        WORKBENCH_HEADLESS: '1',
        WORKBENCH_MOCK_GPUS: '[]',
        WORKBENCH_HUB_SCAN_URLS: ollama.base,
      },
    });

    const health = await httpJson<{ status: string }>(`${cp.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');

    const cliAbs = path.join(REPO_ROOT, 'platforms', 'workbench', 'cli.mjs');
    const devRes = await runCommand(resolveNode22Plus(), [cliAbs, 'devices', '--json'], {
      env: { ...ws.env, INFERENCE_PORT: String(cp.ports.inference) },
    });
    assert.equal(devRes.code, 0, devRes.stderr);
    const snap = JSON.parse(devRes.stdout) as HardwareSnapshot;
    assertHardwareSnapshot(snap);
    assert.equal(snap.gpus.length, 0);

    const scanRes = await httpJson<Record<string, unknown>>(`${cp.urls.workbench}/api/hub/scan`, {
      method: 'POST',
      body: { urls: [ollama.base] },
    });
    assert.equal(scanRes.status, 200);

    const adoptRes = await httpJson<Record<string, unknown>>(`${cp.urls.workbench}/api/hub/adopt`, {
      method: 'POST',
      body: { kind: 'ollama', base_url: ollama.base, id: 'ollama-laptop' },
    });
    assertStatus(
      {
        status: adoptRes.status,
        headers: adoptRes.headers,
        rawBody: Buffer.alloc(0),
        text: '',
        json: adoptRes.data,
      },
      [200, 201],
      'Adopt local Ollama',
    );

    const keyRes = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 't4-01', maxConcurrent: 2, requestsPerMinute: 30 },
    });

    const chatJson = await httpJson<{ choices: Array<{ message: { content: string } }> }>(
      `${cp.urls.inference}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${keyRes.data.secret}` },
        body: { model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hello' }] },
      },
    );
    assert.equal(chatJson.status, 200);

    const sse = await readSseStream(`${cp.urls.inference}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyRes.data.secret}` },
      body: { model: 'qwen2.5:7b', stream: true, messages: [{ role: 'user', content: 'stream' }] },
    });
    assert.equal(sse.status, 200);
    assert.ok(sse.events.some((e) => e.data === '[DONE]'));
    assert.ok(ollama.requests.length >= 2);
  });

  it('t4.02 2-GPU heterogeneous (24G+12G) coexistence + heavy eviction + anti-starvation', async (t) => {
    const ready = await hasM3PoolAndDrivers();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3 (Feature #14): GpuPoolCoordinator coexistence & eviction not delivered',
      )
    ) {
      return;
    }

    const poolRel = await findFirstExisting([
      'platforms/workbench/lib/scheduler/pool-coordinator.ts',
      'platforms/workbench/lib/scheduler/pool-coordinator.mjs',
    ]);
    const snap = createMockHardwareSnapshot('dual-heterogeneous-24g-12g');

    let fakeNow = 0;
    const evicted: string[] = [];
    const pool = await createPoolInstance(
      poolRel!,
      snap,
      {
        'small-a': createResourceSpec({
          backends: ['cuda'],
          vram_mb: 8192,
          vram_mode: 'shared',
          concurrency: 2,
          cold_start_weight: 'low',
        }),
        'small-b': createResourceSpec({
          backends: ['cuda'],
          vram_mb: 8192,
          vram_mode: 'shared',
          concurrency: 2,
          cold_start_weight: 'medium',
        }),
        'heavy-c': createResourceSpec({
          backends: ['cuda'],
          vram_mb: 20480,
          vram_mode: 'exclusive',
          concurrency: 1,
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
        onStop(engine) {
          evicted.push(engine);
        },
      },
    );

    const l1 = await pool.acquire('small-a', { timeout: 4, enqueuedAt: 0 });
    const l2 = await pool.acquire('small-b', { timeout: 4, enqueuedAt: 1 });
    assert.deepEqual(l1.gpu_ids, ['gpu-0']);
    assert.deepEqual(l2.gpu_ids, ['gpu-0']);

    const midStatus = pool.status();
    assertPoolStatus(midStatus);
    assert.equal(midStatus.allocations.length, 2, 'small-a and small-b must coexist on gpu-0');
    assert.equal(evicted.length, 0, 'Active coexisting allocations must not evict each other');

    fakeNow = 10;
    const heavyPromise = pool.acquire('heavy-c', { timeout: 5, enqueuedAt: 10 });
    await l1.release();
    await l2.release();

    const heavy = await heavyPromise;
    assert.deepEqual(heavy.gpu_ids, ['gpu-0'], 'heavy-c must land on 24G gpu-0');
    assert.ok(evicted.length >= 1, 'heavy-c must evict idle resident small models to fit 20480MB');

    // Anti-starvation check: aged small-a waiting > maxWaitSeconds must be prioritized over newer burst
    const order: string[] = [];
    fakeNow = 20;
    const agedSmall = pool.acquire('small-a', { timeout: 5, enqueuedAt: 20 }).then(async (l) => {
      order.push('small-a');
      await l.release();
    });
    const newHeavy = pool.acquire('heavy-c', { timeout: 5, enqueuedAt: 350 }).then(async (l) => {
      order.push('heavy-c');
      await l.release();
    });
    fakeNow = 360;
    await new Promise((r) => setTimeout(r, 20));
    await heavy.release();
    await Promise.all([agedSmall, newHeavy]);
    assert.equal(order[0], 'small-a', 'Anti-starvation must serve aged waiter before new heavy-c');

    assertPoolStatus(pool.status());
  });

  it('t4.03 4-GPU Tensor Parallel LLM (gpu_count=2) + concurrent Audio/Vision + topology/metrics', async (t) => {
    const ready = (await hasM3PoolAndDrivers()) && (await hasM5UiDeliverables());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3/M5 (Features #14, #22): TP pool coordinator & Topology UI not delivered',
      )
    ) {
      return;
    }

    const poolRel = await findFirstExisting([
      'platforms/workbench/lib/scheduler/pool-coordinator.ts',
      'platforms/workbench/lib/scheduler/pool-coordinator.mjs',
    ]);
    const snap = createMockHardwareSnapshot('quad-24g');

    const pool = await createPoolInstance(poolRel!, snap, {
      'tp-llm': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 2,
        vram_mb: 16384,
        vram_mode: 'exclusive',
        concurrency: 2,
      }),
      'audio-vision': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 1,
        vram_mb: 8192,
        vram_mode: 'shared',
        concurrency: 2,
      }),
    });

    const tp = await pool.acquire('tp-llm', { timeout: 3 });
    assert.equal(tp.gpu_ids.length, 2, 'TP LLM must reserve 2 distinct GPUs');
    assert.equal(new Set(tp.gpu_ids).size, 2);

    const av = await pool.acquire('audio-vision', { timeout: 3 });
    assert.equal(av.gpu_ids.length, 1);
    assert.ok(
      !tp.gpu_ids.includes(av.gpu_ids[0]),
      'Concurrent Audio/Vision must occupy a remaining non-TP GPU with zero double-allocation',
    );

    const st = pool.status();
    assertPoolStatus(st);
    assert.equal(st.allocations.length, 2);

    await tp.release();
    await av.release();

    const ws = await createIsolatedWorkspace('t4-03-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: JSON.stringify(snap.gpus) },
      readyTimeoutMs: 45_000,
    });

    const dataRes = await httpJson<{
      gpus: unknown[];
      values: Record<string, number | null>;
      runtime_topology?: { label?: string };
    }>(`${cp.urls.inference}/data?minutes=15&window=30`);
    assert.equal(dataRes.status, 200);
    assert.equal(dataRes.data.gpus.length, 4);
    assert.equal(dataRes.data.values.vram_total, 4 * 24576 * 1048576);
    assert.doesNotMatch(dataRes.data.runtime_topology?.label ?? '', /单卡按需切换/);

    const metricsRes = await httpRequest(`${cp.urls.inference}/metrics`);
    assertStatus(metricsRes, 200, '4-GPU /metrics');
    assert.match(metricsRes.text, /lab_gpu_devices\s+4/);
  });

  it('t4.04 Unreliable mirror download (Range 206 resume + SHA256 verify + 8G quant recommendations)', async (t) => {
    const ready = await hasM4HubDeliverables();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M4 (Feature #19): Hub catalog & Range-resumable downloader not delivered',
      )
    ) {
      return;
    }

    const payload = Buffer.alloc(64 * 1024, 0x5a);
    const mirror = await createMockArtifactDownloadServer({
      files: { '/qwen-q4.gguf': payload },
      dropAfterBytes: 16384,
      dropCount: 2,
    });
    const ws = await createIsolatedWorkspace('t4-04-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await mirror.close().catch(() => {});
      await ws.cleanup();
    });

    const dlRel = await findFirstExisting([
      'platforms/workbench/lib/hub/downloader.ts',
      'platforms/workbench/lib/hub/downloader.mjs',
    ]);
    const dlMod = (await import(pathToFileURL(path.join(REPO_ROOT, dlRel!)).href)) as Record<
      string,
      unknown
    >;
    const downloadFn = (dlMod.downloadWithResume ??
      dlMod.downloadArtifact ??
      dlMod.downloadFile ??
      dlMod.download) as (opts: Record<string, unknown>) => Promise<DownloadProgress>;
    assert.equal(typeof downloadFn, 'function');

    const destOk = path.join(ws.artifactsDir, 'qwen-q4.gguf');
    const expectedSha = mirror.digests['/qwen-q4.gguf'].sha256;

    const progress = await downloadFn({
      url: `${mirror.base}/qwen-q4.gguf`,
      destination: destOk,
      dest: destOk,
      target: 'qwen-q4.gguf',
      sha256: expectedSha,
      retries: 3,
    });
    assertDownloadProgress(progress);
    assert.equal(progress.status, 'completed');
    assert.equal(existsSync(destOk), true);

    const rangeRequests = mirror.requests.filter((r) => Boolean(r.headers.range));
    assert.ok(rangeRequests.length >= 1, 'Mirror must receive HTTP Range resume requests');

    const gpu8g = createMockHardwareSnapshot('single-gpu-24g').gpus.map((g) => ({
      ...g,
      vram_total_mb: 8192,
      vram_free_mb: 7680,
    }));
    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: JSON.stringify(gpu8g) },
    });

    const catRes = await httpJson<{
      models?: Array<HubModelEntry & { fit?: string; status?: string; fits?: boolean }>;
    }>(`${cp.urls.workbench}/api/hub/catalog`);
    assert.equal(catRes.status, 200);
    const models = catRes.data.models ?? [];
    assert.ok(models.length > 0, 'Hub catalog must return models for 8G recommendation check');
    for (const m of models) {
      assertHubModelEntry(m);
    }

    const fitSmall = models.filter((m) => m.recommended_vram_mb <= 7680);
    assert.ok(fitSmall.length > 0, 'Catalog must include at least one <=8G quantization model');
    for (const m of fitSmall) {
      if (m.fits !== undefined) {
        assert.equal(m.fits, true, `${m.id} (${m.recommended_vram_mb}MB) must fit 8G VRAM`);
      }
      if (m.fit || m.status) {
        assert.match(String(m.fit ?? m.status), /fit|ok|tight|warn/i);
      }
    }
    const oversized = models.filter((m) => m.recommended_vram_mb > 8192);
    for (const m of oversized) {
      if (m.fits !== undefined) {
        assert.equal(m.fits, false, `${m.id} (${m.recommended_vram_mb}MB) must not fit 8G VRAM`);
      }
      if (m.fit || m.status) {
        assert.match(String(m.fit ?? m.status), /too.?large|insufficient|exceed|no.?fit/i);
      }
    }
  });

  it('t4.05 External artifact disk offline (503 ARTIFACT_STORAGE_OFFLINE) -> marker mount & "auto" recovery', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(t, readyDeps, 'M1 (Features #7, #11): workbench node_modules required')
    ) {
      return;
    }

    const wsOffline = await createIsolatedWorkspace('t4-05-offline-', {
      withArtifactsMarker: false,
    });
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await wsOffline.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(wsOffline, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
    });

    const health = await httpJson<{ status: string }>(`${cp.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');

    const keyRes = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 't4-05', maxConcurrent: 2, requestsPerMinute: 30 },
    });
    assert.equal(keyRes.status, 200);

    const offlineJob = await httpRequest<{ error: string }>(`${cp.urls.inference}/v1/media/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyRes.data.secret}` },
      body: {
        tool: 'generate_image',
        arguments: { request_id: 't4-05-offline-req', prompt: 'offline test' },
      },
    });
    assertStatus(offlineJob, 503, 'Missing marker must reject media job with 503');
    assert.equal(offlineJob.json?.error, 'ARTIFACT_STORAGE_OFFLINE');

    await writeFile(path.join(wsOffline.artifactsDir, '.llm-backend-artifacts'), '', 'utf8');

    const onlineJob = await httpJson<{ job_id: string; state: string }>(
      `${cp.urls.inference}/v1/media/jobs`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${keyRes.data.secret}` },
        body: {
          tool: 'generate_image',
          arguments: { request_id: 't4-05-online-req', prompt: 'recovered test' },
        },
      },
    );
    assert.equal(onlineJob.status, 202);
    assert.ok(onlineJob.data.job_id.startsWith('job_'));

    await httpRequest(`${cp.urls.inference}/v1/media/jobs/${onlineJob.data.job_id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyRes.data.secret}` },
    });

    const listed = await httpJson<{ jobs: Array<{ job_id: string }> }>(
      `${cp.urls.inference}/v1/media/jobs`,
      { headers: { Authorization: `Bearer ${keyRes.data.secret}` } },
    );
    assert.equal(listed.status, 200);
    assert.ok(listed.data.jobs.some((j) => j.job_id === onlineJob.data.job_id));

    await cp.stop();
    cp = undefined;

    const wsAuto = await createIsolatedWorkspace('t4-05-auto-', { withArtifactsMarker: false });
    let cpAuto: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cpAuto?.stop().catch(() => {});
      await wsAuto.cleanup();
    });

    cpAuto = await spawnWorkbenchControlPlane(wsAuto, {
      env: {
        WORKBENCH_HEADLESS: '1',
        WORKBENCH_MOCK_GPUS: '[]',
        MEDIA_ARTIFACTS_ROOT: undefined,
        LOCALAPPDATA: wsAuto.rootDir,
        XDG_DATA_HOME: wsAuto.rootDir,
        HOME: wsAuto.rootDir,
      },
    });

    const autoDir = expectedAutoArtifactsDir(wsAuto.rootDir);
    assert.equal(
      existsSync(path.join(autoDir, '.llm-backend-artifacts')),
      true,
      `"auto" artifacts marker must be auto-created inside isolated ${autoDir}`,
    );

    const autoKeyRes = await httpJson<{ secret: string }>(
      `${cpAuto.urls.workbench}/api/access-keys`,
      {
        method: 'POST',
        body: { action: 'create', name: 't4-05-auto', maxConcurrent: 2, requestsPerMinute: 30 },
      },
    );
    assert.equal(autoKeyRes.status, 200);

    const autoJob = await httpJson<{ job_id: string; state: string }>(
      `${cpAuto.urls.inference}/v1/media/jobs`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${autoKeyRes.data.secret}` },
        body: {
          tool: 'generate_image',
          arguments: { request_id: 't4-05-auto-req', prompt: 'auto storage recovery' },
        },
      },
    );
    assert.equal(autoJob.status, 202, 'Media job under "auto" storage must succeed with 202');
    assert.ok(autoJob.data.job_id.startsWith('job_'));

    await httpRequest(`${cpAuto.urls.inference}/v1/media/jobs/${autoJob.data.job_id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${autoKeyRes.data.secret}` },
    });
  });

  it('t4.06 Bilingual EN/中文 Web Console + Node CLI + MCP browse_media durable job & artifact download flow', async (t) => {
    const ready =
      (await hasWorkbenchDeps()) &&
      (await hasMcpSdk()) &&
      (await hasM3PoolAndDrivers()) &&
      (await hasM4HubDeliverables()) &&
      (await hasM5UiDeliverables());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3/M4/M5 (Features #16, #18, #22): runtime driver, Hub adopt & bilingual VramDeck UI required',
      )
    ) {
      return;
    }

    const comfy = await createMockComfyUIServer();
    const ws = await createIsolatedWorkspace('t4-06-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    let mcp: Awaited<ReturnType<typeof spawnMcpStdioClient>> | undefined;
    t.after(async () => {
      await mcp?.stop().catch(() => {});
      await cp?.stop().catch(() => {});
      await comfy.close().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]', WORKBENCH_HUB_SCAN_URLS: comfy.base },
      readyTimeoutMs: 45_000,
    });

    for (const lang of ['en', 'zh-CN']) {
      const uiRes = await httpRequest(`${cp.urls.workbench}/?lang=${lang}`, {
        headers: { 'Accept-Language': lang },
        timeoutMs: 30_000,
      });
      assertStatus(uiRes, 200, `Bilingual Web Console ?lang=${lang}`);
      assert.match(uiRes.text, /VramDeck/);
      assert.doesNotMatch(uiRes.text, /Radeon AI PRO R9700/);
      assert.match(uiRes.text, /<html[^>]*\slang=["']?(?:en|zh)/i);
    }

    const cliAbs = path.join(REPO_ROOT, 'platforms', 'workbench', 'cli.mjs');
    const cliStatus = await runCommand(resolveNode22Plus(), [cliAbs, 'status'], {
      env: { ...ws.env, CONTROL_PORT: String(cp.ports.control) },
    });
    assert.equal(cliStatus.code, 0, cliStatus.stderr);

    const cliEngines = await runCommand(resolveNode22Plus(), [cliAbs, 'engine', 'list'], {
      env: { ...ws.env, WORKBENCH_PORT: String(cp.ports.workbench) },
    });
    assert.equal(cliEngines.code, 0, cliEngines.stderr);
    assert.ok(cliEngines.stdout.trim().length > 0);

    const adoptRes = await httpJson<Record<string, unknown>>(`${cp.urls.workbench}/api/hub/adopt`, {
      method: 'POST',
      body: { kind: 'comfyui', base_url: comfy.base, id: 'comfyui-t4' },
    });
    assertStatus(
      {
        status: adoptRes.status,
        headers: adoptRes.headers,
        rawBody: Buffer.alloc(0),
        text: '',
        json: adoptRes.data,
      },
      [200, 201],
      'Adopt mock ComfyUI for durable media job',
    );

    const plat = await httpJson<{
      packages: Array<{ id: string; engine: string; models: Array<{ id: string }> }>;
    }>(`${cp.urls.workbench}/api/platform`);
    assert.equal(plat.status, 200);
    const adoptedPkg = plat.data.packages.find(
      (p) => p.id === 'comfyui-t4' || p.engine.includes('comfyui'),
    );
    assert.ok(adoptedPkg && adoptedPkg.models.length > 0, 'Adopted ComfyUI must register model');
    const adoptedModelId = adoptedPkg.models[0].id;

    const keyRes = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 't4-06-mcp', maxConcurrent: 2, requestsPerMinute: 60 },
    });
    const telemetryToken = (
      JSON.parse(await readFile(path.join(ws.stateDir, 'telemetry', 'secret.json'), 'utf8')) as {
        token: string;
      }
    ).token;

    mcp = await spawnMcpStdioClient(ws, {
      env: {
        MEDIA_GATEWAY_URL: cp.urls.inference,
        MEDIA_API_KEY: keyRes.data.secret,
        MEDIA_TELEMETRY_TOKEN: telemetryToken,
        MEDIA_DOWNLOAD_ROOTS: ws.rootDir,
      },
    });

    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't4-06', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    const opened = await mcp.request<{ isError?: boolean }>('tools/call', {
      name: 'browse_media',
      arguments: { category: 'image' },
    });
    assert.notEqual(opened.isError, true);

    const submitted = await mcp.request<{
      isError?: boolean;
      structuredContent?: { job_id: string; state: string };
    }>('tools/call', {
      name: 'generate_image',
      arguments: {
        request_id: 't4-06-img-1',
        prompt: 'vramdeck durable e2e test image',
        model: adoptedModelId,
      },
    });
    assert.notEqual(submitted.isError, true);
    const jobId = submitted.structuredContent?.job_id ?? '';
    assert.ok(jobId.startsWith('job_'), 'generate_image must return job_id');

    let finalJob: { state: string; artifacts?: Array<{ artifact_id: string }> } | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const polled = await mcp.request<{
        isError?: boolean;
        structuredContent?: { state: string; artifacts?: Array<{ artifact_id: string }> };
      }>('tools/call', {
        name: 'get_job',
        arguments: { job_id: jobId, wait_seconds: 2 },
      });
      assert.notEqual(polled.isError, true);
      finalJob = polled.structuredContent;
      if (finalJob && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(finalJob.state)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(finalJob?.state, 'succeeded', `Expected succeeded job, got ${finalJob?.state}`);
    const artifactId = finalJob?.artifacts?.[0]?.artifact_id ?? '';
    assert.ok(artifactId.startsWith('artifact_'), 'Succeeded job must produce artifact_id');

    const downloadPath = path.join(ws.rootDir, 'downloaded-t4-06.png');
    const artifactRes = await mcp.request<{ isError?: boolean }>('tools/call', {
      name: 'get_artifact',
      arguments: { artifact_id: artifactId, download: true, path: downloadPath },
    });
    assert.notEqual(artifactRes.isError, true);
    assert.equal(existsSync(downloadPath), true, 'Downloaded artifact file must exist in ws');
    assert.ok((await stat(downloadPath)).size > 0, 'Downloaded artifact must be non-empty');

    const callsRes = await httpJson<{ calls?: Array<{ tool: string }> }>(
      `${cp.urls.workbench}/api/mcp/calls`,
    );
    assert.equal(callsRes.status, 200);
    assert.ok((callsRes.data.calls ?? []).some((c) => c.tool === 'browse_media'));
    assert.ok((callsRes.data.calls ?? []).some((c) => c.tool === 'generate_image'));
  });

  it('t4.07 Fresh clone installer dry-run/AST + OSS docs/CI + Prettier/cycle/TypeScript verification', async (t) => {
    const ready =
      (await hasWorkbenchDeps()) &&
      (await hasM5Installers()) &&
      (await hasM6OssLaunchDeliverables());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M5/M6 (Features #23, #24, #25, #26, #27): installers, VramDeck OSS docs & CI gates not delivered',
      )
    ) {
      return;
    }

    const ps1Path = path.join(REPO_ROOT, 'scripts', 'install.ps1');
    const shPath = path.join(REPO_ROOT, 'scripts', 'install.sh');
    const shSrc = await readFile(shPath, 'utf8');
    assert.equal(shSrc.includes('\r\n'), false);
    assert.match(shSrc, /VramDeck/);
    const ps1Src = await readFile(ps1Path, 'utf8');
    assert.match(ps1Src, /VramDeck/);

    for (const rel of [
      'README.md',
      'README.zh-CN.md',
      'CONTRIBUTING.md',
      'docs/guide/ADD_ENGINE.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
    ]) {
      const content = await readFile(path.join(REPO_ROOT, rel), 'utf8');
      assert.ok(content.trim().length > 50, `${rel} must be populated`);
      assert.doesNotMatch(content, /\/home\/aoike|\/media\/aoike/);
    }

    const ciText = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ciText, /ubuntu-latest/);
    assert.match(ciText, /macos-latest/);
    assert.match(ciText, /windows-latest/);
    assert.match(ciText, /check-project\.py\s+--suite\s+python/);
    assert.match(ciText, /check-project\.py\s+--suite\s+node/);
    assert.match(ciText, /format:check|prettier\s+--check/);
    assert.match(ciText, /cycle|circular|assertNoImportCycles/i);

    await assertNoImportCycles(path.join(REPO_ROOT, 'platforms', 'workbench', 'lib'));
    await assertNoImportCycles(E2E_ROOT);

    const nodeBin = resolveNode22Plus();
    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const tscBin = path.join(workbenchDir, 'node_modules', 'typescript', 'bin', 'tsc');
    const prettierBin = path.join(workbenchDir, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

    const wbTscRes = await withWorkbenchTsconfigLock(() =>
      runCommand(nodeBin, [tscBin, '--noEmit', '-p', path.join(workbenchDir, 'tsconfig.json')]),
    );
    assert.equal(wbTscRes.code, 0, `Workbench tsc failed:\n${wbTscRes.stdout}\n${wbTscRes.stderr}`);

    const e2eTscRes = await runCommand(nodeBin, [
      tscBin,
      '--noEmit',
      '-p',
      path.join(E2E_ROOT, 'tsconfig.json'),
    ]);
    assert.equal(e2eTscRes.code, 0, `E2E tsc failed:\n${e2eTscRes.stdout}\n${e2eTscRes.stderr}`);

    const e2eFmtRes = await runCommand(nodeBin, [prettierBin, '--check', E2E_ROOT], {
      cwd: REPO_ROOT,
      timeoutMs: 45_000,
    });
    assert.equal(e2eFmtRes.code, 0, `${e2eFmtRes.stdout}\n${e2eFmtRes.stderr}`);
  });
});
