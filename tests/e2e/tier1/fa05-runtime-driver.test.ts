import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type {
  EngineManifestV2,
  RuntimeDriver,
  RuntimeDriverKind,
  RuntimeDriverSpec,
  RuntimeHandle,
} from '../../../platforms/workbench/lib/types.ts';
import { assertEngineManifestV2 } from '../lib/assertions.ts';
import {
  allocatePort,
  createIsolatedWorkspace,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
  withEnv,
} from '../lib/env.ts';
import { httpJson, waitForHttpReady } from '../lib/http-client.ts';
import {
  createEngineManifestV2,
  createResourceSpec,
  writeMockEnginePackage,
} from '../lib/fixtures.ts';
import { createMockOllamaServer } from '../lib/mock-servers.ts';

async function getDriversEntry(): Promise<string | null> {
  return findFirstExisting([
    'platforms/workbench/lib/drivers/index.ts',
    'platforms/workbench/lib/drivers/index.mjs',
  ]);
}

async function resolveDriver(
  entryRel: string,
  kind: RuntimeDriverKind,
  driverOpts?: Record<string, unknown>,
): Promise<RuntimeDriver> {
  const mod = (await import(pathToFileURL(path.join(REPO_ROOT, entryRel)).href)) as Record<
    string,
    unknown
  >;

  if (typeof mod.createRuntimeDriver === 'function') {
    return (
      mod.createRuntimeDriver as (
        k: RuntimeDriverKind,
        opts?: Record<string, unknown>,
      ) => RuntimeDriver
    )(kind, driverOpts);
  }
  if (typeof mod.getRuntimeDriver === 'function') {
    return (
      mod.getRuntimeDriver as (
        k: RuntimeDriverKind,
        opts?: Record<string, unknown>,
      ) => RuntimeDriver
    )(kind, driverOpts);
  }
  if (typeof mod.createDriverRegistry === 'function') {
    const reg = (
      mod.createDriverRegistry as (opts?: Record<string, unknown>) => Record<string, RuntimeDriver>
    )(driverOpts);
    if (reg[kind]) return reg[kind];
  }
  const ctorMap: Record<RuntimeDriverKind, string[]> = {
    process: ['ProcessDriver', 'ProcessRuntimeDriver'],
    docker: ['DockerDriver', 'DockerRuntimeDriver'],
    external: ['ExternalDriver', 'ExternalRuntimeDriver'],
  };
  for (const name of ctorMap[kind]) {
    if (typeof mod[name] === 'function') {
      const Ctor = mod[name] as new (opts?: Record<string, unknown>) => RuntimeDriver;
      return new Ctor(driverOpts);
    }
  }
  if (
    !driverOpts &&
    mod.drivers &&
    typeof (mod.drivers as Record<string, RuntimeDriver>)[kind] === 'object'
  ) {
    return (mod.drivers as Record<string, RuntimeDriver>)[kind];
  }
  throw new Error(`Unable to resolve ${kind} RuntimeDriver from ${entryRel}`);
}

