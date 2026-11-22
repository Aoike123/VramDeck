import { runtimeTopology } from './runtime-topology.mjs';
import { registry } from './registry.mjs';
import { routes } from './capabilities.mjs';
import { readHostResources } from './devices/index.ts';
import { alignTimestampSeconds, snapshotToValues } from './telemetry.ts';

const fullName = (engine) => {
  const ui = registry.enginePackage(engine)?.manifest.platform.ui;
  return ui ? (ui.full_name ?? ui.name) : null;
};

const LLM_SELECTOR = '{job="llm"}';
const LLM_UP = '(min(min_over_time(up{job="llm"}[30s])) == 1)';
const INPUT_EXPR = `sum(increase(vllm:prompt_tokens_total${LLM_SELECTOR}[1m])) and on() ${LLM_UP}`;
const VISION_UP = '(min(up{job="cpu_vision"}) == 1)';
const visionMetric = (expr) => `${expr} and on() ${VISION_UP}`;

const VISION_KEYS = [
  'vision_up',
  'vision_threads',
  'vision_active',
  'vision_waiting',
  'vision_cpu',
  'vision_memory',
  'vision_memory_limit',
  'vision_cache',
  'vision_cache_limit',
  'vision_cache_hit',
  'vision_encode',
  'vision_last_encode',
  'vision_encodes',
  'vision_hits',
  'vision_failures',
];

const LLM_KEYS = [
  'output',
  'peak',
  'input',
  'llm_up',
  'sample_age',
  'ttft',
  'kv',
  'running',
  'waiting',
];

export const SAMPLING = {
  scrape_seconds: 5,
  refresh_seconds: 5,
  output_window_seconds: 30,
  input_window_seconds: 60,
  latency_window_seconds: 300,
};

// Answers are shared for 3 s so concurrent console tabs and the sidebar reuse one computation.
const SHARE_MS = 3000;
const shared = new Map();
export const resetSharedQueries = () => shared.clear();

const shareFor = (key, compute) => {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.value;
  const value = compute();
  shared.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (shared.get(key)?.value === value) shared.delete(key);
  });
  for (const [k, v] of shared) if (Date.now() - v.at > SHARE_MS * 4) shared.delete(k);
  return value;
};

function latestCompletedFor(metrics, model) {
  const recent = metrics?.state?.recent;
  if (!Array.isArray(recent)) return null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i];
    if (row?.model === model && Number.isFinite(row.finished_at)) return row.finished_at;
  }
  return null;
}

function successCountFor(metrics, model) {
  const totals = metrics?.state?.totals;
  if (!Array.isArray(totals)) return null;
  const row = totals.find((r) => r?.model === model && r?.outcome === 'success');
  return row && Number.isFinite(row.count) ? row.count : null;
}

async function resolveHardwareSnapshot(coordinator, telemetry) {
  const cached = telemetry?.latest?.()?.snapshot;
  if (cached) return cached;
  try {
    if (typeof coordinator?.backend?.hardwareSnapshot === 'function') {
      const snap = await coordinator.backend.hardwareSnapshot();
      if (snap) return snap;
    }
  } catch {}
  return {
    collected_at: Date.now(),
    host: await readHostResources(),
    gpus: [],
  };
}

