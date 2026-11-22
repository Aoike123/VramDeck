import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SYSTEMD_UNIT_NAME = 'vramdeck.service';
export const LAUNCHD_LABEL = 'io.vramdeck.gateway';
export const WINDOWS_TASK_NAME = 'VramDeckGateway';

export interface ServiceInstallFs {
  existsSync(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
}

export type EnvMap = Record<string, string | undefined>;

export type ServiceExecFn = (
  bin: string,
  args: string[],
  options?: { env?: EnvMap },
) => Promise<{ stdout: string; stderr: string }>;

export interface ServiceInstallOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: EnvMap;
  exec?: ServiceExecFn;
  fs?: ServiceInstallFs;
  uid?: number;
  nodePath?: string;
  serverMjsPath?: string;
  rootDir?: string;
  dataDir?: string;
  userId?: string;
}

export interface ServiceActionResult {
  platform: NodeJS.Platform;
  manager: 'systemd' | 'launchd' | 'schtasks' | 'unsupported';
  installed: boolean;
  active: boolean;
  unitPath: string;
  detail: string;
}

const defaultFs: ServiceInstallFs = {
  existsSync: (p) => existsSync(p),
  mkdir: (p, opts) => mkdir(p, opts),
  readFile: (p, enc) => readFile(p, enc),
  writeFile: (p, data, enc) => writeFile(p, data, enc),
  rm: (p, opts) => rm(p, opts),
};

const defaultExec: ServiceExecFn = async (bin, args, options) => {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    env: (options?.env ?? process.env) as NodeJS.ProcessEnv,
    timeout: 10000,
    windowsHide: true,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function defaultRootDir(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

function defaultServerMjsPath(): string {
  return fileURLToPath(new URL('../../server.mjs', import.meta.url));
}

function assertNoControlChars(value: string, fieldName: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Invalid control character in ${fieldName}`);
  }
  return value;
}

function escapeSystemdValue(value: string, fieldName: string): string {
  assertNoControlChars(value, fieldName);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function quoteWinTaskArg(value: string, fieldName: string): string {
  assertNoControlChars(value, fieldName);
  return `"${value.replace(/"/g, '\\"').replace(/\\+$/, (m) => m + m)}"`;
}

function resolveWindowsUserId(env: EnvMap = process.env, explicitUserId?: string): string {
  if (explicitUserId !== undefined) {
    return assertNoControlChars(explicitUserId, 'userId').trim();
  }
  if (env.USERNAME !== undefined) {
    assertNoControlChars(env.USERNAME, 'userId');
  }
  if (env.USERDOMAIN !== undefined) {
    assertNoControlChars(env.USERDOMAIN, 'userId');
  }
  const username = env.USERNAME?.trim();
  const domain = env.USERDOMAIN?.trim();
  if (username) {
    return domain ? `${domain}\\${username}` : username;
  }
  try {
    const infoUser = userInfo().username?.trim();
    if (infoUser) {
      return assertNoControlChars(infoUser, 'userId');
    }
  } catch {
    // Ignore userInfo() errors in restricted environments
  }
  return '';
}

function resolvePaths(options: ServiceInstallOptions) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const env = options.env ?? process.env;
  const envHome =
    platform === 'win32'
      ? env.USERPROFILE ||
        (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ||
        env.HOME ||
        (env.LOCALAPPDATA ? win32.dirname(win32.dirname(env.LOCALAPPDATA)) : undefined)
      : env.HOME;
  const home = options.homeDir ?? envHome ?? homedir();
  const rootDir = options.rootDir ?? defaultRootDir();
  const serverMjsPath = options.serverMjsPath ?? defaultServerMjsPath();
  const nodePath = options.nodePath ?? process.execPath;
  const dataDir =
    options.dataDir ??
    env.WORKBENCH_DATA ??
    pathApi.join(rootDir, 'workspace', 'data', 'scheduler');
  const systemdDir = env.XDG_CONFIG_HOME
    ? pathApi.join(env.XDG_CONFIG_HOME, 'systemd', 'user')
    : pathApi.join(home, '.config', 'systemd', 'user');
  const unitPath =
    platform === 'linux'
      ? pathApi.join(systemdDir, SYSTEMD_UNIT_NAME)
      : platform === 'darwin'
        ? pathApi.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
        : platform === 'win32'
          ? WINDOWS_TASK_NAME
          : '';

  return {
    platform,
    home,
    env,
    rootDir,
    serverMjsPath,
    nodePath,
    dataDir,
    unitPath,
    uid: options.uid ?? process.getuid?.() ?? 1000,
    userId: platform === 'win32' ? resolveWindowsUserId(env, options.userId) : undefined,
  };
}

