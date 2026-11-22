import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile as readDiskFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildWindowsTaskArgs,
  installService,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskXml,
  serviceStatus,
  uninstallService,
} from '../lib/platform/service-install.ts';

function createMemoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    fs: {
      existsSync: (path: string) => files.has(path),
      mkdir: async (path: string) => {
        dirs.add(path);
        return path;
      },
      readFile: async (path: string) => {
        const val = files.get(path);
        if (val === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return val;
      },
      writeFile: async (path: string, data: string) => {
        files.set(path, data);
      },
      rm: async (path: string) => {
        files.delete(path);
      },
    },
  };
}

test('Linux systemd --user unit rendering, install, status, and uninstall', async () => {
  const unit = renderSystemdUnit({
    nodePath: '/usr/local/bin/node',
    serverMjsPath: '/opt/vramdeck/platforms/workbench/server.mjs',
    rootDir: '/opt/vramdeck',
    dataDir: '/var/lib/vramdeck',
  });
  assert.match(
    unit,
    /ExecStart="\/usr\/local\/bin\/node" "\/opt\/vramdeck\/platforms\/workbench\/server\.mjs"/,
  );
  assert.match(unit, /WorkingDirectory=\/opt\/vramdeck/);
  assert.match(unit, /KillSignal=SIGTERM/);

  const mem = createMemoryFs();
  const calls: Array<[string, string[]]> = [];
  const exec = async (bin: string, args: string[]) => {
    calls.push([bin, args]);
    if (args.includes('is-active')) return { stdout: 'active\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  const installed = await installService({
    platform: 'linux',
    homeDir: '/home/tester',
    env: {},
    fs: mem.fs,
    exec,
  });
  assert.equal(installed.manager, 'systemd');
  assert.equal(installed.installed, true);
  assert.equal(installed.unitPath, '/home/tester/.config/systemd/user/vramdeck.service');
  assert.ok(mem.files.has('/home/tester/.config/systemd/user/vramdeck.service'));
  assert.deepEqual(calls, [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'vramdeck.service']],
  ]);

  const status = await serviceStatus({
    platform: 'linux',
    homeDir: '/home/tester',
    env: {},
    fs: mem.fs,
    exec,
  });
  assert.equal(status.installed, true);
  assert.equal(status.active, true);

  const removed = await uninstallService({
    platform: 'linux',
    homeDir: '/home/tester',
    env: {},
    fs: mem.fs,
    exec,
  });
  assert.equal(removed.installed, false);
  assert.equal(mem.files.has('/home/tester/.config/systemd/user/vramdeck.service'), false);
});

test('macOS launchd plist escapes XML and runs launchctl bootstrap/bootout', async () => {
  const plist = renderLaunchdPlist({
    nodePath: '/opt/homebrew/bin/node',
    serverMjsPath: '/Users/a&b/vramdeck/server.mjs',
    rootDir: '/Users/a&b/vramdeck',
    dataDir: '/Users/a&b/data<1>',
  });
  assert.match(plist, /<string>io\.vramdeck\.gateway<\/string>/);
  assert.match(plist, /\/Users\/a&amp;b\/vramdeck\/server\.mjs/);
  assert.match(plist, /\/Users\/a&amp;b\/data&lt;1&gt;/);

  const mem = createMemoryFs();
  const calls: Array<[string, string[]]> = [];
  const exec = async (bin: string, args: string[]) => {
    calls.push([bin, args]);
    if (args[0] === 'print') return { stdout: 'state = running\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  const res = await installService({
    platform: 'darwin',
    homeDir: '/Users/tester',
    uid: 501,
    env: {},
    fs: mem.fs,
    exec,
  });
  assert.equal(res.manager, 'launchd');
  assert.equal(res.unitPath, '/Users/tester/Library/LaunchAgents/io.vramdeck.gateway.plist');
  assert.ok(
    calls.some(([bin, a]) => bin === 'launchctl' && a[0] === 'bootstrap' && a[1] === 'gui/501'),
  );

  const st = await serviceStatus({
    platform: 'darwin',
    homeDir: '/Users/tester',
    uid: 501,
    env: {},
    fs: mem.fs,
    exec,
  });
  assert.equal(st.active, true);

  await uninstallService({
    platform: 'darwin',
    homeDir: '/Users/tester',
    uid: 501,
    env: {},
    fs: mem.fs,
    exec,
  });
  assert.equal(mem.files.has(res.unitPath), false);
});

