import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RingTelemetry,
  TELEMETRY_CAPACITY,
  alignTimestampSeconds,
  parsePrometheusText,
} from '../lib/telemetry.ts';
import type { DeviceProvider } from '../lib/types.ts';

test('RingTelemetry wraps at capacity 720 and preserves 5s-aligned grid with null gaps', () => {
  let fakeNowMs = 1_700_000_000_000;
  const ring = new RingTelemetry({
    capacity: TELEMETRY_CAPACITY,
    now: () => fakeNowMs,
  });

  // Push 725 samples (5s apart) -> should evict first 5
  const baseSec = alignTimestampSeconds(fakeNowMs, 5);
  for (let i = 0; i < 725; i++) {
    const t = baseSec + i * 5;
    ring.record({
      timestamp: t,
      values: { gpu: i % 100, vram: i * 1024 },
    });
  }

  assert.equal(ring.size, 720);
  const endSec = baseSec + 724 * 5;

  const series60 = ring.series('gpu', 60, endSec);
  assert.ok(series60);
  assert.equal(series60.points.length, 721); // 60 * 12 + 1
  // Oldest 5 samples (0..4) were evicted; at endSec, window start is i=4 -> null, and i=5 -> 5
  assert.equal(series60.points[0][1], null);
  assert.equal(series60.points[1][1], 5);
  assert.equal(series60.points.at(-1)?.[0], endSec);
  assert.equal(series60.points.at(-1)?.[1], 724 % 100);

  const series15 = ring.series('gpu', 15, endSec);
  assert.ok(series15);
  assert.equal(series15.points.length, 181);

  const series30 = ring.series('gpu', 30, endSec);
  assert.ok(series30);
  assert.equal(series30.points.length, 361);
});

test('RingTelemetry returns null series when no samples exist and preserves missing slots as null', () => {
  const ring = new RingTelemetry({ now: () => 1_700_000_000_000 });
  assert.equal(ring.series('gpu', 15), null);

  const nowSec = 1_700_000_000;
  ring.record({ timestamp: nowSec - 10, values: { output: 12 } });
  ring.record({ timestamp: nowSec, values: { output: 0 } });

  const s = ring.series('output', 15, nowSec);
  assert.ok(s);
  assert.equal(s.points.length, 181);
  assert.deepEqual(s.points.slice(-3), [
    [nowSec - 10, 12],
    [nowSec - 5, null],
    [nowSec, 0],
  ]);
});

test('RingTelemetry sampleNow aggregates hardware, handles 0 GPUs without zeroing vram, and exports Prometheus text', async () => {
  let draining = false;
  const mockProvider: DeviceProvider = {
    id: 'mock',
    async detect() {
      return {
        collected_at: Date.now(),
        host: { os: 'linux', arch: 'x64', ram_total_mb: 65536, ram_free_mb: 32768 },
        gpus: [
          {
            id: 'nvidia:0',
            index: 0,
            vendor: 'nvidia',
            backend: 'cuda',
            name: 'RTX 4090',
            unified_memory: false,
            vram_total_mb: 24576,
            vram_used_mb: 4096,
            vram_free_mb: 20480,
            utilization_pct: 30,
            temperature_c: 55,
            power_w: 110,
          },
          {
            id: 'amd:1',
            index: 1,
            vendor: 'amd',
            backend: 'rocm',
            name: 'Radeon R9700',
            unified_memory: false,
            vram_total_mb: 32768,
            vram_used_mb: 2048,
            vram_free_mb: 30720,
            utilization_pct: 65,
            temperature_c: 62,
            power_w: 90,
          },
        ],
      };
    },
  };

  const ring = new RingTelemetry({
    deviceProvider: mockProvider,
    now: () => 1_700_000_000_000,
    isDraining: () => draining,
    getEngineMetrics: async () => ({ output: 42.5, running: 2 }),
  });

  const sample = await ring.sampleNow();
  assert.equal(sample.values.vram, (4096 + 2048) * 1048576);
  assert.equal(sample.values.vram_total, (24576 + 32768) * 1048576);
  assert.equal(sample.values.gpu, 65);
  assert.equal(sample.values.temperature, 62);
  assert.equal(sample.values.memory, 32768 * 1048576);
  assert.equal(sample.values.api, 1);
  assert.equal(sample.values.output, 42.5);
  assert.equal(sample.values.running, 2);

  const promText = ring.prometheus();
  assert.match(promText, /lab_gpu_devices 2/);
  assert.match(promText, /lab_gpu_info\{id="nvidia:0".*name="RTX 4090"\} 1/);
  assert.match(promText, /lab_platform_health\{service="gateway"\} 1/);

  const parsed = parsePrometheusText(promText);
  assert.equal(parsed.find((p) => p.name === 'lab_gpu_devices')?.value, 2);

  // 0 GPUs must keep vram and vram_total as null (never 0)
  draining = true;
  const zeroRing = new RingTelemetry({
    deviceProvider: {
      id: 'empty',
      async detect() {
        return {
          collected_at: Date.now(),
          host: { os: 'win32', arch: 'x64', ram_total_mb: 16384, ram_free_mb: 8192 },
          gpus: [],
        };
      },
    },
    isDraining: () => draining,
  });

  const zeroSample = await zeroRing.sampleNow();
  assert.equal(zeroSample.values.vram, null);
  assert.equal(zeroSample.values.vram_total, null);
  assert.equal(zeroSample.values.gpu, null);
  assert.equal(zeroSample.values.api, 0);
});
