import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handlers } from '../lib/http.mjs';
import { acquireProcessLock } from '../lib/process-lock.mjs';
import { parseServerCliArgs, startControlPlane } from '../server.mjs';

test('single-process control plane boots headless with 0 GPUs, no Docker, no Prometheus, and shuts down cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vramdeck-cp-'));
  const dataDir = join(dir, 'data');
  const mediaRoot = join(dir, 'media');

  const prevMockGpus = process.env.WORKBENCH_MOCK_GPUS;
  const prevDisableDocker = process.env.WORKBENCH_DISABLE_DOCKER;
  const prevPromUrl = process.env.WORKBENCH_PROMETHEUS_URL;

  process.env.WORKBENCH_MOCK_GPUS = '[]';
  process.env.WORKBENCH_DISABLE_DOCKER = '1';
  delete process.env.WORKBENCH_PROMETHEUS_URL;

  t.after(async () => {
    if (prevMockGpus === undefined) delete process.env.WORKBENCH_MOCK_GPUS;
    else process.env.WORKBENCH_MOCK_GPUS = prevMockGpus;

    if (prevDisableDocker === undefined) delete process.env.WORKBENCH_DISABLE_DOCKER;
    else process.env.WORKBENCH_DISABLE_DOCKER = prevDisableDocker;

    if (prevPromUrl === undefined) delete process.env.WORKBENCH_PROMETHEUS_URL;
    else process.env.WORKBENCH_PROMETHEUS_URL = prevPromUrl;

    await rm(dir, { recursive: true, force: true });
  });

  const cp = await startControlPlane({
    headless: true,
    dataDir,
    mediaRoot,
    schedulingPath: join(dir, 'missing-scheduling.json'),
    ports: { management: 0, inference: 0, control: 0 },
    telemetryIntervalMs: 60_000,
    shutdownTimeoutMs: 2000,
  });

  try {
    // 1. /health returns 200 ready
    const healthRes = await fetch(`${cp.urls.inference}/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; gateway: boolean };
    assert.equal(health.status, 'ready');
    assert.equal(health.gateway, true);

    // 2. /data returns 200 across 15/30/60m with 0 GPUs and null VRAM (never 0 GiB)
    for (const minutes of [15, 30, 60]) {
      const dataRes = await fetch(`${cp.urls.inference}/data?minutes=${minutes}&window=30`);
      assert.equal(dataRes.status, 200);
      const data = (await dataRes.json()) as {
        gpus: unknown[];
        host: { ram_total_mb: number };
        values: { vram: number | null; vram_total: number | null };
      };
      assert.deepEqual(data.gpus, []);
      assert.ok(data.host.ram_total_mb > 0);
      assert.equal(data.values.vram, null);
      assert.equal(data.values.vram_total, null);
    }

    // 3. /metrics returns Prometheus exposition text
    const metricsRes = await fetch(`${cp.urls.inference}/metrics`);
    assert.equal(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert.match(metricsText, /lab_scheduler_queued/);
    assert.match(metricsText, /lab_gpu_devices 0/);

    // 4. Draining flips /health to 503
    cp.lifecycle.draining = true;
    const drainingHealth = await fetch(`${cp.urls.inference}/health`);
    assert.equal(drainingHealth.status, 503);
    const drainingJson = (await drainingHealth.json()) as { status: string };
    assert.equal(drainingJson.status, 'draining');

    // 5. POST /shutdown on control port triggers clean shutdown and releases lock
    const shutdownRes = await fetch(`${cp.urls.control}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(shutdownRes.status, 202);
  } finally {
    await cp.close();
  }

  // Verify servers are closed and lock is released cleanly
  await assert.rejects(() => fetch(`${cp.urls.inference}/health`));
  const reacquire = await acquireProcessLock(join(dataDir, 'node.lock'));
  await reacquire();
});

test('parseServerCliArgs supports --production and --data-dir flags', () => {
  assert.deepEqual(parseServerCliArgs(['--production', '--data-dir', '/tmp/vramdeck']), {
    dev: false,
    dataDir: '/tmp/vramdeck',
  });
  assert.deepEqual(parseServerCliArgs(['--headless', '--data-dir=D:\\data']), {
    headless: true,
    dataDir: 'D:\\data',
  });
  assert.throws(() => parseServerCliArgs(['--data-dir']), /--data-dir requires a path/);
});

test('spawned server.mjs accepts bodyless POST /shutdown (202) and exits 0 within 2s', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vramdeck-spawn-'));
  const dataDir = join(dir, 'data');
  const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [serverPath, '--headless', '--data-dir', dataDir], {
    env: {
      ...process.env,
      WORKBENCH_HEADLESS: '1',
      WORKBENCH_MOCK_GPUS: '[]',
      WORKBENCH_DISABLE_DOCKER: '1',
      WORKBENCH_PORT: '0',
      INFERENCE_PORT: '0',
      CONTROL_PORT: '0',
      WORKBENCH_SERVER_NO_AUTOSTART: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const portsMatch = await new Promise<RegExpExecArray>((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`Server start timeout.\nstdout: ${stdout}\nstderr: ${stderr}`)),
      15000,
    );
    const check = () => {
      const m = /Next\.js Workbench ready:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolveReady(m);
      }
    };
    child.stdout.on('data', check);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`Server exited early (${code}/${signal}): ${stderr}`));
    });
  });

  const inferencePort = Number(portsMatch[2]);
  const controlPort = Number(portsMatch[3]);

  const healthRes = await fetch(`http://127.0.0.1:${inferencePort}/health`);
  assert.equal(healthRes.status, 200);

  // Origin header on control port /shutdown must still be rejected with 403
  const forbiddenShutdown = await fetch(`http://127.0.0.1:${controlPort}/shutdown`, {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:13000' },
  });
  assert.equal(forbiddenShutdown.status, 403);

  const startedAt = Date.now();
  const shutdownRes = await fetch(`http://127.0.0.1:${controlPort}/shutdown`, {
    method: 'POST',
  });
  assert.equal(shutdownRes.status, 202);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timer = setTimeout(
        () => rejectExit(new Error('server.mjs did not exit within 2000ms after POST /shutdown')),
        2000,
      );
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(exit.code, 0, `Expected exit 0 in ${elapsedMs}ms; stderr: ${stderr}`);
  assert.equal(exit.signal, null);

  const reacquire = await acquireProcessLock(join(dataDir, 'node.lock'));
  await reacquire();
});

test('POST /shutdown triggers onShutdown idempotently on close without finish', async () => {
  let shutdownCalls = 0;
  const { control } = handlers(
    { backend: { residency: async () => ({}) }, status: () => ({}) },
    { snapshot: () => ({}), workflow: () => {}, prometheus: () => '' },
    { draining: false },
    {
      onShutdown: async () => {
        shutdownCalls += 1;
      },
    } as never,
  );

  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/shutdown',
    headers: {},
    resume() {},
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead() {},
    end() {
      res.emit('close');
      res.emit('finish');
    },
  });

  await control(req as never, res as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCalls, 1);
});
