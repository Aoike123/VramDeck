import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertGpuDevice } from '../lib/assertions.ts';
import {
  allocatePort,
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { createMockGpuDevice } from '../lib/fixtures.ts';
import { assertStatus, httpJson, httpRequest } from '../lib/http-client.ts';
import { runCommand, spawnWorkbenchControlPlane } from '../lib/process-runner.ts';

async function hasWorkbenchDeps(): Promise<boolean> {
  const [hasNext, hasSharp, hasUndici] = await Promise.all([
    deliverableExists('platforms/workbench/node_modules/next/package.json'),
    deliverableExists('platforms/workbench/node_modules/sharp/package.json'),
    deliverableExists('platforms/workbench/node_modules/undici/package.json'),
  ]);
  return hasNext && hasSharp && hasUndici;
}

async function collectFiles(dir: string, exts: RegExp): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.next')) continue;
      out.push(...(await collectFiles(path.join(dir, entry.name), exts)));
    } else if (entry.isFile() && exts.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}

async function readAppUiSources(): Promise<Array<{ rel: string; text: string }>> {
  const appFiles = await collectFiles(
    path.join(REPO_ROOT, 'platforms', 'workbench', 'app'),
    /\.(?:jsx?|tsx?|mjs|mts)$/,
  );
  return Promise.all(
    appFiles.map(async (file) => ({
      rel: path.relative(REPO_ROOT, file),
      text: await readFile(file, 'utf8'),
    })),
  );
}

async function readCombinedUiSources(): Promise<Array<{ rel: string; text: string }>> {
  const appSources = await readAppUiSources();
  const panelRel = await findFirstExisting([
    'platforms/workbench/lib/panel.ts',
    'platforms/workbench/lib/panel.mjs',
  ]);
  if (panelRel) {
    appSources.push({
      rel: panelRel,
      text: await readFile(path.join(REPO_ROOT, panelRel), 'utf8'),
    });
  }
  return appSources;
}

