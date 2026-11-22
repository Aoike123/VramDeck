import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  allocatePort,
  deliverableExists,
  type IsolatedWorkspace,
  REPO_ROOT,
  resolveNode22Plus,
} from './env.ts';
import { waitForHttpReady } from './http-client.ts';

export interface ProcessRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ManagedProcess {
  pid: number;
  stdout(): string;
  stderr(): string;
  exited(): boolean;
  exitCode(): number | null;
  waitForExit(timeoutMs?: number): Promise<ProcessRunResult>;
  stop(timeoutMs?: number): Promise<void>;
}

class RingBuffer {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(maxBytes = 256 * 1024) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (buf.length === 0) return;
    if (buf.length >= this.maxBytes) {
      this.chunks = [buf.subarray(buf.length - this.maxBytes)];
      this.totalBytes = this.maxBytes;
      return;
    }
    this.chunks.push(buf);
    this.totalBytes += buf.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const overflow = this.totalBytes - this.maxBytes;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.totalBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.totalBytes -= overflow;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

async function terminateProcessTree(pid: number, force: boolean): Promise<void> {
  if (pid <= 0) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // Process may have already exited.
  }
}

export function spawnManagedProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    maxLogBytes?: number;
  } = {},
): ManagedProcess {
  const startedAt = Date.now();
  const stdoutRing = new RingBuffer(options.maxLogBytes ?? 256 * 1024);
  const stderrRing = new RingBuffer(options.maxLogBytes ?? 256 * 1024);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk: Buffer) => stdoutRing.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrRing.push(chunk));

  let isExited = false;
  let exitCodeValue: number | null = null;
  let exitSignalValue: NodeJS.Signals | null = null;

  const exitPromise = new Promise<ProcessRunResult>((resolve, reject) => {
    child.once('error', (err) => {
      isExited = true;
      reject(err);
    });
    child.once('exit', (code, signal) => {
      isExited = true;
      exitCodeValue = code;
      exitSignalValue = signal;
      resolve({
        code,
        signal,
        stdout: stdoutRing.toString(),
        stderr: stderrRing.toString(),
        durationMs: Date.now() - startedAt,
      });
    });
  });

  async function waitForExit(timeoutMs = 15_000): Promise<ProcessRunResult> {
    if (isExited) return exitPromise;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Process ${command} (pid ${child.pid ?? -1}) did not exit within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stop(timeoutMs = 5_000): Promise<void> {
    if (isExited) {
      await exitPromise.catch(() => {});
      return;
    }
    const pid = child.pid ?? 0;
    if (process.platform === 'win32') {
      await terminateProcessTree(pid, true);
      await waitForExit(Math.max(1_000, timeoutMs)).catch(() => {});
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore kill errors if already exited.
    }

    try {
      await waitForExit(Math.min(timeoutMs, 2_500));
      return;
    } catch {
      // Escalate to tree kill.
    }

    await terminateProcessTree(pid, true);
    await waitForExit(Math.max(1_000, timeoutMs)).catch(() => {});
  }

  return {
    pid: child.pid ?? -1,
    stdout: () => stdoutRing.toString(),
    stderr: () => stderrRing.toString(),
    exited: () => isExited,
    exitCode: () => exitCodeValue,
    waitForExit,
    stop,
  };
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: string | Buffer;
    timeoutMs?: number;
  } = {},
): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env,
      stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutRing = new RingBuffer(512 * 1024);
    const stderrRing = new RingBuffer(512 * 1024);
    child.stdout?.on('data', (chunk: Buffer) => stdoutRing.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrRing.push(chunk));

    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateProcessTree(child.pid ?? 0, true);
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}\nstderr:\n${stderrRing.toString()}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: stdoutRing.toString(),
        stderr: stderrRing.toString(),
        durationMs: Date.now() - startedAt,
      });
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

export interface WorkbenchControlPlaneHandle {
  process: ManagedProcess;
  ports: { workbench: number; inference: number; control: number };
  urls: { workbench: string; inference: string; control: string };
  stop(): Promise<void>;
}

const TSCONFIG_LOCK_DIR = path.join(os.tmpdir(), 'vramdeck-e2e-tsconfig.lock');

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EPERM';
  }
}

