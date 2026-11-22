import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  allocatePort,
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { runCommand, spawnManagedProcess } from '../lib/process-runner.ts';

async function getActiveCliEntry(): Promise<string> {
  return (
    (await findFirstExisting(['platforms/workbench/cli.mjs'])) ?? 'platforms/workbench/cli.mjs'
  );
}

async function getM2CliEntry(): Promise<string | null> {
  const hasCliTs = await deliverableExists('platforms/workbench/cli.ts');
  if (!hasCliTs) return null;
  return findFirstExisting(['platforms/workbench/cli.mjs']);
}

describe('FA6 Tier 2: Node CLI & ./lab boundary / negative tests', () => {
  it('fa06.t2.1 Node CLI stop and restart refuse when control plane holds active lease/switch/queue', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa06-t2-1-');
    t.after(() => ws.cleanup());

    let mode: 'leased' | 'switching' | 'queued' = 'leased';
    const mockControl = http.createServer((req, res) => {
      if (req.url?.startsWith('/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            leased: mode === 'leased',
            switching: mode === 'switching',
            queued: mode === 'queued' ? 1 : 0,
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

    for (const variant of ['leased', 'switching', 'queued'] as const) {
      mode = variant;
      for (const action of ['stop', 'restart']) {
        const res = await runCommand(nodeBin, [cliAbs, action], {
          env: { ...ws.env, CONTROL_PORT: String(port) },
          timeoutMs: 5_000,
        });
        assert.notEqual(res.code, 0, `${action} must fail when ${variant}`);
        assert.match(res.stderr + res.stdout, /Active\/queued work|wait before stopping/i);
      }
    }
  });

  it('fa06.t2.2 Node CLI stop refuses stale or foreign PID in server.pid', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa06-t2-2-');
    t.after(() => ws.cleanup());

    const nodeBin = resolveNode22Plus();
    const bystander = spawnManagedProcess(nodeBin, ['-e', 'setInterval(() => {}, 1000)']);
    t.after(() => bystander.stop());

    await writeFile(path.join(ws.dataDir, 'server.pid'), String(bystander.pid), 'utf8');
    const unusedPort = await allocatePort();

    const mockControl = http.createServer((req, res) => {
      if (req.url?.startsWith('/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ leased: false, switching: false, queued: 0 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      mockControl.listen({ port: unusedPort, host: '127.0.0.1' }, resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve) => {
          mockControl.closeAllConnections();
          mockControl.close(() => resolve());
        }),
    );

    const cliAbs = path.join(REPO_ROOT, cliRel!);
    const res = await runCommand(nodeBin, [cliAbs, 'stop'], {
      env: { ...ws.env, CONTROL_PORT: String(unusedPort) },
      timeoutMs: 5_000,
    });
    assert.notEqual(res.code, 0, 'stop must refuse foreign PID');
    assert.equal(bystander.exited(), false, 'Foreign process must remain alive');
  });

  it('fa06.t2.3 Node CLI rejects unknown subcommands and missing arguments with usage error', async () => {
    const cliRel = await getActiveCliEntry();
    const nodeBin = resolveNode22Plus();
    const cliAbs = path.join(REPO_ROOT, cliRel);

    const bogus = await runCommand(nodeBin, [cliAbs, 'bogus-cmd'], { timeoutMs: 5_000 });
    assert.notEqual(bogus.code, 0);
    assert.match(bogus.stderr + bogus.stdout, /Usage:/i);

    const missingRun = await runCommand(nodeBin, [cliAbs, 'run', 'llm'], { timeoutMs: 5_000 });
    assert.notEqual(missingRun.code, 0);
    assert.ok((missingRun.stderr + missingRun.stdout).trim().length > 0);
  });

  it('fa06.t2.4 Node CLI status against unreachable control port fails cleanly without hanging', async (t) => {
    const cliRel = await getActiveCliEntry();
    const nodeBin = resolveNode22Plus();
    const cliAbs = path.join(REPO_ROOT, cliRel);

    const ws = await createIsolatedWorkspace('fa06-t2-4-');
    t.after(() => ws.cleanup());
    const unusedPort = await allocatePort();
    const res = await runCommand(nodeBin, [cliAbs, 'status'], {
      env: { ...ws.env, CONTROL_PORT: String(unusedPort) },
      timeoutMs: 5_000,
    });
    assert.notEqual(res.code, 0);
    assert.ok(res.durationMs < 5_000);
  });

  it('fa06.t2.5 .workbench/cli.py rejects invalid engine enable target and unknown models cleanly', async () => {
    const cliPy = path.join(REPO_ROOT, '.workbench/cli.py');

    const badEnable = await runCommand('python', [cliPy, 'engine', 'enable', 'nonexistent-pkg']);
    assert.equal(badEnable.code, 1);
    assert.ok(badEnable.stderr.trim().length > 0);

    const badModels = await runCommand('python', [cliPy, 'models', 'nonexistent-pkg']);
    assert.equal(badModels.code, 1);
    assert.ok(badModels.stderr.trim().length > 0);
  });
});
