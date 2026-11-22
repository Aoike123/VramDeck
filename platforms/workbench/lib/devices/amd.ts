import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeviceProvider, GpuDevice, HardwareSnapshot } from '../types.ts';
import { execTool, finiteOrNull, nonNegFinite, readHostResources } from './host.ts';
import type { EnvMap, ExecToolFn } from './host.ts';

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readHwmonTelemetry(
  deviceDir: string,
): Promise<{ temperature_c: number | null; power_w: number | null }> {
  let temperatureC: number | null = null;
  let powerW: number | null = null;
  const hwmonRoot = join(deviceDir, 'hwmon');

  let entries: string[];
  try {
    entries = await readdir(hwmonRoot);
  } catch {
    return { temperature_c: null, power_w: null };
  }

  for (const name of entries.sort()) {
    if (!name.startsWith('hwmon')) continue;
    const hwDir = join(hwmonRoot, name);
    let files: string[];
    try {
      files = await readdir(hwDir);
    } catch {
      continue;
    }

    if (temperatureC === null) {
      const tempFiles = files.filter((f) => /^temp\d+_input$/.test(f)).sort();
      for (const file of tempFiles) {
        const raw = await readTrimmed(join(hwDir, file));
        const val = finiteOrNull(raw);
        if (val !== null) {
          temperatureC = val / 1000;
          break;
        }
      }
    }

    if (powerW === null) {
      for (const powerFile of ['power1_average', 'power1_input']) {
        if (!files.includes(powerFile)) continue;
        const raw = await readTrimmed(join(hwDir, powerFile));
        const val = finiteOrNull(raw);
        if (val !== null) {
          powerW = val / 1_000_000;
          break;
        }
      }
    }

    if (temperatureC !== null && powerW !== null) break;
  }

  return { temperature_c: temperatureC, power_w: powerW };
}

export interface AmdSysfsResult {
  gpus: GpuDevice[];
  hasSuspendedAmd: boolean;
}

export async function probeAmdSysfsWithMeta(
  sysRoot = process.env.HOST_SYS || '/sys',
): Promise<AmdSysfsResult> {
  const drmDir = join(sysRoot, 'class', 'drm');
  let entries: string[];
  try {
    entries = await readdir(drmDir);
  } catch {
    return { gpus: [], hasSuspendedAmd: false };
  }

  const cards = entries
    .map((name) => {
      const match = /^card(\d+)$/.exec(name);
      return match ? { name, index: Number.parseInt(match[1], 10) } : null;
    })
    .filter((item): item is { name: string; index: number } => item !== null)
    .sort((a, b) => a.index - b.index);

  const gpus: GpuDevice[] = [];
  let hasSuspendedAmd = false;

  for (const card of cards) {
    const deviceDir = join(drmDir, card.name, 'device');
    const vendor = (await readTrimmed(join(deviceDir, 'vendor')))?.toLowerCase();
    if (vendor !== '0x1002') continue;

    const runtimeStatus = (
      await readTrimmed(join(deviceDir, 'power', 'runtime_status'))
    )?.toLowerCase();
    const isSuspended = runtimeStatus === 'suspended';
    if (isSuspended) hasSuspendedAmd = true;

    const productName = await readTrimmed(join(deviceDir, 'product_name'));
    const deviceId = await readTrimmed(join(deviceDir, 'device'));
    const name = productName || (deviceId ? `AMD Radeon GPU (${deviceId})` : 'AMD Radeon GPU');

    const totalBytes = finiteOrNull(await readTrimmed(join(deviceDir, 'mem_info_vram_total')));
    const totalMb = totalBytes !== null && totalBytes >= 0 ? Math.round(totalBytes / 1048576) : 0;

    if (isSuspended) {
      // Strictly never touch metrics or invoke rocm-smi on a runtime-suspended GPU.
      gpus.push({
        id: `amd:${card.index}`,
        index: card.index,
        vendor: 'amd',
        backend: 'rocm',
        name,
        unified_memory: false,
        vram_total_mb: totalMb,
        vram_used_mb: 0,
        vram_free_mb: totalMb,
        utilization_pct: null,
        temperature_c: null,
        power_w: null,
      });
      continue;
    }

    const usedBytes = finiteOrNull(await readTrimmed(join(deviceDir, 'mem_info_vram_used')));
    const usedMb = usedBytes !== null && usedBytes >= 0 ? Math.round(usedBytes / 1048576) : 0;
    const freeMb = Math.max(0, totalMb - usedMb);

    const busyRaw = finiteOrNull(await readTrimmed(join(deviceDir, 'gpu_busy_percent')));
    const utilizationPct = busyRaw !== null && busyRaw >= 0 && busyRaw <= 100 ? busyRaw : null;
    const { temperature_c, power_w } = await readHwmonTelemetry(deviceDir);

    gpus.push({
      id: `amd:${card.index}`,
      index: card.index,
      vendor: 'amd',
      backend: 'rocm',
      name,
      unified_memory: false,
      vram_total_mb: totalMb,
      vram_used_mb: usedMb,
      vram_free_mb: freeMb,
      utilization_pct: utilizationPct,
      temperature_c,
      power_w,
    });
  }

  return { gpus, hasSuspendedAmd };
}

