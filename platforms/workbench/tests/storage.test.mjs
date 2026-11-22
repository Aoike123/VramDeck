import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore } from '../lib/media-store.mjs';
import {
  STORAGE,
  artifactsOnline,
  artifactsRoot,
  autoRoot,
  importRoots,
  requireArtifacts,
  stateRoot,
} from '../lib/storage.mjs';

test('job outputs are filed by kind and month; transcripts stay with the audio tool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new MediaStore({ root, minFreeBytes: 0 }).open(),
    created_at = '2026-11-02T08:00:00.000Z';
  assert.equal(
    store.outputDirectory({ job_id: 'job_a', kind: 'image', created_at }),
    join(root, 'images/2026-11/job_a'),
  );
  assert.equal(
    store.outputDirectory({ job_id: 'job_b', kind: 'video', created_at }),
    join(root, 'videos/2026-11/job_b'),
  );
  assert.equal(
    store.outputDirectory({ job_id: 'job_c', kind: 'text', created_at }),
    join(root, 'audio/2026-11/job_c'),
  );
  assert.equal(store.jobs, join(root, 'jobs'));
  assert.equal(store.assets, join(root, 'materials'));
});

test('an artifacts root without its marker is offline: the store opens, media requests get 503', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'state-')),
    artifacts = await mkdtemp(join(tmpdir(), 'artifacts-'));
  t.after(() =>
    Promise.all([
      rm(state, { recursive: true, force: true }),
      rm(artifacts, { recursive: true, force: true }),
    ]),
  );
  const store = await new MediaStore({
    state,
    artifacts,
    requireMarker: true,
    minFreeBytes: 0,
  }).open();
  await assert.rejects(
    store.quota(1),
    (e) => e.status === 503 && e.code === 'ARTIFACT_STORAGE_OFFLINE',
  );
  // The disk coming back needs no restart.
  await writeFile(join(artifacts, STORAGE.marker), '');
  await store.quota(1);
  assert.ok(store.measured);
});

test('auto storage resolves OS default, honors MEDIA_* overrides and enforces explicit marker', async (t) => {
  const prevState = process.env.MEDIA_STATE_ROOT;
  const prevArtifacts = process.env.MEDIA_ARTIFACTS_ROOT;
  const prevImport = process.env.MEDIA_IMPORT_ROOTS;
  t.after(() => {
    if (prevState === undefined) delete process.env.MEDIA_STATE_ROOT;
    else process.env.MEDIA_STATE_ROOT = prevState;
    if (prevArtifacts === undefined) delete process.env.MEDIA_ARTIFACTS_ROOT;
    else process.env.MEDIA_ARTIFACTS_ROOT = prevArtifacts;
    if (prevImport === undefined) delete process.env.MEDIA_IMPORT_ROOTS;
    else process.env.MEDIA_IMPORT_ROOTS = prevImport;
  });

  delete process.env.MEDIA_STATE_ROOT;
  delete process.env.MEDIA_ARTIFACTS_ROOT;
  delete process.env.MEDIA_IMPORT_ROOTS;

  assert.equal(STORAGE.artifacts, 'auto');
  assert.equal(artifactsRoot(), autoRoot('artifacts'));
  assert.ok(importRoots().includes(artifactsRoot()));

  const dir = await mkdtemp(join(tmpdir(), 'storage-override-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const customState = join(dir, 'state');
  const customArtifacts = join(dir, 'artifacts');
  const customImport = join(dir, 'extra-import');
  process.env.MEDIA_STATE_ROOT = customState;
  process.env.MEDIA_ARTIFACTS_ROOT = customArtifacts;
  process.env.MEDIA_IMPORT_ROOTS = customImport;

  assert.equal(stateRoot(), customState);
  assert.equal(artifactsRoot(), customArtifacts);
  assert.ok(importRoots().includes(customImport));
  assert.equal(artifactsOnline(), false);
  assert.throws(
    () => requireArtifacts(),
    (e) => e.status === 503 && e.code === 'ARTIFACT_STORAGE_OFFLINE',
  );

  const store = await new MediaStore({ minFreeBytes: 0 }).open();
  await assert.rejects(
    store.quota(1),
    (e) => e.status === 503 && e.code === 'ARTIFACT_STORAGE_OFFLINE',
  );
  const { mkdir } = await import('node:fs/promises');
  await mkdir(customArtifacts, { recursive: true });
  await writeFile(join(customArtifacts, STORAGE.marker), '');
  assert.equal(requireArtifacts(), customArtifacts);
});
