# Media MCP Server

[Documentation Index](../README.md) · [HTTP & Hub API](CURRENT_API.md) · [Interfaces Overview](INTERFACES.md)

VramDeck exposes a **Model Context Protocol (MCP)** stdio bridge under `platforms/mcp/` connecting desktop agents (Claude Desktop, Cursor, Windsurf, Cline, or custom tool loops) directly to the unified gateway on `http://127.0.0.1:18982`.

**Zero hardcoded capabilities**: `platforms/mcp/server.mjs` queries `/v1/media/catalog` live at runtime and syncs whenever enabled engine packages change—even while a session stays open.

---

## 1. Cross-Platform Setup

Make sure the VramDeck control plane is running (`node platforms/workbench/cli.mjs start`), then initialize local MCP credentials (`0600`) once:

```bash
# Works identically on Linux, macOS, and Windows (or ./lab mcp setup on POSIX)
node platforms/mcp/cli.mjs setup
node platforms/mcp/cli.mjs check
```

Add `vramdeck-media` to your MCP host config:

```json
{
  "mcpServers": {
    "vramdeck-media": {
      "command": "node",
      "args": ["<path-to-VramDeck>/platforms/mcp/cli.mjs", "stdio"]
    }
  }
}
```

### Key Runtime Behaviors
- **Idempotency via `request_id`**: Re-sending the same `request_id` returns the original job instead of duplicating compute; reusing an ID with altered parameters is rejected.
- **Persistent Jobs**: Disconnecting the client does **not** kill running backend tasks. Poll with `get_job`; never automatically resubmit `unknown` jobs without checking first.
- **Progressive Schema Disclosure**: Initial `tools/list` output collapses expert arguments so agent context stays slim. Call `list_media_models` (with `model: "<id>"` for full schemas) when advanced parameters are needed.
- **Scoped Artifact Downloads**: Large generated files stay on disk (`workspace/` / configured download roots via `MEDIA_DOWNLOAD_ROOTS`) rather than flooding context windows with raw base64.

---

## 2. MCP Tool Inventory (14 Tools)

| Intent Layer | Tool | Purpose |
| --- | --- | --- |
| **Discovery** | `browse_media` | Entry point listing enabled categories, workflows, and companion tools |
| | `list_media_models` | Shows live enabled models, active runtime, and detailed parameter schemas |
| **Generation** | `generate_image` | Text-to-image or reference editing (routes through configured primary/fallback chain unless pinned via `model`) |
| | `generate_video` | Reference-guided video generation (accepts optional image, video, and audio references) |
| | `generate_speech` | Text-to-speech synthesis (`kokoro`, or `fish-drama3` under `rocm-pro`) |
| | `process_audio` | Audio source separation (`bs-roformer`) or speech transcription (`whisper-cpp`, `qwen3-asr`) via `task` |
| **Voice Library** | `register_voice` | Register reference voice audio with transcript metadata |
| | `search_voices` | Query saved voices by label/name |
| | `update_voice` | Rename or organize voice library entries |
| **Assets & Jobs** | `import_media` | Ingest a local PNG/JPEG/WebP, video, or audio file from permitted `import_roots` into an `asset_id` (`<= 16 MiB` images) |
| | `get_job` | Poll durable job progress and completion state (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `unknown`) |
| | `list_jobs` | Inspect recent jobs scoped to this MCP identity |
| | `cancel_job` | Cancel queued job or trigger targeted interrupt on active ComfyUI prompts |
| | `get_artifact` | Read artifact metadata and optionally save to workspace (`download: true`) |

---

## 3. Recommended Agent Call Loop

1. Call `list_media_models` first to inspect what is already loaded in the unified compute pool—reuse active runtimes for batch work to avoid unnecessary eviction swaps.
2. When passing reference files, call `import_media` once and reuse the returned `asset_id` across requests.
3. Submit work via `generate_image`, `generate_video`, `generate_speech`, or `process_audio` with a deterministic `request_id`.
4. Wait via `get_job` until `succeeded`, then retrieve metadata or download to disk with `get_artifact`.

---

## 4. Direct ComfyUI Native Boundary

Native ComfyUI workflows outside MCP's registered tool surface can still run directly against ComfyUI's own canvas (`http://127.0.0.1:8188`). VramDeck inspects ComfyUI `/system_stats`, `/queue`, and `/history?max_items=100` in read-only mode so native canvas runs are never interrupted during compute pool eviction, though raw canvas jobs do not receive persistent gateway `job_id` tracking or API key quotas.

## Testing MCP

```bash
npm test --prefix platforms/mcp
```
