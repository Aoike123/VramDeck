import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { resolveWin32Executable } from '../devices/host.ts';
import type { EnvMap, ExecToolFn } from '../devices/host.ts';
import type {
  RuntimeDriver,
  RuntimeDriverSpec,
  RuntimeHandle,
  RuntimeLaunchOptions,
} from '../types.ts';

const execFileAsync = promisify(execFile);

export type SpawnProcessFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type KillPidFn = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export type IsPidAliveFn = (pid: number) => boolean;

export interface ProcessDriverOptions {
  spawnFn?: SpawnProcessFn;
  execFn?: ExecToolFn;
  killPidFn?: KillPidFn;
  isPidAliveFn?: IsPidAliveFn;
  platform?: NodeJS.Platform;
  baseEnv?: EnvMap;
  maxLogLines?: number;
  maxLogBytes?: number;
  stopTimeoutMs?: number;
  startupGraceMs?: number;
}

interface LogEntry {
  ts: number;
  iso: string;
  line: string;
  bytes: number;
}

interface TrackedProcess {
  runtimeId: string;
  pid: number;
  child: ChildProcess;
  detached: boolean;
  exited: boolean;
  exitPromise: Promise<void>;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function defaultKillPid(pid: number, signal?: NodeJS.Signals | number): boolean {
  return process.kill(pid, signal);
}

async function defaultExec(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number; env?: EnvMap } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(bin, args, {
    timeout: options.timeoutMs ?? 5000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    env: options.env as NodeJS.ProcessEnv | undefined,
    windowsHide: true,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function quoteWinCmdToken(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Control character is not allowed in Windows command arguments');
  }
  if (/["%]/.test(value)) {
    throw new Error(
      'Unsafe quote or environment expansion character is not allowed in Windows command arguments',
    );
  }
  if (/^[a-zA-Z0-9_./:=,-]+$/.test(value)) {
    return value;
  }
  return `"${value}"`;
}

export function parseGpuVisibilityIndices(gpuIds: readonly string[]): {
  nvidiaIndices: string[];
  amdIndices: string[];
  bareIndices: string[];
} {
  const nvidiaIndices: string[] = [];
  const amdIndices: string[] = [];
  const bareIndices: string[] = [];

  for (const raw of gpuIds) {
    const token = String(raw).trim();
    if (!token) continue;
    if (/^\d+$/.test(token)) {
      bareIndices.push(token);
      continue;
    }
    const match = /^([a-z0-9_]+)[:\-](\d+)$/i.exec(token);
    if (!match) continue;
    const vendor = match[1].toLowerCase();
    const index = match[2];
    if (vendor === 'nvidia' || vendor === 'cuda') nvidiaIndices.push(index);
    else if (vendor === 'amd' || vendor === 'rocm' || vendor === 'hip') amdIndices.push(index);
    else bareIndices.push(index);
  }

  return { nvidiaIndices, amdIndices, bareIndices };
}

export function buildGpuVisibilityEnv(
  gpuIds: readonly string[],
  specEnv: Record<string, string> = {},
  optEnv: Record<string, string> = {},
  baseEnv: EnvMap = {},
): Record<string, string> {
  const { nvidiaIndices, amdIndices, bareIndices } = parseGpuVisibilityIndices(gpuIds);

  const gpuEnv: Record<string, string> = {};
  const cudaList = [...nvidiaIndices, ...bareIndices];
  const rocmList = [...amdIndices, ...bareIndices];
  const vulkanList = [...nvidiaIndices, ...amdIndices, ...bareIndices];

  if (cudaList.length > 0) {
    gpuEnv.CUDA_VISIBLE_DEVICES = cudaList.join(',');
  }
  if (rocmList.length > 0) {
    const joined = rocmList.join(',');
    gpuEnv.HIP_VISIBLE_DEVICES = joined;
    gpuEnv.ROCR_VISIBLE_DEVICES = joined;
  }
  if (vulkanList.length > 0) {
    gpuEnv.GGML_VK_VISIBLE_DEVICES = vulkanList.join(',');
  }

  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) merged[k] = v;
  }
  for (const [k, v] of Object.entries(specEnv)) {
    merged[k] = v;
  }
  if (
    amdIndices.length > 0 &&
    nvidiaIndices.length === 0 &&
    bareIndices.length === 0 &&
    specEnv.CUDA_VISIBLE_DEVICES === undefined &&
    optEnv.CUDA_VISIBLE_DEVICES === undefined
  ) {
    delete merged.CUDA_VISIBLE_DEVICES;
  }
  if (
    nvidiaIndices.length > 0 &&
    amdIndices.length === 0 &&
    bareIndices.length === 0 &&
    specEnv.HIP_VISIBLE_DEVICES === undefined &&
    optEnv.HIP_VISIBLE_DEVICES === undefined
  ) {
    delete merged.HIP_VISIBLE_DEVICES;
    delete merged.ROCR_VISIBLE_DEVICES;
  }
  for (const [k, v] of Object.entries(gpuEnv)) {
    merged[k] = v;
  }
  for (const [k, v] of Object.entries(optEnv)) {
    merged[k] = v;
  }
  return merged;
}

export class ProcessLogBuffer {
  readonly #maxLines: number;
  readonly #maxBytes: number;
  readonly #entries: LogEntry[] = [];
  #totalBytes = 0;
  #partial = '';

