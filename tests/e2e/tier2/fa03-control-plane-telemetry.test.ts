import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertApiErrorShape } from '../lib/assertions.ts';
import {
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { assertHeader, assertStatus, httpJson, httpRequest } from '../lib/http-client.ts';
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

describe('FA3 Tier 2: Control plane auth, limits, origin & draining negative tests', () => {
  it('fa03.t2.1 rejects invalid /data minutes, window, and unknown model with 400 and zero backend loads', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa03-t2-1-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    for (const query of ['minutes=10', 'minutes=999', 'window=10', 'model=does-not-exist']) {
      const res = await httpRequest<{ error: string }>(`${cp.urls.inference}/data?${query}`);
      assertStatus(res, 400, `GET /data?${query}`);
      assert.equal(typeof res.json?.error, 'string');
    }

    const status = await httpJson<{ current: unknown; leased: boolean; active_leases: number }>(
      `${cp.urls.control}/status`,
    );
    assert.equal(status.status, 200);
    assert.equal(status.data.current, null);
    assert.equal(status.data.leased, false);
    assert.equal(status.data.active_leases, 0);
  });

  it('fa03.t2.2 rejects non-local Origin on API and rejects ALL Origins + >4096 B body on control port', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa03-t2-2-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const evilCors = await httpRequest(`${cp.urls.inference}/v1/chat/completions`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: { model: 'qwen38-27b-w3a4', messages: [{ role: 'user', content: 'hi' }] },
    });
    assertStatus(evilCors, 403, 'Non-local Origin on API');

    const controlOrigin = await httpRequest(`${cp.urls.control}/acquire`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:13000' },
      body: { model: 'llm' },
    });
    assertStatus(controlOrigin, 403, 'Origin header on control port');

    const oversized = await httpRequest(`${cp.urls.control}/acquire`, {
      method: 'POST',
      body: { model: 'llm', pad: 'x'.repeat(5000) },
    });
    assertStatus(oversized, [409, 413], 'Oversized control port body');
  });

  it('fa03.t2.3 management endpoints refuse non-loopback Host, cross-site sec-fetch, X-Workbench-Public, and cross-origin', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa03-t2-3-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    for (const mgmtPath of [
      '/api/access-keys',
      '/api/public',
      '/api/platform',
      '/api/mcp/overview',
    ]) {
      const crossSite = await httpRequest(`${cp.urls.workbench}${mgmtPath}`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      assertStatus(crossSite, 403, `${mgmtPath} sec-fetch-site: cross-site`);

      const badOrigin = await httpRequest(`${cp.urls.workbench}${mgmtPath}`, {
        headers: { Origin: 'https://attacker.example' },
      });
      assertStatus(badOrigin, 403, `${mgmtPath} cross-origin`);

      if (mgmtPath === '/api/platform' || mgmtPath === '/api/mcp/overview') {
        const viaPublic = await httpRequest(`${cp.urls.workbench}${mgmtPath}`, {
          headers: { 'X-Workbench-Public': '1' },
        });
        assertStatus(viaPublic, 403, `${mgmtPath} X-Workbench-Public: 1`);
      }

      const badHost = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const parsed = new URL(`${cp.urls.workbench}${mgmtPath}`);
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: Number(parsed.port),
            path: parsed.pathname,
            method: 'GET',
            headers: { Host: 'evil.example:13000' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                text: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(
        badHost.status,
        403,
        `Expected 403 for non-loopback Host on ${mgmtPath}, got ${badHost.status}`,
      );
    }
  });

  it('fa03.t2.4 enforces 401 API_KEY_REQUIRED/API_KEY_INVALID and /v1/media/jobs auth rules', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa03-t2-4-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const missingKey = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: { 'X-Workbench-Public': '1' },
    });
    assertStatus(missingKey, 401, 'Missing Bearer key on public proxy');
    assertHeader(missingKey, 'www-authenticate', /^Bearer/);
    assertApiErrorShape(missingKey.json, 'API_KEY_REQUIRED');

    const localBypass = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: { 'X-Workbench-Public': '1', Authorization: 'Bearer local' },
    });
    assertStatus(localBypass, 401, 'Bearer local blocked on public proxy');
    assertHeader(localBypass, 'www-authenticate', /^Bearer/);
    assertApiErrorShape(localBypass.json, 'API_KEY_INVALID');

    const invalidKey = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: { Authorization: 'Bearer sk-wb-totally-invalid' },
    });
    assertStatus(invalidKey, 401, 'Invalid Bearer token');
    assertApiErrorShape(invalidKey.json, 'API_KEY_INVALID');

    const mediaPublic = await httpRequest(`${cp.urls.inference}/v1/media/jobs`, {
      headers: { 'X-Workbench-Public': '1' },
    });
    assertStatus(mediaPublic, 404, '/v1/media/jobs blocks X-Workbench-Public');

    const mediaOrigin = await httpRequest(`${cp.urls.inference}/v1/media/jobs`, {
      headers: { Origin: 'http://127.0.0.1:13000' },
    });
    assertStatus(mediaOrigin, 403, '/v1/media/jobs blocks browser Origin');

    const mediaNoAuth = await httpRequest(`${cp.urls.inference}/v1/media/jobs`);
    assertStatus(mediaNoAuth, 401, '/v1/media/jobs requires Bearer key');

    const mediaLocalAuth = await httpRequest(`${cp.urls.inference}/v1/media/jobs`, {
      headers: { Authorization: 'Bearer local' },
    });
    assertStatus(mediaLocalAuth, 401, '/v1/media/jobs rejects Bearer local');

    const created = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 'media-auth-key', maxConcurrent: 1, requestsPerMinute: 30 },
    });
    assert.equal(created.status, 200);

    const mediaAuthed = await httpJson<{ jobs: unknown[] }>(`${cp.urls.inference}/v1/media/jobs`, {
      headers: { Authorization: `Bearer ${created.data.secret}` },
    });
    assert.equal(mediaAuthed.status, 200);
    assert.ok(Array.isArray(mediaAuthed.data.jobs));
  });

  it('fa03.t2.5 returns 429 with Retry-After and distinct codes on per-key and global rate overflow', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa03-t2-5-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const keyCreated = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: {
        action: 'create',
        name: 'tight-limit-key',
        maxConcurrent: 1,
        maxQueued: 0,
        requestsPerMinute: 2,
      },
    });
    assert.equal(keyCreated.status, 200);
    const secret = keyCreated.data.secret;

    const first = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assertStatus(first, 200, 'First key request admitted');

    const second = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assertStatus(second, 200, 'Second key request admitted');

    const third = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assertStatus(third, 429, 'Per-key rate limit overflow');
    assertHeader(third, 'retry-after', /^\d+$/);
    assertApiErrorShape(third.json, 'API_KEY_REQUEST_RATE_LIMIT_EXCEEDED');

    const updateGlobal = await httpJson(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'settings', requestsPerMinute: 2 },
    });
    assert.equal(updateGlobal.status, 200);

    const secondKey = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: {
        action: 'create',
        name: 'second-key',
        maxConcurrent: 1,
        maxQueued: 0,
        requestsPerMinute: 30,
      },
    });
    assert.equal(secondKey.status, 200);

    const globalOverflow = await httpRequest(`${cp.urls.inference}/v1/models`, {
      headers: { Authorization: `Bearer ${secondKey.data.secret}` },
    });
    assertStatus(globalOverflow, 429, 'Global rate limit overflow');
    assertHeader(globalOverflow, 'retry-after', /^\d+$/);
    assertApiErrorShape(globalOverflow.json, 'GLOBAL_REQUEST_RATE_LIMIT_EXCEEDED');
  });

  it('fa03.t2.6 enforces read-only mode (403) and clean shutdown/draining lock release with restart', async (t) => {
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

    const roWs = await createIsolatedWorkspace('fa03-t2-6-ro-');
    t.after(() => roWs.cleanup());

    const roCp = await spawnWorkbenchControlPlane(roWs, {
      env: { WORKBENCH_MOCK_GPUS: '[]', WORKBENCH_READ_ONLY: '1' },
    });
    t.after(() => roCp.stop());

    const roHealth = await httpJson<{ status: string }>(`${roCp.urls.inference}/health`);
    assert.equal(roHealth.status, 200);
    assert.equal(roHealth.data.status, 'ready');

    const roModels = await httpJson<{ object: string }>(`${roCp.urls.inference}/v1/models`);
    assert.equal(roModels.status, 200);
    assert.equal(roModels.data.object, 'list');

    const roStatus = await httpJson<{ draining: boolean }>(`${roCp.urls.control}/status`);
    assert.equal(roStatus.status, 200);
    assert.equal(roStatus.data.draining, false);

    const roKeyPost = await httpRequest(`${roCp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 'blocked' },
    });
    assertStatus(roKeyPost, 403, 'Read-only refuses POST /api/access-keys');

    const roChatPost = await httpRequest(`${roCp.urls.inference}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'qwen38-27b-w3a4', messages: [{ role: 'user', content: 'hi' }] },
    });
    assertStatus(roChatPost, 403, 'Read-only refuses POST /v1/chat/completions');

    const roAcquire = await httpRequest(`${roCp.urls.control}/acquire`, {
      method: 'POST',
      body: { model: 'llm' },
    });
    assertStatus(roAcquire, 403, 'Read-only refuses POST /acquire');
    await roCp.stop();

    const ws = await createIsolatedWorkspace('fa03-t2-6-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    if (process.platform !== 'win32') {
      process.kill(cp.process.pid, 'SIGTERM');
      let sawDraining = false;
      try {
        const probe = await httpRequest<{ status?: string }>(`${cp.urls.inference}/health`, {
          timeoutMs: 1_500,
        });
        if (probe.status === 503 && probe.json?.status === 'draining') {
          sawDraining = true;
        }
      } catch {
        // Server may close listeners immediately when zero active jobs/leases exist.
      }
      const exitRes = await cp.process.waitForExit(10_000);
      assert.equal(
        exitRes.code,
        0,
        `Expected clean SIGTERM exit 0 (sawDraining=${sawDraining}), got ${String(exitRes.code)}`,
      );
      await cp.stop();
    } else {
      await cp.stop();
      assert.equal(cp.process.exited(), true);
    }

    await assert.rejects(() => httpRequest(`${cp.urls.inference}/health`, { timeoutMs: 1_000 }));

    const restarted = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => restarted.stop());
    const restartedHealth = await httpJson<{ status: string }>(
      `${restarted.urls.inference}/health`,
    );
    assert.equal(restartedHealth.status, 200);
    assert.equal(restartedHealth.data.status, 'ready');
  });

  it('fa03.t2.7 duplicate server startup against same WORKBENCH_DATA fails cleanly on node.lock', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa03-t2-7-');
    t.after(() => ws.cleanup());

    const first = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => first.stop());

    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const serverRel =
      (await findFirstExisting([
        'platforms/workbench/server.ts',
        'platforms/workbench/server.mjs',
      ])) ?? 'platforms/workbench/server.mjs';
    const dupNextDist = `.next-e2e-dup-${process.pid}-${Date.now()}`;
    const dupNextDistAbs = path.join(workbenchDir, dupNextDist);
    t.after(async () => {
      await rm(dupNextDistAbs, { recursive: true, force: true }).catch(() => {});
      await withWorkbenchTsconfigLock(() =>
        stripE2eNextFromTsconfig(path.join(workbenchDir, 'tsconfig.json')),
      ).catch(() => {});
    });

    const secondRes = await runCommand(resolveNode22Plus(), [path.join(REPO_ROOT, serverRel)], {
      cwd: workbenchDir,
      env: {
        ...ws.env,
        WORKBENCH_PORT: String(first.ports.workbench),
        INFERENCE_PORT: String(first.ports.inference),
        CONTROL_PORT: String(first.ports.control),
        WORKBENCH_NEXT_DIST: dupNextDist,
        NODE_ENV: 'development',
        WORKBENCH_MOCK_GPUS: '[]',
      },
      timeoutMs: 10_000,
    });
    assert.notEqual(secondRes.code, 0, 'Duplicate control plane must fail on node.lock');
    assert.match(secondRes.stderr + secondRes.stdout, /already running/i);

    const health = await httpJson<{ status: string }>(`${first.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');
  });
});
