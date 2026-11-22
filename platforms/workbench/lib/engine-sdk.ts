import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import { dirname } from 'node:path';
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { call, ROOT } from './backend.mjs';
import { pause } from './core.mjs';
import { createDeviceProvider, readHostResources } from './devices/index.ts';
import { fail, renameWithRetry } from './media-store.mjs';
import {
  id,
  list,
  choice,
  object,
  prompt,
  PROMPT_MAX_LENGTH,
  str,
  validateSchema,
} from './media-tools.mjs';
import { artifactsDirectory, beforeSubmission } from './media.mjs';
import { registry } from './registry.ts';
import { canvasRoot, requireArtifacts } from './storage.mjs';
import type { EngineAdapterContext } from './types.ts';

// What engine adapters may use from the gateway. Adapters import only this module, so the
// gateway can change its internals without touching engine packages.
export {
  call,
  ROOT,
  pause,
  fail,
  renameWithRetry,
  str,
  id,
  list,
  choice,
  object,
  prompt,
  PROMPT_MAX_LENGTH,
  validateSchema,
  beforeSubmission,
  artifactsDirectory,
  canvasRoot,
  requireArtifacts,
};
export { seed } from './media-tools.mjs';

const execFileAsync = promisify(execFile);

interface BackendLike {
  dockerUnavailable?: boolean;
  containerStatus?: (container?: string) => Promise<string>;
  run?: (bin: string, args: string[], options?: Record<string, unknown>) => Promise<string>;
  capture?: (
    bin: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>;
  rows?: () => Promise<string[]>;
  stop?: (engine: string) => Promise<void>;
  ready?: (engine: string) => Promise<boolean>;
  memory?: () => Promise<number>;
  vram?: () => Promise<number>;
}

function backendOf(ctx?: Partial<EngineAdapterContext> | null): BackendLike | null {
  if (!ctx?.backend || typeof ctx.backend !== 'object') return null;
  return ctx.backend as BackendLike;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function enginePolicyKey(policy: Record<string, unknown> | null | undefined): string {
  if (!policy || typeof policy !== 'object') return '';
  if ('context_tokens' in policy && 'concurrency' in policy) {
    const contextTokens = Number(policy.context_tokens);
    const concurrency = Number(policy.concurrency);
    const kvBudget = policy.kv_budget_bytes ?? (contextTokens <= 65536 ? 8859648000 : 8 * 2 ** 30);
    const dtype = typeof policy.kv_dtype === 'string' && policy.kv_dtype ? policy.kv_dtype : 'bf16';
    return `${contextTokens}:${concurrency}:${dtype}:${String(kvBudget)}:${policy.eager ? 'eager' : 'graph'}`;
  }
  return stableJson(policy);
}

// A single-request backend that answered with an HTTP error has finished; only a lost answer is uncertain.
export const answered = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (e) {
    const err = e as { status?: number; code?: string };
    if (err.status) err.code = 'BACKEND_FAILED';
    throw e;
  }
};

export function isDockerDisabled(ctx?: Partial<EngineAdapterContext> | null): boolean {
  if (process.env.WORKBENCH_DISABLE_DOCKER === '1') return true;
  return Boolean(backendOf(ctx)?.dockerUnavailable);
}

export const containerStatus = async (
  ctx: Partial<EngineAdapterContext>,
  container: string | undefined = ctx.runtime?.container,
): Promise<string> => {
  const b = backendOf(ctx);
  if (b?.containerStatus) return b.containerStatus(container);
  if (b?.run) return b.run('docker', ['inspect', '--format', '{{.State.Status}}', container ?? '']);
  if (!container || isDockerDisabled(ctx)) return '';
  const { stdout } = await execFileAsync(
    'docker',
    ['inspect', '--format', '{{.State.Status}}', container],
    { timeout: 3000, windowsHide: true },
  );
  return String(stdout).trim();
};

export async function inspectContainer(
  ctx: Partial<EngineAdapterContext> | null | undefined,
  format: string,
  container: string | undefined = ctx?.runtime?.container,
): Promise<string | null> {
  if (!container) return null;
  const b = backendOf(ctx);
  if (b?.run) {
    const out = await b.run('docker', ['inspect', '--format', format, container], {
      timeout: 3000,
    });
    return String(out).trim();
  }
  if (isDockerDisabled(ctx)) return null;
  const { stdout } = await execFileAsync('docker', ['inspect', '--format', format, container], {
    timeout: 3000,
    windowsHide: true,
  });
  return String(stdout).trim();
}

export async function readContainerLogs(
  ctx: Partial<EngineAdapterContext> | null | undefined,
  options: {
    container?: string;
    tail?: number;
    timestamps?: boolean;
    since?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const container = options.container ?? ctx?.runtime?.container;
  if (!container) return { stdout: '', stderr: '' };
  const args = ['logs'];
  if (options.timestamps !== false) args.push('--timestamps');
  if (options.tail !== undefined) args.push('--tail', String(options.tail));
  if (options.since !== undefined) args.push('--since', String(options.since));
  args.push(container);

  const b = backendOf(ctx);
  if (b?.capture) {
    return b.capture('docker', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  }
  if (isDockerDisabled(ctx)) return { stdout: '', stderr: '' };
  const { stdout, stderr } = await execFileAsync('docker', args, {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export async function listRunningContainers(
  ctx?: Partial<EngineAdapterContext> | null,
): Promise<string[]> {
  const b = backendOf(ctx);
  if (b?.rows) return b.rows();
  if (isDockerDisabled(ctx)) return [];
  try {
    const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}'], {
      timeout: 3000,
      windowsHide: true,
    });
    return String(stdout)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function stopEngine(ctx: Partial<EngineAdapterContext>): Promise<void> {
  const b = backendOf(ctx);
  if (b?.stop && ctx.engine) {
    await b.stop(ctx.engine);
  }
}

export async function readyEngine(ctx: Partial<EngineAdapterContext>): Promise<boolean> {
  const b = backendOf(ctx);
  if (b?.ready && ctx.engine) {
    return b.ready(ctx.engine);
  }
  if (ctx.base) {
    try {
      const res = await fetch(ctx.base + '/health', { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
  return false;
}

export async function hostMemoryBytes(ctx?: Partial<EngineAdapterContext> | null): Promise<number> {
  const b = backendOf(ctx);
  if (b?.memory) return b.memory();
  try {
    return (await readHostResources()).ram_free_mb * 1048576;
  } catch {
    return freemem();
  }
}

export async function vramUsedBytes(ctx?: Partial<EngineAdapterContext> | null): Promise<number> {
  const b = backendOf(ctx);
  if (b?.vram) return b.vram();
  try {
    const snapshot = await createDeviceProvider().detect();
    return snapshot.gpus.reduce((sum, gpu) => sum + (Number(gpu.vram_used_mb) || 0) * 1048576, 0);
  } catch {
    return 0;
  }
}

export async function readJsonFile<T = unknown>(
  filePath: string,
  fallback: T | null = null,
  options: { ignoreInvalid?: boolean } = {},
): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
    if (options.ignoreInvalid) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = filePath + '.' + randomUUID() + '.tmp';
  const fd = await open(tmp, 'wx', 0o600);
  try {
    try {
      await fd.writeFile(JSON.stringify(value), 'utf8');
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (process.platform !== 'win32') {
      await chmod(tmp, 0o600).catch(() => {});
    }
    await renameWithRetry(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

// Whether another model is enabled right now, for adapters that can use it as a helper step.
export const modelEnabled = (modelId: string): boolean => !!registry.model(modelId);

// A PCM WAV of [start, start+seconds) of any audio or video file; mono 44.1 kHz unless asked.
export async function audioClip(
  source: string,
  target: string,
  {
    start = 0,
    seconds,
    rate = 44100,
    channels = 1,
  }: { start?: number; seconds?: number; rate?: number; channels?: number } = {},
): Promise<string> {
  await execFileAsync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      String(start),
      '-i',
      source,
      ...(seconds ? ['-t', String(seconds)] : []),
      '-map',
      '0:a:0',
      '-ac',
      String(channels),
      '-ar',
      String(rate),
      '-c:a',
      'pcm_s16le',
      '-y',
      target,
    ],
    { timeout: 180000, maxBuffer: 2 ** 20, windowsHide: true },
  );
  return target;
}

// Write a base64 WAV durably and read its duration from the header.
export async function saveWav(
  file: string,
  encoded: string,
): Promise<{ duration_seconds: number; sample_rate: number; channels: number }> {
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw Object.assign(new Error('Backend returned invalid WAV audio'), {
      code: 'ARTIFACT_INVALID',
    });
  }
  let offset = 12;
  let format: { channels: number; rate: number; byteRate: number } | null = null;
  let data = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      format = {
        channels: bytes.readUInt16LE(offset + 10),
        rate: bytes.readUInt32LE(offset + 12),
        byteRate: bytes.readUInt32LE(offset + 16),
      };
    }
    if (chunkId === 'data') {
      data = Math.min(size, bytes.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) {
    throw Object.assign(new Error('Backend returned WAV without audio data'), {
      code: 'ARTIFACT_INVALID',
    });
  }
  const tmp = file + '.' + randomUUID() + '.tmp';
  const fd = await open(tmp, 'wx', 0o600);
  try {
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await chmod(tmp, 0o600).catch(() => {});
    await renameWithRetry(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return {
    duration_seconds: Math.round((data / format.byteRate) * 100) / 100,
    sample_rate: format.rate,
    channels: format.channels,
  };
}
