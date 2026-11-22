import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE=Path(__file__).resolve().parents[1]/'controller.py'
spec=importlib.util.spec_from_file_location('comfy_controller',SOURCE)
controller=importlib.util.module_from_spec(spec);spec.loader.exec_module(controller)

class WorkflowSyncTests(unittest.TestCase):
    def test_flat_sync_is_idempotent_and_preserves_custom_and_modified_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';data=root/'data'
            library=data/'user/default/workflows'
            (source/'workflows/ui').mkdir(parents=True)
            (source/'workflows/ui/example.json').write_text('{"version":1}',encoding='utf-8')
            (source/'workflows/catalog.json').write_text(json.dumps({'workflows':[{'id':'example','category':'视频生成','title':'H3','ui':'ui/example.json'}]}),encoding='utf-8')
            (library/'工作台模板/02-video').mkdir(parents=True)
            (library/'工作台模板/02-video/old.json').write_text('old template',encoding='utf-8')
            (library/'我的工作流/20261015-自定义').mkdir(parents=True)
            custom=library/'我的工作流/20261015-自定义/自己的工作流.json';custom.write_text('user-owned',encoding='utf-8')
            old_data,old_here,old_workflows=controller.DATA,controller.HERE,controller.WORKFLOWS
            controller.DATA,controller.HERE,controller.WORKFLOWS=data,source,library
            try:
                controller.sync_workflows()
                target=library/'视频生成/H3.json';self.assertTrue(target.is_file())
                controller.sync_workflows()
                self.assertEqual(custom.read_text(encoding='utf-8'),'user-owned')
                self.assertFalse((library/'工作台模板').exists())
                target.write_text('my edit',encoding='utf-8')
                controller.sync_workflows()
                backups=list((data/'workflow-backups').rglob('*.json'))
                self.assertIn('my edit',[p.read_text(encoding='utf-8') for p in backups])
                self.assertIn('old template',[p.read_text(encoding='utf-8') for p in backups])
                self.assertEqual(target.read_text(encoding='utf-8'),'{"version":1}')
            finally:controller.DATA,controller.HERE,controller.WORKFLOWS=old_data,old_here,old_workflows

if __name__=='__main__':unittest.main(verbosity=2)
