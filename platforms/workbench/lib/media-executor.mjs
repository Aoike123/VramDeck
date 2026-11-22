// Called after admission and the shared GPU lease. Never calls the gateway itself.
import { registry } from './registry.mjs';

export async function executeMedia(engine, d, { capability, ...options } = {}) {
  const pkg = registry.enginePackage(engine);
  const adapter = await registry.adapter(engine);
  if (!pkg || !adapter?.execute) {
    throw Object.assign(new Error('Engine ' + engine + ' is not enabled for media'), {
      code: 'NOT_SUBMITTED',
    });
  }
  const runtime = pkg.manifest.platform.runtime;
  const base = runtime.base_url ?? 'http://127.0.0.1:' + runtime.port;
  return adapter.execute(capability, d, {
    ...options,
    engine,
    base,
    runtime,
  });
}
