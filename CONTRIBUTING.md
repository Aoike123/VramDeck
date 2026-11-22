# Contributing to VramDeck

Thank you for helping make **VramDeck** the easiest open-source resource manager for 1–4 GPU local AI setups across Linux, macOS, and Windows!

## Development Setup

- **Node.js >= 22.19.0** is required (runs `.ts` files natively with `--experimental-strip-types` default behavior).
- **Python 3.12+** is optional for legacy engine helper scripts and running the full test runner `.workbench/scripts/check-project.py`.

Install dependencies:

```bash
npm --prefix platforms/workbench ci
npm --prefix platforms/mcp ci
```

## Coding & Architecture Rules

1. **Progressive Erasable TypeScript**: New control-plane modules under `platforms/workbench/lib/` must comply with `erasableSyntaxOnly: true` (`strict: true`, `allowImportingTsExtensions: true`). Never use TypeScript `enum`, `namespace`, or constructor parameter properties (`constructor(public x: number)`).
2. **Engine SDK Isolation**: Engine adapters under `engines/` must import gateway helpers exclusively through `platforms/workbench/lib/engine-sdk.mjs` (or `.ts`). Never import `core`, `backend`, `http`, or `server` internals directly from an adapter.
3. **Formatting & Cycles**: Every file must pass Prettier formatting (`npm --prefix platforms/workbench run format:check`) and maintain zero circular imports (`npm --prefix platforms/workbench run check:cycles`).
4. **No Hardcoded Host Paths or GPU Vendors**: Keep code cross-platform (`linux`, `darwin`, `win32`) and hardware-agnostic (`cuda`, `rocm`, `metal`, `vulkan`, `cpu`).

## Verification Before Submitting a PR

Run the unified check runner (same checks as `./lab check`):

```bash
npm --prefix platforms/workbench run typecheck
npm --prefix platforms/workbench run format:check
npm --prefix platforms/workbench run check:cycles
WORKBENCH_NEXT_DIST=.next-ci npm --prefix platforms/workbench run build
python .workbench/scripts/check-project.py
```

See [docs/guide/ADD_ENGINE.md](docs/guide/ADD_ENGINE.md) if you are contributing a new model engine or runtime adapter.

## Good First Issues

Want an easy entry point into the codebase? Pick up any of these self-contained starter tasks:

- **good first issue (adapter)**: Add a lightweight `process` or `external` engine package for `TabbyAPI`, `SGLang`, or `KoboldCpp` following [Add an Engine](docs/guide/ADD_ENGINE.md).
- **good first issue (device provider)**: Extend `IntelDeviceProvider` / `VulkanDeviceProvider` sysfs and `vulkaninfo` metrics parsing in `platforms/workbench/lib/devices/`.
- **good first issue (hub)**: Add curated GGUF / safetensors model metadata entries with verified mirror links in `platforms/workbench/lib/hub/catalog.ts`.
- **good first issue (docs)**: Improve OS-specific GPU driver troubleshooting sections in `README.md`, `README.zh-CN.md`, and [docs/](docs/README.md).
- **good first issue (ui)**: Enhance Web UI telemetry charts and bilingual `EN` / `中文` copy inside `platforms/workbench/app/`.
