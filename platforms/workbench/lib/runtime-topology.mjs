// Runtime topology is derived from the enabled engine packages on every read, so enabling or
// disabling an engine in the console takes effect without a restart.
import { PLATFORM, registry } from './registry.mjs';

export const TOPOLOGY = {
  ...PLATFORM,
  get runtimes() {
    return registry.runtimes();
  },
};

export const runtimeFor = (engine) =>
  Object.entries(TOPOLOGY.runtimes).find(([, runtime]) => runtime.engines.includes(engine))?.[0] ??
  null;

export const sameRuntime = (a, b) =>
  a === b || (runtimeFor(a) !== null && runtimeFor(a) === runtimeFor(b));

// Engines whose single resident instance serves several leases at once.
export const sharedEngines = () =>
  Object.fromEntries(
    Object.values(TOPOLOGY.runtimes)
      .filter((runtime) => (runtime.concurrency ?? 0) > 1)
      .flatMap((runtime) => runtime.engines.map((engine) => [engine, runtime.concurrency])),
  );

export const modelBackends = () =>
  Object.fromEntries(
    Object.values(TOPOLOGY.runtimes).flatMap((runtime) =>
      runtime.engines.map((engine) => [
        engine,
        [[...(runtime.launch ?? [])], runtime.port ?? null, runtime.container ?? null],
      ]),
    ),
  );

// The runtime that hosts the native ComfyUI canvas, when one is enabled.
export const nativeRuntime = () =>
  Object.entries(TOPOLOGY.runtimes).find(([, runtime]) => runtime.native_ui) ?? null;

export const comfyBase = () => {
  const native = nativeRuntime();
  return native ? (native[1].base_url ?? 'http://127.0.0.1:' + native[1].port) : null;
};

export function runtimeTopology(status = {}) {
  const current = runtimeFor(status.current);
  const runtimes = TOPOLOGY.runtimes;
  const native = nativeRuntime();
  const gpus = Array.isArray(status.gpus) ? status.gpus : [];
  const allocations = Array.isArray(status.allocations) ? status.allocations : null;
  const switchingTargets = Array.isArray(status.switching_targets)
    ? status.switching_targets
    : null;
  const leased = Object.hasOwn(status, 'leased')
    ? status.leased
    : allocations
      ? allocations.some((a) => (a.active_leases ?? 0) > 0)
      : undefined;
  const switching = Object.hasOwn(status, 'switching')
    ? status.switching
    : switchingTargets
      ? switchingTargets.length > 0
      : undefined;

  const baseLabel =
    gpus.length > 1
      ? `${gpus.length} 卡资源池调度 · API / MCP 统一调度`
      : '少 GPU 资源池调度 · API / MCP 统一调度';

  return {
    mode: TOPOLOGY.mode,
    label: baseLabel + (native ? ' · ComfyUI 原生工作流' : ''),
    current_runtime: current,
    current_runtime_name: runtimes[current]?.name ?? null,
    current_engine: status.current ?? null,
    gateway_port: TOPOLOGY.gateway_port,
    comfyui_port: native?.[1].port ?? null,
    comfyui_engines: native?.[1].engines ?? [],
    gateway_queue: 'API 与 MCP 共用准入、GPU 租约和引擎合批',
    native_queue: '原生工作流进入 ComfyUI 自身队列；不等同于网关任务记录',
    switching_note:
      '调度器按显存预算、并发配置与亲和性分配 1–4 卡资源池；显存不足时优先优雅驱逐空闲运行时，目标引擎按需启动',
    capabilities_only: !Object.hasOwn(status, 'current') && allocations === null && !gpus.length,
    ...(status.engine_scheduling ? { engine_scheduling: status.engine_scheduling } : {}),
    ...(leased !== undefined
      ? { leased, queued: status.queued ?? 0, switching: Boolean(switching) }
      : {}),
    ...(gpus.length ? { gpus } : {}),
    ...(allocations ? { allocations } : {}),
    ...(switchingTargets ? { switching_targets: switchingTargets } : {}),
  };
}