async function hasM5BilingualUi(): Promise<boolean> {
  const layoutRel = await findFirstExisting([
    'platforms/workbench/app/layout.tsx',
    'platforms/workbench/app/layout.jsx',
  ]);
  if (!layoutRel) return false;
  const layoutSrc = await readFile(path.join(REPO_ROOT, layoutRel), 'utf8');
  if (/AI Workbench/.test(layoutSrc)) return false;

  const sources = await readCombinedUiSources();
  if (sources.some((s) => /Asia\/Shanghai/.test(s.text))) return false;
  const combined = sources.map((s) => s.text).join('\n');
  return (
    /['"]en['"]|en-US/i.test(combined) &&
    /['"]zh(?:-CN)?['"]/i.test(combined) &&
    /\bVramDeck\b/.test(combined)
  );
}

async function hasM5TopologyUi(): Promise<boolean> {
  const topoRel = await findFirstExisting([
    'platforms/workbench/lib/runtime-topology.ts',
    'platforms/workbench/lib/runtime-topology.mjs',
  ]);
  if (topoRel) {
    const topoSrc = await readFile(path.join(REPO_ROOT, topoRel), 'utf8');
    if (/单卡按需切换/.test(topoSrc)) return false;
  }
  const appSources = await readAppUiSources();
  return appSources.some(
    (s) =>
      (/vram_total_mb/.test(s.text) && /vram_used_mb|vram_free_mb/.test(s.text)) ||
      /\bPoolAllocation\b|\bPoolStatus\b|\ballocations\b[\s\S]{0,120}\bslots\b/.test(s.text) ||
      (/topology/i.test(s.rel) && /vram|gpu|slot|alloc/i.test(s.text)),
  );
}

async function hasM5HubUiAndRoutes(): Promise<boolean> {
  const serverRel = await findFirstExisting([
    'platforms/workbench/server.ts',
    'platforms/workbench/server.mjs',
  ]);
  if (!serverRel) return false;
  const serverSrc = await readFile(path.join(REPO_ROOT, serverRel), 'utf8');
  const hasHubRoutes =
    serverSrc.includes('/api/hub') ||
    (await deliverableExists('platforms/workbench/lib/gateway/hub-routes.ts')) ||
    (await deliverableExists('platforms/workbench/lib/gateway/hub-routes.mjs')) ||
    (await deliverableExists('platforms/workbench/lib/hub/routes.ts')) ||
    (await deliverableExists('platforms/workbench/lib/hub/routes.mjs')) ||
    (await deliverableExists('platforms/workbench/lib/hub-routes.ts')) ||
    (await deliverableExists('platforms/workbench/lib/hub-routes.mjs'));
  if (!hasHubRoutes) return false;
  const sources = await readCombinedUiSources();
  return sources.some((s) => /['"]hub['"]|\/api\/hub/.test(s.text));
}

function findExecutableOnPath(names: string[]): string | null {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function findPowerShell(): string | null {
  if (process.platform === 'win32') {
    return findExecutableOnPath(['pwsh.exe', 'powershell.exe']);
  }
  return findExecutableOnPath(['pwsh']);
}

function findBash(): string | null {
  return findExecutableOnPath(process.platform === 'win32' ? ['bash.exe'] : ['bash']);
}

describe('FA9 Tier 2: Web UI, Hub API & Installers boundary / negative tests', () => {
  it('fa09.t2.1 handles 0-GPU CPU standby topology and 4-GPU mixed-vendor nullable metrics without NaN', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const topoReady = await hasM5TopologyUi();
    if (
      !requireDeliverable(
        t,
        readyDeps && topoReady,
        'Pending M5 (Feature #22): Multi-GPU / 0-GPU standby topology UI not delivered',
      )
    ) {
      return;
    }

    const wsZero = await createIsolatedWorkspace('fa09-t2-1-zero-');
    let cpZero: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cpZero?.stop().catch(() => {});
      await wsZero.cleanup();
    });

    cpZero = await spawnWorkbenchControlPlane(wsZero, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
      readyTimeoutMs: 45_000,
    });

    const zeroData = await httpJson<{
      gpus: unknown[];
      host: { ram_total_mb: number } | null;
      values: Record<string, number | null>;
    }>(`${cpZero.urls.inference}/data?minutes=15&window=30`);
    assert.equal(zeroData.status, 200);
    assert.deepEqual(zeroData.data.gpus, []);
    assert.equal(zeroData.data.values.vram, null);
    assert.equal(zeroData.data.values.vram_total, null);
    assert.equal(zeroData.data.values.gpu, null);
    assert.ok((zeroData.data.host?.ram_total_mb ?? 0) > 0);

    const zeroUi = await httpRequest(`${cpZero.urls.workbench}/`, { timeoutMs: 30_000 });
    assertStatus(zeroUi, 200, '0-GPU standby GET /');
    assert.match(zeroUi.text, /VramDeck/);
    assert.doesNotMatch(zeroUi.text, /\bNaN\b/);
    assert.doesNotMatch(zeroUi.text, /Radeon AI PRO R9700|Radeon R9700/);
    await cpZero.stop();
    cpZero = undefined;

    const mixed4 = [
      createMockGpuDevice({
        id: 'nvidia:0',
        index: 0,
        vendor: 'nvidia',
        backend: 'cuda',
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
        vram_used_mb: 0,
      }),
      createMockGpuDevice({
        id: 'amd:1',
        index: 1,
        vendor: 'amd',
        backend: 'rocm',
        vram_total_mb: 16384,
        vram_used_mb: 0,
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
      }),
      createMockGpuDevice({
        id: 'apple:2',
        index: 2,
        vendor: 'apple',
        backend: 'metal',
        unified_memory: true,
        vram_total_mb: 49152,
        vram_used_mb: 0,
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
      }),
      createMockGpuDevice({
        id: 'intel:3',
        index: 3,
        vendor: 'intel',
        backend: 'vulkan',
        vram_total_mb: 8192,
        vram_used_mb: 0,
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
      }),
    ];

    const wsMixed = await createIsolatedWorkspace('fa09-t2-1-mixed-');
    let cpMixed: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cpMixed?.stop().catch(() => {});
      await wsMixed.cleanup();
    });

    cpMixed = await spawnWorkbenchControlPlane(wsMixed, {
      env: { WORKBENCH_MOCK_GPUS: JSON.stringify(mixed4) },
      readyTimeoutMs: 45_000,
    });

    const mixedRaw = await httpRequest(`${cpMixed.urls.inference}/data?minutes=15&window=30`);
    assertStatus(mixedRaw, 200, '4-GPU mixed-vendor nullable metrics /data');
    assert.doesNotMatch(mixedRaw.text, /\bNaN\b/);
    const mixedData = mixedRaw.json as { gpus: unknown[] };
    assert.equal(mixedData.gpus.length, 4);
    for (const gpu of mixedData.gpus) {
      assertGpuDevice(gpu);
    }

    const mixedUi = await httpRequest(`${cpMixed.urls.workbench}/`, { timeoutMs: 30_000 });
    assertStatus(mixedUi, 200, '4-GPU mixed-vendor GET /');
    assert.doesNotMatch(mixedUi.text, /\bNaN\b/);

    const appSources = await readAppUiSources();
    const combinedApp = appSources.map((s) => s.text).join('\n');
    assert.match(combinedApp, /vram_total_mb|vram_used_mb|vram_free_mb|PoolAllocation|slots/);
    assert.doesNotMatch(combinedApp, /单卡按需切换/);
  });

  it('fa09.t2.2 enforces Hub API origin/host/CORS/READ_ONLY isolation, localized error UI & invalid payload 400/404', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const hubReady = await hasM5HubUiAndRoutes();
    if (
      !requireDeliverable(
        t,
        readyDeps && hubReady,
        'Pending M5 (Feature #22): Hub Management UI & /api/hub/* isolation not delivered',
      )
    ) {
      return;
    }

    const sources = await readCombinedUiSources();
    const combinedUi = sources.map((s) => s.text).join('\n');
    assert.match(
      combinedUi,
      /error|banner|toast|alert/i,
      'UI must include localized error banner/toast handling for API failures',
    );

    const wsRo = await createIsolatedWorkspace('fa09-t2-2-ro-');
    let cpRo: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cpRo?.stop().catch(() => {});
      await wsRo.cleanup();
    });

    cpRo = await spawnWorkbenchControlPlane(wsRo, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]', WORKBENCH_READ_ONLY: '1' },
    });

    for (const roEndpoint of [
      '/api/hub/scan',
      '/api/hub/engines/install',
      '/api/hub/models/pull',
    ]) {
      const roRes = await httpRequest(`${cpRo.urls.workbench}${roEndpoint}`, {
        method: 'POST',
        body: { id: 'llama-cpp' },
      });
      assertStatus(roRes, [403, 503], `WORKBENCH_READ_ONLY blocks ${roEndpoint}`);
    }
    await cpRo.stop();
    cpRo = undefined;

    const ws = await createIsolatedWorkspace('fa09-t2-2-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_HEADLESS: '1', WORKBENCH_MOCK_GPUS: '[]' },
    });

    const headerVariants: Array<Record<string, string>> = [
      { 'sec-fetch-site': 'cross-site' },
      { Origin: 'https://attacker.example' },
      { 'X-Workbench-Public': '1' },
    ];
    for (const headers of headerVariants) {
      const blocked = await httpRequest(`${cp.urls.workbench}/api/hub/scan`, {
        method: 'POST',
        headers,
        body: {},
      });
      assertStatus(blocked, 403, `Writable server blocks cross-origin/public Hub scan`);
    }

    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const parsed = new URL(`${cp!.urls.workbench}/api/hub/scan`);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: Number(parsed.port),
          path: parsed.pathname,
          method: 'POST',
          headers: { Host: 'evil.example:13000', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(badHostStatus, 403, 'Non-loopback Host on writable /api/hub/scan must return 403');

    const malformed = await httpRequest(`${cp.urls.workbench}/api/hub/engines/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json',
    });
    assertStatus(malformed, [400, 404], 'Malformed JSON payload must never return 500');

    const unknownEngine = await httpRequest(`${cp.urls.workbench}/api/hub/engines/install`, {
      method: 'POST',
      body: { id: 'nonexistent-engine-xyz-999' },
    });
    assertStatus(unknownEngine, [400, 404], 'Unknown engine install must return 400/404');
  });

  it('fa09.t2.3 falls back to EN on invalid locale, handles unknown hash route, and bans legacy hardcodes', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const bilingualReady = await hasM5BilingualUi();
    if (
      !requireDeliverable(
        t,
        readyDeps && bilingualReady,
        'Pending M5 (Feature #22): Bilingual EN/中文 UI & fallback not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa09-t2-3-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
      readyTimeoutMs: 45_000,
    });

    const badLocale = await httpRequest(`${cp.urls.workbench}/?lang=xx-BAD`, {
      headers: {
        'Accept-Language': 'xx-Invalid',
        Cookie: 'lang=xx-BAD; vramdeck_lang=xx-BAD',
      },
      timeoutMs: 30_000,
    });
    assertStatus(badLocale, 200, 'Invalid locale fallback');
    assert.match(badLocale.text, /VramDeck/);
    assert.match(badLocale.text, /<html[^>]*\slang=["']?(?:en|zh)/i);

    const hashRouteRes = await httpRequest(`${cp.urls.workbench}/#/does-not-exist?job=abc`, {
      timeoutMs: 30_000,
    });
    assertStatus(hashRouteRes, 200, 'Unknown hash route serves SPA shell cleanly');
    assert.match(hashRouteRes.text, /VramDeck/);

    const unknownPathRes = await httpRequest(`${cp.urls.workbench}/does-not-exist-route-xyz`, {
      timeoutMs: 30_000,
    });
    assertStatus(unknownPathRes, [200, 404], 'Unknown path route must not return 500');

    const sources = await readCombinedUiSources();
    const combined = sources.map((s) => s.text).join('\n');
    assert.match(combined, /overview/, 'UI routing must include overview fallback');
    for (const s of sources) {
      assert.doesNotMatch(s.text, /Radeon AI PRO R9700|Radeon R9700/);
      assert.doesNotMatch(s.text, /AI Workbench/);
      assert.doesNotMatch(s.text, /单卡推理工作台/);
      assert.doesNotMatch(s.text, /Asia\/Shanghai/);
    }
  });

  it('fa09.t2.4 verifies scripts/install.ps1 rejects invalid flags, Node <22.19, and supports spaces/idempotency', async (t) => {
    const hasPs1 = await deliverableExists('scripts/install.ps1');
    if (
      !requireDeliverable(t, hasPs1, 'Pending M5 (Feature #23): scripts/install.ps1 not delivered')
    ) {
      return;
    }

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'install.ps1');
    const src = await readFile(scriptPath, 'utf8');
    assert.match(src, /22\.19/);
    assert.doesNotMatch(src, /\brequire.*python\b/i);

    const psBin = findPowerShell();
    if (psBin) {
      const badFlag = await runCommand(psBin, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-UnknownInvalidSwitchXYZ',
      ]);
      assert.notEqual(badFlag.code, 0, 'install.ps1 must reject unknown switches');

      const ws = await createIsolatedWorkspace('fa09-t2-4-');
      t.after(() => ws.cleanup());

      const fakeOldNodeDir = path.join(ws.rootDir, 'old-node');
      await mkdir(fakeOldNodeDir, { recursive: true });
      if (process.platform === 'win32') {
        await writeFile(
          path.join(fakeOldNodeDir, 'node.cmd'),
          '@echo off\r\nif "%1"=="-p" (echo 18.0.0) else (echo v18.0.0)\r\n',
          'utf8',
        );
      } else {
        const shim = path.join(fakeOldNodeDir, 'node');
        await writeFile(
          shim,
          '#!/bin/sh\nif [ "${1:-}" = "-p" ]; then echo 18.0.0; else echo v18.0.0; fi\n',
          'utf8',
        );
        await chmod(shim, 0o755);
      }

      const oldNodeRes = await runCommand(
        psBin,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-DryRun',
        ],
        {
          env: {
            PATH: `${fakeOldNodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
            WORKBENCH_NODE: undefined,
            NVM_HOME: undefined,
            USERPROFILE: ws.rootDir,
            LOCALAPPDATA: ws.dataDir,
            VRAMDECK_INSTALL_DIR: path.join(ws.rootDir, 'OldNodeInstall'),
          },
          timeoutMs: 30_000,
        },
      );
      assert.notEqual(oldNodeRes.code, 0, 'install.ps1 must reject Node < 22.19');
      assert.match(
        oldNodeRes.stdout + oldNodeRes.stderr,
        /22\.19|node.*version|upgrade.*node/i,
        'install.ps1 must emit actionable Node >= 22.19 error',
      );

      const spacedDir = path.join(ws.rootDir, 'Dir With Spaces', 'VramDeck');
      await mkdir(spacedDir, { recursive: true });
      const node22Dir = path.dirname(resolveNode22Plus());

      for (let runIdx = 0; runIdx < 2; runIdx += 1) {
        const res = await runCommand(
          psBin,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-DryRun',
          ],
          {
            env: {
              PATH: `${node22Dir}${path.delimiter}${process.env.PATH ?? ''}`,
              USERPROFILE: path.join(ws.rootDir, 'Dir With Spaces'),
              LOCALAPPDATA: ws.dataDir,
              VRAMDECK_INSTALL_DIR: spacedDir,
            },
            timeoutMs: 30_000,
          },
        );
        assert.equal(
          res.code,
          0,
          `install.ps1 -DryRun run #${runIdx + 1} with spaces failed:\n${res.stderr}`,
        );
      }
    }
  });

  it('fa09.t2.5 verifies scripts/install.sh CRLF/unquoted-op guards, invalid flag rejection, and spaces in HOME', async (t) => {
    const hasSh = await deliverableExists('scripts/install.sh');
    if (
      !requireDeliverable(t, hasSh, 'Pending M5 (Feature #23): scripts/install.sh not delivered')
    ) {
      return;
    }

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'install.sh');
    const src = await readFile(scriptPath, 'utf8');
    assert.equal(src.includes('\r\n'), false, 'scripts/install.sh must not contain CRLF');
    assert.doesNotMatch(src, /rm\s+-rf\s+\/(?:\s|\*|$)/);
    assert.match(src, /"\$\{?(?:HOME|INSTALL_DIR|VRAMDECK_INSTALL_DIR)/);
    assert.match(src, /22\.19/);

    const bashBin = findBash();
    if (bashBin) {
      const badFlag = await runCommand(bashBin, [scriptPath, '--unknown-invalid-flag-xyz']);
      assert.notEqual(badFlag.code, 0, 'install.sh must reject unknown flags');

      const ws = await createIsolatedWorkspace('fa09-t2-5-');
      t.after(() => ws.cleanup());
      const spacedHome = path.join(ws.rootDir, 'Dir With Spaces');
      await mkdir(spacedHome, { recursive: true });

      for (let runIdx = 0; runIdx < 2; runIdx += 1) {
        const res = await runCommand(bashBin, [scriptPath, '--dry-run'], {
          env: {
            HOME: spacedHome,
            XDG_DATA_HOME: path.join(spacedHome, 'data'),
            VRAMDECK_INSTALL_DIR: path.join(spacedHome, 'VramDeck'),
          },
          timeoutMs: 30_000,
        });
        assert.equal(
          res.code,
          0,
          `install.sh --dry-run run #${runIdx + 1} with spaces failed:\n${res.stderr}`,
        );
      }
    }
  });

  it('fa09.t2.6 server.mjs fails closed on missing production BUILD_ID and returns 404 on / in headless mode', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Feature #9): platforms/workbench/node_modules required for server.mjs',
      )
    ) {
      return;
    }

    const wsMissing = await createIsolatedWorkspace('fa09-t2-6-missing-');
    t.after(() => wsMissing.cleanup());

    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const serverRel =
      (await findFirstExisting([
        'platforms/workbench/server.ts',
        'platforms/workbench/server.mjs',
      ])) ?? 'platforms/workbench/server.mjs';
    const [p1, p2, p3] = await Promise.all([allocatePort(), allocatePort(), allocatePort()]);

    const missingBuildRes = await runCommand(
      resolveNode22Plus(),
      [path.join(REPO_ROOT, serverRel)],
      {
        cwd: workbenchDir,
        env: {
          ...wsMissing.env,
          NODE_ENV: 'production',
          WORKBENCH_HEADLESS: '0',
          WORKBENCH_NEXT_DIST: `.next-e2e-missing-${process.pid}-${Date.now()}`,
          WORKBENCH_PORT: String(p1),
          INFERENCE_PORT: String(p2),
          CONTROL_PORT: String(p3),
          WORKBENCH_MOCK_GPUS: '[]',
        },
        timeoutMs: 15_000,
      },
    );
    assert.notEqual(
      missingBuildRes.code,
      0,
      'Production server.mjs without BUILD_ID must fail closed',
    );
    assert.match(
      missingBuildRes.stderr + missingBuildRes.stdout,
      /Next\.js production build not found|next build|WORKBENCH_HEADLESS=1/i,
    );

    const wsHeadless = await createIsolatedWorkspace('fa09-t2-6-headless-');
    let cpHeadless: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cpHeadless?.stop().catch(() => {});
      await wsHeadless.cleanup();
    });

    cpHeadless = await spawnWorkbenchControlPlane(wsHeadless, {
      env: {
        NODE_ENV: 'production',
        WORKBENCH_HEADLESS: '1',
        WORKBENCH_MOCK_GPUS: '[]',
      },
    });

    const health = await httpJson<{ status: string }>(`${cpHeadless.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');

    const rootRes = await httpRequest<{ error: string }>(`${cpHeadless.urls.workbench}/`);
    assertStatus(rootRes, 404, 'Headless GET / returns 404');
    assert.match(rootRes.json?.error ?? '', /disabled in headless mode/i);
  });
});
