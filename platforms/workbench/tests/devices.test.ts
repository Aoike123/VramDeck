import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AmdDeviceProvider,
  AppleDeviceProvider,
  CompositeDeviceProvider,
  CpuMockDeviceProvider,
  NvidiaDeviceProvider,
  createDeviceProvider,
  execTool,
  parseAmdSmiJson,
  parseMockGpus,
  parseNvidiaSmiCsv,
  parseRocmSmiJson,
  parseSystemProfilerDisplays,
  parseVmStat,
  parseVulkanInfoSummary,
  parseWindowsAmdCimJson,
  probeAmdSysfs,
  readHostResources,
  resolveWin32Executable,
} from '../lib/devices/index.ts';
import type { DeviceProvider } from '../lib/types.ts';

test('parseNvidiaSmiCsv handles multi-GPU, N/A fields, comma names, and CRLF', () => {
  const csv = [
    '0, NVIDIA GeForce RTX 4090, 24564, 1024, 23540, 35, 48, 82.40\r',
    '1, NVIDIA Tesla, Workstation Edition, 16384, 512, [Not Supported], [N/A], N/A, ERR!\r',
    '',
  ].join('\n');

  const gpus = parseNvidiaSmiCsv(csv);
  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], {
    id: 'nvidia:0',
    index: 0,
    vendor: 'nvidia',
    backend: 'cuda',
    name: 'NVIDIA GeForce RTX 4090',
    unified_memory: false,
    vram_total_mb: 24564,
    vram_used_mb: 1024,
    vram_free_mb: 23540,
    utilization_pct: 35,
    temperature_c: 48,
    power_w: 82.4,
  });
  assert.equal(gpus[1].name, 'NVIDIA Tesla, Workstation Edition');
  assert.equal(gpus[1].vram_free_mb, 16384 - 512);
  assert.equal(gpus[1].utilization_pct, null);
  assert.equal(gpus[1].temperature_c, null);
  assert.equal(gpus[1].power_w, null);
});

