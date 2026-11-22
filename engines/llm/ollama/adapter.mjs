import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const stripPrefix = (name) => (name.startsWith('ollama:') ? name.slice('ollama:'.length) : name);

async function writeJson(res, status, payload) {
  if (res.destroyed) return;
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

async function writeSse(res, chunk) {
  if (res.destroyed) return false;
  if (!res.write(chunk)) {
    await Promise.race([once(res, 'drain'), once(res, 'close')]);
  }
  return !res.destroyed;
}

async function listLiveModels(base) {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json.models)) return [];
    return json.models.map((m) => String(m.name ?? m.model ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export default {
  async ready(ctx) {
    const targetPath = ctx.runtime?.health_path ?? '/api/tags';
    const res = await fetch(`${ctx.base}${targetPath}`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    return Boolean(res?.ok);
  },

  async idle() {
    return true;
  },

  async models(ctx) {
    const names = await listLiveModels(ctx.base);
    if (names.length > 0) {
      return names.map((name) => ({
        id: name,
        object: 'model',
        owned_by: 'ollama',
        tasks: ['chat'],
        max_concurrent_requests: 2,
      }));
    }
    return [
      {
        id: 'ollama-chat',
        object: 'model',
        owned_by: 'ollama',
        tasks: ['chat'],
        max_concurrent_requests: 2,
      },
    ];
  },

  async resolveChatRequest(ctx, body) {
    const model = String(body?.model ?? '').trim();
    if (!model) return false;
    if (model === 'ollama-chat' || model.startsWith('ollama:')) return true;
    const live = await listLiveModels(ctx.base);
    return live.includes(model) || live.includes(stripPrefix(model));
  },

  beforeChat(_ctx, body) {
    const model = String(body?.model ?? '');
    return {
      ...body,
      model: stripPrefix(model),
    };
  },

  async chat(ctx, payload, { res, stream, requestedModel, signal }) {
    const targetBase = String(ctx.base).replace(/\/$/, '');
    const responseModel = requestedModel ?? payload.model;

    const upstream = await fetch(`${targetBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (upstream.status !== 404) {
      if (!upstream.ok) {
        const errPayload = await upstream.json().catch(async () => ({
          error: await upstream.text().catch(() => `Upstream HTTP ${upstream.status}`),
        }));
        await writeJson(res, upstream.status, errPayload);
        return true;
      }
      if (stream && upstream.body) {
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.flushHeaders?.();
        for await (const chunk of upstream.body) {
          if (!(await writeSse(res, Buffer.from(chunk).toString('utf8')))) break;
        }
        if (!res.destroyed) res.end();
        return true;
      }
      const json = await upstream.json();
      json.model = responseModel;
      await writeJson(res, upstream.status, json);
      return true;
    }

    const apiRes = await fetch(`${targetBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: stripPrefix(String(payload.model ?? '')),
        messages: payload.messages,
        stream: Boolean(stream),
      }),
      signal,
    });

    if (!apiRes.ok) {
      const errPayload = await apiRes.json().catch(async () => ({
        error: await apiRes.text().catch(() => `Ollama HTTP ${apiRes.status}`),
      }));
      await writeJson(res, apiRes.status, errPayload);
      return true;
    }

    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      const ollamaJson = await apiRes.json();
      await writeJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            message: {
              role: ollamaJson.message?.role ?? 'assistant',
              content: ollamaJson.message?.content ?? ollamaJson.response ?? '',
            },
            finish_reason: 'stop',
          },
        ],
      });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.flushHeaders?.();

    const decoder = new TextDecoder('utf-8');
    let lineBuffer = '';
    const emitLine = async (rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return true;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return true;
      }
      const deltaContent = parsed.message?.content ?? parsed.response ?? '';
      const frame = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            delta: deltaContent ? { content: deltaContent } : {},
            finish_reason: parsed.done ? 'stop' : null,
          },
        ],
      };
      return writeSse(res, `data: ${JSON.stringify(frame)}\n\n`);
    };

    if (apiRes.body) {
      for await (const rawChunk of apiRes.body) {
        if (res.destroyed) break;
        lineBuffer += decoder.decode(Buffer.from(rawChunk), { stream: true });
        let nlIdx = lineBuffer.indexOf('\n');
        while (nlIdx >= 0) {
          const line = lineBuffer.slice(0, nlIdx);
          lineBuffer = lineBuffer.slice(nlIdx + 1);
          if (!(await emitLine(line))) break;
          nlIdx = lineBuffer.indexOf('\n');
        }
      }
    }
    lineBuffer += decoder.decode();
    if (lineBuffer.trim() && !res.destroyed) {
      await emitLine(lineBuffer);
    }
    if (!res.destroyed) {
      await writeSse(res, 'data: [DONE]\n\n');
      if (!res.destroyed) res.end();
    }
    return true;
  },
};
