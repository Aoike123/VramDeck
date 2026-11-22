import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertGpuDevice, assertHubEngineEntry, assertHubModelEntry } from '../lib/assertions.ts';
import {
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { createMockHardwareSnapshot } from '../lib/fixtures.ts';
import { assertHeader, assertStatus, httpJson, httpRequest } from '../lib/http-client.ts';
import { createMockOllamaServer } from '../lib/mock-servers.ts';
import {
  runCommand,
  spawnWorkbenchControlPlane,
  stripE2eNextFromTsconfig,
  withWorkbenchTsconfigLock,
} from '../lib/process-runner.ts';

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
  const hasEnLocale = /['"]en['"]|en-US/i.test(combined);
  const hasZhLocale = /['"]zh(?:-CN)?['"]/i.test(combined);
  const hasVramDeck = /\bVramDeck\b/.test(combined);
  return hasEnLocale && hasZhLocale && hasVramDeck;
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
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
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

describe('FA9 Tier 1: Bilingual EN/中文 Web UI, Topology, Hub UI & Installers', () => {
  it('fa09.t1.1 builds production Next.js bundle and serves HTML, static assets, and /health via server.mjs', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Feature #9): platforms/workbench/node_modules (next/sharp/undici) required',
      )
    ) {
      return;
    }

    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const nextDist = `.next-e2e-prod-${process.pid}-${Date.now()}`;
    const nextDistAbs = path.join(workbenchDir, nextDist);
    const tsconfigPath = path.join(workbenchDir, 'tsconfig.json');
    const nextBin = path.join(workbenchDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    const nodeBin = resolveNode22Plus();

    let tsconfigBefore: string | null = null;
    let ws: Awaited<ReturnType<typeof createIsolatedWorkspace>> | undefined;
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws?.cleanup().catch(() => {});
      await rm(nextDistAbs, { recursive: true, force: true }).catch(() => {});
      await withWorkbenchTsconfigLock(() =>
        stripE2eNextFromTsconfig(tsconfigPath, tsconfigBefore),
      ).catch(() => {});
    });

    const buildRes = await withWorkbenchTsconfigLock(async () => {
      tsconfigBefore = await readFile(tsconfigPath, 'utf8').catch(() => null);
      const res = await runCommand(nodeBin, [nextBin, 'build', '--webpack'], {
        cwd: workbenchDir,
        env: {
          NODE_ENV: 'production',
          WORKBENCH_NEXT_DIST: nextDist,
          NEXT_TELEMETRY_DISABLED: '1',
        },
        timeoutMs: 120_000,
      });
      await stripE2eNextFromTsconfig(tsconfigPath, tsconfigBefore);
      return res;
    });
    assert.equal(buildRes.code, 0, `next build failed:\n${buildRes.stdout}\n${buildRes.stderr}`);
    assert.equal(
      existsSync(path.join(nextDistAbs, 'BUILD_ID')),
      true,
      'Production next build must generate BUILD_ID',
    );

    ws = await createIsolatedWorkspace('fa09-t1-1-');
    cp = await spawnWorkbenchControlPlane(ws, {
      env: {
        NODE_ENV: 'production',
        WORKBENCH_NEXT_DIST: nextDist,
        WORKBENCH_MOCK_GPUS: '[]',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      readyTimeoutMs: 45_000,
    });

    const health = await httpJson<{ status: string }>(`${cp.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');

    const rootRes = await httpRequest(`${cp.urls.workbench}/`);
    assertStatus(rootRes, 200, 'Production GET /');
    assertHeader(rootRes, 'content-type', /text\/html/i);
    assert.match(rootRes.text, /<html[^>]*\slang=/i);

    const staticMatch = /\/_next\/static\/[^"'\s<>)]+/.exec(rootRes.text);
    assert.ok(staticMatch, 'Production HTML must reference /_next/static/ assets');
    const assetRes = await httpRequest(`${cp.urls.workbench}${staticMatch[0]}`);
    assertStatus(assetRes, 200, `GET ${staticMatch[0]}`);
    assert.ok(assetRes.rawBody.length > 0);
  });

  it('fa09.t1.2 serves bilingual EN/中文 switcher, dynamic <html lang>, VramDeck branding, and locale-aware formatting', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const bilingualReady = await hasM5BilingualUi();
    if (
      !requireDeliverable(
        t,
        readyDeps && bilingualReady,
        'Pending M5 (Feature #22): Bilingual EN/中文 VramDeck UI & dynamic <html lang> not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa09-t1-2-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
      readyTimeoutMs: 45_000,
    });

    const enRes = await httpRequest(`${cp.urls.workbench}/?lang=en`, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'lang=en; vramdeck_lang=en; locale=en',
      },
      timeoutMs: 30_000,
    });
    assertStatus(enRes, 200, 'GET /?lang=en');
    assert.match(enRes.text, /VramDeck/);
    assert.doesNotMatch(enRes.text, /AI Workbench/);
    assert.match(enRes.text, /<html[^>]*\slang=["']?(?:en|zh)/i);

    const zhRes = await httpRequest(`${cp.urls.workbench}/?lang=zh-CN`, {
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Cookie: 'lang=zh-CN; vramdeck_lang=zh-CN; locale=zh-CN',
      },
      timeoutMs: 30_000,
    });
    assertStatus(zhRes, 200, 'GET /?lang=zh-CN');
    assert.match(zhRes.text, /VramDeck/);
    assert.doesNotMatch(zhRes.text, /AI Workbench/);
    assert.match(zhRes.text, /<html[^>]*\slang=["']?(?:en|zh)/i);

    const sources = await readCombinedUiSources();
    const combined = sources.map((s) => s.text).join('\n');
    for (const s of sources) {
      assert.doesNotMatch(s.text, /AI Workbench/, `${s.rel} retains legacy AI Workbench brand`);
      assert.doesNotMatch(
        s.text,
        /Asia\/Shanghai/,
        `${s.rel} hardcodes Asia/Shanghai instead of locale-aware formatting`,
      );
    }
    assert.match(combined, /['"]en['"]|en-US/i, 'UI must include English locale support');
    assert.match(combined, /['"]zh(?:-CN)?['"]|中文/, 'UI must include Chinese locale support');
    assert.match(
      combined,
      /documentElement\.lang|<html[^>]*lang=/i,
      'UI must manage <html lang> dynamically across locales',
    );
    assert.match(
      combined,
      /Intl\.(?:DateTimeFormat|NumberFormat)|toLocale(?:Date|Time)?String/,
      'UI must use locale-aware formatting',
    );
  });

  it('fa09.t1.3 exposes Multi-GPU VRAM Topology view and 2-GPU / 4-GPU /data snapshots without R9700 hardcodes', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const topoReady = await hasM5TopologyUi();
    if (
      !requireDeliverable(
        t,
        readyDeps && topoReady,
        'Pending M5 (Feature #22): Multi-GPU VRAM Topology view not delivered',
      )
    ) {
      return;
    }

    const dualSnap = createMockHardwareSnapshot('dual-heterogeneous-24g-12g');
    const quadSnap = createMockHardwareSnapshot('quad-24g');

    const wsDual = await createIsolatedWorkspace('fa09-t1-3-dual-');
    let cpDual: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cpDual?.stop().catch(() => {});
      await wsDual.cleanup();
    });

    cpDual = await spawnWorkbenchControlPlane(wsDual, {
      env: { WORKBENCH_MOCK_GPUS: JSON.stringify(dualSnap.gpus) },
      readyTimeoutMs: 45_000,
    });

    const dualData = await httpJson<{
      gpus: unknown[];
      values: Record<string, number | null>;
      runtime_topology?: { label?: string };
    }>(`${cpDual.urls.inference}/data?minutes=15&window=30`);
    assert.equal(dualData.status, 200);
    assert.equal(dualData.data.gpus.length, 2);
    for (const gpu of dualData.data.gpus) {
      assertGpuDevice(gpu);
    }
    assert.equal(dualData.data.values.vram_total, (24576 + 12288) * 1048576);
    assert.doesNotMatch(dualData.data.runtime_topology?.label ?? '', /单卡按需切换/);

    const uiDual = await httpRequest(`${cpDual.urls.workbench}/`, { timeoutMs: 30_000 });
    assertStatus(uiDual, 200, 'GET / with 2-GPU topology');
    assert.match(uiDual.text, /VramDeck/);
    assert.doesNotMatch(uiDual.text, /Radeon AI PRO R9700|Radeon R9700/);
    assert.doesNotMatch(uiDual.text, /单卡按需切换/);
    await cpDual.stop();
    cpDual = undefined;

    const wsQuad = await createIsolatedWorkspace('fa09-t1-3-quad-');
    let cpQuad: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cpQuad?.stop().catch(() => {});
      await wsQuad.cleanup();
    });

    cpQuad = await spawnWorkbenchControlPlane(wsQuad, {
      env: { WORKBENCH_MOCK_GPUS: JSON.stringify(quadSnap.gpus) },
      readyTimeoutMs: 45_000,
    });

    const quadData = await httpJson<{
      gpus: unknown[];
      values: Record<string, number | null>;
    }>(`${cpQuad.urls.inference}/data?minutes=15&window=30`);
    assert.equal(quadData.status, 200);
    assert.equal(quadData.data.gpus.length, 4);
    for (const gpu of quadData.data.gpus) {
      assertGpuDevice(gpu);
    }
    assert.equal(quadData.data.values.vram_total, 4 * 24576 * 1048576);

    const uiQuad = await httpRequest(`${cpQuad.urls.workbench}/`, { timeoutMs: 30_000 });
    assertStatus(uiQuad, 200, 'GET / with 4-GPU topology');
    assert.match(uiQuad.text, /VramDeck/);
    assert.doesNotMatch(uiQuad.text, /Radeon AI PRO R9700|Radeon R9700/);

    const appSources = await readAppUiSources();
    const hasPerGpuTopologyUi = appSources.some(
      (s) =>
        (/vram_total_mb/.test(s.text) && /vram_used_mb|vram_free_mb/.test(s.text)) ||
        /\bPoolAllocation\b|\bPoolStatus\b|\ballocations\b[\s\S]{0,120}\bslots\b/.test(s.text) ||
        (/topology/i.test(s.rel) && /vram|gpu|slot|alloc/i.test(s.text)),
    );
    assert.equal(
      hasPerGpuTopologyUi,
      true,
      'Web UI app/ sources must implement Multi-GPU VRAM Topology rendering',
    );
    const allSources = await readCombinedUiSources();
    for (const s of allSources) {
      assert.doesNotMatch(s.text, /Radeon AI PRO R9700|Radeon R9700/);
      assert.doesNotMatch(s.text, /单卡按需切换/);
    }
  });

  it('fa09.t1.4 serves Hub Management page and /api/hub/* catalog + local scan with mock Ollama', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    const hubReady = await hasM5HubUiAndRoutes();
    if (
      !requireDeliverable(
        t,
        readyDeps && hubReady,
        'Pending M5 (Feature #22): Hub Management page & /api/hub/* routes not delivered',
      )
    ) {
      return;
    }

    const ollama = await createMockOllamaServer({
      models: [{ name: 'qwen2.5:7b', size: 4_700_000_000 }],
    });
    const ws = await createIsolatedWorkspace('fa09-t1-4-');
    let cp: Awaited<ReturnType<typeof spawnWorkbenchControlPlane>> | undefined;
    t.after(async () => {
      await cp?.stop().catch(() => {});
      await ollama.close().catch(() => {});
      await ws.cleanup();
    });

    cp = await spawnWorkbenchControlPlane(ws, {
      env: {
        WORKBENCH_MOCK_GPUS: '[]',
        WORKBENCH_HUB_SCAN_URLS: ollama.base,
      },
      readyTimeoutMs: 45_000,
    });

    const uiRes = await httpRequest(`${cp.urls.workbench}/`, { timeoutMs: 30_000 });
    assertStatus(uiRes, 200, 'GET / Hub UI');

    let catalogMatched = false;
    for (const candidate of ['/api/hub/catalog', '/api/hub']) {
      const res = await httpRequest<{ engines?: unknown[]; models?: unknown[] }>(
        `${cp.urls.workbench}${candidate}`,
      );
      if (res.status === 200 && res.json) {
        if (Array.isArray(res.json.engines)) {
          assert.ok(res.json.engines.length > 0);
          assertHubEngineEntry(res.json.engines[0]);
        }
        if (Array.isArray(res.json.models)) {
          assert.ok(res.json.models.length > 0);
          assertHubModelEntry(res.json.models[0]);
        }
        catalogMatched = true;
        break;
      }
    }
    if (!catalogMatched) {
      const enginesRes = await httpJson<{ engines?: unknown[] }>(
        `${cp.urls.workbench}/api/hub/engines`,
      );
      assert.equal(enginesRes.status, 200);
      const enginesList = Array.isArray(enginesRes.data)
        ? enginesRes.data
        : (enginesRes.data.engines ?? []);
      assert.ok(enginesList.length > 0);
      assertHubEngineEntry(enginesList[0]);
    }

    const scanRes = await httpJson<{ services?: unknown[]; discovered?: unknown[] }>(
      `${cp.urls.workbench}/api/hub/scan`,
      {
        method: 'POST',
        body: { ports: [ollama.port], urls: [ollama.base] },
      },
    );
    assert.equal(scanRes.status, 200);
    const items = Array.isArray(scanRes.data)
      ? scanRes.data
      : (scanRes.data.services ?? scanRes.data.discovered ?? []);
    assert.ok(Array.isArray(items), 'POST /api/hub/scan must return discovered services array');
  });

  it('fa09.t1.5 validates Windows installer scripts/install.ps1 AST and -DryRun in isolated dir', async (t) => {
    const hasPs1 = await deliverableExists('scripts/install.ps1');
    if (
      !requireDeliverable(t, hasPs1, 'Pending M5 (Feature #23): scripts/install.ps1 not delivered')
    ) {
      return;
    }

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'install.ps1');
    const src = await readFile(scriptPath, 'utf8');
    assert.match(src, /VramDeck/);
    assert.match(src, /22\.19/);
    assert.match(src, /platforms[\\/]workbench/);

    const psBin = findPowerShell();
    if (psBin) {
      const parseCmd = [
        '$errors = $null;',
        `$null = [System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(scriptPath)}, [ref]$null, [ref]$errors);`,
        'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
      ].join(' ');
      const astRes = await runCommand(psBin, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        parseCmd,
      ]);
      assert.equal(astRes.code, 0, `PS1 AST parse failed:\n${astRes.stderr}`);

      const ws = await createIsolatedWorkspace('fa09-t1-5-');
      t.after(() => ws.cleanup());
      const installDir = path.join(ws.rootDir, 'VramDeck');
      const node22Dir = path.dirname(resolveNode22Plus());

      const dryRes = await runCommand(
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
            USERPROFILE: ws.rootDir,
            LOCALAPPDATA: ws.dataDir,
            VRAMDECK_INSTALL_DIR: installDir,
          },
          timeoutMs: 30_000,
        },
      );
      assert.equal(dryRes.code, 0, `install.ps1 -DryRun failed:\n${dryRes.stderr}`);
      assert.ok((dryRes.stdout + dryRes.stderr).trim().length > 0);
    }
  });

  it('fa09.t1.6 validates Linux/macOS installer scripts/install.sh contract and --dry-run', async (t) => {
    const hasSh = await deliverableExists('scripts/install.sh');
    if (
      !requireDeliverable(t, hasSh, 'Pending M5 (Feature #23): scripts/install.sh not delivered')
    ) {
      return;
    }

    const scriptPath = path.join(REPO_ROOT, 'scripts', 'install.sh');
    const src = await readFile(scriptPath, 'utf8');
    assert.equal(src.includes('\r\n'), false, 'scripts/install.sh must use LF line endings');
    assert.match(src, /^#!\/usr\/bin\/env\s+bash|^#!\/bin\/(?:ba)?sh/);
    assert.match(src, /set -eu/);
    assert.match(src, /uname -s/);
    assert.match(src, /Linux/i);
    assert.match(src, /Darwin/i);
    assert.match(src, /22\.19/);
    assert.match(src, /VramDeck/);
    assert.doesNotMatch(src, /\/home\/aoike|\/media\/aoike/);

    const bashBin = findBash();
    if (bashBin) {
      const syntaxRes = await runCommand(bashBin, ['-n', scriptPath]);
      assert.equal(syntaxRes.code, 0, `bash -n failed:\n${syntaxRes.stderr}`);

      const ws = await createIsolatedWorkspace('fa09-t1-6-');
      t.after(() => ws.cleanup());

      const dryRes = await runCommand(bashBin, [scriptPath, '--dry-run'], {
        env: {
          HOME: ws.rootDir,
          XDG_DATA_HOME: ws.dataDir,
          VRAMDECK_INSTALL_DIR: path.join(ws.rootDir, 'VramDeck'),
        },
        timeoutMs: 30_000,
      });
      assert.equal(dryRes.code, 0, `install.sh --dry-run failed:\n${dryRes.stderr}`);
      assert.ok((dryRes.stdout + dryRes.stderr).trim().length > 0);
    }
  });
});
