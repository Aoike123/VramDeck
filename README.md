# VramDeck

[![CI](https://github.com/Aoike123/VramDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Aoike123/VramDeck/actions/workflows/ci.yml)
![Node >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933)
![OS](https://img.shields.io/badge/OS-Linux%20%7C%20macOS%20%7C%20Windows-blue)

**Run LLMs, image generation, video, and audio models together on 1–4 GPUs — without OOM crashes, port sprawl, or manual restarts.**

[简体中文 (README.zh-CN.md)](README.zh-CN.md) · [Documentation Index](docs/README.md) · [Add an Engine](docs/guide/ADD_ENGINE.md) · [Contributing](CONTRIBUTING.md)

---

## Why VramDeck?

Running local AI quickly gets messy once you combine a coding LLM, ComfyUI image/video workflows, and speech/transcription models on a single PC or 2–4 GPU workstation. **VramDeck** gives all of them one shared VRAM brain, one API endpoint, and one live control deck:

- **Automatic VRAM Orchestration (No More OOM)**: Share a GPU across lightweight models when free memory allows, reserve multiple GPUs atomically for larger models, and automatically queue or swap heavy workloads when switching from chat to image or video generation.
- **Adopt What You Already Run**: Auto-scan and take over local **Ollama**, **ComfyUI**, **LM Studio**, and **llama.cpp** instances in one click — or let VramDeck launch native daemons (`llama.cpp`, `whisper.cpp`, `kokoro`) and Docker containers (`vLLM`) on demand.
- **One API & MCP Server for Every Client**: Point Cursor, Open WebUI, Cherry Studio, Continue, or your own scripts at a single OpenAI-compatible gateway (`http://127.0.0.1:18982/v1`), and give MCP agents (`local-media` via `platforms/mcp/server.mjs`) image, video, speech, and transcription tools.
- **VRAM-Aware Model Hub**: Check real-time free VRAM fit (`fits` / `tight` / `too_large`) before downloading, pull GGUF/quantized weights with HTTP `Range` resume + SHA256 verification across **Hugging Face**, **HF-Mirror**, and **ModelScope**, or link existing local weight directories directly.
- **Live Control Deck Out of the Box**: Real-time multi-GPU memory/temperature/utilization telemetry, active job queues, generated media gallery, scoped API keys, and bilingual (`EN` / `中文`) switching at `http://127.0.0.1:13000`.

---

## How It Works

```text
  Apps / IDEs / Agents          VramDeck Control Plane                 Runtimes & Hardware
┌──────────────────────┐      ┌────────────────────────┐      ┌──────────────────────────────────┐
│ Cursor / Open WebUI  │─────▶│ Gateway (:18982 /v1)   │─────▶│ Adopted: Ollama · ComfyUI · LM   │
│ scripts / SDKs       │      │ Queue · Leases · Keys  │      │ Managed: llama.cpp · vLLM        │
├──────────────────────┤      ├────────────────────────┤      │ Audio:   whisper.cpp · Kokoro    │
│ Claude / MCP Clients │─────▶│ MCP (local-media)      │      ├──────────────────────────────────┤
├──────────────────────┤      ├────────────────────────┤      │ 1–4 GPUs / Mixed Vendors / CPU   │
│ You (Browser)        │─────▶│ Web Console (:13000)   │      │ CUDA · ROCm · Metal · Vulkan     │
└──────────────────────┘      └────────────────────────┘      └──────────────────────────────────┘
```

---

## Quickstart (60 Seconds)

### 1. Run the One-Click Installer

**Linux / macOS:**

```bash
bash scripts/install.sh
```

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

> Use `--dry-run` (bash) or `-DryRun` (PowerShell) to preview setup actions without modifying your machine.

### 2. Start VramDeck

```bash
node platforms/workbench/cli.mjs start
```

### 3. Open the Console & Send Your First Request

- **Web Console**: Open `http://127.0.0.1:13000` to view live GPUs, scan/adopt running local engines in **Hub**, or switch `EN` / `中文`.
- **Unified API Gateway**: List active models and send a chat completion request through `http://127.0.0.1:18982/v1`:

```bash
curl http://127.0.0.1:18982/v1/models

curl http://127.0.0.1:18982/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "Hello from VramDeck!"}]
  }'
```

---

## Works With Your Favorite Tools

| Client / Tool | How to Connect | What You Get |
|---|---|---|
| **Cursor / Continue / Open WebUI / Cherry Studio** | Set OpenAI Base URL to `http://127.0.0.1:18982/v1` | One endpoint across Ollama, llama.cpp, and vLLM with automatic GPU scheduling |
| **Claude Desktop / MCP Agents** | Configure stdio command: `node platforms/mcp/cli.mjs stdio` | `local-media` MCP server (backed by [platforms/mcp/server.mjs](platforms/mcp/server.mjs)) with progressive tool discovery for images, video, TTS, and ASR |
| **Existing Ollama / ComfyUI / LM Studio** | Open **Engine & Model Hub** (`:13000`) -> **Scan Local Services** -> **Adopt** | Keep your existing setups and models while gaining VRAM coordination, unified API routing, and telemetry |

---

## Hardware Support Matrix

| Vendor / Backend | Supported OS | Auto-Discovery | Compatible Workloads |
|---|---|---|---|
| **NVIDIA CUDA** (`cuda`) | Linux, Windows (+ WSL2) | `nvidia-smi` telemetry | `llama.cpp`, `Ollama`, `vLLM`, `ComfyUI`, `whisper.cpp`, `Kokoro` |
| **AMD ROCm** (`rocm`) | Linux, Windows | sysfs / `rocm-smi` / `amd-smi` / CIM | Cross-platform engines + optional ROCm Pro Pack |
| **Apple Silicon Metal** (`metal`) | macOS (`arm64`) | Unified memory budget (`sysctl` + `vm_stat`) | `llama.cpp`, `Ollama`, `ComfyUI`, `whisper.cpp`, `Kokoro` |
| **Intel / Vulkan** (`vulkan`) | Linux, Windows | `vulkaninfo` / sysfs | `llama.cpp`, `ComfyUI`, `whisper.cpp` |
| **CPU Mode** (`cpu`) | Linux, macOS, Windows | Host RAM & OS telemetry | `llama.cpp`, `Ollama`, `ComfyUI`, `whisper.cpp`, `Kokoro` |

---

## Documentation & Extending

- **Full Documentation Index**: [docs/README.md](docs/README.md)
- **Add a Custom Engine in 20 Minutes**: [docs/guide/ADD_ENGINE.md](docs/guide/ADD_ENGINE.md)
- **Contributing & Good First Issues**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Installers**: [scripts/install.sh](scripts/install.sh) · [scripts/install.ps1](scripts/install.ps1)

<details>
<summary>Optional AMD ROCm Pro Pack &amp; Legacy CLI Compatibility</summary>

- Pre-tuned container engine packages for AMD Radeon workstation GPUs are bundled as the optional **ROCm Pro Pack** (`rocm-pro`).
- Existing `./lab` workflows, CLI aliases, and `.llm-backend-artifacts` data directories remain supported out of the box (`./lab start`, `./lab check`).

</details>