async function installDockerShim(
  binDir: string,
  logPath: string,
  statePath: string,
): Promise<{ dockerBin: string }> {
  await mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'docker-shim.mjs');
  const script = [
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';`,
    `const args = process.argv.slice(2);`,
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');`,
    `const sub = args[0] ?? '';`,
    `const stateFile = ${JSON.stringify(statePath)};`,
    `const loadState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { running: false, id: 'mock-cid-001' });`,
    `if (sub === 'run') {`,
    `  const nameIdx = args.indexOf('--name');`,
    `  const id = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : 'mock-cid-001';`,
    `  writeFileSync(stateFile, JSON.stringify({ running: true, id }));`,
    `  console.log(id);`,
    `  process.exit(0);`,
    `} else if (sub === 'inspect' || sub === 'ps') {`,
    `  const st = loadState();`,
    `  if (sub === 'ps') {`,
    `    console.log(st.running ? st.id : '');`,
    `  } else {`,
    `    const fmtIdx = args.findIndex((a) => a === '--format' || a === '-f');`,
    `    const fmtEq = args.find((a) => a.startsWith('--format='));`,
    `    const fmt = fmtIdx >= 0 ? (args[fmtIdx + 1] ?? '') : (fmtEq ? fmtEq.slice('--format='.length) : '');`,
    `    if (fmt.includes('{{.State.Status}}')) {`,
    `      console.log(st.running ? 'running' : 'exited');`,
    `    } else if (fmt.includes('{{.State.Running}}')) {`,
    `      console.log(st.running ? 'true' : 'false');`,
    `    } else if (fmt) {`,
    `      console.log(st.running ? 'running' : 'exited');`,
    `    } else {`,
    `      console.log(JSON.stringify([{ Id: st.id, Name: '/' + st.id, State: { Running: st.running, Status: st.running ? 'running' : 'exited' } }]));`,
    `    }`,
    `  }`,
    `  process.exit(0);`,
    `} else if (sub === 'logs') {`,
    `  console.log('docker-shim: container started');`,
    `  process.exit(0);`,
    `} else if (sub === 'stop' || sub === 'rm') {`,
    `  const st = loadState();`,
    `  writeFileSync(stateFile, JSON.stringify({ running: false, id: st.id }));`,
    `  console.log(st.id);`,
    `  process.exit(0);`,
    `}`,
    `console.log('ok');`,
  ].join('\n');
  await writeFile(scriptPath, `${script}\n`, 'utf8');

  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, 'docker.cmd');
    await writeFile(
      cmdPath,
      `@echo off\r\n"${resolveNode22Plus()}" "${scriptPath}" %*\r\n`,
      'utf8',
    );
    return { dockerBin: cmdPath };
  }
  const shPath = path.join(binDir, 'docker');
  await writeFile(
    shPath,
    `#!/bin/sh\nexec "${resolveNode22Plus()}" "${scriptPath}" "$@"\n`,
    'utf8',
  );
  await chmod(shPath, 0o755);
  return { dockerBin: shPath };
}

