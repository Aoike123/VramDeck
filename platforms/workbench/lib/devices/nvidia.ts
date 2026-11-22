import type { DeviceProvider, GpuDevice, HardwareSnapshot } from '../types.ts';
import { execTool, finiteOrNull, nonNegFinite, readHostResources } from './host.ts';
import type { EnvMap, ExecToolFn } from './host.ts';

const QUERY_FIELDS = [
  'index',
  'name',
  'memory.total',
  'memory.used',
  'memory.free',
  'utilization.gpu',
  'temperature.gpu',
  'power.draw',
].join(',');

const NA_RE = /^(\[?n\/a\]?|\[?not supported\]?|err!?|null|nan)$/i;

function parseOptionalField(raw: string | undefined): number | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || NA_RE.test(trimmed)) return null;
  return finiteOrNull(trimmed);
}

export function parseNvidiaSmiCsv(stdout: string): GpuDevice[] {
  const gpus: GpuDevice[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 8) continue;

    const index = Number.parseInt(parts[0].trim(), 10);
    if (!Number.isInteger(index) || index < 0) continue;

    const tail = parts.slice(-6);
    const name =
      parts
        .slice(1, parts.length - 6)
        .join(',')
        .trim() || 'NVIDIA GPU';

    const totalMb = Math.round(nonNegFinite(parseOptionalField(tail[0]), 0));
    const usedMb = Math.round(nonNegFinite(parseOptionalField(tail[1]), 0));
    const freeParsed = parseOptionalField(tail[2]);
    const freeMb =
      freeParsed !== null && freeParsed >= 0
        ? Math.round(freeParsed)
        : Math.max(0, totalMb - usedMb);

    gpus.push({
      id: `nvidia:${index}`,
      index,
      vendor: 'nvidia',
      backend: 'cuda',
      name,
      unified_memory: false,
      vram_total_mb: totalMb,
      vram_used_mb: usedMb,
      vram_free_mb: freeMb,
      utilization_pct: parseOptionalField(tail[3]),
      temperature_c: parseOptionalField(tail[4]),
      power_w: parseOptionalField(tail[5]),
    });
  }
  return gpus;
}

export interface NvidiaProviderOptions {
  exec?: ExecToolFn;
  platform?: NodeJS.Platform;
  wslBinary?: string;
  env?: EnvMap;
}

export class NvidiaDeviceProvider implements DeviceProvider {
  readonly id = 'nvidia';
  readonly #exec: ExecToolFn;
  readonly #platform: NodeJS.Platform;
  readonly #wslBinary: string;
  readonly #env: EnvMap;

  constructor(options: NvidiaProviderOptions = {}) {
    this.#exec = options.exec ?? execTool;
    this.#platform = options.platform ?? process.platform;
    this.#wslBinary = options.wslBinary ?? '/usr/lib/wsl/lib/nvidia-smi';
    this.#env = options.env ?? process.env;
  }

  async detect(): Promise<HardwareSnapshot> {
    const host = await readHostResources({ platform: this.#platform });
    const args = [`--query-gpu=${QUERY_FIELDS}`, '--format=csv,noheader,nounits'];
    let gpus: GpuDevice[] = [];

    try {
      const { stdout } = await this.#exec('nvidia-smi', args, {
        platform: this.#platform,
        env: this.#env,
      });
      gpus = parseNvidiaSmiCsv(stdout);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (this.#platform === 'linux' && (code === 'ENOENT' || code === 'EACCES')) {
        try {
          const { stdout } = await this.#exec(this.#wslBinary, args, {
            platform: this.#platform,
            env: this.#env,
          });
          gpus = parseNvidiaSmiCsv(stdout);
        } catch {
          gpus = [];
        }
      }
    }

    return {
      collected_at: Date.now(),
      host,
      gpus,
    };
  }
}
