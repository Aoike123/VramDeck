import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { EngineManifestV2, HubEngineEntry } from '../../../platforms/workbench/lib/types.ts';
import { assertEngineManifestV2, assertHubEngineEntry } from '../lib/assertions.ts';
import {
  allocatePort,
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
} from '../lib/env.ts';
import { createEngineManifestV2, writeMockEnginePackage } from '../lib/fixtures.ts';
import { httpJson } from '../lib/http-client.ts';
import { spawnMcpStdioClient, spawnWorkbenchControlPlane } from '../lib/process-runner.ts';

const ROCM_PRO_ENGINES: Array<{
  dir: string;
  engine: string | null;
  port: number | null;
}> = [
  { dir: 'engines/llm/pation-model-qwen38-27b-w3a4', engine: 'llm', port: 18983 },
  { dir: 'engines/llm/pation-model-qwen38-27b-mxfp4', engine: null, port: null },
  { dir: 'engines/image/pation-model-qwen-image-21', engine: 'qwen-image', port: 8191 },
  { dir: 'engines/image/anima', engine: 'anima', port: 8188 },
  { dir: 'engines/video/pation-model-minimax-h3', engine: 'h3', port: 8188 },
  { dir: 'engines/audio/fish-drama3', engine: 'fish-drama3', port: 18986 },
  { dir: 'engines/audio/bs-roformer', engine: 'bs-roformer', port: 18986 },
  { dir: 'engines/audio/qwen3-asr', engine: 'qwen3-asr', port: 18986 },
];

const MAINSTREAM_ENGINE_CANDIDATES: Array<{ label: string; ids: string[] }> = [
  { label: 'llama.cpp', ids: ['llama-cpp', 'llamacpp', 'llama.cpp'] },
  { label: 'Ollama', ids: ['ollama'] },
  { label: 'ComfyUI', ids: ['comfyui', 'comfy-ui'] },
  { label: 'whisper.cpp', ids: ['whisper-cpp', 'whispercpp', 'whisper.cpp'] },
  { label: 'Kokoro / Fish-Speech', ids: ['kokoro', 'fish-speech', 'kokoro-tts'] },
  { label: 'vLLM', ids: ['vllm'] },
];

async function hasWorkbenchDeps(): Promise<boolean> {
  const [hasNext, hasSharp, hasUndici] = await Promise.all([
    deliverableExists('platforms/workbench/node_modules/next/package.json'),
    deliverableExists('platforms/workbench/node_modules/sharp/package.json'),
    deliverableExists('platforms/workbench/node_modules/undici/package.json'),
  ]);
  return hasNext && hasSharp && hasUndici;
}

async function hasMcpSdk(): Promise<boolean> {
  return deliverableExists('platforms/mcp/node_modules/@modelcontextprotocol/sdk/package.json');
}

async function collectEngineManifests(): Promise<
  Array<{ dir: string; manifest: Record<string, unknown> }>
> {
  const enginesDir = path.join(REPO_ROOT, 'engines');
  const results: Array<{ dir: string; manifest: Record<string, unknown> }> = [];
  const categories = await readdir(enginesDir, { withFileTypes: true });
  for (const cat of categories) {
    if (!cat.isDirectory() || cat.name === 'shared') continue;
    const pkgs = await readdir(path.join(enginesDir, cat.name), { withFileTypes: true });
    for (const pkg of pkgs) {
      if (!pkg.isDirectory()) continue;
      const pkgDir = path.join(enginesDir, cat.name, pkg.name);
      const manifestPath = path.join(pkgDir, 'engine.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      results.push({ dir: pkgDir, manifest });
    }
  }
  return results;
}

async function collectAdapterAndSharedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'upstream' ||
        entry.name === 'tests' ||
        entry.name === 'runtime' ||
        entry.name === 'nodes' ||
        entry.name === 'tools'
      ) {
        continue;
      }
      out.push(...(await collectAdapterAndSharedFiles(full)));
    } else if (entry.isFile() && /\.(?:mjs|ts|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'await',
  'yield',
  'in',
  'instanceof',
  'of',
  'else',
  'do',
]);

