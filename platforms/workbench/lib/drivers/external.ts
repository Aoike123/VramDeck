import type {
  RuntimeDriver,
  RuntimeDriverSpec,
  RuntimeHandle,
  RuntimeLaunchOptions,
} from '../types.ts';

export interface ExternalDriverOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function resolveExternalBaseUrl(spec: RuntimeDriverSpec): string {
  const raw =
    spec.base_url ??
    (Number.isInteger(spec.port) && spec.port > 0 ? `http://127.0.0.1:${spec.port}` : '');
  if (!raw) {
    throw new Error(`ExternalDriver: runtime "${spec.id}" requires spec.base_url or spec.port`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`ExternalDriver: invalid base_url "${raw}" for runtime "${spec.id}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `ExternalDriver: base_url "${raw}" must use http: or https: for runtime "${spec.id}"`,
    );
  }
  return raw.replace(/\/$/, '');
}

export class ExternalDriver implements RuntimeDriver {
  readonly kind = 'external' as const;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ExternalDriverOptions = {}) {
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 3000;
  }

  async #probe(url: string): Promise<Response> {
    return this.#fetchFn(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  async isRunning(spec: RuntimeDriverSpec): Promise<boolean> {
    let baseUrl: string;
    try {
      baseUrl = resolveExternalBaseUrl(spec);
    } catch {
      return false;
    }
    const parsed = new URL(baseUrl);

    try {
      if (spec.health_path) {
        const suffix = spec.health_path.startsWith('/') ? spec.health_path : `/${spec.health_path}`;
        const res = await this.#probe(`${baseUrl}${suffix}`);
        return res.ok;
      }

      if (parsed.pathname === '/' || parsed.pathname === '') {
        const healthRes = await this.#probe(`${baseUrl}/health`);
        if (healthRes.ok) return true;
        if (healthRes.status === 404 || healthRes.status === 405) {
          const rootRes = await this.#probe(`${baseUrl}/`);
          return rootRes.ok;
        }
        return false;
      }

      const directRes = await this.#probe(baseUrl);
      return directRes.ok;
    } catch {
      return false;
    }
  }

  async start(spec: RuntimeDriverSpec, options: RuntimeLaunchOptions): Promise<RuntimeHandle> {
    const baseUrl = resolveExternalBaseUrl(spec);
    const reachable = await this.isRunning(spec);
    if (!reachable) {
      throw new Error(
        `ExternalDriver: endpoint ${baseUrl} for runtime "${spec.id}" is unreachable or unhealthy`,
      );
    }
    return {
      runtime_id: spec.id,
      driver: 'external',
      base_url: baseUrl,
      gpu_ids: [...options.gpu_ids],
    };
  }

  async stop(_handle: RuntimeHandle): Promise<void> {
    // External services are owned outside the control plane; stop is an intentional no-op.
  }
}
