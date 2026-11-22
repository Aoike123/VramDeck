// Engine packages are the single source of truth: every engines/<category>/<id>/engine.json
// with a `platform` block registers one scheduler engine, its runtime, console card and the
// models it serves. Enabled flags and capability routing are operator state, kept outside git.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineCapabilities, checkDefinitions } from './media-tools.mjs';
import type {
  ColdStartWeight,
  ComputeBackend,
  EngineAdapter,
  EngineManifestV2,
  ResourceSpec,
  RuntimeDriverKind,
  RuntimeDriverSpec,
  VramMode,
} from './types.ts';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const PLATFORM = JSON.parse(readFileSync(ROOT + 'platforms/platform.json', 'utf8')) as {
  mode: string;
  gateway_port: number;
  management_port: number;
  control_port: number;
  state_file: string;
  next_dist?: string;
  storage?: Record<string, unknown>;
};

const CATEGORY_TYPE: Record<'llm' | 'image' | 'video' | 'audio', string> = {
  llm: 'language',
  image: 'image',
  video: 'video',
  audio: 'audio',
};
const CATEGORY_ORDER = Object.keys(CATEGORY_TYPE) as Array<'llm' | 'image' | 'video' | 'audio'>;

const VALID_DRIVERS: ReadonlySet<RuntimeDriverKind> = new Set(['process', 'docker', 'external']);
const VALID_BACKENDS: ReadonlySet<ComputeBackend> = new Set([
  'cuda',
  'rocm',
  'metal',
  'vulkan',
  'cpu',
]);
const VALID_VRAM_MODES: ReadonlySet<VramMode> = new Set(['shared', 'exclusive']);
const VALID_COLD_START_WEIGHTS: ReadonlySet<ColdStartWeight> = new Set(['low', 'medium', 'high']);

export interface EnginePackage {
  id: string;
  dir: string;
  file: string;
  manifest: EngineManifestV2 & { status?: string };
  enabled?: boolean;
}

export interface PlatformState {
  engines: Record<string, { enabled?: boolean }>;
  routing: Record<
    string,
    { primary?: string; fallbacks?: string[]; fallback_on_backend_error?: boolean }
  >;
}

export interface RegistryOptions {
  enginesDir?: string;
  publish?: boolean;
  statePath?: string | null;
}

