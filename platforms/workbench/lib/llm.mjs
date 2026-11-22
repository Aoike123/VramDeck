// Generic KV cache budget and VRAM forecast math shared with the Web Console draft preview.
// Engine-specific profiles, aliases, and reasoning defaults live in engine packages (e.g. engines/shared/paiton/client.mjs).

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

export function enginePolicyKey(policy) {
  return `${policy.context_tokens}:${policy.concurrency}:bf16:${
    policy.kv_budget_bytes ?? kvBudgetBytes(policy.context_tokens)
  }:${policy.eager ? 'eager' : 'graph'}`;
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

export function previewBudget(policy, contextTokens, concurrency, budget, pending = false) {
  const draft = { ...policy, context_tokens: contextTokens, concurrency };
  const matching =
    policy &&
    contextTokens === policy.context_tokens &&
    concurrency === policy.concurrency &&
    !pending;
  return policyBudget(
    draft,
    matching ? budget?.capacity_tokens : null,
    budget?.measured_policy ?? null,
  );
}

export function forecastBudget(
  policy,
  contextTokens,
  concurrency,
  budget,
  plan,
  pending = false,
  eager = policy?.eager ?? false,
  kvBytes = kvBudgetBytes(contextTokens),
  allocatedBytes,
  extras,
) {
  const draft = {
    ...policy,
    context_tokens: contextTokens,
    concurrency,
    eager,
    kv_budget_bytes: kvBytes,
  };
  const matching = policy && enginePolicyKey(draft) === enginePolicyKey(policy) && !pending;
  const result = policyBudget(
    draft,
    matching ? budget?.capacity_tokens : null,
    budget?.measured_policy ?? null,
  );
  const valid =
    plan?.version === 2 &&
    plan.context_tokens === policy?.context_tokens &&
    plan.concurrency === policy?.concurrency &&
    plan.eager === (policy?.eager ?? false) &&
    plan.kv_budget_bytes === policy?.kv_budget_bytes;
  const livePreview = valid ? planPreview(plan, contextTokens, concurrency, eager, kvBytes) : null;
  const savedPlan = extras?.preview_plan?.preview_only === true ? extras.preview_plan : null;
  const preview = livePreview ?? planPreview(savedPlan, contextTokens, concurrency, eager, kvBytes);
  const historical = !!preview && !livePreview;
  const vram = vramBudget({
    contextTokens,
    concurrency,
    eager,
    kvBytes,
    capacityTokens: result.capacity_tokens,
    allocatedPoolBytes: matching ? allocatedBytes : undefined,
    preview,
    extras: {
      ...extras,
      graph_capture_bytes: matching ? extras?.graph_capture_bytes : undefined,
      full_load_verified: !historical && matching && extras?.full_load_verified === true,
    },
  });
  const estimated = preview?.estimated_capacity_tokens ?? null;
  return {
    ...result,
    ...vram,
    source: historical && result.capacity_tokens == null ? 'historical-plan' : vram.source,
    preview_basis: historical ? 'historical-layout' : preview ? 'engine-layout' : null,
    estimated_capacity_tokens: estimated,
    estimated_capacity_margin_tokens: estimated == null ? null : estimated - result.demand_tokens,
    estimated_remaining_tokens: estimated == null ? null : estimated - result.demand_tokens,
    factors: preview
      ? {
          gdn: preview.gdn,
          prefill_tokens: preview.prefill_tokens,
          block_bytes: preview.block_bytes,
          pool_blocks: preview.pool_blocks,
        }
      : null,
  };
}
