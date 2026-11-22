import test from 'node:test';
import assert from 'node:assert/strict';
import { Backend, ROOT, command, resolveCommand } from '../lib/backend.mjs';
import {
  inspectPaitonMode,
  previewPlan,
  readCapacity,
  sleepResidency,
  startupLogs,
  createPaitonState,
} from '../../../engines/shared/paiton/client.mjs';
import qwenAdapter from '../../../engines/llm/pation-model-qwen38-27b-w3a4/adapter.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('startup logs survive gateway restart, exclude runtime noise and follow container identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-startup-'));
  try {
    const b = new Backend();
    let id = 'first',
      reads = 0;
    b.run = async () => id;
    b.capture = async () => {
      reads++;
      return {
        stdout:
          'loading weights\nGPU KV cache size: 290,785 tokens\nApplication startup complete.\nGET /health\n',
        stderr: '',
      };
    };
    const ctx = { ...b.context('llm'), startupLogPath: join(dir, 'startup.json') };
    const state = createPaitonState('long');
    const startup = await startupLogs(ctx, state);
    assert.equal(startup.complete, true);
    assert.match(startup.output, /loading weights/);
    assert.doesNotMatch(startup.output, /GET \/health/);
    await startupLogs(ctx, state);
    assert.equal(reads, 1);
    const restarted = new Backend();
    restarted.run = async () => id;
    restarted.capture = async () => ({ stdout: 'GET /health', stderr: '' });
    const restartedCtx = { ...restarted.context('llm'), startupLogPath: join(dir, 'startup.json') };
    const restartedState = createPaitonState('long');
    await readCapacity(restartedCtx, restartedState);
    assert.equal(restartedState.capacityTokens, 290785);
    assert.equal((await startupLogs(restartedCtx, restartedState)).output, startup.output);
    id = 'second';
    restarted.capture = async () => ({ stdout: 'new engine loading', stderr: '' });
    const next = await startupLogs(restartedCtx, restartedState);
    assert.equal(next.id, 'second');
    assert.equal(next.complete, false);
    assert.equal(next.output, 'new engine loading');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('cold switch verifies idle twice before stop and start', async () => {
  const b = new Backend(),
    events = [];
  b.running = async () => ['anima'];
  b.idle = async () => {
    events.push('idle');
    return true;
  };
  b.ready = async () => true;
  b.stop = async (m) => events.push('stop:' + m);
  b.run = async (_, args) => {
    events.push('start:' + args[0]);
    return '';
  };
  await b.ensure('qwen-image', performance.now() / 1000 + 10, () => performance.now() / 1000);
  assert.deepEqual(events, ['idle', 'idle', 'stop:anima', 'start:pation-model-qwen-image-21']);
});
test('failed LLM sleep falls back to stop before media starts', async () => {
  const b = new Backend(),
    events = [];
  b.running = async () => ['llm'];
  b.idle = async () => true;
  b.ready = async () => true;
  b.config = async () => ({
    enabled: true,
    models: ['llm'],
    minimum_available_memory_gib: 32,
    transition_timeout_seconds: 5,
  });
  b.labelled = async () => true;
  b.memory = async () => 64 * 2 ** 30;
  b.stop = async (m) => events.push('stop:' + m);
  b.run = async () => {
    events.push('start');
    return '';
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offload failed');
  };
  try {
    await b.ensure('anima', performance.now() / 1000 + 10, () => performance.now() / 1000);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.deepEqual(events, ['stop:llm', 'start']);
});
test('missing GPU activity metrics retain busy status', async () => {
  const b = new Backend();
  b.rows = async () => ['paiton-qwen38'];
  const old = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => 'vllm:num_requests_running 0\n' });
  try {
    assert.equal(await b.idle('llm'), false);
  } finally {
    globalThis.fetch = old;
  }
});
test('insufficient RAM skips CPU offload without issuing a request', async () => {
  const b = new Backend();
  b.config = async () => ({ enabled: true, models: ['llm'], minimum_available_memory_gib: 32 });
  b.labelled = async () => true;
  b.memory = async () => 31 * 2 ** 30;
  assert.equal(await sleepResidency(b.context('llm')), false);
});
test('matching context, concurrency and BF16 worker is reused', async () => {
  const b = new Backend(),
    policy = { context_tokens: 65536, concurrency: 2, kv_budget_bytes: 8859648000 };
  b.running = async () => ['llm'];
  b.ready = async () => true;
  const origMatches = qwenAdapter.matches;
  qwenAdapter.matches = async () => true;
  b.run = async () => {
    throw new Error('Should not reload');
  };
  try {
    await b.ensure('llm', performance.now() / 1000 + 10, () => performance.now() / 1000, policy);
  } finally {
    qwenAdapter.matches = origMatches;
  }
});
test('different serving limits stop and launch with actual context, concurrency and fixed KV', async () => {
  const b = new Backend(),
    policy = { context_tokens: 65536, concurrency: 2, kv_budget_bytes: 8859648000 },
    events = [];
  b.running = async () => ['llm'];
  b.ready = async () => true;
  b.idle = async () => true;
  b.sleeping = async () => false;
  b.labelled = async () => false;
  b.rows = async () => [];
  let mode = '262144:8:bf16:8859648000:graph';
  const origMatches = qwenAdapter.matches;
  const origVerify = qwenAdapter.verify;
  qwenAdapter.matches = async (_ctx, targetPolicy) =>
    mode ===
    `${targetPolicy.context_tokens}:${targetPolicy.concurrency}:bf16:${targetPolicy.kv_budget_bytes}:graph`;
  qwenAdapter.verify = async (ctx, targetPolicy) => {
    if (!(await qwenAdapter.matches(ctx, targetPolicy))) {
      throw new Error('LLM started with an unexpected context or concurrency configuration');
    }
  };
  b.stop = async () => {
    events.push('stop');
  };
  b.run = async (_, args) => {
    events.push(args);
    mode = '65536:2:bf16:8859648000:graph';
  };
  try {
    await b.ensure('llm', performance.now() / 1000 + 10, () => performance.now() / 1000, policy);
  } finally {
    qwenAdapter.matches = origMatches;
    qwenAdapter.verify = origVerify;
  }
  assert.equal(events[0], 'stop');
  const args = events[1];
  for (const [flag, value] of [
    ['--context', '65536'],
    ['--max-num-seqs', '2'],
    ['--kv-cache-memory-bytes', '8859648000'],
    ['--lm-head', 'bf16'],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
});
test('capacity is read from real worker log output including stderr and refreshed for new containers', async () => {
  const b = new Backend();
  const state = createPaitonState('long');
  let id = 'one';
  b.run = async () => id;
  b.capture = async () => ({ stdout: '', stderr: 'GPU KV cache size: 380,928 tokens' });
  await readCapacity(b.context('llm'), state);
  assert.equal(state.capacityTokens, 380928);
  id = 'two';
  b.capture = async () => ({ stdout: 'GPU KV cache size: 381,440 tokens', stderr: '' });
  await readCapacity(b.context('llm'), state);
  assert.equal(state.capacityTokens, 381440);
});

test('engine log output retains native messages and is not scoped to policy changes', async () => {
  const b = new Backend();
  const origStartupLogs = qwenAdapter.startupLogs;
  qwenAdapter.startupLogs = async () => null;
  b.run = async () => 'instance-one';
  b.capture = async (bin, args) => {
    assert.equal(bin, 'docker');
    assert.deepEqual(args, ['logs', '--timestamps', '--tail', '10000', 'paiton-qwen38']);
    return {
      stdout: 'native progress\n\n',
      stderr: 'INFO GET /health\nWARNING diagnostic\nTraceback\n',
    };
  };
  try {
    const logs = await b.engineLogs('llm');
    assert.equal(logs.available, true);
    assert.equal(logs.output, 'native progress\n\nINFO GET /health\nWARNING diagnostic\nTraceback');
    assert.equal(logs.model, 'llm');
    assert.equal(logs.engine, 'vLLM');
    assert.deepEqual(logs.containers, ['paiton-qwen38']);
  } finally {
    qwenAdapter.startupLogs = origStartupLogs;
  }
});

test('engine output follows each media model; engines sharing a runtime read its container', async () => {
  const b = new Backend(),
    seen = [];
  b.run = async (_, args) => args.at(-1) + '-id';
  b.rows = async () => ['paiton-h3-comfyui-1'];
  b.capture = async (_, args) => {
    seen.push(args.at(-1));
    return { stdout: 'model output', stderr: '' };
  };
  for (const model of ['qwen-image', 'h3', 'anima']) {
    const logs = await b.engineLogs(model);
    assert.equal(logs.model, model);
    assert.equal(logs.available, true);
    assert.equal(logs.output, 'model output');
  }
  // The shared container's log reader serves both of its engines.
  assert.deepEqual(seen, ['paiton-qwen-image21', 'paiton-h3-comfyui-1']);
  assert.equal((await b.engineLogs('anima')).engine, 'ComfyUI · Anima');
  const before = seen.length;
  assert.equal((await b.engineLogs(null)).available, false);
  assert.equal(seen.length, before);
});

test('offline preview survives missing engine without inspecting or starting a container', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-preview-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const b = new Backend();
    const kvPreviewPath = join(dir, 'plan.json');
    b.run = async () => {
      throw Error('must not call docker');
    };
    const ctx = { ...b.context('llm'), kvPreviewPath };
    const plan = {
      version: 2,
      id: 'captured-layout',
      matrix: { '54272:6:graph': { block_bytes: 14336000, blocks_per_request: 89 } },
    };
    await writeFile(kvPreviewPath, JSON.stringify(plan));
    const saved = await previewPlan(ctx);
    assert.equal(saved.preview_only, true);
    assert.deepEqual(saved.matrix, plan.matrix);
    await writeFile(kvPreviewPath, 'invalid');
    assert.equal(await previewPlan(ctx), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('launch output streams stdout and stderr before command completion', async () => {
  let completed = false;
  const chunks = [];
  const output = await command(
    process.execPath,
    [
      '-e',
      "process.stdout.write('loading\\n');process.stderr.write('warning\\n');setTimeout(()=>process.stdout.write('ready\\n'),60)",
    ],
    {
      onOutput: (chunk) => {
        assert.equal(completed, false);
        chunks.push(chunk);
      },
    },
  );
  completed = true;
  assert.match(chunks.join(''), /loading/);
  assert.match(chunks.join(''), /warning/);
  assert.match(output, /ready/);
});
test('switch log cutoff excludes previous runtime without discarding the shared log buffer', async () => {
  const b = new Backend();
  b.run = async () => 'instance-one';
  b.capture = async () => ({
    stdout:
      '2026-10-15T00:00:00.000000000Z previous runtime\n2026-10-15T01:00:00.000000000Z new startup',
    stderr: '',
  });
  assert.equal(
    (await b.engineLogs('h3', { since: '2026-10-15T01:00:00.000Z' })).output,
    '2026-10-15T01:00:00.000000000Z new startup',
  );
  assert.match((await b.engineLogs('h3')).output, /previous runtime/);
});
test('container logs follow incrementally, coalesce concurrent readers and reset on recreation', async () => {
  const b = new Backend();
  let id = 'first',
    captures = 0;
  b.run = async () => id;
  b.capture = async (_, args) => {
    captures++;
    if (captures === 2) {
      assert.ok(args.includes('--since'));
      assert.equal(args[args.indexOf('--since') + 1], '2026-10-16T00:00:00.000000001Z');
    }
    return {
      stdout:
        captures === 1
          ? '2026-10-16T00:00:00.000000001Z first generation'
          : captures === 2
            ? '2026-10-16T00:00:00.000000001Z first generation\n2026-10-16T00:00:01.000000000Z second generation'
            : '2026-10-16T01:00:00.000000000Z recreated engine',
      stderr: '',
    };
  };
  await Promise.all([b.engineLogs('h3'), b.engineLogs('h3')]);
  assert.equal(captures, 1);
  b.logReaders.get('paiton-h3-comfyui-1').updatedAt = 0;
  assert.match((await b.engineLogs('h3')).output, /first generation[\s\S]*second generation/);
  id = 'second';
  b.logReaders.get('paiton-h3-comfyui-1').updatedAt = 0;
  const result = await b.engineLogs('h3');
  assert.equal(result.container_id, 'second');
  assert.doesNotMatch(result.output, /first generation/);
});
test('worker reuse requires prefix caching with aligned recurrent state', async (t) => {
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'runtime-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = { llm: { image: 'local-ai/qwen38:test' } };
  await writeFile(join(dir, 'runtime-images.json'), JSON.stringify(runtime));
  const args = [
    'serve',
    '--max-model-len',
    '196608',
    '--max-num-seqs',
    '2',
    '--kv-cache-memory-bytes',
    '8859648000',
    '--max-num-batched-tokens',
    '1024',
    '--long-prefill-token-threshold',
    '512',
    '--mamba-cache-mode',
    'align',
    '--enable-prefix-caching',
  ];
  const env = [
    'HIP_VISIBLE_DEVICES=0',
    'PAITON_LMHEAD_W8=0',
    'WORKBENCH_ROCM_HIP=1',
    'WORKBENCH_CONFIGURATION_VERSION=2',
    'RADIANCE_GDN_LAZY=0',
  ];
  const b = new Backend();
  const state = createPaitonState('long');
  const ctx = {
    ...b.context('llm'),
    runtimeImagesPath: join(dir, 'runtime-images.json'),
  };
  b.run = async (_, command) =>
    command.includes('{{.Config.Image}}')
      ? runtime.llm.image
      : command.includes('{{json .Config.Cmd}}')
        ? JSON.stringify(args)
        : JSON.stringify(env);
  assert.equal(await inspectPaitonMode(ctx, state), '196608:2:bf16:8859648000:graph');
  assert.equal(state.configuration.prefix_caching, true);
  args[args.indexOf('--enable-prefix-caching')] = '--no-enable-prefix-caching';
  assert.equal(await inspectPaitonMode(ctx, state), null);
  args[args.indexOf('--no-enable-prefix-caching')] = '--enable-prefix-caching';
  args[args.indexOf('--mamba-cache-mode') + 1] = 'none';
  assert.equal(await inspectPaitonMode(ctx, state), null);
});
test('memory, vram, hardwareSnapshot and startupLogs work cross-platform with WORKBENCH_MOCK_GPUS', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-fallback-'));
  const prevMock = process.env.WORKBENCH_MOCK_GPUS;
  t.after(async () => {
    if (prevMock === undefined) delete process.env.WORKBENCH_MOCK_GPUS;
    else process.env.WORKBENCH_MOCK_GPUS = prevMock;
    await rm(dir, { recursive: true, force: true });
  });

  process.env.WORKBENCH_MOCK_GPUS = '[]';
  const b = new Backend();
  const mem = await b.memory();
  assert.ok(Number.isFinite(mem) && mem > 0);
  assert.equal(await b.vram(), 0);
  const emptySnap = await b.hardwareSnapshot();
  assert.deepEqual(emptySnap.gpus, []);
  assert.ok(emptySnap.host.ram_total_mb > 0);

  process.env.WORKBENCH_MOCK_GPUS = JSON.stringify([
    {
      vendor: 'nvidia',
      backend: 'cuda',
      name: 'Mock RTX 4090',
      vram_total_mb: 24576,
      vram_used_mb: 4096,
    },
  ]);
  assert.equal(await b.vram(), 4096 * 1024 * 1024);
  const mockDevices = await b.devices();
  assert.equal(mockDevices.length, 1);
  assert.equal(mockDevices[0].name, 'Mock RTX 4090');

  b.run = async () => 'id-1500';
  const manyLines = Array.from({ length: 1600 }, (_, i) => `line-${i}`).join('\n');
  b.capture = async (bin, args) => {
    assert.equal(bin, 'docker');
    assert.deepEqual(args, ['logs', '--timestamps', 'paiton-qwen38']);
    return { stdout: manyLines, stderr: '' };
  };
  const logs = await startupLogs(
    { ...b.context('llm'), startupLogPath: join(dir, 'startup.json') },
    createPaitonState('long'),
  );
  assert.equal(logs.output.split('\n').length, 1500);
});

test('command translates ROOT + lab to .workbench/cli.py on win32', async (t) => {
  const prev = process.env.WORKBENCH_PYTHON;
  t.after(() => {
    if (prev === undefined) delete process.env.WORKBENCH_PYTHON;
    else process.env.WORKBENCH_PYTHON = prev;
  });
  delete process.env.WORKBENCH_PYTHON;

  const translated = resolveCommand(ROOT + 'lab', ['status'], {}, 'win32');
  assert.equal(translated.bin, 'python');
  assert.deepEqual(translated.args, [join(ROOT, '.workbench', 'cli.py'), 'status']);
  assert.equal(
    translated.options.env.PYTHONPYCACHEPREFIX,
    join(ROOT, '.workbench', 'cache', 'python'),
  );

  process.env.WORKBENCH_PYTHON = 'custom-python';
  const custom = resolveCommand(join(ROOT, 'lab'), ['--help'], {}, 'win32');
  assert.equal(custom.bin, 'custom-python');
  assert.deepEqual(custom.args, [join(ROOT, '.workbench', 'cli.py'), '--help']);

  const posix = resolveCommand(ROOT + 'lab', ['status'], {}, 'linux');
  assert.equal(posix.bin, ROOT + 'lab');
  assert.deepEqual(posix.args, ['status']);

  if (process.platform === 'win32') {
    delete process.env.WORKBENCH_PYTHON;
    const output = await command(ROOT + 'lab', ['--help']);
    assert.match(output, /\.workbench|lab/i);
  }
});
