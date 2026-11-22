import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { API_ERRORS, ApiError } from './api-errors.mjs';
import {
  capabilityForSync,
  candidates,
  mediaModels,
  routes,
  runtimeTopology,
} from './capabilities.mjs';
import { pause } from './core.mjs';
import { artifactsDirectory } from './media.mjs';
import { executeMedia } from './media-executor.mjs';
import { monitoring } from './monitoring.mjs';
import { registry } from './registry.mjs';

const localOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

export function send(res, status, data) {
  if (res.destroyed) return;
  const raw = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

async function body(req, limit) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new Error('Use application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!size) throw new Error('JSON object required');
  const data = JSON.parse(Buffer.concat(chunks));
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw new Error('JSON object required');
  }
  return data;
}

const releaseLease = async (coordinator, token) => {
  for (let i = 0; i < 20; i++) {
    try {
      await coordinator.release(token);
      return;
    } catch (e) {
      if (e.message === 'Invalid lease token') return;
      await pause(500);
    }
  }
};

export function handlers(
  coordinator,
  metrics,
  lifecycle,
  { llmBase = null, engineBases = {}, telemetry = null, onShutdown = null } = {},
) {
  const adapterContext = (pkg) => {
    const engine = pkg.manifest.platform.engine;
    const runtime = pkg.manifest.platform.runtime;
    const defaultBase =
      runtime.base_url ??
      (runtime.port ? 'http://127.0.0.1:' + runtime.port : 'http://127.0.0.1:0');
    const baseCtx =
      typeof coordinator.backend?.context === 'function'
        ? coordinator.backend.context(engine)
        : {
            backend: coordinator.backend,
            engine,
            runtime,
            base: defaultBase,
            package: pkg,
          };
    if (engineBases?.[engine]) {
      return { ...baseCtx, base: engineBases[engine] };
    }
    if (llmBase && pkg.manifest.category === 'llm') {
      return { ...baseCtx, base: llmBase };
    }
    return baseCtx;
  };

  const primaryLlmPolicyState = async () => {
    for (const pkg of registry.enabledPackages()) {
      if (pkg.manifest.category !== 'llm') continue;
      const adapter = await registry.adapterOf(pkg);
      if (!adapter?.policyState) continue;
      const ctx = adapterContext(pkg);
      const state = await adapter.policyState(ctx).catch(() => null);
      return { engine: pkg.manifest.platform.engine, pkg, adapter, ctx, state };
    }
    return null;
  };

  const resolveReconfigureTarget = async (requestedEngine) => {
    if (requestedEngine) {
      const pkg = registry.enginePackage(requestedEngine);
      if (!pkg) return null;
      const adapter = await registry.adapterOf(pkg);
      return { engine: requestedEngine, pkg, adapter, ctx: adapterContext(pkg) };
    }
    for (const pkg of registry.enabledPackages()) {
      if (pkg.manifest.category !== 'llm') continue;
      const adapter = await registry.adapterOf(pkg);
      if (adapter?.reconfigure) {
        return {
          engine: pkg.manifest.platform.engine,
          pkg,
          adapter,
          ctx: adapterContext(pkg),
        };
      }
    }
    return null;
  };

  const resolveChatEngine = async (requestBody) => {
    for (const pkg of registry.enabledPackages()) {
      if (pkg.manifest.category !== 'llm') continue;
      const adapter = await registry.adapterOf(pkg);
      const ctx = adapterContext(pkg);
      if (adapter?.resolveChatRequest) {
        if (await adapter.resolveChatRequest(ctx, requestBody)) {
          return { engine: pkg.manifest.platform.engine, pkg, adapter, ctx };
        }
      } else if (adapter?.models) {
        const listed = await adapter.models(ctx);
        if (Array.isArray(listed) && listed.some((m) => m.id === requestBody?.model)) {
          return { engine: pkg.manifest.platform.engine, pkg, adapter, ctx };
        }
      } else if (requestBody?.model === pkg.manifest.platform.engine) {
        return { engine: pkg.manifest.platform.engine, pkg, adapter, ctx };
      }
    }
    return null;
  };

  // /status feeds the exporter and the controller every few seconds; the KV forecast table is only sent on ?full=1.
  const status = async (full = false) => {
    const s = coordinator.status();
    const llmInfo = await primaryLlmPolicyState();
    const p = llmInfo?.state;
    const reconfMatches =
      llmInfo && s.reconfiguring?.engine === llmInfo.engine ? s.reconfiguring : null;
    const compat = p
      ? {
          selected_llm_mode: p.selected_mode ?? null,
          pending_llm_mode: reconfMatches ? reconfMatches.target : null,
          mode_switch: reconfMatches,
          llm_policy: p.policy ?? null,
          llm_engine: p.engine_config ?? null,
          kv_forecast: full ? (p.kv_forecast ?? null) : null,
          kv_budget: p.kv_budget ?? null,
          llm_mode: p.loaded_mode ?? null,
          llm_slots: Object.fromEntries(
            (p.slots ?? []).map((slot) => [slot, s.active_slots?.[slot] ?? 0]),
          ),
        }
      : {};
    return {
      ...compat,
      ...s,
      ...(full ? {} : { kv_forecast: null }),
      ...metrics.snapshot(),
      draining: lifecycle.draining,
      residency: (await coordinator.backend?.residency?.()) ?? { enabled: false },
    };
  };

  async function control(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/status') {
      return send(res, 200, await status(url.searchParams.get('full') === '1'));
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
    if (req.headers.origin) return send(res, 403, { error: 'Local JSON clients only' });
    try {
      if (process.env.WORKBENCH_READ_ONLY === '1') {
        return send(res, 403, { error: 'Preview is read-only' });
      }
      if (path === '/shutdown') {
        req.resume();
        if (onShutdown) {
          let triggered = false;
          const trigger = () => {
            if (triggered) return;
            triggered = true;
            setImmediate(() => {
              void Promise.resolve(onShutdown()).catch(() => {});
            });
          };
          res.once('finish', trigger);
          res.once('close', trigger);
          send(res, 202, { ok: true, draining: true });
          return;
        }
        return send(res, 200, { ok: true, draining: Boolean(lifecycle.draining) });
      }
      const d = await body(req, 4096);
      let result = { ok: true };
      if (path === '/acquire') {
        coordinator.assertAcceptingRequests(d.model);
        if (lifecycle.draining) return send(res, 503, { error: 'Scheduler draining' });
        const timeout = Number(d.timeout ?? 900);
        if (!Number.isFinite(timeout)) throw new Error('Invalid timeout');
        const pkg = registry.enginePackage(d.model);
        const adapter = pkg ? await registry.adapterOf(pkg) : null;
        const extraOpts = adapter?.acquireOptions
          ? await adapter.acquireOptions(adapterContext(pkg), d)
          : {};
        result = await coordinator.acquire(d.model, {
          timeout: Math.min(900, Math.max(1, timeout)),
          exclusive: d.exclusive !== undefined ? Boolean(d.exclusive) : !d.shared,
          ...(d.concurrency !== undefined ? { concurrency: Number(d.concurrency) } : {}),
          ...(d.modeKey !== undefined ? { modeKey: String(d.modeKey) } : {}),
          ...(d.slot !== undefined ? { slot: String(d.slot) } : {}),
          ...extraOpts,
        });
      } else if (path === '/renew') coordinator.renew(d.token);
      else if (path === '/release') await coordinator.release(d.token);
      else if (path === '/workflow-event') metrics.workflow(d);
      else return send(res, 404, { error: 'Not found' });
      send(res, 200, result);
    } catch (e) {
      send(
        res,
        e instanceof ApiError ? e.status : 409,
        e instanceof ApiError ? e.toJSON() : { error: e.message },
      );
    }
  }

  async function api(req, res, { admit, keyId } = {}) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const origin = req.headers.origin;
    if (origin && !localOrigin(origin)) {
      return send(res, 403, { error: 'Only local browser origins are allowed' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }
    if (req.method === 'GET') {
      if (path === '/status') {
        return send(res, 200, await status(url.searchParams.get('full') === '1'));
      }
      if (path === '/api/engine-logs' || path === '/api/llm-mode/logs') {
        const requested = url.searchParams.get('model');
        if (requested !== null && !registry.enginePackage(requested)) {
          return send(res, 400, { error: 'Invalid model' });
        }
        const s = coordinator.status();
        const model =
          requested ??
          s.reconfiguring?.engine ??
          s.switching_target ??
          s.lease_model ??
          s.current ??
          null;
        const pkg = model ? registry.enginePackage(model) : null;
        const adapter = pkg ? await registry.adapterOf(pkg) : null;
        const ctx = pkg ? adapterContext(pkg) : null;
        const pState =
          adapter?.policyState && ctx ? await adapter.policyState(ctx).catch(() => null) : null;
        const reconf = s.reconfiguring?.engine === model ? s.reconfiguring : null;
        const transition =
          s.engine_switch?.target === model &&
          !(reconf && s.engine_switch.started_at < reconf.started_at)
            ? s.engine_switch
            : null;
        const activeSwitch =
          s.switching &&
          (s.switching_target === model ||
            (Array.isArray(s.switching_targets) && s.switching_targets.includes(model)));
        const engineLogs = (await coordinator.backend?.engineLogs?.(model, {
          since:
            activeSwitch && transition ? new Date(transition.started_at).toISOString() : undefined,
          includeProbes: url.searchParams.get('include_probes') === '1',
        })) ?? { model, output: '引擎日志暂不可用。', available: false };
        if (
          reconf &&
          (reconf.phase === 'draining' ||
            (engineLogs.container_id && engineLogs.container_id === reconf.previous_container))
        ) {
          engineLogs.startup_output = null;
          engineLogs.startup_complete = false;
        }
        return send(res, 200, {
          ...engineLogs,
          model,
          policy: pState?.policy ?? null,
          engine_policy: pState?.engine_config ?? null,
          target_policy: reconf ? reconf.policy : null,
          mode_switch: reconf,
          model_id: pState?.active_model_id ?? null,
          engine_switch: transition,
          events: reconf ? (reconf.events ?? []) : [],
          current_model: s.current ?? null,
          switching: Boolean(activeSwitch || reconf),
        });
      }
      if (path === '/health') {
        return send(res, lifecycle.draining ? 503 : 200, {
          status: lifecycle.draining ? 'draining' : 'ready',
          gateway: true,
          gpu: coordinator.status(),
        });
      }
      if (path === '/data') {
        const minutes = Number(url.searchParams.get('minutes') ?? 30);
        const windowSeconds = Number(url.searchParams.get('window') ?? 30);
        if (![15, 30, 60].includes(minutes)) return send(res, 400, { error: 'Invalid time range' });
        if (![5, 15, 30, 60].includes(windowSeconds)) {
          return send(res, 400, { error: 'Invalid sampling window' });
        }
        const model = url.searchParams.get('model');
        if (model !== null && !registry.enginePackage(model)) {
          return send(res, 400, { error: 'Invalid model' });
        }
        return send(
          res,
          200,
          await monitoring(coordinator, metrics, minutes, windowSeconds, model ?? undefined, {
            full: url.searchParams.get('full') === '1',
            telemetry,
            llmBase,
            engineBases,
          }),
        );
      }
      if (path === '/v1/models') {
        const data = [];
        for (const pkg of registry.enabledPackages()) {
          if (pkg.manifest.category !== 'llm') continue;
          const adapter = await registry.adapterOf(pkg);
          const ctx = adapterContext(pkg);
          if (adapter?.models) {
            const listed = await adapter.models(ctx);
            if (Array.isArray(listed)) data.push(...listed);
          } else {
            data.push({
              id: pkg.manifest.platform.engine,
              object: 'model',
              owned_by: 'local-workbench',
              tasks: ['chat'],
            });
          }
        }
        return send(res, 200, { object: 'list', data });
      }
      if (path === '/v1/media/models') {
        return send(res, 200, {
          object: 'list',
          runtime_topology: runtimeTopology(coordinator.status()),
          capabilities: routes(),
          data: (await mediaModels()).map((model) => ({
            id: model.id,
            object: 'model',
            owned_by: 'local-workbench',
            tasks: [model.kind],
            capabilities: model,
            ...(model.reference_limits
              ? {
                  reference_limits: model.reference_limits,
                  reference_presets: model.sync_api?.reference_presets,
                }
              : {}),
          })),
        });
      }
      if (path === '/v1/capabilities') return send(res, 200, { object: 'list', data: routes() });
      if (path === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        return res.end(metrics.prometheus(coordinator) + (telemetry ? telemetry.prometheus() : ''));
      }
      if (/^\/artifacts\/[a-f0-9]{32}\.mp4$/.test(path)) {
        try {
          const file = artifactsDirectory() + path.split('/').at(-1);
          const info = await stat(file);
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': info.size });
          const stream = createReadStream(file);
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
          return;
        } catch {
          return send(res, 404, { error: 'Artifact not found' });
        }
      }
      return send(res, 404, { error: 'Unknown API endpoint' });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (lifecycle.draining) return send(res, 503, { error: 'Gateway draining' });
    if (process.env.WORKBENCH_READ_ONLY === '1') {
      return send(res, 403, { error: 'Preview is read-only' });
    }

    const started = performance.now();
    let model;
    let chatMatch = null;
    let prepared = null;
    let capability;
    let chain;
    let queue = 0;
    let outcome = 'error';
    let counted = false;
    let ticket;
    let timer;
    let phase = 'reading_request';
    const client = new AbortController();
    const clientDisconnected = () => {
      if (res.writableFinished) return;
      client.abort();
      console.warn(
        JSON.stringify({
          event: 'api_client_disconnected',
          code:
            phase === 'waiting_for_admission'
              ? 'CLIENT_REQUEST_CANCELLED'
              : 'CLIENT_CONNECTION_CLOSED',
          path,
          model,
          phase,
          elapsed_seconds: (performance.now() - started) / 1000,
        }),
      );
    };
    res.once('close', clientDisconnected);

    try {
      const d = await body(req, 32 * 2 ** 20);
      const reconfigureMatch = /^\/api\/engines\/([A-Za-z0-9_.-]+)\/reconfigure$/.exec(path);
      if (path === '/api/llm-mode' || reconfigureMatch) {
        const target = await resolveReconfigureTarget(reconfigureMatch?.[1] ?? d.engine);
        if (!target) return send(res, 404, { error: 'No reconfigurable engine enabled' });
        const validated = target.adapter?.validatePolicy ? target.adapter.validatePolicy(d) : d;
        const pState = target.adapter?.policyState
          ? await target.adapter.policyState(target.ctx).catch(() => null)
          : null;
        const result = await coordinator.reconfigure(target.engine, validated, {
          previousContainer: pState?.capacity_container ?? null,
          apply: (policy) => target.adapter?.reconfigure?.(target.ctx, policy),
        });
        return send(res, 200, result);
      }

      if (path === '/v1/chat/completions') {
        chatMatch = await resolveChatEngine(d);
        if (!chatMatch) throw new Error('Choose an LLM model from /v1/models');
        model = chatMatch.engine;
        coordinator.assertAcceptingRequests(model);
        if (!Array.isArray(d.messages) || !d.messages.length) {
          throw new Error('messages required');
        }
        prepared = chatMatch.adapter?.prepareChat
          ? await chatMatch.adapter.prepareChat(chatMatch.ctx, d)
          : { leaseOptions: {}, responseHeaders: {}, state: null };
      } else if (capabilityForSync(path)) {
        capability = capabilityForSync(path);
        if (typeof d.prompt !== 'string' || !d.prompt.trim()) throw new Error('prompt required');
        chain = (await candidates(capability, d, { sync: true })).models;
        model = chain[0].engine;
      } else {
        return send(res, 404, { error: 'Unknown API endpoint' });
      }

      coordinator.assertAcceptingRequests(model);
      phase = 'waiting_for_admission';
      const admission = await admit?.(model, client.signal);
      if (client.signal.aborted) throw new ApiError('CLIENT_REQUEST_CANCELLED');

      if (chain) {
        for (let i = 0; ; i++) {
          const served = chain[i];
          const adapter = await registry.adapter(served.engine);
          model = served.engine;
          try {
            const preparedVideos = await adapter?.prepare?.(capability, d);
            if (client.signal.aborted) throw new ApiError('CLIENT_REQUEST_CANCELLED');
            metrics.start(model);
            counted = true;
            phase = 'waiting_for_engine';
            ticket = await coordinator.acquire(model, {
              timeout: admission?.timeout ?? 900,
              slot: served.id,
              key: admission?.key,
              signal: client.signal,
              enqueuedAt: admission?.enqueuedAt,
            });
            timer = setInterval(() => {
              try {
                coordinator.renew(ticket.token);
              } catch {}
            }, 30000);
            if (client.signal.aborted) throw new ApiError('CLIENT_REQUEST_CANCELLED');
            queue = (performance.now() - started) / 1000;
            phase = 'generating_response';
            const result = await executeMedia(
              model,
              { ...d, model: served.id },
              { capability, preparedVideos },
            );
            result.metrics = {
              ...result.metrics,
              gateway_queue_seconds: queue,
              gateway_total_seconds: (performance.now() - started) / 1000,
            };
            res.setHeader('X-Served-By', served.id);
            if (i) {
              res.setHeader(
                'X-Fallback-From',
                chain
                  .slice(0, i)
                  .map((m) => m.id)
                  .join(','),
              );
            }
            send(res, 200, result);
            break;
          } catch (e) {
            const fallback =
              chain[i + 1] &&
              !client.signal.aborted &&
              ['ENGINE_UNAVAILABLE', 'NOT_SUBMITTED'].includes(e.code);
            if (!fallback) throw e;
            console.warn(
              JSON.stringify({
                event: 'api_fallback',
                path,
                from: served.id,
                to: chain[i + 1].id,
                code: e.code,
              }),
            );
            clearInterval(timer);
            if (ticket) {
              await releaseLease(coordinator, ticket.token);
              ticket = null;
            }
            if (counted) {
              metrics.finish(model, 'error', (performance.now() - started) / 1000, queue);
              counted = false;
            }
          }
        }
      } else {
        metrics.start(model);
        counted = true;
        phase = 'waiting_for_engine';
        ticket = await coordinator.acquire(model, {
          timeout: admission?.timeout ?? 900,
          key: admission?.key,
          signal: client.signal,
          enqueuedAt: admission?.enqueuedAt,
          ...(prepared?.leaseOptions ?? {}),
        });
        timer = setInterval(() => {
          try {
            coordinator.renew(ticket.token);
          } catch {}
        }, 30000);
        if (client.signal.aborted) throw new ApiError('CLIENT_REQUEST_CANCELLED');
        queue = (performance.now() - started) / 1000;
        for (const [header, value] of Object.entries(prepared?.responseHeaders ?? {})) {
          res.setHeader(header, value);
        }
        phase = 'preparing_upstream';
        const payload = chatMatch.adapter?.beforeChat
          ? await chatMatch.adapter.beforeChat(chatMatch.ctx, d, {
              prepared,
              ticket,
              reserveBudget: (units, capacity) =>
                coordinator.reserveBudget(ticket.token, units, 900, {
                  signal: client.signal,
                  capacity,
                }),
              signal: client.signal,
            })
          : d;
        if (client.signal.aborted) throw new ApiError('CLIENT_REQUEST_CANCELLED');
        queue = (performance.now() - started) / 1000;
        phase = 'generating_response';
        if (typeof chatMatch.adapter?.chat === 'function') {
          await chatMatch.adapter.chat(chatMatch.ctx, payload, {
            req,
            res,
            stream: Boolean(d.stream),
            requestedModel: d.model,
            signal: client.signal,
          });
          if (res.destroyed) outcome = 'disconnected';
        } else {
          const upstream = await fetch(chatMatch.ctx.base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(1800000),
          });
          if (!upstream.ok) {
            send(res, upstream.status, await upstream.json());
            return;
          }
          if (d.stream) {
            res.writeHead(upstream.status, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });
            res.flushHeaders();
            for await (const chunk of upstream.body) {
              if (!res.destroyed && !res.write(Buffer.from(chunk))) {
                await Promise.race([once(res, 'drain'), once(res, 'close')]);
              }
            }
            if (res.destroyed) outcome = 'disconnected';
            else res.end();
          } else {
            const result = await upstream.json();
            result.model = d.model;
            send(res, upstream.status, result);
          }
        }
      }
      if (outcome !== 'disconnected') outcome = res.destroyed ? 'disconnected' : 'success';
    } catch (e) {
      if (e.retryAfterSeconds && !res.headersSent && !res.destroyed) {
        res.setHeader('Retry-After', String(e.retryAfterSeconds));
      }
      if (e.code === 'CLIENT_REQUEST_CANCELLED') outcome = 'disconnected';
      else if (e instanceof ApiError) {
        console.warn(
          JSON.stringify({
            event: 'api_request_rejected',
            code: e.code,
            status: e.status,
            path,
            model,
            key_id: keyId,
            ...e.details,
            retry_after_seconds: e.retryAfterSeconds,
          }),
        );
      }
      if (!res.headersSent) {
        const normalizedCode =
          e?.code && Object.hasOwn(API_ERRORS, e.code)
            ? e.code
            : ['ENOENT', 'EACCES', 'ECONNREFUSED'].includes(e?.code)
              ? 'ENGINE_UNAVAILABLE'
              : null;
        const apiErr =
          e instanceof ApiError
            ? e
            : normalizedCode
              ? new ApiError(normalizedCode, { message: e.message, details: e.details })
              : null;
        send(
          res,
          apiErr?.status ?? e.status ?? (ticket ? 503 : 400),
          apiErr ? apiErr.toJSON() : (e.data ?? { error: e.message }),
        );
      } else if (!res.destroyed) {
        res.destroy();
      }
    } finally {
      clearInterval(timer);
      if (ticket) await releaseLease(coordinator, ticket.token);
      if (counted) metrics.finish(model, outcome, (performance.now() - started) / 1000, queue);
    }
  }

  return { api, control };
}