function buildPrometheusQueries(model, isLlm, windowSeconds) {
  const sel = `{model="${model}"}`;
  const fast = `sum(irate(vllm:generation_tokens_total${LLM_SELECTOR}[30s])) and on() ${LLM_UP}`;
  const chartUp = `(min(min_over_time(up{job="llm"}[${Math.max(30, windowSeconds)}s])) == 1)`;
  const chartOutput =
    windowSeconds === 5
      ? fast
      : `sum(rate(vllm:generation_tokens_total${LLM_SELECTOR}[${windowSeconds}s])) and on() ${chartUp}`;
  const peak = `max_over_time((${fast})[1m:5s]) and on() ${LLM_UP}`;

  const queries = {
    vram: 'sum(lab_gpu_vram_used_bytes)',
    vram_total: 'sum(lab_gpu_vram_total_bytes)',
    gpu: 'max(lab_gpu_busy_percent)',
    temperature: 'max(lab_gpu_temperature_celsius)',
    memory: 'node_memory_MemAvailable_bytes',
    memory_total: 'node_memory_MemTotal_bytes',
    api: 'lab_platform_health{service="gateway"}',
    comfy: 'lab_platform_health{service="comfyui"}',
    last: 'lab_gateway_last_request_seconds' + sel,
    wait: 'lab_gateway_last_queue_seconds' + sel,
    last_completed: 'lab_gateway_last_completed_timestamp_seconds' + sel,
    success: `sum(lab_gateway_requests_total{model="${model}",outcome="success"})`,
  };

  if (isLlm) {
    Object.assign(queries, {
      output: chartOutput,
      peak,
      input: INPUT_EXPR,
      llm_up: 'min(up{job="llm"})',
      sample_age: 'time() - max(timestamp(up{job="llm"}))',
      ttft: `histogram_quantile(0.95,sum by(le)(rate(vllm:time_to_first_token_seconds_bucket${LLM_SELECTOR}[5m]))) and on() (sum(increase(vllm:time_to_first_token_seconds_count${LLM_SELECTOR}[5m])) > 0) and on() ${LLM_UP}`,
      kv: `100 * avg(vllm:kv_cache_usage_perc${LLM_SELECTOR}) and on() ${LLM_UP}`,
      running: `sum(vllm:num_requests_running${LLM_SELECTOR}) and on() ${LLM_UP}`,
      waiting: `sum(vllm:num_requests_waiting${LLM_SELECTOR}) and on() ${LLM_UP}`,
    });
  }

  Object.assign(queries, {
    vision_up: 'min(up{job="cpu_vision"})',
    vision_threads: visionMetric('max(cpu_vision_threads)'),
    vision_active: visionMetric('sum(cpu_vision_active)'),
    vision_waiting: visionMetric('sum(cpu_vision_waiting)'),
    vision_cpu: visionMetric(
      '100 * sum(rate(cpu_vision_process_cpu_seconds_total[1m])) / max(cpu_vision_threads)',
    ),
    vision_memory: visionMetric('max(cpu_vision_container_memory_bytes)'),
    vision_memory_limit: visionMetric('max(cpu_vision_container_memory_limit_bytes)'),
    vision_cache: visionMetric('max(cpu_vision_cache_bytes)'),
    vision_cache_limit: visionMetric('max(cpu_vision_cache_limit_bytes)'),
    vision_cache_hit: visionMetric(
      '100 * sum(increase(cpu_vision_hits_total[5m])) / sum(increase(cpu_vision_requests_total[5m]))',
    ),
    vision_encode: visionMetric(
      'sum(rate(cpu_vision_encode_seconds_sum[5m])) / sum(rate(cpu_vision_encodes_total[5m]))',
    ),
    vision_last_encode: visionMetric(
      'max(cpu_vision_last_encode_seconds) and on() (sum(cpu_vision_encodes_total) > 0)',
    ),
    vision_encodes: visionMetric('sum(cpu_vision_encodes_total)'),
    vision_hits: visionMetric('sum(cpu_vision_hits_total)'),
    vision_failures: visionMetric('sum(cpu_vision_failures_total)'),
  });

  const trendQueries = {
    gpu: queries.gpu,
    vram: queries.vram,
    ...(isLlm ? { main: chartOutput, secondary: INPUT_EXPR, running: queries.running } : {}),
  };

  return { queries, trendQueries };
}