export async function withWorkbenchTsconfigLock<T>(
  fn: () => Promise<T>,
  timeoutMs = 60_000,
): Promise<T> {
  const ownerFile = path.join(TSCONFIG_LOCK_DIR, 'owner.json');
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(TSCONFIG_LOCK_DIR);
      await writeFile(
        ownerFile,
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        'utf8',
      );
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') throw err;
      try {
        const raw = await readFile(ownerFile, 'utf8');
        const owner = JSON.parse(raw) as { pid?: number; createdAt?: number };
        const ageMs = typeof owner.createdAt === 'number' ? Date.now() - owner.createdAt : 0;
        if (ageMs > 120_000 || (typeof owner.pid === 'number' && !isPidAlive(owner.pid))) {
          await rm(TSCONFIG_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Owner metadata may not be flushed yet or already removed; retry shortly.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for tsconfig lock: ${TSCONFIG_LOCK_DIR}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(TSCONFIG_LOCK_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

export async function stripE2eNextFromTsconfig(
  tsconfigPath: string,
  tsconfigBefore: string | null = null,
): Promise<void> {
  const currentRaw = await readFile(tsconfigPath, 'utf8').catch(() => null);
  if (currentRaw === null) return;
  let parsed: { include?: unknown };
  try {
    parsed = JSON.parse(currentRaw) as { include?: unknown };
  } catch {
    return;
  }
  if (!Array.isArray(parsed.include)) return;
  const filtered = parsed.include.filter(
    (entry) => typeof entry !== 'string' || !entry.includes('.next-e2e-'),
  );
  if (filtered.length === parsed.include.length) return;
  parsed.include = filtered;

  if (tsconfigBefore !== null) {
    try {
      const beforeParsed = JSON.parse(tsconfigBefore) as { include?: unknown };
      if (Array.isArray(beforeParsed.include)) {
        beforeParsed.include = beforeParsed.include.filter(
          (entry) => typeof entry !== 'string' || !entry.includes('.next-e2e-'),
        );
      }
      if (JSON.stringify(beforeParsed) === JSON.stringify(parsed)) {
        await writeFile(tsconfigPath, tsconfigBefore, 'utf8').catch(() => {});
        return;
      }
    } catch {
      // Fall through to normalized JSON write.
    }
  }

  await writeFile(tsconfigPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8').catch(() => {});
}

export async function spawnWorkbenchControlPlane(
  workspace: IsolatedWorkspace,
  options: {
    ports?: { workbench?: number; inference?: number; control?: number };
    env?: Record<string, string | undefined>;
    readyTimeoutMs?: number;
  } = {},
): Promise<WorkbenchControlPlaneHandle> {
  const workbenchPort = options.ports?.workbench ?? (await allocatePort());
  const inferencePort = options.ports?.inference ?? (await allocatePort());
  const controlPort = options.ports?.control ?? (await allocatePort());
  const workbenchDir = path.join(REPO_ROOT, 'platforms', 'workbench');
  const nextDist = `.next-e2e-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const nextDistAbs = path.join(workbenchDir, nextDist);
  const tsconfigPath = path.join(workbenchDir, 'tsconfig.json');

  const serverScript = (await deliverableExists('platforms/workbench/server.ts'))
    ? path.join(workbenchDir, 'server.ts')
    : path.join(workbenchDir, 'server.mjs');

  const urls = {
    workbench: `http://127.0.0.1:${workbenchPort}`,
    inference: `http://127.0.0.1:${inferencePort}`,
    control: `http://127.0.0.1:${controlPort}`,
  };

  let tsconfigBefore: string | null = null;
  let proc!: ManagedProcess;

  async function cleanupNextArtifacts(): Promise<void> {
    await rm(nextDistAbs, { recursive: true, force: true }).catch(() => {});
    await withWorkbenchTsconfigLock(async () => {
      await stripE2eNextFromTsconfig(tsconfigPath, tsconfigBefore);
    }).catch(() => {});
  }

  await withWorkbenchTsconfigLock(async () => {
    tsconfigBefore = await readFile(tsconfigPath, 'utf8').catch(() => null);
    const nodeBin = resolveNode22Plus();
    proc = spawnManagedProcess(nodeBin, [serverScript], {
      cwd: workbenchDir,
      env: {
        ...workspace.env,
        WORKBENCH_PORT: String(workbenchPort),
        INFERENCE_PORT: String(inferencePort),
        CONTROL_PORT: String(controlPort),
        WORKBENCH_NEXT_DIST: nextDist,
        NODE_ENV: 'development',
        ...options.env,
      },
    });

    try {
      const readyPromise = waitForHttpReady(`${urls.inference}/health`, {
        timeoutMs: options.readyTimeoutMs ?? 30_000,
        intervalMs: 200,
      });
      const earlyExitPromise = proc.waitForExit(options.readyTimeoutMs ?? 30_000).then((res) => {
        throw new Error(
          `Workbench server exited prematurely (code=${String(res.code)}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
        );
      });
      await Promise.race([readyPromise, earlyExitPromise]);
      await stripE2eNextFromTsconfig(tsconfigPath, tsconfigBefore);
    } catch (err) {
      await proc.stop();
      await rm(nextDistAbs, { recursive: true, force: true }).catch(() => {});
      await stripE2eNextFromTsconfig(tsconfigPath, tsconfigBefore);
      throw err;
    }
  });

  return {
    process: proc,
    ports: { workbench: workbenchPort, inference: inferencePort, control: controlPort },
    urls,
    async stop() {
      await proc.stop();
      await cleanupNextArtifacts();
    },
  };
}

export interface McpStdioClient {
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  notifications: Array<{ method: string; params?: unknown }>;
  stderr(): string;
  stop(): Promise<void>;
}

export async function spawnMcpStdioClient(
  workspace: IsolatedWorkspace,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<McpStdioClient> {
  const nodeBin = resolveNode22Plus();
  const cliScript = path.join(REPO_ROOT, 'platforms', 'mcp', 'cli.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...workspace.env,
    ...options.env,
  };

  const child = spawn(nodeBin, [cliScript, 'stdio'], {
    cwd: path.join(REPO_ROOT, 'platforms', 'mcp'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stderrRing = new RingBuffer(128 * 1024);
  child.stderr?.on('data', (chunk: Buffer) => stderrRing.push(chunk));

  const notifications: Array<{ method: string; params?: unknown }> = [];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 1;

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      } else {
        waiter.resolve(msg.result);
      }
    } else if (typeof msg.method === 'string') {
      notifications.push({ method: msg.method, params: msg.params });
    }
  });

  child.once('exit', (code) => {
    for (const [id, waiter] of pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`MCP stdio exited (code=${String(code)}) before response to id=${id}`),
      );
    }
    pending.clear();
  });

  function notify(method: string, params: Record<string, unknown> = {}): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    child.stdin.write(`${frame}\n`);
  }

  function request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(`${frame}\n`);
    });
  }

  async function stop(): Promise<void> {
    rl.close();
    if (child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(async () => {
        await terminateProcessTree(child.pid ?? 0, true);
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    request,
    notify,
    notifications,
    stderr: () => stderrRing.toString(),
    stop,
  };
}
