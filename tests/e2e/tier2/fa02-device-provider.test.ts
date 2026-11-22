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

async function invokeDeviceProbe(
  entryRel: string,
  envOverrides: Record<string, string | undefined>,
  timeoutMs = 15_000,
) {
  const entryUrl = pathToFileURL(path.join(REPO_ROOT, entryRel)).href;
  const script = [
    `const mod = await import(${JSON.stringify(entryUrl)});`,
    `const detect = mod.detectHardware`,
    `  ? () => mod.detectHardware()`,
    `  : mod.createDeviceProvider`,
    `    ? () => mod.createDeviceProvider().detect()`,
    `    : mod.defaultDeviceProvider`,
    `      ? () => mod.defaultDeviceProvider().detect()`,
    `      : () => mod.deviceProvider.detect();`,
    `const snapshot = await detect();`,
    `console.log(JSON.stringify(snapshot));`,
  ].join('\n');

  return runCommand(resolveNode22Plus(), ['--input-type=module', '-e', script], {
    env: envOverrides,
    timeoutMs,
  });
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

describe('FA2 Tier 2: DeviceProvider boundary & negative error handling', () => {
  it('fa02.t2.1 degrades gracefully when vendor CLI binaries are absent from PATH', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa02-t2-1-');
    t.after(() => ws.cleanup());
    const emptyBin = path.join(ws.rootDir, 'empty-bin');
    await mkdir(emptyBin, { recursive: true });

    const res = await invokeDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: undefined,
      PATH: emptyBin,
    });
    assert.equal(res.code, 0, res.stderr);
    const snapshot = JSON.parse(res.stdout.trim()) as HardwareSnapshot;
    assertHardwareSnapshot(snapshot);
  });

  it('fa02.t2.2 normalizes [N/A] and Not Supported telemetry fields safely to null', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa02-t2-2-');
    t.after(() => ws.cleanup());

    const binDir = path.join(ws.rootDir, 'bin');
    await installMockCommand(
      binDir,
      'nvidia-smi',
      '0, Mock NVIDIA Quirk, 16384, 512, 15872, [N/A], Not Supported, [N/A]',
    );
    for (const hostTool of ['powershell', 'amd-smi', 'rocm-smi', 'vulkaninfo']) {
      await installFailingCommand(binDir, hostTool);
    }

    const res = await invokeDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: undefined,
      HOST_SYS: path.join(ws.rootDir, 'empty-sys'),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    });
    assert.equal(res.code, 0, res.stderr);
    const snapshot = JSON.parse(res.stdout.trim()) as HardwareSnapshot;
    assertHardwareSnapshot(snapshot);
    assert.equal(snapshot.gpus.length, 1);
    assert.equal(snapshot.gpus[0].vendor, 'nvidia');
    assert.equal(snapshot.gpus[0].utilization_pct, null);
    assert.equal(snapshot.gpus[0].temperature_c, null);
    assert.equal(snapshot.gpus[0].power_w, null);
  });

  it('fa02.t2.3 handles malformed WORKBENCH_MOCK_GPUS deterministically without NaN GPUs', async (t) => {
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

    for (const badValue of ['{not-json', '{}', JSON.stringify([{ vram_total_mb: -1 }])]) {
      const res = await invokeDeviceProbe(entry!, {
        WORKBENCH_MOCK_GPUS: badValue,
      });
      if (res.code === 0) {
        const snapshot = JSON.parse(res.stdout.trim()) as HardwareSnapshot;
        assertHardwareSnapshot(snapshot);
      } else {
        assert.ok(res.stderr.trim().length > 0, 'Failure must include diagnostic error');
      }
    }
  });

  it('fa02.t2.4 clamps zero-free-VRAM / 100%-utilized GPU boundary cleanly', async (t) => {
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

    const fullGpu = createMockGpuDevice({
      vram_total_mb: 16384,
      vram_used_mb: 16384,
      vram_free_mb: 0,
      utilization_pct: 100,
    });
    const res = await invokeDeviceProbe(entry!, {
      WORKBENCH_MOCK_GPUS: JSON.stringify([fullGpu]),
    });
    assert.equal(res.code, 0, res.stderr);
    const snapshot = JSON.parse(res.stdout.trim()) as HardwareSnapshot;
    assertHardwareSnapshot(snapshot);
    assert.equal(snapshot.gpus[0].vram_free_mb, 0);
    assert.equal(snapshot.gpus[0].utilization_pct, 100);
  });

  it('fa02.t2.5 bounds slow/hanging vendor CLI probes within probe timeout without hanging', async (t) => {
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

    const ws = await createIsolatedWorkspace('fa02-t2-5-');
    t.after(() => ws.cleanup());
    const binDir = path.join(ws.rootDir, 'slow-bin');
    await mkdir(binDir, { recursive: true });

    const sleeperJs = path.join(binDir, 'nvidia-smi.mjs');
    await writeFile(sleeperJs, 'setTimeout(() => {}, 60000);\n', 'utf8');
    if (process.platform === 'win32') {
      await writeFile(
        path.join(binDir, 'nvidia-smi.cmd'),
        `@echo off\r\n"${resolveNode22Plus()}" "${sleeperJs}" %*\r\n`,
        'utf8',
      );
    } else {
      const shPath = path.join(binDir, 'nvidia-smi');
      await writeFile(shPath, `#!/bin/sh\nexec "${resolveNode22Plus()}" "${sleeperJs}"\n`, 'utf8');
      await chmod(shPath, 0o755);
    }

    const res = await invokeDeviceProbe(
      entry!,
      {
        WORKBENCH_MOCK_GPUS: undefined,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      12_000,
    );
    assert.equal(res.code, 0, res.stderr);
    const snapshot = JSON.parse(res.stdout.trim()) as HardwareSnapshot;
    assertHardwareSnapshot(snapshot);
  });
});
