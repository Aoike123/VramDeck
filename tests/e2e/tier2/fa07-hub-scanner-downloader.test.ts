import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { DownloadProgress } from '../../../platforms/workbench/lib/types.ts';
import { assertDownloadProgress } from '../lib/assertions.ts';
import {
  allocatePort,
  createIsolatedWorkspace,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
} from '../lib/env.ts';
import { createMockHardwareSnapshot } from '../lib/fixtures.ts';
import { createMockArtifactDownloadServer, createMockOllamaServer } from '../lib/mock-servers.ts';

async function findHubModules(): Promise<{
  scanner: string | null;
  catalog: string | null;
  downloader: string | null;
}> {
  const [scanner, catalog, downloader] = await Promise.all([
    findFirstExisting([
      'platforms/workbench/lib/hub/scanner.ts',
      'platforms/workbench/lib/hub/scanner.mjs',
    ]),
    findFirstExisting([
      'platforms/workbench/lib/hub/catalog.ts',
      'platforms/workbench/lib/hub/catalog.mjs',
    ]),
    findFirstExisting([
      'platforms/workbench/lib/hub/downloader.ts',
      'platforms/workbench/lib/hub/downloader.mjs',
    ]),
  ]);
  return { scanner, catalog, downloader };
}

describe('FA7 Tier 2: Hub scanner/downloader failure, resume fallback & validation paths', () => {
  it('fa07.t2.1 rejects SHA256 mismatch, deletes/quarantines .part, and emits status: failed', async (t) => {
    const hub = await findHubModules();
    if (
      !requireDeliverable(
        t,
        Boolean(hub.downloader),
        'Pending M4 (Feature #19): platforms/workbench/lib/hub/downloader.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa07-t2-1-');
    t.after(() => ws.cleanup());

    const payload = Buffer.alloc(16384, 0x5a);
    const dlServer = await createMockArtifactDownloadServer({
      files: { '/models/corrupt.gguf': payload },
      corruptByteIndex: 128,
    });
    t.after(() => dlServer.close());

    const expectedSha = dlServer.digests['/models/corrupt.gguf'].sha256;
    const destPath = path.join(ws.dataDir, 'downloads', 'corrupt.gguf');
    const dlMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.downloader!)).href
    )) as Record<string, unknown>;
    const downloadFn = (dlMod.downloadArtifact ?? dlMod.downloadFile ?? dlMod.download) as (
      opts: Record<string, unknown>,
    ) => Promise<DownloadProgress>;

    const progressUpdates: DownloadProgress[] = [];
    let thrown: unknown = null;
    try {
      const res = await downloadFn({
        url: `${dlServer.base}/models/corrupt.gguf`,
        destination: destPath,
        dest: destPath,
        target: 'corrupt.gguf',
        sha256: expectedSha,
        onProgress(p: DownloadProgress) {
          assertDownloadProgress(p);
          progressUpdates.push(p);
        },
      });
      if (res) progressUpdates.push(res);
    } catch (err) {
      thrown = err;
    }

    const failed = progressUpdates.find((p) => p.status === 'failed');
    assert.ok(dlServer.requests.length >= 1, 'Expected download request to reach server');
    assert.ok(thrown || failed, 'SHA256 mismatch must fail or emit status=failed');
    const errText =
      failed?.error ?? (thrown instanceof Error ? thrown.message : String(thrown ?? ''));
    assert.match(
      errText,
      /sha256|checksum|digest|hash|mismatch|integrity/i,
      `Expected SHA256/checksum mismatch error message, got: ${errText}`,
    );
    assert.equal(
      existsSync(destPath),
      false,
      'Corrupted download must never be promoted to final path',
    );
    assert.equal(
      existsSync(`${destPath}.part`),
      false,
      'Corrupted .part temp file must be cleaned/quarantined',
    );
  });

  it('fa07.t2.2 falls back cleanly when server returns 200 instead of 206 on Range resume', async (t) => {
    const hub = await findHubModules();
    if (
      !requireDeliverable(
        t,
        Boolean(hub.downloader),
        'Pending M4 (Feature #19): platforms/workbench/lib/hub/downloader.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa07-t2-2-');
    t.after(() => ws.cleanup());

    const payload = Buffer.alloc(32768);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;

    const dlServer = await createMockArtifactDownloadServer({
      files: { '/models/no-range.gguf': payload },
      ignoreRange: true,
    });
    t.after(() => dlServer.close());

    const downloadsDir = path.join(ws.dataDir, 'downloads');
    await mkdir(downloadsDir, { recursive: true });
    const destPath = path.join(downloadsDir, 'no-range.gguf');
    // Seed a partial .part file so downloader sends Range and server responds 200
    await writeFile(`${destPath}.part`, payload.subarray(0, 4096));

    const dlMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.downloader!)).href
    )) as Record<string, unknown>;
    const downloadFn = (dlMod.downloadArtifact ?? dlMod.downloadFile ?? dlMod.download) as (
      opts: Record<string, unknown>,
    ) => Promise<DownloadProgress>;

    const expectedSha = dlServer.digests['/models/no-range.gguf'].sha256;
    const res = await downloadFn({
      url: `${dlServer.base}/models/no-range.gguf`,
      destination: destPath,
      dest: destPath,
      target: 'no-range.gguf',
      sha256: expectedSha,
    });
    assertDownloadProgress(res);
    assert.equal(res.status, 'completed');

    const finalBytes = await readFile(destPath);
    assert.equal(
      finalBytes.length,
      payload.length,
      '200 fallback must overwrite .part from offset 0',
    );
    assert.equal(createHash('sha256').update(finalBytes).digest('hex'), expectedSha);
  });

  it('fa07.t2.3 handles 416 Range Not Satisfiable, retry exhaustion, and cancellation cleanup', async (t) => {
    const hub = await findHubModules();
    if (
      !requireDeliverable(
        t,
        Boolean(hub.downloader),
        'Pending M4 (Feature #19): platforms/workbench/lib/hub/downloader.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa07-t2-3-');
    t.after(() => ws.cleanup());

    const dlMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.downloader!)).href
    )) as Record<string, unknown>;
    const downloadFn = (dlMod.downloadArtifact ?? dlMod.downloadFile ?? dlMod.download) as (
      opts: Record<string, unknown>,
    ) => Promise<DownloadProgress>;

    // Sub-test A: HTTP 416 Range Not Satisfiable (pre-seeded .part larger than total payload)
    const downloadsDir = path.join(ws.dataDir, 'downloads');
    await mkdir(downloadsDir, { recursive: true });
    const payload416 = Buffer.alloc(16384, 0x44);
    const server416 = await createMockArtifactDownloadServer({
      files: { '/models/range-416.gguf': payload416 },
    });
    t.after(() => server416.close());

    const expectedSha416 = server416.digests['/models/range-416.gguf'].sha256;
    const dest416 = path.join(downloadsDir, 'range-416.gguf');
    await writeFile(`${dest416}.part`, Buffer.alloc(payload416.length + 2048, 0x99));

    let res416: DownloadProgress | null = null;
    let err416: unknown = null;
    try {
      res416 = await downloadFn({
        url: `${server416.base}/models/range-416.gguf`,
        destination: dest416,
        dest: dest416,
        target: 'range-416.gguf',
        sha256: expectedSha416,
        retries: 2,
      });
    } catch (err) {
      err416 = err;
    }
    assert.ok(
      server416.requests.some((r) => Boolean(r.headers.range)),
      'Oversized .part must trigger a Range request resulting in HTTP 416',
    );
    if (res416 && res416.status === 'completed') {
      const recovered = await readFile(dest416);
      assert.equal(recovered.length, payload416.length);
      assert.equal(createHash('sha256').update(recovered).digest('hex'), expectedSha416);
      assert.equal(
        existsSync(`${dest416}.part`),
        false,
        'Recovered 416 download must not leave leftover .part file',
      );
    } else {
      assert.ok(
        err416 !== null || res416?.status === 'failed',
        'Unrecovered 416 must fail cleanly with structured error',
      );
      assert.equal(
        existsSync(dest416),
        false,
        'Failed 416 download must never leave a corrupt final file',
      );
    }

    // Sub-test B: Retry exhaustion on repeated mid-stream drops
    const payload = Buffer.alloc(16384, 0x33);
    const dlServer = await createMockArtifactDownloadServer({
      files: { '/models/drop-loop.gguf': payload },
      dropAfterBytes: 1024,
      dropCount: 99,
    });
    t.after(() => dlServer.close());

    const destExhaust = path.join(downloadsDir, 'exhaust.gguf');
    let exhaustFailed = false;
    try {
      const r = await downloadFn({
        url: `${dlServer.base}/models/drop-loop.gguf`,
        destination: destExhaust,
        dest: destExhaust,
        target: 'exhaust.gguf',
        retries: 2,
      });
      exhaustFailed = r.status === 'failed';
    } catch {
      exhaustFailed = true;
    }
    assert.equal(
      exhaustFailed,
      true,
      'Repeated stream drops must fail cleanly after bounded retries',
    );
    assert.equal(existsSync(destExhaust), false);

    // Sub-test C1: Pre-aborted AbortSignal
    const acPre = new AbortController();
    acPre.abort();
    const destPreCancel = path.join(downloadsDir, 'pre-cancel.gguf');
    let preCancelled = false;
    try {
      const r = await downloadFn({
        url: `${server416.base}/models/range-416.gguf`,
        destination: destPreCancel,
        dest: destPreCancel,
        target: 'pre-cancel.gguf',
        signal: acPre.signal,
      });
      preCancelled = r.status === 'cancelled';
    } catch {
      preCancelled = true;
    }
    assert.equal(preCancelled, true, 'Pre-aborted AbortSignal must cancel/reject cleanly');
    assert.equal(existsSync(destPreCancel), false);

    // Sub-test C2: Deterministic in-flight cancellation via chunk-throttled server + onProgress abort
    const activeTimers = new Set<ReturnType<typeof setInterval>>();
    const totalCancelBytes = 262144;
    const chunkBuf = Buffer.alloc(16384, 0x11);
    const cancelServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(totalCancelBytes),
      });
      let sent = chunkBuf.length;
      res.write(chunkBuf);
      const iv = setInterval(() => {
        if (res.destroyed || req.destroyed || sent >= totalCancelBytes) {
          clearInterval(iv);
          activeTimers.delete(iv);
          if (!res.destroyed) res.end();
          return;
        }
        sent += chunkBuf.length;
        res.write(chunkBuf);
      }, 40);
      activeTimers.add(iv);
      req.on('close', () => {
        clearInterval(iv);
        activeTimers.delete(iv);
      });
    });
    await new Promise<void>((resolve) => cancelServer.listen(0, '127.0.0.1', () => resolve()));
    t.after(async () => {
      for (const iv of activeTimers) clearInterval(iv);
      activeTimers.clear();
      await new Promise<void>((resolve) => {
        cancelServer.closeIdleConnections();
        cancelServer.closeAllConnections();
        cancelServer.close(() => resolve());
      });
    });
    const cancelAddr = cancelServer.address() as { port: number };

    const ac = new AbortController();
    const destCancel = path.join(downloadsDir, 'cancel.gguf');
    const updates: DownloadProgress[] = [];
    const backupAbort = setTimeout(() => {
      if (!ac.signal.aborted) ac.abort();
    }, 150);
    let cancelled = false;
    try {
      const r = await downloadFn({
        url: `http://127.0.0.1:${cancelAddr.port}/models/cancel.gguf`,
        destination: destCancel,
        dest: destCancel,
        target: 'cancel.gguf',
        signal: ac.signal,
        onProgress(p: DownloadProgress) {
          assertDownloadProgress(p);
          updates.push(p);
          if (p.downloaded_bytes > 0 && !ac.signal.aborted) {
            ac.abort();
          }
        },
      });
      cancelled = r.status === 'cancelled';
    } catch {
      cancelled = true;
    } finally {
      clearTimeout(backupAbort);
    }
    assert.ok(
      cancelled || updates.some((u) => u.status === 'cancelled'),
      'In-flight abort must cancel download cleanly',
    );
    assert.equal(existsSync(destCancel), false);
  });

  it('fa07.t2.4 ignores connection-refused ports and malformed HTTP/JSON probes cleanly during scan', async (t) => {
    const hub = await findHubModules();
    if (
      !requireDeliverable(
        t,
        Boolean(hub.scanner),
        'Pending M4 (Feature #18): platforms/workbench/lib/hub/scanner.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const closedPort = await allocatePort();
    const garbageServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-valid-json{{{');
    });
    await new Promise<void>((resolve) => garbageServer.listen(0, '127.0.0.1', () => resolve()));
    t.after(() => new Promise<void>((resolve) => garbageServer.close(() => resolve())));
    const garbageAddr = garbageServer.address() as { port: number };

    const healthyOllama = await createMockOllamaServer();
    t.after(() => healthyOllama.close());

    const scannerMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.scanner!)).href
    )) as Record<string, unknown>;
    const scanFn = (scannerMod.scanLocalServices ?? scannerMod.scanServices ?? scannerMod.scan) as (
      opts?: Record<string, unknown>,
    ) => Promise<Array<Record<string, unknown>> | { services: Array<Record<string, unknown>> }>;

    const raw = await scanFn({
      targets: [
        { kind: 'ollama', url: `http://127.0.0.1:${closedPort}`, port: closedPort },
        { kind: 'ollama', url: `http://127.0.0.1:${garbageAddr.port}`, port: garbageAddr.port },
        { kind: 'ollama', url: healthyOllama.base, port: healthyOllama.port },
      ],
      ports: [closedPort, garbageAddr.port, healthyOllama.port],
      timeoutMs: 1_500,
    });
    const services = Array.isArray(raw) ? raw : raw.services;
    assert.ok(Array.isArray(services));
    assert.ok(
      services.some((s) => String(s.url ?? s.base_url ?? '').includes(String(healthyOllama.port))),
      'Healthy service must still be returned alongside closed/malformed probes',
    );
  });

  it('fa07.t2.5 flags insufficient VRAM quantizations and rejects invalid/traversal local directory links', async (t) => {
    const hub = await findHubModules();
    if (
      !requireDeliverable(
        t,
        Boolean(hub.catalog),
        'Pending M4 (Feature #19): platforms/workbench/lib/hub/catalog.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa07-t2-5-');
    t.after(() => ws.cleanup());

    const catalogMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.catalog!)).href
    )) as Record<string, unknown>;

    const recFn = (catalogMod.recommendModels ??
      catalogMod.matchModels ??
      catalogMod.listModels) as (
      opts?: Record<string, unknown>,
    ) => Promise<
      Array<{ recommended_vram_mb: number; fit?: string; status?: string; fits?: boolean }>
    >;
    const recs = await recFn({
      snapshot: createMockHardwareSnapshot('cpu-only'),
      vramFreeMb: 1024,
      vramMb: 1024,
    });
    const oversized = recs.filter((m) => m.recommended_vram_mb > 4096);
    assert.ok(
      oversized.length > 0,
      'Catalog must include models with recommended_vram_mb > 4096 to validate insufficient VRAM flags',
    );
    assert.ok(
      oversized.every(
        (m) =>
          m.fits === false ||
          /too.?large|insufficient|exceed|no/i.test(String(m.fit ?? m.status ?? '')),
      ),
      'Models exceeding VRAM must be flagged as too large',
    );

    const linkFn = (catalogMod.linkLocalModel ?? catalogMod.registerLocalDirectory) as (
      opts: Record<string, unknown>,
    ) => Promise<unknown>;
    assert.equal(
      typeof linkFn,
      'function',
      'catalog module must export linkLocalModel/registerLocalDirectory',
    );
    await assert.rejects(() =>
      linkFn({
        id: 'missing-dir',
        engine_id: 'llama-cpp',
        dir: path.join(ws.rootDir, 'does-not-exist'),
        path: path.join(ws.rootDir, 'does-not-exist'),
        dataDir: ws.dataDir,
      }),
    );

    await assert.rejects(() =>
      linkFn({
        id: '../../escape',
        engine_id: 'llama-cpp',
        dir: ws.rootDir,
        path: ws.rootDir,
        dataDir: ws.dataDir,
      }),
    );
  });
});