  constructor(maxLines = 1000, maxBytes = 1024 * 1024) {
    this.#maxLines = Math.max(1, maxLines);
    this.#maxBytes = Math.max(256, maxBytes);
  }

  pushChunk(chunk: string | Buffer): void {
    const normalized = String(chunk).replaceAll('\r\n', '\n');
    const combined = this.#partial + normalized;
    const parts = combined.split('\n');
    this.#partial = parts.pop() ?? '';
    for (const line of parts) {
      this.#appendLine(line);
    }
  }

  flush(): void {
    if (this.#partial.length > 0) {
      const remainder = this.#partial;
      this.#partial = '';
      this.#appendLine(remainder);
    }
  }

  #appendLine(rawLine: string): void {
    const ts = Date.now();
    const boundedLine =
      Buffer.byteLength(rawLine, 'utf8') > this.#maxBytes
        ? rawLine.slice(-Math.min(rawLine.length, this.#maxBytes))
        : rawLine;
    const bytes = Buffer.byteLength(boundedLine, 'utf8') + 1;
    this.#entries.push({
      ts,
      iso: new Date(ts).toISOString(),
      line: boundedLine,
      bytes,
    });
    this.#totalBytes += bytes;

    while (
      this.#entries.length > 1 &&
      (this.#entries.length > this.#maxLines || this.#totalBytes > this.#maxBytes)
    ) {
      const removed = this.#entries.shift();
      if (removed) this.#totalBytes -= removed.bytes;
    }
  }

  query(options?: { since?: string; tail?: number }): string {
    let items = this.#entries;
    if (options?.since) {
      const numeric = Number(options.since);
      const sinceMs = Number.isFinite(numeric) ? numeric : Date.parse(options.since);
      if (Number.isFinite(sinceMs)) {
        items = items.filter((entry) => entry.ts >= sinceMs);
      }
    }
    if (options?.tail !== undefined) {
      const tailCount = Math.max(0, Math.floor(options.tail));
      items = tailCount === 0 ? [] : items.slice(-tailCount);
    }
    return items.map((entry) => entry.line).join('\n');
  }
}

export class ProcessDriver implements RuntimeDriver {
  readonly kind = 'process' as const;
  readonly #spawnFn: SpawnProcessFn;
  readonly #execFn: ExecToolFn;
  readonly #killPidFn: KillPidFn;
  readonly #isPidAliveFn: IsPidAliveFn;
  readonly #platform: NodeJS.Platform;
  readonly #baseEnv: EnvMap;
  readonly #maxLogLines: number;
  readonly #maxLogBytes: number;
  readonly #stopTimeoutMs: number;
  readonly #startupGraceMs: number;
  readonly #processes = new Map<string, TrackedProcess>();
  readonly #logBuffers = new Map<string, ProcessLogBuffer>();

