"""Check request/config separation without importing COM or executing native work."""
import ast
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid


class BindingContract(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path(__file__).with_name('run.py').read_text())
        function = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'bound_config')
        namespace = {'os': os, 'Path': Path, 'uuid': uuid}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<isolated-binding>', 'exec'), namespace)
        self.bind = namespace['bound_config']
        self.config = {f'OVD_PLATE_BOUND_{k}': v for k, v in {
            'NATIVE_HASH': 'native', 'CHECKER_HASH': 'checker', 'HELPER': '/server/helper.py',
            'HELPER_HASH': 'pinned', 'PID': '7460', 'STARTED': '123', 'ROOT': '/private/output'}.items()}

    def test_only_server_paths_and_hashes(self):
        with patch.dict(os.environ, self.config):
            result = self.bind({'id': 'a' * 32})
        self.assertEqual(result['helper'], '/server/helper.py')
        self.assertEqual(result['helperHash'], 'pinned')
        self.assertEqual(Path(result['output']).name, 'a' * 32)

    def test_paths_and_hashes_cannot_enter_through_request(self):
        for request in [{'id': '../secret'}, {'id': 'a' * 32, 'helper': '/secret'}, {'id': 'a' * 32, 'nativeHash': 'guess'}, {'id': 123}]:
            with self.assertRaises((ValueError, TypeError)):
                self.bind(request)


if __name__ == '__main__':
    unittest.main()
