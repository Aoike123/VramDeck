import assert from 'node:assert/strict';

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  rawBody: Buffer;
  text: string;
  json: T | null;
}

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
  retry?: number;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Record<string, unknown>;
  timeoutMs?: number;
}

function normalizeRequestInit(options: HttpRequestOptions): {
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  timeoutMs: number;
} {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: string | Uint8Array | undefined;
  if (options.body !== undefined) {
    if (typeof options.body === 'string') {
      body = options.body;
    } else if (Buffer.isBuffer(options.body)) {
      body = new Uint8Array(options.body);
    } else {
      body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }
  return {
    method,
    headers,
    body,
    timeoutMs: options.timeoutMs ?? 10_000,
  };
}

export async function httpRequest<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const init = normalizeRequestInit(options);
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  const rawBody = Buffer.from(await response.arrayBuffer());
  const text = rawBody.toString('utf8');
  let json: T | null = null;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = null;
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    rawBody,
    text,
    json,
  };
}

export async function httpJson<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<{ status: number; headers: Headers; data: T }> {
  const res = await httpRequest<T>(url, options);
  if (res.json === null) {
    assert.fail(
      `Expected JSON response from ${url} (HTTP ${res.status}), got: ${res.text.slice(0, 240)}`,
    );
  }
  return {
    status: res.status,
    headers: res.headers,
    data: res.json,
  };
}

function parseSseBlock(block: string): SseEvent | null {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'retry') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) retry = parsed;
    }
  }

  if (dataLines.length === 0 && event === undefined && id === undefined && retry === undefined) {
    return null;
  }
  const parsed: SseEvent = { data: dataLines.join('\n') };
  if (event !== undefined) parsed.event = event;
  if (id !== undefined) parsed.id = id;
  if (retry !== undefined) parsed.retry = retry;
  return parsed;
}

export async function readSseStream(
  url: string,
  options: HttpRequestOptions & { maxEvents?: number } = {},
): Promise<{ status: number; headers: Headers; events: SseEvent[] }> {
  const init = normalizeRequestInit(options);
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  const events: SseEvent[] = [];
  if (!response.body) {
    return { status: response.status, headers: response.headers, events };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingCr = false;
  const maxEvents = options.maxEvents ?? 500;
  let doneEarly = false;

  const normalizeChunkText = (rawText: string, flush = false): string => {
    let text = pendingCr ? `\r${rawText}` : rawText;
    pendingCr = false;
    if (!flush && text.endsWith('\r')) {
      pendingCr = true;
      text = text.slice(0, -1);
    }
    return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  };

  try {
    while (!doneEarly) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += normalizeChunkText(decoder.decode(), true);
        break;
      }
      buffer += normalizeChunkText(decoder.decode(chunk.value, { stream: true }));
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) {
          events.push(parsed);
          if (parsed.data === '[DONE]' || events.length >= maxEvents) {
            doneEarly = true;
            break;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!doneEarly) {
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) {
          events.push(parsed);
          if (parsed.data === '[DONE]' || events.length >= maxEvents) {
            doneEarly = true;
            break;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!doneEarly && buffer.trim().length > 0) {
      const trailing = parseSseBlock(buffer);
      if (trailing) events.push(trailing);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { status: response.status, headers: response.headers, events };
}

export async function waitForHttpReady(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; expectedStatus?: number[] } = {},
): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 150;
  const expectedStatus = options.expectedStatus ?? [200];
  const deadline = Date.now() + timeoutMs;
  let lastError = 'No response';

  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(url, { timeoutMs: Math.min(2500, timeoutMs) });
      if (expectedStatus.includes(res.status)) {
        return res;
      }
      lastError = `HTTP ${res.status}: ${res.text.slice(0, 120)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timed out waiting for ${url} (${timeoutMs}ms): ${lastError}`);
}

export function assertStatus(
  res: HttpResponse,
  expected: number | number[],
  context = 'HTTP response',
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    allowed.includes(res.status),
    `${context}: expected status ${allowed.join('|')}, got ${res.status}: ${res.text.slice(0, 240)}`,
  );
}

export function assertHeader(res: HttpResponse, name: string, expected: string | RegExp): string {
  const actual = res.headers.get(name);
  assert.ok(actual !== null, `Missing expected header "${name}"`);
  if (typeof expected === 'string') {
    assert.equal(actual, expected, `Header "${name}" mismatch`);
  } else {
    assert.match(actual, expected, `Header "${name}" mismatch`);
  }
  return actual;
}
