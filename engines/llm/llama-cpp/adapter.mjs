import { readyEngine } from '../../../platforms/workbench/lib/engine-sdk.mjs';

function resolveLlamaBin() {
  return (
    process.env.VRAMDECK_LLAMA_BIN ||
    process.env.LLAMA_SERVER_BIN ||
    process.env.LLAMA_CPP_BIN ||
    'llama-server'
  );
}

export default {
  runtimeSpec() {
    return { command: resolveLlamaBin() };
  },

  async ready(ctx) {
    return readyEngine(ctx, '/health');
  },

  async idle(ctx) {
    try {
      const res = await fetch(`${ctx.base}/slots`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return true;
      const slots = await res.json();
      return Array.isArray(slots) ? slots.every((s) => !s.is_processing) : true;
    } catch {
      return true;
    }
  },

  models() {
    return [
      {
        id: 'llama-cpp',
        object: 'model',
        owned_by: 'llama.cpp',
        tasks: ['chat'],
        max_model_len: 32768,
        contextWindow: 32768,
        context_length: 32768,
        max_concurrent_requests: 2,
      },
    ];
  },

  resolveChatRequest(_ctx, body) {
    const model = String(body?.model ?? '');
    return model === 'llama-cpp' || model.startsWith('llama-cpp:');
  },

  prepareChat(_ctx, body) {
    if (!Array.isArray(body?.messages) || !body.messages.length) {
      throw new Error('messages required');
    }
    return {
      leaseOptions: { concurrency: 2 },
      responseHeaders: {},
      state: { upstreamModel: body.model },
    };
  },
};
