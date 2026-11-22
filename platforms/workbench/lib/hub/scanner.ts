import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import type { EngineAdapter, EngineAdapterContext, EngineManifestV2 } from '../types.ts';

export interface DiscoveredService {
  kind: 'ollama' | 'comfyui' | 'llama-server' | 'lm-studio';
  name: string;
  url: string;
  base_url: string;
  port: number;
  models: string[];
  healthy: boolean;
}

export interface ScanTarget {
  kind?: string;
  url?: string;
  base_url?: string;
  port?: number;
}

export interface ScanLocalServicesOptions {
  targets?: ScanTarget[];
  ports?: number[];
  urls?: string[];
  timeoutMs?: number;
}

export interface AdoptServiceOptions {
  id?: string;
  name?: string;
  enabled?: boolean;
  enginesDir?: string;
  dataDir?: string;
  sdkImportPath?: string;
}

const DEFAULT_SCAN_TARGETS: readonly ScanTarget[] = [
  { kind: 'ollama', port: 11434, url: 'http://127.0.0.1:11434' },
  { kind: 'comfyui', port: 8188, url: 'http://127.0.0.1:8188' },
  { kind: 'llama-server', port: 8080, url: 'http://127.0.0.1:8080' },
  { kind: 'lm-studio', port: 1234, url: 'http://127.0.0.1:1234' },
];

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, file);
  } catch {
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function fetchJsonSafe(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, json: null };
    }
    const text = await res.text();
    if (!text.trim()) {
      return { ok: true, status: res.status, json: {} };
    }
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, status: res.status, json: null };
    }
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

function normalizeBaseUrl(rawUrl: string): { baseUrl: string; port: number } | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    const clean =
      `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(
        /\/$/,
        '',
      );
    return { baseUrl: clean, port };
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function probeTarget(
  target: ScanTarget,
  timeoutMs: number,
): Promise<DiscoveredService | null> {
  const rawUrl =
    target.url ??
    target.base_url ??
    (Number.isInteger(target.port) && (target.port ?? 0) > 0
      ? `http://127.0.0.1:${target.port}`
      : '');
  const normalized = normalizeBaseUrl(rawUrl);
  if (!normalized) return null;

  const { baseUrl, port } = normalized;
  const hint = String(target.kind ?? '').toLowerCase();

  // Check ComfyUI first when hinted or as fallback
  const tryComfy = async (): Promise<DiscoveredService | null> => {
    const stats = await fetchJsonSafe(`${baseUrl}/system_stats`, timeoutMs);
    if (!stats.ok || !isPlainObject(stats.json)) return null;
    return {
      kind: 'comfyui',
      name: 'ComfyUI (Local)',
      url: baseUrl,
      base_url: baseUrl,
      port,
      models: [],
      healthy: true,
    };
  };

  // Check Ollama (/api/tags)
  const tryOllama = async (): Promise<DiscoveredService | null> => {
    const tags = await fetchJsonSafe(`${baseUrl}/api/tags`, timeoutMs);
    if (!tags.ok || !isPlainObject(tags.json) || !Array.isArray(tags.json.models)) return null;
    const models = (tags.json.models as Array<Record<string, unknown>>)
      .map((m) => String(m.name ?? m.model ?? m.id ?? '').trim())
      .filter(Boolean);
    return {
      kind: 'ollama',
      name: 'Ollama (Local)',
      url: baseUrl,
      base_url: baseUrl,
      port,
      models,
      healthy: true,
    };
  };

  // Check OpenAI / LM Studio (/v1/models) and llama-server (/props, /health)
  const tryLlama = async (): Promise<DiscoveredService | null> => {
    const propsRes = await fetchJsonSafe(`${baseUrl}/props`, timeoutMs);
    const healthRes = propsRes.ok ? null : await fetchJsonSafe(`${baseUrl}/health`, timeoutMs);
    const healthyProps = propsRes.ok && isPlainObject(propsRes.json);
    const healthyStatus =
      healthRes?.ok &&
      isPlainObject(healthRes.json) &&
      (healthRes.json.status === 'ok' || healthRes.json.status === 'ready');
    if (!healthyProps && !healthyStatus) return null;

    const modelsRes = await fetchJsonSafe(`${baseUrl}/v1/models`, timeoutMs);
    const models =
      modelsRes.ok && isPlainObject(modelsRes.json) && Array.isArray(modelsRes.json.data)
        ? (modelsRes.json.data as Array<Record<string, unknown>>)
            .map((m) => String(m.id ?? m.name ?? '').trim())
            .filter(Boolean)
        : [];
    return {
      kind: 'llama-server',
      name: 'llama.cpp Server',
      url: baseUrl,
      base_url: baseUrl,
      port,
      models,
      healthy: true,
    };
  };

  const tryOpenAiCompatible = async (): Promise<DiscoveredService | null> => {
    const modelsRes = await fetchJsonSafe(`${baseUrl}/v1/models`, timeoutMs);
    if (!modelsRes.ok || !isPlainObject(modelsRes.json) || !Array.isArray(modelsRes.json.data)) {
      return null;
    }
    const models = (modelsRes.json.data as Array<Record<string, unknown>>)
      .map((m) => String(m.id ?? m.name ?? '').trim())
      .filter(Boolean);
    const kind = hint.includes('llama') ? 'llama-server' : 'lm-studio';
    return {
      kind,
      name: kind === 'llama-server' ? 'llama.cpp Server' : 'LM Studio / OpenAI Compatible',
      url: baseUrl,
      base_url: baseUrl,
      port,
      models,
      healthy: true,
    };
  };

  const probes =
    hint === 'comfyui'
      ? [tryComfy]
      : hint === 'ollama'
        ? [tryOllama]
        : hint.includes('llama')
          ? [tryLlama, tryOpenAiCompatible]
          : hint.includes('studio') || hint.includes('openai')
            ? [tryOpenAiCompatible, tryLlama]
            : [tryOllama, tryComfy, tryLlama, tryOpenAiCompatible];

  for (const probe of probes) {
    const result = await probe();
    if (result) return result;
  }
  return null;
}

