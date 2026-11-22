import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { EnvMap, ExecToolFn } from '../devices/host.ts';
import type {
  ComputeBackend,
  RuntimeDriver,
  RuntimeDriverSpec,
  RuntimeHandle,
  RuntimeLaunchOptions,
} from '../types.ts';
import { parseGpuVisibilityIndices } from './process.ts';

const execFileAsync = promisify(execFile);

export interface DockerDriverOptions {
  execFn?: ExecToolFn;
  dockerBin?: string;
  env?: EnvMap;
  stopTimeoutSeconds?: number;
}

function resolveWindowsShim(bin: string, env?: EnvMap): { bin: string; shell: boolean } {
  if (process.platform !== 'win32') {
    return { bin, shell: false };
  }
  if (/[\\/]/.test(bin)) {
    return { bin, shell: /\.(?:cmd|bat)$/i.test(bin) };
  }
  const pathRaw = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathRaw.split(delimiter).filter(Boolean)) {
    for (const ext of ['.exe', '.cmd', '.bat', '']) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) {
        return { bin: candidate, shell: ext === '.cmd' || ext === '.bat' };
      }
    }
  }
  return { bin, shell: false };
}

async function defaultDockerExec(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number; env?: EnvMap } = {},
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveWindowsShim(bin, options.env);
  if (resolved.shell) {
    const result = await execFileAsync('cmd.exe', ['/d', '/c', resolved.bin, ...args], {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      env: options.env as NodeJS.ProcessEnv | undefined,
      windowsHide: true,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }
  const result = await execFileAsync(resolved.bin, args, {
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    env: options.env as NodeJS.ProcessEnv | undefined,
    windowsHide: true,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function assertSafeToken(value: string, label: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`DockerDriver: control characters are not allowed in ${label}`);
  }
  return value;
}

export function buildDockerGpuArgs(gpuIds: readonly string[], backend?: ComputeBackend): string[] {
  const { nvidiaIndices, amdIndices, bareIndices } = parseGpuVisibilityIndices(gpuIds);

  const args: string[] = [];
  const useCuda =
    nvidiaIndices.length > 0 ||
    backend === 'cuda' ||
    (bareIndices.length > 0 && backend !== 'rocm' && backend !== 'vulkan');
  const useRocm = amdIndices.length > 0 || backend === 'rocm';

  if (useCuda) {
    const cudaList = nvidiaIndices.length > 0 ? nvidiaIndices : bareIndices;
    args.push('--gpus', cudaList.length > 0 ? `device=${cudaList.join(',')}` : 'all');
  }

  if (useRocm) {
    args.push('--device', '/dev/kfd', '--device', '/dev/dri');
    const rocmList = amdIndices.length > 0 ? amdIndices : bareIndices;
    if (rocmList.length > 0) {
      const joined = rocmList.join(',');
      args.push(
        '-e',
        `HIP_VISIBLE_DEVICES=${joined}`,
        '-e',
        `ROCR_VISIBLE_DEVICES=${joined}`,
        '-e',
        `GGML_VK_VISIBLE_DEVICES=${joined}`,
      );
    }
  } else if (backend === 'vulkan') {
    args.push('--device', '/dev/dri');
    const vkList = [...nvidiaIndices, ...amdIndices, ...bareIndices];
    if (vkList.length > 0) {
      args.push('-e', `GGML_VK_VISIBLE_DEVICES=${vkList.join(',')}`);
    }
  }

  return args;
}

export class DockerDriver implements RuntimeDriver {
  readonly kind = 'docker' as const;
  readonly #execFn: ExecToolFn;
  readonly #dockerBin: string;
  readonly #env: EnvMap;
  readonly #stopTimeoutSeconds: number;

  constructor(options: DockerDriverOptions = {}) {
    this.#execFn = options.execFn ?? defaultDockerExec;
    this.#env = options.env ?? process.env;
    this.#dockerBin =
      options.dockerBin ?? this.#env.WORKBENCH_DOCKER_BIN ?? this.#env.DOCKER_BIN ?? 'docker';
    this.#stopTimeoutSeconds = options.stopTimeoutSeconds ?? 10;
  }

  #isDisabled(): boolean {
    return this.#env.WORKBENCH_DISABLE_DOCKER === '1';
  }

  async start(spec: RuntimeDriverSpec, options: RuntimeLaunchOptions): Promise<RuntimeHandle> {
    if (this.#isDisabled()) {
      throw new Error('Docker runtime driver is disabled (WORKBENCH_DISABLE_DOCKER=1)');
    }

    const container = assertSafeToken(spec.container || spec.id, 'container');
    const imageCandidate = spec.image ?? (!spec.launch?.length ? spec.command : undefined);
    if (imageCandidate) {
      const image = assertSafeToken(imageCandidate, 'image');
      const args: string[] = ['run', '-d', '--rm', '--init', '--name', container];

      if (Number.isInteger(spec.port) && spec.port > 0) {
        args.push('-p', `${spec.port}:${spec.port}`);
      }

      const mergedEnv = { ...(spec.env ?? {}), ...(options.env ?? {}) };
      const inferredBackend =
        options.backend ??
        spec.resources?.backends?.[0] ??
        (mergedEnv.HIP_VISIBLE_DEVICES || mergedEnv.ROCR_VISIBLE_DEVICES
          ? 'rocm'
          : mergedEnv.CUDA_VISIBLE_DEVICES
            ? 'cuda'
            : undefined);

      args.push(...buildDockerGpuArgs(options.gpu_ids, inferredBackend));

      if (spec.cwd) {
        args.push('-w', assertSafeToken(spec.cwd, 'cwd'));
      }

      for (const vol of spec.volumes ?? []) {
        args.push('-v', assertSafeToken(vol, 'volume'));
      }

      for (const [key, value] of Object.entries(mergedEnv)) {
        assertSafeToken(key, 'env key');
        assertSafeToken(String(value), 'env value');
        args.push('-e', `${key}=${value}`);
      }

      for (const extraArg of spec.docker_args ?? []) {
        args.push(assertSafeToken(extraArg, 'docker_args'));
      }

      args.push(image);

      if (spec.image && spec.command) {
        args.push(assertSafeToken(spec.command, 'command'));
      }
      for (const arg of [...(spec.args ?? []), ...(options.args ?? [])]) {
        args.push(assertSafeToken(arg, 'arg'));
      }

      await this.#execFn(this.#dockerBin, args, { timeoutMs: 120_000, env: this.#env });
    } else {
      await this.#execFn(this.#dockerBin, ['start', container], {
        timeoutMs: 30_000,
        env: this.#env,
      });
    }

    const baseUrl =
      spec.base_url ??
      (Number.isInteger(spec.port) && spec.port > 0
        ? `http://127.0.0.1:${spec.port}`
        : 'http://127.0.0.1:0');

    return {
      runtime_id: spec.id,
      driver: 'docker',
      base_url: baseUrl.replace(/\/$/, ''),
      gpu_ids: [...options.gpu_ids],
      container,
    };
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    if (this.#isDisabled()) return;
    const container = assertSafeToken(handle.container || handle.runtime_id, 'container');
    try {
      await this.#execFn(
        this.#dockerBin,
        ['stop', '-t', String(this.#stopTimeoutSeconds), container],
        { timeoutMs: (this.#stopTimeoutSeconds + 15) * 1000, env: this.#env },
      );
    } catch (error) {
      const msg = String(
        (error as { stderr?: string; message?: string })?.stderr ?? (error as Error)?.message ?? '',
      );
      if (/No such container|is not running/i.test(msg)) return;
      throw error;
    }
  }

  async isRunning(spec: RuntimeDriverSpec): Promise<boolean> {
    if (this.#isDisabled()) return false;
    const container = assertSafeToken(spec.container || spec.id, 'container');
    try {
      const { stdout } = await this.#execFn(
        this.#dockerBin,
        ['inspect', '--format', '{{.State.Running}}', container],
        { timeoutMs: 3000, env: this.#env },
      );
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async logs(handle: RuntimeHandle, options?: { since?: string; tail?: number }): Promise<string> {
    if (this.#isDisabled()) return '';
    const container = assertSafeToken(handle.container || handle.runtime_id, 'container');
    const tail = options?.tail ?? 1000;
    const args = ['logs', '--timestamps', '--tail', String(tail)];
    if (options?.since) {
      args.push('--since', assertSafeToken(options.since, 'since'));
    }
    args.push(container);
    try {
      const { stdout, stderr } = await this.#execFn(this.#dockerBin, args, {
        timeoutMs: 5000,
        maxBuffer: 8 * 1024 * 1024,
        env: this.#env,
      });
      const combined =
        stdout && stderr && !stdout.endsWith('\n') ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;
      return combined.replaceAll('\r\n', '\n').replace(/\n$/, '');
    } catch (error) {
      const msg = String(
        (error as { stderr?: string; message?: string })?.stderr ?? (error as Error)?.message ?? '',
      );
      if (/No such container/i.test(msg)) return '';
      throw error;
    }
  }
}
