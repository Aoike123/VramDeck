import { totalmem } from 'node:os';
import type { DeviceProvider, GpuDevice, HardwareSnapshot } from '../types.ts';
import { execTool, readHostResources } from './host.ts';
import type { EnvMap, ExecToolFn } from './host.ts';

export interface UnifiedMemoryStats {
  vram_total_mb: number;
  vram_used_mb: number;
  vram_free_mb: number;
}

export function parseVmStat(
  vmStatText: string,
  totalMemBytes: number,
  budgetRatio = 0.75,
  arch: string = process.arch,
): UnifiedMemoryStats {
  const pageMatch = /page size of (\d+) bytes/i.exec(vmStatText);
  const pageSize = pageMatch ? Number.parseInt(pageMatch[1], 10) : arch === 'arm64' ? 16384 : 4096;

  const readPages = (label: string): number => {
    const match = new RegExp(`^${label}:\\s*(\\d+)`, 'mi').exec(vmStatText);
    return match ? Number.parseInt(match[1], 10) : 0;
  };

  const freePages =
    readPages('Pages free') + readPages('Pages inactive') + readPages('Pages speculative');
  const availableBytes = freePages * pageSize;

  const safeTotal = Number.isFinite(totalMemBytes) && totalMemBytes > 0 ? totalMemBytes : 0;
  const vramTotalMb = Math.round((safeTotal * budgetRatio) / 1048576);
  const vramFreeMb = Math.min(vramTotalMb, Math.max(0, Math.round(availableBytes / 1048576)));
  const vramUsedMb = Math.max(0, vramTotalMb - vramFreeMb);

  return {
    vram_total_mb: vramTotalMb,
    vram_used_mb: vramUsedMb,
    vram_free_mb: vramFreeMb,
  };
}

function parseDiscreteVramMb(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const match = /([\d.]+)\s*(GB|GiB|MB|MiB)/i.exec(raw);
  if (!match) return 0;
  const val = Number.parseFloat(match[1]);
  if (!Number.isFinite(val) || val < 0) return 0;
  return match[2].toLowerCase().startsWith('g') ? Math.round(val * 1024) : Math.round(val);
}

export function parseSystemProfilerDisplays(
  jsonText: string,
  memStats: UnifiedMemoryStats,
): GpuDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const displays = (parsed as { SPDisplaysDataType?: unknown }).SPDisplaysDataType;
  if (!Array.isArray(displays)) return [];

  const gpus: GpuDevice[] = [];
  for (const item of displays) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.sppci_model ?? rec._name ?? 'Apple GPU').trim();
    const vendorStr = String(rec.spdisplays_vendor ?? '').toLowerCase();
    const isAppleSilicon = name.toLowerCase().startsWith('apple') || vendorStr.includes('apple');
    const isAmd =
      !isAppleSilicon &&
      (vendorStr.includes('amd') ||
        vendorStr.includes('0x1002') ||
        name.toLowerCase().includes('radeon'));

    if (!isAppleSilicon && !isAmd) continue;

    const index = gpus.length;
    if (isAppleSilicon) {
      gpus.push({
        id: `apple:${index}`,
        index,
        vendor: 'apple',
        backend: 'metal',
        name,
        unified_memory: true,
        vram_total_mb: memStats.vram_total_mb,
        vram_used_mb: memStats.vram_used_mb,
        vram_free_mb: memStats.vram_free_mb,
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
      });
    } else {
      const vramMb = parseDiscreteVramMb(rec.spdisplays_vram ?? rec.spdisplays_vram_shared);
      gpus.push({
        id: `amd:${index}`,
        index,
        vendor: 'amd',
        backend: 'metal',
        name,
        unified_memory: false,
        vram_total_mb: vramMb,
        vram_used_mb: 0,
        vram_free_mb: vramMb,
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
      });
    }
  }
  return gpus;
}

export interface AppleProviderOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  exec?: ExecToolFn;
  env?: EnvMap;
  budgetRatio?: number;
}

export class AppleDeviceProvider implements DeviceProvider {
  readonly id = 'apple';
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #exec: ExecToolFn;
  readonly #env: EnvMap;
  readonly #budgetRatio: number;

  constructor(options: AppleProviderOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.#exec = options.exec ?? execTool;
    this.#env = options.env ?? process.env;
    this.#budgetRatio = options.budgetRatio ?? 0.75;
  }

  async detect(): Promise<HardwareSnapshot> {
    const host = await readHostResources({ platform: this.#platform, arch: this.#arch });
    if (this.#platform !== 'darwin') {
      return { collected_at: Date.now(), host, gpus: [] };
    }

    let gpus: GpuDevice[] = [];
    try {
      const [profilerRes, sysctlRes, vmStatRes] = await Promise.allSettled([
        this.#exec('system_profiler', ['SPDisplaysDataType', '-json'], {
          platform: this.#platform,
          env: this.#env,
        }),
        this.#exec('sysctl', ['-n', 'hw.memsize'], {
          platform: this.#platform,
          env: this.#env,
        }),
        this.#exec('vm_stat', [], {
          platform: this.#platform,
          env: this.#env,
        }),
      ]);

      const hwMem =
        sysctlRes.status === 'fulfilled' ? Number.parseInt(sysctlRes.value.stdout.trim(), 10) : NaN;
      const totalMemBytes = Number.isFinite(hwMem) && hwMem > 0 ? hwMem : totalmem();
      const vmStatText = vmStatRes.status === 'fulfilled' ? vmStatRes.value.stdout : '';
      const memStats = parseVmStat(vmStatText, totalMemBytes, this.#budgetRatio, this.#arch);

      if (profilerRes.status === 'fulfilled') {
        gpus = parseSystemProfilerDisplays(profilerRes.value.stdout, memStats);
      }
    } catch {
      gpus = [];
    }

    return {
      collected_at: Date.now(),
      host,
      gpus,
    };
  }
}
