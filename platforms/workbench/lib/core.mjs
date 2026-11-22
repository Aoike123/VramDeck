import { runtimeFor, sharedEngines as topologySharedEngines } from './runtime-topology.mjs';
import { GpuPoolCoordinator, pause } from './scheduler/pool-coordinator.ts';

export { pause };

export class Coordinator extends GpuPoolCoordinator {
  constructor(backend, options = {}) {
    super(backend, {
      groupOf: options.groupOf ?? runtimeFor,
      capacityOf:
        options.capacityOf ??
        ((engine) => (options.sharedEngines ?? topologySharedEngines())[engine]),
      ...options,
    });
  }
}
