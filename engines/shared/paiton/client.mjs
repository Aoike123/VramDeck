import { join } from 'node:path';
import {
  ROOT,
  call,
  containerStatus,
  enginePolicyKey,
  hostMemoryBytes,
  inspectContainer,
  isDockerDisabled,
  pause,
  readContainerLogs,
  readJsonFile,
  vramUsedBytes,
  writeJsonAtomic,
} from '../../../platforms/workbench/lib/engine-sdk.mjs';

export const LLM_REASONING_EFFORTS = Object.freeze({
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
});
export const LLM_DEFAULT_REASONING_EFFORT = 'medium';

const LLM_REASONING_ALIASES = Object.freeze({ off: 'none', minimal: 'low', max: 'xhigh' });

export function reasoningEffort(requested) {
  if (requested === undefined || requested === null) return LLM_DEFAULT_REASONING_EFFORT;
  const asked = typeof requested === 'string' ? requested.trim().toLowerCase() : undefined;
  if (asked === '') return LLM_DEFAULT_REASONING_EFFORT;
  if (asked !== undefined && Object.values(LLM_REASONING_EFFORTS).includes(asked)) return asked;
  if (asked !== undefined && Object.hasOwn(LLM_REASONING_ALIASES, asked)) {
    return LLM_REASONING_ALIASES[asked];
  }
  throw new Error(
    `Unsupported reasoning_effort ${JSON.stringify(requested)}; use ${Object.values(
      LLM_REASONING_EFFORTS,
    ).join(', ')}, or omit it for the default ${LLM_DEFAULT_REASONING_EFFORT}`,
  );
}

export const LLM_PROFILES = {
  'qwen38-27b-w3a4-192k': {
    mode: 'long',
    slot: '192k',
    maxModelLen: 196608,
    limit: 2,
    vision: true,
    visionDevice: 'cpu',
  },
  'qwen38-27b-w3a4-256k': {
    mode: 'long-single',
    slot: '256k',
    maxModelLen: 262144,
    limit: 1,
    vision: true,
    visionDevice: 'cpu',
  },
  'qwen38-27b-w3a4-64k': {
    mode: 'throughput',
    slot: '64k',
    maxModelLen: 65536,
    limit: 8,
    vision: true,
    visionDevice: 'cpu',
  },
};

export const LLM_MODES = {
  long: { limit: 2, name: '长上下文双路 · 每路 192K' },
  'long-single': { limit: 1, name: '长上下文单路 · 256K' },
  throughput: { limit: 8, name: '高并发图文 · 64K · 最多八路' },
};

const aliases = {
  'qwen38-27b-w3a4': 'qwen38-27b-w3a4-192k',
  'qwen38-27b-256k': 'qwen38-27b-w3a4-256k',
  'qwen38-27b-65k-8way': 'qwen38-27b-w3a4-64k',
};

export function activeModelId() {
  return 'qwen38-27b-w3a4';
}

export function llmProfile(id) {
  if (id === 'qwen38-27b-128k') {
    return { ...LLM_PROFILES['qwen38-27b-w3a4-192k'], maxModelLen: 131072 };
  }
  const key = Object.hasOwn(aliases, id) ? aliases[id] : id;
  if (Object.hasOwn(LLM_PROFILES, key)) return LLM_PROFILES[key];
  const match = typeof id === 'string' ? /^qwen38-27b-w3a4-([1-9]\d*(?:\.\d+)?)k$/.exec(id) : null;
  const context = match ? Number(match[1]) * 1024 : NaN;
  if (
    !Number.isInteger(context) ||
    context < 1024 ||
    context > 262144 ||
    id !== `qwen38-27b-w3a4-${context / 1024}k`
  ) {
    return undefined;
  }
  return {
    mode: 'custom',
    slot: match[1] + 'k',
    maxModelLen: context,
    limit: 8,
    vision: true,
    visionDevice: 'cpu',
  };
}

export function completionBudget(data, profile, promptTokens) {
  if (!Number.isInteger(promptTokens) || promptTokens < 0) {
    throw new Error('Backend did not report a valid prompt token count');
  }
  const requested = data.max_completion_tokens ?? data.max_tokens;
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
    throw new Error('Output token limit must be a positive integer');
  }
  const remaining = profile.maxModelLen - promptTokens;
  if (remaining < 1) {
    throw new Error(`Input plus output exceeds ${profile.maxModelLen} tokens for this model`);
  }
  return Math.min(requested ?? 4096, remaining);
}

