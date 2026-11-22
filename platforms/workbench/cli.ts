import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDeviceProvider } from './lib/devices/index.ts';
import {
  installService,
  serviceStatus,
  SYSTEMD_UNIT_NAME,
  uninstallService,
} from './lib/platform/service-install.ts';
import type { ServiceInstallOptions } from './lib/platform/service-install.ts';
import { registry } from './lib/registry.mjs';
import type { HardwareSnapshot } from './lib/types.ts';

const execFileAsync = promisify(execFile);

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface RegistryPackageLike {
  id: string;
  enabled?: boolean;
  manifest: {
    category: string;
    platform: {
      engine: string;
      runtime: unknown;
      models: Array<{ id: string; capabilities: string[] }>;
    };
  };
}

interface PlatformPortsConfig {
  gatewayPort: number;
  managementPort: number;
  controlPort: number;
  nextDist: string;
  dataDir: string;
}

export type EnvMap = Record<string, string | undefined>;

export function loadConfig(env: EnvMap = process.env): PlatformPortsConfig {
  let platformJson: Record<string, unknown> = {};
  try {
    platformJson = JSON.parse(
      readFileSync(join(ROOT, 'platforms', 'platform.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    platformJson = {};
  }

  const gatewayPort = Number(env.INFERENCE_PORT ?? platformJson.gateway_port ?? 18982);
  const managementPort = Number(env.WORKBENCH_PORT ?? platformJson.management_port ?? 13000);
  const controlPort = Number(env.CONTROL_PORT ?? platformJson.control_port ?? 18990);
  const nextDist = String(env.WORKBENCH_NEXT_DIST ?? platformJson.next_dist ?? '.next-workbench');
  const dataDir = resolve(env.WORKBENCH_DATA ?? join(ROOT, 'workspace', 'data', 'scheduler'));

  return { gatewayPort, managementPort, controlPort, nextDist, dataDir };
}

export const USAGE = [
  'VramDeck CLI — Few-GPU Multimodal AI Control Plane',
  '',
  'Usage:',
  '  vramdeck <command> [options]',
  '  ./lab scheduler <command> [options]',
  '',
  'Commands:',
  '  start [--headless]              Start the single-process control plane',
  '  stop                            Gracefully stop the control plane',
  '  restart [--headless]            Restart the control plane',
  '  status                          Show scheduler and gateway status JSON',
  '  logs [--lines N]                Show recent control-plane logs',
  '  devices [--json]                Probe GPUs and host memory',
  '  scheduler status                Show scheduler status JSON',
  '  scheduler switch <model>        Preload/switch active engine',
  '  scheduler run <model> -- <cmd>  Hold GPU lease while running <cmd>',
  '  switch <model>                  Alias for scheduler switch <model>',
  '  run <model> -- <cmd>            Alias for scheduler run <model> -- <cmd>',
  '  engine list                     List engine packages',
  '  engine status [pkg]             Show engine package details',
  '  engine enable <pkg>             Enable an engine package',
  '  engine disable <pkg>            Disable an engine package',
  '  hub scan                        Discover local inference services',
  '  hub install <engine>            Install an engine from the Hub',
  '  hub pull <model>                Download a model from the Hub',
  '  service install                 Install OS background service',
  '  service uninstall               Uninstall OS background service',
  '  service status                  Show OS background service status',
].join('\n');

export interface CliDeps {
  env?: EnvMap;
  platform?: NodeJS.Platform;
  fetchFn?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  detectDevices?: () => Promise<HardwareSnapshot>;
  serviceOps?: {
    install: (opts?: ServiceInstallOptions) => Promise<unknown>;
    uninstall: (opts?: ServiceInstallOptions) => Promise<unknown>;
    status: (opts?: ServiceInstallOptions) => Promise<unknown>;
  };
  spawnFn?: typeof spawn;
  execFn?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultPause = (ms: number) =>
  new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

async function httpJson(
  fetchFn: typeof fetch,
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetchFn(url, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function verifyOwnedProcess(
  pid: number,
  serverPath: string,
  platform: NodeJS.Platform,
  execFn: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'linux') {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.includes(serverPath) || cmdline.includes('server.mjs');
    } catch {
      return false;
    }
  }
  if (platform === 'win32') {
    try {
      const { stdout } = await execFn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
      ]);
      return stdout.includes('server.mjs');
    } catch {
      return false;
    }
  }
  try {
    const { stdout } = await execFn('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.includes('server.mjs');
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

export interface ParsedCommand {
  command: string;
  args: string[];
  help: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCommand {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    return { command: 'help', args: [], help: true };
  }
  const [command, ...rest] = argv;
  if (rest.includes('-h') || rest.includes('--help')) {
    if (command !== 'run' && !(command === 'scheduler' && rest[0] === 'run')) {
      return { command, args: rest, help: true };
    }
  }
  return { command, args: rest, help: false };
}

function formatDevicesHuman(snapshot: HardwareSnapshot): string {
  const lines: string[] = [
    `Host: ${snapshot.host.os}/${snapshot.host.arch} | RAM free ${snapshot.host.ram_free_mb} / ${snapshot.host.ram_total_mb} MiB`,
  ];
  if (!snapshot.gpus.length) {
    lines.push('GPUs: none detected (CPU fallback)');
  } else {
    for (const gpu of snapshot.gpus) {
      lines.push(
        `GPU[${gpu.index}] ${gpu.name} (${gpu.vendor}/${gpu.backend}) | VRAM ${gpu.vram_used_mb}/${gpu.vram_total_mb} MiB` +
          (gpu.utilization_pct !== null ? ` | util ${gpu.utilization_pct}%` : '') +
          (gpu.temperature_c !== null ? ` | ${gpu.temperature_c}C` : ''),
      );
    }
  }
  return lines.join('\n');
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: CliDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const fetchFn = deps.fetchFn ?? fetch;
  const out = deps.stdout ?? ((t: string) => console.log(t));
  const errOut = deps.stderr ?? ((t: string) => console.error(t));
  const sleep = deps.sleep ?? defaultPause;
  const spawnFn = deps.spawnFn ?? spawn;
  const execFn =
    deps.execFn ??
    (async (bin: string, args: string[]) => {
      const r = await execFileAsync(bin, args, { timeout: 5000, windowsHide: true });
      return { stdout: String(r.stdout), stderr: String(r.stderr) };
    });
  const serviceOps = deps.serviceOps ?? {
    install: (opts) => installService(opts),
    uninstall: (opts) => uninstallService(opts),
    status: (opts) => serviceStatus(opts),
  };

  const cfg = loadConfig(env);
  const controlBase = `http://127.0.0.1:${cfg.controlPort}`;
  const gatewayBase = `http://127.0.0.1:${cfg.gatewayPort}`;
  const managementBase = `http://127.0.0.1:${cfg.managementPort}`;

  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    out(USAGE);
    return;
  }

  const getControlStatus = async () => {
    const res = await httpJson(fetchFn, `${controlBase}/status`, { timeoutMs: 3000 });
    if (!res.ok) throw new Error(`Control plane returned HTTP ${res.status}`);
    return res.data as Record<string, unknown>;
  };

  const assertIdle = async () => {
    const s = await getControlStatus();
    const activeAlloc =
      Array.isArray(s.allocations) &&
      s.allocations.some((a) =>
        Boolean(a && typeof a === 'object' && (a as { active_leases?: number }).active_leases),
      );
    const switchingTargets = Array.isArray(s.switching_targets) && s.switching_targets.length > 0;
    if (s.leased || s.switching || s.queued || activeAlloc || switchingTargets) {
      throw new Error('Active/queued work: wait before stopping workbench');
    }
  };

  const waitReady = async () => {
    for (let i = 0; i < 150; i++) {
      try {
        const s = await getControlStatus();
        out(JSON.stringify(s, null, 2));
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error('Workbench startup timeout; inspect logs');
  };

  const runSwitchOrExec = async (subAction: 'switch' | 'run', subArgs: string[]) => {
    const model = subArgs[0];
    if (!model) throw new Error(`Usage: vramdeck scheduler ${subAction} <model>`);
    const rest = subArgs.slice(1);
    const acquire = await httpJson(fetchFn, `${controlBase}/acquire`, {
      body: { model },
      timeoutMs: 900_000,
    });
    if (!acquire.ok) {
      const msg = (acquire.data as { error?: string } | null)?.error ?? `HTTP ${acquire.status}`;
      throw new Error(msg);
    }
    const ticket = acquire.data as { token: string };
    const timer = setInterval(() => {
      void httpJson(fetchFn, `${controlBase}/renew`, { body: { token: ticket.token } }).catch(
        () => {},
      );
    }, 30000);
    timer.unref?.();

    try {
      if (subAction === 'switch') {
        out(`Ready: ${model}`);
      } else {
        const cmdArgs = rest[0] === '--' ? rest.slice(1) : rest;
        if (!cmdArgs.length) throw new Error('Provide command after --');
        const code = await new Promise<number | null>((resolveRun, rejectRun) => {
          const child = spawnFn(cmdArgs[0], cmdArgs.slice(1), {
            cwd: ROOT,
            stdio: 'inherit',
            shell: false,
          });
          child.on('error', rejectRun);
          child.on('exit', resolveRun);
        });
        process.exitCode = code ?? 1;
      }
    } finally {
      clearInterval(timer);
      await httpJson(fetchFn, `${controlBase}/release`, { body: { token: ticket.token } }).catch(
        () => {},
      );
    }
  };

  const { command, args } = parsed;

  if (command === 'status') {
    out(JSON.stringify(await getControlStatus(), null, 2));
    return;
  }

  if (command === 'logs') {
    const linesIdx = args.indexOf('--lines');
    const lineCount = linesIdx >= 0 ? Math.max(1, Number(args[linesIdx + 1]) || 60) : null;
    const logPath = join(cfg.dataDir, 'server.log');
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf8');
      if (lineCount !== null) {
        const lines = content.replace(/\r?\n$/, '').split(/\r?\n/);
        out(lines.slice(-lineCount).join('\n'));
      } else {
        out(content.slice(-6000));
      }
      return;
    }
    if (platform === 'linux') {
      try {
        const res = await execFn('journalctl', [
          '--user',
          '-u',
          SYSTEMD_UNIT_NAME,
          '-n',
          String(lineCount ?? 60),
          '--no-pager',
        ]);
        out(res.stdout);
        return;
      } catch {
        // Fall through to missing-log error.
      }
    }
    throw new Error(`No log file found at ${logPath}`);
  }

  if (command === 'start') {
    try {
      out(JSON.stringify(await getControlStatus(), null, 2));
      return;
    } catch {
      // Not currently running; proceed to spawn.
    }

    const headless = args.includes('--headless') || env.WORKBENCH_HEADLESS === '1';
    const isDev = env.NODE_ENV === 'development';
    if (!headless && !isDev && !existsSync(join(here, cfg.nextDist, 'BUILD_ID'))) {
      throw new Error(
        'Next.js build missing. Run "npm --prefix platforms/workbench run build" or pass --headless.',
      );
    }

    mkdirSync(cfg.dataDir, { recursive: true });
    const logFd = openSync(join(cfg.dataDir, 'server.log'), 'a');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(process.execPath, [join(here, 'server.mjs')], {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...env,
          NODE_ENV: env.NODE_ENV ?? 'production',
          WORKBENCH_DATA: cfg.dataDir,
          ...(headless ? { WORKBENCH_HEADLESS: '1' } : {}),
        } as NodeJS.ProcessEnv,
      });
    } finally {
      closeSync(logFd);
    }
    child.unref();
    if (child.pid) {
      writeFileSync(join(cfg.dataDir, 'server.pid'), String(child.pid));
    }
    await waitReady();
    return;
  }

  if (command === 'stop') {
    try {
      await assertIdle();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) {
        out('Control plane is not running.');
        return;
      }
      throw error;
    }

    const pidFile = join(cfg.dataDir, 'server.pid');
    let trackedPid: number | null = null;
    if (existsSync(pidFile)) {
      const parsedPid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        trackedPid = parsedPid;
      }
    }

    let stoppedViaHttp = false;
    try {
      const res = await httpJson(fetchFn, `${controlBase}/shutdown`, {
        method: 'POST',
        timeoutMs: 5000,
      });
      if (res.ok) stoppedViaHttp = true;
    } catch {
      stoppedViaHttp = false;
    }

    if (!stoppedViaHttp) {
      if (trackedPid === null) {
        throw new Error('Control plane /shutdown unavailable and server.pid missing');
      }
      const owned = await verifyOwnedProcess(
        trackedPid,
        join(here, 'server.mjs'),
        platform,
        execFn,
      );
      if (!owned) {
        throw new Error('PID is not owned workbench');
      }
      process.kill(trackedPid, 'SIGTERM');
    }

    let portClosed = false;
    for (let i = 0; i < 300; i++) {
      try {
        await getControlStatus();
      } catch {
        portClosed = true;
        break;
      }
      await sleep(100);
    }
    if (!portClosed) {
      throw new Error('Workbench shutdown timeout');
    }

    if (trackedPid !== null && isPidAlive(trackedPid)) {
      const owned = await verifyOwnedProcess(
        trackedPid,
        join(here, 'server.mjs'),
        platform,
        execFn,
      );
      if (owned) {
        for (let i = 0; i < 50; i++) {
          if (!isPidAlive(trackedPid)) break;
          await sleep(100);
        }
        if (isPidAlive(trackedPid)) {
          throw new Error('Workbench shutdown timeout waiting for process exit');
        }
      }
    }

    out('Stopped.');
    return;
  }

  if (command === 'restart') {
    await main(['stop'], deps);
    await main(['start', ...args], deps);
    return;
  }

  if (command === 'devices') {
    const asJson = args.includes('--json');
    let snapshot: HardwareSnapshot | null = null;
    try {
      const res = await httpJson(fetchFn, `${gatewayBase}/data?minutes=15&window=30`, {
        timeoutMs: 3000,
      });
      if (res.ok && res.data && typeof res.data === 'object') {
        const d = res.data as {
          gpus?: HardwareSnapshot['gpus'];
          host?: HardwareSnapshot['host'];
          timestamp?: number;
        };
        if (Array.isArray(d.gpus) && d.host) {
          snapshot = {
            collected_at: (d.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
            host: d.host,
            gpus: d.gpus,
          };
        }
      }
    } catch {
      snapshot = null;
    }

    if (!snapshot) {
      snapshot = deps.detectDevices
        ? await deps.detectDevices()
        : await createDeviceProvider({ platform, env }).detect();
    }

    out(asJson ? JSON.stringify(snapshot, null, 2) : formatDevicesHuman(snapshot));
    return;
  }

  if (command === 'switch' || command === 'run') {
    await runSwitchOrExec(command, args);
    return;
  }

  if (command === 'scheduler') {
    const sub = args[0] ?? 'status';
    if (sub === 'status') {
      out(JSON.stringify(await getControlStatus(), null, 2));
      return;
    }
    if (sub === 'switch' || sub === 'run') {
      await runSwitchOrExec(sub, args.slice(1));
      return;
    }
    throw new Error('Usage: vramdeck scheduler status | switch <model> | run <model> -- <cmd>');
  }

  if (command === 'engine') {
    const sub = args[0] ?? 'list';
    if (sub === 'list') {
      let rows: Array<{
        id: string;
        enabled: boolean;
        engine: string;
        models: Array<{ id: string; capabilities: string[] }>;
      }> | null = null;

      try {
        const res = await httpJson(fetchFn, `${managementBase}/api/platform`, {
          headers: { Host: `127.0.0.1:${cfg.managementPort}` },
          timeoutMs: 2500,
        });
        if (res.ok && res.data && typeof res.data === 'object') {
          rows = (res.data as { packages?: typeof rows }).packages ?? null;
        }
      } catch {
        rows = null;
      }

      if (!rows) {
        registry.load();
        const packages = (registry.packages ?? []) as RegistryPackageLike[];
        rows = packages.map((pkg) => ({
          id: pkg.id,
          enabled: Boolean(pkg.enabled),
          engine: pkg.manifest.platform.engine,
          models: pkg.manifest.platform.models.map((m) => ({
            id: m.id,
            capabilities: m.capabilities,
          })),
        }));
      }

      if (!rows.length) {
        out('No engine packages installed.');
        return;
      }
      for (const pkg of rows) {
        const stateLabel = pkg.enabled ? 'enabled' : 'disabled';
        const models = pkg.models.map((m) => `${m.id}[${m.capabilities.join('/')}]`).join(', ');
        out(`  ${pkg.id.padEnd(32)} ${stateLabel.padEnd(9)} ${models || pkg.engine}`);
      }
      return;
    }

    if (sub === 'status') {
      const target = args[1];
      registry.load();
      const packages = (registry.packages ?? []) as RegistryPackageLike[];
      const single = target ? (registry.package(target) as RegistryPackageLike | null) : null;
      const list = target ? (single ? [single] : []) : packages;
      if (target && !list.length) throw new Error(`Unknown engine package: ${target}`);
      out(
        JSON.stringify(
          list.map((pkg) => ({
            id: pkg.id,
            enabled: Boolean(pkg.enabled),
            category: pkg.manifest.category,
            engine: pkg.manifest.platform.engine,
            runtime: pkg.manifest.platform.runtime,
            models: pkg.manifest.platform.models,
          })),
          null,
          2,
        ),
      );
      return;
    }

    if (sub === 'enable' || sub === 'disable') {
      const pkgId = args[1];
      if (!pkgId) throw new Error(`Usage: vramdeck engine ${sub} <package>`);
      const wanted = sub === 'enable';
      try {
        const res = await httpJson(fetchFn, `${managementBase}/api/platform/engines/${pkgId}`, {
          body: { enabled: wanted },
          headers: { Host: `127.0.0.1:${cfg.managementPort}` },
          timeoutMs: 900_000,
        });
        if (!res.ok) {
          const msg = (res.data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        out(`${wanted ? 'Enabled' : 'Disabled'} ${pkgId} (gateway updated).`);
        return;
      } catch (error) {
        const errName = error instanceof Error ? error.name : '';
        const msg = error instanceof Error ? error.message : String(error);
        const isTimeout = errName === 'AbortError' || errName === 'TimeoutError';
        if (isTimeout || !/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) {
          throw error;
        }
      }

      registry.load();
      await registry.setEnabled(pkgId, wanted);
      out(`${wanted ? 'Enabled' : 'Disabled'} ${pkgId} (saved offline; takes effect on start).`);
      return;
    }

    throw new Error('Usage: vramdeck engine list | status [pkg] | enable <pkg> | disable <pkg>');
  }

  if (command === 'hub') {
    const sub = args[0] ?? 'scan';
    let endpoint = '';
    let method: 'GET' | 'POST' = 'POST';
    let body: Record<string, unknown> | undefined;

    if (sub === 'scan') {
      endpoint = '/api/hub/scan';
      method = 'POST';
      body = {};
    } else if (sub === 'install') {
      const target = args[1];
      if (!target) throw new Error('Usage: vramdeck hub install <engine>');
      endpoint = '/api/hub/engines/install';
      body = { id: target };
    } else if (sub === 'pull') {
      const target = args[1];
      if (!target) throw new Error('Usage: vramdeck hub pull <model>');
      endpoint = '/api/hub/models/pull';
      body = { id: target };
    } else {
      throw new Error('Usage: vramdeck hub scan | install <engine> | pull <model>');
    }

    try {
      const res = await httpJson(fetchFn, `${managementBase}${endpoint}`, {
        method,
        body,
        headers: { Host: `127.0.0.1:${cfg.managementPort}` },
        timeoutMs: 5000,
      });
      if (res.status === 404) {
        errOut(
          `Hub endpoint ${endpoint} is not mounted on this gateway yet (scheduled for Milestone M4).`,
        );
        return;
      }
      if (!res.ok) {
        const msg = (res.data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      out(JSON.stringify(res.data, null, 2));
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) {
        errOut('Gateway is offline; start the control plane to use Hub commands.');
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  if (command === 'service') {
    const sub = args[0] ?? 'status';
    const opts: ServiceInstallOptions = { platform, env, dataDir: cfg.dataDir };
    if (sub === 'install') {
      out(JSON.stringify(await serviceOps.install(opts), null, 2));
      return;
    }
    if (sub === 'uninstall') {
      out(JSON.stringify(await serviceOps.uninstall(opts), null, 2));
      return;
    }
    if (sub === 'status') {
      out(JSON.stringify(await serviceOps.status(opts), null, 2));
      return;
    }
    throw new Error('Usage: vramdeck service install | uninstall | status');
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}
