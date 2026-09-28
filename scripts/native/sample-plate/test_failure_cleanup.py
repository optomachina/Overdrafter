"""Exercise native failure sequencing with inert COM doubles; never load pywin32."""
import ast
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class FailureCleanup(unittest.TestCase):
    def exercise(self, save_ok):
        with tempfile.TemporaryDirectory(prefix='ovd-plate-fault-') as directory:
            source = ast.parse(Path(__file__).with_name('run.py').read_text())
            functions = [n for n in source.body if isinstance(n, ast.FunctionDef)]
            ns = {'Path': Path, 'json': json, 'os': os, 'time': time, 'sys': sys, 'hashlib': hashlib}
            exec(compile(ast.Module(body=functions, type_ignores=[]), '<inert-native>', 'exec'), ns)
            doc = SimpleNamespace(title='Part100')
            doc.GetTitle = lambda: doc.title
            app = SimpleNamespace(ActiveDoc=None, GetProcessID=lambda: 42,
                NewDocument=lambda *args: doc, CloseDoc=Mock(),
                OpenDoc6=lambda *args: (doc, 0, 0), LoadFile4=lambda *args: (doc, 99))
            ops = SimpleNamespace(connect=lambda: app, cast=lambda value, _: value, finish_plate=lambda *args: None)
            def save_base(_doc, _path):
                doc.title = 'plate.SLDPRT'
                return save_ok, 0 if save_ok else 1, 0
            ns.update({'bound_config': lambda _: dict(pid=42, processStarted=1, helperHash='h', nativeHash='n', checkerHash='c'),
                'preflight': lambda _: (Path('/helper'), Path(directory), 123), 'load_helper': lambda _: ops,
                'documents': lambda *args: [], 'build_base': save_base,
                'native': lambda *args: ({}, {'material': '6061 Alloy'}),
                'win32event': SimpleNamespace(ReleaseMutex=Mock()), 'win32api': SimpleNamespace(CloseHandle=Mock())})
            with self.assertRaises(RuntimeError):
                ns['main']({'id': 'a' * 32})
            receipt = json.loads((Path(directory) / 'native-receipt.json').read_text())
            return app.CloseDoc.call_args_list, receipt

    def test_failed_renaming_save_closes_current_owned_title(self):
        calls, _ = self.exercise(False)
        self.assertEqual([c.args[0] for c in calls], ['plate.SLDPRT'])

    def test_failed_step_import_retains_actual_error_code(self):
        _, receipt = self.exercise(True)
        self.assertEqual(receipt['stepImportErrors'], 99)


if __name__ == '__main__':
    unittest.main()
