import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type {
  RuntimeDriver,
  RuntimeDriverKind,
  RuntimeDriverSpec,
} from '../../../platforms/workbench/lib/types.ts';
import {
  allocatePort,
  createIsolatedWorkspace,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
  withEnv,
} from '../lib/env.ts';
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

async function installFailingDockerShim(binDir: string): Promise<{ dockerBin: string }> {
  await mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'docker-fail.mjs');
  await writeFile(
    scriptPath,
    `console.error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');\nprocess.exit(1);\n`,
    'utf8',
  );
  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, 'docker.cmd');
    await writeFile(
      cmdPath,
      `@echo off\r\n"${resolveNode22Plus()}" "${scriptPath}" %*\r\n`,
      'utf8',
    );
    return { dockerBin: cmdPath };
  }
  const sh = path.join(binDir, 'docker');
  await writeFile(sh, `#!/bin/sh\nexec "${resolveNode22Plus()}" "${scriptPath}" "$@"\n`, 'utf8');
  await chmod(sh, 0o755);
  return { dockerBin: sh };
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

describe('FA5 Tier 2: RuntimeDriver failure paths & EngineManifestV2 negative validation', () => {
  it('fa05.t2.1 reports spawn failure and non-zero early exit cleanly without corrupting subsequent starts', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa05-t2-1-');
    t.after(() => ws.cleanup());

    const driver = await resolveDriver(entry!, 'process');
    const missingSpec: RuntimeDriverSpec = {
      id: 'missing-bin',
      name: 'Missing Bin',
      driver: 'process',
      port: await allocatePort(),
      command: path.join(ws.rootDir, 'definitely-missing-binary-vramdeck'),
      args: [],
    };
    await assert.rejects(() => driver.start(missingSpec, { gpu_ids: ['0'] }));
    assert.equal(await driver.isRunning(missingSpec), false);

    const crashSpec: RuntimeDriverSpec = {
      id: 'crash-early',
      name: 'Crash Early',
      driver: 'process',
      port: await allocatePort(),
      command: resolveNode22Plus(),
      args: ['-e', "console.error('fatal-init-boom'); process.exit(2);"],
    };
    await assert.rejects(() => driver.start(crashSpec, { gpu_ids: ['0'] }));
    assert.equal(await driver.isRunning(crashSpec), false);

    // Subsequent valid process start succeeds cleanly
    const okPort = await allocatePort();
    const okScript = path.join(ws.rootDir, 'healthy-proc.mjs');
    await writeFile(
      okScript,
      [
        `import http from 'node:http';`,
        `const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });`,
        `srv.listen(${okPort}, '127.0.0.1');`,
      ].join('\n'),
      'utf8',
    );
    const okSpec: RuntimeDriverSpec = {
      id: 'healthy-after-fail',
      name: 'Healthy After Fail',
      driver: 'process',
      port: okPort,
      command: resolveNode22Plus(),
      args: [okScript],
    };
    const handle = await driver.start(okSpec, { gpu_ids: ['0'] });
    t.after(async () => {
      await driver.stop(handle).catch(() => {});
    });
    assert.equal(await driver.isRunning(okSpec), true);
  });

  it('fa05.t2.2 rejects unreachable or 503 external base_url and reports isRunning === false', async (t) => {
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

    const driver = await resolveDriver(entry!, 'external');
    const closedPort = await allocatePort();
    const closedSpec: RuntimeDriverSpec = {
      id: 'ext-closed',
      name: 'Closed External',
      driver: 'external',
      port: closedPort,
      base_url: `http://127.0.0.1:${closedPort}`,
    };

    await assert.rejects(() => driver.start(closedSpec, { gpu_ids: [] }));
    assert.equal(await driver.isRunning(closedSpec), false);

    const unhealthyServer = await createMockOllamaServer({ unhealthy: true });
    t.after(() => unhealthyServer.close());
    const unhealthySpec: RuntimeDriverSpec = {
      id: 'ext-503',
      name: 'Unhealthy External',
      driver: 'external',
      port: unhealthyServer.port,
      base_url: unhealthyServer.base,
    };
    await assert.rejects(() => driver.start(unhealthySpec, { gpu_ids: [] }));
    assert.equal(await driver.isRunning(unhealthySpec), false);
  });

  it('fa05.t2.3 returns structured error and isRunning === false when Docker binary or daemon is unavailable', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa05-t2-3-');
    t.after(() => ws.cleanup());

    const emptyBin = path.join(ws.rootDir, 'empty-bin');
    const missingDockerBin = path.join(emptyBin, 'missing-docker');
    const spec: RuntimeDriverSpec = {
      id: 'docker-missing',
      name: 'Docker Missing',
      driver: 'docker',
      port: await allocatePort(),
      container: 'vramdeck-missing-docker',
      command: 'vllm/vllm-openai:latest',
    };

    await withEnv(
      {
        PATH: emptyBin,
        DOCKER_BIN: missingDockerBin,
        WORKBENCH_DOCKER_BIN: missingDockerBin,
      },
      async () => {
        const missingDriver = await resolveDriver(entry!, 'docker', {
          dockerBin: missingDockerBin,
        });
        await assert.rejects(() => missingDriver.start(spec, { gpu_ids: ['0'] }));
        assert.equal(await missingDriver.isRunning(spec), false);
      },
    );

    const failBin = path.join(ws.rootDir, 'fail-bin');
    const { dockerBin: failDockerBin } = await installFailingDockerShim(failBin);
    await withEnv(
      {
        PATH: `${failBin}${path.delimiter}${process.env.PATH ?? ''}`,
        DOCKER_BIN: failDockerBin,
        WORKBENCH_DOCKER_BIN: failDockerBin,
      },
      async () => {
        const failDriver = await resolveDriver(entry!, 'docker', { dockerBin: failDockerBin });
        await assert.rejects(
          () => failDriver.start(spec, { gpu_ids: ['0'] }),
          /Cannot connect to the Docker daemon/i,
          'Docker daemon failure must surface daemon unavailability error (never ENOENT)',
        );
        assert.equal(await failDriver.isRunning(spec), false);
      },
    );
  });

  it('fa05.t2.4 rejects invalid EngineManifestV2 fields (bad driver, missing port, bad vram_mode, invalid gpu_count)', async (t) => {
    const entry = await getDriversEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M3 (Feature #16): EngineManifestV2 negative validation lands with RuntimeDriver',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa05-t2-4-');
    t.after(() => ws.cleanup());

    const regRel =
      (await findFirstExisting([
        'platforms/workbench/lib/registry.ts',
        'platforms/workbench/lib/registry.mjs',
      ])) ?? 'platforms/workbench/lib/registry.mjs';
    const { Registry } = (await import(pathToFileURL(path.join(REPO_ROOT, regRel)).href)) as {
      Registry: new (opts: { enginesDir: string; statePath: string; publish: boolean }) => {
        packages: Array<{ id: string }>;
      };
    };

    // Control baseline: unmutated V2 manifest with valid surface MUST load cleanly without throwing
    const controlDir = path.join(ws.rootDir, 'valid-control');
    const controlManifest = createEngineManifestV2({
      name: 'valid-v2-control',
      engine: 'valid-v2-control',
      category: 'llm',
      port: await allocatePort(),
      runtime: {
        driver: 'process',
        command: resolveNode22Plus(),
        args: ['-e', 'setInterval(()=>{},1000)'],
      },
      resources: createResourceSpec(),
      surface: createValidMediaSurface('chat.completions', 'chat_mock', '/v1/mock/chat'),
    });
    await writeMockEnginePackage(controlDir, controlManifest);
    const controlReg = new Registry({
      enginesDir: controlDir,
      statePath: path.join(ws.configDir, 'control-state.json'),
      publish: false,
    });
    assert.equal(
      controlReg.packages.length,
      1,
      'Unmutated V2 control manifest must load cleanly in Registry',
    );

    const cases: Array<{
      label: string;
      pattern: RegExp;
      mutate: (m: Record<string, unknown>) => void;
    }> = [
      {
        label: 'invalid driver kind',
        pattern: /driver|runtime/i,
        mutate: (m) => {
          const p = m.platform as Record<string, unknown>;
          (p.runtime as Record<string, unknown>).driver = 'wasm';
        },
      },
      {
        label: 'missing/non-integer port',
        pattern: /port/i,
        mutate: (m) => {
          const p = m.platform as Record<string, unknown>;
          delete (p.runtime as Record<string, unknown>).port;
        },
      },
      {
        label: 'invalid vram_mode',
        pattern: /vram_mode|resources/i,
        mutate: (m) => {
          const p = m.platform as Record<string, unknown>;
          (p.resources as Record<string, unknown>).vram_mode = 'dedicated';
        },
      },
      {
        label: 'invalid gpu_count 0',
        pattern: /gpu_count|resources/i,
        mutate: (m) => {
          const p = m.platform as Record<string, unknown>;
          (p.resources as Record<string, unknown>).gpu_count = 0;
        },
      },
      {
        label: 'invalid affinity syntax',
        pattern: /affinity|resources/i,
        mutate: (m) => {
          const p = m.platform as Record<string, unknown>;
          (p.resources as Record<string, unknown>).affinity = 'sticky:0';
        },
      },
    ];

    for (let i = 0; i < cases.length; i += 1) {
      const enginesDir = path.join(ws.rootDir, `bad-case-${i}`);
      const manifest = createEngineManifestV2({
        name: `bad-v2-${i}`,
        engine: `bad-v2-${i}`,
        category: 'llm',
        port: await allocatePort(),
        runtime: {
          driver: 'process',
          command: resolveNode22Plus(),
          args: ['-e', 'setInterval(()=>{},1000)'],
        },
        resources: createResourceSpec(),
        surface: createValidMediaSurface('chat.completions', 'chat_mock', '/v1/mock/chat'),
      }) as unknown as Record<string, unknown>;
      cases[i].mutate(manifest);
      await writeMockEnginePackage(enginesDir, manifest as never);
      assert.throws(
        () =>
          new Registry({
            enginesDir,
            statePath: path.join(ws.configDir, `bad-state-${i}.json`),
            publish: false,
          }),
        cases[i].pattern,
        `Expected Registry to reject ${cases[i].label} with descriptive error`,
      );
    }
  });

  it('fa05.t2.5 handles idempotent stop(handle) and reports stopped spec isRunning === false', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa05-t2-5-');
    t.after(() => ws.cleanup());

    const port = await allocatePort();
    const script = path.join(ws.rootDir, 'idempotent-stop.mjs');
    await writeFile(
      script,
      [
        `import http from 'node:http';`,
        `const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });`,
        `srv.listen(${port}, '127.0.0.1');`,
      ].join('\n'),
      'utf8',
    );

    const driver = await resolveDriver(entry!, 'process');
    const spec: RuntimeDriverSpec = {
      id: 'idempotent-proc',
      name: 'Idempotent Stop Proc',
      driver: 'process',
      port,
      command: resolveNode22Plus(),
      args: [script],
    };

    const handle = await driver.start(spec, { gpu_ids: ['0'] });
    t.after(async () => {
      await driver.stop(handle).catch(() => {});
    });

    assert.equal(await driver.isRunning(spec), true);
    await driver.stop(handle);
    assert.equal(await driver.isRunning(spec), false);
    // Second stop() must be cleanly idempotent
    await driver.stop(handle);
    assert.equal(await driver.isRunning(spec), false);
  });
});
