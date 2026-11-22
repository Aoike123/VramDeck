import { readyEngine } from '../../../platforms/workbench/lib/engine-sdk.mjs';

export default {
  runtimeSpec() {
    return {
      command: process.env.VRAMDECK_KOKORO_BIN || process.env.KOKORO_BIN || 'kokoro-server',
    };
  },

  async ready(ctx) {
    return readyEngine(ctx, '/health');
  },

  async idle() {
    return true;
  },
};
