"""Where everything is stored, from the single `storage` block of platforms/platform.json.

state      workspace/data/media on the internal NVMe: job records, imported materials, telemetry.
artifacts  generated media on the resource disk:
           <kind>/<YYYY-MM>/<job_id>/  durable API/MCP jobs (images, videos, audio)
           api/                        synchronous API results (/artifacts/*)
           canvas/                     the ComfyUI canvas (container /outputs)
           manual/<owner>/             maintenance commands, acceptance runs and benchmarks
The artifacts root must contain the marker file; without it the resource disk counts as offline
and nothing is written, so an unmounted disk can never fill the root partition.
"""
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "platforms/platform.json").read_text(encoding="utf-8"))["storage"]


def _path(value):
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def auto_root(kind):
    if sys.platform == "win32":
        env = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(env) if env else (Path.home() / "AppData" / "Local")
        return base / "VramDeck" / kind
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "VramDeck" / kind
    env = os.environ.get("XDG_DATA_HOME", "").strip()
    base = Path(env) if env else (Path.home() / ".local" / "share")
    return base / "vramdeck" / kind


def state():
    override = os.environ.get("MEDIA_STATE_ROOT", "").strip()
    if override:
        return _path(override)
    raw = CONFIG.get("state", "auto")
    return auto_root("state") if raw in (None, "", "auto") else _path(raw)


def artifacts(require=True):
    override = os.environ.get("MEDIA_ARTIFACTS_ROOT", "").strip()
    raw = CONFIG.get("artifacts", "auto")
    is_auto = not override and raw in (None, "", "auto")
    root = _path(override) if override else (auto_root("artifacts") if is_auto else _path(raw))
    if require and is_auto:
        root.mkdir(parents=True, exist_ok=True)
        marker = root / CONFIG["marker"]
        if not marker.is_file():
            marker.write_text("", encoding="utf-8")
    if require and not (root / CONFIG["marker"]).is_file():
        raise RuntimeError(f"作品盘未挂载或缺少标记文件：{root / CONFIG['marker']}")
    return root


def import_roots():
    roots = []
    for entry in CONFIG.get("import_roots", []):
        if not entry:
            continue
        roots.append(artifacts(require=False) if entry == "auto" else _path(entry))
    extra = os.environ.get("MEDIA_IMPORT_ROOTS", "")
    for entry in extra.split(os.pathsep):
        if entry.strip():
            roots.append(_path(entry.strip()))
    return list(dict.fromkeys(roots))


def _dir(path):
    path.mkdir(parents=True, exist_ok=True)
    return path


def canvas():
    return _dir(artifacts() / "canvas")


def api():
    return _dir(artifacts() / "api")


def manual(owner):
    """Outputs of maintenance commands for one engine package, runtime or tool."""
    return _dir(artifacts() / "manual" / owner)


def mounts():
    """Read-only mounts that let a container open materials and artifacts by their host paths."""
    return [part for root in (state(), artifacts()) for part in ("-v", f"{root}:{root}:ro")]


def owned(manifest):
    """Directories an engine package or runtime recipe owns (models, caches), as absolute paths."""
    return [_path(path) for path in manifest.get("storage", {}).get("data", [])]
