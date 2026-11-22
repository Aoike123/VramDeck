import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pause } from './core.mjs';
import { EngineLogBuffer } from './engine-logs.mjs';
import { sameRuntime } from './runtime-topology.mjs';
import { registry } from './registry.mjs';
import { createDeviceProvider, readHostResources } from './devices/index.ts';
import { buildGpuVisibilityEnv, createRuntimeDrivers, resolveDriverKind } from './drivers/index.ts';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const exec = promisify(execFile);

export function resolveCommand(bin, args, options = {}, platform = process.platform) {
  if (platform === 'win32' && (bin === ROOT + 'lab' || bin === join(ROOT, 'lab'))) {
    return {
      bin: process.env.WORKBENCH_PYTHON || 'python',
      args: [join(ROOT, '.workbench', 'cli.py'), ...args],
      options: {
        ...options,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          ...options.env,
          PYTHONPYCACHEPREFIX: join(ROOT, '.workbench', 'cache', 'python'),
        },
      },
    };
  }
  return { bin, args, options };
}

export async function command(bin, args, options = {}) {
  ({ bin, args, options } = resolveCommand(bin, args, options));
  const { onOutput, ...settings } = options;
  const config = { timeout: 90000, maxBuffer: 8 * 1024 * 1024, ...settings };
  if (!onOutput) return (await exec(bin, args, config)).stdout.trim();
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, config, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
    child.stdout?.on('data', (chunk) => onOutput(String(chunk)));
    child.stderr?.on('data', (chunk) => onOutput(String(chunk)));
  });
}

export async function call(base, path, data, timeout = 30000) {
  const r = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    body: data === undefined ? undefined : JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { error: `Backend HTTP ${r.status}` };
  }
  if (!r.ok) {
    const reason =
      typeof result.error === 'string'
        ? result.error
        : typeof result.error?.message === 'string'
          ? result.error.message
          : null;
    const e = new Error(
      reason ? `Backend HTTP ${r.status}: ${reason}` : `Backend HTTP ${r.status}`,
    );
    e.status = r.status;
    e.data = result;
    throw e;
  }
  return result;
}

export class Backend {
  run = command;
  capture = exec;
  dockerUnavailable = false;
  #dockerUnavailableUntil = 0;

  constructor({ deviceProvider, dataDir, drivers } = {}) {
    this.deviceProvider = deviceProvider ?? createDeviceProvider();
    this.dataDir = dataDir ?? null;
    this.drivers = drivers ?? createRuntimeDrivers();
  }

  async hardwareSnapshot() {
    return this.deviceProvider.detect();
  }

  async devices() {
    return (await this.hardwareSnapshot()).gpus;
  }