async function resolvePolicyDetails(coordinator, model, full) {
  const candidates = [];
  if (model) {
    const pkg = registry.enginePackage(model);
    if (pkg?.manifest.category === 'llm') candidates.push(pkg);
  }
  if (!candidates.length) {
    for (const pkg of registry.enabledPackages()) {
      if (pkg.manifest.category === 'llm') candidates.push(pkg);
    }
  }
  for (const pkg of candidates) {
    const adapter = await registry.adapterOf(pkg).catch(() => null);
    if (!adapter?.policyState) continue;
    const engine = pkg.manifest.platform.engine;
    const ctx =
      typeof coordinator?.backend?.context === 'function'
        ? coordinator.backend.context(engine)
        : {
            backend: coordinator?.backend,
            engine,
            runtime: pkg.manifest.platform.runtime,
            base:
              pkg.manifest.platform.runtime.base_url ??
              'http://127.0.0.1:' + pkg.manifest.platform.runtime.port,
          };
    const state = await adapter.policyState(ctx, { preview: full }).catch(() => null);
    if (state) return { engine, state };
  }
  return null;
}

// full: include the KV forecast tables (half a megabyte each), which only the configuration panel reads.
export async function monitoring(
  coordinator,
  metrics,
  minutes,
  windowSeconds = 30,
  requestedModel,
  { full = true, telemetry = null, prometheusUrl } = {},
) {
  const s = coordinator.status();
  const model = requestedModel ?? s.switching_target ?? s.current;
  const pkg = model ? registry.enginePackage(model) : null;
  const isLlm = pkg?.manifest.category === 'llm';
  const now = alignTimestampSeconds(Date.now(), 5);
  const promBaseRaw = prometheusUrl ?? process.env.WORKBENCH_PROMETHEUS_URL;
  const promBase =
    typeof promBaseRaw === 'string' && promBaseRaw.trim() !== ''
      ? promBaseRaw.trim().replace(/\/$/, '')
      : null;

  const {
    snapshot,
    values: currentValues,
    trends: currentTrends,
  } = await shareFor(`${model}|${minutes}|${windowSeconds}|${promBase ?? 'ring'}`, async () => {
    const snap = await resolveHardwareSnapshot(coordinator, telemetry);
    const latest = telemetry?.latest?.();
    const hwValues = snapshotToValues(
      snap,
      latest?.values?.api ?? 1,
      latest?.values?.comfy ?? null,
    );

    const ringValues = {
      ...hwValues,
      last: metrics?.state?.last_seconds?.[model] ?? null,
      wait: metrics?.state?.last_queue?.[model] ?? null,
      last_completed: latestCompletedFor(metrics, model),
      success: successCountFor(metrics, model),
    };

    for (const k of VISION_KEYS) {
      ringValues[k] = latest?.values?.[k] ?? null;
    }
    if (isLlm) {
      for (const k of LLM_KEYS) {
        ringValues[k] = latest?.values?.[k] ?? null;
      }
    }

    const ringTrends = {
      gpu: telemetry?.series?.('gpu', minutes, now)?.points ?? null,
      vram: telemetry?.series?.('vram', minutes, now)?.points ?? null,
      ...(isLlm
        ? {
            main: telemetry?.series?.('output', minutes, now)?.points ?? null,
            secondary: telemetry?.series?.('input', minutes, now)?.points ?? null,
            running: telemetry?.series?.('running', minutes, now)?.points ?? null,
          }
        : {}),
    };

    if (!promBase) {
      return { snapshot: snap, values: ringValues, trends: ringTrends };
    }

    const { queries, trendQueries } = buildPrometheusQueries(model, isLlm, windowSeconds);
    const queryProm = async (expr, range) => {
      try {
        const params = new URLSearchParams({
          query: expr,
          ...(range ? { start: String(now - minutes * 60), end: String(now), step: '5' } : {}),
        });
        const r = await fetch(`${promBase}/api/v1/${range ? 'query_range' : 'query'}?${params}`, {
          signal: AbortSignal.timeout(3000),
        });
        const d = await r.json();
        if (d.status !== 'success') return null;
        const row = d.data?.result?.[0];
        const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        if (range) {
          if (!row) return null;
          const byTime = new Map((row.values ?? []).map(([t, v]) => [t, n(v)]));
          return Array.from({ length: minutes * 12 + 1 }, (_, i) => {
            const t = now - minutes * 60 + i * 5;
            return [t, byTime.get(t) ?? null];
          });
        }
        return row ? n(row.value?.[1]) : null;
      } catch {
        return null;
      }
    };

    const [promValues, promSeries] = await Promise.all([
      Promise.all(
        Object.entries(queries).map(async ([k, expr]) => [k, await queryProm(expr, false)]),
      ),
      Promise.all(
        Object.entries(trendQueries).map(async ([k, expr]) => [k, await queryProm(expr, true)]),
      ),
    ]);

    const mergedValues = { ...ringValues };
    for (const [k, val] of promValues) {
      if (val !== null) mergedValues[k] = val;
    }

    const mergedTrends = { ...ringTrends };
    for (const [k, pts] of promSeries) {
      if (pts !== null) mergedTrends[k] = pts;
    }

    return { snapshot: snap, values: mergedValues, trends: mergedTrends };
  });

  const valuesOut = { ...currentValues };
  const isModelActive =
    s.current === model ||
    (Array.isArray(s.allocations) && s.allocations.some((a) => a.engine === model));
  if (isLlm && (!isModelActive || s.switching)) {
    for (const key of ['output', 'peak', 'input', 'ttft', 'kv', 'running', 'waiting']) {
      valuesOut[key] = null;
    }
  }

  const policyDetails = await resolvePolicyDetails(coordinator, model, full);
  const p = policyDetails?.state;
  const reconf =
    policyDetails && s.reconfiguring?.engine === policyDetails.engine ? s.reconfiguring : null;
  const gpus = s.gpus ?? snapshot?.gpus ?? [];
  const allocations = s.allocations ?? [];
  const switchingTargets = s.switching_targets ?? [];

  return {
    runtime_topology: runtimeTopology({
      ...s,
      gpus,
      allocations,
      switching_targets: switchingTargets,
    }),
    model,
    current_model: s.current ?? null,
    switching_target: s.switching_target ?? null,
    switching_targets: switchingTargets,
    allocations,
    pool: {
      gpus,
      allocations,
      queued: s.queued ?? 0,
      switching_targets: switchingTargets,
    },
    name: fullName(model) ?? '待机',
    services: registry.services(),
    capabilities: routes(),
    llm_mode: s.llm_mode ?? p?.loaded_mode ?? null,
    selected_llm_mode: s.selected_llm_mode ?? p?.selected_mode ?? null,
    pending_llm_mode: s.pending_llm_mode ?? (reconf ? reconf.target : null),
    mode_switch: s.mode_switch ?? reconf ?? null,
    engine_switch: s.engine_switch ?? null,
    reconfiguring: s.reconfiguring ?? null,
    llm_policy: s.llm_policy ?? p?.policy ?? null,
    llm_engine: s.llm_engine ?? p?.engine_config ?? null,
    kv_forecast: full ? (s.kv_forecast ?? p?.kv_forecast ?? null) : null,
    kv_preview_plan: full
      ? (p?.kv_preview_plan ?? (await coordinator.backend?.previewPlan?.()) ?? null)
      : null,
    kv_budget: s.kv_budget ?? p?.kv_budget ?? null,
    llm_slots:
      s.llm_slots ??
      (p?.slots
        ? Object.fromEntries(p.slots.map((slot) => [slot, s.active_slots?.[slot] ?? 0]))
        : null),
    switching: s.switching,
    queued: s.queued,
    active: metrics.active[model] ?? 0,
    error: s.last_error,
    recent: [...metrics.state.recent].reverse(),
    gpus,
    host: snapshot?.host ?? null,
    values: valuesOut,
    trends: currentTrends,
    timestamp: now,
    minutes,
    sampling: {
      ...SAMPLING,
      output_window_seconds: windowSeconds,
      peak_window_seconds: 60,
      peak_interval_seconds: 5,
    },
    kv_calibration: p?.kv_calibration ?? null,
    vram_defaults: p?.vram_defaults ?? null,
    residency: (await coordinator.backend?.residency?.()) ?? { enabled: false },
  };
}