export async function scanLocalServices(
  options: ScanLocalServicesOptions = {},
): Promise<DiscoveredService[]> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 1500;
  const candidates: ScanTarget[] = [];
  const seenUrls = new Set<string>();

  const pushTarget = (target: ScanTarget) => {
    const raw =
      target.url ??
      target.base_url ??
      (Number.isInteger(target.port) && (target.port ?? 0) > 0
        ? `http://127.0.0.1:${target.port}`
        : '');
    const norm = normalizeBaseUrl(raw);
    if (!norm) return;
    if (seenUrls.has(norm.baseUrl)) return;
    seenUrls.add(norm.baseUrl);
    candidates.push({ ...target, url: norm.baseUrl, port: norm.port });
  };

  for (const t of options.targets ?? []) pushTarget(t);
  for (const u of options.urls ?? []) pushTarget({ url: u });
  for (const p of options.ports ?? []) {
    const hint =
      p === 11434
        ? 'ollama'
        : p === 8188
          ? 'comfyui'
          : p === 8080
            ? 'llama-server'
            : p === 1234
              ? 'lm-studio'
              : undefined;
    pushTarget({ kind: hint, port: p, url: `http://127.0.0.1:${p}` });
  }

  const envUrls = (process.env.WORKBENCH_HUB_SCAN_URLS ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const u of envUrls) pushTarget({ url: u });

  if (
    !options.targets?.length &&
    !options.urls?.length &&
    !options.ports?.length &&
    !envUrls.length
  ) {
    for (const def of DEFAULT_SCAN_TARGETS) pushTarget(def);
  }

  const results = await Promise.all(candidates.map((target) => probeTarget(target, timeoutMs)));
  return results.filter((entry): entry is DiscoveredService => entry !== null);
}

