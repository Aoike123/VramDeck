import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  timestamp: number;
}

export interface MockServerHandle<TMode extends Record<string, unknown> = Record<string, unknown>> {
  base: string;
  url: string;
  host: string;
  port: number;
  requests: RecordedRequest[];
  reset(): void;
  setMode(patch: Partial<TMode>): void;
  close(): Promise<void>;
}

const MINIMAL_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const MINIMAL_MP4 = Buffer.from('0000001866747970', 'hex');

async function readBodyText(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

async function startHttpServer<TMode extends Record<string, unknown>>(
  initialMode: TMode,
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: { mode: TMode; rawBody: string; pathname: string; searchParams: URLSearchParams },
  ) => Promise<void> | void,
): Promise<MockServerHandle<TMode>> {
  const requests: RecordedRequest[] = [];
  const mode: TMode = { ...initialMode };

  const server = http.createServer(async (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    try {
      const rawBody = await readBodyText(req);
      const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: { ...req.headers },
        body: rawBody,
        timestamp: Date.now(),
      });
      await handler(req, res, {
        mode,
        rawBody,
        pathname: parsedUrl.pathname,
        searchParams: parsedUrl.searchParams,
      });
    } catch (err) {
      if (
        res.destroyed ||
        res.writableEnded ||
        res.socket?.destroyed ||
        (!req.complete && req.destroyed)
      ) {
        return;
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.destroy();
      }
    }
  });

  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const host = '127.0.0.1';
  const port = addr.port;
  const base = `http://${host}:${port}`;

  return {
    base,
    url: base,
    host,
    port,
    requests,
    reset() {
      requests.length = 0;
      Object.assign(mode, initialMode);
    },
    setMode(patch: Partial<TMode>) {
      Object.assign(mode, patch);
    },
    async close() {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export interface MockOpenAiMode extends Record<string, unknown> {
  healthy: boolean;
  busy: boolean;
  sleeping: boolean;
  models: string[];
  chatText: string;
  streamChunks: string[];
  tokenizeCount: number | null;
  errorStatus: number | null;
  streamGate: Promise<void> | null;
}

export async function createMockOpenAIServer(
  opts: Partial<MockOpenAiMode> = {},
): Promise<MockServerHandle<MockOpenAiMode>> {
  const initial: MockOpenAiMode = {
    healthy: true,
    busy: false,
    sleeping: false,
    models: ['mock-llm'],
    chatText: 'mock-openai-response',
    streamChunks: ['mock-', 'openai-', 'stream'],
    tokenizeCount: null,
    errorStatus: null,
    streamGate: null,
    ...opts,
  };

  return startHttpServer(initial, async (req, res, { mode, rawBody, pathname }) => {
    const method = req.method ?? 'GET';
    if (mode.errorStatus && pathname.startsWith('/v1/')) {
      sendJson(res, mode.errorStatus, {
        error: { message: 'Injected OpenAI upstream fault', type: 'server_error' },
      });
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      if (!mode.healthy) {
        sendJson(res, 503, { status: 'unavailable' });
        return;
      }
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && pathname === '/metrics') {
      const running = mode.busy ? 1 : 0;
      const body =
        `vllm:num_requests_running{model_name="${mode.models[0] ?? 'mock-llm'}"} ${running}\n` +
        `vllm:num_requests_waiting{model_name="${mode.models[0] ?? 'mock-llm'}"} 0\n`;
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(body);
      return;
    }

    if (method === 'GET' && pathname === '/is_sleeping') {
      sendJson(res, 200, { is_sleeping: mode.sleeping });
      return;
    }

    if (method === 'POST' && pathname === '/sleep') {
      mode.sleeping = true;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/wake_up') {
      mode.sleeping = false;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/tokenize') {
      const parsed = rawBody ? (JSON.parse(rawBody) as { messages?: unknown[] }) : {};
      const computed = Math.max(8, Math.ceil(JSON.stringify(parsed).length / 4));
      sendJson(res, 200, { count: mode.tokenizeCount ?? computed });
      return;
    }

    if (method === 'GET' && pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: mode.models.map((id) => ({ id, object: 'model', owned_by: 'mock-openai' })),
      });
      return;
    }

    if (method === 'POST' && pathname === '/v1/chat/completions') {
      const payload = rawBody ? (JSON.parse(rawBody) as { model?: string; stream?: boolean }) : {};
      const model = payload.model ?? mode.models[0] ?? 'mock-llm';

      if (payload.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        const chunks = mode.streamChunks;
        for (let i = 0; i < chunks.length; i += 1) {
          if (i === 1 && mode.streamGate) {
            await mode.streamGate;
          }
          if (res.destroyed) return;
          const frame = {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion.chunk',
            model,
            choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      sendJson(res, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: mode.chatText },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

export interface MockComfyUiMode extends Record<string, unknown> {
  delayMs: number;
  failPrompt: boolean;
  failExecution: boolean;
  emptyOutputs: boolean;
  rejectView: boolean;
  objectInfo: Record<string, unknown>;
}

interface ComfyPromptState {
  id: string;
  number: number;
  running: boolean;
  interrupted: boolean;
  done: boolean;
  error: boolean;
}

export async function createMockComfyUIServer(
  opts: Partial<MockComfyUiMode> = {},
): Promise<MockServerHandle<MockComfyUiMode>> {
  const initial: MockComfyUiMode = {
    delayMs: 0,
    failPrompt: false,
    failExecution: false,
    emptyOutputs: false,
    rejectView: false,
    objectInfo: { KSampler: { input: { required: {} } } },
    ...opts,
  };

  let seq = 0;
  const prompts = new Map<string, ComfyPromptState>();

  return startHttpServer(initial, async (req, res, { mode, pathname, searchParams }) => {
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/system_stats') {
      sendJson(res, 200, { system: { comfyui_version: '0.3.0' }, devices: [] });
      return;
    }

    if (method === 'GET' && pathname === '/object_info') {
      sendJson(res, 200, mode.objectInfo);
      return;
    }

    if (method === 'GET' && pathname === '/queue') {
      const running = [...prompts.values()]
        .filter((p) => p.running && !p.done)
        .map((p) => [p.number, p.id]);
      sendJson(res, 200, { queue_running: running, queue_pending: [] });
      return;
    }

    if (method === 'POST' && pathname === '/queue') {
      sendJson(res, 200, {});
      return;
    }

    if (method === 'POST' && pathname === '/prompt') {
      if (mode.failPrompt) {
        sendJson(res, 400, { error: { message: 'Invalid ComfyUI prompt graph' } });
        return;
      }
      seq += 1;
      const promptId = randomUUID();
      const state: ComfyPromptState = {
        id: promptId,
        number: seq,
        running: mode.delayMs > 0,
        interrupted: false,
        done: mode.delayMs <= 0,
        error: mode.failExecution,
      };
      prompts.set(promptId, state);
      if (mode.delayMs > 0) {
        setTimeout(() => {
          if (!state.interrupted) {
            state.running = false;
            state.done = true;
          }
        }, mode.delayMs).unref();
      }
      sendJson(res, 200, { prompt_id: promptId, number: seq, node_errors: {} });
      return;
    }

    if (method === 'POST' && pathname === '/interrupt') {
      for (const state of prompts.values()) {
        if (state.running && !state.done) {
          state.running = false;
          state.interrupted = true;
          state.done = true;
        }
      }
      sendJson(res, 200, {});
      return;
    }

    if (method === 'POST' && pathname === '/upload/image') {
      sendJson(res, 200, { name: 'uploaded.png', subfolder: '', type: 'input' });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/history/')) {
      const id = pathname.slice('/history/'.length);
      const state = prompts.get(id);
      if (!state || !state.done) {
        sendJson(res, 200, {});
        return;
      }
      if (state.interrupted) {
        sendJson(res, 200, {
          [id]: {
            status: { status_str: 'error', messages: [['execution_interrupted', {}]] },
            outputs: {},
          },
        });
        return;
      }
      if (state.error) {
        sendJson(res, 200, {
          [id]: {
            status: { status_str: 'error', messages: [['execution_error', {}]] },
            outputs: {},
          },
        });
        return;
      }
      sendJson(res, 200, {
        [id]: {
          status: { status_str: 'success', messages: [] },
          outputs: mode.emptyOutputs
            ? {}
            : { '9': { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] } },
        },
      });
      return;
    }

    if (method === 'GET' && pathname === '/view') {
      if (mode.rejectView) {
        sendJson(res, 404, { error: 'View disabled' });
        return;
      }
      const filename = searchParams.get('filename') ?? 'output.png';
      const isVideo = filename.endsWith('.mp4');
      const body = isVideo ? MINIMAL_MP4 : MINIMAL_1X1_PNG;
      res.writeHead(200, {
        'Content-Type': isVideo ? 'video/mp4' : 'image/png',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

export interface MockOllamaModel {
  name: string;
  size?: number;
}

export interface MockOllamaMode extends Record<string, unknown> {
  models: MockOllamaModel[];
  unhealthy: boolean;
  delayMs: number;
  streamError: boolean;
  responseText: string;
}

export async function createMockOllamaServer(
  opts: Partial<MockOllamaMode> = {},
): Promise<MockServerHandle<MockOllamaMode>> {
  const initial: MockOllamaMode = {
    models: [{ name: 'qwen2.5:7b', size: 4_700_000_000 }],
    unhealthy: false,
    delayMs: 0,
    streamError: false,
    responseText: 'mock-ollama-reply',
    ...opts,
  };

  return startHttpServer(initial, async (req, res, { mode, rawBody, pathname }) => {
    const method = req.method ?? 'GET';
    if (mode.delayMs > 0) {
      await new Promise((r) => setTimeout(r, mode.delayMs));
    }
    if (mode.unhealthy) {
      sendJson(res, 503, { error: 'Ollama unavailable' });
      return;
    }

    if (method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ollama is running');
      return;
    }

    if (method === 'GET' && pathname === '/api/version') {
      sendJson(res, 200, { version: '0.6.0-mock' });
      return;
    }

    if (method === 'GET' && pathname === '/api/tags') {
      sendJson(res, 200, {
        models: mode.models.map((m) => ({
          name: m.name,
          model: m.name,
          modified_at: '2026-01-01T00:00:00Z',
          size: m.size ?? 4_000_000_000,
          digest: 'sha256:mock',
          details: { format: 'gguf', family: 'llama', quantization_level: 'Q4_K_M' },
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/ps') {
      sendJson(res, 200, {
        models: mode.models.map((m) => ({
          name: m.name,
          model: m.name,
          size: m.size ?? 4_000_000_000,
        })),
      });
      return;
    }

    if (method === 'POST' && (pathname === '/api/chat' || pathname === '/api/generate')) {
      const payload = rawBody ? (JSON.parse(rawBody) as { model?: string; stream?: boolean }) : {};
      const model = payload.model ?? mode.models[0]?.name ?? 'qwen2.5:7b';
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        if (mode.streamError) {
          res.write(`${JSON.stringify({ error: 'Injected stream error', done: true })}\n`);
          res.end();
          return;
        }
        res.write(
          `${JSON.stringify({
            model,
            created_at: new Date().toISOString(),
            ...(pathname === '/api/chat'
              ? { message: { role: 'assistant', content: mode.responseText } }
              : { response: mode.responseText }),
            done: true,
          })}\n`,
        );
        res.end();
        return;
      }

      sendJson(res, 200, {
        model,
        created_at: new Date().toISOString(),
        ...(pathname === '/api/chat'
          ? { message: { role: 'assistant', content: mode.responseText } }
          : { response: mode.responseText }),
        done: true,
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

export interface MockLlamaMode extends Record<string, unknown> {
  loading: boolean;
  modelId: string;
  streamDelayMs: number;
  errorStatus: number | null;
  chatText: string;
}

export async function createMockLlamaServer(
  opts: Partial<MockLlamaMode> = {},
): Promise<MockServerHandle<MockLlamaMode>> {
  const initial: MockLlamaMode = {
    loading: false,
    modelId: 'mock-gguf-model',
    streamDelayMs: 0,
    errorStatus: null,
    chatText: 'mock-llama-reply',
    ...opts,
  };

  return startHttpServer(initial, async (req, res, { mode, rawBody, pathname }) => {
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/health') {
      if (mode.loading) {
        sendJson(res, 503, {
          error: { code: 503, message: 'Loading model', type: 'unavailable_error' },
        });
        return;
      }
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (mode.errorStatus && pathname.startsWith('/v1/')) {
      sendJson(res, mode.errorStatus, {
        error: { code: mode.errorStatus, message: 'Injected llama-server fault', type: 'error' },
      });
      return;
    }

    if (method === 'GET' && pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [{ id: mode.modelId, object: 'model', owned_by: 'llamacpp' }],
      });
      return;
    }

    if (method === 'POST' && pathname === '/v1/chat/completions') {
      const payload = rawBody ? (JSON.parse(rawBody) as { model?: string; stream?: boolean }) : {};
      const model = payload.model ?? mode.modelId;
      if (payload.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        if (mode.streamDelayMs > 0) {
          await new Promise((r) => setTimeout(r, mode.streamDelayMs));
        }
        res.write(
          `data: ${JSON.stringify({
            id: `llama-${randomUUID()}`,
            object: 'chat.completion.chunk',
            model,
            choices: [{ index: 0, delta: { content: mode.chatText }, finish_reason: null }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      sendJson(res, 200, {
        id: `llama-${randomUUID()}`,
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: mode.chatText },
            finish_reason: 'stop',
          },
        ],
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

export interface ArtifactEntry {
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

export interface ArtifactDownloadMode extends Record<string, unknown> {
  dropAfterBytes: number | null;
  dropRemainingCount: number;
  corruptByteIndex: number | null;
  ignoreRange: boolean;
  httpErrorStatus: number | null;
  retryAfter: string | null;
}

export interface ArtifactDownloadServerHandle extends MockServerHandle<ArtifactDownloadMode> {
  digests: Record<string, { sha256: string; size: number }>;
  registerFile(urlPath: string, data: Buffer | string, contentType?: string): void;
}

export async function createMockArtifactDownloadServer(
  opts: {
    files?: Record<string, Buffer | string>;
    dropAfterBytes?: number | null;
    dropCount?: number;
    corruptByteIndex?: number | null;
    ignoreRange?: boolean;
    httpErrorStatus?: number | null;
    retryAfter?: string | null;
  } = {},
): Promise<ArtifactDownloadServerHandle> {
  const catalog = new Map<string, ArtifactEntry>();
  const digests: Record<string, { sha256: string; size: number }> = {};

  function registerFile(
    urlPath: string,
    data: Buffer | string,
    contentType = 'application/octet-stream',
  ): void {
    const normalized = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    catalog.set(normalized, { bytes, sha256, contentType });
    digests[normalized] = { sha256, size: bytes.length };
  }

  for (const [k, v] of Object.entries(opts.files ?? {})) {
    registerFile(k, v);
  }

  const initial: ArtifactDownloadMode = {
    dropAfterBytes: opts.dropAfterBytes ?? null,
    dropRemainingCount: opts.dropCount ?? 1,
    corruptByteIndex: opts.corruptByteIndex ?? null,
    ignoreRange: opts.ignoreRange ?? false,
    httpErrorStatus: opts.httpErrorStatus ?? null,
    retryAfter: opts.retryAfter ?? null,
  };

  const handle = await startHttpServer(initial, async (req, res, { mode, pathname }) => {
    const method = req.method ?? 'GET';
    if (mode.httpErrorStatus !== null) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (mode.retryAfter) {
        headers['Retry-After'] = mode.retryAfter;
      }
      res.writeHead(mode.httpErrorStatus, headers);
      res.end(JSON.stringify({ error: `HTTP ${mode.httpErrorStatus}` }));
      return;
    }

    const entry = catalog.get(pathname);
    if (!entry) {
      sendJson(res, 404, { error: 'Artifact not found' });
      return;
    }

    const total = entry.bytes.length;
    const baseHeaders: Record<string, string> = {
      'Content-Type': entry.contentType,
      'Accept-Ranges': 'bytes',
      ETag: `"${entry.sha256}"`,
      'X-Repo-Commit': 'mock-commit-0001',
      'X-Linked-Etag': `"${entry.sha256}"`,
    };

    if (method === 'HEAD') {
      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(total) });
      res.end();
      return;
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    let payload = Buffer.from(entry.bytes);
    if (
      mode.corruptByteIndex !== null &&
      mode.corruptByteIndex >= 0 &&
      mode.corruptByteIndex < payload.length
    ) {
      payload[mode.corruptByteIndex] ^= 0xff;
    }

    const rangeHeader = req.headers.range;
    let slice = payload;
    let status = 200;
    const responseHeaders: Record<string, string> = { ...baseHeaders };

    if (rangeHeader && !mode.ignoreRange) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      const start = Number.parseInt(match[1], 10);
      const end = match[2] ? Math.min(total - 1, Number.parseInt(match[2], 10)) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end < start) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      status = 206;
      slice = payload.subarray(start, end + 1);
      responseHeaders['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }

    responseHeaders['Content-Length'] = String(slice.length);
    res.writeHead(status, responseHeaders);

    if (
      mode.dropAfterBytes !== null &&
      mode.dropAfterBytes >= 0 &&
      mode.dropRemainingCount > 0 &&
      slice.length > mode.dropAfterBytes
    ) {
      mode.dropRemainingCount -= 1;
      const partial = slice.subarray(0, mode.dropAfterBytes);
      res.write(partial, () => {
        res.destroy(new Error('Simulated mid-stream connection drop'));
      });
      return;
    }

    res.end(slice);
  });

  return {
    ...handle,
    digests,
    registerFile,
  };
}