export const KV_BUDGET_BYTES = 8859648000;
export function kvBudgetBytes(contextTokens) {
  return contextTokens <= 65536 ? KV_BUDGET_BYTES : 8 * 2 ** 30;
}
export const MAX_CONTEXT = 262144;
export const MAX_CONCURRENCY = 8;

export const VRAM_DEFAULTS = Object.freeze({
  vramTotalBytes: 31.86 * 2 ** 30,
  peakBytes: 31.58 * 2 ** 30,
  weightsBytes: 13.51 * 2 ** 30,
  bufferBytes: (31.58 - 13.51 - 8.251190185546875 - 1.45) * 2 ** 30,
});

export function graphCaptureBytes(concurrency, eager = false) {
  if (eager) return 0;
  const measured = { 1: 0.71, 2: 0.91, 6: 1.45, 8: 1.73 };
  if (measured[concurrency] != null) return measured[concurrency] * 2 ** 30;
  const points = Object.keys(measured)
    .map(Number)
    .sort((a, b) => a - b);
  const upper = points.find((n) => n > concurrency);
  const lower = [...points].reverse().find((n) => n < concurrency);
  if (lower == null || upper == null) return measured[lower ?? upper ?? 8] * 2 ** 30;
  return (
    (measured[lower] +
      ((measured[upper] - measured[lower]) * (concurrency - lower)) / (upper - lower)) *
    2 ** 30
  );
}

export const KV_CALIBRATION = Object.freeze([
  [49152, 8, 8859648000, 365975],
  [65536, 6, 8859648000, 393216],
  [196608, 2, 8589934592, 393873],
  [262144, 1, 8589934592, 412137],
]);

export function kvPoolBytesPerToken(contextTokens, concurrency, extras) {
  const hit = (extras?.calibration ?? KV_CALIBRATION).find(
    (row) => row[0] === contextTokens && row[1] === concurrency,
  );
  if (hit) {
    return {
      bytes_per_token: hit[2] / hit[3],
      source: 'measured',
      context_tokens: hit[0],
      concurrency: hit[1],
      allocated_pool_bytes: hit[2],
      capacity_tokens: hit[3],
    };
  }
  return {
    bytes_per_token: null,
    source: 'uncalibrated',
    context_tokens: contextTokens,
    concurrency,
    allocated_pool_bytes: null,
    capacity_tokens: null,
  };
}

export function planPreview(
  plan,
  contextTokens,
  concurrency,
  eager = false,
  kvBytes = kvBudgetBytes(contextTokens),
) {
  const sample =
    plan?.version === 2
      ? plan.matrix?.[`${contextTokens}:${concurrency}:${eager ? 'eager' : 'graph'}`]
      : null;
  if (
    !Number.isSafeInteger(sample?.block_bytes) ||
    sample.block_bytes <= 0 ||
    !Number.isSafeInteger(sample.blocks_per_request) ||
    sample.blocks_per_request <= 0 ||
    !Number.isSafeInteger(kvBytes) ||
    kvBytes <= 0
  ) {
    return null;
  }
  const blocks = Math.floor(kvBytes / sample.block_bytes);
  return {
    source: 'planned',
    block_bytes: sample.block_bytes,
    blocks_per_request: sample.blocks_per_request,
    gdn: sample.gdn,
    prefill_tokens: sample.prefill_tokens,
    pool_blocks: blocks,
    estimated_capacity_tokens: Math.floor((blocks * contextTokens) / sample.blocks_per_request),
    required_pool_bytes: sample.block_bytes * sample.blocks_per_request * concurrency,
    planned_pool_bytes: blocks * sample.block_bytes,
  };
}

export function allocatedPoolBytes(plan, policy) {
  if (
    plan?.version !== 2 ||
    plan.context_tokens !== policy?.context_tokens ||
    plan.concurrency !== policy?.concurrency ||
    plan.eager !== policy?.eager ||
    plan.kv_budget_bytes !== policy?.kv_budget_bytes ||
    !Number.isSafeInteger(plan.pool_blocks) ||
    plan.pool_blocks <= 0
  ) {
    return null;
  }
  const block =
    plan.matrix?.[
      `${policy.context_tokens}:${policy.concurrency}:${policy.eager ? 'eager' : 'graph'}`
    ]?.block_bytes;
  const bytes = plan.pool_blocks * block;
  return Number.isSafeInteger(block) && block > 0 && Number.isSafeInteger(bytes) ? bytes : null;
}

