import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertApiErrorShape } from '../lib/assertions.ts';
import {
  allocatePort,
  createIsolatedWorkspace,
  deliverableExists,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { createEngineManifestV2, writeMockEnginePackage } from '../lib/fixtures.ts';
import { httpJson, httpRequest } from '../lib/http-client.ts';
import { spawnMcpStdioClient, spawnWorkbenchControlPlane } from '../lib/process-runner.ts';

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

function validSurfaceFor(cap: string, group: string, sync: string): Record<string, unknown> {
  return {
    [cap]: {
      group,
      kind: 'image',
      label: group,
      description: `${group} description`,
      order: 10,
      base: {
        request_id: { $use: 'request_id' },
        prompt: { $use: 'prompt' },
      },
      required: ['request_id', 'prompt'],
      example: { request_id: 'r1', prompt: 'hello' },
      group_info: { label: group, summary: group, description: group },
      category: { id: 'image', label: 'Image', summary: 'Images' },
      sync,
      sync_via: 'job',
    },
  };
}

async function startMockMcpGateway(
  opts: {
    onJobRequest?: () => void;
    onAssetUpload?: () => void;
  } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const { catalog } = (await import(
    pathToFileURL(path.join(REPO_ROOT, 'platforms/workbench/lib/capabilities.mjs')).href
  )) as { catalog: () => Promise<Record<string, unknown>> };
  const catalogData = await catalog();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/media/catalog') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(catalogData));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/media/jobs') {
      opts.onJobRequest?.();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: `job_${'1'.repeat(32)}`, state: 'queued' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/media/assets') {
      for await (const _chunk of req) {
        // drain body
      }
      opts.onAssetUpload?.();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          asset_id: 'asset_mock_01',
          kind: url.searchParams.get('kind') ?? 'image',
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

describe('FA8 Tier 2: Adapters, Registry conflicts, MCP resilience & traversal rejection', () => {
  it('fa08.t2.1 returns actionable Hub/structured error on missing local binary without crashing gateway', async (t) => {
    const hubRoutesRel = await findFirstExisting([
      'platforms/workbench/lib/hub-routes.ts',
      'platforms/workbench/lib/hub-routes.mjs',
      'platforms/workbench/lib/gateway/hub-routes.ts',
      'platforms/workbench/lib/hub/catalog.ts',
      'platforms/workbench/lib/hub/catalog.mjs',
    ]);
    const llamaManifestRel = await findFirstExisting([
      'engines/llm/llama-cpp/engine.json',
      'engines/llm/llamacpp/engine.json',
      'engines/llm/llama.cpp/engine.json',
    ]);
    if (
      !requireDeliverable(
        t,
        Boolean(hubRoutesRel) && Boolean(llamaManifestRel),
        'Pending M4 (Features #18, #20): Mainstream adapter + Hub structured missing-binary error not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa08-t2-1-');
    t.after(() => ws.cleanup());

    const missingBin = path.join(ws.rootDir, 'missing-llama-server');
    const cp = await spawnWorkbenchControlPlane(ws, {
      env: {
        WORKBENCH_MOCK_GPUS: '[]',
        VRAMDECK_LLAMA_BIN: missingBin,
        LLAMA_SERVER_BIN: missingBin,
        LLAMA_CPP_BIN: missingBin,
      },
    });
    t.after(() => cp.stop());

    const platformBefore = await httpJson<{
      packages: Array<{
        id: string;
        enabled: boolean;
        engine?: string;
        models?: Array<{ id: string }>;
      }>;
      services?: Array<{ id: string; models?: Array<{ id: string }> }>;
    }>(`${cp.urls.workbench}/api/platform`);
    assert.equal(platformBefore.status, 200);

    const llamaPkg = platformBefore.data.packages.find((p) =>
      /llama/i.test(`${p.id} ${p.engine ?? ''}`),
    );
    assert.ok(llamaPkg, 'Expected llama.cpp package registered in /api/platform');

    if (!llamaPkg.enabled) {
      const enableRes = await httpJson<{
        packages: Array<{ id: string; enabled: boolean }>;
      }>(`${cp.urls.workbench}/api/platform/engines/${encodeURIComponent(llamaPkg.id)}`, {
        method: 'POST',
        body: { enabled: true },
      });
      assert.equal(enableRes.status, 200);
      assert.equal(
        enableRes.data.packages.find((p) => p.id === llamaPkg.id)?.enabled,
        true,
        `${llamaPkg.id} must be enabled before testing missing-binary inference`,
      );
    }

    const platformAfter = await httpJson<{
      packages: Array<{ id: string; enabled: boolean }>;
      services?: Array<{ id: string; models?: Array<{ id: string }> }>;
    }>(`${cp.urls.workbench}/api/platform`);
    assert.equal(platformAfter.status, 200);
    assert.equal(
      platformAfter.data.packages.find((p) => p.id === llamaPkg.id)?.enabled,
      true,
      `${llamaPkg.id} must remain enabled in /api/platform`,
    );

    const modelsRes = await httpJson<{ data: Array<{ id: string; owned_by?: string }> }>(
      `${cp.urls.inference}/v1/models`,
    );
    assert.equal(modelsRes.status, 200);
    const listedModel = modelsRes.data.data.find((m) =>
      /llama/i.test(`${m.id} ${m.owned_by ?? ''}`),
    );
    const targetModel =
      listedModel?.id ?? llamaPkg.models?.[0]?.id ?? llamaPkg.engine ?? 'llama-cpp';

    const chatRes = await httpRequest(`${cp.urls.inference}/v1/chat/completions`, {
      method: 'POST',
      body: { model: targetModel, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.ok(
      chatRes.status >= 400 && chatRes.status < 600,
      `Expected 4xx/5xx error for missing llama binary, got HTTP ${chatRes.status}`,
    );
    assert.ok(chatRes.json, 'Missing binary inference failure must return JSON error envelope');
    assertApiErrorShape(chatRes.json);
    const errObj = (chatRes.json as { error: { code: string; message: string } }).error;
    assert.doesNotMatch(
      errObj.message,
      /choose an llm model/i,
      'Must not return unrelated model-selection 400 when llama-cpp is enabled',
    );
    assert.match(
      `${errObj.code} ${errObj.message}`,
      /binary|executable|not installed|missing|enoent|spawn|unavailable|failed|llama|hub|install|command|start|runtime/i,
      `Expected actionable missing-binary/runtime error, got: ${errObj.code} ${errObj.message}`,
    );

    const health = await httpJson<{ status: string }>(`${cp.urls.inference}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ready');
  });

  it('fa08.t2.2 rejects duplicate engine, model.id, and runtime.port conflicts in isolated Registry', async (t) => {
    const ws = await createIsolatedWorkspace('fa08-t2-2-');
    t.after(() => ws.cleanup());

    const regRel =
      (await findFirstExisting([
        'platforms/workbench/lib/registry.ts',
        'platforms/workbench/lib/registry.mjs',
      ])) ?? 'platforms/workbench/lib/registry.mjs';
    const { Registry } = (await import(pathToFileURL(path.join(REPO_ROOT, regRel)).href)) as {
      Registry: new (opts: { enginesDir: string; statePath: string; publish: boolean }) => {
        setEnabled: (id: string, enabled: boolean) => Promise<unknown>;
        package: (id: string) => { enabled: boolean } | null;
      };
    };

    // Case A: duplicate platform.engine
    const dirEngine = path.join(ws.rootDir, 'dup-engine');
    await writeMockEnginePackage(
      dirEngine,
      createEngineManifestV2({
        name: 'pkg-a',
        engine: 'shared-eng',
        category: 'image',
        port: await allocatePort(),
        runtime: { id: 'rt-a', container: 'c-a', launch: ['node', '-v'] },
        models: [{ id: 'model-a', capabilities: ['image.generate'] }],
        surface: validSurfaceFor('image.generate', 'generate_image', '/v1/images/gen'),
      }),
    );
    await writeMockEnginePackage(
      dirEngine,
      createEngineManifestV2({
        name: 'pkg-b',
        engine: 'shared-eng',
        category: 'image',
        port: await allocatePort(),
        runtime: { id: 'rt-b', container: 'c-b', launch: ['node', '-v'] },
        models: [{ id: 'model-b', capabilities: ['image.generate'] }],
        surface: validSurfaceFor('image.generate', 'generate_image', '/v1/images/gen'),
      }),
    );
    assert.throws(
      () =>
        new Registry({
          enginesDir: dirEngine,
          statePath: path.join(ws.configDir, 's1.json'),
          publish: false,
        }),
      /already declared by/,
    );

    // Case B: duplicate model.id
    const dirModel = path.join(ws.rootDir, 'dup-model');
    await writeMockEnginePackage(
      dirModel,
      createEngineManifestV2({
        name: 'pkg-m1',
        engine: 'eng-m1',
        category: 'image',
        port: await allocatePort(),
        runtime: { id: 'rt-m1', container: 'c-m1', launch: ['node', '-v'] },
        models: [{ id: 'same-model', capabilities: ['image.generate'] }],
        surface: validSurfaceFor('image.generate', 'generate_image', '/v1/images/gen'),
      }),
    );
    await writeMockEnginePackage(
      dirModel,
      createEngineManifestV2({
        name: 'pkg-m2',
        engine: 'eng-m2',
        category: 'image',
        port: await allocatePort(),
        runtime: { id: 'rt-m2', container: 'c-m2', launch: ['node', '-v'] },
        models: [{ id: 'same-model', capabilities: ['image.generate'] }],
        surface: validSurfaceFor('image.generate', 'generate_image', '/v1/images/gen'),
      }),
    );
    assert.throws(
      () =>
        new Registry({
          enginesDir: dirModel,
          statePath: path.join(ws.configDir, 's2.json'),
          publish: false,
        }),
      /already declared by/,
    );

    // Case C: duplicate runtime.port across DIFFERENT runtime.ids (and setEnabled 409 rollback)
    const collidingPort = await allocatePort();
    const dirPort = path.join(ws.rootDir, 'dup-port');
    await writeMockEnginePackage(
      dirPort,
      createEngineManifestV2({
        name: 'pkg-p1',
        engine: 'eng-p1',
        category: 'image',
        default_enabled: true,
        port: collidingPort,
        runtime: { id: 'rt-p1', container: 'c-p1', launch: ['node', '-v'] },
        models: [{ id: 'model-p1', capabilities: ['image.generate'] }],
        surface: validSurfaceFor('image.generate', 'generate_image', '/v1/images/gen'),
      }),
    );
    await writeMockEnginePackage(
      dirPort,
      createEngineManifestV2({
        name: 'pkg-p2',
        engine: 'eng-p2',
        category: 'image',
        default_enabled: false,
        port: collidingPort,
        runtime: { id: 'rt-p2', container: 'c-p2', launch: ['node', '-v'] },
        models: [{ id: 'model-p2', capabilities: ['image.generate'] }],
        surface: validSurfaceFor('image.generate', 'generate_image', '/v1/images/gen'),
      }),
    );
    // Same runtime.id sharing a port MUST be allowed
    await writeMockEnginePackage(
      dirPort,
      createEngineManifestV2({
        name: 'pkg-p3-shared-rt',
        engine: 'eng-p3',
        category: 'image',
        default_enabled: true,
        port: collidingPort,
        runtime: { id: 'rt-p1', container: 'c-p1', launch: ['node', '-v'] },
        models: [{ id: 'model-p3', capabilities: ['image.generate'] }],
        surface: validSurfaceFor('image.generate', 'generate_image', '/v1/images/gen'),
      }),
    );

    const reg = new Registry({
      enginesDir: dirPort,
      statePath: path.join(ws.configDir, 's3.json'),
      publish: false,
    });
    assert.equal(reg.package('pkg-p3-shared-rt')?.enabled, true);
    await assert.rejects(
      () => reg.setEnabled('pkg-p2', true),
      (err: unknown) =>
        (err as { status?: number }).status === 409 &&
        /already declared by/.test((err as Error).message),
    );
    assert.equal(reg.package('pkg-p2')?.enabled, false);
  });

  it('fa08.t2.3 rejects invalid platform.surface definitions and bad MCP arguments with isError: true', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa08-t2-3-');
    t.after(() => ws.cleanup());

    // Part A: Invalid platform.surface in isolated Registry
    const regRel =
      (await findFirstExisting([
        'platforms/workbench/lib/registry.ts',
        'platforms/workbench/lib/registry.mjs',
      ])) ?? 'platforms/workbench/lib/registry.mjs';
    const { Registry } = (await import(pathToFileURL(path.join(REPO_ROOT, regRel)).href)) as {
      Registry: new (opts: { enginesDir: string; statePath: string; publish: boolean }) => unknown;
    };

    const badSurfaces: Array<Record<string, unknown>> = [
      // Reserved category 'other'
      {
        'image.bad': {
          ...(validSurfaceFor('image.bad', 'bad_tool', '/v1/images/bad')['image.bad'] as Record<
            string,
            unknown
          >),
          category: { id: 'other', label: 'Other', summary: 'Reserved' },
        },
      },
      // Non-/v1/ sync path
      {
        'image.bad': {
          ...(validSurfaceFor('image.bad', 'bad_tool', '/api/bad')['image.bad'] as Record<
            string,
            unknown
          >),
        },
      },
      // Required field missing from base
      {
        'image.bad': {
          ...(validSurfaceFor('image.bad', 'bad_tool', '/v1/images/bad')['image.bad'] as Record<
            string,
            unknown
          >),
          required: ['nonexistent_field'],
        },
      },
    ];

    for (let i = 0; i < badSurfaces.length; i += 1) {
      const dir = path.join(ws.rootDir, `bad-surf-${i}`);
      await writeMockEnginePackage(
        dir,
        createEngineManifestV2({
          name: `bad-surf-${i}`,
          engine: `bad-surf-${i}`,
          category: 'image',
          port: await allocatePort(),
          runtime: { id: `rt-bad-${i}`, container: 'c', launch: ['node', '-v'] },
          models: [{ id: `m-bad-${i}`, capabilities: ['image.bad'] }],
          surface: badSurfaces[i],
        }),
      );
      assert.throws(
        () =>
          new Registry({
            enginesDir: dir,
            statePath: path.join(ws.configDir, `bad-surf-${i}.json`),
            publish: false,
          }),
        /platform\.surface/,
      );
    }

    // Part B: Bad MCP arguments return { isError: true } without hitting gateway /v1/media/jobs
    let jobPosts = 0;
    const gateway = await startMockMcpGateway({
      onJobRequest: () => {
        jobPosts += 1;
      },
    });
    t.after(() => gateway.close());

    const mcp = await spawnMcpStdioClient(ws, {
      env: { MEDIA_GATEWAY_URL: gateway.base, MEDIA_API_KEY: 'sk-wb-test' },
    });
    t.after(() => mcp.stop());

    await mcp.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'fa08-bad-args', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    const badCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'generate_image', arguments: { prompt: 'missing request_id' } },
      { name: 'generate_image', arguments: { request_id: 'r1', prompt: 'x', unknown_param: 1 } },
      { name: 'get_job', arguments: { job_id: '../../etc/passwd' } },
      { name: 'nonexistent_tool', arguments: {} },
      { name: 'generate_image', arguments: { request_id: 'r2', prompt: 'a'.repeat(32001) } },
    ];

    for (const call of badCalls) {
      const res = await mcp.request<{ isError?: boolean }>('tools/call', call);
      assert.equal(res.isError, true, `Expected isError=true for ${call.name}`);
    }
    assert.equal(
      jobPosts,
      0,
      'Invalid MCP arguments must never be forwarded to gateway /v1/media/jobs',
    );
  });

  it('fa08.t2.4 survives malformed JSON-RPC stdio frames and rejects invalid media:// URIs', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa08-t2-4-');
    t.after(() => ws.cleanup());

    const gateway = await startMockMcpGateway();
    t.after(() => gateway.close());

    const mcp = await spawnMcpStdioClient(ws, {
      env: { MEDIA_GATEWAY_URL: gateway.base, MEDIA_API_KEY: 'sk-wb-test' },
    });
    t.after(() => mcp.stop());

    // First verify raw malformed frame resilience via direct stdio write
    const cliScript = path.join(REPO_ROOT, 'platforms', 'mcp', 'cli.mjs');
    const child = spawn(resolveNode22Plus(), [cliScript, 'stdio'], {
      cwd: path.join(REPO_ROOT, 'platforms', 'mcp'),
      env: {
        ...process.env,
        ...ws.env,
        MEDIA_GATEWAY_URL: gateway.base,
        MEDIA_API_KEY: 'sk-wb-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    });

    let stderrOut = '';
    let stdoutOut = '';
    child.stderr.on('data', (d: Buffer) => {
      stderrOut += d.toString('utf8');
    });
    child.stdout.on('data', (d: Buffer) => {
      stdoutOut += d.toString('utf8');
    });

    child.stdin.write('{not valid json\n');
    child.stdin.write('{"foo":"bar"}\n');
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'resilience-test', version: '1.0.0' },
        },
      })}\n`,
    );

    const deadline = Date.now() + 5_000;
    while (!stdoutOut.includes('"id":1') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(
      stdoutOut.includes('"id":1'),
      'MCP server must survive malformed JSON frames and answer initialize',
    );
    assert.match(stderrOut, /MCP protocol error/);
    child.stdin.end();

    // Invalid media:// URI rejection on resources/read
    await mcp.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'uri-neg-test', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    await assert.rejects(
      () => mcp.request('resources/read', { uri: 'media://artifacts/../../etc/passwd' }),
      /Invalid artifact URI/,
    );
    await assert.rejects(
      () => mcp.request('resources/read', { uri: 'file:///etc/passwd' }),
      /Invalid artifact URI/,
    );
  });

  it('fa08.t2.5 rejects MEDIA_IMPORT_ROOTS path traversal and symlink escapes while allowing valid imports', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa08-t2-5-');
    t.after(() => ws.cleanup());

    const allowedDir = path.join(ws.rootDir, 'allowed');
    await mkdir(allowedDir, { recursive: true });
    const okFile = path.join(allowedDir, 'ok.png');
    const outsideFile = path.join(ws.rootDir, 'outside-secret.png');
    await writeFile(okFile, 'png-ok');
    await writeFile(outsideFile, 'secret-outside');

    let linked = true;
    const symlinkEscape = path.join(allowedDir, 'escape-link.png');
    try {
      await symlink(outsideFile, symlinkEscape);
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') {
        linked = false;
      } else {
        throw err;
      }
    }

    let uploaded = 0;
    const gateway = await startMockMcpGateway({
      onAssetUpload: () => {
        uploaded += 1;
      },
    });
    t.after(() => gateway.close());

    const mcp = await spawnMcpStdioClient(ws, {
      env: {
        MEDIA_GATEWAY_URL: gateway.base,
        MEDIA_API_KEY: 'sk-wb-test',
        MEDIA_IMPORT_ROOTS: allowedDir,
      },
    });
    t.after(() => mcp.stop());

    await mcp.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'import-guard', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized', {});

    const relAttempt = await mcp.request<{ isError?: boolean }>('tools/call', {
      name: 'import_media',
      arguments: { path: '../outside-secret.png', kind: 'image' },
    });
    assert.equal(relAttempt.isError, true);

    const traversalAttempt = await mcp.request<{ isError?: boolean }>('tools/call', {
      name: 'import_media',
      arguments: { path: path.join(allowedDir, '..', 'outside-secret.png'), kind: 'image' },
    });
    assert.equal(traversalAttempt.isError, true);

    if (linked) {
      const symlinkAttempt = await mcp.request<{ isError?: boolean }>('tools/call', {
        name: 'import_media',
        arguments: { path: symlinkEscape, kind: 'image' },
      });
      assert.equal(symlinkAttempt.isError, true);
    }

    assert.equal(uploaded, 0);

    const validAttempt = await mcp.request<{
      isError?: boolean;
      structuredContent: { asset_id: string };
    }>('tools/call', {
      name: 'import_media',
      arguments: { path: okFile, kind: 'image' },
    });
    assert.notEqual(validAttempt.isError, true);
    assert.equal(validAttempt.structuredContent.asset_id, 'asset_mock_01');
    assert.equal(uploaded, 1);
  });

  it('fa08.t2.6 excludes default_enabled: false engines from catalog and models until enabled', async (t) => {
    const wbReady = await hasWorkbenchDeps();
    if (
      !requireDeliverable(
        t,
        wbReady,
        'Pending M1 (Feature #9): platforms/workbench node_modules required',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa08-t2-6-');
    t.after(() => ws.cleanup());

    const cp = await spawnWorkbenchControlPlane(ws, {
      env: { WORKBENCH_MOCK_GPUS: '[]' },
    });
    t.after(() => cp.stop());

    const keyRes = await httpJson<{ secret: string }>(`${cp.urls.workbench}/api/access-keys`, {
      method: 'POST',
      body: { action: 'create', name: 'fa08-enable', maxConcurrent: 2, requestsPerMinute: 60 },
    });
    assert.equal(keyRes.status, 200);

    const platformBefore = await httpJson<{
      packages: Array<{ id: string; enabled: boolean }>;
    }>(`${cp.urls.workbench}/api/platform`);
    assert.equal(platformBefore.status, 200);
    for (const id of ['fish-drama3', 'bs-roformer', 'qwen3-asr']) {
      const row = platformBefore.data.packages.find((p) => p.id === id);
      assert.ok(row, `Expected ${id} in /api/platform`);
      assert.equal(row.enabled, false, `${id} must be disabled by default`);
    }

    const mediaModelsBefore = await httpJson<{ data: Array<{ engine: string }> }>(
      `${cp.urls.inference}/v1/media/models`,
    );
    assert.equal(mediaModelsBefore.status, 200);
    assert.ok(
      !mediaModelsBefore.data.data.some((m) =>
        ['fish-drama3', 'bs-roformer', 'qwen3-asr'].includes(m.engine),
      ),
    );

    const catalogBefore = await httpJson<{
      tools: Array<{ name: string }>;
      models: Array<{ engine: string }>;
    }>(`${cp.urls.inference}/v1/media/catalog`, {
      headers: { Authorization: `Bearer ${keyRes.data.secret}` },
    });
    assert.equal(catalogBefore.status, 200);
    assert.ok(!catalogBefore.data.models.some((m) => m.engine === 'qwen3-asr'));

    const enableRes = await httpJson<{
      packages: Array<{ id: string; enabled: boolean }>;
    }>(`${cp.urls.workbench}/api/platform/engines/qwen3-asr`, {
      method: 'POST',
      body: { enabled: true },
    });
    assert.equal(enableRes.status, 200);
    assert.equal(enableRes.data.packages.find((p) => p.id === 'qwen3-asr')?.enabled, true);

    const catalogAfter = await httpJson<{
      tools: Array<{ name: string }>;
      models: Array<{ engine: string }>;
    }>(`${cp.urls.inference}/v1/media/catalog`, {
      headers: { Authorization: `Bearer ${keyRes.data.secret}` },
    });
    assert.equal(catalogAfter.status, 200);
    assert.ok(catalogAfter.data.models.some((m) => m.engine === 'qwen3-asr'));
    assert.ok(catalogAfter.data.tools.some((tool) => tool.name === 'process_audio'));
  });
});
