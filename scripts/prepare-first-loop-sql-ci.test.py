import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('packet', Path(__file__).with_name('prepare-first-loop-sql-ci.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class PacketTests(unittest.TestCase):
    def test_complete_fixture_and_runner_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'packet'
            manifest = p.prepare(output)
            self.assertEqual(p.digest((output / 'first-loop.sql').read_bytes()), p.FIXTURE_SHA)
            self.assertEqual(len(manifest['stages']), 8)
            self.assertEqual(manifest['stages'][0]['requiredRunner'], 'supabase_admin')
            self.assertEqual(manifest['stages'][1]['requiredRunner'], 'postgres')
            self.assertIn('ovd561_pending', [s['name'] for s in manifest['stages']])
            self.assertGreater(len([f for f in manifest['files'] if 'supabase/migrations/' in f]), 50)
            self.assertEqual(manifest['verdicts']['runtime'], 'unrun')
            self.assertEqual(manifest['canonicalMigrations'], [])
            with self.assertRaisesRegex(ValueError, 'already_exists'):
                p.prepare(output)

    def test_drift_rejected_before_output(self):
        real = p.run
        def changed(args, cwd=p.ROOT):
            return b'changed' if args[:2] == ['git', 'show'] else real(args, cwd)
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'run', changed):
            output = Path(directory) / 'packet'
            with self.assertRaisesRegex(ValueError, 'source_drift'):
                p.prepare(output)
            self.assertFalse(output.exists())

    def test_canonical_requires_existing_cli(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'cli_unavailable'):
                p.prepare(Path(directory) / 'packet', True)

    def test_canonical_per_stage_exact_bytes(self):
        real = p.run
        duplicate = False
        def fake_cli(args, cwd=p.ROOT):
            if args[0] != '/synthetic/supabase':
                return real(args, cwd)
            if args[1:] == ['--version']:
                return b'2.78.1\n'
            if args[-1] == '--help':
                return b'help'
            self.assertEqual(args[1:3], ['migration', 'new'])
            folder = cwd / 'supabase/migrations'
            folder.mkdir(exist_ok=True)
            (folder / (f'209901010000{0 if duplicate else len(list(folder.iterdir())):02d}_' + args[-1] + '.sql')).write_bytes(b'')
            return b''
        with tempfile.TemporaryDirectory() as directory, patch.object(p.shutil, 'which', return_value='/synthetic/supabase'), patch.object(p, 'run', fake_cli), patch.object(p, 'await_cli_second'):
            output = Path(directory) / 'packet'
            manifest = p.prepare(output, True)
            self.assertEqual(len(manifest['canonicalMigrations']), 8)
            for migration, stage in zip(manifest['canonicalMigrations'], manifest['stages']):
                self.assertEqual((output / migration['path']).read_bytes(), (p.ROOT / stage['path']).read_bytes())
            duplicate = True
            with self.assertRaisesRegex(ValueError, 'version_not_increasing'):
                p.prepare(Path(directory) / 'duplicate', True)

    def test_stalled_clock_is_bounded(self):
        with patch.object(p.time, 'monotonic', side_effect=[0, 3]):
            with self.assertRaisesRegex(ValueError, 'clock_not_advancing'):
                p.await_cli_second('99991231235959')

if __name__ == '__main__':
    unittest.main()
