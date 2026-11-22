import { readyEngine } from '../../../platforms/workbench/lib/engine-sdk.mjs';

export default {
  async ready(ctx) {
    return readyEngine(ctx, '/health');
  },

  async idle() {
    return true;
  },

  models() {
    return [
      {
        id: 'vllm-openai',
        object: 'model',
        owned_by: 'vllm',
        tasks: ['chat'],
        max_concurrent_requests: 4,
      },
    ];
  },

  resolveChatRequest(_ctx, body) {
    const model = String(body?.model ?? '');
    return model === 'vllm-openai' || model.startsWith('vllm:');
  },
};