export async function probeAmdSysfs(
  sysRoot = process.env.HOST_SYS || '/sys',
): Promise<GpuDevice[]> {
  return (await probeAmdSysfsWithMeta(sysRoot)).gpus;
}

export function parseRocmSmiJson(jsonText: string): GpuDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const gpus: GpuDevice[] = [];
  for (const [key, raw] of Object.entries(parsed)) {
    const match = /^card(\d+)$/i.exec(key);
    if (!match || !raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const index = Number.parseInt(match[1], 10);

    const name = String(
      rec['Card series'] ?? rec['Card model'] ?? rec['Product Name'] ?? 'AMD Radeon GPU',
    ).trim();

    const totalBytes = finiteOrNull(rec['VRAM Total Memory (B)']);
    const usedBytes = finiteOrNull(rec['VRAM Total Used Memory (B)']);
    const totalMb = totalBytes !== null && totalBytes >= 0 ? Math.round(totalBytes / 1048576) : 0;
    const usedMb = usedBytes !== null && usedBytes >= 0 ? Math.round(usedBytes / 1048576) : 0;
    const freeMb = Math.max(0, totalMb - usedMb);

    const util = finiteOrNull(rec['GPU use (%)']);
    const temp = finiteOrNull(
      rec['Temperature (Sensor edge) (C)'] ?? rec['Temperature (Sensor junction) (C)'],
    );
    const power = finiteOrNull(rec['Average Graphics Package Power (W)']);

    gpus.push({
      id: `amd:${index}`,
      index,
      vendor: 'amd',
      backend: 'rocm',
      name: name || 'AMD Radeon GPU',
      unified_memory: false,
      vram_total_mb: totalMb,
      vram_used_mb: usedMb,
      vram_free_mb: freeMb,
      utilization_pct: util,
      temperature_c: temp,
      power_w: power,
    });
  }
  return gpus.sort((a, b) => a.index - b.index);
}

export function parseAmdSmiJson(jsonText: string): GpuDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { gpu_data?: unknown }).gpu_data)
      ? (parsed as { gpu_data: unknown[] }).gpu_data
      : [];

  const gpus: GpuDevice[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const index = Number.isInteger(rec.gpu) && (rec.gpu as number) >= 0 ? (rec.gpu as number) : i;
    const asic = (rec.asic && typeof rec.asic === 'object' ? rec.asic : {}) as Record<
      string,
      unknown
    >;
    const vram = (rec.vram && typeof rec.vram === 'object' ? rec.vram : {}) as Record<
      string,
      unknown
    >;
    const usage = (rec.usage && typeof rec.usage === 'object' ? rec.usage : {}) as Record<
      string,
      unknown
    >;
    const temp = (
      rec.temperature && typeof rec.temperature === 'object' ? rec.temperature : {}
    ) as Record<string, unknown>;
    const power = (rec.power && typeof rec.power === 'object' ? rec.power : {}) as Record<
      string,
      unknown
    >;

    const totalMb = Math.round(nonNegFinite(vram.size ?? vram.total, 0));
    const usedMb = Math.round(nonNegFinite(vram.used, 0));
    const name = String(asic.market_name ?? asic.asic_name ?? 'AMD Radeon GPU').trim();

    gpus.push({
      id: `amd:${index}`,
      index,
      vendor: 'amd',
      backend: 'rocm',
      name: name || 'AMD Radeon GPU',
      unified_memory: false,
      vram_total_mb: totalMb,
      vram_used_mb: usedMb,
      vram_free_mb: Math.max(0, totalMb - usedMb),
      utilization_pct: finiteOrNull(usage.gfx_activity),
      temperature_c: finiteOrNull(temp.edge ?? temp.hotspot),
      power_w: finiteOrNull(power.socket_power),
    });
  }
  return gpus;
}

