# Operations Guide

[Documentation Index](../README.md) · [Services & Layout](SERVICES.md) · [HTTP & Hub API](../api/CURRENT_API.md)

VramDeck operates from a single cross-platform control plane (`Node.js >= 22.19`) across Linux, macOS, and Windows. Rather than managing isolated containers manually or treating local GPUs as independent cluster nodes, all accelerators and host CPU fallback are scheduled as one **unified local compute pool**.

---

## Core Service Lifecycle

Run commands via the linked binary (`vramdeck`), `node platforms/workbench/cli.mjs`, or `./lab` (Linux/macOS wrapper):

```bash
# Start Console (:13000), Unified Gateway (:18982), and Lease Control (:18990)
node platforms/workbench/cli.mjs start

# Start gateway & pool scheduler only (skip Next.js Console assets if needed)
node platforms/workbench/cli.mjs start --headless

# Inspect process health, active runtime, and pool lease summary
node platforms/workbench/cli.mjs status

# Stream recent control-plane logs
node platforms/workbench/cli.mjs logs --lines 100

# Stop or restart cleanly
node platforms/workbench/cli.mjs stop
node platforms/workbench/cli.mjs restart
```

## Compute Pool & Device Inspection

```bash
# Probe CUDA (nvidia-smi), ROCm (rocm-smi), Apple Metal, Vulkan, and CPU RAM
node platforms/workbench/cli.mjs devices --json

# Check live pool slot allocations and active engine leases
node platforms/workbench/cli.mjs scheduler status

# Manually switch or warm a specific package inside the unified pool
node platforms/workbench/cli.mjs scheduler switch llama-cpp
```

### Quick HTTP Health Check

```bash
curl -s http://127.0.0.1:18982/health
curl -s 'http://127.0.0.1:13000/data?minutes=15&window=15'
```

`/health` returning ready confirms the control plane and gateway listener are up; model weights still load on demand when requests arrive unless explicitly warmed.

## Managing Engines & Model Weights

```bash
# List all discovered engine packages (core + optional packs) and enabled state
node platforms/workbench/cli.mjs engine list

# Check storage & status of a specific package
node platforms/workbench/cli.mjs engine status llama-cpp

# Enable or disable a package safely (refuses disabling while requests are queued/active)
node platforms/workbench/cli.mjs engine enable llama-cpp
node platforms/workbench/cli.mjs engine disable llama-cpp

# Scan localhost ports (Ollama :11434, ComfyUI :18188, llama-server :18080, LM Studio :1234)
node platforms/workbench/cli.mjs hub scan

# Download quantized weights with HTTP Range resume and SHA256 check
node platforms/workbench/cli.mjs hub pull qwen2.5-7b-instruct-q4_k_m --mirror hf-mirror
```

## Optional User-Level Background Service

For unattended workstations, register VramDeck as a user service (`systemd --user` on Linux, `launchd` on macOS, or Task Scheduler / user daemon on Windows):

```bash
node platforms/workbench/cli.mjs service install
node platforms/workbench/cli.mjs service status
node platforms/workbench/cli.mjs service uninstall
```

## Storage & Workspace Hygiene

- Mutable runtime state, downloaded weights (`workspace/models/`), SQLite/JSON telemetry, access keys (`workspace/data/scheduler/access-keys.json`), and generated media outputs reside under `workspace/` (or the path set via `WORKBENCH_DATA`).
- Keep `workspace/` intact during upgrades and never delete `workspace/data/scheduler/` if you want to preserve issued API keys and routing preferences.
- All weight downloads from the Hub happen on demand per chosen model and mirror (`huggingface`, `hf-mirror`, `modelscope`).

## Optional ROCm Pro Pack (`rocm-pro`)

Workstations with supported AMD ROCm GPUs running Docker can additionally enable the 8 specialized `rocm-pro` packages under `engines/` (`pation-model-qwen38-27b-w3a4`, `pation-model-qwen-image-21`, `pation-model-minimax-h3`, etc.). These packages use pinned container image recipes documented in [Runtime Images](../runtime/RUNTIME_IMAGES.md) and upstream plugins such as [Paiton](https://github.com/Eliovp-BV/paiton-vllm-plugin), [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness), [GenEval](https://github.com/djghosh13/geneval), and [VBench](https://github.com/Vchitect/VBench).
