import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
  withEnv,
} from '../lib/env.ts';
import { createPlatformConfig } from '../lib/fixtures.ts';
import { runCommand, spawnManagedProcess } from '../lib/process-runner.ts';

async function loadProcessLock(): Promise<{
  acquireProcessLock: (lockPath: string) => Promise<() => Promise<void>>;
}> {
  const rel =
    (await findFirstExisting([
      'platforms/workbench/lib/platform/process-lock.ts',
      'platforms/workbench/lib/platform/process-lock.mjs',
      'platforms/workbench/lib/process-lock.mjs',
    ])) ?? 'platforms/workbench/lib/process-lock.mjs';
  return (await import(pathToFileURL(path.join(REPO_ROOT, rel)).href)) as {
    acquireProcessLock: (lockPath: string) => Promise<() => Promise<void>>;
  };
}

function createMinimalPcmWavBase64(sampleCount = 64): string {
  const dataBytes = sampleCount * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf.toString('base64');
}

describe('FA1 Tier 1: Cross-platform primitives & auto storage', () => {
  it('fa01.t1.1 acquires independent process locks, releases idempotently, and re-acquires', async (t) => {
    const ws = await createIsolatedWorkspace('fa01-t1-1-');
    t.after(() => ws.cleanup());

    const { acquireProcessLock } = await loadProcessLock();
    const lockA = path.join(ws.dataDir, 'lock-a.lock');
    const lockB = path.join(ws.dataDir, 'lock-b.lock');

    const releaseA = await acquireProcessLock(lockA);
    const releaseB = await acquireProcessLock(lockB);

    await assert.rejects(() => acquireProcessLock(lockA), /already running/i);

    await releaseA();
    await releaseA();

    const reacquiredA = await acquireProcessLock(lockA);
    await reacquiredA();
    await releaseB();
  });

  it('fa01.t1.2 releases process lock cleanly when owning subprocess is terminated', async (t) => {
    const ws = await createIsolatedWorkspace('fa01-t1-2-');
    t.after(() => ws.cleanup());

    const lockRel =
      (await findFirstExisting([
        'platforms/workbench/lib/platform/process-lock.ts',
        'platforms/workbench/lib/platform/process-lock.mjs',
        'platforms/workbench/lib/process-lock.mjs',
      ])) ?? 'platforms/workbench/lib/process-lock.mjs';
    const lockUrl = pathToFileURL(path.join(REPO_ROOT, lockRel)).href;
    const lockPath = path.join(ws.dataDir, 'child-node.lock');

    const holderScript = [
      `import { acquireProcessLock } from ${JSON.stringify(lockUrl)};`,
      `await acquireProcessLock(${JSON.stringify(lockPath)});`,
      `console.log('LOCKED');`,
      `setInterval(() => {}, 1000);`,
    ].join('\n');

    const nodeBin = resolveNode22Plus();
    const child = spawnManagedProcess(nodeBin, ['--input-type=module', '-e', holderScript]);
    t.after(() => child.stop());

    const deadline = Date.now() + 8_000;
    while (!child.stdout().includes('LOCKED')) {
      if (child.exited()) {
        assert.fail(`Lock holder child exited early: ${child.stderr()}`);
      }
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for child lock acquisition: ${child.stderr()}`);
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    const { acquireProcessLock } = await loadProcessLock();
    await assert.rejects(() => acquireProcessLock(lockPath), /already running/i);

    await child.stop();

    const relock = await acquireProcessLock(lockPath);
    await relock();
  });

  it('fa01.t1.3 persists WAV and atomic JSON durably without leftover tmp files', async (t) => {
    const hasSharp = await deliverableExists('platforms/workbench/node_modules/sharp/package.json');
    if (
      !requireDeliverable(
        t,
        hasSharp,
        'M1 (Feature #9): platforms/workbench/node_modules (sharp) required for MediaStore/engine-sdk',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa01-t1-3-');
    t.after(() => ws.cleanup());

    const mediaStoreUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/media-store.mjs'),
    ).href;
    const sdkUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/engine-sdk.mjs'),
    ).href;

    const { atomic } = (await import(mediaStoreUrl)) as {
      atomic: (file: string, value: unknown) => Promise<void>;
    };
    const { saveWav } = (await import(sdkUrl)) as {
      saveWav: (
        file: string,
        encoded: string,
      ) => Promise<{ duration_seconds: number; sample_rate: number; channels: number }>;
    };

    const nestedJson = path.join(ws.stateDir, 'nested', 'dir', 'record.json');
    await atomic(nestedJson, { ok: true, brand: 'VramDeck' });
    const parsed = JSON.parse(await readFile(nestedJson, 'utf8')) as {
      ok: boolean;
      brand: string;
    };
    assert.deepEqual(parsed, { ok: true, brand: 'VramDeck' });

    const wavTarget = path.join(ws.artifactsDir, 'sample.wav');
    const wavInfo = await saveWav(wavTarget, createMinimalPcmWavBase64(1600));
    assert.equal(wavInfo.sample_rate, 16000);
    assert.equal(wavInfo.channels, 1);
    assert.equal(wavInfo.duration_seconds, 0.1);
    const wavStat = await stat(wavTarget);
    assert.ok(wavStat.size > 44);
    await assert.rejects(() => stat(`${wavTarget}.tmp`));
  });

  it('fa01.t1.4 openImport reads valid files inside allowed roots including mixed-case Windows roots', async (t) => {
    const ws = await createIsolatedWorkspace('fa01-t1-4-');
    t.after(() => ws.cleanup());

    const clientUrl = pathToFileURL(path.join(REPO_ROOT, 'platforms/mcp/client.mjs')).href;
    const { openImport } = (await import(clientUrl)) as {
      openImport: (
        filePath: string,
        roots: string[],
      ) => Promise<{ readFile: () => Promise<Buffer>; close: () => Promise<void> }>;
    };

    const allowedDir = path.join(ws.rootDir, 'AllowedRoot');
    await mkdir(allowedDir, { recursive: true });
    const targetFile = path.join(allowedDir, 'input.txt');
    const expected = Buffer.from('VramDeck-import-payload-123', 'utf8');
    await writeFile(targetFile, expected);

    const handle = await openImport(targetFile, [allowedDir]);
    try {
      const actual = await handle.readFile();
      assert.deepEqual(actual, expected);
    } finally {
      await handle.close();
    }

    const mixedDir = path.join(ws.rootDir, 'MixedCaseRoot');
    await mkdir(mixedDir, { recursive: true });
    const mixedTarget = path.join(mixedDir, 'CaseFile.txt');
    await writeFile(mixedTarget, expected);

    if (process.platform === 'win32') {
      for (const rootVariant of [mixedDir.toLowerCase(), mixedDir.toUpperCase()]) {
        const winHandle = await openImport(mixedTarget, [rootVariant]);
        try {
          assert.deepEqual(await winHandle.readFile(), expected);
        } finally {
          await winHandle.close();
        }
      }
    } else {
      await assert.rejects(() => openImport(mixedTarget, [mixedDir.toLowerCase()]), /outside/i);
    }
  });

  it('fa01.t1.5 host RAM and VRAM fallback resolve cross-platform without ENOENT', async () => {
    const devicesRel = await findFirstExisting([
      'platforms/workbench/lib/devices/index.ts',
      'platforms/workbench/lib/devices/index.mjs',
    ]);
    if (devicesRel) {
      const devicesUrl = pathToFileURL(path.join(REPO_ROOT, devicesRel)).href;
      const mod = (await import(devicesUrl)) as {
        detectHardware?: () => Promise<{
          host: { ram_total_mb: number; ram_free_mb: number };
          gpus: Array<{ vram_total_mb: number }>;
        }>;
        createDeviceProvider?: () => {
          detect: () => Promise<{
            host: { ram_total_mb: number; ram_free_mb: number };
            gpus: Array<{ vram_total_mb: number }>;
          }>;
        };
      };
      const snapshot = mod.detectHardware
        ? await mod.detectHardware()
        : await mod.createDeviceProvider!().detect();
      assert.ok(
        Number.isFinite(snapshot.host.ram_total_mb) && snapshot.host.ram_total_mb > 0,
        `Expected positive host RAM, got ${snapshot.host.ram_total_mb}`,
      );
      assert.ok(
        Number.isFinite(snapshot.host.ram_free_mb) && snapshot.host.ram_free_mb >= 0,
        `Expected non-negative free RAM, got ${snapshot.host.ram_free_mb}`,
      );
      return;
    }

    const backendUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/backend.mjs'),
    ).href;
    const { Backend } = (await import(backendUrl)) as {
      Backend: new () => { memory: () => Promise<number>; vram: () => Promise<number> };
    };
    const backend = new Backend();
    const mem = await backend.memory();
    const vram = await backend.vram();

    assert.equal(typeof mem, 'number');
    assert.ok(Number.isFinite(mem) && mem > 0, `Expected finite positive RAM, got ${mem}`);
    assert.equal(typeof vram, 'number');
    assert.ok(Number.isFinite(vram) && vram >= 0, `Expected non-negative VRAM, got ${vram}`);
  });

  it('fa01.t1.6 resolves auto storage roots, honors MEDIA_* overrides, and parses platform.json', async (t) => {
    const ws = await createIsolatedWorkspace('fa01-t1-6-');
    t.after(() => ws.cleanup());

    const platformRaw = await readFile(path.join(REPO_ROOT, 'platforms/platform.json'), 'utf8');
    const platformJson = JSON.parse(platformRaw) as {
      storage: { state: string; artifacts: string; marker: string; import_roots: string[] };
    };
    assert.equal(platformJson.storage.artifacts, 'auto');
    assert.ok(platformJson.storage.import_roots.includes('auto'));
    assert.ok(!platformRaw.includes('/media/aoike/'), 'platform.json must not hardcode host paths');

    const storageUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/storage.mjs'),
    ).href;
    const storageMod = (await import(storageUrl)) as {
      autoRoot: (kind: string) => string;
      stateRoot: () => string;
      artifactsRoot: () => string;
      artifactsOnline: (root?: string) => boolean;
      requireArtifacts: () => string;
    };

    const autoState = storageMod.autoRoot('state');
    const autoArtifacts = storageMod.autoRoot('artifacts');
    assert.ok(path.isAbsolute(autoState), `autoRoot(state) must be absolute: ${autoState}`);
    assert.ok(
      path.isAbsolute(autoArtifacts),
      `autoRoot(artifacts) must be absolute: ${autoArtifacts}`,
    );
    assert.match(autoState.toLowerCase(), /vramdeck/);

    await withEnv(
      {
        MEDIA_STATE_ROOT: ws.stateDir,
        MEDIA_ARTIFACTS_ROOT: ws.artifactsDir,
      },
      async () => {
        assert.equal(path.resolve(storageMod.stateRoot()), path.resolve(ws.stateDir));
        assert.equal(path.resolve(storageMod.artifactsRoot()), path.resolve(ws.artifactsDir));
        assert.equal(storageMod.artifactsOnline(), true);
        assert.equal(path.resolve(storageMod.requireArtifacts()), path.resolve(ws.artifactsDir));
      },
    );

    const sampleCfg = createPlatformConfig();
    assert.equal((sampleCfg.storage as { artifacts: string }).artifacts, 'auto');

    const pyProbe = await runCommand(
      'python',
      [
        '-c',
        [
          'import json, sys',
          'sys.path.insert(0, ".workbench")',
          'import storage',
          'print(json.dumps({"state": str(storage.state()), "artifacts": str(storage.artifacts())}))',
        ].join('; '),
      ],
      {
        env: {
          MEDIA_STATE_ROOT: ws.stateDir,
          MEDIA_ARTIFACTS_ROOT: ws.artifactsDir,
        },
      },
    );
    assert.equal(pyProbe.code, 0, pyProbe.stderr);
    const pyPaths = JSON.parse(pyProbe.stdout) as { state: string; artifacts: string };
    assert.equal(path.resolve(pyPaths.state), path.resolve(ws.stateDir));
    assert.equal(path.resolve(pyPaths.artifacts), path.resolve(ws.artifactsDir));
  });
});
