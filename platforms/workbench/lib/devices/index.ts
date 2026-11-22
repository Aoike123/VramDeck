import type { DeviceProvider, GpuDevice, HardwareSnapshot } from '../types.ts';
import { AmdDeviceProvider } from './amd.ts';
import { AppleDeviceProvider } from './apple.ts';
import { CpuMockDeviceProvider, dedupeGpuDevices, parseMockGpus } from './cpu-mock.ts';
import { readHostResources } from './host.ts';
import type { EnvMap, ExecToolFn } from './host.ts';
import { NvidiaDeviceProvider } from './nvidia.ts';

export { readHostResources, execTool, resolveWin32Executable } from './host.ts';
export { NvidiaDeviceProvider, parseNvidiaSmiCsv } from './nvidia.ts';
export {
  AmdDeviceProvider,
  probeAmdSysfs,
  parseRocmSmiJson,
  parseAmdSmiJson,
  parseWindowsAmdCimJson,
  parseVulkanInfoSummary,
} from './amd.ts';
export { AppleDeviceProvider, parseSystemProfilerDisplays, parseVmStat } from './apple.ts';
export { CpuMockDeviceProvider, parseMockGpus } from './cpu-mock.ts';

export interface DeviceProviderOptions {
  platform?: NodeJS.Platform;
  env?: EnvMap;
  exec?: ExecToolFn;
  sysRoot?: string;
  providers?: DeviceProvider[];
}

export class CompositeDeviceProvider implements DeviceProvider {
  readonly id = 'composite';
  readonly #platform: NodeJS.Platform;
  readonly #env: EnvMap;
  readonly #providers: DeviceProvider[];

  constructor(options: DeviceProviderOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#env = options.env ?? process.env;

    if (options.providers) {
      this.#providers = options.providers;
    } else if (this.#platform === 'linux' || this.#platform === 'win32') {
      this.#providers = [
        new NvidiaDeviceProvider({
          platform: this.#platform,
          env: this.#env,
          exec: options.exec,
        }),
        new AmdDeviceProvider({
          platform: this.#platform,
          env: this.#env,
          exec: options.exec,
          sysRoot: options.sysRoot,
        }),
      ];
    } else if (this.#platform === 'darwin') {
      this.#providers = [
        new AppleDeviceProvider({
          platform: this.#platform,
          env: this.#env,
          exec: options.exec,
        }),
      ];
    } else {
      this.#providers = [];
    }
  }

  async detect(): Promise<HardwareSnapshot> {
    const host = await readHostResources({ platform: this.#platform });

    const mock = parseMockGpus(this.#env.WORKBENCH_MOCK_GPUS);
    if (mock !== null) {
      return {
        collected_at: Date.now(),
        host,
        gpus: dedupeGpuDevices(mock),
      };
    }

    const results = await Promise.allSettled(this.#providers.map((provider) => provider.detect()));
    const rawGpus: GpuDevice[] = [];
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      rawGpus.push(...res.value.gpus);
    }

    return {
      collected_at: Date.now(),
      host,
      gpus: dedupeGpuDevices(rawGpus),
    };
  }
}

export function createDeviceProvider(options: DeviceProviderOptions = {}): DeviceProvider {
  return new CompositeDeviceProvider(options);
}
