# Runtime Topology & Unified Compute Pool Semantics

[Documentation Index](../README.md) · [System Architecture](ARCHITECTURE.md) · [Pool Scheduling Strategy](MODEL_SCHEDULING.md)

## 1. Unified Compute Pool Model

VramDeck models all compute devices on a workstation—whether 1 discrete GPU, 2–4 mixed-vendor GPUs (`CUDA` + `ROCm` + `Vulkan`), Apple unified memory (`Metal`), or host memory (`CPU` standby)—as a **single unified local compute pool**.

```text
                ┌──────────────────┐
Request / MCP ─▶│ Gateway (:18982) │─▶ Admission Queue (per-key + global FIFO/aging)
                └────────┬─────────┘
                         ▼
               ┌───────────────────┐
               │  PoolCoordinator  │  Tracks slot leases & free pool VRAM
               └─────────┬─────────┘
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   Device #0        Device #1       Host Standby
  (e.g. CUDA)      (e.g. ROCm)      (Metal / CPU)
```

### Key Placement Rules
- **Best-Fit & Co-Location**: Multiple lightweight `shared` engines (for example `llama-cpp` + `whisper-cpp` + `kokoro`) co-locate in the pool whenever remaining capacity comfortably exceeds each engine's declared `resources.vram_mb`.
- **Safe Eviction via Drain**: When an incoming workload cannot fit alongside resident engines, `PoolCoordinator` blocks new leases for the target eviction candidate, waits for active HTTP/media requests to drain cleanly, stops only what must yield room, and then allocates slots for the incoming engine.
- **Atomic Multi-Device Placement**: Engines configured with `gpu_count > 1` reserve matching contiguous pool slots atomically across devices or wait until total capacity is available.
- **0-GPU / CPU Standby**: If no discrete GPU is detected, the Console switches to CPU standby mode and dispatches CPU-capable engines directly against host memory without failing gateway startup.

## 2. Three Request Queues (Non-Additive)

| Counter | Source | Lifecycle |
| --- | --- | --- |
| **Gateway Queue** | `:18982` HTTP API | Bounded per-key and global waiting slots (FIFO with cross-engine batching & anti-starvation aging). |
| **Persistent Media Jobs** | `/v1/media/jobs` & MCP | Durable job records stored in `workspace/data/media/` (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `unknown`). |
| **ComfyUI Native Queue** | Direct `:18188` UI | Tracked directly via ComfyUI `/system_stats`, `/queue`, and `/history?max_items=100` so VramDeck never tears down an active canvas job mid-run. |

> **Important Boundary**: Submitting workflows directly inside the raw ComfyUI web canvas bypasses VramDeck's gateway admission and per-key rate quotas. Pool switching still inspects ComfyUI `/queue` for idleness before evicting the shared ComfyUI runtime, while programmatic API/MCP traffic should always go through `:18982`.

## 3. Shared ComfyUI Runtime

Engines sharing one `runtime.id` (such as `anima` and `pation-model-minimax-h3` in the `rocm-pro` pack, or workflows attached to the core `comfyui` external runtime) switch without tearing down or restarting the underlying ComfyUI backend. Non-ComfyUI engines still wait for `/queue` idleness before claiming that VRAM.

## 4. Web Console Structure (`:13000`)

The Console ships with full **`EN` / `中文`** localization and follows one dark workstation instrument layout:

| Section | Hash Route | Purpose |
| --- | --- | --- |
| **Overview** | `#/overview` | Headline pool KPIs, live Compute Pool Topology (per-device VRAM bars, active slot segments, 3-col util/temp/power), model service cards, recent artifacts |
| **Engine & Model Hub** | `#/hub` | Pool status bar, Engine catalog (`Core` / `ROCm Pro`), Model weights table with mirror pull (`huggingface` / `hf-mirror` / `modelscope`) & local directory linking, Localhost service scanner/adopter |
| **Artifacts** | `#/library` | Filterable gallery of generated images, videos, audio, and transcripts |
| **Tasks** | `#/tasks` | Persistent job history, gateway completion logs, and native ComfyUI queue monitor |
| **Services** | `#/services` | Deep runtime telemetry, active request timelines, context/KV tuning, and live container/process logs |
| **Engines** | `#/engines` | Package enable/disable switches and primary/fallback routing priority chains |
| **API** | `#/api` | Live OpenAI + Hub + Media endpoint catalog and copy-paste snippets |
| **MCP** | `#/mcp` | Stdio MCP configuration helper, live schema viewer, and call stats |
| **Access & Keys** | `#/keys` | API key issuance (SHA256 hashed), concurrency/RPM/queue quotas, and public switchboard |
