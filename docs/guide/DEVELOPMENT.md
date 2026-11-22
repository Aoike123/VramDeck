# Development Guide

[Documentation Index](../README.md) · [Add an Engine](ADD_ENGINE.md) · [Contributing](../../CONTRIBUTING.md)

## Prerequisites & Conventions

- **Node.js `>= 22.19`** (uses Node's native `--experimental-strip-types` / erasable TypeScript execution).
- **TypeScript Rules**: `erasableSyntaxOnly: true` is enforced across `platforms/workbench/`. Do not use TypeScript `enum`, `namespace`, or parameter properties (`constructor(public x: number)`).
- **Package Boundaries**: Engine adapters under `engines/` may only import from `platforms/engine-sdk/` (`@vramdeck/engine-sdk`) and standard Node built-ins — never directly from `platforms/workbench/lib/`.
- **Zero Circular Imports**: All imports across `platforms/workbench/lib/`, `platforms/workbench/app/`, and `platforms/mcp/` must form a DAG verified by `check:cycles`.
- **Line Endings & Formatting**: `.gitattributes` enforces LF line endings (`eol=lf`). `platforms/workbench/app/globals.css` is intentionally excluded from Prettier checks and keeps compact single-line rules — edit it cleanly without reformatting the whole file with Prettier.

## Local Quality Gates

Install dependencies once:

```bash
npm --prefix platforms/workbench install
```

Run all static and build checks from the repository root:

```bash
# 1. Code formatting check
npm --prefix platforms/workbench run format:check

# 2. TypeScript verification (no emit, strict erasable syntax)
npm --prefix platforms/workbench run typecheck

# 3. Circular import check
npm --prefix platforms/workbench run check:cycles

# 4. Production Next.js Console build (isolated dist directory)
WORKBENCH_NEXT_DIST=.next-workbench npm --prefix platforms/workbench run build
```

> **Note on Console Builds**: Production runs read the build directory referenced by `WORKBENCH_NEXT_DIST` (or `platforms/platform.json` `next_dist`). All `.next/`, `.next-*/`, and `node_modules/` directories are ignored by Git and Docker build contexts.

## Unit & E2E Test Suites

Tests bind ephemeral localhost ports inside isolated temporary workspaces and **do not require live GPUs or model weights**.

```bash
# Python repository sanity & script checks
python .workbench/scripts/check-project.py

# Workbench Node.js unit & integration tests (all Node test suites)
python .workbench/scripts/check-project.py --suite node

# Full 4-tier strict E2E suite (covers storage, DeviceProvider, telemetry,
# PoolCoordinator, drivers, CLI, Hub, MCP, Web UI, and docs hygiene)
node tests/e2e/run-e2e.ts --strict
```

### Live Isolated UI Preview (Mocked Hardware)

You can preview any hardware topology locally without real GPUs using `WORKBENCH_MOCK_GPUS`:

```bash
WORKBENCH_PORT=13180 INFERENCE_PORT=18992 CONTROL_PORT=18993 \
WORKBENCH_NEXT_DIST=.next-workbench NODE_ENV=production WORKBENCH_DISABLE_DOCKER=1 \
WORKBENCH_MOCK_GPUS='[{"id":"nvidia:0","vendor":"nvidia","backend":"cuda","index":0,"name":"NVIDIA GeForce RTX 4090","vram_total_mb":24576,"vram_used_mb":11264,"vram_free_mb":13312,"utilization_pct":42,"temperature_c":54,"power_w":185,"unified_memory":false}]' \
node platforms/workbench/server.mjs
```

## Workspace & Secret Hygiene

- Never commit `.env`, `.env.*`, `workspace/` runtime weights, SSH private keys, `.aws/`, or generated screenshots under temp directories.
- Always keep engine manifests under `engines/*/*/engine.json` compliant with `EngineManifestV2` validation before enabling them in default packs.