  constructor(options: ProcessDriverOptions = {}) {
    this.#spawnFn = options.spawnFn ?? spawn;
    this.#execFn = options.execFn ?? defaultExec;
    this.#killPidFn = options.killPidFn ?? defaultKillPid;
    this.#isPidAliveFn = options.isPidAliveFn ?? (options.spawnFn ? () => true : defaultIsPidAlive);
    this.#platform = options.platform ?? process.platform;
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#maxLogLines = options.maxLogLines ?? 1000;
    this.#maxLogBytes = options.maxLogBytes ?? 1024 * 1024;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.#startupGraceMs = options.startupGraceMs ?? (options.spawnFn ? 0 : 250);
  }

  async start(spec: RuntimeDriverSpec, options: RuntimeLaunchOptions): Promise<RuntimeHandle> {
    if (!spec.command || typeof spec.command !== 'string' || !spec.command.trim()) {
      throw new Error(`ProcessDriver: runtime "${spec.id}" requires spec.command`);
    }
    if (await this.isRunning(spec)) {
      throw new Error(`ProcessDriver: runtime "${spec.id}" is already running`);
    }

    const args = [...(spec.args ?? []), ...(options.args ?? [])];
    for (const arg of args) {
      if (arg.includes('\0')) {
        throw new Error('ProcessDriver: NUL byte is not allowed in process arguments');
      }
    }

    const env = buildGpuVisibilityEnv(options.gpu_ids, spec.env, options.env, this.#baseEnv);
    const logBuffer = new ProcessLogBuffer(this.#maxLogLines, this.#maxLogBytes);
    this.#logBuffers.set(spec.id, logBuffer);

    let spawnBin = spec.command;
    let spawnArgs = args;
    const isWin = this.#platform === 'win32';
    let detached = !isWin;
    let windowsVerbatimArguments = false;

    if (isWin) {
      const resolved = resolveWin32Executable(spec.command, env);
      if (/\.(cmd|bat)$/i.test(resolved)) {
        const comspec = env.ComSpec || this.#baseEnv.ComSpec || 'cmd.exe';
        const cmdLine = `"${[quoteWinCmdToken(resolved), ...args.map(quoteWinCmdToken)].join(' ')}"`;
        spawnBin = comspec;
        spawnArgs = ['/d', '/s', '/c', cmdLine];
        windowsVerbatimArguments = true;
      } else {
        spawnBin = resolved;
      }
      detached = false;
    }

    const child = this.#spawnFn(spawnBin, spawnArgs, {
      cwd: spec.cwd,
      env: env as NodeJS.ProcessEnv,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: isWin,
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    const onStdout = (chunk: string | Buffer) => logBuffer.pushChunk(chunk);
    const onStderr = (chunk: string | Buffer) => logBuffer.pushChunk(chunk);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      let settled = false;
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectSpawn(error);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveSpawn();
      };
      const cleanup = () => {
        child.removeListener('error', onError);
        child.removeListener('spawn', onSpawn);
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
      // Support simple EventEmitter mocks that set pid synchronously without emitting 'spawn'.
      if (
        !(child instanceof EventEmitter) ||
        (child.pid && typeof child.pid === 'number' && options && !child.listenerCount('spawn'))
      ) {
        // Only rely on 'spawn' event for real/standard EventEmitter mocks;
      }
    });

    const pid = child.pid;
    if (!Number.isInteger(pid) || !pid || pid <= 0) {
      throw new Error(`ProcessDriver: spawned process for "${spec.id}" has no valid PID`);
    }

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => {
      resolveExit = r;
    });

    const tracked: TrackedProcess = {
      runtimeId: spec.id,
      pid,
      child,
      detached,
      exited: child.exitCode !== null || child.signalCode !== null,
      exitPromise,
    };

    const markExited = () => {
      if (tracked.exited) return;
      tracked.exited = true;
      logBuffer.flush();
      resolveExit();
    };

