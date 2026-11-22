# Project Status

[Documentation Index](../README.md) · [Operations Guide](OPERATIONS.md) · [System Architecture](../design/ARCHITECTURE.md)

## Release Overview (`v1.0.0`)

**VramDeck v1.0.0** elevates the codebase from an earlier single-GPU workstation controller into a cross-platform **unified local compute pool** manager supporting Linux, macOS, and Windows across NVIDIA, AMD, Apple Silicon, Intel/Vulkan, and CPU fallback hosts.

## Capabilities Matrix

| Subsystem | Status | Implementation Highlights |
| --- | --- | --- |
| **Control Plane (`platforms/workbench`)** | Ready | Single-process Node.js `>= 22.19` HTTP + Next.js App Router server (`:13000` UI, `:18982` API, `:18990` control) with 60-minute in-memory ring telemetry and zero mandatory systemd or Prometheus dependencies |
| **Hardware Discovery (`DeviceProvider`)** | Ready | Probes NVIDIA (`nvidia-smi`), AMD (`rocm-smi`), Apple Silicon (`system_profiler` / Metal unified memory), Vulkan, and host CPU/RAM fallback cleanly |
| **Unified Compute Pool (`PoolCoordinator`)** | Ready | Single host compute pool coordinator supporting best-fit VRAM placement, shared engine coexistence, atomic multi-device slots, idle-drain eviction, and anti-starvation scheduling |
| **Runtime Drivers (`RuntimeDriver`)** | Ready | Modular `process`, `docker`, and `external` (HTTP adoption) drivers with `EngineManifestV2` contract validation and `@vramdeck/engine-sdk` isolation |
| **Engine & Model Hub (`lib/hub/`)** | Ready | Probes localhost AI daemons (`Ollama`, `ComfyUI`, `llama-server`, `LM Studio`), computes live pool fit (`fits` / `tight` / `too_large`), pulls GGUF/weights with HTTP Range `206` resume & SHA256 verification (`huggingface`, `hf-mirror`, `modelscope`), and links local folders |
| **Core Engine Pack (6 Packages)** | Ready | Cross-platform `llama-cpp`, `ollama`, `vllm`, `comfyui`, `whisper-cpp`, and `kokoro` packages (`default_enabled: false` until enabled or adopted) |
| **Bilingual Web Console (`:13000`)** | Ready | Full `EN` / `中文` localization with unified Studio UI design across Compute Pool Topology, Hub, Artifacts, Tasks, Services, Engines, API, MCP, and Access & Keys |
| **Unified MCP Server (`platforms/mcp`)** | Ready | Stdio MCP bridge exposing 14 capability-driven media, voice, artifact, and task tools with lazy detail disclosure |
| **CI & Strict E2E Verification** | Ready | 3-OS GitHub Actions matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`), Prettier/cycle/TypeScript gates, and strict 4-tier E2E suite (`137` checks) |

## Optional `rocm-pro` Workstation Pack

Eight specialized AMD ROCm Docker engine packages (`pation-model-qwen38-27b-w3a4`, `pation-model-qwen38-27b-mxfp4`, `pation-model-qwen-image-21`, `anima`, `pation-model-minimax-h3`, `fish-drama3`, `bs-roformer`, `qwen3-asr`) remain available under the `rocm-pro` pack (`default_enabled: false`) for dedicated AMD ROCm Linux workstations requiring high-context quantized LLMs, high-res synthesis, reference-guided video workflows, and voice/audio separation pipelines.
