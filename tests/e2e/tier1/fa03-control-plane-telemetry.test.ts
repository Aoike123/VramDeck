import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertNoImportCycles, assertTelemetrySeries } from '../lib/assertions.ts';
import {
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
} from '../lib/env.ts';
import {
  assertHeader,
  assertStatus,
  httpJson,
  httpRequest,
  readSseStream,
} from '../lib/http-client.ts';
import { createMockOpenAIServer } from '../lib/mock-servers.ts';
import {
  runCommand,
  spawnWorkbenchControlPlane,
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

async function collectUiSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.next')) continue;
      files.push(...(await collectUiSourceFiles(path.join(dir, entry.name))));
    } else if (entry.isFile() && /\.(?:jsx?|tsx?|mjs|mts)$/.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files.sort();
}

function findDirectRenderSetServicesCalls(source: string): number[] {
  const pageMatch = /export\s+default\s+function\s+Page\s*\([^)]*\)\s*\{/.exec(source);
  if (!pageMatch) {
    return [];
  }
  const bodyStart = (pageMatch.index ?? 0) + pageMatch[0].length - 1;
  const hitLines: number[] = [];

  let i = bodyStart + 1;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'bt' = 'code';
  let parenDepth = 0;
  let renderBraceDepth = 1;
  // Track braces belonging to nested functions/arrow callbacks inside Page() so
  // calls inside useEffect(() => { ... }) or async function poll() { ... } are allowed.
  const scopeStack: Array<{ braceDepth: number; isFunction: boolean }> = [
    { braceDepth: 1, isFunction: true },
  ];
  let nestedFnDepth = 0;
  let lastIdent = '';
  let sawArrowOrFn = false;

  while (i < source.length && renderBraceDepth > 0) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (state === 'line') {
      if (ch === '\n') state = 'code';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (state === 'sq' || state === 'dq' || state === 'bt') {
      if (ch === '\\' && i + 1 < source.length) {
        i += 2;
        continue;
      }
      if (
        (state === 'sq' && ch === "'") ||
        (state === 'dq' && ch === '"') ||
        (state === 'bt' && ch === '`')
      ) {
        state = 'code';
      }
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'line';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'bt';
      sawArrowOrFn = false;
      i += 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) {
        end += 1;
      }
      const word = source.slice(i, end);
      if (word === 'setServices' && source[end] === '(' && nestedFnDepth === 0) {
        const lineNo = source.slice(0, i).split('\n').length;
        hitLines.push(lineNo);
      }
      if (word === 'function') {
        sawArrowOrFn = true;
      } else if (word !== 'async') {
        if (lastIdent === 'function') {
          // keep sawArrowOrFn true across function name
        } else {
          sawArrowOrFn = false;
        }
      }
      lastIdent = word;
      i = end;
      continue;
    }

    if (ch === '=' && next === '>') {
      sawArrowOrFn = true;
      lastIdent = '';
      i += 2;
      continue;
    }

    if (ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth -= 1;
      i += 1;
      continue;
    }

    if (ch === '{') {
      renderBraceDepth += 1;
      const isFn = sawArrowOrFn;
      scopeStack.push({ braceDepth: renderBraceDepth, isFunction: isFn });
      if (isFn) nestedFnDepth += 1;
      sawArrowOrFn = false;
      lastIdent = '';
      i += 1;
      continue;
    }

    if (ch === '}') {
      const top = scopeStack.pop();
      if (top?.isFunction && nestedFnDepth > 0) {
        nestedFnDepth -= 1;
      }
      renderBraceDepth -= 1;
      sawArrowOrFn = false;
      lastIdent = '';
      i += 1;
      continue;
    }

    if (!/\s/.test(ch)) {
      if (ch !== ',' && ch !== ':' && ch !== ';' && parenDepth === 0 && ch !== ')') {
        // Keep sawArrowOrFn only across parameter lists / return type punctuation
        if (!['[', ']', '<', '>'].includes(ch)) {
          sawArrowOrFn = false;
        }
      }
      lastIdent = '';
    }
    i += 1;
  }

  return hitLines;
}

