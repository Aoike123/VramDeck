import type {
  RuntimeDriver,
  RuntimeDriverKind,
  RuntimeDriverSpec,
  RuntimeHandle,
  RuntimeLaunchOptions,
} from '../types.ts';
import { DockerDriver, buildDockerGpuArgs } from './docker.ts';
import type { DockerDriverOptions } from './docker.ts';
import { ExternalDriver, resolveExternalBaseUrl } from './external.ts';
import type { ExternalDriverOptions } from './external.ts';
import { ProcessDriver, ProcessLogBuffer, buildGpuVisibilityEnv } from './process.ts';
import type { ProcessDriverOptions } from './process.ts';

export { ProcessDriver, ProcessLogBuffer, buildGpuVisibilityEnv } from './process.ts';
export type { ProcessDriverOptions, SpawnProcessFn, KillPidFn, IsPidAliveFn } from './process.ts';
export { DockerDriver, buildDockerGpuArgs } from './docker.ts';
export type { DockerDriverOptions } from './docker.ts';
export { ExternalDriver, resolveExternalBaseUrl } from './external.ts';
export type { ExternalDriverOptions } from './external.ts';

export interface RuntimeDriversOptions {
  process?: ProcessDriverOptions;
  docker?: DockerDriverOptions;
  external?: ExternalDriverOptions;
}

export function resolveDriverKind(
  spec: { driver?: RuntimeDriverKind } | null | undefined,
): RuntimeDriverKind {
  return spec?.driver ?? 'docker';
}

export class RuntimeDriverRegistry {
  readonly #drivers: Record<RuntimeDriverKind, RuntimeDriver>;
  readonly #handles = new Map<string, RuntimeHandle>();

  constructor(options: RuntimeDriversOptions = {}) {
    this.#drivers = {
      process: new ProcessDriver(options.process),
      docker: new DockerDriver(options.docker),
      external: new ExternalDriver(options.external),
    };
  }

  get(kind: RuntimeDriverKind = 'docker'): RuntimeDriver {
    const driver = this.#drivers[kind];
    if (!driver) {
      throw new Error(`Unknown runtime driver: ${String(kind)}`);
    }
    return driver;
  }

  handleOf(runtimeId: string): RuntimeHandle | null {
    return this.#handles.get(runtimeId) ?? null;
  }

  async start(spec: RuntimeDriverSpec, options: RuntimeLaunchOptions): Promise<RuntimeHandle> {
    const driver = this.get(resolveDriverKind(spec));
    const handle = await driver.start(spec, options);
    this.#handles.set(spec.id, handle);
    return handle;
  }

  async stop(handleOrRuntimeId: RuntimeHandle | string): Promise<void> {
    const handle =
      typeof handleOrRuntimeId === 'string'
        ? this.#handles.get(handleOrRuntimeId)
        : handleOrRuntimeId;
    if (!handle) return;
    const driver = this.get(handle.driver);
    try {
      await driver.stop(handle);
    } finally {
      this.#handles.delete(handle.runtime_id);
    }
  }

  async isRunning(spec: RuntimeDriverSpec): Promise<boolean> {
    return this.get(resolveDriverKind(spec)).isRunning(spec);
  }

  async logs(
    handleOrSpec: RuntimeHandle | RuntimeDriverSpec,
    options?: { since?: string; tail?: number },
  ): Promise<string> {
    const handle: RuntimeHandle =
      'runtime_id' in handleOrSpec
        ? handleOrSpec
        : (this.#handles.get(handleOrSpec.id) ?? {
            runtime_id: handleOrSpec.id,
            driver: resolveDriverKind(handleOrSpec),
            base_url:
              handleOrSpec.base_url ??
              (handleOrSpec.port ? `http://127.0.0.1:${handleOrSpec.port}` : 'http://127.0.0.1:0'),
            gpu_ids: [],
            container: handleOrSpec.container,
          });
    const driver = this.get(handle.driver);
    return driver.logs ? driver.logs(handle, options) : '';
  }

  async stopAll(): Promise<void> {
    const handles = [...this.#handles.values()];
    await Promise.allSettled(handles.map((handle) => this.stop(handle)));
  }
}

export function createRuntimeDrivers(options: RuntimeDriversOptions = {}): RuntimeDriverRegistry {
  return new RuntimeDriverRegistry(options);
}

export const runtimeDrivers = createRuntimeDrivers();
