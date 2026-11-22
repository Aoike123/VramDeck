import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type {
  DownloadProgress,
  HubEngineEntry,
  HubModelEntry,
} from '../../../platforms/workbench/lib/types.ts';
import {
  assertDownloadProgress,
  assertEngineManifestV2,
  assertHubEngineEntry,
  assertHubModelEntry,
} from '../lib/assertions.ts';
import {
  createIsolatedWorkspace,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
} from '../lib/env.ts';
import { createMockHardwareSnapshot } from '../lib/fixtures.ts';
import {
  createMockArtifactDownloadServer,
  createMockComfyUIServer,
  createMockLlamaServer,
  createMockOllamaServer,
  createMockOpenAIServer,
} from '../lib/mock-servers.ts';

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

describe('FA7 Tier 1: Engine & Model Hub local scanner, catalog & downloader', () => {
  it('fa07.t1.1 scans local services (Ollama, ComfyUI, llama-server, LM Studio) and adopts external manifest', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa07-t1-1-');
    t.after(() => ws.cleanup());

    const ollama = await createMockOllamaServer({
      models: [{ name: 'qwen2.5:7b', size: 4_700_000_000 }],
    });
    t.after(() => ollama.close());
    const comfy = await createMockComfyUIServer();
    t.after(() => comfy.close());
    const llama = await createMockLlamaServer({ modelId: 'qwen2.5-7b-q4_k_m' });
    t.after(() => llama.close());
    const lmStudio = await createMockOpenAIServer({ models: ['lmstudio-local-model'] });
    t.after(() => lmStudio.close());

    const scannerMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.scanner!)).href
    )) as Record<string, unknown>;

    const scanFn = (scannerMod.scanLocalServices ?? scannerMod.scanServices ?? scannerMod.scan) as (
      opts?: Record<string, unknown>,
    ) => Promise<Array<Record<string, unknown>> | { services: Array<Record<string, unknown>> }>;
    assert.equal(typeof scanFn, 'function', 'scanner module must export scanLocalServices/scan');

    const raw = await scanFn({
      targets: [
        { kind: 'ollama', url: ollama.base, port: ollama.port },
        { kind: 'comfyui', url: comfy.base, port: comfy.port },
        { kind: 'llama-server', url: llama.base, port: llama.port },
        { kind: 'lm-studio', url: lmStudio.base, port: lmStudio.port },
      ],
      ports: [ollama.port, comfy.port, llama.port, lmStudio.port],
      timeoutMs: 2_000,
    });
    const services = Array.isArray(raw) ? raw : raw.services;
    assert.ok(
      Array.isArray(services) && services.length >= 4,
      'Expected all 4 local services detected',
    );

    const kinds = new Set(
      services.map((s) => String(s.kind ?? s.engine ?? s.type ?? '').toLowerCase()),
    );
    assert.ok(
      [...kinds].some((k) => k.includes('ollama')),
      'Ollama must be discovered',
    );
    assert.ok(
      [...kinds].some((k) => k.includes('comfy')),
      'ComfyUI must be discovered',
    );
    assert.ok(
      [...kinds].some((k) => k.includes('llama')),
      'llama-server must be discovered',
    );
    assert.ok(
      [...kinds].some(
        (k) => k.includes('lm-studio') || k.includes('lmstudio') || k.includes('openai'),
      ),
      'LM Studio / OpenAI-compatible server must be discovered',
    );

    const discoveredPorts = new Set(
      services
        .map((s) => {
          if (typeof s.port === 'number' && Number.isFinite(s.port)) return s.port;
          const rawUrl = String(s.url ?? s.base_url ?? '');
          try {
            const parsed = new URL(rawUrl);
            return parsed.port ? Number(parsed.port) : null;
          } catch {
            return null;
          }
        })
        .filter((p): p is number => p !== null),
    );
    assert.equal(
      discoveredPorts.size,
      4,
      `Expected 4 distinct discovered ports across ollama/comfyui/llama-server/lm-studio, got: ${[...discoveredPorts].join(', ')}`,
    );
    for (const expectedPort of [ollama.port, comfy.port, llama.port, lmStudio.port]) {
      assert.ok(
        discoveredPorts.has(expectedPort),
        `Expected port ${expectedPort} in discovered services`,
      );
    }

    const adoptFn = (scannerMod.adoptExternalService ??
      scannerMod.adoptService ??
      scannerMod.adopt) as (
      service: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    assert.equal(
      typeof adoptFn,
      'function',
      'scanner module must export adoptExternalService/adoptService/adopt',
    );
    const ollamaSvc = services.find((s) =>
      String(s.kind ?? s.engine ?? s.type ?? '')
        .toLowerCase()
        .includes('ollama'),
    )!;
    const adopted = await adoptFn(ollamaSvc, {
      enginesDir: path.join(ws.rootDir, 'engines'),
      dataDir: ws.dataDir,
    });
    const manifest = adopted.manifest ?? adopted;
    assertEngineManifestV2(manifest);
    assert.equal(
      (manifest as { platform: { runtime: { driver: string } } }).platform.runtime.driver,
      'external',
    );
  });

  it('fa07.t1.2 matches Hub engine catalog entries by OS, arch, and compute backend', async (t) => {
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

    const catalogMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.catalog!)).href
    )) as Record<string, unknown>;

    const matchFn = (catalogMod.matchEngines ??
      catalogMod.recommendEngines ??
      catalogMod.listEngines) as (
      opts?: Record<string, unknown>,
    ) => Promise<HubEngineEntry[]> | HubEngineEntry[];
    assert.equal(typeof matchFn, 'function', 'catalog module must export matchEngines/listEngines');

    const cudaSnap = createMockHardwareSnapshot('single-gpu-24g');
    const appleSnap = createMockHardwareSnapshot('apple-silicon-64g', {
      host: { os: 'darwin', arch: 'arm64', ram_total_mb: 65536, ram_free_mb: 49152 },
    });
    const cpuSnap = createMockHardwareSnapshot('cpu-only');

    const cudaEngines = await matchFn({ snapshot: cudaSnap, os: 'linux', arch: 'x64' });
    const appleEngines = await matchFn({ snapshot: appleSnap, os: 'darwin', arch: 'arm64' });
    const cpuEngines = await matchFn({ snapshot: cpuSnap, os: 'win32', arch: 'x64' });

    for (const list of [cudaEngines, appleEngines, cpuEngines]) {
      assert.ok(Array.isArray(list) && list.length > 0);
      for (const entry of list) {
        assertHubEngineEntry(entry);
      }
    }

    assert.ok(
      appleEngines.some((e) => e.backends.includes('metal')),
      'Apple Silicon snapshot must match Metal-capable engines',
    );
    assert.ok(
      !appleEngines.some((e) => e.pack === 'rocm-pro'),
      'ROCm Pro Pack must not be recommended as primary match on Apple Metal',
    );
    assert.ok(
      cpuEngines.some((e) => e.backends.includes('cpu')),
      'CPU-only snapshot must match CPU-capable engines',
    );
  });

  it('fa07.t1.3 computes VRAM-fit quantization recommendations (fits / tight / too large)', async (t) => {
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

    const catalogMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.catalog!)).href
    )) as Record<string, unknown>;
    const recFn = (catalogMod.recommendModels ??
      catalogMod.matchModels ??
      catalogMod.listModels) as (
      opts?: Record<string, unknown>,
    ) => Promise<Array<HubModelEntry & { fit?: string; status?: string; fits?: boolean }>>;
    assert.equal(typeof recFn, 'function', 'catalog module must export recommendModels/listModels');

    const models12g = await recFn({
      snapshot: createMockHardwareSnapshot('single-gpu-24g'),
      vramFreeMb: 12288,
      vramMb: 12288,
    });
    const models4g = await recFn({
      snapshot: createMockHardwareSnapshot('single-gpu-24g'),
      vramFreeMb: 4096,
      vramMb: 4096,
    });
    assert.ok(Array.isArray(models12g) && models12g.length > 0);
    assert.ok(Array.isArray(models4g) && models4g.length > 0);

    const allChecked = [...models12g, ...models4g];
    for (const m of allChecked) {
      assertHubModelEntry(m);
    }

    const extractFit = (m: HubModelEntry & { fit?: string; status?: string; fits?: boolean }) =>
      String(m.fit ?? m.status ?? '').toLowerCase();

    let fitLabels = allChecked.map(extractFit).filter(Boolean);
    if (!fitLabels.some((f) => /tight|warn|marginal|borderline/i.test(f))) {
      // Probe recommended_vram_mb and 90% of recommended_vram_mb so tight-fit triggers whether fits is >= or > recommended_vram_mb
      const probeTarget = models12g.find((m) => m.recommended_vram_mb > 0);
      if (probeTarget) {
        for (const vramCandidate of [
          probeTarget.recommended_vram_mb,
          Math.floor(probeTarget.recommended_vram_mb * 0.9),
        ]) {
          const tightProbe = await recFn({
            snapshot: createMockHardwareSnapshot('single-gpu-24g'),
            vramFreeMb: vramCandidate,
            vramMb: vramCandidate,
          });
          tightProbe.forEach((m) => assertHubModelEntry(m));
          fitLabels = [...fitLabels, ...tightProbe.map(extractFit).filter(Boolean)];
        }
      }
    }

    assert.ok(
      fitLabels.some((f) => f === 'fits' || f === 'fit' || f === 'ok') ||
        models12g.some((m) => m.fits === true),
      `Catalog recommendations at 12288 MB must include a "fits" tier, got: ${fitLabels.join(', ')}`,
    );
    assert.ok(
      fitLabels.some((f) => /tight|warn|marginal|borderline/i.test(f)),
      `Catalog recommendations must include a "tight" VRAM tier, got: ${fitLabels.join(', ')}`,
    );
    assert.ok(
      fitLabels.some((f) => /too.?large|insufficient|exceed|no.?fit/i.test(f)) ||
        models4g.some((m) => m.fits === false),
      `Catalog recommendations at 4096 MB must include a "too large" VRAM tier, got: ${fitLabels.join(', ')}`,
    );
  });

  it('fa07.t1.4 resolves multi-mirror URLs (huggingface / hf-mirror / modelscope) and links local directory', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa07-t1-4-');
    t.after(() => ws.cleanup());

    const localModelDir = path.join(ws.rootDir, 'local-gguf-model');
    await mkdir(localModelDir, { recursive: true });
    await writeFile(path.join(localModelDir, 'model-q4.gguf'), Buffer.alloc(1024, 0x42));

    const catalogMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.catalog!)).href
    )) as Record<string, unknown>;
    const resolveMirror = (catalogMod.resolveMirrorUrl ?? catalogMod.mirrorUrl) as (source: {
      mirror: string;
      repo: string;
      file?: string;
    }) => string;
    assert.equal(
      typeof resolveMirror,
      'function',
      'catalog module must export resolveMirrorUrl/mirrorUrl',
    );

    const hf = resolveMirror({
      mirror: 'huggingface',
      repo: 'Qwen/Qwen2.5-7B-GGUF',
      file: 'model.gguf',
    });
    const hfm = resolveMirror({
      mirror: 'hf-mirror',
      repo: 'Qwen/Qwen2.5-7B-GGUF',
      file: 'model.gguf',
    });
    const ms = resolveMirror({
      mirror: 'modelscope',
      repo: 'Qwen/Qwen2.5-7B-GGUF',
      file: 'model.gguf',
    });
    assert.notEqual(hf, hfm);
    assert.notEqual(hf, ms);
    assert.match(hf, /huggingface\.co/);
    assert.match(hfm, /hf-mirror\.com/);
    assert.match(ms, /modelscope/);

    const linkFn = (catalogMod.linkLocalModel ?? catalogMod.registerLocalDirectory) as (
      opts: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    assert.equal(
      typeof linkFn,
      'function',
      'catalog module must export linkLocalModel/registerLocalDirectory',
    );
    const linked = await linkFn({
      id: 'local-qwen-q4',
      engine_id: 'llama-cpp',
      dir: localModelDir,
      path: localModelDir,
      dataDir: ws.dataDir,
    });
    assert.ok(linked, 'Expected local model link result');
  });

  it('fa07.t1.5 streams DownloadProgress, resumes via HTTP Range 206, and verifies SHA256 digest', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa07-t1-5-');
    t.after(() => ws.cleanup());

    const payload = Buffer.alloc(65536);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 31) & 0xff;
    }
    const dlServer = await createMockArtifactDownloadServer({
      files: { '/models/qwen-test.gguf': payload },
      dropAfterBytes: 16384,
      dropCount: 1,
    });
    t.after(() => dlServer.close());

    const expectedSha = dlServer.digests['/models/qwen-test.gguf'].sha256;
    const destPath = path.join(ws.dataDir, 'downloads', 'qwen-test.gguf');

    const dlMod = (await import(
      pathToFileURL(path.join(REPO_ROOT, hub.downloader!)).href
    )) as Record<string, unknown>;
    const downloadFn = (dlMod.downloadArtifact ?? dlMod.downloadFile ?? dlMod.download) as (
      opts: Record<string, unknown>,
    ) => Promise<DownloadProgress>;
    assert.equal(
      typeof downloadFn,
      'function',
      'downloader module must export downloadArtifact/download',
    );

    const events: DownloadProgress[] = [];
    const finalProgress = await downloadFn({
      url: `${dlServer.base}/models/qwen-test.gguf`,
      destination: destPath,
      dest: destPath,
      target: 'qwen-test.gguf',
      sha256: expectedSha,
      retries: 3,
      onProgress(progress: DownloadProgress) {
        assertDownloadProgress(progress);
        events.push(progress);
      },
    });

    assertDownloadProgress(finalProgress);
    assert.equal(finalProgress.status, 'completed');
    assert.equal(finalProgress.downloaded_bytes, payload.length);
    assert.equal(finalProgress.total_bytes, payload.length);
    assert.ok(events.length >= 1, 'Expected streaming DownloadProgress updates');

    const rangeRequests = dlServer.requests.filter((r) => Boolean(r.headers.range));
    assert.ok(rangeRequests.length >= 1, 'Expected HTTP Range resume request after drop');

    const written = await readFile(destPath);
    assert.equal(createHash('sha256').update(written).digest('hex'), expectedSha);
    assert.equal(
      existsSync(`${destPath}.part`),
      false,
      'Completed download must not leave .part file',
    );
  });
});
