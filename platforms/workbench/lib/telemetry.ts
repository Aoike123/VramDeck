import type {
  DeviceProvider,
  GpuDevice,
  HardwareSnapshot,
  TelemetrySample,
  TelemetrySeries,
} from './types.ts';

export const TELEMETRY_INTERVAL_MS = 5000;
export const TELEMETRY_CAPACITY = 720;

export function alignTimestampSeconds(ms: number, stepSeconds = 5): number {
  return Math.floor(ms / (stepSeconds * 1000)) * stepSeconds;
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function maxFinite(values: Array<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const val of values) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      max = max === null ? val : Math.max(max, val);
    }
  }
  return max;
}

function escapePromLabel(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export interface ParsedPrometheusLine {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parsePrometheusText(text: string): ParsedPrometheusLine[] {
  const rows: ParsedPrometheusLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (match[2]) {
      const labelRe = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
      let labelMatch: RegExpExecArray | null;
      while ((labelMatch = labelRe.exec(match[2])) !== null) {
        labels[labelMatch[1]] = labelMatch[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    rows.push({ name: match[1], labels, value });
  }
  return rows;
}

export function snapshotToValues(
  snapshot: HardwareSnapshot | null,
  apiStatus: number | null = 1,
  comfyStatus: number | null = null,
): Record<string, number | null> {
  const gpus: GpuDevice[] = snapshot?.gpus ?? [];
  const hasGpus = gpus.length > 0;

  return {
    vram: hasGpus
      ? gpus.reduce((sum, gpu) => sum + (Number(gpu.vram_used_mb) || 0) * 1048576, 0)
      : null,
    vram_total: hasGpus
      ? gpus.reduce((sum, gpu) => sum + (Number(gpu.vram_total_mb) || 0) * 1048576, 0)
      : null,
    gpu: hasGpus ? maxFinite(gpus.map((gpu) => gpu.utilization_pct)) : null,
    temperature: hasGpus ? maxFinite(gpus.map((gpu) => gpu.temperature_c)) : null,
    memory: snapshot?.host ? snapshot.host.ram_free_mb * 1048576 : null,
    memory_total: snapshot?.host ? snapshot.host.ram_total_mb * 1048576 : null,
    api: apiStatus,
    comfy: comfyStatus,
  };
}

export interface RingTelemetryOptions {
  deviceProvider?: DeviceProvider;
  intervalMs?: number;
  capacity?: number;
  now?: () => number;
  isDraining?: () => boolean;
  getHealth?: () => Promise<{ api?: number | null; comfy?: number | null }>;
  getEngineMetrics?: () => Promise<Record<string, number | null>>;
  getVisionMetrics?: () => Promise<Record<string, number | null>>;
}

export class RingTelemetry {
  readonly #deviceProvider?: DeviceProvider;
  readonly #intervalMs: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #isDraining?: () => boolean;
  readonly #getHealth?: () => Promise<{ api?: number | null; comfy?: number | null }>;
  readonly #getEngineMetrics?: () => Promise<Record<string, number | null>>;
  readonly #getVisionMetrics?: () => Promise<Record<string, number | null>>;

  #samples: TelemetrySample[] = [];
  #byTimestamp = new Map<number, TelemetrySample>();
  #latestSnapshot: HardwareSnapshot | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #sampling = false;

  constructor(options: RingTelemetryOptions = {}) {
    this.#deviceProvider = options.deviceProvider;
    this.#intervalMs = options.intervalMs ?? TELEMETRY_INTERVAL_MS;
    this.#capacity = Math.max(1, options.capacity ?? TELEMETRY_CAPACITY);
    this.#now = options.now ?? Date.now;
    this.#isDraining = options.isDraining;
    this.#getHealth = options.getHealth;
    this.#getEngineMetrics = options.getEngineMetrics;
    this.#getVisionMetrics = options.getVisionMetrics;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#samples.length;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.sampleNow();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  record(sample: TelemetrySample, snapshot?: HardwareSnapshot | null): void {
    const cleanValues: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(sample.values)) {
      cleanValues[k] = finiteOrNull(v);
    }
    const normalized: TelemetrySample = {
      timestamp: sample.timestamp,
      values: cleanValues,
    };

    if (snapshot !== undefined) {
      this.#latestSnapshot = snapshot;
    }

    const existingIndex = this.#samples.findIndex((s) => s.timestamp === normalized.timestamp);
    if (existingIndex >= 0) {
      this.#samples[existingIndex] = normalized;
    } else {
      this.#samples.push(normalized);
      if (
        this.#samples.length >= 2 &&
        this.#samples[this.#samples.length - 2].timestamp > normalized.timestamp
      ) {
        this.#samples.sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    this.#byTimestamp.set(normalized.timestamp, normalized);
    while (this.#samples.length > this.#capacity) {
      const evicted = this.#samples.shift();
      if (evicted && this.#byTimestamp.get(evicted.timestamp) === evicted) {
        this.#byTimestamp.delete(evicted.timestamp);
      }
    }
  }

  async sampleNow(): Promise<TelemetrySample> {
    if (this.#sampling) {
      const last = this.#samples.at(-1);
      return (
        last ?? {
          timestamp: alignTimestampSeconds(this.#now(), 5),
          values: snapshotToValues(this.#latestSnapshot, this.#isDraining?.() ? 0 : 1, null),
        }
      );
    }
    this.#sampling = true;
    try {
      const [snapshotRes, healthRes, engineRes, visionRes] = await Promise.allSettled([
        this.#deviceProvider ? this.#deviceProvider.detect() : Promise.resolve(null),
        this.#getHealth ? this.#getHealth() : Promise.resolve({}),
        this.#getEngineMetrics ? this.#getEngineMetrics() : Promise.resolve({}),
        this.#getVisionMetrics ? this.#getVisionMetrics() : Promise.resolve({}),
      ]);

      const snapshot = snapshotRes.status === 'fulfilled' ? snapshotRes.value : null;
      const health: { api?: number | null; comfy?: number | null } =
        healthRes.status === 'fulfilled' ? healthRes.value : {};
      const engine: Record<string, number | null> =
        engineRes.status === 'fulfilled' ? engineRes.value : {};
      const vision: Record<string, number | null> =
        visionRes.status === 'fulfilled' ? visionRes.value : {};

      const apiStatus = health.api !== undefined ? health.api : this.#isDraining?.() ? 0 : 1;
      const comfyStatus = health.comfy !== undefined ? health.comfy : null;

      const values: Record<string, number | null> = {
        ...snapshotToValues(snapshot, apiStatus, comfyStatus),
        ...vision,
        ...engine,
      };

      const sample: TelemetrySample = {
        timestamp: alignTimestampSeconds(this.#now(), 5),
        values,
      };
      this.record(sample, snapshot);
      return sample;
    } finally {
      this.#sampling = false;
    }
  }

  latest(): {
    timestamp: number | null;
    values: Record<string, number | null>;
    snapshot: HardwareSnapshot | null;
  } {
    const last = this.#samples.at(-1) ?? null;
    return {
      timestamp: last?.timestamp ?? null,
      values: last ? { ...last.values } : {},
      snapshot: this.#latestSnapshot,
    };
  }

  series(
    metric: string,
    minutes: number,
    nowSeconds = alignTimestampSeconds(this.#now(), 5),
  ): TelemetrySeries | null {
    if (!this.#samples.length) return null;
    const totalPoints = minutes * 12 + 1;
    const start = nowSeconds - minutes * 60;
    const points: Array<[number, number | null]> = [];

    for (let i = 0; i < totalPoints; i++) {
      const t = start + i * 5;
      const sample = this.#byTimestamp.get(t);
      const val = sample ? finiteOrNull(sample.values[metric]) : null;
      points.push([t, val]);
    }

    return { metric, points };
  }

  prometheus(): string {
    const lines: string[] = [];
    const snap = this.#latestSnapshot;
    const latestValues = this.#samples.at(-1)?.values ?? {};

    if (snap) {
      lines.push(`lab_gpu_devices ${snap.gpus.length}`);
      for (const gpu of snap.gpus) {
        const labels = `{id="${escapePromLabel(gpu.id)}",index="${gpu.index}",vendor="${escapePromLabel(gpu.vendor)}",backend="${escapePromLabel(gpu.backend)}",name="${escapePromLabel(gpu.name)}"}`;
        lines.push(`lab_gpu_info${labels} 1`);
        lines.push(
          `lab_gpu_vram_used_bytes{id="${escapePromLabel(gpu.id)}",vendor="${escapePromLabel(gpu.vendor)}"} ${gpu.vram_used_mb * 1048576}`,
        );
        lines.push(
          `lab_gpu_vram_total_bytes{id="${escapePromLabel(gpu.id)}",vendor="${escapePromLabel(gpu.vendor)}"} ${gpu.vram_total_mb * 1048576}`,
        );
        if (gpu.utilization_pct !== null) {
          lines.push(
            `lab_gpu_busy_percent{id="${escapePromLabel(gpu.id)}",vendor="${escapePromLabel(gpu.vendor)}"} ${gpu.utilization_pct}`,
          );
        }
        if (gpu.temperature_c !== null) {
          lines.push(
            `lab_gpu_temperature_celsius{id="${escapePromLabel(gpu.id)}",vendor="${escapePromLabel(gpu.vendor)}"} ${gpu.temperature_c}`,
          );
        }
        if (gpu.power_w !== null) {
          lines.push(
            `lab_gpu_power_watts{id="${escapePromLabel(gpu.id)}",vendor="${escapePromLabel(gpu.vendor)}"} ${gpu.power_w}`,
          );
        }
      }
      lines.push(`lab_host_memory_available_bytes ${snap.host.ram_free_mb * 1048576}`);
      lines.push(`lab_host_memory_total_bytes ${snap.host.ram_total_mb * 1048576}`);
    }

    const api = latestValues.api ?? (this.#isDraining?.() ? 0 : 1);
    if (api !== null) {
      lines.push(`lab_platform_health{service="gateway"} ${api}`);
    }
    if (latestValues.comfy !== null && latestValues.comfy !== undefined) {
      lines.push(`lab_platform_health{service="comfyui"} ${latestValues.comfy}`);
    }

    return lines.length ? lines.join('\n') + '\n' : '';
  }
}
