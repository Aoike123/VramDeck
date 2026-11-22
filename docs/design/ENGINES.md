# Engine Packages & Manifest Specification

[Documentation Index](../README.md) · [Add an Engine](../guide/ADD_ENGINE.md) · [System Architecture](ARCHITECTURE.md)

Every inference backend in VramDeck is packaged as a self-contained directory under `engines/<category>/<package>/` containing an `EngineManifestV2` file (`engine.json`) and an adapter (`adapter.mjs`). **Core platform code contains zero hardcoded tool or modality names**—everything in the Gateway, PoolCoordinator, MCP server, and Console derives dynamically from discovered engine packages.

---

## Built-in Packages (14 Total)

All packages default to `default_enabled: false` so clean installs remain lightweight until you enable or adopt what you need via CLI (`engine enable <pkg>` / `hub scan`) or Console (`#/hub`, `#/engines`).

### Core Cross-Platform Pack (6 Packages)

| Package | Path | Category | Driver | Port | Backends | Est. VRAM | Concurrency |
| --- | --- | --- | --- | ---: | --- | ---: | ---: |
| `llama-cpp` | `engines/llm/llama-cpp/` | `llm` | `process` | `18080` | `cuda`, `rocm`, `metal`, `vulkan`, `cpu` | `4,096 MB` | `2` |
| `ollama` | `engines/llm/ollama/` | `llm` | `external` | `11434` | `cuda`, `rocm`, `metal`, `cpu` | `4,096 MB` | `2` |
| `vllm` | `engines/llm/vllm/` | `llm` | `docker` | `18000` | `cuda`, `rocm` | `8,192 MB` | `4` |
| `comfyui` | `engines/image/comfyui/` | `image` | `external` | `18188` | `cuda`, `rocm`, `metal`, `vulkan`, `cpu` | `6,144 MB` | `1` |
| `whisper-cpp` | `engines/audio/whisper-cpp/` | `audio` | `process` | `18081` | `cuda`, `rocm`, `metal`, `vulkan`, `cpu` | `2,048 MB` | `2` |
| `kokoro` | `engines/audio/kokoro/` | `audio` | `process` | `18082` | `cuda`, `rocm`, `metal`, `cpu` | `2,048 MB` | `2` |

### Optional ROCm Pro Pack (`rocm-pro`, 8 Packages)

Dedicated AMD ROCm Docker packages preserved under `engines/`:

| Package | Category | Port | Purpose |
| --- | --- | ---: | --- |
| `pation-model-qwen38-27b-w3a4` | `llm` | `18983` | AMD ROCm vLLM W3A4 long-context (up to 256K) quantized LLM + CPU vision |
| `pation-model-qwen38-27b-mxfp4` | `llm` | CLI | AMD ROCm MXFP4 Qwen3.8 variant |
| `pation-model-qwen-image-21` | `image` | `8191` | Qwen-Image 2.1 text-to-image, RGBA, and multi-reference image editing |
| `anima` | `image` | `8188` | Anime & illustration generation / stylization on shared ComfyUI |
| `pation-model-minimax-h3` | `video` | `8188` | MiniMax H3 reference-guided video generation (up to 9 images + 3 videos) |
| `fish-drama3` | `audio` | `18986` | Multi-speaker voice cloning and expressive speech synthesis |
| `bs-roformer` | `audio` | `18986` | Vocal & stem audio source separation |
| `qwen3-asr` | `audio` | `18986` | Multilingual speech transcription |

---

## Manifest Contract (`engine.json`)

Every package manifest follows `EngineManifestV2` rules (validated at startup and in strict E2E tests):

```json
{
  "schema_version": 2,
  "id": "llama-cpp",
  "display_name": "llama.cpp Server",
  "category": "llm",
  "default_enabled": false,
  "resources": {
    "backends": ["cuda", "rocm", "metal", "vulkan", "cpu"],
    "gpu_count": 1,
    "vram_mb": 4096,
    "shared": true,
    "concurrency": 2
  },
  "platform": {
    "engine": "llama-cpp",
    "adapter": "adapter.mjs",
    "runtime": {
      "id": "llama-cpp",
      "driver": "process",
      "port": 18080,
      "health": "/health"
    },
    "models": [
      { "id": "llama-cpp", "capabilities": ["chat.completions"], "priority": 10 }
    ]
  }
}
```

### Core Fields
- **`schema_version`**: `2` (`EngineManifestV2`).
- **`resources`**:
  - `backends`: non-empty list among `cuda`, `rocm`, `metal`, `vulkan`, `cpu`.
  - `gpu_count`: number of device slots requested (`1` for single-device or `> 1` for atomic tensor-parallel slots; `0` allowed when targeting CPU fallback).
  - `vram_mb`: default memory reservation budget tracked by `PoolCoordinator`.
  - `shared`: `true` if compatible engines may co-locate on the same device inside free pool headroom; `false` for exclusive device usage.
  - `concurrency`: maximum concurrent requests dispatched to a single loaded instance.
- **`platform.runtime.driver`**:
  - `process`: managed local child process (`llama-server`, `whisper-server`, etc.).
  - `external`: adopted or user-managed local HTTP server (`Ollama`, `ComfyUI`).
  - `docker`: containerized runtime (`vLLM`, `rocm-pro` packs).

## Capability Surface (`platform.surface`)

Packages providing media capabilities declare HTTP sync endpoints, MCP tool groups, and `browse_media` categories declaratively via `platform.surface` or shared `surface_files` (for example `engines/shared/capabilities/image.surface.json`). Conflicting declarations across active packages fail loudly at registry load time.

- Key fields: `group`, `task`, `kind` (`image` | `video` | `audio` | `text`), `label`, `description`, `group_info`, `category`, `base`, `required`, `example`, optional `sync` HTTP path, `sync_via` (`engine` or `job`), `sync_public`, `library` (`voices`), and `order`.
- Current shared capabilities across packages: `image.generate`, `image.edit`, `video.generate`, `speech.synthesize`, `audio.separate`, and `audio.transcribe`.

## Adapter Isolation & Lifecycle Hooks

Adapters (`adapter.mjs`) **must import shared contracts strictly from `platforms/engine-sdk/` (`@vramdeck/engine-sdk`)**—never directly from `platforms/workbench/lib/`.

Supported adapter hooks:
- `ready(ctx)` / `idle(ctx)` — startup readiness and safe-drain idle checks.
- `params[capability]` / `notes[capability]` (each called with `model`) — per-model JSON Schema extensions and MCP schema notes.
- `validate(capability, input)` / `syncValidate` — pre-submission parameter checks.
- `assets(capability, input, { asset })` / `onCreate` / `payload` / `prepare` — asset budgeting, preprocessing, and backend request assembly.
- `execute(capability, payload, ctx)` — runs backend generation and emits `{ artifacts: [{ kind, file, mime, name?, media? }] }` (or legacy `{ data: [...] }`).
- `interrupt(backend)` / `recover(job, helpers)` — explicit cancellation (e.g. ComfyUI `prompt_id`) and crash recovery.
- `launchArgs` / `launchEnv` / `startupCheck` / `parked` / `park` / `resume` — extended lifecycle hooks for managed runtimes.

## Managing Packages

```bash
node platforms/workbench/cli.mjs engine list
node platforms/workbench/cli.mjs engine status <package>
node platforms/workbench/cli.mjs engine enable <package>
node platforms/workbench/cli.mjs engine disable <package>
```

Persisted enablement toggles live in `workspace/data/` / `workspace/config/` (never committed to Git). See [Add an Engine](../guide/ADD_ENGINE.md) to build your own adapter.
