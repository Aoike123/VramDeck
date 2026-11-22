import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { HardwareSnapshot } from '../../../platforms/workbench/lib/types.ts';
import { assertHardwareSnapshot } from '../lib/assertions.ts';
import {
  createIsolatedWorkspace,
  findFirstExisting,
  REPO_ROOT,
  requireDeliverable,
  resolveNode22Plus,
} from '../lib/env.ts';
import { createMockGpuDevice } from '../lib/fixtures.ts';
import { runCommand } from '../lib/process-runner.ts';

async function getDevicesEntry(): Promise<string | null> {
  return findFirstExisting([
    'platforms/workbench/lib/devices/index.ts',
    'platforms/workbench/lib/devices/index.mjs',
  ]);
}

async function runDeviceProbe(
  entryRel: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<HardwareSnapshot> {
  const entryUrl = pathToFileURL(path.join(REPO_ROOT, entryRel)).href;
  const script = [
    `const mod = await import(${JSON.stringify(entryUrl)});`,
    `let snapshot;`,
    `if (typeof mod.detectHardware === 'function') {`,
    `  snapshot = await mod.detectHardware();`,
    `} else if (typeof mod.createDeviceProvider === 'function') {`,
    `  snapshot = await mod.createDeviceProvider().detect();`,
    `} else if (typeof mod.defaultDeviceProvider === 'function') {`,
    `  snapshot = await mod.defaultDeviceProvider().detect();`,
    `} else if (mod.deviceProvider && typeof mod.deviceProvider.detect === 'function') {`,
    `  snapshot = await mod.deviceProvider.detect();`,
    `} else if (typeof mod.default === 'function') {`,
    `  const p = new mod.default();`,
    `  snapshot = await p.detect();`,
    `} else {`,
    `  throw new Error('No DeviceProvider entry export found in ' + ${JSON.stringify(entryRel)});`,
    `}`,
    `console.log(JSON.stringify(snapshot));`,
  ].join('\n');

  const nodeBin = resolveNode22Plus();
  const res = await runCommand(nodeBin, ['--input-type=module', '-e', script], {
    env: envOverrides,
  });
  assert.equal(res.code, 0, `Device probe failed (code=${res.code}):\n${res.stderr}`);
  return JSON.parse(res.stdout.trim()) as HardwareSnapshot;
}

async function installMockCommand(binDir: string, name: string, stdoutText: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const escaped = stdoutText.replace(/\r?\n/g, '\n');
    const jsPath = path.join(binDir, `${name}.mjs`);
    await writeFile(jsPath, `process.stdout.write(${JSON.stringify(escaped)});\n`, 'utf8');
    const cmdPath = path.join(binDir, `${name}.cmd`);
    await writeFile(cmdPath, `@echo off\r\n"${resolveNode22Plus()}" "${jsPath}" %*\r\n`, 'utf8');
  } else {
    const shPath = path.join(binDir, name);
    await writeFile(shPath, `#!/bin/sh\ncat << 'EOF'\n${stdoutText}\nEOF\n`, 'utf8');
    await chmod(shPath, 0o755);
  }
}

async function installFailingCommand(binDir: string, name: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, `${name}.cmd`);
    await writeFile(cmdPath, '@echo off\r\nexit /b 1\r\n', 'utf8');
  } else {
    const shPath = path.join(binDir, name);
    await writeFile(shPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(shPath, 0o755);
  }
}

