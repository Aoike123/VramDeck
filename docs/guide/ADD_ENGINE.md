# Add a New Engine in 20 Minutes

VramDeck discovers and orchestrates model runtimes declaratively from directories under `engines/<category>/<package-name>/`. Each package contains an `engine.json` manifest (EngineManifestV2) and a lightweight JavaScript/TypeScript `adapter.mjs`.

## 1. Create the Package Directory

Create `engines/<category>/<your-engine>/`:

- `<category>` must be one of `llm`, `image`, `video`, or `audio`.
- Set `default_enabled: false` so users opt into it via the Console or API without unintended port conflicts.

## 2. Declare `engine.json` (EngineManifestV2)

Every V2 manifest must declare:

- `platform.engine`: Unique engine identifier (e.g., `"llama-cpp"`).
- `platform.runtime`: Runtime specification with `id`, `name`, `driver` (`"process"`, `"docker"`, or `"external"`), and `port` (plus `command`/`args` for `process`, `image`/`container` for `docker`, or `base_url` for `external`).
- `platform.resources`: Scheduling contract declaring `backends` (`cuda`, `rocm`, `metal`, `vulkan`, `cpu`), `gpu_count` (`>= 1` unless `cpu` is included), `vram_mb`, `vram_mode` (`"shared"` or `"exclusive"`), `concurrency`, optional `affinity` (`"any"`, `"prefer:<gpu_id>"`, or `"pin:<gpu_id>"`), and optional `cold_start_weight` (`"low"`, `"medium"`, or `"high"`).
- `platform.surface` (for media/non-chat engines) and `platform.models`: Declare capabilities matching your engine's HTTP/MCP surface. Shared capability schemas live in `engines/shared/capabilities/`.

```json
{
  "name": "Example Engine",
  "category": "llm",
  "deployment_id": "example-engine",
  "version": "1.0.0",
  "platform": {
    "engine": "example-engine",
    "default_enabled": false,
    "adapter": "adapter.mjs",
    "runtime": {
      "id": "example-engine",
      "name": "Example Runtime",
      "driver": "process",
      "command": "example-server",
      "args": ["--port", "18090"],
      "port": 18090,
      "health_path": "/health"
    },
    "resources": {
      "backends": ["cuda", "rocm", "metal", "cpu"],
      "gpu_count": 1,
      "vram_mb": 4096,
      "vram_mode": "shared",
      "concurrency": 2
    },
    "ui": {
      "name": "Example",
      "description": "Lightweight local model server",
      "symbol": "E",
      "accent": "#6ee7b7",
      "panel": "llm"
    },
    "models": []
  }
}
```

## 3. Write `adapter.mjs` Using `engine-sdk` Only

Engine adapters must stay decoupled from platform scheduling and gateway internals:

> [!IMPORTANT]
> Adapters MUST import platform helpers exclusively through `../../../platforms/workbench/lib/engine-sdk.mjs`. Never import `core`, `llm`, `backend`, `http`, or `server` directly inside an engine adapter.

```js
import { readyEngine } from '../../../platforms/workbench/lib/engine-sdk.mjs';

export default {
  async ready(ctx) {
    return readyEngine(ctx, '/health');
  },
  async idle() {
    return true;
  },
  models() {
    return [{ id: 'example-model', object: 'model', owned_by: 'example-engine', tasks: ['chat'] }];
  },
  resolveChatRequest(_ctx, body) {
    return body?.model === 'example-model';
  },
};
```

## 4. Validate Your Package

Run the repository checks to validate your manifest schema, surface definitions, and import boundaries:

```bash
npm --prefix platforms/workbench run typecheck
python .workbench/scripts/check-project.py
```

Check [CONTRIBUTING.md](../../CONTRIBUTING.md) and [docs/README.md](../README.md) before opening your pull request.