export function vramBudget({
  contextTokens,
  concurrency,
  eager = false,
  kvBytes,
  capacityTokens,
  allocatedPoolBytes: allocatedBytes,
  preview,
  vramTotalBytes,
  weightsBytes,
  bufferBytes,
  extras,
} = {}) {
  const finite = (n) => Number.isFinite(n) && n >= 0;
  const capture = eager
    ? 0
    : finite(extras?.graph_capture_bytes)
      ? extras.graph_capture_bytes
      : graphCaptureBytes(concurrency, false);
  const total = finite(vramTotalBytes)
    ? vramTotalBytes
    : finite(extras?.vram_total_bytes)
      ? extras.vram_total_bytes
      : VRAM_DEFAULTS.vramTotalBytes;
  const weights = finite(weightsBytes)
    ? weightsBytes
    : finite(extras?.weights_bytes)
      ? extras.weights_bytes
      : VRAM_DEFAULTS.weightsBytes;
  const buffer = finite(bufferBytes)
    ? bufferBytes
    : finite(extras?.buffer_bytes)
      ? extras.buffer_bytes
      : VRAM_DEFAULTS.bufferBytes;
  const verified =
    extras?.full_load_verified === true &&
    finite(extras?.buffer_bytes) &&
    finite(extras?.vram_total_bytes) &&
    finite(extras?.weights_bytes) &&
    (eager || finite(extras?.graph_capture_bytes));
  const feasible = Math.floor(total - weights - capture - buffer);
  const demand = contextTokens * concurrency;
  const budget = Number.isSafeInteger(kvBytes) ? kvBytes : null;
  const allocated = Number.isSafeInteger(allocatedBytes) ? allocatedBytes : null;
  const required = preview?.required_pool_bytes ?? null;
  const capacity = capacityTokens ?? preview?.estimated_capacity_tokens ?? null;
  const allocation = allocated ?? budget;
  const tokenShortfall = capacity == null ? null : Math.max(0, demand - capacity);
  const violations = [];
  if (allocation != null && allocation > feasible) violations.push('allocation');
  if (required != null && required > feasible) violations.push('vram');
  if (required != null && budget != null && required > budget) violations.push('budget');
  if (tokenShortfall > 0) violations.push('tokens');
  return {
    vram_total_bytes: total,
    weights_bytes: weights,
    graph_capture_bytes: capture,
    buffer_bytes: buffer,
    full_load_verified: verified,
    vram_source: verified ? 'load-measured' : 'startup-estimate',
    feasible_pool_bytes: feasible,
    required_pool_bytes: required,
    pool_budget_bytes: budget,
    pool_allocated_bytes: allocated,
    allocation_margin_bytes: allocation == null ? null : feasible - allocation,
    budget_margin_bytes: budget == null ? null : feasible - budget,
    usable_pool_margin_bytes:
      required == null || budget == null ? null : Math.min(feasible, budget) - required,
    full_load_margin_bytes:
      required == null || budget == null ? null : feasible - Math.max(required, budget),
    vram_margin_bytes: required == null ? null : feasible - required,
    capacity_tokens: capacity,
    demand_tokens: demand,
    capacity_margin_tokens: capacity == null ? null : capacity - demand,
    shortfall_tokens: tokenShortfall,
    factors: preview,
    violations,
    bottleneck: violations[0] ?? (required == null || capacity == null ? 'uncalibrated' : 'none'),
    source: capacityTokens != null ? 'measured' : preview ? 'planned' : 'uncalibrated',
  };
}

export function budgetStatus(budget) {
  if (budget?.violations?.length) return 'exceeded';
  if (budget?.capacity_tokens == null || budget?.required_pool_bytes == null) return 'unknown';
  if (!budget.full_load_verified) return 'unverified';
  if (budget.vram_margin_bytes < 0.5 * 2 ** 30 || budget.allocation_margin_bytes < 0.5 * 2 ** 30) {
    return 'tight';
  }
  return 'verified';
}

