import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import next from 'next';
import { Agent, setGlobalDispatcher } from 'undici';
import { Backend, ROOT } from './lib/backend.mjs';
import { Coordinator, pause } from './lib/core.mjs';
import { Metrics } from './lib/metrics.mjs';
import { handlers, send } from './lib/http.mjs';
import { AccessKeys, keyManagement, publicManagement, secureApi } from './lib/access-keys.mjs';
import { PublicExposure } from './lib/public-exposure.mjs';
import { routes as mediaRoutes, catalog as mediaCatalog } from './lib/capabilities.mjs';
import { categoriesOf, syncViaJob } from './lib/media-tools.mjs';
import { MediaStore } from './lib/media-store.mjs';
import { MediaJobs } from './lib/media-jobs.mjs';
import { McpInfo, mcpRoutes } from './lib/mcp-routes.mjs';
import { platformRoutes } from './lib/platform-routes.mjs';
import { hubRoutes } from './lib/hub-routes.ts';
import { acquireProcessLock } from './lib/process-lock.mjs';
import { registry } from './lib/registry.mjs';
import { RingTelemetry } from './lib/telemetry.ts';
import { createDeviceProvider } from './lib/devices/index.ts';

setGlobalDispatcher(new Agent({ headersTimeout: 1800000, bodyTimeout: 1800000 }));

const directory = fileURLToPath(new URL('.', import.meta.url));

async function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function parseServerCliArgs(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--production') {
      opts.dev = false;
    } else if (arg === '--dev') {
      opts.dev = true;
    } else if (arg === '--headless') {
      opts.headless = true;
    } else if (arg === '--data-dir') {
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) throw new Error('--data-dir requires a path');
      opts.dataDir = val;
      i++;
    } else if (arg.startsWith('--data-dir=')) {
      const val = arg.slice('--data-dir='.length);
      if (!val) throw new Error('--data-dir requires a path');
      opts.dataDir = val;
    }
  }
  return opts;
}