test('Windows schtasks XML rendering and install/status/uninstall commands', async () => {
  const xml = renderWindowsTaskXml({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    serverMjsPath: 'D:\\Code\\Infer\\llm-backend\\platforms\\workbench\\server.mjs',
    rootDir: 'D:\\Code\\Infer\\llm-backend',
  });
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(xml, /<LogonTrigger>/);
  assert.deepEqual(buildWindowsTaskArgs('create', 'C:\\tmp\\t.xml'), [
    '/Create',
    '/TN',
    'VramDeckGateway',
    '/XML',
    'C:\\tmp\\t.xml',
    '/F',
  ]);

  const mem = createMemoryFs();
  const calls: Array<[string, string[]]> = [];
  const exec = async (bin: string, args: string[]) => {
    calls.push([bin, args]);
    if (args.includes('/Query')) return { stdout: 'Status: Ready\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  const res = await installService({
    platform: 'win32',
    env: {},
    fs: mem.fs,
    exec,
  });
  assert.equal(res.manager, 'schtasks');
  assert.equal(res.installed, true);
  assert.equal(calls[0][0], 'schtasks.exe');
  assert.ok(calls[0][1].includes('/Create'));

  const st = await serviceStatus({ platform: 'win32', env: {}, fs: mem.fs, exec });
  assert.equal(st.installed, true);
  assert.equal(st.detail, 'Ready');

  await uninstallService({ platform: 'win32', env: {}, fs: mem.fs, exec });
  assert.ok(calls.some(([, a]) => a.includes('/Delete')));
});

test('renderSystemdUnit rejects control chars, quotes WORKBENCH_DATA with spaces, and escapes quotes', () => {
  assert.throws(
    () =>
      renderSystemdUnit({
        nodePath: '/usr/bin/node',
        serverMjsPath: '/opt/server.mjs',
        rootDir: '/opt/app\nExecStartPre=/bin/sh -c id',
      }),
    /control character/i,
  );
  assert.throws(
    () =>
      renderSystemdUnit({
        nodePath: '/usr/bin/node',
        serverMjsPath: '/opt/server.mjs',
        rootDir: '/opt/app',
        dataDir: '/tmp/data\r\nEnvironment=LD_PRELOAD=/evil.so',
      }),
    /control character/i,
  );
  assert.throws(
    () =>
      renderSystemdUnit({
        nodePath: '/usr/bin/node\0bad',
        serverMjsPath: '/opt/server.mjs',
        rootDir: '/opt/app',
      }),
    /control character/i,
  );

  const unit = renderSystemdUnit({
    nodePath: '/opt/my "node"/bin/node',
    serverMjsPath: '/opt/vramdeck/server.mjs',
    rootDir: '/opt/my "app"',
    dataDir: '/var/lib/my vramdeck/data',
  });
  assert.match(unit, /Environment="WORKBENCH_DATA=\/var\/lib\/my vramdeck\/data"/);
  assert.match(unit, /ExecStart="\/opt\/my \\"node\\"\/bin\/node" "\/opt\/vramdeck\/server\.mjs"/);
  assert.match(unit, /WorkingDirectory=\/opt\/my \\"app\\"/);
});