export function renderSystemdUnit(params: {
  nodePath: string;
  serverMjsPath: string;
  rootDir: string;
  dataDir?: string;
  description?: string;
  unitName?: string;
}): string {
  const description = assertNoControlChars(
    params.description ?? 'VramDeck Multimodal AI Control Plane',
    'description',
  );
  if (params.unitName !== undefined) {
    assertNoControlChars(params.unitName, 'unitName');
  }
  const workingDir = escapeSystemdValue(params.rootDir, 'rootDir');
  const nodeExec = escapeSystemdValue(params.nodePath, 'nodePath');
  const serverExec = escapeSystemdValue(params.serverMjsPath, 'serverMjsPath');

  const lines = [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${workingDir}`,
    'Environment=NODE_ENV=production',
  ];
  if (params.dataDir) {
    const escapedDataDir = escapeSystemdValue(params.dataDir, 'dataDir');
    lines.push(`Environment="WORKBENCH_DATA=${escapedDataDir}"`);
  }
  lines.push(
    `ExecStart="${nodeExec}" "${serverExec}"`,
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30',
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

export function renderLaunchdPlist(params: {
  label?: string;
  nodePath: string;
  serverMjsPath: string;
  rootDir: string;
  dataDir: string;
}): string {
  const label = params.label ?? LAUNCHD_LABEL;
  const logOut = posix.join(params.dataDir, 'server.log');
  const logErr = posix.join(params.dataDir, 'server.err.log');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(params.nodePath)}</string>`,
    `    <string>${escapeXml(params.serverMjsPath)}</string>`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(params.rootDir)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>NODE_ENV</key>',
    '    <string>production</string>',
    '    <key>WORKBENCH_DATA</key>',
    `    <string>${escapeXml(params.dataDir)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(logOut)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(logErr)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderWindowsTaskXml(params: {
  nodePath: string;
  serverMjsPath: string;
  rootDir: string;
  dataDir?: string;
  userId?: string;
}): string {
  const nodePath = assertNoControlChars(params.nodePath, 'nodePath');
  const rootDir = assertNoControlChars(params.rootDir, 'rootDir');
  const resolvedUserId = resolveWindowsUserId(process.env, params.userId);
  const taskArgs = [quoteWinTaskArg(params.serverMjsPath, 'serverMjsPath'), '--production'];
  if (params.dataDir) {
    taskArgs.push('--data-dir', quoteWinTaskArg(params.dataDir, 'dataDir'));
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
  ];
  if (resolvedUserId) {
    lines.push(`      <UserId>${escapeXml(resolvedUserId)}</UserId>`);
  }
  lines.push('    </LogonTrigger>', '  </Triggers>');
  if (resolvedUserId) {
    lines.push(
      '  <Principals>',
      '    <Principal id="Author">',
      `      <UserId>${escapeXml(resolvedUserId)}</UserId>`,
      '      <LogonType>InteractiveToken</LogonType>',
      '    </Principal>',
      '  </Principals>',
    );
  }
  lines.push(
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(nodePath)}</Command>`,
    `      <Arguments>${escapeXml(taskArgs.join(' '))}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(rootDir)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  );
  return lines.join('\n');
}

export function buildWindowsTaskArgs(
  action: 'create' | 'delete' | 'query',
  xmlPath?: string,
  taskName = WINDOWS_TASK_NAME,
): string[] {
  if (action === 'create') {
    if (!xmlPath) throw new Error('xmlPath is required for Windows task creation');
    return ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'];
  }
  if (action === 'delete') {
    return ['/Delete', '/TN', taskName, '/F'];
  }
  return ['/Query', '/TN', taskName, '/FO', 'LIST'];
}

export async function installService(
  options: ServiceInstallOptions = {},
): Promise<ServiceActionResult> {
  const fs = options.fs ?? defaultFs;
  const exec = options.exec ?? defaultExec;
  const resolved = resolvePaths(options);

  if (resolved.platform === 'linux') {
    const unitContent = renderSystemdUnit(resolved);
    await fs.mkdir(posix.dirname(resolved.unitPath), { recursive: true });
    await fs.writeFile(resolved.unitPath, unitContent, 'utf8');
    await exec('systemctl', ['--user', 'daemon-reload'], { env: resolved.env });
    await exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME], {
      env: resolved.env,
    });
    return {
      platform: 'linux',
      manager: 'systemd',
      installed: true,
      active: true,
      unitPath: resolved.unitPath,
      detail: `Installed and started ${SYSTEMD_UNIT_NAME}`,
    };
  }

  if (resolved.platform === 'darwin') {
    const plistContent = renderLaunchdPlist(resolved);
    await fs.mkdir(posix.dirname(resolved.unitPath), { recursive: true });
    await fs.mkdir(resolved.dataDir, { recursive: true });
    await fs.writeFile(resolved.unitPath, plistContent, 'utf8');
    const domain = `gui/${resolved.uid}`;
    await exec('launchctl', ['bootout', domain, resolved.unitPath], {
      env: resolved.env,
    }).catch(() => {});
    await exec('launchctl', ['bootstrap', domain, resolved.unitPath], { env: resolved.env });
    return {
      platform: 'darwin',
      manager: 'launchd',
      installed: true,
      active: true,
      unitPath: resolved.unitPath,
      detail: `Installed and bootstrapped ${LAUNCHD_LABEL}`,
    };
  }

  if (resolved.platform === 'win32') {
    const xml = renderWindowsTaskXml(resolved);
    const tmpXml = join(tmpdir(), `vramdeck-task-${process.pid}.xml`);
    await fs.writeFile(tmpXml, `\uFEFF${xml}`, 'utf16le');
    try {
      await exec('schtasks.exe', buildWindowsTaskArgs('create', tmpXml), { env: resolved.env });
    } finally {
      await fs.rm(tmpXml, { force: true }).catch(() => {});
    }
    return {
      platform: 'win32',
      manager: 'schtasks',
      installed: true,
      active: true,
      unitPath: WINDOWS_TASK_NAME,
      detail: `Registered Scheduled Task ${WINDOWS_TASK_NAME}`,
    };
  }

  return {
    platform: resolved.platform,
    manager: 'unsupported',
    installed: false,
    active: false,
    unitPath: '',
    detail: `Service installation is not supported on ${resolved.platform}`,
  };
}

export async function uninstallService(
  options: ServiceInstallOptions = {},
): Promise<ServiceActionResult> {
  const fs = options.fs ?? defaultFs;
  const exec = options.exec ?? defaultExec;
  const resolved = resolvePaths(options);

  if (resolved.platform === 'linux') {
    await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME], {
      env: resolved.env,
    }).catch(() => {});
    await fs.rm(resolved.unitPath, { force: true });
    await exec('systemctl', ['--user', 'daemon-reload'], { env: resolved.env }).catch(() => {});
    return {
      platform: 'linux',
      manager: 'systemd',
      installed: false,
      active: false,
      unitPath: resolved.unitPath,
      detail: `Uninstalled ${SYSTEMD_UNIT_NAME}`,
    };
  }

  if (resolved.platform === 'darwin') {
    const domain = `gui/${resolved.uid}`;
    await exec('launchctl', ['bootout', domain, resolved.unitPath], {
      env: resolved.env,
    }).catch(() => {});
    await fs.rm(resolved.unitPath, { force: true });
    return {
      platform: 'darwin',
      manager: 'launchd',
      installed: false,
      active: false,
      unitPath: resolved.unitPath,
      detail: `Uninstalled ${LAUNCHD_LABEL}`,
    };
  }

  if (resolved.platform === 'win32') {
    await exec('schtasks.exe', buildWindowsTaskArgs('delete'), { env: resolved.env }).catch(
      () => {},
    );
    return {
      platform: 'win32',
      manager: 'schtasks',
      installed: false,
      active: false,
      unitPath: WINDOWS_TASK_NAME,
      detail: `Removed Scheduled Task ${WINDOWS_TASK_NAME}`,
    };
  }

  return {
    platform: resolved.platform,
    manager: 'unsupported',
    installed: false,
    active: false,
    unitPath: '',
    detail: `Service uninstall is not supported on ${resolved.platform}`,
  };
}

export async function serviceStatus(
  options: ServiceInstallOptions = {},
): Promise<ServiceActionResult> {
  const fs = options.fs ?? defaultFs;
  const exec = options.exec ?? defaultExec;
  const resolved = resolvePaths(options);

  if (resolved.platform === 'linux') {
    const installed = fs.existsSync(resolved.unitPath);
    let active = false;
    let detail = installed ? 'inactive' : 'not installed';
    if (installed) {
      try {
        const { stdout } = await exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME], {
          env: resolved.env,
        });
        detail = stdout.trim() || 'active';
        active = detail === 'active';
      } catch (err) {
        detail = (err as { stdout?: string })?.stdout?.trim() || 'inactive';
      }
    }
    return {
      platform: 'linux',
      manager: 'systemd',
      installed,
      active,
      unitPath: resolved.unitPath,
      detail,
    };
  }

  if (resolved.platform === 'darwin') {
    const installed = fs.existsSync(resolved.unitPath);
    let active = false;
    let detail = installed ? 'loaded: false' : 'not installed';
    if (installed) {
      try {
        const { stdout } = await exec(
          'launchctl',
          ['print', `gui/${resolved.uid}/${LAUNCHD_LABEL}`],
          { env: resolved.env },
        );
        active = /state = running/i.test(stdout);
        detail = active ? 'running' : 'loaded';
      } catch {
        detail = 'not loaded';
      }
    }
    return {
      platform: 'darwin',
      manager: 'launchd',
      installed,
      active,
      unitPath: resolved.unitPath,
      detail,
    };
  }

  if (resolved.platform === 'win32') {
    try {
      const { stdout } = await exec('schtasks.exe', buildWindowsTaskArgs('query'), {
        env: resolved.env,
      });
      const active = /Status:\s+Running/i.test(stdout);
      return {
        platform: 'win32',
        manager: 'schtasks',
        installed: true,
        active,
        unitPath: WINDOWS_TASK_NAME,
        detail: active ? 'Running' : 'Ready',
      };
    } catch {
      return {
        platform: 'win32',
        manager: 'schtasks',
        installed: false,
        active: false,
        unitPath: WINDOWS_TASK_NAME,
        detail: 'not installed',
      };
    }
  }

  return {
    platform: resolved.platform,
    manager: 'unsupported',
    installed: false,
    active: false,
    unitPath: '',
    detail: `Service management is not supported on ${resolved.platform}`,
  };
}