export function servingPolicy(mode = 'long', contextTokens, concurrency, eager = false, kvBytes) {
  const preset = { long: [196608, 2], 'long-single': [262144, 1], throughput: [65536, 8] };
  if (mode !== 'custom' && !Object.hasOwn(preset, mode)) throw new Error('Unknown LLM mode');
  const context = contextTokens ?? preset[mode]?.[0];
  const limit = concurrency ?? preset[mode]?.[1];
  if (!Number.isInteger(context) || context < 1024 || context > MAX_CONTEXT) {
    throw new Error('Context must be between 1024 and 262144 tokens');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONCURRENCY) {
    throw new Error('Concurrency must be between 1 and 8');
  }
  if (typeof eager !== 'boolean') throw new Error('Eager must be a boolean');
  const bytes = kvBytes ?? kvBudgetBytes(context);
  if (!Number.isSafeInteger(bytes) || bytes < 2 ** 30 || bytes > 32 * 2 ** 30) {
    throw new Error('KV budget must be between 1 and 32 GiB');
  }
  return { mode, context_tokens: context, concurrency: limit, eager, kv_budget_bytes: bytes };
}

export function policyBudget(policy, capacityTokens, measuredPolicy = enginePolicyKey(policy)) {
  if (measuredPolicy !== enginePolicyKey(policy)) capacityTokens = null;
  const demand = policy.context_tokens * policy.concurrency;
  const margin = capacityTokens == null ? null : capacityTokens - demand;
  return {
    capacity_tokens: capacityTokens ?? null,
    demand_tokens: demand,
    capacity_margin_tokens: margin,
    remaining_tokens: margin,
    shortfall_tokens: margin == null ? null : Math.max(0, -margin),
    risk: capacityTokens == null ? null : demand > capacityTokens,
    measured_policy: capacityTokens == null ? null : measuredPolicy,
  };
}

export function createPaitonState(defaultMode = 'long') {
  return {
    selectedMode: defaultMode,
    policy: servingPolicy(defaultMode),
    loadedMode: null,
    configuration: null,
    kvForecast: null,
    kvPlanId: null,
    capacityTokens: null,
    capacityContainer: null,
    startupBudget: null,
    startupBudgetContainer: null,
    startupLog: null,
  };
}

function runtimeBase(ctx) {
  return ctx?.base ?? 'http://127.0.0.1:' + (ctx?.runtime?.port ?? 18983);
}

function runtimeContainer(ctx) {
  return ctx?.runtime?.container ?? 'paiton-qwen38';
}

export async function readResidencyConfig(ctx) {
  if (ctx?.residencyConfig) return ctx.residencyConfig;
  const path = ctx?.residencyConfigPath ?? join(ROOT, 'platforms', 'scheduler', 'residency.json');
  return (
    (await readJsonFile(path, { enabled: false, models: ['llm'] })) ?? {
      enabled: false,
      models: ['llm'],
    }
  );
}

export async function isResidentLabelled(ctx) {
  if (typeof ctx?.backend?.labelled === 'function') {
    return Boolean(await ctx.backend.labelled());
  }
  if (isDockerDisabled(ctx)) return false;
  try {
    const val = await inspectContainer(
      ctx,
      '{{index .Config.Labels "ai.workbench.resident"}}',
      runtimeContainer(ctx),
    );
    return val === 'true';
  } catch {
    return false;
  }
}

export async function isSleeping(ctx) {
  if (typeof ctx?.backend?.sleeping === 'function') {
    return Boolean(await ctx.backend.sleeping());
  }
  try {
    return (
      (await isResidentLabelled(ctx)) &&
      (await call(runtimeBase(ctx), '/is_sleeping')).is_sleeping === true
    );
  } catch {
    return false;
  }
}

export async function sleepResidency(ctx) {
  const p = await readResidencyConfig(ctx);
  if (
    !p.enabled ||
    !p.models.includes(ctx?.engine ?? 'llm') ||
    !(await isResidentLabelled(ctx)) ||
    (await hostMemoryBytes(ctx)) < p.minimum_available_memory_gib * 2 ** 30
  ) {
    return false;
  }
  await call(runtimeBase(ctx), '/sleep?level=1&mode=wait', {}, p.transition_timeout_seconds * 1000);
  if (!(await isSleeping(ctx))) throw new Error('LLM did not enter CPU-resident sleep');
  for (let i = 0; i < 30 && (await vramUsedBytes(ctx)) > p.maximum_sleep_vram_gib * 2 ** 30; i++) {
    await pause(200);
  }
  if (
    (await vramUsedBytes(ctx)) > p.maximum_sleep_vram_gib * 2 ** 30 ||
    (await hostMemoryBytes(ctx)) < p.minimum_remaining_memory_gib * 2 ** 30
  ) {
    throw new Error('CPU residency exceeded memory budget');
  }
  return true;
}

