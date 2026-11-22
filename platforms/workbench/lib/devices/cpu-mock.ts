import type {
  ComputeBackend,
  DeviceProvider,
  GpuDevice,
  GpuVendor,
  HardwareSnapshot,
} from '../types.ts';
import { finiteOrNull, nonNegFinite, readHostResources } from './host.ts';
import type { EnvMap } from './host.ts';

const VALID_VENDORS = new Set<GpuVendor>(['nvidia', 'amd', 'apple', 'intel', 'cpu']);
const VALID_BACKENDS = new Set<ComputeBackend>(['cuda', 'rocm', 'metal', 'vulkan', 'cpu']);

function inferBackend(vendor: GpuVendor): ComputeBackend {
  switch (vendor) {
    case 'nvidia':
      return 'cuda';
    case 'amd':
      return 'rocm';
    case 'apple':
      return 'metal';
    case 'intel':
      return 'vulkan';
    default:
      return 'cpu';
  }
}

function inferVendor(backend: ComputeBackend): GpuVendor {
  switch (backend) {
    case 'cuda':
      return 'nvidia';
    case 'rocm':
      return 'amd';
    case 'metal':
      return 'apple';
    case 'vulkan':
      return 'amd';
    default:
      return 'cpu';
  }
}

export function parseMockGpus(raw: string | undefined): GpuDevice[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const gpus: GpuDevice[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const rawVendor = typeof item.vendor === 'string' ? item.vendor.toLowerCase() : '';
    const rawBackend = typeof item.backend === 'string' ? item.backend.toLowerCase() : '';

    let vendor: GpuVendor;
    let backend: ComputeBackend;
    if (VALID_VENDORS.has(rawVendor as GpuVendor)) {
      vendor = rawVendor as GpuVendor;
      backend = VALID_BACKENDS.has(rawBackend as ComputeBackend)
        ? (rawBackend as ComputeBackend)
        : inferBackend(vendor);
    } else if (VALID_BACKENDS.has(rawBackend as ComputeBackend)) {
      backend = rawBackend as ComputeBackend;
      vendor = inferVendor(backend);
    } else {
      vendor = 'cpu';
      backend = 'cpu';
    }

    const index =
      typeof item.index === 'number' && Number.isInteger(item.index) && item.index >= 0
        ? item.index
        : gpus.length;
    const id =
      typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : `${vendor}:${index}`;
    const name =
      typeof item.name === 'string' && item.name.trim() !== ''
        ? item.name.trim()
        : `Mock ${vendor.toUpperCase()} GPU ${index}`;

    const totalMb = Math.round(nonNegFinite(item.vram_total_mb, 0));
    const rawUsedMb = Math.round(nonNegFinite(item.vram_used_mb, 0));
    const usedMb = totalMb > 0 ? Math.min(rawUsedMb, totalMb) : rawUsedMb;
    const freeParsed = finiteOrNull(item.vram_free_mb);
    const freeMb =
      freeParsed !== null && freeParsed >= 0
        ? totalMb > 0
          ? Math.min(Math.round(freeParsed), Math.max(0, totalMb - usedMb))
          : Math.round(freeParsed)
        : Math.max(0, totalMb - usedMb);

    const rawUtil = finiteOrNull(item.utilization_pct);
    const utilizationPct = rawUtil !== null && rawUtil >= 0 ? Math.min(100, rawUtil) : null;
    const rawPower = finiteOrNull(item.power_w);
    const powerW = rawPower !== null && rawPower >= 0 ? rawPower : null;

    gpus.push({
      id,
      index,
      vendor,
      backend,
      name,
      unified_memory: Boolean(item.unified_memory),
      vram_total_mb: totalMb,
      vram_used_mb: usedMb,
      vram_free_mb: freeMb,
      utilization_pct: utilizationPct,
      temperature_c: finiteOrNull(item.temperature_c),
      power_w: powerW,
    });
  }
  return gpus;
}

export function dedupeGpuDevices(list: GpuDevice[]): GpuDevice[] {
  const gpus: GpuDevice[] = [];
  const seenIds = new Set<string>();
  for (const gpu of list) {
    const index = gpus.length;
    let id = gpu.id;
    if (seenIds.has(id)) {
      id = `${gpu.vendor}:${index}`;
      let suffix = 1;
      while (seenIds.has(id)) {
        id = `${gpu.vendor}:${index}:${suffix++}`;
      }
    }
    seenIds.add(id);
    gpus.push({ ...gpu, id, index });
  }
  return gpus;
}

export class CpuMockDeviceProvider implements DeviceProvider {
  readonly id = 'cpu-mock';
  readonly #env: EnvMap;
  readonly #platform: NodeJS.Platform;

  constructor(options: { env?: EnvMap; platform?: NodeJS.Platform } = {}) {
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
  }

  async detect(): Promise<HardwareSnapshot> {
    const host = await readHostResources({ platform: this.#platform });
    const gpus = dedupeGpuDevices(parseMockGpus(this.#env.WORKBENCH_MOCK_GPUS) ?? []);
    return {
      collected_at: Date.now(),
      host,
      gpus,
    };
  }
}