function createValidMediaSurface(
  capability: string,
  tool: string,
  sync: string,
): Record<string, unknown> {
  return {
    [capability]: {
      group: tool,
      kind: 'text',
      label: 'Mock Chat',
      description: 'Mock chat completion capability',
      order: 10,
      base: {
        prompt: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      required: ['prompt'],
      example: { prompt: 'hello' },
      group_info: {
        label: 'Mock Chat',
        summary: 'Mock chat',
        description: 'Mock chat group',
      },
      category: {
        id: 'text',
        label: 'Text',
        summary: 'Text generation',
      },
      sync,
      sync_via: 'engine',
      sync_public: true,
    },
  };
}

describe('FA5 Tier 1: Pluggable RuntimeDriver & EngineManifestV2', () => {
  it('fa05.t1.1 spawns native process driver, captures stdout/stderr ring logs, and stops cleanly', async (t) => {
    const entry = await getDriversEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #16): platforms/workbench/lib/drivers/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa05-t1-1-');
    t.after(() => ws.cleanup());

    const port = await allocatePort();
    const serverScript = path.join(ws.rootDir, 'mock-proc-server.mjs');
    await writeFile(
      serverScript,
      [
        `import http from 'node:http';`,
        `console.log('PROC_STDOUT_READY');`,
        `console.error('PROC_STDERR_INIT');`,
        `const srv = http.createServer((req, res) => {`,
        `  if (req.url === '/health') {`,
        `    res.writeHead(200, { 'Content-Type': 'application/json' });`,
        `    res.end(JSON.stringify({ status: 'ok' }));`,
        `    return;`,
        `  }`,
        `  res.writeHead(404); res.end();`,
        `});`,
        `srv.listen(${port}, '127.0.0.1');`,
        `process.on('SIGTERM', () => srv.close(() => process.exit(0)));`,
      ].join('\n'),
      'utf8',
    );

    const driver = await resolveDriver(entry!, 'process');
    const spec: RuntimeDriverSpec = {
      id: 'proc-test',
      name: 'Process Test',
      driver: 'process',
      port,
      command: resolveNode22Plus(),
      args: [serverScript],
    };

    const handle: RuntimeHandle = await driver.start(spec, { gpu_ids: ['0'] });
    t.after(async () => {
      await driver.stop(handle).catch(() => {});
    });

    assert.equal(handle.driver, 'process');
    assert.equal(handle.runtime_id, 'proc-test');
    assert.ok(typeof handle.pid === 'number' && handle.pid > 0, 'Expected live child pid');
    assert.ok(handle.base_url.includes(String(port)));

    await waitForHttpReady(`${handle.base_url}/health`, { timeoutMs: 8_000 });
    assert.equal(await driver.isRunning(spec), true);

    if (typeof driver.logs === 'function') {
      const logText = await driver.logs(handle, { tail: 50 });
      assert.match(logText, /PROC_STDOUT_READY/);
      assert.match(logText, /PROC_STDERR_INIT/);
    }

    await driver.stop(handle);
    assert.equal(await driver.isRunning(spec), false);
  });

  it('fa05.t1.2 injects GPU visibility environment variables into process driver child', async (t) => {
    const entry = await getDriversEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #16): platforms/workbench/lib/drivers/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa05-t1-2-');
    t.after(() => ws.cleanup());

    const port = await allocatePort();
    const serverScript = path.join(ws.rootDir, 'env-echo-server.mjs');
    await writeFile(
      serverScript,
      [
        `import http from 'node:http';`,
        `const srv = http.createServer((req, res) => {`,
        `  if (req.url === '/env' || req.url === '/health') {`,
        `    res.writeHead(200, { 'Content-Type': 'application/json' });`,
        `    res.end(JSON.stringify({`,
        `      CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES ?? null,`,
        `      HIP_VISIBLE_DEVICES: process.env.HIP_VISIBLE_DEVICES ?? null,`,
        `      ROCR_VISIBLE_DEVICES: process.env.ROCR_VISIBLE_DEVICES ?? null,`,
        `      GGML_VK_VISIBLE_DEVICES: process.env.GGML_VK_VISIBLE_DEVICES ?? null,`,
        `      CUSTOM_FLAG: process.env.CUSTOM_FLAG ?? null,`,
        `    }));`,
        `    return;`,
        `  }`,
        `  res.writeHead(404); res.end();`,
        `});`,
        `srv.listen(${port}, '127.0.0.1');`,
      ].join('\n'),
      'utf8',
    );

    const driver = await resolveDriver(entry!, 'process');
    const spec: RuntimeDriverSpec = {
      id: 'proc-env-test',
      name: 'Process Env Test',
      driver: 'process',
      port,
      command: resolveNode22Plus(),
      args: [serverScript],
    };

    const handle = await driver.start(spec, {
      gpu_ids: ['1', '3'],
      env: { CUSTOM_FLAG: 'vramdeck-ok' },
    });
    t.after(async () => {
      await driver.stop(handle).catch(() => {});
    });

    await waitForHttpReady(`${handle.base_url}/health`, { timeoutMs: 8_000 });
    const envRes = await httpJson<Record<string, string | null>>(`${handle.base_url}/env`);
    assert.equal(envRes.data.CUDA_VISIBLE_DEVICES, '1,3');
    assert.equal(envRes.data.HIP_VISIBLE_DEVICES, '1,3');
    assert.equal(envRes.data.ROCR_VISIBLE_DEVICES, '1,3');
    assert.equal(envRes.data.GGML_VK_VISIBLE_DEVICES, '1,3');
    assert.equal(envRes.data.CUSTOM_FLAG, 'vramdeck-ok');
  });

  it('fa05.t1.3 constructs CUDA --gpus and ROCm /dev/kfd + /dev/dri isolation in docker driver via PATH shim', async (t) => {
    const entry = await getDriversEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #16): platforms/workbench/lib/drivers/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa05-t1-3-');
    t.after(() => ws.cleanup());

    const binDir = path.join(ws.rootDir, 'bin');
    const logPath = path.join(ws.rootDir, 'docker-calls.jsonl');
    const statePath = path.join(ws.rootDir, 'docker-state.json');
    const { dockerBin } = await installDockerShim(binDir, logPath, statePath);

    await withEnv(
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        DOCKER_BIN: dockerBin,
        WORKBENCH_DOCKER_BIN: dockerBin,
      },
      async () => {
        const driver = await resolveDriver(entry!, 'docker', { dockerBin });

        const cudaPort = await allocatePort();
        const cudaSpec = {
          id: 'docker-cuda',
          name: 'Docker CUDA',
          driver: 'docker',
          port: cudaPort,
          container: 'vramdeck-mock-cuda',
          command: 'vllm/vllm-openai:latest',
          env: { CUDA_VISIBLE_DEVICES: '0,1' },
          resources: createResourceSpec({ backends: ['cuda'], gpu_count: 2 }),
        } as RuntimeDriverSpec;
        const cudaHandle = await driver.start(cudaSpec, {
          gpu_ids: ['0', '1'],
          env: { CUDA_VISIBLE_DEVICES: '0,1' },
        });
        t.after(async () => {
          await driver.stop(cudaHandle).catch(() => {});
        });
        assert.equal(cudaHandle.driver, 'docker');
        assert.equal(await driver.isRunning(cudaSpec), true);
        if (typeof driver.logs === 'function') {
          const logs = await driver.logs(cudaHandle, { tail: 20 });
          assert.match(logs, /docker-shim/);
        }
        await driver.stop(cudaHandle);
        assert.equal(await driver.isRunning(cudaSpec), false);

        const rocmPort = await allocatePort();
        const rocmSpec = {
          id: 'docker-rocm',
          name: 'Docker ROCm',
          driver: 'docker',
          port: rocmPort,
          container: 'vramdeck-mock-rocm',
          command: 'rocm/vllm:latest',
          env: { HIP_VISIBLE_DEVICES: '0', ROCR_VISIBLE_DEVICES: '0' },
          resources: createResourceSpec({ backends: ['rocm'], gpu_count: 1 }),
        } as RuntimeDriverSpec;
        const rocmHandle = await driver.start(rocmSpec, {
          gpu_ids: ['0'],
          env: { HIP_VISIBLE_DEVICES: '0', ROCR_VISIBLE_DEVICES: '0' },
        });
        t.after(async () => {
          await driver.stop(rocmHandle).catch(() => {});
        });
        await driver.stop(rocmHandle);

        const recorded = (await readFile(logPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        const runCalls = recorded.filter((args) => args[0] === 'run');
        assert.ok(runCalls.length >= 2);
        const cudaRun = runCalls[0].join(' ');
        const rocmRun = runCalls[1].join(' ');
        assert.match(cudaRun, /--gpus/);
        assert.ok(
          rocmRun.includes('/dev/kfd') && rocmRun.includes('/dev/dri'),
          `ROCm docker run must pass /dev/kfd and /dev/dri, got: ${rocmRun}`,
        );
      },
    );
  });

  it('fa05.t1.4 adopts live HTTP server via external driver without spawning or terminating it on stop()', async (t) => {
    const entry = await getDriversEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #16): platforms/workbench/lib/drivers/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ollama = await createMockOllamaServer();
    t.after(() => ollama.close());

    const driver = await resolveDriver(entry!, 'external');
    const spec: RuntimeDriverSpec = {
      id: 'ext-ollama',
      name: 'External Ollama',
      driver: 'external',
      port: ollama.port,
      base_url: ollama.base,
    };

    const handle = await driver.start(spec, { gpu_ids: [] });
    assert.equal(handle.driver, 'external');
    assert.equal(handle.base_url, ollama.base);
    assert.equal(handle.pid, undefined);
    assert.equal(await driver.isRunning(spec), true);

    await driver.stop(handle);
    // External upstream must remain alive after driver.stop()
    const check = await httpJson<{ version: string }>(`${ollama.base}/api/version`);
    assert.equal(check.status, 200);
    assert.equal(check.data.version, '0.6.0-mock');
  });

  it('fa05.t1.5 validates EngineManifestV2 with platform.resources, platform.runtime.driver, and platform.surface in Registry', async (t) => {
    const entry = await getDriversEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #16): EngineManifestV2 registry validation lands with RuntimeDriver',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa05-t1-5-');
    t.after(() => ws.cleanup());

    const enginesDir = path.join(ws.rootDir, 'engines');
    const manifests: EngineManifestV2[] = [
      createEngineManifestV2({
        name: 'v2-proc-llm',
        engine: 'v2-proc-llm',
        category: 'llm',
        port: await allocatePort(),
        runtime: {
          driver: 'process',
          command: resolveNode22Plus(),
          args: ['-e', 'setInterval(()=>{},1000)'],
        },
        resources: createResourceSpec({
          backends: ['cuda', 'vulkan'],
          gpu_count: 1,
          vram_mb: 6144,
          vram_mode: 'shared',
          concurrency: 2,
          affinity: 'any',
          cold_start_weight: 'low',
        }),
        models: [{ id: 'v2-proc-llm-model', capabilities: ['text.chat'], priority: 10 }],
        surface: createValidMediaSurface('text.chat', 'chat_mock', '/v1/mock/chat'),
      }),
      createEngineManifestV2({
        name: 'v2-docker-llm',
        engine: 'v2-docker-llm',
        category: 'llm',
        port: await allocatePort(),
        runtime: {
          driver: 'docker',
          container: 'mock-docker-c',
          launch: ['docker', 'run', '-d', 'mock-image'],
        },
        resources: createResourceSpec({
          backends: ['rocm'],
          gpu_count: 2,
          vram_mb: 16384,
          vram_mode: 'exclusive',
          concurrency: 1,
          affinity: 'prefer:gpu-0',
          cold_start_weight: 'high',
        }),
        models: [{ id: 'v2-docker-llm-model', capabilities: ['text.embed'], priority: 10 }],
        surface: createValidMediaSurface('text.embed', 'embed_mock', '/v1/mock/embed'),
      }),
      createEngineManifestV2({
        name: 'v2-external-llm',
        engine: 'v2-external-llm',
        category: 'llm',
        port: await allocatePort(),
        runtime: {
          driver: 'external',
          base_url: 'http://127.0.0.1:11434',
        },
        resources: createResourceSpec({
          backends: ['cpu'],
          gpu_count: 1,
          vram_mb: 0,
          vram_mode: 'shared',
          concurrency: 4,
        }),
        models: [{ id: 'v2-external-llm-model', capabilities: ['text.rerank'], priority: 10 }],
        surface: createValidMediaSurface('text.rerank', 'rerank_mock', '/v1/mock/rerank'),
      }),
    ];

    for (const m of manifests) {
      assertEngineManifestV2(m);
      await writeMockEnginePackage(enginesDir, m);
    }

    const regRel =
      (await findFirstExisting([
        'platforms/workbench/lib/registry.ts',
        'platforms/workbench/lib/registry.mjs',
      ])) ?? 'platforms/workbench/lib/registry.mjs';
    const { Registry } = (await import(pathToFileURL(path.join(REPO_ROOT, regRel)).href)) as {
      Registry: new (opts: { enginesDir: string; statePath: string; publish: boolean }) => {
        packages: Array<{ id: string }>;
        services: () => Array<{ id: string }>;
        runtimes: () => Record<string, unknown>;
      };
    };

    const reg = new Registry({
      enginesDir,
      statePath: path.join(ws.configDir, 'reg-state.json'),
      publish: false,
    });
    assert.equal(reg.packages.length, 3);
    assert.equal(reg.services().length, 3);
    assert.equal(Object.keys(reg.runtimes()).length, 3);
  });
});
