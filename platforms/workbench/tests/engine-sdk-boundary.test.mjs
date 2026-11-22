import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, containerStatus, enginePolicyKey, saveWav } from '../lib/engine-sdk.mjs';
import qwenAdapter from '../../../engines/llm/pation-model-qwen38-27b-w3a4/adapter.mjs';

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'upstream' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(mjs|ts|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test('engines only import platforms/workbench/lib/engine-sdk.{mjs,ts}', async () => {
  const files = await walk(join(ROOT, 'engines'));
  assert.ok(files.length > 0);
  const violations = [];
  const patterns = [
    /from\s+['"]([^'"]*platforms\/workbench\/lib\/[^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]*platforms\/workbench\/lib\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]*platforms\/workbench\/lib\/[^'"]+)['"]\s*\)/g,
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const target = match[1];
        if (
          !target.endsWith('platforms/workbench/lib/engine-sdk.mjs') &&
          !target.endsWith('platforms/workbench/lib/engine-sdk.ts')
        ) {
          violations.push(`${file}: ${target}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('saveWav handles concurrent writes to the same file without temp-file collisions or leaks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-sdk-wav-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const samples = 4410;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(88200, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  const encoded = buf.toString('base64');
  const out = join(dir, 'same.wav');

  const results = await Promise.all(Array.from({ length: 10 }, () => saveWav(out, encoded)));
  for (const meta of results) {
    assert.equal(meta.sample_rate, 44100);
    assert.equal(meta.channels, 1);
    assert.equal(meta.duration_seconds, 0.1);
  }
  assert.deepEqual(await readFile(out), buf);
  assert.deepEqual(await readdir(dir), ['same.wav']);

  await assert.rejects(saveWav(join(dir, 'missing', 'fail.wav'), encoded), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dir), ['same.wav']);
});

test('engine-sdk exports enginePolicyKey and containerStatus with mock fallback', async () => {
  assert.equal(typeof enginePolicyKey, 'function');
  const key = enginePolicyKey({
    context_tokens: 65536,
    concurrency: 2,
    kv_budget_bytes: 8859648000,
    eager: false,
  });
  assert.equal(key, '65536:2:bf16:8859648000:graph');

  let calledWith = null;
  const ctxWithMethod = {
    runtime: { container: 'c1' },
    backend: {
      async containerStatus(name) {
        calledWith = name;
        return 'running';
      },
    },
  };
  assert.equal(await containerStatus(ctxWithMethod), 'running');
  assert.equal(calledWith, 'c1');

  const ctxFallback = {
    runtime: { container: 'c2' },
    backend: {
      async run(bin, args) {
        assert.equal(bin, 'docker');
        assert.deepEqual(args, ['inspect', '--format', '{{.State.Status}}', 'c2']);
        return 'exited';
      },
    },
  };
  assert.equal(await containerStatus(ctxFallback), 'exited');
});

test('qwen38 adapter startupCheck uses containerStatus cleanly', async () => {
  await qwenAdapter.startupCheck({
    runtime: { container: 'paiton-qwen38' },
    backend: {
      labelled: async () => true,
      containerStatus: async () => 'running',
    },
  });
  await assert.rejects(
    qwenAdapter.startupCheck({
      runtime: { container: 'paiton-qwen38' },
      backend: {
        labelled: async () => true,
        containerStatus: async () => 'exited',
      },
    }),
    /Resident LLM exited during startup/,
  );
});