function fail(path: string, message: string): never {
  throw new Error(path + ': ' + message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function parseHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function effectivePort(runtime: RuntimeDriverSpec): number | null {
  if (Number.isInteger(runtime.port) && runtime.port >= 1 && runtime.port <= 65535) {
    return runtime.port;
  }
  const parsed = parseHttpUrl(runtime.base_url);
  if (!parsed) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

// What a package says about how its capabilities look to clients: `platform.surface` inline and/or
// `platform.surface_files` (paths relative to the package, for declarations several engines share,
// such as the image tools). Declared once per capability; a repeat must be identical.
export function readSurface(pkg: EnginePackage): Record<string, Record<string, unknown>> {
  const p = pkg.manifest.platform;
  const out: Record<string, Record<string, unknown>> = {};
  const add = (declared: Record<string, Record<string, unknown>>, from: string) => {
    for (const [capability, definition] of Object.entries(declared)) {
      if (out[capability] && JSON.stringify(out[capability]) !== JSON.stringify(definition)) {
        fail(pkg.file, capability + ' is declared twice with different content (' + from + ')');
      }
      out[capability] = definition;
    }
  };
  for (const file of p.surface_files ?? []) {
    let declared: Record<string, Record<string, unknown>>;
    try {
      declared = JSON.parse(readFileSync(join(pkg.dir, file), 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
    } catch (e) {
      fail(pkg.file, 'platform.surface_files ' + file + ': ' + (e as Error).message);
    }
    add(declared, file);
  }
  if (p.surface) add(p.surface as Record<string, Record<string, unknown>>, 'surface');
  return out;
}

// Every installed package's declarations, enabled or not (stored jobs and aliases keep resolving),
// ordered by each capability's `order`, then by package order. The same capability declared by
// several packages must agree, and every capability a model serves must be declared somewhere.
export function mergeSurface(packages: EnginePackage[]): Record<string, Record<string, unknown>> {
  const merged = new Map<string, { definition: Record<string, unknown>; from: string }>();
  const ordered = [...packages].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.manifest.category) - CATEGORY_ORDER.indexOf(b.manifest.category) ||
      a.id.localeCompare(b.id),
  );
  for (const pkg of ordered) {
    for (const [capability, definition] of Object.entries(readSurface(pkg))) {
      const prior = merged.get(capability);
      if (prior && JSON.stringify(prior.definition) !== JSON.stringify(definition)) {
        fail(
          pkg.file,
          capability +
            ' is also declared by ' +
            prior.from +
            ' with different content; share one declaration through platform.surface_files',
        );
      }
      if (!prior) merged.set(capability, { definition, from: pkg.id });
    }
  }
  for (const pkg of ordered) {
    for (const model of pkg.manifest.platform.models) {
      for (const capability of model.capabilities) {
        if (!merged.has(capability)) {
          fail(
            pkg.file,
            model.id + ' serves ' + capability + ', which no package declares in platform.surface',
          );
        }
      }
    }
  }
  const definitions = Object.fromEntries(
    [...merged]
      .sort(
        ([, a], [, b]) =>
          ((a.definition.order as number | undefined) ?? 100) -
          ((b.definition.order as number | undefined) ?? 100),
      )
      .map(([capability, { definition }]) => [capability, definition]),
  );
  const problems = checkDefinitions(definitions);
  if (problems.length) throw new Error('platform.surface: ' + problems.join('; '));
  return definitions;
}

function readManifests(enginesDir: string): EnginePackage[] {
  if (!existsSync(enginesDir)) return [];
  const packages: EnginePackage[] = [];
  for (const category of readdirSync(enginesDir, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    for (const entry of readdirSync(join(enginesDir, category.name), { withFileTypes: true })) {
      const file = join(enginesDir, category.name, entry.name, 'engine.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as EngineManifestV2 & {
        status?: string;
      };
      if (manifest.platform) {
        packages.push({
          id: manifest.deployment_id ?? entry.name,
          dir: dirname(file),
          file,
          manifest,
        });
      }
    }
  }
  return packages.sort((a, b) => a.id.localeCompare(b.id));
}

function validateRuntime(runtime: unknown, where: string): void {
  if (!isPlainObject(runtime)) fail(where, 'platform.runtime must be an object');

  for (const key of ['id', 'name'] as const) {
    if (runtime[key] === undefined) fail(where, 'platform.runtime.' + key + ' is required');
    if (typeof runtime[key] !== 'string' || !runtime[key].trim()) {
      fail(where, 'platform.runtime.' + key + ' must be a non-empty string');
    }
  }

  const rawDriver = runtime.driver;
  const driver: RuntimeDriverKind =
    rawDriver === undefined ? 'docker' : (rawDriver as RuntimeDriverKind);
  if (typeof driver !== 'string' || !VALID_DRIVERS.has(driver)) {
    fail(where, 'platform.runtime.driver must be one of process, docker, external');
  }

  if (driver !== 'external') {
    if (runtime.port === undefined) fail(where, 'platform.runtime.port is required');
    if (
      !Number.isInteger(runtime.port) ||
      (runtime.port as number) < 1 ||
      (runtime.port as number) > 65535
    ) {
      fail(where, 'platform.runtime.port must be an integer');
    }
  } else if (runtime.port !== undefined) {
    if (
      !Number.isInteger(runtime.port) ||
      (runtime.port as number) < 1 ||
      (runtime.port as number) > 65535
    ) {
      fail(where, 'platform.runtime.port must be an integer');
    }
  }

  if (driver === 'docker') {
    if (runtime.image !== undefined) {
      if (typeof runtime.image !== 'string' || !runtime.image.trim()) {
        fail(where, 'platform.runtime.image must be a non-empty string');
      }
    } else {
      if (runtime.container === undefined) {
        fail(where, 'platform.runtime.container is required');
      }
      if (typeof runtime.container !== 'string' || !runtime.container.trim()) {
        fail(where, 'platform.runtime.container must be a non-empty string');
      }
      if (runtime.launch === undefined) {
        fail(where, 'platform.runtime.launch is required');
      }
      if (!Array.isArray(runtime.launch) || !runtime.launch.length) {
        fail(where, 'platform.runtime.launch must be a non-empty array');
      }
    }
  } else if (driver === 'process') {
    if (typeof runtime.command !== 'string' || !runtime.command.trim()) {
      fail(where, 'platform.runtime.command is required for process driver');
    }
  } else if (driver === 'external') {
    if (!parseHttpUrl(runtime.base_url)) {
      fail(where, 'platform.runtime.base_url must be a valid http(s) URL for external driver');
    }
  }

  if (runtime.args !== undefined && !isStringArray(runtime.args)) {
    fail(where, 'platform.runtime.args must be an array of strings');
  }
  if (runtime.cwd !== undefined && typeof runtime.cwd !== 'string') {
    fail(where, 'platform.runtime.cwd must be a string');
  }
  if (runtime.env !== undefined && !isStringRecord(runtime.env)) {
    fail(where, 'platform.runtime.env must be a string map');
  }
  if (runtime.extra_containers !== undefined && !isStringArray(runtime.extra_containers)) {
    fail(where, 'platform.runtime.extra_containers must be an array of strings');
  }
  if (runtime.volumes !== undefined && !isStringArray(runtime.volumes)) {
    fail(where, 'platform.runtime.volumes must be an array of strings');
  }
  if (runtime.docker_args !== undefined && !isStringArray(runtime.docker_args)) {
    fail(where, 'platform.runtime.docker_args must be an array of strings');
  }
  if (
    runtime.concurrency !== undefined &&
    (!Number.isInteger(runtime.concurrency) || (runtime.concurrency as number) < 1)
  ) {
    fail(where, 'platform.runtime.concurrency must be an integer >= 1');
  }
  if (
    runtime.health_path !== undefined &&
    (typeof runtime.health_path !== 'string' || !runtime.health_path.startsWith('/'))
  ) {
    fail(where, 'platform.runtime.health_path must be a path starting with /');
  }
}

function validateResources(resources: unknown, where: string): void {
  if (!isPlainObject(resources)) fail(where, 'platform.resources must be an object');

  const spec = resources as Partial<ResourceSpec>;
  if (
    !Array.isArray(spec.backends) ||
    spec.backends.length === 0 ||
    spec.backends.some((b) => typeof b !== 'string' || !VALID_BACKENDS.has(b as ComputeBackend))
  ) {
    fail(
      where,
      'platform.resources.backends must be a non-empty array of cuda, rocm, metal, vulkan, cpu',
    );
  }
  if (!Number.isInteger(spec.gpu_count) || (spec.gpu_count as number) < 0) {
    fail(where, 'platform.resources.gpu_count must be an integer >= 0');
  }
  if (spec.gpu_count === 0 && !spec.backends.includes('cpu')) {
    fail(where, 'platform.resources.gpu_count must be >= 1 unless cpu backend is enabled');
  }
  if (typeof spec.vram_mb !== 'number' || !Number.isFinite(spec.vram_mb) || spec.vram_mb < 0) {
    fail(where, 'platform.resources.vram_mb must be a finite number >= 0');
  }
  if (typeof spec.vram_mode !== 'string' || !VALID_VRAM_MODES.has(spec.vram_mode as VramMode)) {
    fail(where, 'platform.resources.vram_mode must be shared or exclusive');
  }
  if (!Number.isInteger(spec.concurrency) || (spec.concurrency as number) < 1) {
    fail(where, 'platform.resources.concurrency must be an integer >= 1');
  }
  if (
    spec.affinity !== undefined &&
    (typeof spec.affinity !== 'string' ||
      (spec.affinity !== 'any' && !/^(prefer|pin):[a-zA-Z0-9:._-]+$/.test(spec.affinity)))
  ) {
    fail(where, 'platform.resources.affinity must be any, prefer:<id>, or pin:<id>');
  }
  if (
    spec.cold_start_weight !== undefined &&
    (typeof spec.cold_start_weight !== 'string' ||
      !VALID_COLD_START_WEIGHTS.has(spec.cold_start_weight as ColdStartWeight))
  ) {
    fail(where, 'platform.resources.cold_start_weight must be low, medium, or high');
  }
}

export function validatePackage(pkg: EnginePackage): void {
  const p = pkg.manifest.platform as unknown as Record<string, unknown>;
  const where = pkg.file;
  for (const key of ['engine', 'runtime', 'ui', 'models']) {
    if (p[key] === undefined) fail(where, 'platform.' + key + ' is required');
  }
  if (typeof p.engine !== 'string' || !/^[a-z0-9-]+$/.test(p.engine)) {
    fail(where, 'platform.engine must be lowercase letters, digits or -');
  }
  validateRuntime(p.runtime, where);
  if (p.resources !== undefined) validateResources(p.resources, where);

  const ui = p.ui as Record<string, unknown>;
  for (const key of ['name', 'description', 'symbol', 'accent', 'panel']) {
    if (ui[key] === undefined) fail(where, 'platform.ui.' + key + ' is required');
  }
  // A native runtime (ComfyUI) is shown through its engines' cards, never as a card of its own.
  if (!['media', 'llm'].includes(String(ui.panel))) {
    fail(where, 'platform.ui.panel must be media or llm');
  }
  if (!CATEGORY_TYPE[pkg.manifest.category]) {
    fail(where, 'category must be one of ' + Object.keys(CATEGORY_TYPE).join(', '));
  }
  for (const model of p.models as EngineManifestV2['platform']['models']) {
    if (!/^[a-z0-9.-]+$/.test(model.id ?? '')) fail(where, 'model id is invalid');
    if (!Array.isArray(model.capabilities) || !model.capabilities.length) {
      fail(where, model.id + ' declares no capabilities');
    }
  }
  if (ui.works !== undefined) validateWorks(pkg.manifest.platform, where);
}

// Work categories: each becomes a tab beside 运行监控 on the engine's service page.
export const WORK_VIEWS = ['gallery', 'voices'] as const;
export const WORK_KINDS = ['image', 'video', 'audio', 'text'] as const;
const RESERVED_VIEWS = ['runtime', 'tasks', 'config'];

function validateWorks(p: EngineManifestV2['platform'], where: string): void {
  if (p.ui.panel !== 'media') fail(where, 'platform.ui.works is only for media engines');
  if (!Array.isArray(p.ui.works) || !p.ui.works.length) {
    fail(where, 'platform.ui.works must be a non-empty array');
  }
  const provided = new Set(p.models.flatMap((m) => m.capabilities));
  const seen = new Set<string>();
  for (const work of p.ui.works) {
    const at = 'platform.ui.works[' + (work?.id ?? '?') + ']';
    if (
      !/^[a-z][a-z0-9-]*$/.test(work?.id ?? '') ||
      RESERVED_VIEWS.includes(work.id) ||
      seen.has(work.id)
    ) {
      fail(where, at + '.id must be a unique lowercase id other than ' + RESERVED_VIEWS.join('/'));
    }
    seen.add(work.id);
    if (typeof work.label !== 'string' || !work.label) fail(where, at + '.label is required');
    if (work.view !== undefined && !WORK_VIEWS.includes(work.view)) {
      fail(where, at + '.view must be one of ' + WORK_VIEWS.join(', '));
    }
    if (
      !Array.isArray(work.capabilities) ||
      !work.capabilities.length ||
      work.capabilities.some((c) => !provided.has(c))
    ) {
      fail(where, at + '.capabilities must list capabilities this engine provides');
    }
    if (
      work.kinds !== undefined &&
      (!Array.isArray(work.kinds) ||
        !work.kinds.length ||
        work.kinds.some((k) => !WORK_KINDS.includes(k)))
    ) {
      fail(where, at + '.kinds must list ' + WORK_KINDS.join('/'));
    }
  }
}

export class Registry {
  enginesDir: string;
  publish: boolean;
  statePath: string | null;
  adapters: Map<string, Promise<EngineAdapter>>;
  dynamicPackages: Map<string, { pkg: EnginePackage; adapter?: EngineAdapter }>;
  listeners: Set<(registry: Registry) => void>;
  surface: Record<string, Record<string, unknown>> = {};
  packages: EnginePackage[] = [];
  state: PlatformState = { engines: {}, routing: {} };

  // Under `node --test` the operator's state file is neither read nor written: tests see the
  // manifest defaults whatever engines are switched on in this workbench.
  constructor({
    enginesDir = ROOT + 'engines',
    publish = enginesDir === ROOT + 'engines',
    statePath = process.env.WORKBENCH_PLATFORM_STATE ??
      (process.env.NODE_TEST_CONTEXT ? null : ROOT + PLATFORM.state_file),
  }: RegistryOptions = {}) {
    this.enginesDir = enginesDir;
    this.publish = publish;
    this.statePath = statePath;
    this.adapters = new Map();
    this.dynamicPackages = new Map();
    this.listeners = new Set();
    this.load();
  }

  readState(): Partial<PlatformState> {
    return this.statePath && existsSync(this.statePath)
      ? (JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PlatformState>)
      : {};
  }

  // Validates manifests against a candidate state; this.state changes only if it is consistent.
  load(candidateState: Partial<PlatformState> = this.readState()): this {
    const diskPackages = readManifests(this.enginesDir);
    const byId = new Map<string, EnginePackage>();
    for (const pkg of diskPackages) {
      byId.set(pkg.id, pkg);
    }
    for (const entry of this.dynamicPackages.values()) {
      byId.set(entry.pkg.id, { ...entry.pkg });
    }
    const packages = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    packages.forEach(validatePackage);
    this.surface = mergeSurface(packages);
    // Only the gateway's own registry fills the live capability tables; a registry built over another directory (tests, tooling) just validates.
    if (this.publish) defineCapabilities(this.surface);
    const state: PlatformState = {
      engines: candidateState.engines ?? {},
      routing: candidateState.routing ?? {},
    };
    for (const pkg of packages) {
      pkg.enabled =
        state.engines[pkg.id]?.enabled ?? pkg.manifest.platform.default_enabled === true;
    }
    // Conflicts only matter between engines that can run together.
    const seen = {
      engine: new Map<string, string>(),
      model: new Map<string, string>(),
      port: new Map<number, string>(),
    };
    for (const pkg of packages.filter((p) => p.enabled)) {
      const p = pkg.manifest.platform;
      const claim = <K extends keyof typeof seen>(
        kind: K,
        key: K extends 'port' ? number : string,
        owner: string,
      ) => {
        const table = seen[kind] as Map<string | number, string>;
        const other = table.get(key);
        if (other && other !== owner) {
          fail(pkg.file, kind + ' ' + String(key) + ' is already declared by ' + other);
        }
        table.set(key, owner);
      };
      claim('engine', p.engine, pkg.id);
      for (const model of p.models) claim('model', model.id, pkg.id);
      const port = effectivePort(p.runtime);
      if (port !== null) claim('port', port, p.runtime.id);
    }
    this.packages = packages;
    this.state = state;
    for (const listener of this.listeners) listener(this);
    return this;
  }

  onChange(listener: (registry: Registry) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerDynamicPackage(
    pkg: EnginePackage,
    adapter?: EngineAdapter,
    { enabled = true }: { enabled?: boolean } = {},
  ): EnginePackage {
    const previousDynamic = this.dynamicPackages.get(pkg.id);
    const previousState = this.state;
    this.dynamicPackages.set(pkg.id, { pkg: { ...pkg }, adapter });
    this.adapters.delete(pkg.id);
    try {
      this.load({
        ...previousState,
        engines: {
          ...previousState.engines,
          [pkg.id]: { ...previousState.engines[pkg.id], enabled: !!enabled },
        },
      });
    } catch (error) {
      if (previousDynamic) this.dynamicPackages.set(pkg.id, previousDynamic);
      else this.dynamicPackages.delete(pkg.id);
      this.adapters.delete(pkg.id);
      this.load(previousState);
      throw error;
    }
    return this.package(pkg.id)!;
  }

  unregisterDynamicPackage(id: string): void {
    if (!this.dynamicPackages.has(id)) return;
    this.dynamicPackages.delete(id);
    this.adapters.delete(id);
    this.load(this.state);
  }

  // Adapters load on first use: they import gateway modules that import this registry.
  async adapterOf(pkg: EnginePackage): Promise<EngineAdapter> {
    const dynamic = this.dynamicPackages.get(pkg.id);
    if (dynamic?.adapter) {
      return dynamic.adapter;
    }
    if (!this.adapters.has(pkg.id)) {
      const name = pkg.manifest.platform.adapter;
      if (!name) throw new Error(pkg.file + ': platform.adapter is required');
      // A failed import is retried on next use, so fixing the file needs no gateway restart.
      this.adapters.set(
        pkg.id,
        import(pathToFileURL(join(pkg.dir, name)).href).then(
          (m: { default: EngineAdapter }) => m.default,
          (e: unknown) => {
            this.adapters.delete(pkg.id);
            throw e;
          },
        ),
      );
    }
    return this.adapters.get(pkg.id)!;
  }

  enabledPackages(): EnginePackage[] {
    return this.packages.filter((p) => p.enabled);
  }

  package(id: string): EnginePackage | null {
    return this.packages.find((p) => p.id === id) ?? null;
  }

  // Scheduler engine key -> package.
  engines(): Record<string, EnginePackage> {
    return Object.fromEntries(this.enabledPackages().map((p) => [p.manifest.platform.engine, p]));
  }

  enginePackage(engine: string): EnginePackage | null {
    return this.engines()[engine] ?? null;
  }

  async adapter(engine: string): Promise<EngineAdapter | null> {
    const pkg = this.enginePackage(engine);
    return pkg ? this.adapterOf(pkg) : null;
  }

  runtimes(): Record<string, Omit<RuntimeDriverSpec, 'id'> & { engines: string[] }> {
    const runtimes: Record<string, Omit<RuntimeDriverSpec, 'id'> & { engines: string[] }> = {};
    for (const pkg of this.enabledPackages()) {
      const p = pkg.manifest.platform;
      const { id, ...runtime } = p.runtime;
      const row = (runtimes[id] ??= {
        ...runtime,
        driver: runtime.driver ?? 'docker',
        engines: [],
      });
      row.engines.push(p.engine);
    }
    return runtimes;
  }

  // Public model rows, one per served model, in routing priority order.
  models(): Array<{
    id: string;
    capabilities: string[];
    priority?: number;
    info?: Record<string, unknown>;
    engine: string;
    category: 'llm' | 'image' | 'video' | 'audio';
    kind: string;
    package: string;
  }> {
    return this.enabledPackages()
      .flatMap((pkg) =>
        pkg.manifest.platform.models.map((model) => ({
          ...model,
          engine: pkg.manifest.platform.engine,
          category: pkg.manifest.category,
          kind:
            CATEGORY_TYPE[pkg.manifest.category] === 'language'
              ? 'text'
              : CATEGORY_TYPE[pkg.manifest.category],
          package: pkg.id,
        })),
      )
      .sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
          (a.priority ?? 100) - (b.priority ?? 100) ||
          a.id.localeCompare(b.id),
      );
  }

  model(id: string) {
    return this.models().find((m) => m.id === id) ?? null;
  }

  capabilities(): string[] {
    return [...new Set(this.models().flatMap((m) => m.capabilities))];
  }

  // Primary first, then fallbacks, then any other enabled provider so a new engine is reachable
  // by name without being promoted. Disabled or missing names are skipped silently.
  routing(capability: string): {
    capability: string;
    primary: string | null;
    fallbacks: string[];
    providers: string[];
    fallback_on_backend_error: boolean;
  } {
    const providers = this.models()
      .filter((m) => m.capabilities.includes(capability))
      .map((m) => m.id);
    const saved = this.state.routing[capability] ?? {};
    const chain = [saved.primary, ...(saved.fallbacks ?? [])].filter(
      (id): id is string => typeof id === 'string' && providers.includes(id),
    );
    const primary = chain[0] ?? providers[0] ?? null;
    const fallbacks = saved.primary || saved.fallbacks ? chain.slice(1) : providers.slice(1);
    return {
      capability,
      primary,
      fallbacks: [...new Set(fallbacks)].filter((id) => id !== primary),
      providers,
      fallback_on_backend_error: saved.fallback_on_backend_error === true,
    };
  }

  persist(): void {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = this.statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  async setEnabled(id: string, enabled: boolean): Promise<EnginePackage | null> {
    const pkg = this.package(id);
    if (!pkg) throw Object.assign(new Error('Unknown engine package: ' + id), { status: 404 });
    const previous = this.state;
    try {
      this.load({
        ...previous,
        engines: { ...previous.engines, [id]: { ...previous.engines[id], enabled: !!enabled } },
      });
      if (enabled) await this.adapterOf(this.package(id)!);
    } catch (e) {
      this.load(previous);
      throw Object.assign(e as object, { status: 409 });
    }
    this.persist();
    return this.package(id);
  }

  setRouting(
    capability: string,
    {
      primary,
      fallbacks = [],
      fallback_on_backend_error = false,
    }: { primary: string; fallbacks?: string[]; fallback_on_backend_error?: boolean },
  ) {
    const capabilityModels = this.models().filter((m) => m.capabilities.includes(capability));
    const providers = capabilityModels.map((m) => m.id);
    if (!providers.length) {
      throw Object.assign(new Error('No enabled engine provides ' + capability), { status: 404 });
    }
    const resolveProvider = (id: string): string | null => {
      if (providers.includes(id)) return id;
      const byEngineOrPkg = capabilityModels.find((m) => m.engine === id || m.package === id);
      return byEngineOrPkg ? byEngineOrPkg.id : null;
    };
    const resolvedPrimary = resolveProvider(primary);
    if (!resolvedPrimary) {
      throw Object.assign(new Error(primary + ' does not provide ' + capability), { status: 400 });
    }
    const resolvedFallbacks: string[] = [];
    for (const id of fallbacks) {
      const resolved = resolveProvider(id);
      if (!resolved) {
        throw Object.assign(new Error(id + ' does not provide ' + capability), { status: 400 });
      }
      if (resolved !== resolvedPrimary && !resolvedFallbacks.includes(resolved)) {
        resolvedFallbacks.push(resolved);
      }
    }
    this.load({
      ...this.state,
      routing: {
        ...this.state.routing,
        [capability]: {
          primary: resolvedPrimary,
          fallbacks: resolvedFallbacks,
          fallback_on_backend_error: !!fallback_on_backend_error,
        },
      },
    });
    this.persist();
    return this.routing(capability);
  }

  // Console cards come straight from the manifests.
  services() {
    // Language first, then image, video and audio engines, as the console has always listed them.
    const ordered = [...this.enabledPackages()].sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.manifest.category) - CATEGORY_ORDER.indexOf(b.manifest.category) ||
        a.manifest.platform.ui.name.localeCompare(b.manifest.platform.ui.name),
    );
    return ordered.map((pkg) => {
      const p = pkg.manifest.platform;
      return {
        id: p.engine,
        package: pkg.id,
        ...p.ui,
        type: CATEGORY_TYPE[pkg.manifest.category],
        category: pkg.manifest.category,
        status: pkg.manifest.status ?? null,
        models: p.models.map((m) => ({ id: m.id, capabilities: m.capabilities })),
        runtime: p.runtime.id,
        driver: p.runtime.driver ?? 'docker',
        port: p.runtime.port ?? null,
        base_url: p.runtime.base_url ?? null,
        resources: p.resources ?? null,
        native_ui: p.runtime.native_ui ?? null,
      };
    });
  }
}

export const registry = new Registry();