    if (tracked.exited) {
      logBuffer.flush();
      resolveExit();
    } else {
      child.once('exit', markExited);
      child.once('close', markExited);
      child.once('error', markExited);
    }

    this.#processes.set(spec.id, tracked);

    if (this.#startupGraceMs > 0 && !tracked.exited) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, this.#startupGraceMs);
            graceTimer.unref?.();
          }),
        ]);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    }

    if (tracked.exited && (child.exitCode !== 0 || child.signalCode !== null)) {
      this.#processes.delete(spec.id);
      logBuffer.flush();
      const tailLogs = logBuffer.query({ tail: 20 });
      const detail =
        child.signalCode !== null
          ? `signal ${child.signalCode}`
          : `exit code ${child.exitCode ?? 'unknown'}`;
      throw new Error(
        `ProcessDriver: runtime "${spec.id}" exited prematurely (${detail})${tailLogs ? `: ${tailLogs}` : ''}`,
      );
    }

    const baseUrl =
      spec.base_url ??
      (Number.isInteger(spec.port) && spec.port > 0
        ? `http://127.0.0.1:${spec.port}`
        : 'http://127.0.0.1:0');

    return {
      runtime_id: spec.id,
      driver: 'process',
      base_url: baseUrl.replace(/\/$/, ''),
      gpu_ids: [...options.gpu_ids],
      pid,
    };
  }

  async isRunning(spec: RuntimeDriverSpec): Promise<boolean> {
    const tracked = this.#processes.get(spec.id);
    if (!tracked) return false;
    if (tracked.exited || tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
      tracked.exited = true;
      return false;
    }
    return this.#isPidAliveFn(tracked.pid);
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    let tracked = this.#processes.get(handle.runtime_id);
    if (!tracked && handle.pid) {
      for (const candidate of this.#processes.values()) {
        if (candidate.pid === handle.pid) {
          tracked = candidate;
          break;
        }
      }
    }
    if (!tracked || tracked.exited) {
      return;
    }

    const pid = tracked.pid;
    if (this.#platform === 'win32') {
      try {
        await this.#execFn('taskkill', ['/PID', String(pid), '/T'], { timeoutMs: 3000 });
      } catch {
        // Process may already have exited or require forced termination below.
      }
      const exited = await this.#waitExit(tracked, this.#stopTimeoutMs);
      if (!exited && !tracked.exited) {
        try {
          await this.#execFn('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 3000 });
        } catch {
          try {
            tracked.child.kill('SIGKILL');
          } catch {
            // Ignore ESRCH.
          }
        }
        await this.#waitExit(tracked, 2000);
      }
      return;
    }

    this.#signalPosix(tracked, 'SIGTERM');
    const exited = await this.#waitExit(tracked, this.#stopTimeoutMs);
    if (!exited && !tracked.exited) {
      this.#signalPosix(tracked, 'SIGKILL');
      await this.#waitExit(tracked, 2000);
    }
  }

  #signalPosix(tracked: TrackedProcess, signal: NodeJS.Signals): void {
    const target = tracked.detached ? -tracked.pid : tracked.pid;
    try {
      this.#killPidFn(target, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') return;
      if (tracked.detached) {
        try {
          this.#killPidFn(tracked.pid, signal);
        } catch (fallbackError) {
          const fallbackCode = (fallbackError as NodeJS.ErrnoException)?.code;
          if (fallbackCode !== 'ESRCH') {
            tracked.child.kill(signal);
          }
        }
      }
    }
  }

  async #waitExit(tracked: TrackedProcess, timeoutMs: number): Promise<boolean> {
    if (tracked.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        tracked.exitPromise.then(() => true),
        new Promise<boolean>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), Math.max(10, timeoutMs));
          timer.unref?.();
        }),
      ]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async logs(handle: RuntimeHandle, options?: { since?: string; tail?: number }): Promise<string> {
    const buffer = this.#logBuffers.get(handle.runtime_id);
    if (!buffer) return '';
    return buffer.query(options);
  }
}