function stripJsComments(source: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'bt' | 'regex' = 'code';
  let canStartRegex = true;
  let lastNonWsChar = '';
  let nextOpenParenIsCond = false;
  const parenCondStack: boolean[] = [];
  let regexInCharClass = false;
  const templateBraceStack: number[] = [];

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
      } else if (ch === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
      } else if (ch === "'") {
        state = 'sq';
        nextOpenParenIsCond = false;
        out += ch;
        i += 1;
      } else if (ch === '"') {
        state = 'dq';
        nextOpenParenIsCond = false;
        out += ch;
        i += 1;
      } else if (ch === '`') {
        state = 'bt';
        nextOpenParenIsCond = false;
        out += ch;
        i += 1;
      } else if (ch === '/' && canStartRegex) {
        state = 'regex';
        regexInCharClass = false;
        nextOpenParenIsCond = false;
        out += ' ';
        i += 1;
      } else if (/[A-Za-z_$]/.test(ch)) {
        let end = i + 1;
        while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) {
          end += 1;
        }
        const word = source.slice(i, end);
        out += word;
        const notMember = lastNonWsChar !== '.';
        canStartRegex = notMember && REGEX_PREFIX_KEYWORDS.has(word);
        if (notMember && (word === 'if' || word === 'while' || word === 'for' || word === 'with')) {
          nextOpenParenIsCond = true;
        } else if (notMember && word === 'await' && nextOpenParenIsCond) {
          nextOpenParenIsCond = true;
        } else {
          nextOpenParenIsCond = false;
        }
        lastNonWsChar = word[word.length - 1];
        i = end;
      } else if (/\d/.test(ch)) {
        let end = i + 1;
        while (end < source.length && /[\dA-Za-z_.]/.test(source[end])) {
          end += 1;
        }
        const num = source.slice(i, end);
        out += num;
        canStartRegex = false;
        nextOpenParenIsCond = false;
        lastNonWsChar = num[num.length - 1];
        i = end;
      } else if (/\s/.test(ch)) {
        out += ch;
        i += 1;
      } else {
        if (ch === '{' && templateBraceStack.length > 0) {
          templateBraceStack[templateBraceStack.length - 1] += 1;
        } else if (ch === '}' && templateBraceStack.length > 0) {
          const top = templateBraceStack[templateBraceStack.length - 1];
          if (top === 0) {
            templateBraceStack.pop();
            out += '}';
            state = 'bt';
            nextOpenParenIsCond = false;
            i += 1;
            continue;
          }
          templateBraceStack[templateBraceStack.length - 1] = top - 1;
        }

        if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
          out += ch + next;
          canStartRegex = false;
          nextOpenParenIsCond = false;
          lastNonWsChar = ch;
          i += 2;
        } else {
          out += ch;
          if (ch === '(') {
            parenCondStack.push(nextOpenParenIsCond);
            canStartRegex = true;
          } else if (ch === ')') {
            canStartRegex = parenCondStack.pop() ?? false;
          } else {
            canStartRegex = ch !== ']';
          }
          nextOpenParenIsCond = false;
          lastNonWsChar = ch;
          i += 1;
        }
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
      } else {
        out += ch === '\n' ? '\n' : ' ';
        i += 1;
      }
    } else if (state === 'sq' || state === 'dq') {
      if (ch === '\\' && i + 1 < source.length) {
        out += ch + source[i + 1];
        i += 2;
      } else if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"')) {
        state = 'code';
        canStartRegex = false;
        lastNonWsChar = ch;
        out += ch;
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    } else if (state === 'bt') {
      if (ch === '\\' && i + 1 < source.length) {
        out += ch + source[i + 1];
        i += 2;
      } else if (ch === '$' && next === '{') {
        templateBraceStack.push(0);
        out += '${';
        state = 'code';
        canStartRegex = true;
        lastNonWsChar = '{';
        i += 2;
      } else if (ch === '`') {
        state = 'code';
        canStartRegex = false;
        lastNonWsChar = '`';
        out += ch;
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    } else {
      // state === 'regex'
      if (ch === '\\' && i + 1 < source.length) {
        out += next === '\n' ? ' \n' : '  ';
        if (next === '\n') {
          state = 'code';
          canStartRegex = true;
        }
        i += 2;
      } else if (ch === '\n') {
        out += '\n';
        state = 'code';
        canStartRegex = true;
        i += 1;
      } else if (ch === '[' && !regexInCharClass) {
        regexInCharClass = true;
        out += ' ';
        i += 1;
      } else if (ch === ']' && regexInCharClass) {
        regexInCharClass = false;
        out += ' ';
        i += 1;
      } else if (ch === '/' && !regexInCharClass) {
        out += ' ';
        i += 1;
        while (i < source.length && /[A-Za-z]/.test(source[i])) {
          out += ' ';
          i += 1;
        }
        state = 'code';
        canStartRegex = false;
        lastNonWsChar = '/';
      } else {
        out += ' ';
        i += 1;
      }
    }
  }
  return out;
}

