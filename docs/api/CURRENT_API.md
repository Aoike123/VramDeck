# HTTP & Hub API Reference

[Documentation Index](../README.md) · [Media MCP Server](MEDIA_MCP.md) · [Public Access & Keys](PUBLIC_API.md)

## 1. Listeners & Trust Boundaries

| Listener | Default Port | Purpose | Access Policy |
| --- | ---: | --- | --- |
| **Inference Gateway** | `18982` | OpenAI chat/images/videos/audio & persistent `/v1/media/*` | Loopback; `Authorization: Bearer local` allowed locally; distributed SHA256 keys enforced when provided or via `X-Workbench-Public` |
| **Web Console & Hub API** | `13000` | Console UI, telemetry `/data`, `/api/hub/*`, `/api/platform/*`, `/api/access-keys` | Local same-origin Console only (rejects cross-origin/public writes) |
| **Local Lease Control** | `18990` | Low-level pool lease coordination (`/status`, `/acquire`, `/renew`, `/release`) | Loopback non-browser requests only |

`GET http://127.0.0.1:18982/health` reports control-plane readiness; inference models still load on demand unless already warm.

---

## 2. OpenAI-Compatible Gateway (`:18982`)

### Models & Chat

- `GET /v1/models` — Returns active engine models with context limits and optional reasoning metadata (`reasoning`, `reasoningEfforts`, `compat`).
- `POST /v1/chat/completions` — Standard OpenAI streaming (`stream: true` SSE) and non-streaming chat completion. Compatible across enabled LLM packages (`llama-cpp`, `ollama`, `vllm`, or `rocm-pro` `qwen38-27b-w3a4`).

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:18982/v1", api_key="local")
resp = client.chat.completions.create(
    model="llama-cpp",
    messages=[{"role": "user", "content": "Hello from VramDeck"}],
    max_tokens=512,
)
print(resp.choices[0].message.content)
```

### Synchronous Media Endpoints

Sync routes depend on which engine packages declare those capabilities as active:
- `POST /v1/images/generations` — Synchronous text-to-image (returns `data[0].b64_json` + timing metrics).
- `POST /v1/images/edits` — Synchronous reference image edit/restyling (`images_b64` or `image_b64`).
- `POST /v1/videos/generations` — Synchronous video generation (long timeout recommended; relative artifact URLs resolve against gateway origin).
- **Job-backed Sync Audio**: `/v1/audio/speech`, `/v1/audio/voices`, `/v1/audio/separations`, `/v1/audio/transcriptions` (controlled via capability `sync_via: "job"`, returning audio directly on `Accept: audio/*` or HTTP `202` with `job_id` on timeout).

---

## 3. Persistent Media Jobs API (`:18982/v1/media/*`)

Shared with the stdio MCP server; assets and jobs are strictly isolated per API key identity:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/media/assets?kind=image\|video\|audio` | Upload raw `application/octet-stream` asset (`201` with `asset_id`) |
| `POST` | `/v1/media/jobs` | Enqueue `{ tool, arguments }` (`request_id` idempotent; returns `202`) |
| `GET` | `/v1/media/jobs?offset=0&limit=20` | Paginated jobs (`max 100`) scoped to caller key |
| `GET` | `/v1/media/jobs/{job_id}?wait_seconds=10` | Long-poll job status (`0–20s`) |
| `POST` | `/v1/media/jobs/{job_id}/cancel` | Cancel queued job or interrupt active ComfyUI prompt |
| `GET` | `/v1/media/artifacts/{artifact_id}` | Fetch artifact metadata |
| `GET` | `/v1/media/artifacts/{artifact_id}/content` | Download generated artifact bytes |
| `GET` | `/v1/media/models` | Capability & runtime topology discovery (zero GPU load) |
| `GET` | `/v1/media/catalog` | Dynamic MCP tool definitions emitted from enabled packages |

---

## 4. Engine & Model Hub API (`:13000/api/hub/*`)

Local same-origin Console endpoints powering the Engine & Model Hub (`platforms/workbench/lib/hub-routes.ts`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/hub` or `/api/hub/catalog` | Returns `{ engines, models, downloads }` matched & VRAM-fit scored against live pool snapshot |
| `GET` | `/api/hub/engines` | Returns pool-matched catalog engines (`Core` + optional `rocm-pro`) |
| `GET` | `/api/hub/models` | Returns curated GGUF/weight entries with live `fit` (`fits`, `tight`, `too_large`), `size_bytes`, and `recommended_vram_mb` |
| `GET` | `/api/hub/downloads` | Lists active/completed download queue entries |
| `POST` | `/api/hub/scan` | Probes localhost ports (`Ollama`, `ComfyUI`, `llama-server`, `LM Studio`) for running external daemons |
| `POST` | `/api/hub/adopt` | Adopts a discovered localhost service (`{ name, kind, url, persist? }`) into the pool registry |
| `POST` | `/api/hub/engines/install` | Enables / readies a catalog engine (`{ id }`) |
| `POST` | `/api/hub/models/pull` | Starts or resumes HTTP Range `206` download (`{ model_id, mirror }`, SHA256 verified) |
| `POST` | `/api/hub/models/link` | Registers an existing local weights folder (`{ id, engine_id, dir }`) without copying |

---

## 5. Console Telemetry, Logs & Configuration (`:13000`)

| Endpoint | Purpose |
| --- | --- |
| `GET /data?model=<id>&minutes=30&window=30` | Full Console snapshot: `gpus`, `host`, `runtime_topology` (`allocations`), `services`, `values`, `trends`, `recent`, `kv_forecast`, `llm_policy` (`minutes`: `15\|30\|60`, `window`: `5\|15\|30\|60`) |
| `GET /api/engine-logs?model=<id>` | Tailed engine stdout/stderr and switch progress events |
| `POST /api/llm-mode` | Applies context/concurrency/KV budget presets (`throughput`, `long`, `long-single`, `custom`) with drain-and-restart verification |

---

## 6. Local Scheduler Lease Control (`:18990`)

| Method | Path | Body / Behavior |
| --- | --- | --- |
| `GET` | `/status` | Inspect active runtime, pool slots, and lease state |
| `POST` | `/acquire` | `{ "model": "<engine>", "timeout": 900, "shared": true }` → returns `{ token, model, lease_seconds }` |
| `POST` | `/renew` | `{ "token": "<lease_token>" }` — renews TTL (`120s` default) |
| `POST` | `/release` | `{ "token": "<lease_token>" }` — releases lease (waits if backend busy) |

Gateway inference requests automatically manage pool leases—clients calling `:18982/v1/*` do not need to call `:18990` directly.

---

## 7. HTTP Error Codes (`platforms/workbench/lib/api-errors.mjs`)

| `error.code` | HTTP | Meaning |
| --- | ---: | --- |
| `API_KEY_REQUIRED` | `401` | Missing `Authorization: Bearer <key>` on protected/public request |
| `API_KEY_INVALID` | `401` | Unknown, disabled, or revoked API key |
| `API_KEY_CONCURRENCY_LIMIT_EXCEEDED` | `429` | Per-key concurrent slot limit reached (when `maxQueued: 0`) |
| `GLOBAL_CONCURRENCY_LIMIT_EXCEEDED` | `429` | Global gateway concurrent slot limit reached |
| `API_KEY_REQUEST_RATE_LIMIT_EXCEEDED` | `429` | Per-key requests-per-minute quota exceeded |
| `GLOBAL_REQUEST_RATE_LIMIT_EXCEEDED` | `429` | Global gateway RPM quota exceeded |
| `API_KEY_QUEUE_FULL` | `429` | Per-key admission wait queue full (`maxQueued` default `8`, range `0–128`) |
| `GLOBAL_QUEUE_FULL` | `429` | Global admission wait queue full (`maxQueued` default `32`, range `0–256`) |
| `ADMISSION_BODY_BUDGET_EXCEEDED` | `429` | Concurrent/queued raw payload reservation exceeds `64 MiB` budget |
| `ADMISSION_QUEUE_WAIT_TIMEOUT` | `503` | Queued request timed out before dispatch (`queueWaitSeconds` max `900s`) |
| `KV_CAPACITY_WAIT_TIMEOUT` | `429` | Scheduled request timed out waiting for KV token budget |
| `GPU_LEASE_QUEUE_TIMEOUT` | `503` | Trusted local scheduler lease wait timed out |
