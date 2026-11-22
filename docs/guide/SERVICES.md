# Services & Directory Layout

[Documentation Index](../README.md) · [Operations Guide](OPERATIONS.md) · [System Architecture](../design/ARCHITECTURE.md)

## Control Plane & Ports

VramDeck runs as a **single unified Node.js service** (`platforms/workbench/server.mjs`) with zero mandatory external daemon dependencies (no required Redis, Prometheus, or Kubernetes):

| Port | Role | Bind Scope | Notes |
| --- | --- | --- | --- |
| `13000` | Web Console & Management API | Local (`WORKBENCH_PORT`) | Next.js App Router + `/data`, `/api/hub/*`, `/api/platform/*`, `/api/access-keys` |
| `18982` | Unified OpenAI & Media Gateway | Loopback (`INFERENCE_PORT`) | `/v1/chat/completions`, `/v1/images/*`, `/v1/videos/generations`, `/v1/media/*` |
| `18990` | Local Lease & Scheduler Control | Loopback (`CONTROL_PORT`) | `/status`, `/acquire`, `/renew`, `/release` for trusted local tooling |

An optional user-level OS service definition (`systemd --user`, `launchd`, or Windows Task Scheduler) can manage startup/restart of this process via `node platforms/workbench/cli.mjs service install`.

## Repository Layout

```text
VramDeck/
├── lab                          POSIX convenience wrapper forwarding to platforms/workbench/cli.mjs
├── engines/                     Modular inference engine packages (manifest engine.json + adapter.mjs)
│   ├── llm/                     llama-cpp, ollama, vllm, and optional rocm-pro LLM packages
│   ├── image/                   comfyui and optional rocm-pro image packages
│   ├── video/                   optional rocm-pro video package
│   ├── audio/                   whisper-cpp, kokoro, and optional rocm-pro audio packages
│   └── shared/                  Shared ComfyUI workflow graphs and capability surface schemas
├── platforms/
│   ├── workbench/               Core control plane, DeviceProvider, PoolCoordinator, Hub, and Next.js Console
│   ├── engine-sdk/              Isolated SDK contract types imported by engine adapters
│   ├── mcp/                     Stdio MCP server (14 tools) bridging Claude Desktop / IDE agents to :18982
│   ├── installer/               Cross-platform install scripts (install.sh, install.ps1)
│   ├── monitoring/              Optional Prometheus exporter config for legacy Linux deployments
│   ├── services/                Service unit templates
│   └── public-api/              Optional reverse-proxy Caddyfile & SSH tunnel templates
├── docs/                        Architecture, API, MCP, runtime, and contributor documentation
├── tests/                       4-tier strict E2E verification suite (tests/e2e/run-e2e.ts)
└── workspace/                   Mutable local runtime state, models, logs, keys, and media artifacts
```

## Runtime Principles

1. **Unified Local Compute Pool**: All detected GPUs (`CUDA`, `ROCm`, `Metal`, `Vulkan`) and CPU memory are tracked in a single host inventory. Requests never manually pick raw card indices unless pinned via scheduler overrides; the coordinator tracks free memory, affinity, and active leases across the pool.
2. **In-Process Telemetry**: Metrics are stored in a 60-minute in-memory ring buffer with 5-second sampling and served straight out of `/data` on port `13000`.
3. **API & MCP Share One Pool**: Both `/v1/*` HTTP clients and stdio MCP agents route through the same admission queue, lease coordinator, and ComfyUI native-queue guard. Cross-runtime replacement drains active requests first before unloading idle engines.
4. **Shared ComfyUI Guard**: Image and video packages sharing one ComfyUI runtime coexist without restarts; switching out of ComfyUI waits until ComfyUI's own `/queue` reports idle. See [Runtime Topology](../design/RUNTIME_TOPOLOGY.md).
