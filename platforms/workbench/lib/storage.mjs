// Where everything is stored, from the single `storage` block of platforms/platform.json (see
// .workbench/storage.py for the layout). Explicit artifacts roots must hold the marker file:
// without it the resource disk counts as offline and media requests fail instead of writing elsewhere.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const STORAGE = JSON.parse(
  readFileSync(join(ROOT, 'platforms/platform.json'), 'utf8'),
).storage;
const envValue = (name) => {
  const value = process.env[name]?.trim();
  return value ? value : null;
};
const path = (value) => (isAbsolute(value) ? value : join(ROOT, value));

export function autoRoot(kind) {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    return join(base, 'VramDeck', kind);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'VramDeck', kind);
  }
  const base = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(base, 'vramdeck', kind);
}

export const isAutoArtifacts = () =>
  !envValue('MEDIA_ARTIFACTS_ROOT') && (!STORAGE.artifacts || STORAGE.artifacts === 'auto');

export const stateRoot = () => {
  const override = envValue('MEDIA_STATE_ROOT');
  if (override) return path(override);
  return !STORAGE.state || STORAGE.state === 'auto' ? autoRoot('state') : path(STORAGE.state);
};

export const artifactsRoot = () => {
  const override = envValue('MEDIA_ARTIFACTS_ROOT');
  if (override) return path(override);
  return !STORAGE.artifacts || STORAGE.artifacts === 'auto'
    ? autoRoot('artifacts')
    : path(STORAGE.artifacts);
};

export const artifactsOnline = (root = artifactsRoot()) => existsSync(join(root, STORAGE.marker));

export function ensureAutoArtifacts(root = artifactsRoot()) {
  if (!isAutoArtifacts()) return root;
  mkdirSync(root, { recursive: true });
  const marker = join(root, STORAGE.marker);
  if (!existsSync(marker)) writeFileSync(marker, '', 'utf8');
  return root;
}

export const offline = () =>
  Object.assign(new Error('Artifact storage is offline: the resource disk is not mounted'), {
    status: 503,
    code: 'ARTIFACT_STORAGE_OFFLINE',
  });

export function requireArtifacts() {
  const root = artifactsRoot();
  if (isAutoArtifacts()) ensureAutoArtifacts(root);
  if (!artifactsOnline(root)) throw offline();
  return root;
}

export const canvasRoot = () => join(artifactsRoot(), 'canvas');
export const apiRoot = () => join(artifactsRoot(), 'api');

export function importRoots() {
  const configured = (STORAGE.import_roots ?? [])
    .filter(Boolean)
    .map((entry) => (entry === 'auto' ? artifactsRoot() : path(entry)));
  const extra = (envValue('MEDIA_IMPORT_ROOTS') ?? '')
    .split(delimiter)
    .map((v) => v.trim())
    .filter(Boolean)
    .map(path);
  return [...new Set([...configured, ...extra])];
}
