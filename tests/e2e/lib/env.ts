import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

export interface NodeVersionInfo {
  major: number;
  minor: number;
  patch: number;
}

export interface IsolatedWorkspace {
  rootDir: string;
  stateDir: string;
  artifactsDir: string;
  dataDir: string;
  configDir: string;
  platformStatePath: string;
  mcpConfigPath: string;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface IsolatedWorkspaceOptions {
  withArtifactsMarker?: boolean;
  markerName?: string;
}

function findRepoRootFrom(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, 'platforms', 'platform.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveRepoRoot(startDir?: string): string {
  const candidates = [
    startDir,
    process.env.VRAMDECK_REPO_ROOT,
    process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined,
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const found = findRepoRootFrom(candidate);
    if (found) return found;
  }
  throw new Error('Unable to locate repository root containing platforms/platform.json');
}

export const REPO_ROOT: string = resolveRepoRoot();
export const E2E_ROOT: string = path.join(REPO_ROOT, 'tests', 'e2e');

export function parseNodeVersion(version = process.versions.node): NodeVersionInfo {
  const cleaned = version.trim().replace(/^v/i, '').split('-')[0] ?? '';
  const parts = cleaned.split('.').map((part) => Number.parseInt(part, 10));
  return {
    major: Number.isFinite(parts[0]) ? parts[0] : 0,
    minor: Number.isFinite(parts[1]) ? parts[1] : 0,
    patch: Number.isFinite(parts[2]) ? parts[2] : 0,
  };
}

export function isNode22Plus(version = process.versions.node): boolean {
  const parsed = parseNodeVersion(version);
  return parsed.major > 22 || (parsed.major === 22 && parsed.minor >= 19);
}

function compareSemverDesc(a: string, b: string): number {
  const pa = parseNodeVersion(a);
  const pb = parseNodeVersion(b);
  if (pb.major !== pa.major) return pb.major - pa.major;
  if (pb.minor !== pa.minor) return pb.minor - pa.minor;
  return pb.patch - pa.patch;
}

function probeNodeVersion(executable: string): string | null {
  try {
    const out = execFileSync(executable, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return isNode22Plus(out) ? out : null;
  } catch {
    return null;
  }
}

function collectNvmCandidates(): string[] {
  const results: string[] = [];
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const searchDirs: string[] = [];

  if (process.env.NVM_HOME) {
    searchDirs.push(process.env.NVM_HOME, path.join(process.env.NVM_HOME, 'installs'));
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    searchDirs.push(
      path.join(localAppData, 'Author Software', 'nvm', 'installs'),
      path.join(localAppData, 'nvm'),
      path.join(appData, 'nvm'),
    );
  } else {
    searchDirs.push(path.join(os.homedir(), '.nvm', 'versions', 'node'));
  }

  const versioned: Array<{ version: string; bin: string }> = [];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^v?\d+\.\d+/i.test(entry.name)) continue;
        const bin =
          process.platform === 'win32'
            ? path.join(dir, entry.name, exe)
            : path.join(dir, entry.name, 'bin', exe);
        if (existsSync(bin)) {
          versioned.push({ version: entry.name, bin });
        }
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  versioned.sort((a, b) => compareSemverDesc(a.version, b.version));
  for (const item of versioned) {
    results.push(item.bin);
  }
  return results;
}

export function resolveNode22Plus(): string {
  const candidates: string[] = [];
  if (process.env.WORKBENCH_NODE?.trim()) {
    candidates.push(process.env.WORKBENCH_NODE.trim());
  }
  if (isNode22Plus(process.versions.node)) {
    candidates.push(process.execPath);
  }
  candidates.push(...collectNvmCandidates());
  candidates.push('node');

  for (const candidate of candidates) {
    if (candidate !== 'node' && !existsSync(candidate)) continue;
    if (probeNodeVersion(candidate)) {
      return candidate;
    }
  }
  throw new Error('Node.js >=22.19.0 is required; set WORKBENCH_NODE or install via nvm');
}

export function isStrictMode(): boolean {
  return process.env.E2E_STRICT === '1';
}

export async function deliverableExists(relativePath: string): Promise<boolean> {
  try {
    await access(path.resolve(REPO_ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

export function deliverableExistsSync(relativePath: string): boolean {
  return existsSync(path.resolve(REPO_ROOT, relativePath));
}

export async function findFirstExisting(relativePaths: string[]): Promise<string | null> {
  for (const rel of relativePaths) {
    if (await deliverableExists(rel)) {
      return rel;
    }
  }
  return null;
}

export function requireDeliverable(
  t: TestContext,
  condition: boolean,
  milestoneAndReason: string,
): boolean {
  if (condition) return true;
  if (isStrictMode()) {
    assert.fail(`[E2E_STRICT=1] Missing deliverable: ${milestoneAndReason}`);
  }
  t.skip(milestoneAndReason);
  return false;
}

export async function allocatePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      server.close(() => reject(err));
    });
    server.listen({ port: 0, host }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve allocated ephemeral port')));
        return;
      }
      const { port } = address;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

export async function createIsolatedWorkspace(
  prefix = 'vramdeck-e2e-',
  opts: IsolatedWorkspaceOptions = {},
): Promise<IsolatedWorkspace> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(rootDir, 'state');
  const artifactsDir = path.join(rootDir, 'artifacts');
  const dataDir = path.join(rootDir, 'data');
  const configDir = path.join(rootDir, 'config');
  const platformStatePath = path.join(configDir, 'platform-state.json');
  const mcpConfigPath = path.join(configDir, 'media-mcp.json');

  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(artifactsDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
  ]);

  if (opts.withArtifactsMarker !== false) {
    const markerName = opts.markerName ?? '.llm-backend-artifacts';
    await writeFile(path.join(artifactsDir, markerName), '', 'utf8');
  }

  const env: Record<string, string> = {
    WORKBENCH_DATA: dataDir,
    WORKBENCH_PLATFORM_STATE: platformStatePath,
    MEDIA_STATE_ROOT: stateDir,
    MEDIA_ARTIFACTS_ROOT: artifactsDir,
    MEDIA_MCP_CONFIG: mcpConfigPath,
  };

  async function cleanup(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await rm(rootDir, { recursive: true, force: true });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (attempt < 3 && (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY')) {
          await new Promise((r) => setTimeout(r, 75 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  return {
    rootDir,
    stateDir,
    artifactsDir,
    dataDir,
    configDir,
    platformStatePath,
    mcpConfigPath,
    env,
    cleanup,
  };
}

export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, prev] of previous.entries()) {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}
