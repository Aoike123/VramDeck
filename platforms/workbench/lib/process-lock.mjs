import { createHash } from 'node:crypto';
import { lstat, open, stat, unlink } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const inProcessQueues = new Map();

function withInProcessQueue(key, fn) {
  const prev = inProcessQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  inProcessQueues.set(key, next);
  next
    .finally(() => {
      if (inProcessQueues.get(key) === next) inProcessQueues.delete(key);
    })
    .catch(() => {});
  return next;
}

function listenOn(server, endpoint) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function probeSocket(endpoint) {
  return new Promise((resolveProbe, rejectProbe) => {
    const client = connect(endpoint);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      fn(value);
    };
    client.once('connect', () => finish(resolveProbe, true));
    client.once('error', (error) => {
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
        finish(resolveProbe, true);
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        finish(resolveProbe, false);
      } else {
        finish(rejectProbe, error);
      }
    });
  });
}

async function withInitLock(initPath, fn) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const fd = await open(initPath, 'wx', 0o600);
      await fd.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(initPath);
        if (Date.now() - info.mtimeMs > 5000) {
          await unlink(initPath).catch(() => {});
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for process lock initialization', { cause: error });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(initPath).catch(() => {});
  }
}

// Acquire an exclusive, kernel-released process lock keyed by `path` without touching `path` itself:
// - Linux: abstract Unix domain socket (\0ai-workbench-<sha256>)
// - Windows: named pipe (\\.\pipe\ai-workbench-<sha256>)
// - macOS / other POSIX: Unix domain socket under tmpdir() with atomic stale-socket recovery
export async function acquireProcessLock(path) {
  const normalized = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const hash = createHash('sha256').update(normalized).digest('hex');
  const server = createServer((socket) => socket.destroy());
  let filesystemSocket = null;
  let socketIdentity = null;

  if (process.platform === 'win32') {
    const pipeName = '\\\\.\\pipe\\ai-workbench-' + hash;
    try {
      await listenOn(server, pipeName);
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        throw new Error('Workbench already running', { cause: error });
      }
      if (error.code === 'EACCES') {
        if (await probeSocket(pipeName).catch(() => false)) {
          throw new Error('Workbench already running', { cause: error });
        }
      }
      throw error;
    }
  } else if (process.platform === 'linux') {
    const abstractName = '\0ai-workbench-' + hash;
    try {
      await listenOn(server, abstractName);
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        throw new Error('Workbench already running', { cause: error });
      }
      throw error;
    }
  } else {
    const candidate = join(tmpdir(), 'awb-' + hash.slice(0, 24) + '.sock');
    const sockPath =
      Buffer.byteLength(candidate) <= 100 ? candidate : '/tmp/awb-' + hash.slice(0, 24) + '.sock';
    filesystemSocket = sockPath;
    try {
      await listenOn(server, sockPath);
      socketIdentity = await lstat(sockPath).catch(() => null);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      await withInProcessQueue(sockPath, () =>
        withInitLock(sockPath + '.init', async () => {
          try {
            await listenOn(server, sockPath);
            socketIdentity = await lstat(sockPath).catch(() => null);
          } catch (retryError) {
            if (retryError.code !== 'EADDRINUSE') throw retryError;
            if (await probeSocket(sockPath)) {
              throw new Error('Workbench already running', { cause: retryError });
            }
            await unlink(sockPath).catch((e) => {
              if (e.code !== 'ENOENT') throw e;
            });
            try {
              await listenOn(server, sockPath);
              socketIdentity = await lstat(sockPath).catch(() => null);
            } catch (finalError) {
              if (finalError.code === 'EADDRINUSE') {
                throw new Error('Workbench already running', { cause: finalError });
              }
              throw finalError;
            }
          }
        }),
      );
    }
  }

  server.unref();
  let closing;
  return () =>
    (closing ??= (async () => {
      const closeServer = () =>
        new Promise((resolveClose, rejectClose) =>
          server.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
      if (filesystemSocket) {
        await withInProcessQueue(filesystemSocket, () =>
          withInitLock(filesystemSocket + '.init', async () => {
            const current = await lstat(filesystemSocket).catch(() => null);
            if (
              socketIdentity &&
              current &&
              current.dev === socketIdentity.dev &&
              current.ino === socketIdentity.ino
            ) {
              await unlink(filesystemSocket).catch(() => {});
            }
            await closeServer();
          }),
        );
      } else {
        await closeServer();
      }
    })());
}
