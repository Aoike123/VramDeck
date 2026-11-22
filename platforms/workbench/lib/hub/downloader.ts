import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { DownloadProgress } from '../types.ts';

export interface DownloadArtifactOptions {
  taskId?: string;
  url: string;
  destination?: string;
  dest?: string;
  target?: string;
  sha256?: string;
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

async function renameWithRetry(src: string, dest: string, attempts = 6): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') && i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectHash);
    stream.on('end', () => resolveHash());
  });
  return hash.digest('hex');
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf('/');
  if (slash < 0) return null;
  const totalRaw = header.slice(slash + 1).trim();
  if (totalRaw === '*') return null;
  const total = Number(totalRaw);
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  if (!existsSync(filePath)) return 0;
  try {
    const st = await stat(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

export async function downloadArtifact(
  options: DownloadArtifactOptions,
): Promise<DownloadProgress> {
  const destPath = options.destination ?? options.dest;
  if (!destPath) {
    throw new Error('Download destination path is required');
  }
  const target = options.target ?? basename(destPath);
  const taskId = options.taskId ?? randomUUID();
  const partPath = `${destPath}.part`;
  const maxRetries =
    typeof options.retries === 'number' && options.retries >= 0 ? options.retries : 3;

  const emit = (progress: DownloadProgress): DownloadProgress => {
    options.onProgress?.(progress);
    return progress;
  };

  if (options.signal?.aborted) {
    await rm(partPath, { force: true }).catch(() => {});
    return emit({
      task_id: taskId,
      target,
      status: 'cancelled',
      downloaded_bytes: 0,
      total_bytes: 0,
      speed_bps: 0,
    });
  }

  await mkdir(dirname(destPath), { recursive: true });
  emit({
    task_id: taskId,
    target,
    status: 'queued',
    downloaded_bytes: await fileSizeIfExists(partPath),
    total_bytes: 0,
    speed_bps: 0,
  });

  let totalBytes = 0;
  let downloadedBytes = 0;
  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt <= maxRetries) {
    if (options.signal?.aborted) {
      await rm(partPath, { force: true }).catch(() => {});
      return emit({
        task_id: taskId,
        target,
        status: 'cancelled',
        downloaded_bytes: downloadedBytes,
        total_bytes: totalBytes,
        speed_bps: 0,
      });
    }

    const existingOffset = await fileSizeIfExists(partPath);
    const headers: Record<string, string> = {};
    if (existingOffset > 0) {
      headers.Range = `bytes=${existingOffset}-`;
    }

    try {
      const response = await fetch(options.url, {
        method: 'GET',
        headers,
        signal: options.signal,
      });

      if (response.status === 416) {
        await response.body?.cancel().catch(() => {});
        await rm(partPath, { force: true }).catch(() => {});
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status} while downloading ${options.url}`);
      }

      const isPartial = response.status === 206 && existingOffset > 0;
      const startOffset = isPartial ? existingOffset : 0;
      downloadedBytes = startOffset;

      const contentLen = Number(response.headers.get('content-length') ?? 0);
      const rangeTotal = parseContentRangeTotal(response.headers.get('content-range'));
      if (rangeTotal !== null) {
        totalBytes = rangeTotal;
      } else if (Number.isFinite(contentLen) && contentLen > 0) {
        totalBytes = startOffset + contentLen;
      }

      if (!response.body) {
        throw new Error('Response body missing');
      }

      const reader = response.body.getReader();
      const ws = createWriteStream(partPath, { flags: isPartial ? 'a' : 'w' });
      const startedAt = Date.now();

      try {
        while (true) {
          if (options.signal?.aborted) {
            await reader.cancel().catch(() => {});
            throw new DOMException('Aborted', 'AbortError');
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await new Promise<void>((resolveWrite, rejectWrite) => {
              ws.write(value, (err) => (err ? rejectWrite(err) : resolveWrite()));
            });
            downloadedBytes += value.byteLength;
            const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
            emit({
              task_id: taskId,
              target,
              status: 'downloading',
              downloaded_bytes: downloadedBytes,
              total_bytes: totalBytes || downloadedBytes,
              speed_bps: Math.round((downloadedBytes - startOffset) / elapsedSec),
            });
          }
        }
      } finally {
        await new Promise<void>((resolveClose) => ws.end(() => resolveClose()));
      }

      if (totalBytes > 0 && downloadedBytes < totalBytes) {
        throw new Error(`Incomplete transfer (${downloadedBytes}/${totalBytes} bytes received)`);
      }

      lastError = null;
      break;
    } catch (error) {
      if (options.signal?.aborted || (error as Error)?.name === 'AbortError') {
        await rm(partPath, { force: true }).catch(() => {});
        return emit({
          task_id: taskId,
          target,
          status: 'cancelled',
          downloaded_bytes: downloadedBytes,
          total_bytes: totalBytes,
          speed_bps: 0,
        });
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      attempt += 1;
    }
  }

  if (lastError) {
    await rm(partPath, { force: true }).catch(() => {});
    await rm(destPath, { force: true }).catch(() => {});
    const failed = emit({
      task_id: taskId,
      target,
      status: 'failed',
      downloaded_bytes: downloadedBytes,
      total_bytes: totalBytes,
      speed_bps: 0,
      error: lastError.message,
    });
    void failed;
    throw lastError;
  }

  if (!totalBytes) {
    totalBytes = await fileSizeIfExists(partPath);
    downloadedBytes = totalBytes;
  }

  emit({
    task_id: taskId,
    target,
    status: 'verifying',
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
    speed_bps: 0,
  });

  if (options.sha256) {
    const actualSha = await computeSha256(partPath);
    if (actualSha.toLowerCase() !== options.sha256.toLowerCase()) {
      await rm(partPath, { force: true }).catch(() => {});
      await rm(destPath, { force: true }).catch(() => {});
      const errMsg = `SHA256 checksum mismatch for ${target}: expected ${options.sha256}, got ${actualSha}`;
      emit({
        task_id: taskId,
        target,
        status: 'failed',
        downloaded_bytes: downloadedBytes,
        total_bytes: totalBytes,
        speed_bps: 0,
        error: errMsg,
      });
      throw new Error(errMsg);
    }
  }

  await renameWithRetry(partPath, destPath);
  return emit({
    task_id: taskId,
    target,
    status: 'completed',
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
    speed_bps: 0,
  });
}

export const downloadFile = downloadArtifact;
export const download = downloadArtifact;

export class DownloadManager {
  readonly #tasks = new Map<string, DownloadProgress>();
  readonly #controllers = new Map<string, AbortController>();

  list(): DownloadProgress[] {
    return [...this.#tasks.values()];
  }

  get(taskId: string): DownloadProgress | null {
    return this.#tasks.get(taskId) ?? null;
  }

  start(options: DownloadArtifactOptions): { task_id: string; promise: Promise<DownloadProgress> } {
    const taskId = options.taskId ?? randomUUID();
    const ac = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) ac.abort();
      else options.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    this.#controllers.set(taskId, ac);
    const initial: DownloadProgress = {
      task_id: taskId,
      target: options.target ?? basename(options.destination ?? options.dest ?? taskId),
      status: 'queued',
      downloaded_bytes: 0,
      total_bytes: 0,
      speed_bps: 0,
    };
    this.#tasks.set(taskId, initial);

    const promise = downloadArtifact({
      ...options,
      taskId,
      signal: ac.signal,
      onProgress: (p) => {
        this.#tasks.set(taskId, p);
        options.onProgress?.(p);
      },
    }).finally(() => {
      this.#controllers.delete(taskId);
    });

    return { task_id: taskId, promise };
  }

  cancel(taskId: string): boolean {
    const controller = this.#controllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    const current = this.#tasks.get(taskId);
    if (current) {
      this.#tasks.set(taskId, { ...current, status: 'cancelled' });
    }
    return true;
  }
}
