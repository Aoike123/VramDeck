import { pause } from '../../../platforms/workbench/lib/engine-sdk.mjs';

export default {
  async ready(ctx) {
    const targetPath = ctx.runtime?.health_path ?? '/system_stats';
    const res = await fetch(`${ctx.base}${targetPath}`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    return Boolean(res?.ok);
  },

  async idle(ctx) {
    try {
      const res = await fetch(`${ctx.base}/queue`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return true;
      const data = await res.json();
      const running = Array.isArray(data.queue_running) ? data.queue_running.length : 0;
      return running === 0;
    } catch {
      return true;
    }
  },

  async interrupt(ctx) {
    if (!ctx?.base) return;
    await fetch(`${ctx.base}/interrupt`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  },

  payload(_capability, input) {
    return {
      prompt: input.prompt,
      seed: input.seed ?? 42,
      ...(input.negative_prompt !== undefined ? { negative_prompt: input.negative_prompt } : {}),
    };
  },

  effective(capability, input) {
    return {
      seed: input.seed ?? 42,
      mode: capability === 'image.edit' ? 'image-to-image' : 'text-to-image',
    };
  },

  async execute(_capability, d, { base, onSubmitted }) {
    const started = performance.now();
    const targetBase = String(base).replace(/\/$/, '');
    const graph = {
      1: { class_type: 'CLIPTextEncode', inputs: { text: String(d.prompt ?? '') } },
      9: { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    };

    const submitRes = await fetch(`${targetBase}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph }),
      signal: AbortSignal.timeout(15000),
    }).catch((err) => {
      throw Object.assign(new Error(`ComfyUI prompt request failed: ${err.message}`), {
        code: 'NOT_SUBMITTED',
      });
    });

    if (!submitRes.ok) {
      throw Object.assign(new Error(`ComfyUI rejected prompt (${submitRes.status})`), {
        code: submitRes.status >= 500 ? 'BACKEND_FAILED' : 'NOT_SUBMITTED',
      });
    }

    const submitted = await submitRes.json();
    const promptId = submitted?.prompt_id;
    if (!promptId) {
      throw Object.assign(new Error('ComfyUI response missing prompt_id'), {
        code: 'NOT_SUBMITTED',
      });
    }

    await onSubmitted?.({ prompt_id: promptId });

    const deadline = Date.now() + 60_000;
    let historyEntry = null;
    while (Date.now() < deadline) {
      const histRes = await fetch(`${targetBase}/history/${encodeURIComponent(promptId)}`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (histRes?.ok) {
        const histJson = await histRes.json();
        if (histJson?.[promptId]) {
          historyEntry = histJson[promptId];
          break;
        }
      }
      await pause(50);
    }

    if (!historyEntry) {
      throw Object.assign(new Error('ComfyUI execution timed out awaiting history'), {
        code: 'BACKEND_FAILED',
      });
    }
    if (historyEntry.status?.status_str === 'error') {
      throw Object.assign(new Error('ComfyUI execution failed'), { code: 'BACKEND_FAILED' });
    }

    let imageMeta = null;
    for (const node of Object.values(historyEntry.outputs ?? {})) {
      const first = node?.images?.[0];
      if (first?.filename) {
        imageMeta = first;
        break;
      }
    }
    if (!imageMeta) {
      throw Object.assign(new Error('ComfyUI returned no image outputs'), {
        code: 'BACKEND_FAILED',
      });
    }

    const viewParams = new URLSearchParams({
      filename: imageMeta.filename,
      subfolder: imageMeta.subfolder ?? '',
      type: imageMeta.type ?? 'output',
    });
    const viewRes = await fetch(`${targetBase}/view?${viewParams.toString()}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!viewRes.ok) {
      throw Object.assign(new Error(`ComfyUI image download failed (${viewRes.status})`), {
        code: 'BACKEND_FAILED',
      });
    }
    const bytes = Buffer.from(await viewRes.arrayBuffer());
    return {
      data: [{ b64_json: bytes.toString('base64') }],
      metrics: {
        prompt_id: promptId,
        generation_seconds: (performance.now() - started) / 1000,
      },
    };
  },
};