export async function previewPlan(ctx) {
  const path =
    ctx?.kvPreviewPath ??
    join(ROOT, 'workspace', 'data', 'llm', 'paiton', 'runtime', 'qwen38', 'workbench-kv-plan.json');
  const plan = await readJsonFile(path, null, { ignoreInvalid: true });
  if (!plan || plan.version !== 2 || !plan.id || !plan.matrix || typeof plan.matrix !== 'object') {
    return null;
  }
  return { ...plan, preview_only: true };
}

export async function startupLogs(ctx, state) {
  try {
    const container = runtimeContainer(ctx);
    const id = await inspectContainer(ctx, '{{.Id}}', container);
    if (!id) return null;
    if (state.startupLog?.id === id && state.startupLog.complete) return state.startupLog;
    const path =
      ctx?.startupLogPath ??
      (ctx?.dataDir
        ? join(ctx.dataDir, 'llm-startup.json')
        : join(ROOT, 'workspace', 'data', 'scheduler', 'llm-startup.json'));
    const saved = await readJsonFile(path, null, { ignoreInvalid: true });
    if (saved && saved.id === id && saved.complete) {
      state.startupLog = saved;
      return saved;
    }
    const { stdout, stderr } = await readContainerLogs(ctx, { container, timestamps: true });
    const combined = (
      stdout && stderr && !stdout.endsWith('\n') ? stdout + '\n' + stderr : stdout + stderr
    ).replaceAll('\r\n', '\n');
    const lines = combined.split('\n').slice(0, 1500);
    const end = lines.findIndex((line) => line.includes('Application startup complete.'));
    const record = {
      id,
      complete: end >= 0,
      output: (end >= 0 ? lines.slice(0, end + 1) : lines).join('\n'),
    };
    state.startupLog = record;
    if (record.complete) {
      await writeJsonAtomic(path, record);
    }
    return record;
  } catch {
    return null;
  }
}

export async function readCapacity(ctx, state) {
  const container = runtimeContainer(ctx);
  const id = await inspectContainer(ctx, '{{.Id}}', container);
  if (!id) return null;
  if (state.capacityContainer === id && state.capacityTokens) return state.capacityTokens;
  state.capacityTokens = null;
  try {
    const { stdout, stderr } = await readContainerLogs(ctx, {
      container,
      tail: 3000,
      timestamps: false,
    });
    let matches = [...(stdout + '\n' + stderr).matchAll(/GPU KV cache size:\s*([\d,]+) tokens/g)];
    if (!matches.length) {
      const startup = await startupLogs(ctx, state);
      if (startup?.id === id) {
        matches = [...startup.output.matchAll(/GPU KV cache size:\s*([\d,]+) tokens/g)];
      }
    }
    if (matches.length) {
      state.capacityTokens = Number(matches.at(-1)[1].replaceAll(',', ''));
      state.capacityContainer = id;
    }
  } catch {}
  return state.capacityTokens;
}

export async function readStartupBudget(ctx, state) {
  const container = runtimeContainer(ctx);
  const id = await inspectContainer(ctx, '{{.Id}}', container);
  if (!id) return null;
  if (state.startupBudgetContainer === id && state.startupBudget) return state.startupBudget;
  state.startupBudget = null;
  state.startupBudgetContainer = null;
  try {
    const { stdout, stderr } = await readContainerLogs(ctx, {
      container,
      tail: 3000,
      timestamps: false,
    });
    const saved = await startupLogs(ctx, state);
    const text = (saved?.id === id ? saved.output + '\n' : '') + stdout + '\n' + stderr;
    const gib = (value) => Number.parseFloat(value.replaceAll(',', '')) * 2 ** 30;
    const weights = /Model loading took ([\d.]+) GiB/.exec(text);
    const free = /Initial free memory ([\d.]+) GiB/.exec(text);
    const graph = /Graph capturing finished in [\d.]+ secs, took ([\d.]+) GiB/.exec(text);
    if (weights && free) {
      state.startupBudget = {
        container: id,
        weights_bytes: gib(weights[1]),
        free_at_load_bytes: gib(free[1]),
        graph_capture_bytes: graph ? gib(graph[1]) : null,
        graph_monitored: !!graph,
      };
      state.startupBudgetContainer = id;
    }
  } catch {}
  return state.startupBudget ?? null;
}

