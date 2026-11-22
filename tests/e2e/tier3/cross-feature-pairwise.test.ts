import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type {
  DeviceProvider,
  DownloadProgress,
  HardwareSnapshot,
  PoolAllocation,
  PoolStatus,
  ResourceSpec,
  RuntimeDriver,
  RuntimeDriverKind,
  RuntimeDriverSpec,
} from '../../../platforms/workbench/lib/types.ts';
import {
  assertDownloadProgress,
  assertEngineManifestV2,
  assertHardwareSnapshot,
  assertHubEngineEntry,
  assertHubModelEntry,
  assertNoImportCycles,
  assertPoolAllocation,
  assertPoolStatus,
} from '../lib/assertions.ts';
import {
  allocatePort,
  createIsolatedWorkspace,
  deliverableExists,
  E2E_ROOT,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import {
  createEngineManifestV2,
  createMockHardwareSnapshot,
  createResourceSpec,
  writeMockEnginePackage,
} from '../lib/fixtures.ts';
import { assertStatus, httpJson, httpRequest } from '../lib/http-client.ts';
import {
  createMockArtifactDownloadServer,
  createMockOllamaServer,
  createMockOpenAIServer,
} from '../lib/mock-servers.ts';
import {
  runCommand,
  spawnMcpStdioClient,
  spawnWorkbenchControlPlane,
  stripE2eNextFromTsconfig,
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

async function resolveDriver(
  entryRel: string,
  kind: RuntimeDriverKind,
  driverOpts?: Record<string, unknown>,
): Promise<RuntimeDriver> {
  const mod = (await import(pathToFileURL(path.join(REPO_ROOT, entryRel)).href)) as Record<
    string,
    unknown
  >;

  if (typeof mod.createRuntimeDriver === 'function') {
    return (
      mod.createRuntimeDriver as (
        k: RuntimeDriverKind,
        opts?: Record<string, unknown>,
      ) => RuntimeDriver
    )(kind, driverOpts);
  }
  if (typeof mod.getRuntimeDriver === 'function') {
    return (
      mod.getRuntimeDriver as (
        k: RuntimeDriverKind,
        opts?: Record<string, unknown>,
      ) => RuntimeDriver
    )(kind, driverOpts);
  }
  if (typeof mod.createDriverRegistry === 'function') {
    const reg = (
      mod.createDriverRegistry as (opts?: Record<string, unknown>) => Record<string, RuntimeDriver>
    )(driverOpts);
    if (reg[kind]) return reg[kind];
  }
  const ctorMap: Record<RuntimeDriverKind, string[]> = {
    process: ['ProcessDriver', 'ProcessRuntimeDriver'],
    docker: ['DockerDriver', 'DockerRuntimeDriver'],
    external: ['ExternalDriver', 'ExternalRuntimeDriver'],
  };
  for (const name of ctorMap[kind]) {
    if (typeof mod[name] === 'function') {
      const Ctor = mod[name] as new (opts?: Record<string, unknown>) => RuntimeDriver;
      return new Ctor(driverOpts);
    }
  }
  if (
    !driverOpts &&
    mod.drivers &&
    typeof (mod.drivers as Record<string, RuntimeDriver>)[kind] === 'object'
  ) {
    return (mod.drivers as Record<string, RuntimeDriver>)[kind];
  }
  throw new Error(`Unable to resolve ${kind} RuntimeDriver from ${entryRel}`);
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

async function hasM3DecoupledHttp(): Promise<boolean> {
  const httpRel = await findFirstExisting([
    'platforms/workbench/lib/http.ts',
    'platforms/workbench/lib/http.mjs',
  ]);
  if (!httpRel) return false;
  const httpSrc = await readFile(path.join(REPO_ROOT, httpRel), 'utf8');
  return !httpSrc.includes('qwen38-27b-w3a4-192k');
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

async function hasM4MainstreamAdapters(): Promise<boolean> {
  const hasLlama =
    (await deliverableExists('engines/llm/llama-cpp/engine.json')) ||
    (await deliverableExists('engines/llm/llama.cpp/engine.json'));
  const hasOllama = await deliverableExists('engines/llm/ollama/engine.json');
  const qwenManifest = path.join(REPO_ROOT, 'engines/llm/pation-model-qwen38-27b-w3a4/engine.json');
  const qwenRaw = existsSync(qwenManifest) ? await readFile(qwenManifest, 'utf8') : '';
  return hasLlama && hasOllama && qwenRaw.includes('rocm-pro');
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

async function hasM6DocsAndCi(): Promise<boolean> {
  if (!(await deliverableExists('README.md')) || !(await deliverableExists('README.zh-CN.md'))) {
    return false;
  }
  const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const ci = await readFile(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  return /\bVramDeck\b/.test(readme) && /format:check|prettier\s+--check/.test(ci);
}

describe('Tier 3: Cross-Feature Pairwise Combinatorial E2E Tests', () => {
  it('t3.01 FA1 x FA3: "auto" storage resolution and node.lock isolation across parallel control planes', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(t, readyDeps, 'M1 (Features #7, #11): workbench node_modules required')
    ) {
      return;
    }

    const wsA = await createIsolatedWorkspace('t3-01-a-');
    const wsB = await createIsolatedWorkspace('t3-01-b-');
    let cpA: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    let cpB: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await Promise.all([cpA?.stop().catch(() => {}), cpB?.stop().catch(() => {})]);
      await Promise.all([wsA.cleanup(), wsB.cleanup()]);
    });

    [cpA, cpB] = await Promise.all([
      spawnWorkbenchControlPlane(wsA, {
        env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
      }),
      spawnWorkbenchControlPlane(wsB, {
        env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
      }),
    ]);

    const [healthA, healthB] = await Promise.all([
      httpJson<{ status: string }>(`${cpA.urls.inference}/health`),
      httpJson<{ status: string }>(`${cpB.urls.inference}/health`),
    ]);
    assert.equal(healthA.data.status, 'ready');
    assert.equal(healthB.data.status, 'ready');

    const autoWs = await createIsolatedWorkspace('t3-01-auto-', { withArtifactsMarker: false });
    t.after(() => autoWs.cleanup());
    const storageUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms', 'workbench', 'lib', 'storage.mjs'),
    ).href;
    const probeScript = [
      `import { artifactsRoot, ensureAutoArtifacts } from ${JSON.stringify(storageUrl)};`,
      `const root = artifactsRoot();`,
      `ensureAutoArtifacts();`,
      `console.log(JSON.stringify({ root }));`,
    ].join(' ');
    const autoRes = await runCommand(
      resolveNode22Plus(),
      ['--input-type=module', '-e', probeScript],
      {
        env: {
          MEDIA_ARTIFACTS_ROOT: undefined,
          LOCALAPPDATA: autoWs.rootDir,
          XDG_DATA_HOME: autoWs.rootDir,
          HOME: autoWs.rootDir,
        },
      },
    );
    assert.equal(autoRes.code, 0, autoRes.stderr);
    const parsedAuto = JSON.parse(autoRes.stdout.trim()) as { root: string };
    assert.equal(existsSync(path.join(parsedAuto.root, '.llm-backend-artifacts')), true);

    const dupPort = await allocatePort();
    const serverRel =
      (await findFirstExisting([
        'platforms/workbench/server.ts',
        'platforms/workbench/server.mjs',
      ])) ?? 'platforms/workbench/server.mjs';
    const dupRes = await runCommand(resolveNode22Plus(), [path.join(REPO_ROOT, serverRel)], {
      cwd: path.join(REPO_ROOT, 'platforms', 'workbench'),
      env: {
        ...wsA.env,
        WORKBENCH_HEADLESS: '1',
        WORKBENCH_PORT: String(dupPort),
        INFERENCE_PORT: String(await allocatePort()),
        CONTROL_PORT: String(await allocatePort()),
        WORKBENCH_MOCK_GPUS: '[]',
      },
      timeoutMs: 10_000,
    });
    assert.notEqual(dupRes.code, 0);
    assert.match(dupRes.stderr + dupRes.stdout, /already running/i);
  });

  it('t3.02 FA1 x FA8: openImport root enforcement + MCP import_media -> /v1/media/assets with storage marker', async (t) => {
    const readyDeps = (await hasWorkbenchDeps()) && (await hasMcpSdk());
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Features #5, #7): workbench & mcp node_modules required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('t3-02-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    let mcp: Awaited<ReturnType<typeof spawnMcpStdioClient>> | undefined;
    t.after(async () => {
      await mcp?.stop().catch(() => {});
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    const allowedRoot = path.join(ws.rootDir, 'allowed-imports');
    const outsideRoot = path.join(ws.rootDir, 'outside-imports');
    await mkdir(allowedRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });

    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const allowedPng = path.join(allowedRoot, 'pixel.png');
    const outsidePng = path.join(outsideRoot, 'secret.png');
    await writeFile(allowedPng, pngBytes);
    await writeFile(outsidePng, pngBytes);

    cp = await spawnWorkbenchControlPlane(ws, {
      env: {
        WORKBENCH_HEADLESS: '1',
        WORKBENCH_MOCK_GPUS: '[]',
        MEDIA_IMPORT_ROOTS: allowedRoot,
      },
    });

    const keyRes = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 't3-02-mcp', maxConcurrent: 2, requestsPerMinute: 60 },
    });
    assert.equal(keyRes.status, 200);

    const telemetrySecretRaw = await readFile(
      path.join(ws.stateDir, 'telemetry', 'secret.json'),
      'utf8',
    );
    const telemetryToken = (JSON.parse(telemetrySecretRaw) as { token: string }).token;

    mcp = await spawnMcpStdioClient(ws, {
      env: {
        MEDIA_GATEWAY_URL: cp.urls.inference,
        MEDIA_API_KEY: keyRes.data.secret,
        MEDIA_TELEMETRY_TOKEN: telemetryToken,
        MEDIA_IMPORT_ROOTS: allowedRoot,
        MEDIA_TOOLS_WATCH_MS: '500',
      },
    });

    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't3-02', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    const browseRes = await mcp.request<{
      isError?: boolean;
      structuredContent?: { categories?: Array<{ id: string }> };
    }>('tools/call', { name: 'browse_media', arguments: { category: 'image' } });
    assert.notEqual(browseRes.isError, true);

    const imported = await mcp.request<{
      isError?: boolean;
      structuredContent?: { asset_id: string; kind: string };
    }>('tools/call', {
      name: 'import_media',
      arguments: { kind: 'image', path: allowedPng },
    });
    assert.notEqual(imported.isError, true);
    assert.ok(imported.structuredContent?.asset_id.startsWith('asset_'));

    const rejected = await mcp.request<{ isError?: boolean; content?: Array<{ text: string }> }>(
      'tools/call',
      {
        name: 'import_media',
        arguments: { kind: 'image', path: outsidePng },
      },
    );
    assert.equal(
      rejected.isError,
      true,
      'import_media outside MEDIA_IMPORT_ROOTS must be rejected',
    );
  });

  it('t3.03 FA2 x FA3: DeviceProvider 2-GPU heterogeneous snapshot -> RingTelemetry -> 60-min /data & /metrics', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const hasDevices = await deliverableExists('platforms/workbench/lib/devices/index.ts');
    const hasTelemetry = await deliverableExists('platforms/workbench/lib/telemetry.ts');
    if (
      !requireDeliverable(
        t,
        readyDeps && hasDevices && hasTelemetry,
        'M2 (Features #12, #13): devices/index.ts & telemetry.ts required',
      )
    ) {
      return;
    }

    const dual = createMockHardwareSnapshot('dual-heterogeneous-24g-12g');
    const ws = await createIsolatedWorkspace('t3-03-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: {
        WORKBENCH_HEADLESS: '1',
        WORKBENCH_MOCK_GPUS: JSON.stringify(dual.gpus),
      },
    });

    const data15 = await httpJson<{
      gpus: unknown[];
      values: Record<string, number | null>;
      trends: Record<string, unknown>;
    }>(`${cp.urls.inference}/data?minutes=15&window=5`);
    assert.equal(data15.status, 200);
    assert.equal(data15.data.gpus.length, 2);
    assert.equal(data15.data.values.vram_total, (24576 + 12288) * 1048576);
    assert.ok(data15.data.trends.vram);

    const data60 = await httpJson<{
      minutes: number;
      trends: Record<string, Array<[number, number | null]>>;
    }>(`${cp.urls.inference}/data?minutes=60&window=60`);
    assert.equal(data60.status, 200);
    assert.equal(data60.data.minutes, 60);
    assert.equal(data60.data.trends.vram.length, 60 * 12 + 1);

    const metricsRes = await httpRequest(`${cp.urls.inference}/metrics`);
    assertStatus(metricsRes, 200, 'GET /metrics');
    assert.match(metricsRes.text, /lab_gpu_devices\s+2/);
    assert.match(metricsRes.text, /lab_gpu_vram_total_bytes\{[^}]*vendor="nvidia"/);
    assert.match(metricsRes.text, /lab_gpu_vram_total_bytes\{[^}]*vendor="amd"/);
  });

  it('t3.04 FA2 x FA6: DeviceProvider 2-GPU snapshot x Node CLI devices --json (online vs offline)', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const hasCli = await deliverableExists('platforms/workbench/cli.ts');
    if (
      !requireDeliverable(
        t,
        readyDeps && hasCli,
        'M2 (Features #12, #17): cli.ts & devices/index.ts required',
      )
    ) {
      return;
    }

    const dual = createMockHardwareSnapshot('dual-heterogeneous-24g-12g');
    const ws = await createIsolatedWorkspace('t3-04-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: {
        WORKBENCH_HEADLESS: '1',
        WORKBENCH_MOCK_GPUS: JSON.stringify(dual.gpus),
      },
    });

    const nodeBin = resolveNode22Plus();
    const cliAbs = path.join(REPO_ROOT, 'platforms', 'workbench', 'cli.mjs');

    const onlineRes = await runCommand(nodeBin, [cliAbs, 'devices', '--json'], {
      env: {
        ...ws.env,
        INFERENCE_PORT: String(cp.ports.inference),
        WORKBENCH_PORT: String(cp.ports.workbench),
        CONTROL_PORT: String(cp.ports.control),
      },
    });
    assert.equal(onlineRes.code, 0, onlineRes.stderr);
    const onlineSnap = JSON.parse(onlineRes.stdout) as HardwareSnapshot;
    assertHardwareSnapshot(onlineSnap);
    assert.equal(onlineSnap.gpus.length, 2);

    const offlinePort = await allocatePort();
    const offlineRes = await runCommand(nodeBin, [cliAbs, 'devices', '--json'], {
      env: {
        ...ws.env,
        INFERENCE_PORT: String(offlinePort),
        WORKBENCH_MOCK_GPUS: JSON.stringify(dual.gpus),
      },
    });
    assert.equal(offlineRes.code, 0, offlineRes.stderr);
    const offlineSnap = JSON.parse(offlineRes.stdout) as HardwareSnapshot;
    assertHardwareSnapshot(offlineSnap);
    assert.equal(offlineSnap.gpus.length, 2);
    assert.equal(offlineSnap.gpus[0].vendor, onlineSnap.gpus[0].vendor);
    assert.equal(offlineSnap.gpus[1].vram_total_mb, onlineSnap.gpus[1].vram_total_mb);
  });

  it('t3.05 FA3 x FA6: Process lock + graceful shutdown + CLI stop lease refusal & release', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const hasCli = await deliverableExists('platforms/workbench/cli.ts');
    if (
      !requireDeliverable(
        t,
        readyDeps && hasCli,
        'M2 (Features #3, #11, #17): cli.ts & server.mjs required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('t3-05-');
    const workbenchPort = await allocatePort();
    const inferencePort = await allocatePort();
    const controlPort = await allocatePort();
    const nextDist = `.next-e2e-t305-${process.pid}-${Date.now()}`;
    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const tsconfigPath = path.join(workbenchDir, 'tsconfig.json');
    const cliAbs = path.join(workbenchDir, 'cli.mjs');
    const nodeBin = resolveNode22Plus();

    const baseEnv = {
      ...ws.env,
      WORKBENCH_PORT: String(workbenchPort),
      INFERENCE_PORT: String(inferencePort),
      CONTROL_PORT: String(controlPort),
      WORKBENCH_NEXT_DIST: nextDist,
      WORKBENCH_MOCK_GPUS: '[]',
      NODE_ENV: 'production',
    };

    let proxy: http.Server | undefined;
    t.after(async () => {
      if (proxy) {
        await new Promise<void>((resolve) => {
          proxy!.closeAllConnections();
          proxy!.close(() => resolve());
        });
      }
      await runCommand(nodeBin, [cliAbs, 'stop'], { env: baseEnv, timeoutMs: 8_000 }).catch(
        () => {},
      );
      await rm(path.join(workbenchDir, nextDist), { recursive: true, force: true }).catch(() => {});
      await withWorkbenchTsconfigLock(() => stripE2eNextFromTsconfig(tsconfigPath)).catch(() => {});
      await ws.cleanup();
    });

    const startRes = await runCommand(nodeBin, [cliAbs, 'start', '--headless'], {
      env: baseEnv,
      timeoutMs: 30_000,
    });
    assert.equal(startRes.code, 0, `${startRes.stdout}\n${startRes.stderr}`);

    let fakeLeaseActive = true;
    proxy = http.createServer((req, res) => {
      if (req.url?.startsWith('/status') && fakeLeaseActive) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ leased: true, switching: false, queued: 0 }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const fwd = http.request(
          {
            hostname: '127.0.0.1',
            port: controlPort,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (upstream) => {
            res.writeHead(upstream.statusCode ?? 500, upstream.headers);
            upstream.pipe(res);
          },
        );
        fwd.on('error', () => {
          res.writeHead(502);
          res.end();
        });
        fwd.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((resolve) => proxy!.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;

    const refusedStop = await runCommand(nodeBin, [cliAbs, 'stop'], {
      env: { ...baseEnv, CONTROL_PORT: String(proxyPort) },
      timeoutMs: 8_000,
    });
    assert.notEqual(refusedStop.code, 0, 'cli stop must refuse while lease is active');
    assert.match(refusedStop.stderr + refusedStop.stdout, /Active\/queued work/i);

    const stillHealthy = await httpJson<{ status: string }>(
      `http://127.0.0.1:${inferencePort}/health`,
    );
    assert.equal(stillHealthy.status, 200);

    fakeLeaseActive = false;
    const allowedStop = await runCommand(nodeBin, [cliAbs, 'stop'], {
      env: { ...baseEnv, CONTROL_PORT: String(proxyPort) },
      timeoutMs: 15_000,
    });
    assert.equal(allowedStop.code, 0, `${allowedStop.stdout}\n${allowedStop.stderr}`);

    const lockProbe = await runCommand(nodeBin, [cliAbs, 'start', '--headless'], {
      env: baseEnv,
      timeoutMs: 30_000,
    });
    assert.equal(lockProbe.code, 0, 'node.lock must be freed so immediate restart succeeds');
    await runCommand(nodeBin, [cliAbs, 'stop'], { env: baseEnv, timeoutMs: 15_000 });
  });

  it('t3.06 FA3 x FA8: AccessKeys/CORS/Origin + Durable Jobs + Artifacts Range + MCP browse_media', async (t) => {
    const readyDeps = (await hasWorkbenchDeps()) && (await hasMcpSdk());
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Features #11, #20): workbench & mcp node_modules required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('t3-06-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    let mcp: Awaited<ReturnType<typeof spawnMcpStdioClient>> | undefined;
    t.after(async () => {
      await mcp?.stop().catch(() => {});
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
    });

    const k1 = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 't3-06-k1', maxConcurrent: 2, requestsPerMinute: 60 },
    });
    const k2 = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 't3-06-k2', maxConcurrent: 2, requestsPerMinute: 60 },
    });

    const originBlocked = await httpRequest(`${cp.urls.inference}/v1/media/jobs`, {
      headers: { Origin: 'http://127.0.0.1:13000', Authorization: `Bearer ${k1.data.secret}` },
    });
    assertStatus(originBlocked, 403, '/v1/media/jobs rejects browser Origin');

    const audioNoAuth = await httpRequest(`${cp.urls.inference}/v1/audio/speech`, {
      method: 'POST',
      body: { text: 'hello' },
    });
    assertStatus(audioNoAuth, 401, '/v1/audio/speech requires API key');

    const publicBlocked = await httpRequest(`${cp.urls.inference}/v1/media/jobs`, {
      headers: { 'X-Workbench-Public': '1', Authorization: `Bearer ${k1.data.secret}` },
    });
    assertStatus(publicBlocked, 404, '/v1/media/jobs refuses X-Workbench-Public');

    const createdJob = await httpJson<{ job_id: string; state: string }>(
      `${cp.urls.inference}/v1/media/jobs`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${k1.data.secret}` },
        body: {
          tool: 'generate_image',
          arguments: { request_id: 't3-06-req-1', prompt: 'minimal test prompt' },
        },
      },
    );
    assert.equal(createdJob.status, 202);
    assert.ok(createdJob.data.job_id.startsWith('job_'));

    const crossKeyRead = await httpRequest(
      `${cp.urls.inference}/v1/media/jobs/${createdJob.data.job_id}`,
      { headers: { Authorization: `Bearer ${k2.data.secret}` } },
    );
    assertStatus(crossKeyRead, 404, 'K2 cannot read K1 durable media job');

    await httpRequest(`${cp.urls.inference}/v1/media/jobs/${createdJob.data.job_id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k1.data.secret}` },
    });

    const rangeMissing = await httpRequest(
      `${cp.urls.inference}/v1/media/artifacts/artifact_00000000000000000000000000000000/content`,
      {
        headers: {
          Authorization: `Bearer ${k1.data.secret}`,
          Range: 'bytes=0-15',
        },
      },
    );
    assertStatus(rangeMissing, 404, 'Missing artifact Range request returns 404');

    const telemetrySecretRaw = await readFile(
      path.join(ws.stateDir, 'telemetry', 'secret.json'),
      'utf8',
    );
    const telemetryToken = (JSON.parse(telemetrySecretRaw) as { token: string }).token;

    mcp = await spawnMcpStdioClient(ws, {
      env: {
        MEDIA_GATEWAY_URL: cp.urls.inference,
        MEDIA_API_KEY: k1.data.secret,
        MEDIA_TELEMETRY_TOKEN: telemetryToken,
      },
    });

    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't3-06', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    const initialTools = await mcp.request<{ tools: Array<{ name: string }> }>('tools/list', {});
    assert.deepEqual(
      initialTools.tools.map((tool) => tool.name),
      ['browse_media'],
    );
    await mcp.request('tools/call', { name: 'browse_media', arguments: { category: 'image' } });
    const expanded = await mcp.request<{ tools: Array<{ name: string }> }>('tools/list', {});
    assert.ok(expanded.tools.some((tool) => tool.name === 'generate_image'));
  });

  it('t3.07 FA2 x FA4: DeviceProvider 24G+12G heterogeneous pool x GpuPoolCoordinator coexistence & eviction', async (t) => {
    const ready = await hasM3PoolAndDrivers();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3 (Features #14, #16): pool-coordinator & drivers not delivered',
      )
    ) {
      return;
    }

    const poolRel = await findFirstExisting([
      'platforms/workbench/lib/scheduler/pool-coordinator.ts',
      'platforms/workbench/lib/scheduler/pool-coordinator.mjs',
    ]);
    const snap = createMockHardwareSnapshot('dual-heterogeneous-24g-12g');
    const evictions: string[] = [];

    const pool = await createPoolInstance(
      poolRel!,
      snap,
      {
        'small-a': createResourceSpec({
          backends: ['cuda', 'vulkan'],
          vram_mb: 4096,
          vram_mode: 'shared',
          concurrency: 2,
        }),
        'small-b': createResourceSpec({
          backends: ['cuda', 'vulkan'],
          vram_mb: 8192,
          vram_mode: 'shared',
          concurrency: 2,
        }),
        'heavy-c': createResourceSpec({
          backends: ['cuda'],
          vram_mb: 20480,
          vram_mode: 'exclusive',
          concurrency: 1,
        }),
      },
      {
        onStop(engine) {
          evictions.push(engine);
        },
      },
    );

    const a = await pool.acquire('small-a', { timeout: 2 });
    const b = await pool.acquire('small-b', { timeout: 2 });
    const statusDuring = pool.status();
    assertPoolStatus(statusDuring);
    assert.equal(statusDuring.allocations.length, 2, 'Shared models must coexist');
    assert.equal(evictions.length, 0, 'Coexisting shared models must not trigger eviction');

    await a.release();
    await b.release();

    const heavy = await pool.acquire('heavy-c', { timeout: 2 });
    assert.deepEqual(heavy.gpu_ids, ['gpu-0'], '20GB CUDA workload must place on 24GB gpu-0');
    const statusHeavy = pool.status();
    assertPoolStatus(statusHeavy);
    await heavy.release();
  });

  it('t3.08 FA4 x FA5: GpuPoolCoordinator atomic TP multi-GPU (gpu_count=2) x RuntimeDriver process env injection', async (t) => {
    const ready = await hasM3PoolAndDrivers();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3 (Features #14, #16): pool-coordinator & drivers not delivered',
      )
    ) {
      return;
    }

    const poolRel = await findFirstExisting([
      'platforms/workbench/lib/scheduler/pool-coordinator.ts',
      'platforms/workbench/lib/scheduler/pool-coordinator.mjs',
    ]);
    const drvRel = await findFirstExisting([
      'platforms/workbench/lib/drivers/index.ts',
      'platforms/workbench/lib/drivers/index.mjs',
    ]);
    const snap = createMockHardwareSnapshot('quad-24g');

    const ws = await createIsolatedWorkspace('t3-08-');
    const drv = await resolveDriver(drvRel!, 'process');
    let lease: PoolAcquireResult | undefined;
    let handle: Awaited<ReturnType<RuntimeDriver['start']>> | undefined;
    t.after(async () => {
      if (handle) await drv.stop(handle).catch(() => {});
      await lease?.release().catch(() => {});
      await ws.cleanup();
    });

    const pool = await createPoolInstance(poolRel!, snap, {
      'tp-llm': createResourceSpec({
        backends: ['cuda'],
        gpu_count: 2,
        vram_mb: 16384,
        vram_mode: 'exclusive',
        concurrency: 1,
      }),
    });

    lease = await pool.acquire('tp-llm', { timeout: 2 });
    assert.equal(lease.gpu_ids.length, 2, 'TP allocation must reserve 2 GPUs');
    assert.equal(new Set(lease.gpu_ids).size, 2, 'TP allocation must span 2 distinct GPUs');

    const envOutFile = path.join(ws.rootDir, 'child-env.json');
    const nodeBin = resolveNode22Plus();
    const spec: RuntimeDriverSpec = {
      id: 'tp-rt',
      name: 'tp',
      driver: 'process',
      port: await allocatePort(),
      command: nodeBin,
      args: [
        '-e',
        `import('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(envOutFile)}, JSON.stringify(process.env)); setInterval(() => {}, 1000); });`,
      ],
    };

    handle = await drv.start(spec, { gpu_ids: lease.gpu_ids });
    const deadline = Date.now() + 5_000;
    while (!existsSync(envOutFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(existsSync(envOutFile), true, 'Child process must write envOutFile');
    assert.equal(await drv.isRunning(spec), true, 'Process driver must report running');

    await drv.stop(handle);
    handle = undefined;
    assert.equal(await drv.isRunning(spec), false, 'Process driver must report stopped');

    const childEnv = JSON.parse(await readFile(envOutFile, 'utf8')) as Record<string, string>;
    const visibleDevices =
      childEnv.CUDA_VISIBLE_DEVICES ??
      childEnv.HIP_VISIBLE_DEVICES ??
      childEnv.ROCR_VISIBLE_DEVICES ??
      '';
    assert.ok(
      visibleDevices.length > 0,
      'RuntimeDriver must inject CUDA/HIP/ROCR_VISIBLE_DEVICES into child process env',
    );
    const assignedTokens = visibleDevices
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    assert.equal(
      assignedTokens.length,
      2,
      `Expected 2 allocated GPUs in visible devices env, got: ${visibleDevices}`,
    );

    await lease.release();
    lease = undefined;
    assertPoolStatus(pool.status());
  });

  it('t3.09 FA4 x FA3: GpuPoolCoordinator single-GPU exclusive mode x EngineScheduling anti-starvation & /status', async (t) => {
    const ready = (await hasM3PoolAndDrivers()) && (await hasM3DecoupledHttp());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3 (Features #14, #15): single-GPU exclusive coordinator & decoupled core/http required',
      )
    ) {
      return;
    }

    const poolRel = await findFirstExisting([
      'platforms/workbench/lib/scheduler/pool-coordinator.ts',
      'platforms/workbench/lib/scheduler/pool-coordinator.mjs',
    ]);
    const snap = createMockHardwareSnapshot('single-gpu-24g');

    let fakeNow = 0;
    const pool = await createPoolInstance(
      poolRel!,
      snap,
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
        engineScheduling: {
          minBatchRequests: 2,
          maxBatchRequests: 4,
          maxBatchSeconds: 120,
          maxWaitSeconds: 300,
        },
      },
    );

    const hold = await pool.acquire('llm', { timeout: 3, enqueuedAt: 0 });
    const grantedOrder: string[] = [];
    fakeNow = 1;
    const agedAnima = pool.acquire('anima', { timeout: 4, enqueuedAt: 1 }).then(async (l) => {
      grantedOrder.push('anima');
      await l.release();
    });
    const freshLlm = pool.acquire('llm', { timeout: 4, enqueuedAt: 350 }).then(async (l) => {
      grantedOrder.push('llm');
      await l.release();
    });
    const freshTts = pool.acquire('tts', { timeout: 4, enqueuedAt: 351 }).then(async (l) => {
      grantedOrder.push('tts');
      await l.release();
    });
    fakeNow = 400;
    await new Promise((r) => setTimeout(r, 20));
    await hold.release();
    await Promise.all([agedAnima, freshLlm, freshTts]);
    assert.equal(
      grantedOrder[0],
      'anima',
      `Anti-starvation must prioritize >300s aged anima ahead of newer requests, got: ${grantedOrder.join(', ')}`,
    );

    const ws = await createIsolatedWorkspace('t3-09-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: JSON.stringify(snap.gpus) },
    });

    const status = await httpJson<Record<string, unknown>>(`${cp.urls.control}/status?full=1`);
    assert.equal(status.status, 200);
    assert.ok('engine_scheduling' in status.data);
    assert.ok('leased' in status.data);
    assert.ok('queued' in status.data);
    assert.ok('switching' in status.data);
  });

  it('t3.10 FA5 x FA8: EngineManifestV2 external driver + platform.surface x POST /api/platform/engines/:id -> MCP tools/list_changed', async (t) => {
    const ready =
      (await hasM3PoolAndDrivers()) && (await hasM3DecoupledHttp()) && (await hasMcpSdk());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3 (Features #15, #16): EngineManifestV2 external driver & decoupled registry required',
      )
    ) {
      return;
    }

    const openai = await createMockOpenAIServer();
    const ws = await createIsolatedWorkspace('t3-10-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    let mcp: Awaited<ReturnType<typeof spawnMcpStdioClient>> | undefined;
    t.after(async () => {
      await mcp?.stop().catch(() => {});
      await cp?.stop().catch(() => {});
      await openai.close().catch(() => {});
      await ws.cleanup();
    });

    const mockEnginesDir = path.join(ws.rootDir, 'engines');
    const manifest = createEngineManifestV2({
      name: 'mock-ext-image',
      category: 'image',
      engine: 'mock-ext-image',
      default_enabled: false,
      runtime: {
        driver: 'external',
        base_url: openai.base,
        port: openai.port,
      },
      models: [{ id: 'mock-ext-img-1', capabilities: ['image.stylize'], priority: 10 }],
      surface: {
        'image.stylize': {
          group: 'stylize_image',
          kind: 'image',
          label: 'Stylize Image',
          description: 'Mock external stylize image',
          order: 35,
          base: {
            request_id: { $use: 'request_id' },
            prompt: { $use: 'prompt' },
          },
          required: ['request_id', 'prompt'],
          example: { request_id: 'req-1', prompt: 'ink' },
          group_info: {
            label: 'Stylize Image',
            summary: 'Stylize',
            description: 'Stylize',
          },
          category: { id: 'image', label: 'Image', summary: 'Image tools' },
          sync: '/v1/images/stylize',
          sync_via: 'job',
          sync_public: true,
        },
      },
    });
    assertEngineManifestV2(manifest);
    await writeMockEnginePackage(mockEnginesDir, manifest);

    const regRel =
      (await findFirstExisting([
        'platforms/workbench/lib/registry.ts',
        'platforms/workbench/lib/registry.mjs',
      ])) ?? 'platforms/workbench/lib/registry.mjs';
    const { Registry } = (await import(pathToFileURL(path.join(REPO_ROOT, regRel)).href)) as {
      Registry: new (opts: { enginesDir: string; statePath: string; publish: boolean }) => {
        surface: Record<string, unknown>;
        setEnabled: (id: string, enabled: boolean) => Promise<unknown>;
        engines: () => Record<string, unknown>;
      };
    };
    const isolatedReg = new Registry({
      enginesDir: mockEnginesDir,
      statePath: path.join(ws.configDir, 't3-10-reg.json'),
      publish: false,
    });
    assert.ok(Object.hasOwn(isolatedReg.surface, 'image.stylize'));
    await isolatedReg.setEnabled('mock-ext-image', true);
    assert.ok(Object.hasOwn(isolatedReg.engines(), 'mock-ext-image'));

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
    });

    const keyRes = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 't3-10-mcp', maxConcurrent: 2, requestsPerMinute: 60 },
    });
    assert.equal(keyRes.status, 200);

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
        MEDIA_TOOLS_WATCH_MS: '150',
      },
    });

    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't3-10', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    const enableRes = await httpJson(`${cp.urls.workbench}/api/platform/engines/bs-roformer`, {
      method: 'POST',
      body: { enabled: true },
    });
    assert.equal(enableRes.status, 200, 'POST /api/platform/engines/bs-roformer enable failed');

    await mcp.request('tools/call', {
      name: 'browse_media',
      arguments: { category: 'audio' },
    });
    const toolsBeforeDisable = await mcp.request<{ tools: Array<{ name: string }> }>(
      'tools/list',
      {},
    );
    assert.ok(
      toolsBeforeDisable.tools.some((tool) => tool.name === 'process_audio'),
      'Enabling bs-roformer and opening audio category must expose process_audio',
    );

    const beforeCount = mcp.notifications.filter(
      (n) => n.method === 'notifications/tools/list_changed',
    ).length;

    const disableRes = await httpJson(`${cp.urls.workbench}/api/platform/engines/bs-roformer`, {
      method: 'POST',
      body: { enabled: false },
    });
    assert.equal(disableRes.status, 200, 'POST /api/platform/engines/bs-roformer disable failed');

    const deadline = Date.now() + 5_000;
    while (
      mcp.notifications.filter((n) => n.method === 'notifications/tools/list_changed').length <=
        beforeCount &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      mcp.notifications.filter((n) => n.method === 'notifications/tools/list_changed').length >
        beforeCount,
      'Toggling engine via POST /api/platform/engines/:id must trigger MCP notifications/tools/list_changed',
    );

    const toolsAfterDisable = await mcp.request<{ tools: Array<{ name: string }> }>(
      'tools/list',
      {},
    );
    assert.equal(
      toolsAfterDisable.tools.some((tool) => tool.name === 'process_audio'),
      false,
      'Disabling bs-roformer must remove process_audio from MCP tools/list',
    );
  });

  it('t3.11 FA5 x FA7: Hub Scan detects live mock Ollama -> external driver adoption -> /v1/chat/completions', async (t) => {
    const ready = (await hasM3PoolAndDrivers()) && (await hasM4HubDeliverables());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M3/M4 (Features #16, #18): Hub scanner & external RuntimeDriver not delivered',
      )
    ) {
      return;
    }

    const ollama = await createMockOllamaServer({
      models: [{ name: 'qwen2.5:7b' }],
      responseText: 'adopted-ollama-reply',
    });
    const ws = await createIsolatedWorkspace('t3-11-');
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

    const scanRes = await httpJson<Record<string, unknown>>(`${cp.urls.workbench}/api/hub/scan`, {
      method: 'POST',
      body: { urls: [ollama.base] },
    });
    assert.equal(scanRes.status, 200);

    const adoptRes = await httpJson<Record<string, unknown>>(`${cp.urls.workbench}/api/hub/adopt`, {
      method: 'POST',
      body: { kind: 'ollama', base_url: ollama.base, id: 'ollama-adopted' },
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
      'Adopt scanned Ollama',
    );

    const chatRes = await httpJson<{ choices?: Array<{ message?: { content?: string } }> }>(
      `${cp.urls.inference}/v1/chat/completions`,
      {
        method: 'POST',
        body: { model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'ping' }] },
      },
    );
    assert.equal(chatRes.status, 200);
    assert.ok(ollama.requests.length > 0, 'Mock Ollama must receive forwarded chat completion');
  });

  it('t3.12 FA1 x FA7: Hub downloader Range 206 resume & SHA256 quarantine x isolated storage', async (t) => {
    const ready = await hasM4HubDeliverables();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M4 (Feature #19): lib/hub/downloader & /api/hub/models/pull not delivered',
      )
    ) {
      return;
    }

    const payload = Buffer.alloc(4096, 0x41);
    const dlServer = await createMockArtifactDownloadServer({
      files: { '/model.gguf': payload },
      dropAfterBytes: 512,
      dropCount: 1,
    });
    const ws = await createIsolatedWorkspace('t3-12-');
    t.after(async () => {
      await dlServer.close().catch(() => {});
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
    assert.equal(
      typeof downloadFn,
      'function',
      'downloader module must export downloadWithResume/downloadArtifact/downloadFile/download',
    );

    const expectedSha = dlServer.digests['/model.gguf'].sha256;
    const okTarget = path.join(ws.artifactsDir, 'ok.gguf');
    const badTarget = path.join(ws.artifactsDir, 'bad.gguf');

    const progress = await downloadFn({
      url: `${dlServer.base}/model.gguf`,
      destination: okTarget,
      dest: okTarget,
      target: 'ok.gguf',
      sha256: expectedSha,
      retries: 3,
    });
    assertDownloadProgress(progress);
    assert.equal(progress.status, 'completed');
    assert.equal(existsSync(okTarget), true);

    dlServer.setMode({ corruptByteIndex: 10, dropAfterBytes: null });
    await assert.rejects(() =>
      downloadFn({
        url: `${dlServer.base}/model.gguf`,
        destination: badTarget,
        dest: badTarget,
        target: 'bad.gguf',
        sha256: expectedSha,
        retries: 1,
      }),
    );
    assert.equal(existsSync(badTarget), false, 'Corrupted target must not remain at final path');
  });

  it('t3.13 FA2 x FA7: DeviceProvider 8G vs 24G VRAM detection x Hub catalog quant recommendations', async (t) => {
    const ready = await hasM4HubDeliverables();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M4 (Feature #19): lib/hub/catalog & /api/hub/* not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('t3-13-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    const gpu8g = createMockHardwareSnapshot('single-gpu-24g').gpus.map((g) => ({
      ...g,
      vram_total_mb: 8192,
      vram_free_mb: 7680,
    }));
    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: JSON.stringify(gpu8g) },
    });

    const catRes = await httpJson<{ engines?: unknown[]; models?: unknown[] }>(
      `${cp.urls.workbench}/api/hub/catalog`,
    );
    assert.equal(catRes.status, 200);
    for (const eng of catRes.data.engines ?? []) assertHubEngineEntry(eng);
    for (const mod of catRes.data.models ?? []) assertHubModelEntry(mod);
  });

  it('t3.14 FA7 x FA8: ROCm Pro Pack + mainstream adapters + /api/platform/routing/:cap coexistence', async (t) => {
    const ready = await hasM4MainstreamAdapters();
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M4 (Features #20, #21): mainstream adapters & ROCm Pro Pack grouping not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('t3-14-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
    });

    const plat = await httpJson<{ packages: Array<{ id: string }> }>(
      `${cp.urls.workbench}/api/platform`,
    );
    assert.equal(plat.status, 200);
    assert.ok(plat.data.packages.some((p) => p.id.includes('llama') || p.id.includes('ollama')));
    assert.ok(plat.data.packages.some((p) => p.id === 'pation-model-qwen38-27b-w3a4'));

    const routeRes = await httpJson(`${cp.urls.workbench}/api/platform/routing/image.generate`, {
      method: 'POST',
      body: { primary: 'anima', fallbacks: ['qwen-image'], fallback_on_backend_error: true },
    });
    assert.equal(routeRes.status, 200);
  });

  it('t3.15 FA6 x FA9: Node CLI start (UI enabled) x bilingual EN/中文 Web Console, Topology & Hub UI', async (t) => {
    const ready = (await hasWorkbenchDeps()) && (await hasM5UiDeliverables());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M5 (Feature #22): Bilingual VramDeck Web Console + Topology + Hub UI not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('t3-15-');
    const [workbenchPort, inferencePort, controlPort] = await Promise.all([
      allocatePort(),
      allocatePort(),
      allocatePort(),
    ]);
    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const nextDist = `.next-e2e-t315-${process.pid}-${Date.now()}`;
    const tsconfigPath = path.join(workbenchDir, 'tsconfig.json');
    const cliAbs = path.join(workbenchDir, 'cli.mjs');
    const nodeBin = resolveNode22Plus();
    let tsconfigBefore: string | null = null;

    const cliEnv = {
      ...ws.env,
      NODE_ENV: 'development',
      WORKBENCH_PORT: String(workbenchPort),
      INFERENCE_PORT: String(inferencePort),
      CONTROL_PORT: String(controlPort),
      WORKBENCH_NEXT_DIST: nextDist,
      WORKBENCH_MOCK_GPUS: JSON.stringify(
        createMockHardwareSnapshot('dual-heterogeneous-24g-12g').gpus,
      ),
    };

    t.after(async () => {
      await runCommand(nodeBin, [cliAbs, 'stop'], { env: cliEnv, timeoutMs: 10_000 }).catch(
        () => {},
      );
      await rm(path.join(workbenchDir, nextDist), { recursive: true, force: true }).catch(() => {});
      await withWorkbenchTsconfigLock(() =>
        stripE2eNextFromTsconfig(tsconfigPath, tsconfigBefore),
      ).catch(() => {});
      await ws.cleanup();
    });

    const startRes = await withWorkbenchTsconfigLock(async () => {
      tsconfigBefore = await readFile(tsconfigPath, 'utf8').catch(() => null);
      const res = await runCommand(nodeBin, [cliAbs, 'start'], {
        env: cliEnv,
        timeoutMs: 45_000,
      });
      await stripE2eNextFromTsconfig(tsconfigPath, tsconfigBefore);
      return res;
    });
    assert.equal(startRes.code, 0, `cli.mjs start failed:\n${startRes.stdout}\n${startRes.stderr}`);

    const statusRes = await runCommand(nodeBin, [cliAbs, 'status'], {
      env: cliEnv,
      timeoutMs: 10_000,
    });
    assert.equal(statusRes.code, 0, statusRes.stderr);

    const uiBase = `http://127.0.0.1:${workbenchPort}`;
    const infBase = `http://127.0.0.1:${inferencePort}`;

    for (const lang of ['en', 'zh-CN']) {
      const uiRes = await httpRequest(`${uiBase}/?lang=${lang}`, {
        headers: { 'Accept-Language': lang },
        timeoutMs: 30_000,
      });
      assertStatus(uiRes, 200, `GET /?lang=${lang}`);
      assert.match(uiRes.text, /VramDeck/);
      assert.doesNotMatch(uiRes.text, /AI Workbench/);
      assert.match(uiRes.text, /<html[^>]*\slang=["']?(?:en|zh)/i);
    }

    const dataRes = await httpJson<{ gpus: unknown[]; runtime_topology?: { label?: string } }>(
      `${infBase}/data?minutes=15&window=30`,
    );
    assert.equal(dataRes.status, 200);
    assert.equal(dataRes.data.gpus.length, 2);
    assert.doesNotMatch(dataRes.data.runtime_topology?.label ?? '', /单卡按需切换/);

    const hubRes = await httpRequest(`${uiBase}/api/hub/catalog`);
    assertStatus(hubRes, 200, 'GET /api/hub/catalog via CLI-started server');

    const appEntries = await readdir(path.join(REPO_ROOT, 'platforms', 'workbench', 'app'));
    for (const file of appEntries) {
      if (!/\.(?:jsx?|tsx?)$/.test(file)) continue;
      const src = await readFile(
        path.join(REPO_ROOT, 'platforms', 'workbench', 'app', file),
        'utf8',
      );
      assert.doesNotMatch(src, /Radeon AI PRO R9700|Radeon R9700/);
      assert.doesNotMatch(src, /单卡按需切换/);
    }
  });

  it('t3.16 FA9 x FA10: OS Installers + Single-Process Headless Startup + CI/Docs + Zero-Cycle & Prettier', async (t) => {
    const ready =
      (await hasWorkbenchDeps()) && (await hasM5Installers()) && (await hasM6DocsAndCi());
    if (
      !requireDeliverable(
        t,
        ready,
        'Pending M5/M6 (Features #23, #24, #27): scripts/install.*, VramDeck READMEs & CI gates not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('t3-16-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
    });

    const health = await httpJson<{ status: string }>(`${cp.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');

    const shSrc = await readFile(path.join(REPO_ROOT, 'scripts', 'install.sh'), 'utf8');
    assert.equal(shSrc.includes('\r\n'), false);
    assert.match(shSrc, /VramDeck/);

    const ps1Src = await readFile(path.join(REPO_ROOT, 'scripts', 'install.ps1'), 'utf8');
    assert.match(ps1Src, /VramDeck/);

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

    const e2eFmtRes = await runCommand(nodeBin, [prettierBin, '--check', E2E_ROOT], {
      cwd: REPO_ROOT,
      timeoutMs: 45_000,
    });
    assert.equal(e2eFmtRes.code, 0, `${e2eFmtRes.stdout}\n${e2eFmtRes.stderr}`);
  });
});