test('NvidiaDeviceProvider falls back to WSL2 binary on Linux ENOENT and returns [] when absent', async () => {
  const calls: string[] = [];
  const wslProvider = new NvidiaDeviceProvider({
    platform: 'linux',
    exec: async (bin) => {
      calls.push(bin);
      if (bin === 'nvidia-smi') {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return {
        stdout: '0, NVIDIA RTX 3090, 24576, 2048, 22528, 10, 40, 45.0\n',
        stderr: '',
      };
    },
  });

  const snap = await wslProvider.detect();
  assert.deepEqual(calls, ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']);
  assert.equal(snap.gpus.length, 1);
  assert.equal(snap.gpus[0].name, 'NVIDIA RTX 3090');

  const missingProvider = new NvidiaDeviceProvider({
    platform: 'win32',
    exec: async () => {
      throw new Error('ENOENT');
    },
  });
  const emptySnap = await missingProvider.detect();
  assert.deepEqual(emptySnap.gpus, []);
});

test('resolveWin32Executable and execTool handle .cmd shims on Windows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'win-cmd-shim-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const shimPath = join(dir, 'mock-smi.cmd');
  await writeFile(
    shimPath,
    '@echo off\r\necho 0, Mock GPU, 8192, 1024, 7168, 12, 50, 25.5\r\n',
    'utf8',
  );

  const resolved = resolveWin32Executable('mock-smi', {
    PATH: dir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  });
  assert.equal(resolved.toLowerCase(), shimPath.toLowerCase());

  if (process.platform === 'win32') {
    const res = await execTool('mock-smi', [], {
      platform: 'win32',
      env: { ...process.env, PATH: `${dir};${process.env.PATH ?? ''}` },
    });
    const parsed = parseNvidiaSmiCsv(res.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'Mock GPU');
  }
});

test('execTool and NvidiaDeviceProvider handle .cmd shims in Windows directories with spaces', async (t) => {
  if (process.platform !== 'win32') return;
  const baseDir = await mkdtemp(join(tmpdir(), 'win-cmd-space-'));
  const spaceDir = join(baseDir, 'win bin spaces');
  await mkdir(spaceDir, { recursive: true });
  t.after(() => rm(baseDir, { recursive: true, force: true }));

  const shimPath = join(spaceDir, 'nvidia-smi.CMD');
  await writeFile(
    shimPath,
    '@echo off\r\necho 0, NVIDIA GeForce RTX 4090, 24564, 1024, 23540, 22, 46, 65.5\r\n',
    'utf8',
  );

  const env = { ...process.env, PATH: `${spaceDir};${process.env.PATH ?? ''}` };
  const direct = await execTool(
    'nvidia-smi',
    ['--query-gpu=index,name', '--format=csv,noheader,nounits'],
    { platform: 'win32', env },
  );
  assert.match(direct.stdout, /NVIDIA GeForce RTX 4090/);

  const provider = new NvidiaDeviceProvider({ platform: 'win32', env });
  const snap = await provider.detect();
  assert.equal(snap.gpus.length, 1);
  assert.equal(snap.gpus[0].name, 'NVIDIA GeForce RTX 4090');
  assert.equal(snap.gpus[0].vram_total_mb, 24564);
});

test('execTool rejects Windows .cmd/.bat quote breakout and %VAR% expansion while allowing safe space/& paths', async (t) => {
  if (process.platform !== 'win32') return;
  const baseDir = await mkdtemp(join(tmpdir(), 'win-cmd-sec-'));
  const ampDir = join(baseDir, 'dir & test');
  await mkdir(ampDir, { recursive: true });
  t.after(() => rm(baseDir, { recursive: true, force: true }));

  const probeBat = join(ampDir, 'arg-probe.bat');
  await writeFile(
    probeBat,
    `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
    'utf8',
  );

  const env = { ...process.env, PATH: `${ampDir};${process.env.PATH ?? ''}` };
  const injectedFile = join(baseDir, 'injected.txt');

  const warnings: string[] = [];
  const onWarning = (w: Error & { code?: string }) => {
    warnings.push(w.code ?? w.message);
  };
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));

  await assert.rejects(
    () =>
      execTool('arg-probe', [`foo" & echo INJECTED > "${injectedFile}" & rem `], {
        platform: 'win32',
        env,
      }),
    /Unsafe quote or environment expansion character/,
  );
  assert.equal(existsSync(injectedFile), false);

  await assert.rejects(
    () => execTool('arg-probe', ['--expr="a & b"'], { platform: 'win32', env }),
    /Unsafe quote or environment expansion character/,
  );

  await assert.rejects(
    () => execTool('arg-probe', ['%ComSpec%'], { platform: 'win32', env }),
    /Unsafe quote or environment expansion character/,
  );

  const safeRes = await execTool('arg-probe', ['a & b', 'hello world'], {
    platform: 'win32',
    env,
  });
  assert.deepEqual(JSON.parse(safeRes.stdout.trim()), ['a & b', 'hello world']);
  assert.equal(warnings.filter((code) => code === 'DEP0190').length, 0);
});