export async function startControlPlane(options = {}) {
  const dataDir = resolve(
    options.dataDir ?? process.env.WORKBENCH_DATA ?? join(ROOT, 'workspace', 'data', 'scheduler'),
  );
  const headless = Boolean(
    options.headless ?? (options.next === false || process.env.WORKBENCH_HEADLESS === '1'),
  );
  const dev = Boolean(options.dev ?? process.env.NODE_ENV !== 'production');
  const telemetryIntervalMs = options.telemetryIntervalMs ?? 5000;
  const shutdownTimeoutMs = Number(
    options.shutdownTimeoutMs ?? process.env.WORKBENCH_SHUTDOWN_TIMEOUT_MS ?? 15000,
  );
  const managementPort = options.ports?.management ?? Number(process.env.WORKBENCH_PORT ?? 13000);
  const inferencePort = options.ports?.inference ?? Number(process.env.INFERENCE_PORT ?? 18982);
  const controlPort = options.ports?.control ?? Number(process.env.CONTROL_PORT ?? 18990);

  await mkdir(dataDir, { recursive: true });
  const releaseLock = await acquireProcessLock(join(dataDir, 'node.lock'));

  let app = null;
  let telemetry = null;
  let refreshTimer = null;
  let refreshToolsTimer = null;
  let servers = [];
  let closingPromise = null;

  const cleanupEarly = async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (refreshToolsTimer) clearInterval(refreshToolsTimer);
    telemetry?.stop();
    await Promise.all(
      servers.map(
        (s) =>
          new Promise((r) => {
            s.close(r);
            s.closeIdleConnections?.();
            s.closeAllConnections?.();
          }),
      ),
    );
    if (app?.close) await app.close().catch(() => {});
    await releaseLock().catch(() => {});
  };

  try {
    const scheduling = await readJsonSafe(
      options.schedulingPath ?? join(ROOT, 'platforms', 'scheduler', 'scheduling.json'),
      {},
    );
    const deviceProvider = options.deviceProvider ?? createDeviceProvider();
    const backend = options.backend ?? new Backend({ deviceProvider, dataDir });
    const coordinator = new Coordinator(backend, {
      deviceProvider,
      engineScheduling: scheduling,
      getResourceSpec: (engine) => registry.enginePackage(engine)?.manifest.platform.resources,
    });
    await coordinator.init();
    const metrics = new Metrics(join(dataDir, 'metrics.json'));
    const lifecycle = { draining: false };

    await backend.initAdapters?.().catch(() => null);

    telemetry = new RingTelemetry({
      deviceProvider,
      intervalMs: telemetryIntervalMs,
      isDraining: () => lifecycle.draining,
      getHealth: async () => ({
        api: lifecycle.draining ? 0 : 1,
        comfy: null,
      }),
    });
    await telemetry.sampleNow().catch(() => null);
    telemetry.start();

    let handle = (req, res) => send(res, 404, { error: 'UI disabled in headless mode' });
    if (!headless) {
      if (!dev) {
        const nextConfig = (await import('./next.config.mjs')).default;
        const distDir = nextConfig.distDir ?? '.next-workbench';
        if (!existsSync(join(directory, distDir, 'BUILD_ID'))) {
          throw new Error(
            `Next.js production build not found in ${join(directory, distDir)}. Run "npm --prefix platforms/workbench run build" or start with WORKBENCH_HEADLESS=1.`,
          );
        }
      }
      const nextTsconfig = join(directory, 'tsconfig.next.json');
      if (!existsSync(nextTsconfig)) {
        await writeFile(
          nextTsconfig,
          JSON.stringify({ extends: './tsconfig.json' }, null, 2) + '\n',
          'utf8',
        );
      }
      app = next({
        dev,
        dir: directory,
        hostname: '127.0.0.1',
        port: managementPort || 13000,
      });
      await app.prepare();
      handle = app.getRequestHandler();
    }

    const accessKeys = await AccessKeys.open(join(dataDir, 'access-keys.json'), {
      legacyFile: join(ROOT, 'workspace', 'data', 'public-api', 'api.keys'),
    });
    let mediaTools = [];
    const refreshTools = () =>
      mediaCatalog().then(
        (c) => {
          mediaTools = c.tools;
        },
        () => {},
      );
    await refreshTools();
    const unsubscribeRegistry = registry.onChange(() => {
      void refreshTools();
    });
    refreshToolsTimer = setInterval(refreshTools, 5000);
    refreshToolsTimer.unref?.();

    const exposure = await PublicExposure.open(join(dataDir, 'public-exposure.json'), {
      routes: mediaRoutes,
      categories: () => categoriesOf(mediaTools),
      root: ROOT,
    });
    const mediaStore = await new MediaStore(
      options.mediaRoot ? { root: options.mediaRoot } : {},
    ).open();
    const mediaJobs = await new MediaJobs(
      mediaStore,
      accessKeys,
      coordinator,
      metrics,
      lifecycle,
    ).open();
    const mcpInfo = await new McpInfo(mediaStore).open();
    const mcp = mcpRoutes(mediaJobs, mcpInfo, accessKeys, lifecycle);
    const platform = platformRoutes(coordinator, lifecycle);
    const hub = hubRoutes({ dataDir, coordinator });

    const close = () => {
      if (closingPromise) return closingPromise;
      closingPromise = (async () => {
        lifecycle.draining = true;
        mediaJobs.stopped = true;
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        if (refreshToolsTimer) {
          clearInterval(refreshToolsTimer);
          refreshToolsTimer = null;
        }
        unsubscribeRegistry();
        telemetry?.stop();
        if (coordinator.tick) {
          clearInterval(coordinator.tick);
          coordinator.tick = null;
        }

        const deadline = Date.now() + shutdownTimeoutMs;
        const remaining = () => Math.max(50, deadline - Date.now());
        const withTimeout = (promise) => {
          let timer = null;
          const timeoutPromise = new Promise((resolveTimeout) => {
            timer = setTimeout(resolveTimeout, remaining());
            timer.unref?.();
          });
          return Promise.race([promise, timeoutPromise])
            .catch(() => {})
            .finally(() => {
              if (timer) clearTimeout(timer);
            });
        };

        await withTimeout(
          Promise.allSettled([
            ...mediaJobs.workers,
            mediaJobs.pending,
            mediaJobs.recovery,
            mcpInfo.pending,
            accessKeys.pending,
            exposure.pending,
          ]),
        );

        while (
          Date.now() < deadline &&
          (coordinator.hasActiveWork?.() ||
            coordinator.owner ||
            coordinator.switching ||
            coordinator.queue.length ||
            accessKeys.preparing.size)
        ) {
          await coordinator.recover().catch(() => {});
          await pause(Math.min(200, remaining()));
        }

        await Promise.all(
          servers.map(
            (s) =>
              new Promise((resolveClose) => {
                s.close(() => resolveClose());
                s.closeIdleConnections?.();
                s.closeAllConnections?.();
                s.unref?.();
              }),
          ),
        );
        if (app?.close) await app.close().catch(() => {});
        await releaseLock().catch(() => {});
      })();
      return closingPromise;
    };

    const { api: rawApi, control } = handlers(coordinator, metrics, lifecycle, {
      telemetry,
      onShutdown: async () => {
        await close();
        await options.onShutdown?.();
      },
    });
    const api = secureApi(rawApi, accessKeys, { coordinator, exposure });
    const manageKeys = keyManagement(accessKeys);
    const managePublic = publicManagement(exposure);
    const syncJobApi = secureApi(mcp.syncJob, accessKeys, { coordinator, exposure });

    const inferenceApi = (req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (syncViaJob(path)) return syncJobApi(req, res);
      return path === '/internal/mcp/events' ||
        path === '/v1/media/catalog' ||
        path.startsWith('/v1/media/jobs') ||
        path.startsWith('/v1/media/assets') ||
        path.startsWith('/v1/media/artifacts')
        ? mcp.media(req, res)
        : api(req, res);
    };

    const safe = (fn) => (req, res) =>
      Promise.resolve(fn(req, res)).catch((e) => {
        console.error(e.message);
        if (!res.headersSent) send(res, 503, { error: 'Service temporarily unavailable' });
        else res.destroy();
      });

    const ui = http.createServer(
      safe((req, res) => {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path.startsWith('/api/mcp/')) return mcp.admin(req, res);
        if (path === '/api/platform' || path.startsWith('/api/platform/')) {
          return platform(req, res);
        }
        if (path === '/api/hub' || path.startsWith('/api/hub/')) {
          return hub(req, res);
        }
        if (path === '/api/access-keys') return manageKeys(req, res);
        if (path === '/api/public') return managePublic(req, res);
        return path === '/data' ||
          path === '/status' ||
          path === '/metrics' ||
          path === '/health' ||
          path.startsWith('/api/llm-mode') ||
          /^\/api\/engines\/[A-Za-z0-9_.-]+\/reconfigure$/.test(path) ||
          path === '/api/engine-logs' ||
          path.startsWith('/v1/') ||
          path.startsWith('/artifacts/')
          ? inferenceApi(req, res)
          : handle(req, res);
      }),
    );
    const inference = http.createServer(safe(inferenceApi));
    const controls = http.createServer(safe(control));
    servers = [ui, inference, controls];
    for (const server of servers) {
      server.requestTimeout = 0;
      server.headersTimeout = 60000;
    }

    const bindPorts = [managementPort, inferencePort, controlPort];
    await Promise.all(
      servers.map(
        (s, i) =>
          new Promise((resolveListen, rejectListen) => {
            s.once('error', rejectListen);
            s.listen(bindPorts[i], '127.0.0.1', resolveListen);
          }),
      ),
    );

    const boundPorts = {
      management: ui.address().port,
      inference: inference.address().port,
      control: controls.address().port,
    };

    await writeFile(join(dataDir, 'server.pid'), String(process.pid));

    let refreshing = false;
    refreshTimer = setInterval(async () => {
      if (refreshing || lifecycle.draining || coordinator.hasActiveWork?.()) return;
      refreshing = true;
      try {
        await coordinator.refreshDevices?.();
        const active = await backend.running();
        if (!coordinator.hasActiveWork?.()) {
          if (active.length === 1) {
            coordinator.current = backend.sameRuntime(active[0], coordinator.current)
              ? coordinator.current
              : active[0];
          } else if (active.length === 0) {
            coordinator.current = null;
          } else if (coordinator.current && !active.includes(coordinator.current)) {
            coordinator.current = active[0] ?? null;
          }
        }
      } catch {
      } finally {
        refreshing = false;
      }
    }, 5000);
    refreshTimer.unref?.();

    return {
      ports: boundPorts,
      urls: {
        management: `http://127.0.0.1:${boundPorts.management}`,
        inference: `http://127.0.0.1:${boundPorts.inference}`,
        control: `http://127.0.0.1:${boundPorts.control}`,
      },
      coordinator,
      backend,
      metrics,
      telemetry,
      lifecycle,
      close,
    };
  } catch (error) {
    await cleanupEarly();
    throw error;
  }
}

const isMainEntry =
  process.env.WORKBENCH_AUTOSTART === '1' ||
  (process.env.WORKBENCH_SERVER_NO_AUTOSTART !== '1' &&
    ((process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) ||
      (!process.argv[1] && !process.env.NODE_TEST_CONTEXT)));

if (isMainEntry) {
  const cliOptions = parseServerCliArgs(process.argv.slice(2));
  const controlPlane = await startControlPlane({
    ...cliOptions,
    onShutdown: () => {
      process.exit(0);
    },
  });
  console.log(
    'Next.js Workbench ready:',
    `${controlPlane.ports.management} / ${controlPlane.ports.inference} / ${controlPlane.ports.control}`,
  );
  const onSignal = async () => {
    await controlPlane.close();
    process.exit(0);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