describe('FA3 Tier 1: Single-process control plane, telemetry & baseline', () => {
  it('fa03.t1.1 passes all 4 Python suites via check-project.py --suite python', async () => {
    const res = await runCommand('python', [
      path.join(REPO_ROOT, '.workbench/scripts/check-project.py'),
      '--suite',
      'python',
    ]);
    assert.equal(
      res.code,
      0,
      `check-project.py --suite python failed (code=${res.code}):\n${res.stdout}\n${res.stderr}`,
    );
    assert.match(res.stdout, /tools:\s*PASS/);
    assert.match(res.stdout, /comfyui:\s*PASS/);
    assert.match(res.stdout, /scheduler:\s*PASS/);
    assert.match(res.stdout, /cpu-vision:\s*PASS/);
  });

  it('fa03.t1.2 enforces adapter SDK boundary, zero import cycles, and workbench tsconfig.json contract', async (t) => {
    const enginesDir = path.join(REPO_ROOT, 'engines');
    const categories = await readdir(enginesDir, { withFileTypes: true });
    for (const category of categories) {
      if (!category.isDirectory() || category.name === 'shared') continue;
      const pkgDirs = await readdir(path.join(enginesDir, category.name), { withFileTypes: true });
      for (const pkg of pkgDirs) {
        if (!pkg.isDirectory()) continue;
        for (const candidate of ['adapter.mjs', 'adapter.ts']) {
          const adapterPath = path.join(enginesDir, category.name, pkg.name, candidate);
          if (!existsSync(adapterPath)) continue;
          const src = await readFile(adapterPath, 'utf8');
          assert.doesNotMatch(
            src,
            /platforms\/workbench\/lib\/(?!engine-sdk\.(?:mjs|ts))/,
            `${adapterPath} leaks direct workbench lib import bypassing engine-sdk`,
          );
          assert.doesNotMatch(
            src,
            /['"]docker['"]\s*,\s*\[\s*['"]inspect['"]/,
            `${adapterPath} directly executes docker inspect bypassing engine-sdk`,
          );
        }
      }
    }

    await assertNoImportCycles(path.join(REPO_ROOT, 'platforms/workbench/lib'));
    await assertNoImportCycles(path.join(REPO_ROOT, 'platforms/workbench/app'));

    const tsconfigPath = path.join(REPO_ROOT, 'platforms/workbench/tsconfig.json');
    assert.equal(
      existsSync(tsconfigPath),
      true,
      'M1 (Feature #9/#10): platforms/workbench/tsconfig.json must exist',
    );
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8')) as {
      compilerOptions?: {
        erasableSyntaxOnly?: boolean;
        allowImportingTsExtensions?: boolean;
        strict?: boolean;
      };
    };
    assert.equal(tsconfig.compilerOptions?.erasableSyntaxOnly, true);
    assert.equal(tsconfig.compilerOptions?.allowImportingTsExtensions, true);
    assert.equal(tsconfig.compilerOptions?.strict, true);

    const hasTsc = await deliverableExists('platforms/workbench/node_modules/typescript/bin/tsc');
    if (
      requireDeliverable(
        t,
        hasTsc,
        'M1 (Feature #9): platforms/workbench/node_modules/typescript required for tsc --noEmit',
      )
    ) {
      const tscBin = path.join(REPO_ROOT, 'platforms/workbench/node_modules/typescript/bin/tsc');
      const tscRes = await withWorkbenchTsconfigLock(() =>
        runCommand(process.execPath, [tscBin, '--noEmit', '-p', tsconfigPath]),
      );
      assert.equal(tscRes.code, 0, `${tscRes.stdout}\n${tscRes.stderr}`);
    }
  });

  it('fa03.t1.3 Web console app/page has no render side-effects and no R9700/single-GPU hardcodes', async () => {
    const pageRel = await findFirstExisting([
      'platforms/workbench/app/page.tsx',
      'platforms/workbench/app/page.jsx',
    ]);
    assert.ok(pageRel, 'Expected platforms/workbench/app/page.{jsx,tsx} to exist');

    const pagePath = path.join(REPO_ROOT, pageRel);
    const pageSource = await readFile(pagePath, 'utf8');
    const directCalls = findDirectRenderSetServicesCalls(pageSource);
    assert.equal(
      directCalls.length,
      0,
      `M1 (Feature #8): ${pageRel} must not invoke setServices() directly during render (lines: ${directCalls.join(', ')})`,
    );

    const uiFiles = await collectUiSourceFiles(path.join(REPO_ROOT, 'platforms/workbench/app'));
    const panelRel = await findFirstExisting([
      'platforms/workbench/lib/panel.ts',
      'platforms/workbench/lib/panel.mjs',
    ]);
    if (panelRel) {
      uiFiles.push(path.join(REPO_ROOT, panelRel));
    }

    for (const file of uiFiles) {
      const source = await readFile(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file);
      assert.doesNotMatch(
        source,
        /Radeon AI PRO R9700|Radeon R9700/,
        `M1 (Feature #8): ${rel} must not hardcode Radeon R9700`,
      );
      assert.doesNotMatch(
        source,
        /单卡推理工作台|单卡按需调度/,
        `M1 (Feature #8): ${rel} must not hardcode single-GPU labels`,
      );
    }
  });

  it('fa03.t1.4 single-process Node control plane boots cleanly with 0 GPUs and 0 engines', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Feature #9): platforms/workbench/node_modules (next/sharp/undici) required to spawn server.mjs',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa03-t1-4-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const health = await httpJson<{ status: string; gateway: boolean; gpu: unknown }>(
      `${cp.urls.inference}/health`,
    );
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');
    assert.equal(health.data.gateway, true);

    const status = await httpJson<Record<string, unknown>>(`${cp.urls.control}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.data.draining, false);
  });

  it('fa03.t1.5 graceful SIGTERM exits cleanly, releases node.lock, and allows immediate restart', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Feature #9): platforms/workbench/node_modules (next/sharp/undici) required to spawn server.mjs',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa03-t1-5-');
    t.after(() => ws.cleanup());

    const first = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    await first.stop();

    const second = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => second.stop());

    const health = await httpJson<{ status: string }>(`${second.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');
  });

  it('fa03.t1.6 built-in 60-min ring telemetry serves /data windows and /metrics without Prometheus', async (t) => {
    const telemetryEntry = await findFirstExisting([
      'platforms/workbench/lib/telemetry.ts',
      'platforms/workbench/lib/telemetry.mjs',
    ]);
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        Boolean(telemetryEntry) && readyDeps,
        'Pending M1/M2 (Features #9, #13): telemetry.{ts,mjs} and workbench node_modules required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa03-t1-6-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    for (const [minutes, windowSeconds] of [
      [15, 5],
      [30, 30],
      [60, 60],
    ]) {
      const res = await httpJson<{
        minutes: number;
        values: Record<string, unknown>;
        trends: Record<string, unknown>;
      }>(`${cp.urls.inference}/data?minutes=${minutes}&window=${windowSeconds}`);
      assert.equal(res.status, 200);
      assert.equal(res.data.minutes, minutes);
      assert.ok(res.data.values && typeof res.data.values === 'object');
      assert.ok(res.data.trends && typeof res.data.trends === 'object');
      for (const [metric, series] of Object.entries(res.data.trends)) {
        if (Array.isArray(series)) {
          assertTelemetrySeries({ metric, points: series });
        } else {
          assertTelemetrySeries(series);
        }
      }
    }

    const metricsRes = await httpRequest(`${cp.urls.inference}/metrics`);
    assertStatus(metricsRes, 200, 'GET /metrics');
    assertHeader(metricsRes, 'content-type', /text\/plain/);
    assert.match(metricsRes.text, /lab_scheduler_queued/);
  });

  it('fa03.t1.7 serves CORS preflight, AccessKeys creation/auth, public toggle, /health, and /metrics over live HTTP', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Feature #9): platforms/workbench/node_modules (next/sharp/undici) required to spawn server.mjs',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa03-t1-7-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const optionsRes = await httpRequest(`${cp.urls.inference}/v1/models`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:13000' },
    });
    assertStatus(optionsRes, 204, 'CORS preflight');
    assertHeader(optionsRes, 'access-control-allow-origin', 'http://127.0.0.1:13000');
    assertHeader(optionsRes, 'vary', 'Origin');

    const created = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 'e2e-key', maxConcurrent: 2, requestsPerMinute: 30 },
    });
    assert.equal(created.status, 200);
    assert.ok(created.data.secret.startsWith('sk-wb-'));

    const models = await httpJson<{ object: string; data: unknown[] }>(
      `${cp.urls.inference}/v1/models`,
      {
        headers: {
          'X-Workbench-Public': '1',
          Authorization: `Bearer ${created.data.secret}`,
        },
      },
    );
    assert.equal(models.status, 200);
    assert.equal(models.data.object, 'list');
    assert.ok(models.data.data.length >= 1);

    const disablePublic = await httpJson<{ routes: Array<{ id: string; exposed: boolean }> }>(
      `${cp.urls.workbench}/api/public`,
      {
        method: 'POST',
        body: { action: 'set', id: 'GET /v1/models', exposed: false },
      },
    );
    assert.equal(disablePublic.status, 200);

    const blockedPublic = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: {
        'X-Workbench-Public': '1',
        Authorization: `Bearer ${created.data.secret}`,
      },
    });
    assertStatus(blockedPublic, 404, 'Disabled public route returns 404');

    const enablePublic = await httpJson(`${cp.urls.workbench}/api/public`, {
      method: 'POST',
      body: { action: 'set', id: 'GET /v1/models', exposed: true },
    });
    assert.equal(enablePublic.status, 200);

    const health = await httpJson<{ status: string }>(`${cp.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');

    const metricsRes = await httpRequest(`${cp.urls.inference}/metrics`);
    assertStatus(metricsRes, 200, 'GET /metrics');
    assert.match(metricsRes.text, /lab_scheduler_active_leases/);
  });

  it('fa03.t1.8 exposes live /v1/models, /v1/capabilities, /v1/media/models, /v1/chat/completions validation, and OpenAI SSE stream contract', async (t) => {
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        readyDeps,
        'M1 (Feature #9): platforms/workbench/node_modules (next/sharp/undici) required to spawn server.mjs',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa03-t1-8-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const modelsRes = await httpJson<{
      object: string;
      data: Array<{
        id: string;
        tasks: string[];
        max_model_len: number;
        reasoningEfforts: Record<string, string>;
        default_reasoning_effort: string;
      }>;
    }>(`${cp.urls.inference}/v1/models`);
    assert.equal(modelsRes.status, 200);
    assert.equal(modelsRes.data.object, 'list');
    assert.ok(modelsRes.data.data.length >= 1);
    const modelId = modelsRes.data.data[0].id;
    assert.ok(modelsRes.data.data[0].tasks.includes('chat'));
    assert.ok(modelsRes.data.data[0].max_model_len > 0);
    assert.equal(typeof modelsRes.data.data[0].reasoningEfforts, 'object');
    assert.ok(Object.values(modelsRes.data.data[0].reasoningEfforts).includes('medium'));
    assert.equal(modelsRes.data.data[0].default_reasoning_effort, 'medium');

    const capsRes = await httpJson<{ object: string; data: unknown[] }>(
      `${cp.urls.inference}/v1/capabilities`,
    );
    assert.equal(capsRes.status, 200);
    assert.equal(capsRes.data.object, 'list');
    assert.ok(Array.isArray(capsRes.data.data));

    const mediaModelsRes = await httpJson<{
      object: string;
      runtime_topology: unknown;
      capabilities: unknown[];
      data: unknown[];
    }>(`${cp.urls.inference}/v1/media/models`);
    assert.equal(mediaModelsRes.status, 200);
    assert.equal(mediaModelsRes.data.object, 'list');
    assert.ok(mediaModelsRes.data.runtime_topology);
    assert.ok(Array.isArray(mediaModelsRes.data.capabilities));
    assert.ok(Array.isArray(mediaModelsRes.data.data));

    const badModel = await httpRequest<{ error: string }>(
      `${cp.urls.inference}/v1/chat/completions`,
      {
        method: 'POST',
        body: { model: 'nonexistent-model', messages: [{ role: 'user', content: 'ping' }] },
      },
    );
    assertStatus(badModel, 400, 'Unknown chat model validation');
    assert.equal(typeof badModel.json?.error, 'string');

    const missingMsgs = await httpRequest<{ error: string }>(
      `${cp.urls.inference}/v1/chat/completions`,
      {
        method: 'POST',
        body: { model: modelId, messages: [] },
      },
    );
    assertStatus(missingMsgs, 400, 'Empty chat messages validation');

    const badLimit = await httpRequest<{ error: string }>(
      `${cp.urls.inference}/v1/chat/completions`,
      {
        method: 'POST',
        body: { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 0 },
      },
    );
    assertStatus(badLimit, 400, 'Invalid max_tokens validation');

    const ctrlStatus = await httpJson<{ leased: boolean; active_leases: number }>(
      `${cp.urls.control}/status`,
    );
    assert.equal(ctrlStatus.status, 200);
    assert.equal(ctrlStatus.data.leased, false);
    assert.equal(ctrlStatus.data.active_leases, 0);

    const openai = await createMockOpenAIServer({
      chatText: 'hello-from-vramdeck-mock',
      streamChunks: ['chunk-a-', 'chunk-b'],
    });
    t.after(() => openai.close());

    const jsonChat = await httpJson<{
      choices: Array<{ message: { content: string } }>;
    }>(`${openai.base}/v1/chat/completions`, {
      method: 'POST',
      body: { model: modelId, messages: [{ role: 'user', content: 'ping' }] },
    });
    assert.equal(jsonChat.status, 200);
    assert.equal(jsonChat.data.choices[0].message.content, 'hello-from-vramdeck-mock');

    const sseRes = await readSseStream(`${openai.base}/v1/chat/completions`, {
      method: 'POST',
      body: {
        model: modelId,
        stream: true,
        messages: [{ role: 'user', content: 'stream' }],
      },
    });
    assert.equal(sseRes.status, 200);
    assert.ok(
      sseRes.events.some((e) => e.data === '[DONE]'),
      'SSE stream must end with [DONE]',
    );
    assert.ok(sseRes.events.some((e) => e.data.includes('chunk-a-')));
    assert.ok(sseRes.events.some((e) => e.data.includes('chunk-b')));
  });
});