test('probeAmdSysfs parses AMD cards, skips Intel, handles invalid hwmon, and never wakes suspended GPUs', async (t) => {
  const sysRoot = await mkdtemp(join(tmpdir(), 'amd-sysfs-'));
  t.after(() => rm(sysRoot, { recursive: true, force: true }));

  const card0 = join(sysRoot, 'class', 'drm', 'card0', 'device');
  await mkdir(join(card0, 'hwmon', 'hwmon0'), { recursive: true });
  await mkdir(join(card0, 'power'), { recursive: true });
  await writeFile(join(card0, 'vendor'), '0x1002\n', 'utf8');
  await writeFile(join(card0, 'product_name'), 'Radeon AI PRO R9700\n', 'utf8');
  await writeFile(join(card0, 'power', 'runtime_status'), 'active\n', 'utf8');
  await writeFile(join(card0, 'mem_info_vram_total'), String(32 * 1024 * 1048576), 'utf8');
  await writeFile(join(card0, 'mem_info_vram_used'), String(4 * 1024 * 1048576), 'utf8');
  await writeFile(join(card0, 'gpu_busy_percent'), '27\n', 'utf8');
  await writeFile(join(card0, 'hwmon', 'hwmon0', 'temp1_input'), '57500\n', 'utf8');
  await writeFile(join(card0, 'hwmon', 'hwmon0', 'power1_average'), '45123000\n', 'utf8');
  await writeFile(join(card0, 'hwmon', 'hwmon0', 'fan1_input'), 'invalid\n', 'utf8');

  // Non-AMD card (Intel) should be skipped
  const card1 = join(sysRoot, 'class', 'drm', 'card1', 'device');
  await mkdir(card1, { recursive: true });
  await writeFile(join(card1, 'vendor'), '0x8086\n', 'utf8');

  // Connector node should be ignored
  await mkdir(join(sysRoot, 'class', 'drm', 'card0-DP-1'), { recursive: true });

  // Sleeping AMD GPU must never wake or fail when used/hwmon are missing
  const card2 = join(sysRoot, 'class', 'drm', 'card2', 'device');
  await mkdir(join(card2, 'power'), { recursive: true });
  await writeFile(join(card2, 'vendor'), '0x1002\n', 'utf8');
  await writeFile(join(card2, 'device'), '0x744c\n', 'utf8');
  await writeFile(join(card2, 'power', 'runtime_status'), 'suspended\n', 'utf8');
  await writeFile(join(card2, 'mem_info_vram_total'), String(16 * 1024 * 1048576), 'utf8');

  const gpus = await probeAmdSysfs(sysRoot);
  assert.equal(gpus.length, 2);

  assert.deepEqual(gpus[0], {
    id: 'amd:0',
    index: 0,
    vendor: 'amd',
    backend: 'rocm',
    name: 'Radeon AI PRO R9700',
    unified_memory: false,
    vram_total_mb: 32768,
    vram_used_mb: 4096,
    vram_free_mb: 28672,
    utilization_pct: 27,
    temperature_c: 57.5,
    power_w: 45.123,
  });

  assert.equal(gpus[1].id, 'amd:2');
  assert.equal(gpus[1].name, 'AMD Radeon GPU (0x744c)');
  assert.equal(gpus[1].vram_total_mb, 16384);
  assert.equal(gpus[1].vram_used_mb, 0);
  assert.equal(gpus[1].utilization_pct, null);
  assert.equal(gpus[1].temperature_c, null);
  assert.equal(gpus[1].power_w, null);

  // Suspended GPU in sysfs must NOT trigger rocm-smi fallback
  let rocmInvoked = false;
  const suspendedOnlyRoot = await mkdtemp(join(tmpdir(), 'amd-suspended-'));
  t.after(() => rm(suspendedOnlyRoot, { recursive: true, force: true }));
  const sCard = join(suspendedOnlyRoot, 'class', 'drm', 'card0', 'device');
  await mkdir(join(sCard, 'power'), { recursive: true });
  await writeFile(join(sCard, 'vendor'), '0x1002\n', 'utf8');
  await writeFile(join(sCard, 'power', 'runtime_status'), 'suspended\n', 'utf8');

  const amdProvider = new AmdDeviceProvider({
    platform: 'linux',
    sysRoot: suspendedOnlyRoot,
    exec: async () => {
      rocmInvoked = true;
      return { stdout: '{}', stderr: '' };
    },
  });
  const sSnap = await amdProvider.detect();
  assert.equal(rocmInvoked, false);
  assert.equal(sSnap.gpus.length, 1);

  // Temp in hwmon0 and power in hwmon1 should both be collected
  const splitHwmonRoot = await mkdtemp(join(tmpdir(), 'amd-split-hwmon-'));
  t.after(() => rm(splitHwmonRoot, { recursive: true, force: true }));
  const splitCard = join(splitHwmonRoot, 'class', 'drm', 'card0', 'device');
  await mkdir(join(splitCard, 'hwmon', 'hwmon0'), { recursive: true });
  await mkdir(join(splitCard, 'hwmon', 'hwmon1'), { recursive: true });
  await writeFile(join(splitCard, 'vendor'), '0x1002\n', 'utf8');
  await writeFile(join(splitCard, 'hwmon', 'hwmon0', 'temp1_input'), '61000\n', 'utf8');
  await writeFile(join(splitCard, 'hwmon', 'hwmon1', 'power1_average'), '72000000\n', 'utf8');
  const splitGpus = await probeAmdSysfs(splitHwmonRoot);
  assert.equal(splitGpus.length, 1);
  assert.equal(splitGpus[0].temperature_c, 61);
  assert.equal(splitGpus[0].power_w, 72);
});

