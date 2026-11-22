import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { main, parseCliArgs } from '../cli.ts';

const execFileAsync = promisify(execFile);

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

test('parseCliArgs handles help flags and preserves --help after run --', () => {
  assert.equal(parseCliArgs([]).help, true);
  assert.equal(parseCliArgs(['--help']).help, true);
  assert.equal(parseCliArgs(['scheduler', '--help']).help, true);
  const runCmd = parseCliArgs(['run', 'llm', '--', 'python', '--help']);
  assert.equal(runCmd.help, false);
  assert.equal(runCmd.command, 'run');
});

test('devices command falls back to local DeviceProvider when gateway is offline', async () => {
  const outputs: string[] = [];
  await main(['devices', '--json'], {
    fetchFn: async () => {
      throw new Error('fetch failed');
    },
    detectDevices: async () => ({
      collected_at: 1700000000000,
      host: { os: 'win32', arch: 'x64', ram_total_mb: 32768, ram_free_mb: 16384 },
      gpus: [],
    }),
    stdout: (t) => outputs.push(t),
  });

  const parsed = JSON.parse(outputs.join(''));
  assert.equal(parsed.host.os, 'win32');
  assert.deepEqual(parsed.gpus, []);
});

test('scheduler switch and top-level ./lab scheduler switch compat acquire and release lease', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const outputs: string[] = [];

  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u, body });
    if (u.endsWith('/acquire')) {
      return new Response(JSON.stringify({ token: 'tok-123', model: body.model }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await main(['scheduler', 'switch', 'llm'], {
    fetchFn: fakeFetch,
    stdout: (t) => outputs.push(t),
  });
  await main(['switch', 'h3'], {
    fetchFn: fakeFetch,
    stdout: (t) => outputs.push(t),
  });

  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /\/acquire$/);
  assert.deepEqual(calls[0].body, { model: 'llm' });
  assert.match(calls[1].url, /\/release$/);
  assert.deepEqual(calls[1].body, { token: 'tok-123' });
  assert.deepEqual(calls[2].body, { model: 'h3' });
  assert.deepEqual(outputs, ['Ready: llm', 'Ready: h3']);
});

test('stop command prefers POST /shutdown on control port without reading /proc', async () => {
  let statusCalls = 0;
  const seenUrls: string[] = [];
  const outputs: string[] = [];

  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.endsWith('/status')) {
      statusCalls++;
      if (statusCalls === 1) {
        return new Response(JSON.stringify({ leased: false, switching: false, queued: 0 }), {
          status: 200,
        });
      }
      throw new Error('fetch failed');
    }
    if (u.endsWith('/shutdown')) {
      return new Response(JSON.stringify({ ok: true, draining: true }), { status: 202 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  await main(['stop'], {
    platform: 'win32',
    fetchFn: fakeFetch,
    sleep: async () => {},
    stdout: (t) => outputs.push(t),
  });

  assert.ok(seenUrls.some((u) => u.endsWith('/shutdown')));
  assert.deepEqual(outputs, ['Stopped.']);
});

test('engine list, hub 404 handling, service status, and logs read server.log cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vramdeck-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'server.log'), 'line 1\nline 2\nline 3\n', 'utf8');

  const logOut: string[] = [];
  await main(['logs', '--lines', '2'], {
    env: { ...process.env, WORKBENCH_DATA: dir },
    stdout: (txt) => logOut.push(txt),
  });
  assert.match(logOut.join(''), /line 2/);

  const engineOut: string[] = [];
  await main(['engine', 'list'], {
    fetchFn: (async () =>
      new Response(
        JSON.stringify({
          packages: [
            {
              id: 'test-llm',
              enabled: true,
              engine: 'llm',
              models: [{ id: 'm1', capabilities: ['chat'] }],
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch,
    stdout: (txt) => engineOut.push(txt),
  });
  assert.match(engineOut.join(''), /test-llm\s+enabled\s+m1\[chat\]/);

  const hubErr: string[] = [];
  await main(['hub', 'scan'], {
    fetchFn: (async () =>
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })) as typeof fetch,
    stderr: (txt) => hubErr.push(txt),
  });
  assert.match(hubErr.join(''), /Milestone M4/);

  const svcOut: string[] = [];
  await main(['service', 'status'], {
    serviceOps: {
      install: async () => ({}),
      uninstall: async () => ({}),
      status: async () => ({ installed: false, active: false, manager: 'schtasks' }),
    },
    stdout: (txt) => svcOut.push(txt),
  });
  assert.equal(JSON.parse(svcOut.join('')).manager, 'schtasks');
});

test('engine enable/disable increases timeout and does not fall back offline on AbortError/TimeoutError', async () => {
  let observedTimeoutSignal = false;
  await assert.rejects(
    () =>
      main(['engine', 'disable', 'anima'], {
        fetchFn: (async (_url, init) => {
          observedTimeoutSignal = Boolean(init?.signal);
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }) as typeof fetch,
      }),
    /aborted due to timeout/i,
  );
  assert.equal(observedTimeoutSignal, true);
});

test('cli.mjs start --headless followed by cli.mjs stop leaves no alive server PID', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vramdeck-cli-lifecycle-'));
  const dataDir = join(dir, 'data');
  const cliMjs = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const [managementPort, inferencePort, controlPort] = await Promise.all([
    getFreePort(),
    getFreePort(),
    getFreePort(),
  ]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKBENCH_DATA: dataDir,
    WORKBENCH_PORT: String(managementPort),
    INFERENCE_PORT: String(inferencePort),
    CONTROL_PORT: String(controlPort),
    WORKBENCH_MOCK_GPUS: '[]',
    WORKBENCH_DISABLE_DOCKER: '1',
    WORKBENCH_SERVER_NO_AUTOSTART: '0',
  };

  t.after(async () => {
    try {
      const pid = Number((await readFile(join(dataDir, 'server.pid'), 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  const startRes = await execFileAsync(process.execPath, [cliMjs, 'start', '--headless'], {
    env,
    timeout: 20000,
  });
  assert.match(startRes.stdout, /"draining":\s*false/);

  const pid = Number((await readFile(join(dataDir, 'server.pid'), 'utf8')).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  process.kill(pid, 0);

  const stopRes = await execFileAsync(process.execPath, [cliMjs, 'stop'], {
    env,
    timeout: 15000,
  });
  assert.match(stopRes.stdout, /Stopped\./);

  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
