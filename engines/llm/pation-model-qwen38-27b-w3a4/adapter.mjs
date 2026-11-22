// Qwen3.8 27B W3A4 on vLLM. Chat is served by the gateway's OpenAI-compatible route; this adapter
// covers the engine lifecycle: CPU residency instead of unloading, policy-driven launch arguments,
// OpenAI chat validation/budget hooks, and verification that the loaded engine matches the policy.
import { join } from 'node:path';
import {
  call,
  containerStatus,
  enginePolicyKey,
  listRunningContainers,
  readJsonFile,
  readyEngine,
  stopEngine,
  writeJsonAtomic,
} from '../../../platforms/workbench/lib/engine-sdk.mjs';
import {
  KV_CALIBRATION,
  LLM_DEFAULT_REASONING_EFFORT,
  LLM_REASONING_EFFORTS,
  VRAM_DEFAULTS,
  activeModelId,
  completionBudget,
  createPaitonState,
  inspectPaitonMode,
  isResidentLabelled,
  isSleeping,
  llmProfile,
  policyBudget,
  previewPlan,
  readResidencyConfig,
  reasoningEffort,
  servingPolicy,
  sleepResidency,
  startupLogs,
} from '../../shared/paiton/client.mjs';

const counted = (text, metric) => [
  ...text.matchAll(new RegExp('^vllm:' + metric + '(?:\\{[^\\n]*\\})?\\s+([\\d.eE+-]+)', 'gm')),
];

