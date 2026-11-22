import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { HostResources } from '../types.ts';

const execFileAsync = promisify(execFile);

export type EnvMap = Record<string, string | undefined>;

export interface ExecToolOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: EnvMap;
  platform?: NodeJS.Platform;
}

export interface ExecToolResult {
  stdout: string;
  stderr: string;
}

export type ExecToolFn = (
  bin: string,
  args: string[],
  options?: ExecToolOptions,
) => Promise<ExecToolResult>;

export function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function nonNegFinite(value: unknown, fallback = 0): number {
  const n = finiteOrNull(value);
  return n !== null && n >= 0 ? n : fallback;
}

export async function readHostResources(options?: {
  meminfoPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<HostResources> {
  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;
  const ramTotalMb = Math.round(totalmem() / 1048576);
  let ramFreeMb = Math.round(freemem() / 1048576);

  if (platform === 'linux') {
    try {
      const meminfo = await readFile(options?.meminfoPath ?? '/proc/meminfo', 'utf8');
      const match = meminfo.match(/^MemAvailable:\s+(\d+)/m);
      if (match) {
        ramFreeMb = Math.round((Number(match[1]) * 1024) / 1048576);
      }
    } catch {
      // Fall back to os.freemem() when /proc/meminfo is unavailable.
    }
  }

  return {
    os: platform,
    arch,
    ram_total_mb: ramTotalMb,
    ram_free_mb: Math.max(0, ramFreeMb),
  };
}

export function resolveWin32Executable(bin: string, env: EnvMap = process.env): string {
  const pathExtRaw = env.PATHEXT ?? env.pathext ?? '.COM;.EXE;.BAT;.CMD';
  const pathExts = pathExtRaw
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);

  const hasSep = bin.includes('/') || bin.includes('\\');
  if (isAbsolute(bin) || hasSep) {
    if (existsSync(bin)) return bin;
    if (!extname(bin)) {
      for (const ext of pathExts) {
        const candidate = bin + ext;
        if (existsSync(candidate)) return candidate;
      }
    }
    return bin;
  }

  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = pathVar
    .split(';')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const candidates = extname(bin) ? [bin] : [bin, ...pathExts.map((ext) => bin + ext)];

  for (const dir of dirs) {
    for (const candidateName of candidates) {
      const candidate = join(dir, candidateName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return bin;
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

export async function execTool(
  bin: string,
  args: string[],
  options: ExecToolOptions = {},
): Promise<ExecToolResult> {
  const timeout = options.timeoutMs ?? 4000;
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (platform === 'win32') {
    const resolved = resolveWin32Executable(bin, env);
    if (/\.(cmd|bat)$/i.test(resolved)) {
      const comspec = env.ComSpec || process.env.ComSpec || 'cmd.exe';
      const cmdLine = `"${[quoteWinCmdToken(resolved), ...args.map(quoteWinCmdToken)].join(' ')}"`;
      const { stdout, stderr } = await execFileAsync(comspec, ['/d', '/s', '/c', cmdLine], {
        timeout,
        maxBuffer,
        env: env as NodeJS.ProcessEnv,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    }
    const { stdout, stderr } = await execFileAsync(resolved, args, {
      timeout,
      maxBuffer,
      env: env as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  }

  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout,
    maxBuffer,
    env: env as NodeJS.ProcessEnv,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}
