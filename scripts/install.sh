#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
INSTALL_DIR="${VRAMDECK_INSTALL_DIR:-"$HOME/.local/share/vramdeck"}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --dir)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --dir requires a path argument" >&2
        exit 2
      fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#--dir=}"
      shift
      ;;
    -h|--help)
      echo "VramDeck installer (Linux / macOS) - requires Node.js >= 22.19"
      echo "Usage: $0 [--dry-run] [--dir <install-dir>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKBENCH_DIR="$REPO_ROOT/platforms/workbench"
MCP_DIR="$REPO_ROOT/platforms/mcp"

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

case "$OS_NAME" in
  Linux|Darwin)
    ;;
  MINGW*|MSYS*|CYGWIN*)
    ;;
  *)
    echo "Unsupported OS: $OS_NAME" >&2
    exit 1
    ;;
esac

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local raw
  raw="$(node -p "process.versions.node" 2>/dev/null || node -v 2>/dev/null || true)"
  raw="${raw#v}"
  local major minor
  major="${raw%%.*}"
  minor="${raw#*.}"
  minor="${minor%%.*}"
  if [[ -z "$major" || -z "$minor" ]]; then
    return 1
  fi
  if (( major < 22 || (major == 22 && minor < 19) )); then
    echo "Detected Node.js v$raw, but VramDeck requires Node.js >= 22.19." >&2
    return 2
  fi
  echo "Detected Node.js v$raw"
  return 0
}

echo "==> VramDeck Installer ($OS_NAME / $ARCH_NAME | Target: Node.js >= 22.19)"
echo "Install directory: $INSTALL_DIR"
echo "Workbench directory: $WORKBENCH_DIR"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Verified OS=$OS_NAME and target directory \"$INSTALL_DIR\""
  echo "[dry-run] Would ensure Node.js >= 22.19, run npm ci in \"$WORKBENCH_DIR\", build Next.js console, and print VramDeck URLs (http://127.0.0.1:13000 & http://127.0.0.1:18982)."
  exit 0
fi

check_node_version || {
  echo "Please install Node.js >= 22.19 (e.g., via fnm, nvm, Homebrew on Darwin, or NodeSource on Linux)." >&2
  exit 1
}

mkdir -p "$INSTALL_DIR"
npm --prefix "$WORKBENCH_DIR" ci
if [[ -f "$MCP_DIR/package.json" ]]; then
  npm --prefix "$MCP_DIR" ci
fi

WORKBENCH_NEXT_DIST=".next-workbench" npm --prefix "$WORKBENCH_DIR" run build

echo ""
echo "VramDeck installation completed!"
echo "  Console UI : http://127.0.0.1:13000"
echo "  API / MCP  : http://127.0.0.1:18982"
echo "  Start now  : node \"$WORKBENCH_DIR/cli.mjs\" start"
