import assert from 'node:assert/strict';
import { mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  withEnv,
} from '../lib/env.ts';
import { runCommand } from '../lib/process-runner.ts';

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

describe('FA1 Tier 2: Platform & storage boundary / negative tests', () => {
  it('fa01.t2.1 permits strictly 1 winner in a 20-way concurrent lock race', async (t) => {
    const ws = await createIsolatedWorkspace('fa01-t2-1-');
    t.after(() => ws.cleanup());

    const { acquireProcessLock } = await loadProcessLock();
    const lockPath = path.join(ws.dataDir, 'contested.lock');

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => acquireProcessLock(lockPath)),
    );
    const winners = attempts.filter(
      (res): res is PromiseFulfilledResult<() => Promise<void>> => res.status === 'fulfilled',
    );
    const losers = attempts.filter(
      (res): res is PromiseRejectedResult => res.status === 'rejected',
    );

    assert.equal(winners.length, 1, `Expected 1 lock winner, got ${winners.length}`);
    assert.equal(losers.length, 19);
    for (const loser of losers) {
      const msg = loser.reason instanceof Error ? loser.reason.message : String(loser.reason);
      assert.match(msg, /already running/i);
    }

    await winners[0].value();
  });

  it('fa01.t2.2 openImport rejects relative, outside-root, symlink/junction escape, directory, 0-byte, and >128 MiB', async (t) => {
    const ws = await createIsolatedWorkspace('fa01-t2-2-');
    t.after(() => ws.cleanup());

    const clientUrl = pathToFileURL(path.join(REPO_ROOT, 'platforms/mcp/client.mjs')).href;
    const { openImport } = (await import(clientUrl)) as {
      openImport: (filePath: string, roots: string[]) => Promise<{ close: () => Promise<void> }>;
    };

    const allowedRoot = path.join(ws.rootDir, 'allowed');
    const outsideRoot = path.join(ws.rootDir, 'outside');
    const subDir = path.join(allowedRoot, 'subdir');
    await mkdir(subDir, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });

    const outsideSecret = path.join(outsideRoot, 'secret.txt');
    await writeFile(outsideSecret, 'outside-secret', 'utf8');

    const emptyFile = path.join(allowedRoot, 'empty.bin');
    await writeFile(emptyFile, Buffer.alloc(0));

    const oversizedFile = path.join(allowedRoot, 'too-big.bin');
    const oversizedFd = await open(oversizedFile, 'w');
    try {
      await oversizedFd.truncate(128 * 1024 * 1024 + 1);
    } finally {
      await oversizedFd.close();
    }

    let escapeTarget: string;
    if (process.platform === 'win32') {
      const junctionDir = path.join(allowedRoot, 'escape-junction');
      await symlink(outsideRoot, junctionDir, 'junction');
      escapeTarget = path.join(junctionDir, 'secret.txt');
    } else {
      const fileLink = path.join(allowedRoot, 'escape-link.txt');
      await symlink(outsideSecret, fileLink);
      escapeTarget = fileLink;
    }

    await assert.rejects(() => openImport('relative/file.txt', [allowedRoot]), /absolute/i);
    await assert.rejects(() => openImport(outsideSecret, [allowedRoot]), /outside/i);
    await assert.rejects(() => openImport(escapeTarget, [allowedRoot]), /outside|symlink/i);
    await assert.rejects(() => openImport(subDir, [allowedRoot]), /regular file/i);
    await assert.rejects(() => openImport(emptyFile, [allowedRoot]), /nonempty|regular file/i);
    await assert.rejects(() => openImport(oversizedFile, [allowedRoot]), /128 MiB|regular file/i);
  });

  it('fa01.t2.3 returns 503 ARTIFACT_STORAGE_OFFLINE when marker missing and recovers once restored', async (t) => {
    const hasSharp = await deliverableExists('platforms/workbench/node_modules/sharp/package.json');
    if (
      !requireDeliverable(
        t,
        hasSharp,
        'M1 (Feature #9): platforms/workbench/node_modules (sharp) required for MediaStore',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa01-t2-3-', { withArtifactsMarker: false });
    t.after(() => ws.cleanup());

    const mediaStoreUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/media-store.mjs'),
    ).href;
    const { MediaStore } = (await import(mediaStoreUrl)) as {
      MediaStore: new (opts: Record<string, unknown>) => {
        open: () => Promise<unknown>;
        online: () => boolean;
        quota: (reserve?: number) => Promise<void>;
      };
    };

    const store = new MediaStore({
      state: ws.stateDir,
      artifacts: ws.artifactsDir,
      requireMarker: true,
      minFreeBytes: 0,
    });
    await store.open();
    assert.equal(store.online(), false);

    await assert.rejects(
      () => store.quota(1),
      (err: unknown) => {
        const e = err as { status?: number; code?: string };
        return e.status === 503 && e.code === 'ARTIFACT_STORAGE_OFFLINE';
      },
    );

    await writeFile(path.join(ws.artifactsDir, '.llm-backend-artifacts'), '', 'utf8');
    assert.equal(store.online(), true);
    await store.quota(1);
  });

  it('fa01.t2.4 enforces storage quota and minimum free space limits with HTTP 507', async (t) => {
    const hasSharp = await deliverableExists('platforms/workbench/node_modules/sharp/package.json');
    if (
      !requireDeliverable(
        t,
        hasSharp,
        'M1 (Feature #9): platforms/workbench/node_modules (sharp) required for MediaStore',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa01-t2-4-');
    t.after(() => ws.cleanup());

    const mediaStoreUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/media-store.mjs'),
    ).href;
    const { MediaStore } = (await import(mediaStoreUrl)) as {
      MediaStore: new (opts: Record<string, unknown>) => {
        open: () => Promise<unknown>;
        quota: (reserve?: number) => Promise<void>;
      };
    };

    const cappedStore = new MediaStore({
      state: ws.stateDir,
      artifacts: ws.artifactsDir,
      requireMarker: true,
      maxBytes: 100,
      minFreeBytes: 0,
    });
    await cappedStore.open();
    await assert.rejects(
      () => cappedStore.quota(101),
      (err: unknown) => (err as { status?: number }).status === 507,
    );

    const diskStore = new MediaStore({
      state: ws.stateDir,
      artifacts: ws.artifactsDir,
      requireMarker: true,
      maxBytes: Number.MAX_SAFE_INTEGER,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    await diskStore.open();
    await assert.rejects(
      () => diskStore.quota(1),
      (err: unknown) => (err as { status?: number }).status === 507,
    );
  });

  it('fa01.t2.5 saveWav rejects truncated, non-RIFF, and empty-data WAV payloads with ARTIFACT_INVALID', async (t) => {
    const hasSharp = await deliverableExists('platforms/workbench/node_modules/sharp/package.json');
    if (
      !requireDeliverable(
        t,
        hasSharp,
        'M1 (Feature #9): platforms/workbench/node_modules (sharp) required for engine-sdk',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa01-t2-5-');
    t.after(() => ws.cleanup());

    const sdkUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/engine-sdk.mjs'),
    ).href;
    const { saveWav } = (await import(sdkUrl)) as {
      saveWav: (file: string, encoded: string) => Promise<unknown>;
    };

    const outPath = path.join(ws.artifactsDir, 'bad.wav');
    const nonRiff = Buffer.alloc(64);
    nonRiff.write('NOPE', 0, 'ascii');

    const zeroData = Buffer.alloc(44);
    zeroData.write('RIFF', 0, 'ascii');
    zeroData.writeUInt32LE(36, 4);
    zeroData.write('WAVE', 8, 'ascii');
    zeroData.write('fmt ', 12, 'ascii');
    zeroData.writeUInt32LE(16, 16);
    zeroData.writeUInt16LE(1, 20);
    zeroData.writeUInt16LE(1, 22);
    zeroData.writeUInt32LE(16000, 24);
    zeroData.writeUInt32LE(32000, 28);
    zeroData.writeUInt16LE(2, 32);
    zeroData.writeUInt16LE(16, 34);
    zeroData.write('data', 36, 'ascii');
    zeroData.writeUInt32LE(0, 40);

    for (const payload of [
      Buffer.from('RIFF', 'ascii').toString('base64'),
      nonRiff.toString('base64'),
      zeroData.toString('base64'),
    ]) {
      await assert.rejects(
        () => saveWav(outPath, payload),
        (err: unknown) => (err as { code?: string }).code === 'ARTIFACT_INVALID',
      );
    }

    await assert.rejects(() => open(outPath, 'r'));
    await assert.rejects(() => open(`${outPath}.tmp`, 'r'));
  });

  it('fa01.t2.6 storage.mjs and .workbench/storage.py reject missing explicit marker and read UTF-8 cleanly', async (t) => {
    const ws = await createIsolatedWorkspace('fa01-t2-6-', { withArtifactsMarker: false });
    t.after(() => ws.cleanup());

    const storageUrl = pathToFileURL(
      path.join(REPO_ROOT, 'platforms/workbench/lib/storage.mjs'),
    ).href;
    const { requireArtifacts, artifactsOnline } = (await import(storageUrl)) as {
      requireArtifacts: () => string;
      artifactsOnline: () => boolean;
    };

    await withEnv(
      {
        MEDIA_STATE_ROOT: ws.stateDir,
        MEDIA_ARTIFACTS_ROOT: ws.artifactsDir,
      },
      async () => {
        assert.equal(artifactsOnline(), false);
        assert.throws(
          () => requireArtifacts(),
          (err: unknown) => {
            const e = err as { status?: number; code?: string };
            return e.status === 503 && e.code === 'ARTIFACT_STORAGE_OFFLINE';
          },
        );
      },
    );

    const pyResult = await runCommand(
      'python',
      [
        '-c',
        [
          'import sys',
          'sys.path.insert(0, ".workbench")',
          'import storage',
          'storage.artifacts(require=True)',
        ].join('; '),
      ],
      {
        env: {
          MEDIA_STATE_ROOT: ws.stateDir,
          MEDIA_ARTIFACTS_ROOT: ws.artifactsDir,
          PYTHONUTF8: '0',
          LC_ALL: 'C',
        },
      },
    );
    assert.notEqual(pyResult.code, 0, 'Expected Python storage.artifacts(require=True) to fail');
    assert.doesNotMatch(pyResult.stderr, /UnicodeDecodeError/);

    await rm(path.join(ws.artifactsDir, '.llm-backend-artifacts'), { force: true });
  });
});
