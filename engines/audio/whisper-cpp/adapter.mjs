import { readyEngine } from '../../../platforms/workbench/lib/engine-sdk.mjs';

export default {
  runtimeSpec() {
    return {
      command: process.env.VRAMDECK_WHISPER_BIN || process.env.WHISPER_CPP_BIN || 'whisper-server',
    };
  },

  async ready(ctx) {
    return readyEngine(ctx, '/health');
  },

  async idle() {
    return true;
  },
};
