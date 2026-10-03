import importlib.util
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('first-loop-sql-fixture.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FixtureGeneration(unittest.TestCase):
    def test_deterministic_complete_rollback_packet(self):
        packet = module.generate()
        self.assertEqual(packet, module.generate())
        self.assertTrue(packet.endswith('rollback;\n'))
        self.assertNotIn('@@', packet)
        self.assertLess(packet.index("set local statement_timeout='30s'"), packet.index('create extension'))
        self.assertEqual(packet.count("set local statement_timeout='30s'"), 1)
        self.assertNotIn('create table public.engineering_execution_attempts', packet)
        self.assertNotIn('insert into engineering_private.native_observer_evidence', packet)
        self.assertIn('engineering_private.store_native_observer_evidence(', packet)
        self.assertIn('engineering_private.admit_qualified_native_stop(', packet)
        self.assertIn('engineering_private.register_native_result_object(', packet)
        self.assertIn('"role":"operation"', packet)
        self.assertIn('"role":"native"', packet)
        self.assertNotIn('grant ', packet)

    def test_hook_order(self):
        packet = module.generate('-- PRECLAIM SENTINEL', '-- POSTSTOP SENTINEL', '-- READER SENTINEL')
        self.assertLess(packet.index('-- PRECLAIM SENTINEL'), packet.index('first-loop real claim succeeds'))
        self.assertLess(packet.index('stop preserves exact result authority'), packet.index('-- POSTSTOP SENTINEL'))
        self.assertLess(packet.index('all seven actual registry rows retained'), packet.index('-- READER SENTINEL'))

    def test_seed_digest_bound_before_immutable_admission(self):
        packet = module.generate(seed_setup='-- SEED SETUP', seed_manifest='pg_temp.fixture_manifest_hash()', registry='-- EXACT TARGET REGISTRY')
        self.assertLess(packet.index('-- SEED SETUP'), packet.index('insert into engineering_private.native_input_admissions(id,snapshot_id,'))
        self.assertIn('context_sha256,(pg_temp.fixture_manifest_hash()),pg_temp.h(8)', packet)
        self.assertNotIn('update engineering_private.native_input_admissions', packet)
        self.assertIn('-- EXACT TARGET REGISTRY', packet)
        self.assertNotIn("values('first-loop-synthetic'", packet)

    def test_json_sql_literal_escapes_apostrophe(self):
        self.assertEqual(module.literal({'path': "O'Brien"}), '\'{"path":"O\'\'Brien"}\'::jsonb')

if __name__ == '__main__':
    unittest.main()