export const scanServices = scanLocalServices;
export const scan = scanLocalServices;

function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned.includes('..')) return 'external-service';
  return cleaned;
}

async function writeHttpJson(res: ServerResponse, status: number, payload: unknown): Promise<void> {
  if (res.destroyed) return;
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

async function writeSseLine(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.destroyed) return false;
  if (!res.write(chunk)) {
    await Promise.race([once(res, 'drain'), once(res, 'close')]);
  }
  return !res.destroyed;
}

interface ComfyHistoryEntry {
  status?: { status_str?: string };
  outputs?: Record<
    string,
    { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }
  >;
}

async function* readWebStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function createComfyAdoptedAdapter(baseUrl: string): EngineAdapter {
  const resolveBase = (ctx?: Partial<EngineAdapterContext>) =>
    (ctx?.base ?? baseUrl).replace(/\/$/, '');

  return {
    async ready(ctx) {
      const targetPath = ctx.runtime?.health_path ?? '/system_stats';
      const res = await fetch(`${resolveBase(ctx)}${targetPath}`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      return Boolean(res?.ok);
    },

    async idle(ctx) {
      try {
        const res = await fetch(`${resolveBase(ctx)}/queue`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return true;
        const data = (await res.json()) as { queue_running?: unknown[] };
        return !Array.isArray(data.queue_running) || data.queue_running.length === 0;
      } catch {
        return true;
      }
    },

    async interrupt(ctx) {
      await fetch(`${resolveBase(ctx)}/interrupt`, {
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

    async execute(_capability, d, ctx) {
      const started = performance.now();
      const targetBase = resolveBase(ctx);
      const graph = {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: String(d.prompt ?? '') } },
        '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      };

      const submitRes = await fetch(`${targetBase}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph }),
        signal: AbortSignal.timeout(15000),
      }).catch((err: unknown) => {
        throw Object.assign(new Error(`ComfyUI prompt request failed: ${(err as Error).message}`), {
          code: 'NOT_SUBMITTED',
        });
      });

      if (!submitRes.ok) {
        throw Object.assign(new Error(`ComfyUI rejected prompt (${submitRes.status})`), {
          code: submitRes.status >= 500 ? 'BACKEND_FAILED' : 'NOT_SUBMITTED',
        });
      }

      const submitted = (await submitRes.json()) as { prompt_id?: string };
      const promptId = submitted.prompt_id;
      if (!promptId) {
        throw Object.assign(new Error('ComfyUI response missing prompt_id'), {
          code: 'NOT_SUBMITTED',
        });
      }

      await ctx.onSubmitted?.({ prompt_id: promptId });

      const deadline = Date.now() + 60_000;
      let historyEntry: ComfyHistoryEntry | null = null;

      while (Date.now() < deadline) {
        const histRes = await fetch(`${targetBase}/history/${encodeURIComponent(promptId)}`, {
          signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        if (histRes?.ok) {
          const histJson = (await histRes.json()) as Record<string, ComfyHistoryEntry | undefined>;
          const found = histJson[promptId];
          if (found) {
            historyEntry = found;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      if (!historyEntry) {
        throw Object.assign(new Error('ComfyUI execution timed out awaiting history'), {
          code: 'BACKEND_FAILED',
        });
      }
      if (historyEntry.status?.status_str === 'error') {
        throw Object.assign(new Error('ComfyUI execution failed'), { code: 'BACKEND_FAILED' });
      }

      let imageMeta: { filename: string; subfolder?: string; type?: string } | null = null;
      for (const node of Object.values(historyEntry.outputs ?? {})) {
        const first = node?.images?.[0];
        if (first?.filename) {
          imageMeta = { filename: first.filename, subfolder: first.subfolder, type: first.type };
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
      } as unknown as { data: unknown[] };
    },
  };
}

function createOllamaAdoptedAdapter(options: {
  id: string;
  baseUrl: string;
  models: string[];
}): EngineAdapter {
  const cachedModels = new Set(options.models);
  const stripPrefix = (name: string) =>
    name.startsWith('ollama:') ? name.slice('ollama:'.length) : name;

  const listOllamaModels = async (base: string): Promise<string[]> => {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) }).catch(
      () => null,
    );
    if (!res?.ok) return [...cachedModels];
    const json = (await res.json().catch(() => null)) as {
      models?: Array<{ name?: string; model?: string }>;
    } | null;
    if (!Array.isArray(json?.models)) return [...cachedModels];
    const names = json.models.map((m) => String(m.name ?? m.model ?? '').trim()).filter(Boolean);
    for (const n of names) cachedModels.add(n);
    return names.length ? names : [...cachedModels];
  };

  return {
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
      const names = await listOllamaModels(ctx.base);
      const effective = names.length ? names : [options.id];
      return effective.map((name) => ({
        id: name,
        object: 'model',
        owned_by: options.id,
        tasks: ['chat'],
        max_concurrent_requests: 4,
      }));
    },

    async resolveChatRequest(ctx, body) {
      const raw = String(body?.model ?? '').trim();
      if (!raw) return false;
      const normalized = stripPrefix(raw);
      if (normalized === options.id || cachedModels.has(normalized) || cachedModels.has(raw)) {
        return true;
      }
      const live = await listOllamaModels(ctx.base);
      return live.includes(normalized) || live.includes(raw);
    },

    async beforeChat(_ctx, body) {
      const raw = String(body?.model ?? '');
      return {
        ...body,
        model: stripPrefix(raw),
      };
    },

    async chat(ctx, payload, { res, stream, requestedModel, signal }) {
      const httpRes = res as ServerResponse;
      const targetBase = ctx.base.replace(/\/$/, '');
      const responseModel = requestedModel ?? String(payload.model ?? options.id);

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
          await writeHttpJson(httpRes, upstream.status, errPayload);
          return true;
        }
        if (stream && upstream.body) {
          httpRes.writeHead(upstream.status, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          httpRes.flushHeaders?.();
          const sseDecoder = new TextDecoder('utf-8');
          for await (const chunk of readWebStream(upstream.body)) {
            if (!(await writeSseLine(httpRes, sseDecoder.decode(chunk, { stream: true })))) break;
          }
          const trailing = sseDecoder.decode();
          if (trailing && !httpRes.destroyed) await writeSseLine(httpRes, trailing);
          if (!httpRes.destroyed) httpRes.end();
          return true;
        }
        const json = (await upstream.json()) as Record<string, unknown>;
        json.model = responseModel;
        await writeHttpJson(httpRes, upstream.status, json);
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
        await writeHttpJson(httpRes, apiRes.status, errPayload);
        return true;
      }

      const completionId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      if (!stream) {
        const ollamaJson = (await apiRes.json()) as {
          message?: { role?: string; content?: string };
          response?: string;
        };
        await writeHttpJson(httpRes, 200, {
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

      httpRes.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      httpRes.flushHeaders?.();

      const decoder = new TextDecoder('utf-8');
      let lineBuffer = '';

      const emitNdjsonLine = async (rawLine: string): Promise<boolean> => {
        const trimmed = rawLine.trim();
        if (!trimmed) return true;
        let parsed: {
          message?: { content?: string };
          response?: string;
          done?: boolean;
          error?: string;
        };
        try {
          parsed = JSON.parse(trimmed) as typeof parsed;
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
        return writeSseLine(httpRes, `data: ${JSON.stringify(frame)}\n\n`);
      };

      if (apiRes.body) {
        for await (const rawChunk of readWebStream(apiRes.body)) {
          if (httpRes.destroyed) break;
          lineBuffer += decoder.decode(rawChunk, { stream: true });
          let nlIdx = lineBuffer.indexOf('\n');
          while (nlIdx >= 0) {
            const line = lineBuffer.slice(0, nlIdx);
            lineBuffer = lineBuffer.slice(nlIdx + 1);
            if (!(await emitNdjsonLine(line))) break;
            nlIdx = lineBuffer.indexOf('\n');
          }
        }
      }
      lineBuffer += decoder.decode();
      if (lineBuffer.trim() && !httpRes.destroyed) {
        await emitNdjsonLine(lineBuffer);
      }
      if (!httpRes.destroyed) {
        await writeSseLine(httpRes, 'data: [DONE]\n\n');
        if (!httpRes.destroyed) httpRes.end();
      }
      return true;
    },
  };
}

function createOpenAiExternalAdapter(options: { id: string; models: string[] }): EngineAdapter {
  const cachedModels = new Set(options.models);

  const listOpenAiModels = async (base: string): Promise<string[]> => {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) }).catch(
      () => null,
    );
    if (!res?.ok) return [...cachedModels];
    const json = (await res.json().catch(() => null)) as {
      data?: Array<{ id?: string; name?: string }>;
    } | null;
    if (!Array.isArray(json?.data)) return [...cachedModels];
    const names = json.data.map((m) => String(m.id ?? m.name ?? '').trim()).filter(Boolean);
    for (const n of names) cachedModels.add(n);
    return names.length ? names : [...cachedModels];
  };

  return {
    async ready(ctx) {
      if (ctx.runtime?.health_path) {
        const res = await fetch(`${ctx.base}${ctx.runtime.health_path}`, {
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);
        return Boolean(res?.ok);
      }
      const modelsRes = await fetch(`${ctx.base}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (modelsRes?.ok) return true;
      const healthRes = await fetch(`${ctx.base}/health`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      return Boolean(healthRes?.ok);
    },

    async idle() {
      return true;
    },

    async models(ctx) {
      const names = await listOpenAiModels(ctx.base);
      const effective = names.length ? names : [options.id];
      return effective.map((name) => ({
        id: name,
        object: 'model',
        owned_by: options.id,
        tasks: ['chat'],
        max_concurrent_requests: 4,
      }));
    },

    async resolveChatRequest(ctx, body) {
      const raw = String(body?.model ?? '').trim();
      if (!raw) return false;
      if (raw === options.id || cachedModels.has(raw)) return true;
      const live = await listOpenAiModels(ctx.base);
      return live.includes(raw);
    },
  };
}

export function createAdoptedAdapter(
  kind: string,
  options: { id: string; baseUrl: string; models?: string[] },
): EngineAdapter {
  const lowerKind = kind.toLowerCase();
  if (lowerKind.includes('comfy')) {
    return createComfyAdoptedAdapter(options.baseUrl);
  }
  if (lowerKind.includes('ollama')) {
    return createOllamaAdoptedAdapter({
      id: options.id,
      baseUrl: options.baseUrl,
      models: options.models ?? [],
    });
  }
  return createOpenAiExternalAdapter({
    id: options.id,
    models: options.models ?? [],
  });
}

export async function adoptExternalService(
  service: DiscoveredService | Record<string, unknown>,
  options: AdoptServiceOptions = {},
): Promise<{
  id: string;
  path: string | null;
  manifest: EngineManifestV2;
  models: string[];
  kind: string;
}> {
  const svc = service as Record<string, unknown>;
  const kind = String(svc.kind ?? svc.engine ?? svc.type ?? 'external').toLowerCase();
  const rawUrl = String(svc.base_url ?? svc.url ?? '');
  const normalized = normalizeBaseUrl(rawUrl);
  if (!normalized) {
    throw new Error(`Invalid external service URL: ${rawUrl}`);
  }
  const { baseUrl, port } = normalized;
  const isImage = kind.includes('comfy');
  const category = isImage ? ('image' as const) : ('llm' as const);
  const rawId = options.id ?? `ext-${sanitizeSlug(kind)}-${port}`;
  const id = sanitizeSlug(rawId);
  const displayName = options.name ?? String(svc.name ?? `${kind} (${port})`);

  let discoveredModels = Array.isArray(svc.models)
    ? svc.models.map((m) => String(m).trim()).filter(Boolean)
    : [];
  if (discoveredModels.length === 0 && !isImage) {
    const probed = await probeTarget({ kind, url: baseUrl, port }, 1500).catch(() => null);
    if (probed?.models.length) {
      discoveredModels = probed.models;
    }
  }

  const manifestModels = isImage
    ? [
        {
          id,
          priority: 50,
          capabilities: ['image.generate', 'image.edit'],
          info: { tasks: ['text-to-image', 'image-to-image'] },
        },
      ]
    : [];

  const manifest: EngineManifestV2 = {
    name: displayName,
    category,
    deployment_id: id,
    version: '1.0.0',
    platform: {
      engine: id,
      default_enabled: options.enabled ?? false,
      adapter: 'adapter.mjs',
      runtime: {
        id,
        name: displayName,
        driver: 'external',
        port,
        base_url: baseUrl,
        ...(kind === 'ollama'
          ? { health_path: '/api/tags' }
          : isImage
            ? { health_path: '/system_stats' }
            : {}),
        ...(isImage ? { native_ui: baseUrl } : {}),
      },
      resources: {
        backends: ['cuda', 'rocm', 'metal', 'vulkan', 'cpu'],
        gpu_count: 1,
        vram_mb: 4096,
        vram_mode: 'shared',
        concurrency: 4,
        affinity: 'any',
        cold_start_weight: 'low',
      },
      ui: {
        name: displayName,
        description: `Adopted external ${kind} service at ${baseUrl}`,
        symbol: isImage ? 'C' : 'E',
        accent: '#7dd3fc',
        panel: category === 'llm' ? 'llm' : 'media',
      },
      models: manifestModels,
    },
  };

  let writtenPath: string | null = null;
  if (options.enginesDir) {
    const pkgDir = resolve(options.enginesDir, category, id);
    await mkdir(pkgDir, { recursive: true });
    writtenPath = join(pkgDir, 'engine.json');
    await writeJsonAtomic(writtenPath, manifest);

    const adapterPath = join(pkgDir, 'adapter.mjs');
    if (!existsSync(adapterPath)) {
      const fallbackModels = discoveredModels.length ? discoveredModels : [id];
      const adapterSrc = [
        `const defaultModels = ${JSON.stringify(fallbackModels)};`,
        `export default {`,
        `  async ready(ctx) {`,
        `    const path = ctx.runtime?.health_path ?? '/health';`,
        `    const res = await fetch(ctx.base + path, { signal: AbortSignal.timeout(3000) }).catch(() => null);`,
        `    return Boolean(res?.ok);`,
        `  },`,
        `  async idle() {`,
        `    return true;`,
        `  },`,
        `  models() {`,
        `    return defaultModels.map((id) => ({ id, object: 'model', owned_by: '${id}', tasks: ['${category === 'llm' ? 'chat' : 'image'}'] }));`,
        `  },`,
        `  resolveChatRequest(_ctx, body) {`,
        `    return defaultModels.includes(body?.model);`,
        `  },`,
        `};`,
        ``,
      ].join('\n');
      await writeFile(adapterPath, adapterSrc, 'utf8');
    }
  }

  if (options.dataDir) {
    const storeFile = join(options.dataDir, 'hub-adopted.json');
    let existing: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(await readFile(storeFile, 'utf8')) as unknown;
      if (Array.isArray(parsed)) existing = parsed as Array<Record<string, unknown>>;
    } catch {}
    const filtered = existing.filter((entry) => entry.id !== id);
    filtered.push({
      id,
      base_url: baseUrl,
      kind,
      models: discoveredModels,
      adopted_at: new Date().toISOString(),
    });
    await writeJsonAtomic(storeFile, filtered);
  }

  return { id, path: writtenPath, manifest, models: discoveredModels, kind };
}

export const adoptService = adoptExternalService;
export const adopt = adoptExternalService;
