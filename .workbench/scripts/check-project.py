#!/usr/bin/env python3
"""Run every project-owned test suite without starting inference services."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "platforms/workbench"
PYTHON_SUITES = (
    ("tools", ".workbench/tests"),
    ("comfyui", "engines/shared/comfyui/tests"),
    ("scheduler", "platforms/scheduler/tests"),
    ("cpu-vision", ".workbench/runtime/cpu-vision"),
)


def run(label, command, cwd=ROOT, env=None):
    print(f"\n[{label}]", flush=True)
    try:
        return subprocess.run(command, cwd=cwd, env=env).returncode == 0
    except OSError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return False


def _node_usable(path):
    if not path:
        return False
    check = "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=19?0:1)"
    try:
        return subprocess.run([path, "-e", check], capture_output=True).returncode == 0
    except OSError:
        return False


def _node_version_key(path):
    for part in reversed(path.parts):
        if part.startswith("v"):
            nums = tuple(int(p) for p in part[1:].split(".") if p.isdigit())
            if nums:
                return nums
    return (0,)


def _nvm_node_candidates():
    candidates = []
    search_roots = [Path.home() / ".nvm" / "versions" / "node"]
    for env_var in ("NVM_HOME", "NVM_SYMLINK"):
        val = os.environ.get(env_var)
        if val:
            search_roots.append(Path(val))
    for app_env in ("APPDATA", "LOCALAPPDATA"):
        val = os.environ.get(app_env)
        if val:
            search_roots.append(Path(val) / "nvm")
            search_roots.append(Path(val) / "Author Software" / "nvm")
    exe = "node.exe" if sys.platform == "win32" else "node"
    patterns = ("v*/bin/node", "v*/node.exe", "installs/v*/node.exe", ".nodejs/node.exe", "node.exe", "bin/node")
    for root in search_roots:
        try:
            if not root.exists():
                continue
        except OSError:
            continue
        for pattern in patterns:
            try:
                for match in root.glob(pattern):
                    if match.name == exe and match.is_file():
                        candidates.append(match)
            except OSError:
                continue
    return sorted(set(candidates), key=_node_version_key)


def find_node():
    for candidate in (os.environ.get("WORKBENCH_NODE"), shutil.which("node")):
        if _node_usable(candidate):
            return candidate
    for candidate in reversed(_nvm_node_candidates()):
        if _node_usable(str(candidate)):
            return str(candidate)
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("all", "python", "node"), default="all")
    tools_env = ROOT / ".workbench/envs/tools"
    default_python = tools_env / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    parser.add_argument("--python", default=str(default_python) if default_python.is_file() else sys.executable,
                        help="Python with aiohttp installed (defaults to the existing tools environment)")
    args = parser.parse_args(argv)
    results = []
    if args.suite in ("all", "python"):
        py_env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        for name, directory in PYTHON_SUITES:
            command = [args.python, "-B", "-m", "unittest", "discover", "-s", str(ROOT / directory), "-q"]
            results.append((name, run(name, command, env=py_env)))
    if args.suite in ("all", "node"):
        node = find_node()
        if not node:
            print("ERROR: Node.js >=22.19 required; set WORKBENCH_NODE.", file=sys.stderr)
            results.append(("workbench", False))
        elif not run("node-version", [node, "-e", "const [a,b]=process.versions.node.split('.').map(Number);"
                                             "if(!(a>22||(a===22&&b>=19))){"
                                             "console.error('Node.js >=22.19 required');process.exit(1);}"]):
            results.append(("workbench", False))
        else:
            tests = sorted(
                str(path.relative_to(APP))
                for pattern in ("*.test.mjs", "*.test.ts")
                for path in (APP / "tests").glob(pattern)
            )
            if not tests:
                print("ERROR: No workbench tests found.", file=sys.stderr)
                results.append(("workbench", False))
            else:
                results.append(("workbench", run("workbench", [node, "--test", *tests], APP)))
            # Engine packages carry their own tests (engines/<category>/<id>/tests, engines/shared/*/tests).
            engine_tests = sorted({
                str(path.relative_to(ROOT))
                for pattern in ("engines/*/*/tests/*.test.mjs", "engines/*/*/tests/*.test.ts",
                                "engines/shared/*/tests/*.test.mjs", "engines/shared/*/tests/*.test.ts")
                for path in ROOT.glob(pattern)
            })
            if engine_tests:
                results.append(("engines", run("engines", [node, "--test", *engine_tests], ROOT)))
            mcp_app = ROOT / "platforms/mcp"
            mcp_tests = sorted(
                str(path.relative_to(mcp_app))
                for pattern in ("*.test.mjs", "*.test.ts")
                for path in (mcp_app / "tests").glob(pattern)
            )
            results.append(("media-mcp", run("media-mcp", [node, "--test", *mcp_tests], mcp_app) if mcp_tests else False))
    print("\n" + " | ".join(f"{name}: {'PASS' if passed else 'FAIL'}" for name, passed in results), flush=True)
    return 0 if all(passed for _, passed in results) else 1


if __name__ == "__main__":
    sys.exit(main())
