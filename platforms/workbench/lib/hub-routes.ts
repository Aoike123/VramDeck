import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  linkLocalModel,
  listEngines,
  listModels,
  matchEngines,
  recommendModels,
  resolveMirrorUrl,
} from './hub/catalog.ts';
import { DownloadManager } from './hub/downloader.ts';
import { adoptExternalService, createAdoptedAdapter, scanLocalServices } from './hub/scanner.ts';
import { send } from './http.mjs';
import { localManagement } from './mcp-routes.mjs';
import { ROOT, registry } from './registry.mjs';
import type { HardwareSnapshot } from './types.ts';

export interface HubRoutesOptions {
  dataDir: string;
  enginesDir?: string;
  coordinator?: {
    snapshot?: HardwareSnapshot | null;
    refreshDevices?: () => Promise<HardwareSnapshot | null>;
  };
  downloader?: DownloadManager;
}

async function readJsonBody(req: IncomingMessage, limit = 65536): Promise<Record<string, unknown>> {
  const ctype = req.headers['content-type']?.split(';')[0]?.trim();
  if (ctype && ctype !== 'application/json') {
    throw Object.assign(new Error('Use application/json'), { status: 415 });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${(error as Error).message}`), {
      status: 400,
    });
  }
}

export function hubRoutes(options: HubRoutesOptions) {
  const downloader = options.downloader ?? new DownloadManager();
  const enginesDir = options.enginesDir ?? join(ROOT, 'engines');

  async function currentSnapshot(): Promise<HardwareSnapshot | undefined> {
    if (options.coordinator?.snapshot) return options.coordinator.snapshot;
    if (options.coordinator?.refreshDevices) {
      const refreshed = await options.coordinator.refreshDevices().catch(() => null);
      if (refreshed) return refreshed;
    }
    return undefined;
  }

  return async function handleHub(req: IncomingMessage, res: ServerResponse) {
    if (!localManagement(req)) {
      return send(res, 403, { error: 'Local same-origin console only' });
    }
    const url = new URL(req.url ?? '/api/hub', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'POST' && process.env.WORKBENCH_READ_ONLY === '1') {
      return send(res, 403, { error: 'Preview is read-only' });
    }

    try {
      if (req.method === 'GET' && (pathname === '/api/hub' || pathname === '/api/hub/catalog')) {
        const snapshot = await currentSnapshot();
        const engines = snapshot ? matchEngines({ snapshot }) : listEngines();
        const models = snapshot ? recommendModels({ snapshot }) : listModels();
        return send(res, 200, {
          engines,
          models,
          downloads: downloader.list(),
        });
      }

      if (req.method === 'GET' && pathname === '/api/hub/engines') {
        const snapshot = await currentSnapshot();
        const engines = snapshot ? matchEngines({ snapshot }) : listEngines();
        return send(res, 200, { engines });
      }

      if (req.method === 'GET' && pathname === '/api/hub/models') {
        const snapshot = await currentSnapshot();
        const models = snapshot ? recommendModels({ snapshot }) : listModels();
        return send(res, 200, { models });
      }

      if (req.method === 'GET' && pathname === '/api/hub/downloads') {
        return send(res, 200, { downloads: downloader.list() });
      }

      if (req.method === 'POST' && pathname === '/api/hub/scan') {
        const body = await readJsonBody(req);
        const services = await scanLocalServices({
          targets: Array.isArray(body.targets)
            ? (body.targets as Array<{ kind?: string; url?: string; port?: number }>)
            : undefined,
          ports: Array.isArray(body.ports)
            ? body.ports.filter((p): p is number => typeof p === 'number')
            : undefined,
          urls: Array.isArray(body.urls)
            ? body.urls.filter((u): u is string => typeof u === 'string')
            : undefined,
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        });
        return send(res, 200, { services, discovered: services });
      }

      if (req.method === 'POST' && pathname === '/api/hub/adopt') {
        const body = await readJsonBody(req);
        const urlCandidate = String(body.url ?? body.base_url ?? '').trim();
        if (!urlCandidate) {
          return send(res, 400, { error: 'url or base_url is required' });
        }
        const enabled = body.enabled !== false;
        const adopted = await adoptExternalService(body, {
          id: typeof body.id === 'string' ? body.id : undefined,
          name: typeof body.name === 'string' ? body.name : undefined,
          enabled,
          enginesDir: body.persist ? enginesDir : undefined,
          dataDir: options.dataDir,
        });
        const baseUrl = adopted.manifest.platform.runtime.base_url!;
        const adapter = createAdoptedAdapter(adopted.kind, {
          id: adopted.id,
          baseUrl,
          models: adopted.models,
        });
        registry.registerDynamicPackage(
          {
            id: adopted.id,
            dir: join(options.dataDir, 'adopted', adopted.id),
            file: adopted.path ?? join(options.dataDir, 'hub-adopted.json'),
            manifest: adopted.manifest,
          },
          adapter,
          { enabled },
        );
        return send(res, 200, {
          ok: true,
          adopted: {
            id: adopted.id,
            path: adopted.path,
            manifest: adopted.manifest,
            models: adopted.models,
          },
        });
      }

      if (req.method === 'POST' && pathname === '/api/hub/engines/install') {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) {
          return send(res, 400, { error: 'Engine id is required' });
        }
        const catalogEntry = listEngines().find((e) => e.id === id);
        if (!catalogEntry) {
          return send(res, 404, { error: `Unknown Hub engine: ${id}` });
        }
        const installedPkg =
          registry.packages.find((p) => p.id === id || p.manifest.platform?.engine === id) ?? null;
        if (installedPkg && body.enable !== false) {
          await registry.setEnabled(installedPkg.id, true);
        }
        return send(res, 200, {
          ok: true,
          id,
          engine: catalogEntry,
          installed: Boolean(installedPkg),
          enabled: installedPkg ? (registry.package(installedPkg.id)?.enabled ?? true) : false,
        });
      }

      if (req.method === 'POST' && pathname === '/api/hub/models/pull') {
        const body = await readJsonBody(req);
        const mirror = typeof body.mirror === 'string' ? body.mirror : 'huggingface';
        let downloadUrl = typeof body.url === 'string' ? body.url.trim() : '';
        let targetName = typeof body.target === 'string' ? body.target.trim() : '';

        if (!downloadUrl) {
          const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
          const entry = listModels().find((m) => m.id === modelId);
          if (!entry) {
            return send(res, modelId ? 404 : 400, {
              error: modelId ? `Unknown Hub model: ${modelId}` : 'url or model_id is required',
            });
          }
          const src = entry.sources.find((s) => s.mirror === mirror) ?? entry.sources[0];
          const file = src.files?.[0] ?? `${entry.id}.gguf`;
          downloadUrl = resolveMirrorUrl({ mirror: src.mirror, repo: src.repo, file });
          targetName = targetName || file;
        } else {
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(downloadUrl);
          } catch {
            return send(res, 400, { error: 'Invalid download URL' });
          }
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return send(res, 400, { error: 'Download URL must use http or https' });
          }
          if (!targetName) {
            targetName = parsedUrl.pathname.split('/').filter(Boolean).pop() ?? 'model.bin';
          }
        }

        const safeTarget = targetName.replace(/[^A-Za-z0-9._-]/g, '_');
        const dest = join(options.dataDir, 'models', safeTarget);
        const { task_id, promise } = downloader.start({
          url: downloadUrl,
          destination: dest,
          target: safeTarget,
          sha256: typeof body.sha256 === 'string' ? body.sha256 : undefined,
        });
        promise.catch(() => {});
        return send(res, 202, {
          ok: true,
          task_id,
          target: safeTarget,
          mirror,
          status: 'queued',
        });
      }

      const cancelMatch = /^\/api\/hub\/downloads\/([^/]+)\/cancel$/.exec(pathname);
      if (req.method === 'POST' && cancelMatch) {
        const taskId = decodeURIComponent(cancelMatch[1]);
        const cancelled = downloader.cancel(taskId);
        if (!cancelled) {
          return send(res, 404, {
            error: `Download task not found or already finished: ${taskId}`,
          });
        }
        return send(res, 200, { ok: true, task_id: taskId, status: 'cancelled' });
      }

      if (req.method === 'POST' && pathname === '/api/hub/models/link') {
        const body = await readJsonBody(req);
        const dir = String(body.dir ?? body.path ?? '').trim();
        const id = String(body.id ?? '').trim();
        if (!id || !dir) {
          return send(res, 400, { error: 'id and dir/path are required' });
        }
        if (!existsSync(dir)) {
          return send(res, 400, { error: `Directory does not exist: ${dir}` });
        }
        const linked = await linkLocalModel({
          id,
          engine_id: typeof body.engine_id === 'string' ? body.engine_id : 'llama-cpp',
          dir,
          dataDir: options.dataDir,
        });
        return send(res, 200, { ok: true, linked });
      }

      return send(res, 404, { error: 'Unknown Hub endpoint' });
    } catch (error) {
      const err = error as Error & { status?: number };
      const status = typeof err.status === 'number' && err.status >= 400 ? err.status : 400;
      return send(res, status, { error: err.message });
    }
  };
}