test('Windows task XML propagates --production and --data-dir and resolvePaths honors env.HOME', async () => {
  const xml = renderWindowsTaskXml({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    serverMjsPath: 'D:\\Code\\server.mjs',
    rootDir: 'D:\\Code',
    dataDir: 'D:\\custom\\vramdeck data',
  });
  assert.match(
    xml,
    /<Arguments>&quot;D:\\Code\\server\.mjs&quot; --production --data-dir &quot;D:\\custom\\vramdeck data&quot;<\/Arguments>/,
  );

  const mem = createMemoryFs();
  let writtenXml = '';
  const calls: Array<[string, string[]]> = [];
  await installService({
    platform: 'win32',
    dataDir: 'D:\\custom\\vramdeck-data',
    env: {},
    fs: {
      ...mem.fs,
      writeFile: async (path: string, data: string) => {
        writtenXml = data;
        mem.files.set(path, data);
      },
    },
    exec: async (bin, args) => {
      calls.push([bin, args]);
      return { stdout: '', stderr: '' };
    },
  });
  assert.match(writtenXml, /--production --data-dir &quot;D:\\custom\\vramdeck-data&quot;/);
  assert.ok(writtenXml.startsWith('\uFEFF<?xml version="1.0" encoding="UTF-16"?>'));

  const linuxStatus = await serviceStatus({
    platform: 'linux',
    env: { HOME: '/custom/linux/home' },
    fs: mem.fs,
    exec: async () => ({ stdout: '', stderr: '' }),
  });
  assert.equal(linuxStatus.unitPath, '/custom/linux/home/.config/systemd/user/vramdeck.service');
});

test('installService win32 writes raw UTF-16LE BOM (0xFF 0xFE) on disk and cleans up temp XML', async () => {
  let capturedBytes: Buffer | null = null;
  let capturedXmlPath = '';
  const calls: Array<[string, string[]]> = [];

  const res = await installService({
    platform: 'win32',
    dataDir: 'D:\\custom\\vramdeck data',
    env: { USERDOMAIN: 'WORKGROUP', USERNAME: 'tester' },
    exec: async (bin, args) => {
      calls.push([bin, args]);
      const xmlFlagIndex = args.indexOf('/XML');
      assert.ok(xmlFlagIndex >= 0);
      capturedXmlPath = args[xmlFlagIndex + 1];
      capturedBytes = await readDiskFile(capturedXmlPath);
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(res.installed, true);
  assert.equal(calls[0][0], 'schtasks.exe');
  assert.ok(capturedBytes !== null);
  const raw: Buffer = capturedBytes;
  assert.equal(raw[0], 0xff);
  assert.equal(raw[1], 0xfe);

  const decoded = raw.subarray(2).toString('utf16le');
  assert.ok(decoded.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.match(
    decoded,
    /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>WORKGROUP\\tester<\/UserId>/,
  );
  assert.match(
    decoded,
    /<Principals>\s*<Principal id="Author">\s*<UserId>WORKGROUP\\tester<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<\/Principal>\s*<\/Principals>/,
  );
  assert.equal(existsSync(capturedXmlPath), false);
});

test('Windows task XML escapes <Principals>/<UserId> and rejects control chars in userId', async () => {
  const xml = renderWindowsTaskXml({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    serverMjsPath: 'D:\\Code\\server.mjs',
    rootDir: 'D:\\Code',
    userId: 'CONTOSO\\a&b<1>"\'',
  });
  assert.match(
    xml,
    /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>CONTOSO\\a&amp;b&lt;1&gt;&quot;&apos;<\/UserId>\s*<\/LogonTrigger>/,
  );
  assert.match(
    xml,
    /<Principals>\s*<Principal id="Author">\s*<UserId>CONTOSO\\a&amp;b&lt;1&gt;&quot;&apos;<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<\/Principal>\s*<\/Principals>/,
  );

  for (const badUserId of ['CORP\\alice\r\n', 'CORP\\alice\n', 'CORP\\alice\0']) {
    assert.throws(
      () =>
        renderWindowsTaskXml({
          nodePath: 'C:\\Program Files\\nodejs\\node.exe',
          serverMjsPath: 'D:\\Code\\server.mjs',
          rootDir: 'D:\\Code',
          userId: badUserId,
        }),
      /control character/i,
    );
  }

  const mem = createMemoryFs();
  await assert.rejects(
    () =>
      installService({
        platform: 'win32',
        env: { USERDOMAIN: 'CORP', USERNAME: 'alice\n' },
        fs: mem.fs,
        exec: async () => ({ stdout: '', stderr: '' }),
      }),
    /control character/i,
  );
  await assert.rejects(
    () =>
      installService({
        platform: 'win32',
        env: { USERDOMAIN: 'CORP\0', USERNAME: 'alice' },
        fs: mem.fs,
        exec: async () => ({ stdout: '', stderr: '' }),
      }),
    /control character/i,
  );
});