export async function inspectPaitonMode(ctx, state) {
  if (isDockerDisabled(ctx)) {
    state.loadedMode = null;
    state.configuration = null;
    state.kvForecast = null;
    return null;
  }
  try {
    const container = runtimeContainer(ctx);
    const runtimeImages = await readJsonFile(
      ctx?.runtimeImagesPath ?? join(ROOT, 'workspace', 'config', 'runtime-images.json'),
      {},
    );
    const runtime = runtimeImages?.llm;
    const image = await inspectContainer(ctx, '{{.Config.Image}}', container);
    if (runtime?.image && image !== runtime.image) {
      state.loadedMode = null;
      return null;
    }
    const args = JSON.parse(await inspectContainer(ctx, '{{json .Config.Cmd}}', container));
    const context = args[args.indexOf('--max-model-len') + 1];
    const seqs = args[args.indexOf('--max-num-seqs') + 1];
    const kv = args[args.indexOf('--kv-cache-memory-bytes') + 1];
    const env = JSON.parse(await inspectContainer(ctx, '{{json .Config.Env}}', container));
    state.kvPlanId =
      env.find((value) => value.startsWith('WORKBENCH_KV_PLAN_ID='))?.split('=')[1] ?? null;
    state.kvForecast = null;
    if (state.kvPlanId) {
      const plan = await readJsonFile(
        ctx?.kvPreviewPath ??
          join(
            ROOT,
            'workspace',
            'data',
            'llm',
            'paiton',
            'runtime',
            'qwen38',
            'workbench-kv-plan.json',
          ),
        null,
        { ignoreInvalid: true },
      );
      if (
        plan &&
        plan.id === state.kvPlanId &&
        plan.context_tokens === Number(context) &&
        plan.concurrency === Number(seqs)
      ) {
        state.kvForecast = plan;
      }
    }
    state.configuration = {
      context_tokens: Number(context),
      concurrency: Number(seqs),
      kv_budget_bytes:
        args.includes('--kv-cache-memory-bytes') && Number(kv) > 0 ? Number(kv) : null,
      eager: args.includes('--enforce-eager'),
      lm_head: env.includes('PAITON_LMHEAD_W8=0') ? 'bf16' : null,
      prefix_caching:
        args.includes('--enable-prefix-caching') && !args.includes('--no-enable-prefix-caching'),
      mamba_cache_mode: args.includes('--mamba-cache-mode')
        ? args[args.indexOf('--mamba-cache-mode') + 1]
        : null,
    };
    state.configuration.pool_allocated_bytes = allocatedPoolBytes(
      state.kvForecast,
      state.configuration,
    );
    state.loadedMode =
      Number(kv) >= 2 ** 30 &&
      env.includes('PAITON_LMHEAD_W8=0') &&
      env.some((value) => value.startsWith('HIP_VISIBLE_DEVICES=')) &&
      !env.some((value) => value.split('=')[0] === 'CUDA_VISIBLE_DEVICES') &&
      env.includes('WORKBENCH_ROCM_HIP=1') &&
      env.includes('WORKBENCH_CONFIGURATION_VERSION=2') &&
      state.configuration.prefix_caching &&
      state.configuration.mamba_cache_mode === 'align' &&
      args[args.indexOf('--max-num-batched-tokens') + 1] ===
        (Number(context) <= 65536 ? '4096' : '1024') &&
      (Number(context) <= 65536
        ? !args.includes('--long-prefill-token-threshold') ||
          args[args.indexOf('--long-prefill-token-threshold') + 1] === '0'
        : args[args.indexOf('--long-prefill-token-threshold') + 1] === '512') &&
      env.includes('RADIANCE_GDN_LAZY=0')
        ? enginePolicyKey(
            servingPolicy(
              'custom',
              Number(context),
              Number(seqs),
              args.includes('--enforce-eager'),
              Number(kv),
            ),
          )
        : null;
    if (state.loadedMode) await readCapacity(ctx, state);
    if (state.loadedMode) {
      const budget = await readStartupBudget(ctx, state);
      if (budget) {
        Object.assign(state.configuration, {
          weights_bytes: budget.weights_bytes,
          free_at_load_bytes: budget.free_at_load_bytes,
          graph_capture_bytes: budget.graph_capture_bytes,
        });
      }
    }
  } catch {
    state.loadedMode = null;
    state.configuration = null;
    state.kvForecast = null;
  }
  return state.loadedMode;
}

export { containerStatus, enginePolicyKey };