export function createQwen38Adapter(initialMode = 'long') {
  const state = createPaitonState(initialMode);

  const policyFile = (ctx) => (ctx?.dataDir ? join(ctx.dataDir, 'llm-mode.json') : null);

  return {
    state,

    async init(ctx) {
      const file = policyFile(ctx);
      let loaded = false;
      if (file) {
        const saved = await readJsonFile(file, null, { ignoreInvalid: true });
        if (saved?.mode) {
          try {
            state.policy = servingPolicy(
              saved.mode,
              saved.policy?.context_tokens,
              saved.policy?.concurrency,
              saved.policy?.eager,
              saved.policy?.kv_budget_bytes,
            );
            state.selectedMode = saved.mode;
            loaded = true;
          } catch {
            loaded = false;
          }
        }
      }
      if (!loaded) {
        state.selectedMode = 'throughput';
        state.policy = servingPolicy('throughput');
      }
      await inspectPaitonMode(ctx, state).catch(() => null);
    },

    async idle(ctx) {
      const r = await fetch(ctx.base + '/metrics', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return false;
      const text = await r.text();
      return ['num_requests_running', 'num_requests_waiting'].every((metric) => {
        const values = counted(text, metric);
        return values.length > 0 && values.every((v) => Number(v[1]) === 0);
      });
    },

    async ready(ctx) {
      if (await isSleeping(ctx)) return false;
      return (await fetch(ctx.base + '/health', { signal: AbortSignal.timeout(5000) })).ok;
    },

    parked: (ctx) => isSleeping(ctx),

    matches: async (ctx, policy) =>
      (await inspectPaitonMode(ctx, state)) === enginePolicyKey(policy ?? state.policy),

    async park(ctx, report) {
      report?.('unloading', '将 Qwen 权重迁移到 CPU');
      try {
        const preserved = await sleepResidency(ctx);
        if (preserved) report?.('unloading', 'Qwen 权重已保留在 CPU');
        return preserved;
      } catch (e) {
        report?.('unloading', `CPU 保留失败，改为释放容器：${e.message}`);
        return false;
      }
    },

    async resume(ctx, policy, report) {
      const targetPolicy = policy ?? state.policy;
      if (
        (await isSleeping(ctx)) &&
        (await inspectPaitonMode(ctx, state)) === enginePolicyKey(targetPolicy)
      ) {
        report?.('loading', '从 CPU 唤醒 Qwen 权重');
        try {
          const cfg = await readResidencyConfig(ctx);
          await call(ctx.base, '/wake_up', {}, cfg.transition_timeout_seconds * 1000);
          if (!(await isSleeping(ctx)) && (await readyEngine(ctx))) return true;
        } catch (e) {
          report?.('loading', `唤醒失败，改为冷启动：${e.message}`);
        }
        await stopEngine(ctx);
      }
      const running = await listRunningContainers(ctx);
      if ((await isResidentLabelled(ctx)) || running.includes(ctx.runtime?.container)) {
        await stopEngine(ctx);
      }
      return false;
    },

    launchArgs: (_ctx, policy) => {
      const p = policy ?? state.policy;
      return [
        '--context',
        String(p.context_tokens),
        '--max-num-seqs',
        String(p.concurrency),
        '--kv-cache-memory-bytes',
        String(p.kv_budget_bytes),
        '--lm-head',
        'bf16',
        '--eager-mode',
        p.eager ? 'on' : 'off',
      ];
    },

    launchEnv: (_ctx, { cold } = {}) => (cold ? { LAB_LLM_RESIDENCY_DISABLE: '1' } : {}),

    async startupCheck(ctx) {
      if (
        (await isResidentLabelled(ctx)) &&
        !['running', 'created'].includes(await containerStatus(ctx))
      ) {
        throw new Error('Resident LLM exited during startup');
      }
    },

    async verify(ctx, policy) {
      const targetPolicy = policy ?? state.policy;
      if ((await inspectPaitonMode(ctx, state)) !== enginePolicyKey(targetPolicy)) {
        throw new Error('LLM started with an unexpected context or concurrency configuration');
      }
    },

    retryCold: async (ctx) => Boolean((await readResidencyConfig(ctx)).enabled),

    onStop() {
      state.loadedMode = null;
      state.capacityTokens = null;
      state.capacityContainer = null;
      state.configuration = null;
      state.kvForecast = null;
    },

    startupLogs: (ctx) => startupLogs(ctx, state),

    models() {
      const id = activeModelId(state.policy);
      const profile = llmProfile(id);
      return [
        {
          id,
          object: 'model',
          owned_by: 'local-workbench',
          tasks: ['chat'],
          max_model_len: state.policy.context_tokens,
          contextWindow: state.policy.context_tokens,
          context_length: state.policy.context_tokens,
          inputModalities: ['text', 'image'],
          input: ['text', 'image'],
          max_concurrent_requests: state.policy.concurrency,
          mode: state.selectedMode,
          vision: profile.vision,
          vision_device: profile.visionDevice,
          reasoning: true,
          reasoningEfforts: LLM_REASONING_EFFORTS,
          default_reasoning_effort: LLM_DEFAULT_REASONING_EFFORT,
          compat: { supportsReasoningEffort: true },
        },
      ];
    },

    resolveChatRequest(_ctx, body) {
      return Boolean(llmProfile(body?.model));
    },

    prepareChat(_ctx, body) {
      const baseProfile = llmProfile(body?.model);
      if (!baseProfile) throw new Error('Choose an LLM model from /v1/models');
      const profile = {
        ...baseProfile,
        mode: enginePolicyKey(state.policy),
        maxModelLen: state.policy.context_tokens,
        limit: state.policy.concurrency,
      };
      if (!Array.isArray(body?.messages) || !body.messages.length) {
        throw new Error('messages required');
      }
      let effort = reasoningEffort(body.reasoning_effort);
      if (
        !profile.vision &&
        body.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type !== 'text'),
        )
      ) {
        throw new Error('The eight-way model supports text only');
      }
      const output = body.max_completion_tokens ?? body.max_tokens;
      if (
        output !== undefined &&
        (!Number.isInteger(output) || output < 1 || output > profile.maxModelLen)
      ) {
        throw new Error('Invalid output token limit');
      }
      if (effort === 'high') effort = 'xhigh';
      return {
        leaseOptions: {
          concurrency: state.policy.concurrency,
          modeKey: enginePolicyKey(state.policy),
          slot: profile.slot,
          policy: state.policy,
        },
        responseHeaders: { 'X-Reasoning-Effort': effort },
        state: { profile, effort, upstreamModel: 'qwen38-27b-w3a4' },
      };
    },

    async beforeChat(ctx, body, { prepared, reserveBudget }) {
      const { profile, effort, upstreamModel } = prepared.state;
      const payload = {
        ...body,
        model: upstreamModel,
        reasoning_effort: effort,
        chat_template_kwargs: {
          ...body.chat_template_kwargs,
          enable_thinking: effort !== 'none',
          reasoning_effort: effort,
        },
      };
      const tokens = await call(
        ctx.base,
        '/tokenize',
        { ...payload, add_generation_prompt: true },
        120000,
      );
      try {
        payload.max_tokens = completionBudget(body, profile, tokens.count);
      } catch (e) {
        e.status = 400;
        throw e;
      }
      delete payload.max_completion_tokens;
      await reserveBudget(tokens.count + payload.max_tokens, state.capacityTokens);
      if (body.stream) {
        payload.stream_options = {
          ...body.stream_options,
          include_usage: body.stream_options?.include_usage ?? true,
        };
      }
      return payload;
    },

    validatePolicy(d = {}) {
      return servingPolicy(d.mode, d.context_tokens, d.concurrency, d.eager, d.kv_budget_bytes);
    },

    async reconfigure(ctx, policy) {
      const file = policyFile(ctx);
      if (file) {
        await writeJsonAtomic(file, { mode: policy.mode, policy });
      }
      state.policy = policy;
      state.selectedMode = policy.mode;
      return {
        mode: policy.mode,
        policy,
        budget: policyBudget(policy, state.capacityTokens),
      };
    },

    acquireOptions(_ctx, d = {}) {
      const slot =
        d.slot ??
        (state.selectedMode === 'throughput'
          ? '64k'
          : state.selectedMode === 'long-single'
            ? '256k'
            : '192k');
      return {
        concurrency: state.policy.concurrency,
        modeKey: enginePolicyKey(state.policy),
        slot,
        policy: state.policy,
      };
    },

    async policyState(ctx, { preview = false } = {}) {
      const kvPreviewPlan = preview ? await previewPlan(ctx) : null;
      return {
        selected_mode: state.selectedMode,
        policy: state.policy,
        engine_config: state.configuration,
        kv_forecast: state.kvForecast,
        kv_preview_plan: kvPreviewPlan,
        kv_budget: policyBudget(state.policy, state.capacityTokens, state.loadedMode),
        loaded_mode: state.loadedMode,
        active_model_id: activeModelId(state.policy),
        capacity_tokens: state.capacityTokens,
        capacity_container: state.capacityContainer ?? state.startupLog?.id ?? null,
        slots: ['192k', '256k', '64k'],
        kv_calibration: KV_CALIBRATION,
        vram_defaults: VRAM_DEFAULTS,
      };
    },

    async residencyStatus(ctx) {
      const cfg = await readResidencyConfig(ctx);
      const stateLabel = cfg.enabled
        ? (await isSleeping(ctx))
          ? 'cpu'
          : (await isResidentLabelled(ctx))
            ? 'gpu'
            : 'cold'
        : 'cold';
      return {
        enabled: cfg.enabled,
        models: cfg.models ?? ['llm'],
        state: stateLabel,
      };
    },
  };
}

export default createQwen38Adapter();