describe('FA2 Tier 1: Hardware detection DeviceProvider', () => {
  it('fa02.t1.1 detects single-GPU WORKBENCH_MOCK_GPUS snapshot matching HardwareSnapshot schema', async (t) => {
    const entry = await getDevicesEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M2 (Feature #12): platforms/workbench/lib/devices/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const mockGpu = createMockGpuDevice({
      id: 'gpu-0',
      index: 0,
      vendor: 'nvidia',
      backend: 'cuda',
      name: 'Mock CUDA 24G',
      vram_total_mb: 24576,
      vram_used_mb: 2048,
      vram_free_mb: 22528,
    });

    const snapshot = await runDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: JSON.stringify([mockGpu]),
    });
    assertHardwareSnapshot(snapshot);
    assert.equal(snapshot.gpus.length, 1);
    assert.equal(snapshot.gpus[0].id, 'gpu-0');
    assert.equal(snapshot.gpus[0].vendor, 'nvidia');
    assert.equal(snapshot.gpus[0].backend, 'cuda');
    assert.equal(snapshot.gpus[0].vram_total_mb, 24576);
    assert.equal(snapshot.gpus[0].unified_memory, false);
  });

  it('fa02.t1.2 preserves indices and VRAM invariants across 1-4 heterogeneous mock GPUs', async (t) => {
    const entry = await getDevicesEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M2 (Feature #12): platforms/workbench/lib/devices/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const mockGpus = [
      createMockGpuDevice({
        id: 'gpu-0',
        index: 0,
        vendor: 'nvidia',
        backend: 'cuda',
        vram_total_mb: 24576,
        vram_used_mb: 1024,
        vram_free_mb: 23552,
      }),
      createMockGpuDevice({
        id: 'gpu-1',
        index: 1,
        vendor: 'amd',
        backend: 'rocm',
        vram_total_mb: 32768,
        vram_used_mb: 4096,
        vram_free_mb: 28672,
      }),
      createMockGpuDevice({
        id: 'gpu-2',
        index: 2,
        vendor: 'amd',
        backend: 'vulkan',
        vram_total_mb: 12288,
        vram_used_mb: 512,
        vram_free_mb: 11776,
      }),
      createMockGpuDevice({
        id: 'gpu-3',
        index: 3,
        vendor: 'nvidia',
        backend: 'cuda',
        vram_total_mb: 8192,
        vram_used_mb: 0,
        vram_free_mb: 8192,
      }),
    ];

    const snapshot = await runDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: JSON.stringify(mockGpus),
    });
    assertHardwareSnapshot(snapshot);
    assert.equal(snapshot.gpus.length, 4);
    const ids = new Set(snapshot.gpus.map((g) => g.id));
    assert.equal(ids.size, 4);
    snapshot.gpus.forEach((gpu, idx) => {
      assert.equal(gpu.index, idx);
      assert.ok(gpu.vram_used_mb + gpu.vram_free_mb <= gpu.vram_total_mb + 1);
    });
  });

  it('fa02.t1.3 CPU-only / 0-GPU environment returns valid host resources and empty or CPU GPU list', async (t) => {
    const entry = await getDevicesEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M2 (Feature #12): platforms/workbench/lib/devices/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const snapshot = await runDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: '[]',
    });
    assertHardwareSnapshot(snapshot);
    assert.ok(snapshot.host.os.length > 0);
    assert.ok(snapshot.host.arch.length > 0);
    assert.ok(snapshot.host.ram_total_mb > 0);
    assert.ok(snapshot.host.ram_free_mb >= 0);
    assert.ok(snapshot.gpus.length === 0 || snapshot.gpus.every((g) => g.backend === 'cpu'));
  });

  it('fa02.t1.4 Apple Silicon unified memory validates Metal contract and 75% hw.memsize budget on darwin', async (t) => {
    const entry = await getDevicesEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M2 (Feature #12): platforms/workbench/lib/devices/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    if (process.platform === 'darwin') {
      const ws = await createIsolatedWorkspace('fa02-t1-4-');
      t.after(() => ws.cleanup());

      const binDir = path.join(ws.rootDir, 'bin');
      await installMockCommand(
        binDir,
        'system_profiler',
        JSON.stringify({
          SPDisplaysDataType: [
            {
              sppci_model: 'Apple M3 Max',
              spdisplays_vendor: 'sppci_vendor_apple',
              sppci_device_type: 'spdisplays_gpu',
            },
          ],
        }),
      );
      await installMockCommand(binDir, 'sysctl', '68719476736');
      await installMockCommand(
        binDir,
        'vm_stat',
        [
          'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
          'Pages free:                               100000.',
          'Pages inactive:                            50000.',
        ].join('\n'),
      );

      const snapshot = await runDeviceProbe(entry!, {
        WORKBENCH_MOCK_GPUS: undefined,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      });
      assertHardwareSnapshot(snapshot);
      assert.ok(snapshot.gpus.length >= 1, 'Expected Apple GPU on darwin');
      assert.equal(snapshot.gpus[0].vendor, 'apple');
      assert.equal(snapshot.gpus[0].backend, 'metal');
      assert.equal(snapshot.gpus[0].unified_memory, true);
      assert.equal(snapshot.gpus[0].vram_total_mb, 49152);
      return;
    }

    const appleMock = createMockGpuDevice({
      id: 'apple-0',
      index: 0,
      vendor: 'apple',
      backend: 'metal',
      name: 'Apple Silicon Unified',
      unified_memory: true,
      vram_total_mb: 24576,
      vram_used_mb: 2048,
      vram_free_mb: 22528,
      temperature_c: null,
      power_w: null,
    });
    const snapshot = await runDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: JSON.stringify([appleMock]),
    });
    assertHardwareSnapshot(snapshot);
    assert.equal(snapshot.gpus.length, 1);
    assert.equal(snapshot.gpus[0].vendor, 'apple');
    assert.equal(snapshot.gpus[0].backend, 'metal');
    assert.equal(snapshot.gpus[0].unified_memory, true);
    assert.equal(snapshot.gpus[0].temperature_c, null);
    assert.equal(snapshot.gpus[0].power_w, null);
    assert.ok(
      snapshot.gpus[0].vram_used_mb + snapshot.gpus[0].vram_free_mb <=
        snapshot.gpus[0].vram_total_mb + 1,
    );
  });

  it('fa02.t1.5 probes nvidia-smi CSV output via PATH shim into normalized GpuDevice entries', async (t) => {
    const entry = await getDevicesEntry();
    if (
      !requireDeliverable(
        t,
        Boolean(entry),
        'Pending M2 (Feature #12): platforms/workbench/lib/devices/index.{ts,mjs} not delivered',
      )
    ) {
      return;
    }

    const ws = await createIsolatedWorkspace('fa02-t1-5-');
    t.after(() => ws.cleanup());

    const binDir = path.join(ws.rootDir, 'bin');
    const csv = [
      '0, Mock NVIDIA 24G, 24576, 1024, 23552, 12, 44, 55.5',
      '1, Mock NVIDIA 12G, 12288, 512, 11776, [N/A], 39, [N/A]',
    ].join('\n');
    await installMockCommand(binDir, 'nvidia-smi', csv);
    for (const hostTool of ['powershell', 'amd-smi', 'rocm-smi', 'vulkaninfo']) {
      await installFailingCommand(binDir, hostTool);
    }

    const snapshot = await runDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: undefined,
      HOST_SYS: path.join(ws.rootDir, 'empty-sys'),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    });
    assertHardwareSnapshot(snapshot);
    assert.equal(snapshot.gpus.length, 2);
    assert.equal(snapshot.gpus[0].vendor, 'nvidia');
    assert.equal(snapshot.gpus[0].backend, 'cuda');
    assert.equal(snapshot.gpus[0].vram_total_mb, 24576);
    assert.equal(snapshot.gpus[1].vendor, 'nvidia');
    assert.equal(snapshot.gpus[1].backend, 'cuda');
    assert.equal(snapshot.gpus[1].vram_total_mb, 12288);
    assert.equal(snapshot.gpus[1].utilization_pct, null);
    assert.equal(snapshot.gpus[1].power_w, null);
  });
});