test('AMD parsers cover rocm-smi, amd-smi, Windows 64-bit registry CIM, and vulkaninfo', async () => {
  const rocm = parseRocmSmiJson(
    JSON.stringify({
      card0: {
        'Card series': 'AMD Instinct MI300X',
        'VRAM Total Memory (B)': 192 * 1024 * 1048576,
        'VRAM Total Used Memory (B)': 10 * 1024 * 1048576,
        'GPU use (%)': '15',
        'Temperature (Sensor edge) (C)': '42.5',
        'Average Graphics Package Power (W)': '95.2',
      },
    }),
  );
  assert.equal(rocm.length, 1);
  assert.equal(rocm[0].vram_total_mb, 196608);
  assert.equal(rocm[0].temperature_c, 42.5);

  const amdSmi = parseAmdSmiJson(
    JSON.stringify({
      gpu_data: [
        {
          gpu: 0,
          asic: { market_name: 'Radeon RX 7900 XTX' },
          vram: { size: 24576, used: 2048 },
          usage: { gfx_activity: 40 },
          temperature: { edge: 55 },
          power: { socket_power: 120 },
        },
      ],
    }),
  );
  assert.equal(amdSmi[0].vram_total_mb, 24576);
  assert.equal(amdSmi[0].power_w, 120);

  // Verify 64-bit QwMemorySize avoids 4 GiB uint32 AdapterRAM cap (e.g. 32 GiB), including REG_BINARY byte arrays
  const cim = parseWindowsAmdCimJson(
    JSON.stringify([
      {
        Name: 'AMD Radeon PRO W7900',
        PNPDeviceID: 'PCI\\VEN_1002&DEV_7448',
        AdapterRAM: 4293918720,
        QwMemorySize: 34359738368,
      },
      {
        Name: 'AMD Radeon RX 7900 XTX',
        PNPDeviceID: 'PCI\\VEN_1002&DEV_744C',
        AdapterRAM: 4293918720,
        QwMemorySize: [0, 0, 0, 0, 6, 0, 0, 0],
      },
      {
        Name: 'NVIDIA GeForce RTX 4090',
        PNPDeviceID: 'PCI\\VEN_10DE&DEV_2684',
        AdapterRAM: 4293918720,
      },
    ]),
  );
  assert.equal(cim.length, 2);
  assert.equal(cim[0].vendor, 'amd');
  assert.equal(cim[0].backend, 'vulkan');
  assert.equal(cim[0].vram_total_mb, 32768);
  assert.equal(cim[1].vram_total_mb, 24576);

  const vulkan = parseVulkanInfoSummary(
    [
      'GPU0:',
      '\tvendorID         = 0x1002',
      '\tdeviceName       = AMD Radeon RX 7800 XT',
      'GPU1:',
      '\tvendorID         = 0x8086',
      '\tdeviceName       = Intel Arc',
    ].join('\n'),
  );
  assert.equal(vulkan.length, 1);
  assert.equal(vulkan[0].name, 'AMD Radeon RX 7800 XT');

  // Linux fallback uses rocm-smi only when sysfs yields 0 GPUs
  const fallbackProvider = new AmdDeviceProvider({
    platform: 'linux',
    sysRoot: join(tmpdir(), 'nonexistent-sys-dir-' + Date.now()),
    exec: async (bin) => {
      assert.equal(bin, 'rocm-smi');
      return {
        stdout: JSON.stringify({
          card0: {
            'Card series': 'Fallback AMD',
            'VRAM Total Memory (B)': 8192 * 1048576,
            'VRAM Total Used Memory (B)': 1024 * 1048576,
          },
        }),
        stderr: '',
      };
    },
  });
  const snap = await fallbackProvider.detect();
  assert.equal(snap.gpus.length, 1);
  assert.equal(snap.gpus[0].name, 'Fallback AMD');
});

