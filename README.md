# VramDeck

**Universal 1–4 GPU Multimodal AI Resource Manager & Control Plane**

> [中文文档 (README.zh-CN.md)](README.zh-CN.md) · [Documentation Index](docs/README.md) · [Add an Engine](docs/guide/ADD_ENGINE.md) · [Contributing](CONTRIBUTING.md)

**VramDeck** (formerly evolved from `llm-backend`) turns 1–4 consumer or workstation GPUs — or even a GPU-less CPU host — into a unified OpenAI-compatible HTTP gateway (`:18982`), staged MCP media server (`local-media`), bilingual (`EN` / `中文`) Web console (`:13000`), and one-click Engine & Model Hub across **Linux, macOS, and Windows**.

---

## Key Capabilities

- **Cross-Platform, Single-Process Control Plane**: Built on **Node.js >= 22.19** native TypeScript with zero mandatory `systemd`, Prometheus, or host Python runtime for core control-plane startup.
- **1–4 GPU Best-Fit Pool Coordinator**: Places heterogeneous workloads cleanly (`nvidia:0`, `amd:1`, `apple:0`, `intel:2`), allows `shared` coexistence within free VRAM budgets, supports atomic multi-GPU tensor parallelism, and evicts gracefully (`idle -> batch_eligible -> lowest cold_start_weight`).
- **Pluggable Runtime Drivers (`process` | `docker` | `external`)**: Orchestrates lightweight native daemons (`llama.cpp`, `whisper.cpp`, `kokoro`), containerized stacks (`vLLM`, **ROCm Pro Pack**), or already-running external local services (`Ollama`, `ComfyUI`, `LM Studio`).
- **Engine & Model Hub**: Scans local AI services on your machine, recommends GGUF / quantized models tailored to your GPU VRAM (`fits` / `tight` / `too_large`), downloads with HTTP `Range` resume + SHA256 verification across **Hugging Face / HF-Mirror / ModelScope**, and links local weight folders.
- **Backward Compatibility (`llm-backend` & `./lab`)**: Existing `llm-backend` workspaces, `.llm-backend-artifacts` storage markers, `./lab` CLI commands, and all 8 AMD Radeon R9700 / Paiton engines (grouped under the optional `rocm-pro` pack) continue working seamlessly.

---

## 3-Step Quickstart

### Step 1 — Run the One-Click Installer

**Linux / macOS:**

```bash
bash scripts/install.sh
```

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

> Preview planned actions safely without modifying your system using `--dry-run` (bash) or `-DryRun` (PowerShell).

### Step 2 — Start VramDeck

```bash
node platforms/workbench/cli.mjs start
# Or via the compatibility shim on Linux/macOS/Windows:
./lab start
```

### Step 3 — Open the Console & Connect Your Clients

- **Web Console**: `http://127.0.0.1:13000` (Bilingual `EN` / `中文` toggle, Live Multi-GPU Topology & Hub)
- **OpenAI / Multimodal Gateway**: `http://127.0.0.1:18982/v1` (`/v1/chat/completions`, `/v1/models`, `/v1/media/models`, `/v1/images/generations`)
- **MCP (`local-media`)**: Staged `browse_media` discovery over stdio via `platforms/mcp/server.mjs`

---

## Hardware Compatibility Matrix

| Vendor / Backend | OS Support | Discovery Mechanism | Supported Workloads |
|---|---|---|---|
| **NVIDIA CUDA** (`cuda`) | Linux, Windows (+ WSL2) | `nvidia-smi` CSV query | `llama.cpp`, `Ollama`, `vLLM`, `ComfyUI`, `whisper.cpp`, `Kokoro` |
| **AMD ROCm** (`rocm`) | Linux, Windows | `rocm-smi` / `amd-smi` / sysfs / CIM | Cross-platform engines + **ROCm Pro Pack** (8 R9700 engines) |
| **Apple Silicon Metal** (`metal`) | macOS (`arm64`) | Unified Memory (~75% budget via `sysctl` + `vm_stat`) | `llama.cpp`, `Ollama`, `ComfyUI`, `whisper.cpp`, `Kokoro` |
| **Intel / Vulkan** (`vulkan`) | Linux, Windows | `vulkaninfo` / sysfs fallback | `llama.cpp`, `ComfyUI`, `whisper.cpp` |
| **CPU Fallback** (`cpu`) | Linux, macOS, Windows | Host RAM & OS CPU telemetry | `llama.cpp`, `Ollama`, `ComfyUI`, `whisper.cpp`, `Kokoro` |

---

## 30s Product Demo GIF (Recording Guide)

> **Demo Preview Placeholder**: `<!-- Add docs/assets/vramdeck-demo.gif (1280x720, <= 30s) before publishing release notes -->`

To capture a crisp 30-second GIF demo on a multi-GPU rig:
1. Start VramDeck (`http://127.0.0.1:13000`) with two workloads active so the **Multi-GPU VRAM Topology** bar shows shared + exclusive `PoolAllocation` slots.
2. Switch to the **Hub** tab (`#/hub`), trigger **Scan Local Services**, and preview a VRAM-fit quantization recommendation (`fits` / `tight`).
3. Toggle the header language switch between `EN` and `中文` cleanly in one continuous take.

---

## Architecture & Development

- **Documentation Hub**: [docs/README.md](docs/README.md)
- **Add an Engine in 20 Minutes**: [docs/guide/ADD_ENGINE.md](docs/guide/ADD_ENGINE.md)
- **Contributing & Good First Issues**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Installers**: [scripts/install.sh](scripts/install.sh) · [scripts/install.ps1](scripts/install.ps1)
