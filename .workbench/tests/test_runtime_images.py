"""Runtime image recipes, the shared SDK mount, registered storage and engine package resources."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".workbench/runtime"))
sys.path.insert(0, str(ROOT / ".workbench"))
import images  # noqa: E402
import storage  # noqa: E402
from rocm101 import sdk  # noqa: E402

spec = importlib.util.spec_from_file_location("lab_cli", ROOT / ".workbench/cli.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class RecipeTests(unittest.TestCase):
    def test_every_gpu_runtime_has_one_recipe_on_a_pinned_base(self):
        recipes = images.recipes()
        self.assertTrue({"llm", "qwen-image", "comfy", "vbench"} <= set(recipes))
        runtimes = {m["platform"]["runtime"]["id"] for m in cli.registry().values() if m.get("platform")}
        for runtime, recipe in recipes.items():
            self.assertIn("@sha256:", recipe["base"], runtime)
            self.assertEqual(recipe["steps"][0], {"script": "attach-sdk.py"}, runtime)
            if runtime != "vbench":
                self.assertIn(runtime, runtimes, f"{runtime} builds an image no engine runs on")
            for step in recipe["steps"]:
                if "script" in step and "/" in step["script"]:
                    self.assertTrue((ROOT / step["script"]).is_file(), step["script"])

    def test_build_script_copies_replaces_and_cleans_up(self):
        recipe = {"_file": "x", "steps": [{"script": "attach-sdk.py"},
                  {"copy": {"runtime": "llm", "from": "/a", "names": ["torch"], "into": "/opt/site", "replace": ["torch", "torch-*.dist-info"]}},
                  {"script": "engines/shared/comfyui/image/assemble.sh"}, {"remove": ["/opt/rocm"]}]}
        script = images.script(recipe, Path("/tmp/ctx"))
        self.assertIn("python3 /src/.workbench/runtime/rocm101/steps/attach-sdk.py", script)
        self.assertIn("rm -rf /opt/site/torch-*.dist-info\ntar -xf /build/copy-1.tar -C /opt/site", script)
        self.assertIn("sh /src/engines/shared/comfyui/image/assemble.sh", script)
        self.assertIn("rm -rf '/opt/rocm'", script)
        self.assertTrue(script.rstrip().endswith("rm -rf /tmp/* /root/.cache/pip"))

    def test_flattened_image_keeps_base_config_and_runs_on_rocm101(self):
        config = {"Env": ["PATH=/opt/rocm101/bin:/usr/bin", "LANG=C.UTF-8"], "Entrypoint": ["python3", "main.py"], "Cmd": ["--port", "1"],
                  "WorkingDir": "/app", "ExposedPorts": {"8188/tcp": {}}, "Volumes": {"/models/cache": {}}, "Labels": {"a": "b"}}
        rows = images.changes(config, {"HSA_ENABLE_SDMA": "0"}, {"Cmd": None, "WorkingDir": "/opt/x"})
        self.assertIn("ENV PATH=/opt/rocm101/bin:/usr/bin", rows)
        self.assertIn("ENV ROCM_PATH=/opt/rocm101", rows)
        self.assertIn("ENV HSA_ENABLE_SDMA=0", rows)
        self.assertIn('ENTRYPOINT ["python3", "main.py"]', rows)
        self.assertFalse(any(row.startswith("CMD") for row in rows))
        self.assertIn("WORKDIR /opt/x", rows)
        self.assertIn('VOLUME ["/models/cache"]', rows)

    def test_activation_keeps_the_previous_tag_and_refuses_unknown_runtimes(self):
        with tempfile.TemporaryDirectory() as directory:
            old, images.STATE = images.STATE, Path(directory) / "runtime-images.json"
            info, images.image_info = images.image_info, lambda tag: {"Id": tag}
            try:
                images.activate("llm", "local-ai/qwen38:1")
                images.activate("llm", "local-ai/qwen38:2")
                self.assertEqual(images.state()["llm"], {"image": "local-ai/qwen38:2", "previous": "local-ai/qwen38:1"})
                self.assertEqual(images.referenced(), {"local-ai/qwen38:1", "local-ai/qwen38:2"})
                with self.assertRaisesRegex(RuntimeError, "未知运行时"):
                    images.activate("nope", "x")
                with self.assertRaisesRegex(RuntimeError, "还没有激活镜像"):
                    images.active("qwen-image")
            finally:
                images.STATE, images.image_info = old, info


class SdkTests(unittest.TestCase):
    def test_mount_is_read_only_and_refuses_an_incomplete_sdk(self):
        with tempfile.TemporaryDirectory() as directory:
            old_store, old_here = sdk.STORE, sdk.HERE
            sdk.STORE, sdk.HERE = Path(directory) / "sdk", Path(directory)
            try:
                (Path(directory) / "sdk.json").write_text(json.dumps({"active": "9.9"}), encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "共享 ROCm SDK 不完整"):
                    sdk.mount()
                library = Path(directory) / "sdk/9.9/_rocm_sdk_devel/lib/libamdhip64.so"
                library.parent.mkdir(parents=True)
                library.write_text("", encoding="utf-8")
                self.assertEqual(sdk.mount(), ["-v", f"{Path(directory) / 'sdk/9.9'}:/opt/rocm101-sdk:ro"])
                self.assertIn("_rocm_sdk_devel/lib/libamdhip64.so", sdk.checksums(Path(directory) / "sdk/9.9"))
            finally:
                sdk.STORE, sdk.HERE = old_store, old_here

    def test_every_gpu_launch_point_mounts_the_sdk(self):
        for path in ("engines/image/pation-model-qwen-image-21/controller.py", ".workbench/runtime/cpu-vision/controller.py",
                     ".workbench/scripts/launch-configured-llm.py", "engines/shared/audiocpp/controller.py", ".workbench/scripts/run-vbench.py"):
            self.assertIn("sdk.mount()", (ROOT / path).read_text(encoding="utf-8"), path)
        self.assertIn("PAITON_ROCM101_SDK", (ROOT / "engines/shared/paiton/controller.py").read_text(encoding="utf-8"))


class StorageTests(unittest.TestCase):
    def test_an_unmarked_artifacts_root_counts_as_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            old = dict(storage.CONFIG)
            storage.CONFIG.update(artifacts=directory)
            try:
                with self.assertRaisesRegex(RuntimeError, "作品盘未挂载"):
                    storage.canvas()
                (Path(directory) / storage.CONFIG["marker"]).write_text("", encoding="utf-8")
                self.assertEqual(storage.manual("anima"), Path(directory) / "manual/anima")
                self.assertEqual(storage.mounts()[-1], f"{directory}:{directory}:ro")
            finally:
                storage.CONFIG.clear()
                storage.CONFIG.update(old)

    def test_auto_storage_resolution_and_env_overrides(self):
        self.assertEqual(storage.CONFIG["artifacts"], "auto")
        self.assertEqual(storage.CONFIG["import_roots"], ["auto"])
        with tempfile.TemporaryDirectory() as directory:
            custom_state = Path(directory) / "state"
            custom_artifacts = Path(directory) / "artifacts"
            custom_import = Path(directory) / "extra"
            env = {
                "MEDIA_STATE_ROOT": str(custom_state),
                "MEDIA_ARTIFACTS_ROOT": str(custom_artifacts),
                "MEDIA_IMPORT_ROOTS": str(custom_import),
            }
            with patch.dict(os.environ, env, clear=False):
                self.assertEqual(storage.state(), custom_state)
                with self.assertRaisesRegex(RuntimeError, "作品盘未挂载"):
                    storage.artifacts(require=True)
                self.assertEqual(storage.artifacts(require=False), custom_artifacts)
                self.assertEqual(storage.import_roots(), [custom_artifacts, custom_import])

            auto_base = Path(directory) / "auto-base"
            auto_env = {
                "MEDIA_ARTIFACTS_ROOT": "",
                "LOCALAPPDATA": str(auto_base),
                "XDG_DATA_HOME": str(auto_base),
            }
            with patch.dict(os.environ, auto_env, clear=False):
                roots = storage.import_roots()
                self.assertTrue(any(str(auto_base) in str(r) for r in roots) or sys.platform == "darwin")
                if sys.platform != "darwin":
                    self.assertFalse(auto_base.exists(), "import_roots() must not create auto artifacts dir")

    def test_shared_data_and_runtimes_survive_removing_one_package(self):
        manifests = cli.registry()
        anima = cli.resources("anima", manifests)
        self.assertTrue(anima["shared_runtime"])
        self.assertEqual([shared for _, shared in anima["data"]], [True])
        qwen = cli.resources("pation-model-qwen-image-21", manifests)
        self.assertFalse(qwen["shared_runtime"])
        self.assertEqual([(path.relative_to(ROOT).as_posix(), shared) for path, shared in qwen["data"]], [("workspace/data/image/qwen-image", False)])

    def test_no_code_writes_to_the_legacy_output_links(self):
        for path in [*ROOT.glob("engines/*/*/*.py"), *ROOT.glob("engines/*/*/*.mjs"), *ROOT.glob(".workbench/scripts/*.py"),
                     *ROOT.glob("platforms/*/lib/*.mjs")]:
            if "upstream" in path.parts:
                continue
            self.assertFalse("workspace/outputs" in path.read_text(encoding="utf-8"), path)


if __name__ == "__main__":
    unittest.main()