test('AppleDeviceProvider computes 75% unified memory budget from system_profiler + vm_stat', async () => {
  const totalBytes = 64 * 1024 ** 3; // 64 GiB
  const vmStatText = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                              100000.',
    'Pages inactive:                          200000.',
    'Pages speculative:                        50000.',
  ].join('\n');

  const memStats = parseVmStat(vmStatText, totalBytes, 0.75, 'arm64');
  assert.equal(memStats.vram_total_mb, 49152); // 75% of 65536 MiB
  assert.ok(memStats.vram_free_mb > 0 && memStats.vram_free_mb <= 49152);
  assert.equal(memStats.vram_used_mb, memStats.vram_total_mb - memStats.vram_free_mb);

  const profilerJson = JSON.stringify({
    SPDisplaysDataType: [
      {
        sppci_model: 'Apple M3 Max',
        spdisplays_vendor: 'sppci_vendor_Apple',
      },
      {
        sppci_model: 'AMD Radeon Pro W6800X',
        spdisplays_vendor: 'sppci_vendor_amd',
        spdisplays_vram: '32 GB',
      },
    ],
  });

  const parsed = parseSystemProfilerDisplays(profilerJson, memStats);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].vendor, 'apple');
  assert.equal(parsed[0].backend, 'metal');
  assert.equal(parsed[0].unified_memory, true);
  assert.equal(parsed[0].vram_total_mb, 49152);
  assert.equal(parsed[1].vendor, 'amd');
  assert.equal(parsed[1].unified_memory, false);
  assert.equal(parsed[1].vram_total_mb, 32768);

  const appleProvider = new AppleDeviceProvider({
    platform: 'darwin',
    arch: 'arm64',
    exec: async (bin) => {
      if (bin === 'system_profiler') return { stdout: profilerJson, stderr: '' };
      if (bin === 'sysctl') return { stdout: `${totalBytes}\n`, stderr: '' };
      if (bin === 'vm_stat') return { stdout: vmStatText, stderr: '' };
      throw new Error('unexpected binary: ' + bin);
    },
  });
  const snap = await appleProvider.detect();
  assert.equal(snap.gpus.length, 2);
  assert.equal(snap.gpus[0].name, 'Apple M3 Max');
});

test('parseMockGpus sanitizes malformed input and never throws or emits NaN', () => {
  assert.equal(parseMockGpus(undefined), null);
  assert.equal(parseMockGpus('   '), null);
  assert.deepEqual(parseMockGpus('{bad json'), []);
  assert.deepEqual(parseMockGpus('{"not":"an array"}'), []);
  assert.deepEqual(parseMockGpus('[]'), []);

  const sanitized = parseMockGpus(
    JSON.stringify([
      'skip-string',
      {
        vendor: 'nvidia',
        name: 'RTX 4080',
        vram_total_mb: 16384,
        vram_used_mb: 20000, // clamped to 16384
        utilization_pct: Number.NaN,
        temperature_c: 'not-a-number',
        power_w: 150,
      },
      {
        backend: 'rocm',
        vram_total_mb: -50,
        vram_used_mb: 'NaN',
        utilization_pct: -10,
        power_w: -999,
      },
      {
        vendor: 'nvidia',
        utilization_pct: 140,
        power_w: 0,
      },
    ]),
  );

  assert.ok(sanitized && sanitized.length === 3);
  assert.equal(sanitized[0].backend, 'cuda');
  assert.equal(sanitized[0].vram_used_mb, 16384);
  assert.equal(sanitized[0].vram_free_mb, 0);
  assert.equal(sanitized[0].utilization_pct, null);
  assert.equal(sanitized[0].temperature_c, null);
  assert.equal(sanitized[0].power_w, 150);

  assert.equal(sanitized[1].vendor, 'amd');
  assert.equal(sanitized[1].vram_total_mb, 0);
  assert.equal(sanitized[1].vram_used_mb, 0);
  assert.equal(sanitized[1].vram_free_mb, 0);
  assert.equal(sanitized[1].utilization_pct, null);
  assert.equal(sanitized[1].power_w, null);

  assert.equal(sanitized[2].utilization_pct, 100);
  assert.equal(sanitized[2].power_w, 0);
});