function extractModuleSpecifiers(codeOnly: string): string[] {
  const specs: string[] = [];
  const quotedSpec = `(?:'([^'\\n\\r]+)'|"([^"\\n\\r]+)"|\`([^\`\\n\\r]+)\`)`;
  const patterns = [
    new RegExp(`\\bfrom\\s+${quotedSpec}`, 'g'),
    new RegExp(`(?:^|[;\\n\\r])\\s*import\\s+${quotedSpec}`, 'g'),
    new RegExp(`\\bimport\\s*\\(\\s*${quotedSpec}\\s*(?:,[^)]*)?\\)`, 'g'),
    new RegExp(`\\brequire\\s*\\(\\s*${quotedSpec}\\s*\\)`, 'g'),
  ];
  for (const pattern of patterns) {
    for (const match of codeOnly.matchAll(pattern)) {
      const bt = match[3];
      if (bt !== undefined && bt.includes('${')) continue;
      const raw = match[1] ?? match[2] ?? bt;
      if (raw) {
        specs.push(raw.replace(/\\+/g, '/').replace(/\/+/g, '/'));
      }
    }
  }
  return specs;
}

async function startMockArtifactGateway(
  artifactId: string,
  artifactLocalPath: string,
): Promise<{ base: string; close: () => Promise<void> }> {
  const { catalog } = (await import(
    pathToFileURL(path.join(REPO_ROOT, 'platforms/workbench/lib/capabilities.mjs')).href
  )) as { catalog: () => Promise<Record<string, unknown>> };
  const catalogData = await catalog();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/media/catalog') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(catalogData));
      return;
    }
    if (req.method === 'GET' && url.pathname === `/v1/media/artifacts/${artifactId}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          artifact_id: artifactId,
          kind: 'image',
          mime_type: 'image/png',
          bytes: 128,
          local_path: artifactLocalPath,
          uri: `media://artifacts/${artifactId}`,
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/mcp/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeIdleConnections();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('FA8 Tier 1: Mainstream adapters, ROCm Pro Pack & MCP surface', () => {
  it('fa08.t1.1 provides built-in mainstream lightweight adapters with valid EngineManifestV2 and surface contracts', async (t) => {
    const manifests = await collectEngineManifests();
    const declaredIds = new Set(
      manifests.map((m) =>
        String(
          (m.manifest.platform as Record<string, unknown> | undefined)?.engine ??
            m.manifest.deployment_id ??
            m.manifest.name ??
            path.basename(m.dir),
        ).toLowerCase(),
      ),
    );
    const hasAllMainstream = MAINSTREAM_ENGINE_CANDIDATES.every((group) =>
      group.ids.some((id) => declaredIds.has(id)),
    );

    if (
      !requireDeliverable(
        t,
        hasAllMainstream,
        'Pending M4 (Feature #20): Mainstream lightweight adapters (llama.cpp, Ollama, ComfyUI, whisper.cpp, Kokoro/Fish-Speech, vLLM) not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa08-t1-1-');
    t.after(() => ws.cleanup());

    const regRel =
      (await findFirstExisting([
        'platforms/workbench/lib/registry.ts',
        'platforms/workbench/lib/registry.mjs',
      ])) ?? 'platforms/workbench/lib/registry.mjs';
    const mediaToolsRel =
      (await findFirstExisting([
        'platforms/workbench/lib/media-tools.ts',
        'platforms/workbench/lib/media-tools.mjs',
      ])) ?? 'platforms/workbench/lib/media-tools.mjs';

    const { Registry, readSurface } = (await import(
      pathToFileURL(path.join(REPO_ROOT, regRel)).href
    )) as {
      Registry: new (opts: { enginesDir: string; statePath: string; publish: boolean }) => {
        surface: Record<string, unknown>;
        packages: Array<{ id: string }>;
      };
      readSurface: (pkg: {
        dir: string;
        file: string;
        manifest: Record<string, unknown>;
      }) => Record<string, unknown>;
    };
    const { checkDefinitions } = (await import(
      pathToFileURL(path.join(REPO_ROOT, mediaToolsRel)).href
    )) as {
      checkDefinitions: (defs: Record<string, unknown>) => string[];
    };

    const reg = new Registry({
      enginesDir: path.join(REPO_ROOT, 'engines'),
      statePath: path.join(ws.configDir, 'fa08-t1-1-reg.json'),
      publish: false,
    });

    for (const group of MAINSTREAM_ENGINE_CANDIDATES) {
      const matched = manifests.find((m) => {
        const id = String(
          (m.manifest.platform as Record<string, unknown> | undefined)?.engine ??
            m.manifest.deployment_id ??
            m.manifest.name ??
            path.basename(m.dir),
        ).toLowerCase();
        return group.ids.includes(id);
      });
      assert.ok(matched, `Missing mainstream adapter for ${group.label}`);
      assertEngineManifestV2(matched.manifest as unknown as EngineManifestV2);

      const plat = matched.manifest.platform as Record<string, unknown>;
      const adapterRel = String(plat.adapter ?? '');
      assert.ok(adapterRel.length > 0, `${group.label} must declare platform.adapter`);
      assert.equal(
        existsSync(path.join(matched.dir, adapterRel)),
        true,
        `${group.label} adapter file must exist on disk: ${path.join(matched.dir, adapterRel)}`,
      );

      const pkgSurface = readSurface({
        dir: matched.dir,
        file: path.join(matched.dir, 'engine.json'),
        manifest: matched.manifest,
      });
      if (Object.keys(pkgSurface).length > 0) {
        assert.deepEqual(
          checkDefinitions(pkgSurface),
          [],
          `${group.label} platform.surface must pass checkDefinitions`,
        );
      }
      if (matched.manifest.category !== 'llm') {
        const models = (plat.models as Array<{ capabilities?: string[] }>) ?? [];
        for (const model of models) {
          for (const cap of model.capabilities ?? []) {
            assert.ok(
              Object.hasOwn(reg.surface, cap),
              `${group.label} capability ${cap} must be declared in Registry surface`,
            );
          }
        }
      }
    }
  });

  it('fa08.t1.2 preserves all 8 AMD R9700/Paiton engines under ROCm Pro Pack (pack: rocm-pro)', async (t) => {
    const manifests = await collectEngineManifests();
    const hasPackTagInManifests = manifests.some((m) => {
      const plat = m.manifest.platform as Record<string, unknown> | undefined;
      return m.manifest.pack === 'rocm-pro' || plat?.pack === 'rocm-pro';
    });

    let hasPackInCatalog = false;
    let catalogEntries: HubEngineEntry[] = [];
    const catalogRel = await findFirstExisting([
      'platforms/workbench/lib/hub/catalog.ts',
      'platforms/workbench/lib/hub/catalog.mjs',
    ]);
    if (catalogRel) {
      const catMod = (await import(pathToFileURL(path.join(REPO_ROOT, catalogRel)).href)) as Record<
        string,
        unknown
      >;
      const listFn = (catMod.listEngines ?? catMod.matchEngines) as
        | ((opts?: Record<string, unknown>) => Promise<HubEngineEntry[]> | HubEngineEntry[])
        | undefined;
      if (typeof listFn === 'function') {
        catalogEntries = await listFn({});
        catalogEntries.forEach((e) => assertHubEngineEntry(e));
        hasPackInCatalog = catalogEntries.some((e) => e.pack === 'rocm-pro');
      }
    }

    if (
      !requireDeliverable(
        t,
        hasPackTagInManifests || hasPackInCatalog,
        'Pending M4 (Feature #21): ROCm Pro Pack (pack: "rocm-pro") grouping not delivered',
      )
    ) {
      return;
    }

    for (const expected of ROCM_PRO_ENGINES) {
      const absDir = path.join(REPO_ROOT, expected.dir);
      assert.equal(existsSync(absDir), true, `Missing ROCm Pro engine dir: ${expected.dir}`);
      const manifest = JSON.parse(
        await readFile(path.join(absDir, 'engine.json'), 'utf8'),
      ) as Record<string, unknown>;
      const plat = manifest.platform as Record<string, unknown> | undefined;
      if (expected.engine !== null) {
        assert.ok(plat, `${expected.dir} must preserve platform block`);
        assert.equal(plat.engine, expected.engine);
        const rt = plat.runtime as Record<string, unknown>;
        assert.equal(rt.port, expected.port);
      }

      const manifestPack = manifest.pack ?? plat?.pack;
      const pkgDirName = path.basename(expected.dir);
      const deploymentId = String(manifest.deployment_id ?? pkgDirName);
      const catalogMatch = catalogEntries.find(
        (e) =>
          e.id === deploymentId ||
          e.id === pkgDirName ||
          (expected.engine !== null && e.id === expected.engine),
      );

      if (hasPackTagInManifests) {
        assert.equal(
          manifestPack,
          'rocm-pro',
          `${expected.dir} manifest must carry pack: 'rocm-pro'`,
        );
      }
      if (hasPackInCatalog) {
        assert.ok(
          catalogMatch || manifestPack === 'rocm-pro',
          `${expected.dir} must appear in Hub catalog or manifest with pack: 'rocm-pro'`,
        );
        if (catalogMatch) {
          assert.equal(
            catalogMatch.pack,
            'rocm-pro',
            `Catalog entry ${catalogMatch.id} for ${expected.dir} must carry pack: 'rocm-pro'`,
          );
        } else {
          assert.equal(manifestPack, 'rocm-pro');
        }
      }
    }
  });

  it('fa08.t1.3 runs live MCP stdio server (local-media) with staged browse_media discovery & tools/list_changed', async (t) => {
    const [mcpReady, wbReady] = await Promise.all([hasMcpSdk(), hasWorkbenchDeps()]);
    if (
      !requireDeliverable(
        t,
        mcpReady && wbReady,
        'Pending M1 (Feature #9): platforms/mcp @modelcontextprotocol/sdk and workbench deps required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa08-t1-3-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const keyRes = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 'fa08-mcp', maxConcurrent: 2, requestsPerMinute: 60 },
    });
    assert.equal(keyRes.status, 200);

    const mcp = await spawnMcpStdioClient(ws, {
      env: {
        MEDIA_GATEWAY_URL: cp.urls.inference,
        MEDIA_API_KEY: keyRes.data.secret,
        MEDIA_TOOLS_WATCH_MS: '100',
      },
    });
    t.after(() => mcp.stop());

    const init = await mcp.request<{
      serverInfo: { name: string };
      capabilities: { tools?: { listChanged?: boolean } };
    }>('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'fa08-e2e-client', version: '1.0.0' },
    });
    assert.equal(init.serverInfo.name, 'local-media');
    assert.equal(init.capabilities.tools?.listChanged, true);
    mcp.notify('notifications/initialized', {});

    const initialTools = await mcp.request<{ tools: Array<{ name: string }> }>('tools/list');
    assert.deepEqual(
      initialTools.tools.map((tool) => tool.name),
      ['browse_media'],
      'Staged MCP discovery must expose ONLY browse_media initially',
    );

    const browseOverview = await mcp.request<{
      isError?: boolean;
      structuredContent: { categories: Array<{ category: string }> };
    }>('tools/call', { name: 'browse_media', arguments: {} });
    assert.notEqual(browseOverview.isError, true);
    const catIds = browseOverview.structuredContent.categories.map((c) => c.category);
    assert.ok(catIds.includes('image'));
    assert.ok(catIds.includes('video'));
    assert.ok(!catIds.includes('audio'), 'Disabled audio engines must stay hidden until enabled');

    const beforeOpenTools = await mcp.request<{ tools: Array<{ name: string }> }>('tools/list');
    assert.deepEqual(
      beforeOpenTools.tools.map((tool) => tool.name),
      ['browse_media'],
    );

    const openVideo = await mcp.request<{ isError?: boolean }>('tools/call', {
      name: 'browse_media',
      arguments: { category: 'video' },
    });
    assert.notEqual(openVideo.isError, true);

    const deadline = Date.now() + 3_000;
    while (
      !mcp.notifications.some((n) => n.method === 'notifications/tools/list_changed') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      mcp.notifications.some((n) => n.method === 'notifications/tools/list_changed'),
      'Opening a category must emit notifications/tools/list_changed',
    );

    const afterOpenTools = await mcp.request<{ tools: Array<{ name: string }> }>('tools/list');
    const names = afterOpenTools.tools.map((tool) => tool.name);
    assert.ok(names.includes('generate_video'));
    assert.ok(names.includes('list_media_models'));
    assert.ok(names.includes('import_media'));
    assert.ok(names.includes('get_job'));
    assert.ok(names.includes('get_artifact'));
    assert.ok(
      !names.includes('generate_image'),
      'Unopened image category tools must remain hidden',
    );
  });

  it('fa08.t1.4 enforces MCP media://artifacts/* resource_link and resources/read URI contract', async (t) => {
    const mcpReady = await hasMcpSdk();
    if (
      !requireDeliverable(
        t,
        mcpReady,
        'Pending M1: platforms/mcp @modelcontextprotocol/sdk required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa08-t1-4-');
    t.after(() => ws.cleanup());

    const artifactId = `artifact_${'a'.repeat(32)}`;
    const localArtifactPath = path.join(ws.artifactsDir, 'sample.png');
    await writeFile(localArtifactPath, 'png-bytes');

    const gateway = await startMockArtifactGateway(artifactId, localArtifactPath);
    t.after(() => gateway.close());

    const mcp = await spawnMcpStdioClient(ws, {
      env: {
        MEDIA_GATEWAY_URL: gateway.base,
        MEDIA_API_KEY: 'sk-wb-mock-key',
      },
    });
    t.after(() => mcp.stop());

    await mcp.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'fa08-uri-client', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    const toolRes = await mcp.request<{
      isError?: boolean;
      structuredContent: { artifact_id: string; uri: string };
      content: Array<{ type: string; uri?: string; mimeType?: string }>;
    }>('tools/call', {
      name: 'get_artifact',
      arguments: { artifact_id: artifactId },
    });
    assert.notEqual(toolRes.isError, true);
    assert.equal(toolRes.structuredContent.uri, `media://artifacts/${artifactId}`);
    const link = toolRes.content.find((c) => c.type === 'resource_link');
    assert.ok(link, 'get_artifact must include a resource_link content item');
    assert.equal(link.uri, `media://artifacts/${artifactId}`);
    assert.equal(link.mimeType, 'application/json');

    const readRes = await mcp.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>('resources/read', { uri: `media://artifacts/${artifactId}` });
    assert.equal(readRes.contents.length, 1);
    assert.equal(readRes.contents[0].uri, `media://artifacts/${artifactId}`);
    assert.equal(readRes.contents[0].mimeType, 'application/json');
    const parsed = JSON.parse(readRes.contents[0].text) as { artifact_id: string };
    assert.equal(parsed.artifact_id, artifactId);
  });

  it('fa08.t1.5 enforces adapter SDK boundary and dynamic platform.surface + Registry contract', async (t) => {
    const engineFiles = await collectAdapterAndSharedFiles(path.join(REPO_ROOT, 'engines'));
    assert.ok(engineFiles.length >= 7, 'Expected existing engine adapters and shared clients');

    for (const file of engineFiles) {
      const rawSrc = await readFile(file, 'utf8');
      const codeOnly = stripJsComments(rawSrc);
      const specifiers = extractModuleSpecifiers(codeOnly);
      for (const spec of specifiers) {
        if (spec.includes('platforms/workbench/lib/')) {
          assert.ok(
            spec.endsWith('platforms/workbench/lib/engine-sdk.mjs') ||
              spec.endsWith('platforms/workbench/lib/engine-sdk.ts'),
            `${path.relative(REPO_ROOT, file)} must only import platforms/workbench/lib/engine-sdk (found: ${spec})`,
          );
        }
      }
      assert.doesNotMatch(
        codeOnly,
        /['"]docker['"]\s*,\s*\[\s*['"]inspect['"]/,
        `${path.relative(REPO_ROOT, file)} must not call docker inspect directly`,
      );
    }

    const ws = await createIsolatedWorkspace('fa08-t1-5-');
    t.after(() => ws.cleanup());

    const enginesDir = path.join(ws.rootDir, 'engines');
    const port = await allocatePort();
    const manifest = createEngineManifestV2({
      name: 'custom-surface-pkg',
      engine: 'custom-surface',
      category: 'image',
      port,
      runtime: {
        container: 'mock-custom-container',
        launch: ['node', '-e', 'setInterval(()=>{},1000)'],
      },
      models: [{ id: 'custom-img-1', capabilities: ['image.stylize'], priority: 10 }],
      surface: {
        'image.stylize': {
          group: 'stylize_image',
          kind: 'image',
          label: 'Stylize Image',
          description: 'Mock custom surface capability',
          order: 30,
          base: {
            request_id: { $use: 'request_id' },
            prompt: { $use: 'prompt', note: 'style prompt' },
          },
          required: ['request_id', 'prompt'],
          example: { request_id: 'req_1', prompt: 'watercolor' },
          group_info: {
            label: 'Stylize Image',
            summary: 'Stylize images',
            description: 'Custom surface tool group',
          },
          category: {
            id: 'image',
            label: 'Image',
            summary: 'Image tools',
          },
          sync: '/v1/images/stylize',
          sync_via: 'job',
          sync_public: true,
        },
      },
    });
    await writeMockEnginePackage(enginesDir, manifest);

    const regRel =
      (await findFirstExisting([
        'platforms/workbench/lib/registry.ts',
        'platforms/workbench/lib/registry.mjs',
      ])) ?? 'platforms/workbench/lib/registry.mjs';
    const { Registry } = (await import(pathToFileURL(path.join(REPO_ROOT, regRel)).href)) as {
      Registry: new (opts: { enginesDir: string; statePath: string; publish: boolean }) => {
        surface: Record<string, unknown>;
        services: () => Array<{ id: string }>;
        capabilities: () => string[];
      };
    };

    const reg = new Registry({
      enginesDir,
      statePath: path.join(ws.configDir, 'reg-state.json'),
      publish: false,
    });
    assert.ok(Object.hasOwn(reg.surface, 'image.stylize'));
    assert.deepEqual(reg.capabilities(), ['image.stylize']);
    assert.equal(reg.services()[0].id, 'custom-surface');
  });
});
