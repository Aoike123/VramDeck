import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  linkLocalModel,
  matchEngines,
  recommendModels,
  resolveMirrorUrl,
} from '../lib/hub/catalog.ts';
import { downloadArtifact } from '../lib/hub/downloader.ts';
import { adoptExternalService, scanLocalServices } from '../lib/hub/scanner.ts';
import { hubRoutes } from '../lib/hub-routes.ts';
import type { HardwareSnapshot } from '../lib/types.ts';

function snap(overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot {
  return {
    collected_at: Date.now(),
    gpus: overrides.gpus ?? [
      {
        id: 'nvidia:0',
        index: 0,
        vendor: 'nvidia',
        backend: 'cuda',
        name: 'RTX 4090',
        unified_memory: false,
        vram_total_mb: 24576,
        vram_used_mb: 0,
        vram_free_mb: 24576,
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
      },
    ],
    host: overrides.host ?? {
      os: 'linux',
      arch: 'x64',
      ram_total_mb: 65536,
      ram_free_mb: 49152,
    },
  };
}

test('Hub scanner detects local Ollama and OpenAI servers while ignoring unreachable/garbage ports', async () => {
  const ollama = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const garbage = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('{broken-json');
  });
  await Promise.all([
    new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r())),
    new Promise<void>((r) => garbage.listen(0, '127.0.0.1', () => r())),
  ]);
  const ollamaPort = (ollama.address() as { port: number }).port;
  const garbagePort = (garbage.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(tmpdir(), 'hub-scan-'));

  try {
    const found = await scanLocalServices({
      targets: [
        { kind: 'ollama', url: `http://127.0.0.1:${ollamaPort}`, port: ollamaPort },
        { kind: 'ollama', url: `http://127.0.0.1:${garbagePort}`, port: garbagePort },
      ],
      timeoutMs: 1000,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'ollama');
    assert.deepEqual(found[0].models, ['qwen2.5:7b']);

    const adopted = await adoptExternalService(found[0], {
      enginesDir: path.join(dir, 'engines'),
      dataDir: dir,
    });
    assert.equal(adopted.manifest.platform.runtime.driver, 'external');
    assert.equal(existsSync(adopted.path!), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await Promise.all([
      new Promise<void>((r) => ollama.close(() => r())),
      new Promise<void>((r) => garbage.close(() => r())),
    ]);
  }
});

test('Hub catalog matches OS/backend, computes fits/tight/too_large, resolves mirrors, and validates local links', async () => {
  const apple = matchEngines({
    snapshot: snap({
      gpus: [
        {
          id: 'apple:0',
          index: 0,
          vendor: 'apple',
          backend: 'metal',
          name: 'M3 Max',
          unified_memory: true,
          vram_total_mb: 65536,
          vram_used_mb: 0,
          vram_free_mb: 49152,
          utilization_pct: null,
          temperature_c: null,
          power_w: null,
        },
      ],
      host: { os: 'darwin', arch: 'arm64', ram_total_mb: 65536, ram_free_mb: 49152 },
    }),
    os: 'darwin',
    arch: 'arm64',
  });
  assert.ok(apple.some((e) => e.backends.includes('metal')));
  assert.ok(!apple.some((e) => e.pack === 'rocm-pro'));

  const recs12g = recommendModels({ vramFreeMb: 12288 });
  assert.ok(recs12g.some((m) => m.fit === 'fits'));
  assert.ok(recs12g.some((m) => m.fit === 'tight'));
  assert.ok(recs12g.some((m) => m.fit === 'too_large'));

  assert.match(
    resolveMirrorUrl({ mirror: 'hf-mirror', repo: 'Qwen/Qwen2.5-7B-GGUF', file: 'm.gguf' }),
    /hf-mirror\.com/,
  );
  assert.match(
    resolveMirrorUrl({ mirror: 'modelscope', repo: 'Qwen/Qwen2.5-7B-GGUF', file: 'm.gguf' }),
    /modelscope/,
  );

  const dir = await mkdtemp(path.join(tmpdir(), 'hub-link-'));
  try {
    await mkdir(path.join(dir, 'ok'), { recursive: true });
    await writeFile(path.join(dir, 'ok', 'model.gguf'), 'stub');
    const linked = await linkLocalModel({
      id: 'local-ok',
      engine_id: 'llama-cpp',
      dir: path.join(dir, 'ok'),
      dataDir: dir,
    });
    assert.deepEqual(linked.files, ['model.gguf']);
    await assert.rejects(() =>
      linkLocalModel({ id: '../bad', engine_id: 'llama-cpp', dir: path.join(dir, 'ok') }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hub downloader supports Range 206 resume and rejects SHA256 mismatch without leaving .part', async () => {
  const payload = Buffer.alloc(32768);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const sha = createHash('sha256').update(payload).digest('hex');

  const srv = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-$/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const slice = payload.subarray(start);
      res.writeHead(206, {
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'hub-dl-'));

  try {
    const dest = path.join(dir, 'ok.gguf');
    await writeFile(`${dest}.part`, payload.subarray(0, 8192));
    const progress = await downloadArtifact({
      url: `${base}/ok.gguf`,
      destination: dest,
      sha256: sha,
    });
    assert.equal(progress.status, 'completed');
    assert.equal(
      createHash('sha256')
        .update(await readFile(dest))
        .digest('hex'),
      sha,
    );
    assert.equal(existsSync(`${dest}.part`), false);

    const badDest = path.join(dir, 'bad.gguf');
    await assert.rejects(
      () =>
        downloadArtifact({
          url: `${base}/bad.gguf`,
          destination: badDest,
          sha256: '0'.repeat(64),
        }),
      /SHA256 checksum mismatch/i,
    );
    assert.equal(existsSync(badDest), false);
    assert.equal(existsSync(`${badDest}.part`), false);

    // Hub routes smoke check
    const handler = hubRoutes({ dataDir: dir });
    const hubSrv = http.createServer(handler);
    await new Promise<void>((r) => hubSrv.listen(0, '127.0.0.1', () => r()));
    const hubPort = (hubSrv.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${hubPort}/api/hub/catalog`);
      assert.equal(r.status, 200);
      const data = (await r.json()) as { engines: unknown[]; models: unknown[] };
      assert.ok(data.engines.length > 0 && data.models.length > 0);
    } finally {
      await new Promise<void>((r) => hubSrv.close(() => r()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