function parseQwMemorySize(value: unknown): number | null {
  const direct = finiteOrNull(value);
  if (direct !== null) return direct;
  if (
    Array.isArray(value) &&
    (value.length === 4 || value.length === 8) &&
    value.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    let bytes = 0n;
    for (let i = value.length - 1; i >= 0; i--) {
      bytes = (bytes << 8n) | BigInt(value[i]);
    }
    const num = Number(bytes);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

export function parseWindowsAmdCimJson(jsonText: string): GpuDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : [];
  const gpus: GpuDevice[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const pnp = String(rec.PNPDeviceID ?? '');
    const name = String(rec.Name ?? 'AMD Radeon GPU').trim();
    const isAmd = /VEN_1002/i.test(pnp) || (!pnp && /\b(amd|radeon)\b/i.test(name));
    if (!isAmd) continue;

    const qwMem = parseQwMemorySize(rec.QwMemorySize);
    const adapterRam = finiteOrNull(rec.AdapterRAM);
    const bytes =
      qwMem !== null && qwMem > 0 ? qwMem : adapterRam !== null && adapterRam > 0 ? adapterRam : 0;
    const totalMb = Math.round(bytes / 1048576);
    const idx = gpus.length;

    gpus.push({
      id: `amd:${idx}`,
      index: idx,
      vendor: 'amd',
      backend: 'vulkan',
      name: name || 'AMD Radeon GPU',
      unified_memory: false,
      vram_total_mb: totalMb,
      vram_used_mb: 0,
      vram_free_mb: totalMb,
      utilization_pct: null,
      temperature_c: null,
      power_w: null,
    });
  }
  return gpus;
}

export function parseVulkanInfoSummary(stdout: string): GpuDevice[] {
  const gpus: GpuDevice[] = [];
  const blocks = stdout.split(/(?=^GPU\d+:)/m);
  for (const block of blocks) {
    if (!/^GPU\d+:/m.test(block)) continue;
    const vendorMatch = /vendorID\s*=\s*(0x[0-9a-f]+|\d+)/i.exec(block);
    if (!vendorMatch) continue;
    const vendorVal = vendorMatch[1].toLowerCase();
    if (vendorVal !== '0x1002' && vendorVal !== '4098') continue;
    const nameMatch = /deviceName\s*=\s*(.+)/i.exec(block);
    const name = nameMatch ? nameMatch[1].trim() : 'AMD Radeon GPU';
    const idx = gpus.length;
    gpus.push({
      id: `amd:${idx}`,
      index: idx,
      vendor: 'amd',
      backend: 'vulkan',
      name,
      unified_memory: false,
      vram_total_mb: 0,
      vram_used_mb: 0,
      vram_free_mb: 0,
      utilization_pct: null,
      temperature_c: null,
      power_w: null,
    });
  }
  return gpus;
}

const WIN32_CIM_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  "$reg = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue;",
  "$gpus = Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -match 'VEN_1002' } | ForEach-Object {",
  '  $vc = $_;',
  "  $match = $reg | Where-Object { $_.MatchingDeviceId -and $vc.PNPDeviceID -like ('*' + $_.MatchingDeviceId + '*') } | Select-Object -First 1;",
  '  if (-not $match) { $match = $reg | Where-Object { $_.DriverDesc -eq $vc.Name } | Select-Object -First 1 }',
  "  [PSCustomObject]@{ Name = $vc.Name; PNPDeviceID = $vc.PNPDeviceID; AdapterRAM = $vc.AdapterRAM; QwMemorySize = $match.'HardwareInformation.qwMemorySize' }",
  '};',
  '@($gpus) | ConvertTo-Json -Compress',
].join(' ');

export interface AmdProviderOptions {
  platform?: NodeJS.Platform;
  sysRoot?: string;
  exec?: ExecToolFn;
  env?: EnvMap;
}

export class AmdDeviceProvider implements DeviceProvider {
  readonly id = 'amd';
  readonly #platform: NodeJS.Platform;
  readonly #sysRoot: string;
  readonly #exec: ExecToolFn;
  readonly #env: EnvMap;

  constructor(options: AmdProviderOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#sysRoot = options.sysRoot ?? options.env?.HOST_SYS ?? process.env.HOST_SYS ?? '/sys';
    this.#exec = options.exec ?? execTool;
    this.#env = options.env ?? process.env;
  }

  async detect(): Promise<HardwareSnapshot> {
    const host = await readHostResources({ platform: this.#platform });
    let gpus: GpuDevice[] = [];

    if (this.#platform === 'linux') {
      const sysfs = await probeAmdSysfsWithMeta(this.#sysRoot);
      gpus = sysfs.gpus;
      if (gpus.length === 0 && !sysfs.hasSuspendedAmd) {
        try {
          const { stdout } = await this.#exec(
            'rocm-smi',
            [
              '--showproductname',
              '--showmeminfo',
              'vram',
              '--showuse',
              '--showtemp',
              '--showpower',
              '--json',
            ],
            { platform: this.#platform, env: this.#env },
          );
          gpus = parseRocmSmiJson(stdout);
        } catch {
          gpus = [];
        }
      }
    } else if (this.#platform === 'win32') {
      try {
        const { stdout } = await this.#exec('amd-smi', ['metric', '--json'], {
          platform: this.#platform,
          env: this.#env,
        });
        gpus = parseAmdSmiJson(stdout);
      } catch {
        gpus = [];
      }

      if (gpus.length === 0) {
        try {
          const { stdout } = await this.#exec(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', WIN32_CIM_SCRIPT],
            { platform: this.#platform, env: this.#env, timeoutMs: 5000 },
          );
          gpus = parseWindowsAmdCimJson(stdout);
        } catch {
          gpus = [];
        }
      }

      if (gpus.length === 0) {
        try {
          const { stdout } = await this.#exec('vulkaninfo', ['--summary'], {
            platform: this.#platform,
            env: this.#env,
          });
          gpus = parseVulkanInfoSummary(stdout);
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