  #isDockerDisabled() {
    if (this.run !== command) return false;
    if (process.env.WORKBENCH_DISABLE_DOCKER === '1') {
      this.dockerUnavailable = true;
      return true;
    }
    return this.#dockerUnavailableUntil > Date.now();
  }

  #markDockerError(error) {
    if (this.run !== command) return false;
    const code = error?.code;
    const msg = String(error?.stderr ?? error?.message ?? '');
    if (code === 'ENOENT') {
      this.dockerUnavailable = true;
      this.#dockerUnavailableUntil = Number.POSITIVE_INFINITY;
      return true;
    }
    if (
      /Cannot connect to the Docker daemon|Is the docker daemon running|dockerDesktopLinuxEngine|pipe\/docker_engine/i.test(
        msg,
      )
    ) {
      this.dockerUnavailable = true;
      this.#dockerUnavailableUntil = Date.now() + 30_000;
      return true;
    }
    return false;
  }

  // Scheduler engines come from the enabled packages: [launch, port, container] per engine.
  get models() {
    return Object.fromEntries(
      Object.entries(registry.engines()).map(([engine, pkg]) => {
        const r = pkg.manifest.platform.runtime;
        return [engine, [[...(r.launch ?? [])], r.port ?? null, r.container ?? null]];
      }),
    );
  }

  get resources() {
    return Object.fromEntries(
      Object.entries(registry.engines())
        .filter(([, pkg]) => pkg.manifest.platform.resources)
        .map(([engine, pkg]) => [engine, pkg.manifest.platform.resources]),
    );
  }

  context(engine, gpuIds = undefined) {
    const pkg = registry.enginePackage(engine);
    if (!pkg) {
      throw Object.assign(new Error('Unknown or disabled engine: ' + engine), {
        code: 'ENGINE_UNAVAILABLE',
      });
    }
    const runtime = pkg.manifest.platform.runtime;
    const base =
      runtime.base_url ??
      (runtime.port ? 'http://127.0.0.1:' + runtime.port : 'http://127.0.0.1:0');
    return {
      backend: this,
      engine,
      runtime,
      base: base.replace(/\/$/, ''),
      package: pkg,
      ...(this.dataDir ? { dataDir: this.dataDir } : {}),
      ...(gpuIds ? { gpu_ids: gpuIds } : {}),
    };
  }

  async adapter(engine) {
    const adapter = await registry.adapter(engine);
    if (!adapter) {
      throw Object.assign(new Error('Unknown or disabled engine: ' + engine), {
        code: 'ENGINE_UNAVAILABLE',
      });
    }
    return adapter;
  }

  async initAdapters() {
    for (const pkg of registry.enabledPackages()) {
      const adapter = await registry.adapterOf(pkg);
      if (adapter?.init) {
        await adapter.init(this.context(pkg.manifest.platform.engine));
      }
    }
  }

  containersOf(engine) {
    const r = registry.enginePackage(engine)?.manifest.platform.runtime;
    return r ? [r.container, ...(r.extra_containers ?? [])].filter(Boolean) : [];
  }

  sameRuntime = sameRuntime;

  async config() {
    try {
      return JSON.parse(await readFile(ROOT + 'platforms/scheduler/residency.json', 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { enabled: false, models: [] };
      throw error;
    }
  }

  async containerStatus(container) {
    return this.run('docker', ['inspect', '--format', '{{.State.Status}}', container]);
  }

  async memory() {
    try {
      return (await readHostResources()).ram_free_mb * 1048576;
    } catch {
      return freemem();
    }
  }

  async vram() {
    try {
      const snapshot = await this.hardwareSnapshot();
      return snapshot.gpus.reduce((sum, gpu) => sum + (Number(gpu.vram_used_mb) || 0) * 1048576, 0);
    } catch {
      return 0;
    }
  }

  async residency() {
    const cfg = await this.config();
    const engines = {};
    for (const pkg of registry.enabledPackages()) {
      const engine = pkg.manifest.platform.engine;
      try {
        const adapter = await registry.adapterOf(pkg);
        if (adapter?.residencyStatus) {
          const status = await adapter.residencyStatus(this.context(engine));
          if (status) engines[engine] = status.state ?? 'cold';
        }
      } catch {}
    }
    return {
      enabled: cfg.enabled,
      models: cfg.models ?? [],
      engines,
      ...engines,
      available_memory_bytes: await this.memory(),
    };
  }

  async rows() {
    if (this.#isDockerDisabled()) return [];
    try {
      return (await this.run('docker', ['ps', '--format', '{{.Names}}'], { timeout: 3000 })).split(
        '\n',
      );
    } catch (error) {
      if (this.#markDockerError(error)) return [];
      throw error;
    }
  }

  async running() {
    const rows = await this.rows();
    if (rows.includes('ai-vbench')) {
      throw new Error('VBench holds GPU; finish evaluation before switching');
    }
    const active = [];
    const seenRuntimes = new Set();
    for (const [engine, pkg] of Object.entries(registry.engines())) {
      const runtime = pkg.manifest.platform.runtime;
      const driverKind = resolveDriverKind(runtime);
      if (driverKind === 'process' || driverKind === 'external') {
        if (seenRuntimes.has(runtime.id)) continue;
        if (!(await this.drivers.isRunning(runtime))) continue;
        const adapter = await this.adapter(engine);
        if (await adapter.parked?.(this.context(engine))) continue;
        active.push(engine);
        seenRuntimes.add(runtime.id);
        continue;
      }

      const containers = this.containersOf(engine).filter((name) => rows.includes(name));
      if (!containers.length || containers.some((name) => seenRuntimes.has(name))) continue;
      if (await (await this.adapter(engine)).parked?.(this.context(engine))) continue;
      active.push(engine);
      containers.forEach((name) => seenRuntimes.add(name));
    }
    return active;
  }

  async idle(model) {
    try {
      const pkg = registry.enginePackage(model);
      if (!pkg) return true;
      const runtime = pkg.manifest.platform.runtime;
      const driverKind = resolveDriverKind(runtime);
      if (driverKind === 'process' || driverKind === 'external') {
        if (!(await this.drivers.isRunning(runtime))) return true;
        return await (await this.adapter(model)).idle(this.context(model));
      }
      const rows = await this.rows();
      if (!this.containersOf(model).some((name) => rows.includes(name))) return true;
      return await (await this.adapter(model)).idle(this.context(model));
    } catch {
      return false;
    }
  }

  async ready(model) {
    try {
      return await (await this.adapter(model)).ready(this.context(model));
    } catch {
      return false;
    }
  }

  async stop(model, gpuIds = []) {
    const pkg = registry.enginePackage(model);
    const r = pkg?.manifest.platform.runtime;
    const driverKind = resolveDriverKind(r);
    if (driverKind === 'docker' && r?.launch?.length) {
      const args = [...r.launch];
      args[1] = 'stop';
      await this.run(ROOT + 'lab', args);
    } else if (r) {
      const handle = this.drivers.handleOf(r.id) ?? {
        runtime_id: r.id,
        driver: driverKind,
        base_url: r.base_url ?? 'http://127.0.0.1:' + r.port,
        gpu_ids: gpuIds,
        container: r.container,
      };
      await this.drivers.stop(handle);
    }
    (await this.adapter(model)).onStop?.(this.context(model, gpuIds));
  }

  logReaders = new Map();

  async containerLogs(container, options = {}) {
    let reader = this.logReaders.get(container);
    if (reader?.pending) {
      return reader.pending.then(() => this.containerLogResult(container, reader, options));
    }
    if (reader && Date.now() - reader.updatedAt < 1000) {
      return this.containerLogResult(container, reader, options);
    }
    if (!reader) {
      reader = { buffer: new EngineLogBuffer(), updatedAt: 0 };
      this.logReaders.set(container, reader);
    }
    reader.pending = (async () => {
      try {
        const id = await this.run('docker', ['inspect', '--format', '{{.Id}}', container], {
          timeout: 4000,
        });
        if (id !== reader.id) {
          reader.id = id;
          reader.buffer = new EngineLogBuffer();
        }
        const cursor = reader.buffer.cursor;
        const args = [
          'logs',
          '--timestamps',
          '--tail',
          '10000',
          ...(cursor ? ['--since', cursor] : []),
          container,
        ];
        const { stdout, stderr } = await this.capture('docker', args, {
          timeout: 4000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const combined = (
          stdout && stderr && !stdout.endsWith('\n') ? stdout + '\n' + stderr : stdout + stderr
        ).replaceAll('\r\n', '\n');
        reader.buffer.ingest(combined);
        reader.available = true;
        reader.error = null;
      } catch {
        // A container that does not exist yet (engine never started, or removed) is not a read failure.
        const exists = await this.run(
          'docker',
          ['container', 'ls', '-aq', '--filter', 'name=^/' + container + '$'],
          { timeout: 4000 },
        ).then(Boolean, () => true);
        reader.available = false;
        reader.error = exists ? '日志读取暂时失败，已保留上次输出；正在重试。' : null;
      } finally {
        reader.updatedAt = Date.now();
      }
    })();
    try {
      await reader.pending;
    } finally {
      reader.pending = null;
    }
    return this.containerLogResult(container, reader, options);
  }

  containerLogResult(container, reader, options) {
    return {
      container,
      id: reader.id,
      output: reader.buffer.output(options),
      available: reader.available,
      suppressed: reader.buffer.suppressed,
      error: reader.error,
    };
  }

  async engineLogs(model = null, { since, includeProbes = false } = {}) {
    const pkg = model ? registry.enginePackage(model) : null;
    if (!pkg) {
      return {
        model: null,
        engine: null,
        containers: [],
        output: '当前没有运行中的模型，等待任务。',
        available: false,
      };
    }
    const ctx = this.context(model);
    const adapter = await this.adapter(model);
    const runtime = pkg.manifest.platform.runtime;
    const driverKind = resolveDriverKind(runtime);
    let engine = pkg.manifest.platform.ui.log_name ?? pkg.manifest.platform.ui.name;

    if (driverKind !== 'docker' && !runtime.container) {
      const output = await this.drivers.logs(runtime, { since });
      return {
        model,
        engine,
        containers: [],
        output,
        available: Boolean(output),
        startup_output: null,
        startup_complete: false,
        container_id: null,
        suppressed_probe_lines: 0,
        include_probes: includeProbes,
        log_error: null,
      };
    }

    let containers = runtime.container ? [runtime.container] : [];
    if (adapter.logContainers) {
      try {
        const picked = adapter.logContainers(ctx, await this.rows());
        containers = picked.containers;
        engine = picked.label;
      } catch {}
    }
    const results = await Promise.all(
      containers.map((container) => this.containerLogs(container, { since, includeProbes })),
    );
    const startup = adapter.startupLogs ? await adapter.startupLogs(ctx) : null;
    return {
      model,
      engine,
      containers,
      output: results
        .map((r) => (containers.length > 1 ? '── ' + r.container + ' ──\n' : '') + r.output)
        .join('\n'),
      available: results.some((r) => r.available),
      startup_output: startup?.output ?? null,
      startup_complete: startup?.complete ?? false,
      container_id:
        results
          .map((r) => r.id)
          .filter(Boolean)
          .join(',') || null,
      suppressed_probe_lines: results.reduce((n, r) => n + r.suppressed, 0),
      include_probes: includeProbes,
      log_error: results.find((r) => r.error)?.error ?? null,
    };
  }

  // Load one engine: drain/release conflicting runtimes if needed, then start the target via its driver.
  async ensure(model, deadline, clock, policy = undefined, report = () => {}, gpuIds = []) {
    const pkg = registry.enginePackage(model);
    const adapter = await this.adapter(model);
    const ctx = this.context(model, gpuIds);
    const runtime = pkg?.manifest.platform.runtime;
    const driverKind = resolveDriverKind(runtime);
    const skipGlobalDrain = Array.isArray(gpuIds) && gpuIds.length > 0;

    let active = skipGlobalDrain ? [] : await this.running();
    if (
      active.length === 1 &&
      this.sameRuntime(active[0], model) &&
      (await this.ready(model)) &&
      ((await adapter.matches?.(ctx, policy)) ?? true)
    ) {
      return;
    }

    if (
      skipGlobalDrain &&
      (await this.ready(model)) &&
      ((await adapter.matches?.(ctx, policy)) ?? true)
    ) {
      return;
    }

    if (driverKind === 'external' && (await this.ready(model))) {
      return;
    }

    if (active.length) report('draining', '等待当前引擎任务结束');
    while (active.length) {
      if (clock() >= deadline) throw new Error('Timed out waiting for active GPU requests');
      if ((await Promise.all(active.map((k) => this.idle(k)))).every(Boolean)) {
        await pause(1000);
        if ((await Promise.all(active.map((k) => this.idle(k)))).every(Boolean)) break;
      }
      await pause(1000);
      active = await this.running();
    }

    for (const old of active) {
      report('unloading', `释放 ${old} 引擎`);
      const previous = await this.adapter(old);
      const preserved =
        old !== model && previous.park ? await previous.park(this.context(old), report) : false;
      if (!preserved) await this.stop(old);
    }

    if (adapter.resume && (await adapter.resume(ctx, policy, report))) return;

    const start = async (cold) => {
      report('loading', `启动 ${model} 引擎${cold ? ' · 冷启动重试' : ''}`);
      const launchEnv = adapter.launchEnv?.(ctx, { cold }) ?? {};
      const launchArgs = adapter.launchArgs?.(ctx, policy) ?? [];

      const runtimeSpec = adapter.runtimeSpec ? await adapter.runtimeSpec(ctx, policy) : null;
      const effectiveRuntime = runtime && runtimeSpec ? { ...runtime, ...runtimeSpec } : runtime;

      if (driverKind === 'docker' && effectiveRuntime?.launch?.length) {
        const gpuEnv = buildGpuVisibilityEnv(gpuIds);
        const args = [...effectiveRuntime.launch, ...launchArgs];
        await this.run(ROOT + 'lab', args, {
          timeout: 180000,
          env: { ...process.env, ...gpuEnv, ...launchEnv },
          onOutput: (output) => report('loading', output, 'launcher'),
        });
      } else if (effectiveRuntime) {
        await this.drivers.start(effectiveRuntime, {
          gpu_ids: gpuIds,
          env: launchEnv,
          args: launchArgs,
          cold,
        });
      }

      report('health-check', '等待目标引擎健康检查通过');
      while (!(await this.ready(model))) {
        if (clock() >= deadline) throw new Error('Model startup timeout; inspect worker logs');
        await adapter.startupCheck?.(ctx);
        await pause(2000);
      }
      await adapter.verify?.(ctx, policy);
    };

    try {
      await start(false);
    } catch (e) {
      if (!(await adapter.retryCold?.(ctx))) throw e;
      report('loading', `启动失败，重新冷启动：${e.message}`);
      await this.stop(model, gpuIds);
      await start(true);
    }
  }
}
