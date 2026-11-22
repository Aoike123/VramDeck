import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  allocatePort,
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import {
  runCommand,
  stripE2eNextFromTsconfig,
  withWorkbenchTsconfigLock,
} from '../lib/process-runner.ts';

async function getM2CliEntry(): Promise<string | null> {
  const hasCliTs = await deliverableExists('platforms/workbench/cli.ts');
  if (!hasCliTs) return null;
  return findFirstExisting(['platforms/workbench/cli.mjs']);
}

async function hasWorkbenchDeps(): Promise<boolean> {
  const [hasNext, hasSharp, hasUndici] = await Promise.all([
    deliverableExists('platforms/workbench/node_modules/next/package.json'),
    deliverableExists('platforms/workbench/node_modules/sharp/package.json'),
    deliverableExists('platforms/workbench/node_modules/undici/package.json'),
  ]);
  return hasNext && hasSharp && hasUndici;
}

describe('FA6 Tier 1: Cross-platform Node CLI & ./lab compatibility', () => {
  it('fa06.t1.1 Node CLI status, devices, and scheduler subcommands emit valid output', async (t) => {
    const cliRel = await getM2CliEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(cliRel),
        'Pending M2 (Feature #17): platforms/workbench/cli.ts not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa06-t1-1-');
    t.after(() => ws.cleanup());

    const mockControl = http.createServer((req, res) => {
      if (req.url?.startsWith('/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            current: null,
            leased: false,
            active_leases: 0,
            queued: 0,
            switching: false,
            draining: false,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      mockControl.listen({ port: 0, host: '127.0.0.1' }, resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve) => {
          mockControl.closeAllConnections();
          mockControl.close(() => resolve());
        }),
    );

    const port = (mockControl.address() as AddressInfo).port;
    const nodeBin = resolveNode22Plus();
    const cliAbs = path.join(REPO_ROOT, cliRel!);

    const statusRes = await runCommand(nodeBin, [cliAbs, 'status'], {
      env: { ...ws.env, CONTROL_PORT: String(port) },
    });
    assert.equal(statusRes.code, 0, statusRes.stderr);
    const parsedStatus = JSON.parse(statusRes.stdout) as { leased: boolean };
    assert.equal(parsedStatus.leased, false);

    const devicesRes = await runCommand(nodeBin, [cliAbs, 'devices', '--json'], {
      env: { ...ws.env, WORKBENCH_MOCK_GPUS: '[]' },
    });
    assert.equal(devicesRes.code, 0, devicesRes.stderr);
    const parsedDevices = JSON.parse(devicesRes.stdout) as { host: unknown; gpus: unknown[] };
    assert.ok(Array.isArray(parsedDevices.gpus));

    const schedRes = await runCommand(nodeBin, [cliAbs, 'scheduler', 'status'], {
      env: { ...ws.env, CONTROL_PORT: String(port) },
    });
    assert.equal(schedRes.code, 0, schedRes.stderr);
    const parsedSched = JSON.parse(schedRes.stdout) as { leased: boolean };
    assert.equal(parsedSched.leased, false);
  });

  it('fa06.t1.2 Node CLI start -> status -> logs -> stop lifecycle in isolated workspace', async (t) => {
    const cliRel = await getM2CliEntry();
    const readyDeps = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        Boolean(cliRel) && readyDeps,
        'Pending M1/M2 (Features #9, #17): cli.ts and workbench node_modules required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa06-t1-2-');
    t.after(() => ws.cleanup());

    const workbenchPort = await allocatePort();
    const inferencePort = await allocatePort();
    const controlPort = await allocatePort();
    const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
    const nextDist = `.next-e2e-cli-${process.pid}-${Date.now()}`;
    const nextDistAbs = path.join(workbenchDir, nextDist);
    const tsconfigPath = path.join(workbenchDir, 'tsconfig.json');

    const nodeBin = resolveNode22Plus();
    const cliAbs = path.join(REPO_ROOT, cliRel!);
    const cliEnv = {
      ...ws.env,
      WORKBENCH_PORT: String(workbenchPort),
      INFERENCE_PORT: String(inferencePort),
      CONTROL_PORT: String(controlPort),
      WORKBENCH_NEXT_DIST: nextDist,
      WORKBENCH_MOCK_GPUS: '[]',
      NODE_ENV: 'development',
    };

    t.after(async () => {
      await runCommand(nodeBin, [cliAbs, 'stop'], { env: cliEnv, timeoutMs: 8_000 }).catch(
        () => {},
      );
      await rm(nextDistAbs, { recursive: true, force: true }).catch(() => {});
      await withWorkbenchTsconfigLock(() => stripE2eNextFromTsconfig(tsconfigPath)).catch(() => {});
    });

    const startRes = await withWorkbenchTsconfigLock(async () => {
      const res = await runCommand(nodeBin, [cliAbs, 'start'], { env: cliEnv, timeoutMs: 30_000 });
      await stripE2eNextFromTsconfig(tsconfigPath);
      return res;
    });
    assert.equal(startRes.code, 0, `${startRes.stdout}\n${startRes.stderr}`);

    const statusRes = await runCommand(nodeBin, [cliAbs, 'status'], { env: cliEnv });
    assert.equal(statusRes.code, 0, statusRes.stderr);

    const logsRes = await runCommand(nodeBin, [cliAbs, 'logs'], { env: cliEnv });
    assert.equal(logsRes.code, 0, logsRes.stderr);
    assert.ok(logsRes.stdout.trim().length > 0, 'CLI logs must return non-empty output');

    const stopRes = await runCommand(nodeBin, [cliAbs, 'stop'], { env: cliEnv });
    assert.equal(stopRes.code, 0, stopRes.stderr);

    const afterStop = await runCommand(nodeBin, [cliAbs, 'status'], {
      env: cliEnv,
      timeoutMs: 5_000,
    });
    assert.notEqual(afterStop.code, 0, 'Status must fail after stop');
  });

  it('fa06.t1.3 Node CLI engine list & scheduler subcommands run without starting GPUs', async (t) => {
    const cliRel = await getM2CliEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(cliRel),
        'Pending M2 (Feature #17): platforms/workbench/cli.ts not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa06-t1-3-');
    t.after(() => ws.cleanup());

    const mockControl = http.createServer((req, res) => {
      if (req.url?.startsWith('/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            current: null,
            leased: false,
            active_leases: 0,
            queued: 0,
            switching: false,
            draining: false,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      mockControl.listen({ port: 0, host: '127.0.0.1' }, resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve) => {
          mockControl.closeAllConnections();
          mockControl.close(() => resolve());
        }),
    );

    const port = (mockControl.address() as AddressInfo).port;
    const nodeBin = resolveNode22Plus();
    const cliAbs = path.join(REPO_ROOT, cliRel!);

    const engineList = await runCommand(nodeBin, [cliAbs, 'engine', 'list'], { env: ws.env });
    assert.equal(engineList.code, 0, engineList.stderr);
    assert.ok(engineList.stdout.trim().length > 0);

    const schedulerRes = await runCommand(nodeBin, [cliAbs, 'scheduler', 'status'], {
      env: { ...ws.env, CONTROL_PORT: String(port) },
    });
    assert.equal(schedulerRes.code, 0, schedulerRes.stderr);
    assert.ok(schedulerRes.stdout.trim().length > 0);
  });

  it('fa06.t1.4 Node CLI service install and status invoke OS service manager safely via isolated PATH shims', async (t) => {
    const cliRel = await getM2CliEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(cliRel),
        'Pending M2 (Feature #17): platforms/workbench/cli.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa06-t1-4-');
    t.after(() => ws.cleanup());

    const binDir = path.join(ws.rootDir, 'bin');
    await mkdir(binDir, { recursive: true });
    const shimLogPath = path.join(ws.rootDir, 'service-shim.jsonl');
    const recorderJs = path.join(binDir, 'record-service-shim.mjs');
    const nodeBin = resolveNode22Plus();

    await writeFile(
      recorderJs,
      [
        `import { appendFileSync } from 'node:fs';`,
        `const tool = process.argv[2];`,
        `const args = process.argv.slice(3);`,
        `appendFileSync(${JSON.stringify(shimLogPath)}, JSON.stringify({ tool, args }) + '\\n', 'utf8');`,
        `if (tool === 'schtasks' && args.includes('/Query')) process.stdout.write('Status: Ready\\n');`,
        `if (tool === 'systemctl' && args.includes('is-active')) process.stdout.write('active\\n');`,
        `if (tool === 'launchctl' && args[0] === 'print') process.stdout.write('state = running\\n');`,
      ].join('\n'),
      'utf8',
    );

    const serviceEnv: Record<string, string | undefined> = {
      ...ws.env,
      HOME: ws.rootDir,
      USERPROFILE: ws.rootDir,
      XDG_CONFIG_HOME: ws.configDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    };

    if (process.platform === 'win32') {
      await writeFile(
        path.join(binDir, 'schtasks.cmd'),
        `@echo off\r\n"${nodeBin}" "${recorderJs}" schtasks %*\r\n`,
        'utf8',
      );
      // On Windows, service-install.ts calls execFile('schtasks.exe', ...) directly, which skips
      // .cmd shims and searches System32 before PATH; route schtasks.exe to binDir/schtasks.cmd.
      const preloadPath = path.join(ws.rootDir, 'schtasks-shim-preload.mjs');
      await writeFile(
        preloadPath,
        [
          `import cp from 'node:child_process';`,
          `import { existsSync } from 'node:fs';`,
          `import { syncBuiltinESMExports } from 'node:module';`,
          `import { join } from 'node:path';`,
          `const origExecFile = cp.execFile;`,
          `const customPromisify = Symbol.for('nodejs.util.promisify.custom');`,
          `function resolveCmdShim(file, env) {`,
          `  const pathVar = (env && (env.PATH || env.Path)) || process.env.PATH || '';`,
          `  const base = file.replace(/\\.exe$/i, '');`,
          `  for (const dir of pathVar.split(';').filter(Boolean)) {`,
          `    const candidate = join(dir, base + '.cmd');`,
          `    if (existsSync(candidate)) return candidate;`,
          `  }`,
          `  return null;`,
          `}`,
          `function patchedExecFile(file, args, options, callback) {`,
          `  if (typeof options === 'function') { callback = options; options = undefined; }`,
          `  if (typeof args === 'function') { callback = args; args = []; options = undefined; }`,
          `  if (typeof file === 'string' && /schtasks(\\.exe)?$/i.test(file)) {`,
          `    const cmdShim = resolveCmdShim(file, options?.env);`,
          `    if (!cmdShim) throw new Error('Isolated schtasks.cmd shim not found in PATH');`,
          `    const comspec = (options?.env?.ComSpec) || process.env.ComSpec || 'cmd.exe';`,
          `    return origExecFile.call(cp, comspec, ['/d', '/c', cmdShim, ...(args || [])], options, callback);`,
          `  }`,
          `  return origExecFile.call(cp, file, args, options, callback);`,
          `}`,
          `patchedExecFile[customPromisify] = (file, args, options) => new Promise((resolve, reject) => {`,
          `  patchedExecFile(file, args, options, (err, stdout, stderr) => {`,
          `    if (err) reject(err); else resolve({ stdout, stderr });`,
          `  });`,
          `});`,
          `cp.execFile = patchedExecFile;`,
          `syncBuiltinESMExports();`,
        ].join('\n'),
        'utf8',
      );
      const importFlag = `--import=${pathToFileURL(preloadPath).href}`;
      serviceEnv.NODE_OPTIONS = process.env.NODE_OPTIONS
        ? `${process.env.NODE_OPTIONS} ${importFlag}`
        : importFlag;
    } else {
      for (const tool of ['systemctl', 'launchctl']) {
        const shPath = path.join(binDir, tool);
        await writeFile(
          shPath,
          `#!/bin/sh\nexec "${nodeBin}" "${recorderJs}" ${tool} "$@"\n`,
          'utf8',
        );
        await chmod(shPath, 0o755);
      }
    }

    const cliAbs = path.join(REPO_ROOT, cliRel!);
    const installRes = await runCommand(nodeBin, [cliAbs, 'service', 'install'], {
      env: serviceEnv,
    });
    assert.equal(installRes.code, 0, installRes.stderr);
    const installJson = JSON.parse(installRes.stdout) as {
      platform: string;
      manager: string;
      installed: boolean;
      unitPath: string;
      detail: string;
    };
    assert.equal(installJson.installed, true);
    assert.ok(installJson.unitPath.length > 0);

    const statusRes = await runCommand(nodeBin, [cliAbs, 'service', 'status'], {
      env: serviceEnv,
    });
    assert.equal(statusRes.code, 0, statusRes.stderr);
    const statusJson = JSON.parse(statusRes.stdout) as {
      installed: boolean;
      manager: string;
      unitPath: string;
    };
    assert.equal(statusJson.installed, true);
    assert.equal(statusJson.manager, installJson.manager);
    assert.equal(statusJson.unitPath, installJson.unitPath);

    const logLines = (await readFile(shimLogPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { tool: string; args: string[] });
    assert.ok(logLines.length >= 2, 'Expected recording shim invocations for install and status');

    if (process.platform === 'win32') {
      assert.equal(installJson.manager, 'schtasks');
      assert.equal(installJson.unitPath, 'VramDeckGateway');
      assert.ok(
        logLines.some(
          (entry) =>
            entry.tool === 'schtasks' &&
            entry.args.includes('/Create') &&
            entry.args.includes('VramDeckGateway'),
        ),
      );
      assert.ok(
        logLines.some(
          (entry) =>
            entry.tool === 'schtasks' &&
            entry.args.includes('/Query') &&
            entry.args.includes('VramDeckGateway'),
        ),
      );
    } else if (process.platform === 'linux') {
      assert.equal(installJson.manager, 'systemd');
      const unitContent = await readFile(installJson.unitPath, 'utf8');
      assert.match(unitContent, /server\.mjs/);
      assert.ok(
        logLines.some(
          (entry) => entry.tool === 'systemctl' && entry.args.includes('vramdeck.service'),
        ),
      );
    } else if (process.platform === 'darwin') {
      assert.equal(installJson.manager, 'launchd');
      const plistContent = await readFile(installJson.unitPath, 'utf8');
      assert.match(plistContent, /io\.vramdeck\.gateway/);
      assert.ok(logLines.some((entry) => entry.tool === 'launchctl'));
    }
  });

  it('fa06.t1.5 .workbench/cli.py and ./lab compatibility commands list engines and models cleanly', async () => {
    const cliPy = path.join(REPO_ROOT, '.workbench/cli.py');

    for (const args of [
      ['--help'],
      ['engines'],
      ['engine', 'list'],
      ['models', 'pation-model-qwen38-27b-w3a4'],
    ]) {
      const res = await runCommand('python', [cliPy, ...args]);
      assert.equal(
        res.code,
        0,
        `python .workbench/cli.py ${args.join(' ')} failed:\n${res.stderr}`,
      );
      assert.ok(res.stdout.trim().length > 0);
    }

    const enginesRes = await runCommand('python', [cliPy, 'engines']);
    assert.match(enginesRes.stdout, /pation-model-qwen38-27b-w3a4/);
    assert.match(enginesRes.stdout, /anima/);

    if (process.platform !== 'win32') {
      const labRes = await runCommand(path.join(REPO_ROOT, 'lab'), ['--help']);
      assert.equal(labRes.code, 0, labRes.stderr);
    }
  });
});
