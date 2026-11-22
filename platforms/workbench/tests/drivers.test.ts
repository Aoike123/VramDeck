import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DockerDriver,
  ExternalDriver,
  ProcessDriver,
  buildDockerGpuArgs,
  buildGpuVisibilityEnv,
} from '../lib/drivers/index.ts';
import { Registry } from '../lib/registry.ts';

test('ProcessDriver spawns child, injects multi-vendor GPU env, captures logs, and stops cleanly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drv-proc-'));
  try {
    const script = path.join(dir, 'echo-server.mjs');
    await writeFile(
      script,
      [
        `import http from 'node:http';`,
        `console.log('DRIVER_BOOT_OK');`,
        `const s = http.createServer((_, r) => { r.writeHead(200); r.end('ok'); });`,
        `s.listen(0, '127.0.0.1');`,
        `process.on('SIGTERM', () => s.close(() => process.exit(0)));`,
      ].join('\n'),
    );

    const driver = new ProcessDriver({ startupGraceMs: 100 });
    const spec = {
      id: 'unit-proc',
      name: 'Unit Process',
      driver: 'process' as const,
      port: 0,
      command: process.execPath,
      args: [script],
    };
    const handle = await driver.start(spec, { gpu_ids: ['nvidia:1', 'amd:0'] });
    try {
      assert.equal(handle.driver, 'process');
      assert.ok((handle.pid ?? 0) > 0);
      assert.equal(await driver.isRunning(spec), true);
      let out = '';
      for (let i = 0; i < 40; i++) {
        out = await driver.logs(handle, { tail: 10 });
        if (/DRIVER_BOOT_OK/.test(out)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.match(out, /DRIVER_BOOT_OK/);
    } finally {
      await driver.stop(handle);
    }
    assert.equal(await driver.isRunning(spec), false);

    const gpuEnv = buildGpuVisibilityEnv(['amd:2', 'amd:3']);
    assert.equal(gpuEnv.HIP_VISIBLE_DEVICES, '2,3');
    assert.equal(gpuEnv.ROCR_VISIBLE_DEVICES, '2,3');
    assert.equal(gpuEnv.CUDA_VISIBLE_DEVICES, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DockerDriver constructs CUDA --gpus and ROCm device args and honors dockerBin', async () => {
  assert.deepEqual(buildDockerGpuArgs(['nvidia:0', 'nvidia:2'], 'cuda'), ['--gpus', 'device=0,2']);
  assert.deepEqual(buildDockerGpuArgs(['amd:1'], 'rocm'), [
    '--device',
    '/dev/kfd',
    '--device',
    '/dev/dri',
    '-e',
    'HIP_VISIBLE_DEVICES=1',
    '-e',
    'ROCR_VISIBLE_DEVICES=1',
    '-e',
    'GGML_VK_VISIBLE_DEVICES=1',
  ]);

  const calls: Array<{ bin: string; args: string[] }> = [];
  const driver = new DockerDriver({
    dockerBin: 'custom-docker',
    execFn: async (bin, args) => {
      calls.push({ bin, args });
      if (args[0] === 'inspect') return { stdout: 'true\n', stderr: '' };
      if (args[0] === 'logs') return { stdout: 'container line\n', stderr: '' };
      return { stdout: 'cid-1\n', stderr: '' };
    },
  });

  const spec = {
    id: 'vllm-unit',
    name: 'vLLM Unit',
    driver: 'docker' as const,
    port: 18000,
    container: 'vramdeck-vllm-unit',
    command: 'vllm/vllm-openai:latest',
    resources: {
      backends: ['cuda' as const],
      gpu_count: 2,
      vram_mb: 12000,
      vram_mode: 'exclusive' as const,
      concurrency: 1,
    },
  };

  const handle = await driver.start(spec, { gpu_ids: ['0', '1'] });
  assert.equal(calls[0].bin, 'custom-docker');
  assert.equal(calls[0].args[0], 'run');
  assert.ok(calls[0].args.includes('--gpus'));
  assert.ok(calls[0].args.includes('device=0,1'));
  assert.equal(await driver.isRunning(spec), true);
  assert.equal(await driver.logs(handle), 'container line');
  await driver.stop(handle);
  assert.equal(calls.at(-1)?.args[0], 'stop');
});

test('ExternalDriver attaches to live HTTP service without killing it and Registry validates EngineManifestV2', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404);
    res.end('ok');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const ext = new ExternalDriver();
    const spec = {
      id: 'ext-srv',
      name: 'External Server',
      driver: 'external' as const,
      port,
      base_url: `http://127.0.0.1:${port}`,
      health_path: '/health',
    };
    const handle = await ext.start(spec, { gpu_ids: ['0'] });
    assert.equal(handle.driver, 'external');
    assert.equal(await ext.isRunning(spec), true);
    await ext.stop(handle);
    assert.equal(await ext.isRunning(spec), true);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'reg-v2-'));
  try {
    const pkgDir = path.join(dir, 'llm', 'bad-pkg');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, 'engine.json'),
      JSON.stringify({
        name: 'bad-pkg',
        category: 'llm',
        platform: {
          engine: 'bad-pkg',
          runtime: { id: 'rt-bad', name: 'Bad', driver: 'process', port: 19999, command: 'node' },
          resources: {
            backends: ['cuda'],
            gpu_count: 0,
            vram_mb: 1024,
            vram_mode: 'shared',
            concurrency: 1,
          },
          ui: {
            name: 'Bad',
            description: 'Bad pkg',
            symbol: 'B',
            accent: '#fff',
            panel: 'llm',
          },
          models: [],
        },
      }),
    );
    assert.throws(
      () =>
        new Registry({
          enginesDir: dir,
          statePath: path.join(dir, 'state.json'),
          publish: false,
        }),
      /gpu_count/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