test('CompositeDeviceProvider handles 0-GPU fallback and re-indexes multi-provider GPUs', async () => {
  const emptyProvider = createDeviceProvider({
    env: { WORKBENCH_MOCK_GPUS: '[]' },
  });
  const emptySnap = await emptyProvider.detect();
  assert.deepEqual(emptySnap.gpus, []);
  assert.ok(emptySnap.host.ram_total_mb > 0);
  assert.ok(emptySnap.collected_at > 0);

  const failingSub: DeviceProvider = {
    id: 'failing',
    async detect() {
      throw new Error('probe failed');
    },
  };
  const okSubA: DeviceProvider = {
    id: 'a',
    async detect() {
      return {
        collected_at: Date.now(),
        host: await readHostResources(),
        gpus: [
          {
            id: 'nvidia:0',
            index: 0,
            vendor: 'nvidia',
            backend: 'cuda',
            name: 'RTX 4090',
            unified_memory: false,
            vram_total_mb: 24576,
            vram_used_mb: 1024,
            vram_free_mb: 23552,
            utilization_pct: 10,
            temperature_c: 40,
            power_w: 80,
          },
        ],
      };
    },
  };
  const okSubB: DeviceProvider = {
    id: 'b',
    async detect() {
      return {
        collected_at: Date.now(),
        host: await readHostResources(),
        gpus: [
          {
            id: 'amd:0',
            index: 0,
            vendor: 'amd',
            backend: 'rocm',
            name: 'Radeon R9700',
            unified_memory: false,
            vram_total_mb: 32768,
            vram_used_mb: 512,
            vram_free_mb: 32256,
            utilization_pct: 5,
            temperature_c: 38,
            power_w: 50,
          },
        ],
      };
    },
  };

  const composite = new CompositeDeviceProvider({
    env: {},
    providers: [failingSub, okSubA, okSubB],
  });
  const snap = await composite.detect();
  assert.equal(snap.gpus.length, 2);
  assert.equal(snap.gpus[0].index, 0);
  assert.equal(snap.gpus[1].index, 1);
  assert.equal(snap.gpus[0].id, 'nvidia:0');
  assert.equal(snap.gpus[1].id, 'amd:0');

  const dedupMockProvider = createDeviceProvider({
    env: {
      WORKBENCH_MOCK_GPUS: JSON.stringify([
        { id: 'amd:0', vendor: 'amd', name: 'GPU A' },
        { id: 'amd:0', vendor: 'amd', name: 'GPU B' },
      ]),
    },
  });
  const dedupMockSnap = await dedupMockProvider.detect();
  assert.equal(dedupMockSnap.gpus.length, 2);
  assert.equal(dedupMockSnap.gpus[0].id, 'amd:0');
  assert.equal(dedupMockSnap.gpus[1].id, 'amd:1');

  const directMockProvider = new CpuMockDeviceProvider({
    env: {
      WORKBENCH_MOCK_GPUS: JSON.stringify([
        { id: 'amd:0', vendor: 'amd', name: 'GPU A' },
        { id: 'amd:0', vendor: 'amd', name: 'GPU B' },
      ]),
    },
  });
  const directMockSnap = await directMockProvider.detect();
  assert.equal(directMockSnap.gpus.length, 2);
  assert.equal(directMockSnap.gpus[0].id, 'amd:0');
  assert.equal(directMockSnap.gpus[1].id, 'amd:1');
});
