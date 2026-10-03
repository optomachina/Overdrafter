#!/usr/bin/env python3
"""Prepare an exact-source SQL CI artifact. Never connect to a database."""
import argparse
from datetime import datetime, timezone
import time
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = 'f4f0a087f041078244bbb28e081fe96d6418d036'
FIXTURE_SHA = 'f2909462eaf02d28b3fbd268e95fc6c384a19c3b80e265611b882eea5116a75d'
STAGES = [
    ('ovd558_verifier_authority', 'docs/release/ovd-558-verifier-authority-forward.sql'),
    ('ovd560_result_registry', 'docs/release/ovd-560-result-registry-forward.sql'),
    ('ovd561_finalization', 'docs/release/ovd-561-finalization-forward.sql'),
    ('ovd561_pending', 'docs/release/ovd561-pending-forward.sql'),
    ('ovd575_observer_replay', 'scripts/native/stop-observer/sql/store-native-observer-evidence-replay.staged.sql'),
    ('private_artifact', 'docs/release/private-artifact-forward.sql'),
    ('native_artifact_mapping', 'docs/release/native-artifact-mapping-forward.sql'),
    ('native_result_reader', 'docs/release/native-result-reader-forward.sql'),
]
FRAGMENTS = ('seed-setup', 'seed-manifest', 'preclaim', 'poststop', 'registry')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(args, cwd=ROOT):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, timeout=60).stdout


def await_cli_second(previous):
    deadline = time.monotonic() + 2.5
    while datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S') <= previous:
        if time.monotonic() >= deadline:
            raise ValueError('canonical_cli_clock_not_advancing')
        time.sleep(0.05)


def prepare(output, canonical=False):
    # New directory only: never overwrite a previous source/qualification receipt.
    if output.exists():
        raise ValueError('output_directory_already_exists')
    paths = set(run(['git', 'ls-tree', '-r', '--name-only', BASE, 'supabase/migrations']).decode().splitlines())
    paths.update(path for _, path in STAGES)
    tracked = run(['git', 'ls-tree', '-r', '--name-only', BASE, 'scripts', 'docs/release']).decode().splitlines()
    paths.update(path for path in tracked if path.startswith('scripts/ovd510-')
                 or path.startswith(('docs/release/ovd-558-', 'docs/release/ovd-560-', 'docs/release/ovd-561-')))
    paths.add('docs/release/ovd-510-prechange-compatibility-manifest.json')
    paths.update(['supabase/config.toml', 'supabase/tests/engineering_native_ownership.sql',
                  'scripts/first-loop-sql-fixture.py', 'scripts/first-loop-sql-fixture.sql',
                  'scripts/native-result-reader-proof.py', 'server/engineering/native-result-reader.ts'])
    paths.update(f'scripts/first-loop-sql-fixture-{name}.sql' for name in FRAGMENTS)
    paths.update(f'scripts/native/stop-observer/fixtures/{name}.json' for name in ('manifest', 'journal'))
    sources = {}
    for path in sorted(paths):
        # Preserve the reviewed authority runner as prerequisite source; current
        # lifecycle adapter is separately retained as control source below.
        data = (run(['git', 'show', f'{BASE}:{path}']) if path == 'scripts/ovd510-disposable-replay.mjs'
                else (ROOT / path).read_bytes())
        if data != run(['git', 'show', f'{BASE}:{path}']):
            raise ValueError(f'reviewed_source_drift:{path}')
        sources[path] = data
    cli = shutil.which('supabase') if canonical else None
    if canonical and not cli:
        raise ValueError('canonical_cli_unavailable')
    output.mkdir(parents=True)
    for path, data in sources.items():
        target = output / 'source' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for path in ('scripts/prepare-first-loop-sql-ci.py', 'scripts/prepare-first-loop-sql-ci.test.py',
                 '.github/workflows/jarvis-sql-source.yml', 'docs/release/first-loop-sql-ci.md',
                 'scripts/ovd510-disposable-replay.mjs', 'scripts/ovd561-race-proof.mjs',
                 'scripts/first-loop-local-sql.mjs', 'scripts/first-loop-local-sql.node-test.mjs',
                 'scripts/first-loop-authority-baseline.json'):
        target = output / 'control-source' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / path).read_bytes())
    fs = {'input': {'path': r'C:\fixture\input', 'volumeSerial': '0000000000000001', 'fileId': '1'*32},
          'candidate': {'path': r'C:\fixture\candidate', 'volumeSerial': '0000000000000001', 'fileId': '2'*32}}
    reader = run([sys.executable, 'scripts/native-result-reader-proof.py', '--dynamic-first-loop',
                  '--fragment', '--filesystem-json', json.dumps(fs)])
    (output / 'reader.sql').write_bytes(reader)
    args = [sys.executable, 'scripts/first-loop-sql-fixture.py']
    for name in FRAGMENTS:
        args.extend(['--' + name, str(output / 'source' / f'scripts/first-loop-sql-fixture-{name}.sql')])
    args.extend(['--reader', str(output / 'reader.sql')])
    fixture = run(args)
    if digest(fixture) != FIXTURE_SHA:
        raise ValueError('reviewed_fixture_digest_mismatch')
    (output / 'first-loop.sql').write_bytes(fixture)
    migrations = []
    version = None
    if canonical:
        version = run([cli, '--version']).decode().strip()
        if version != '2.78.1':
            raise ValueError('canonical_cli_version_mismatch')
        # Discover flags before mutation; no init/start/reset/status/login command.
        run([cli, 'migration', 'new', '--help'])
        project = output / 'canonical-project'
        (project / 'supabase').mkdir(parents=True)
        (project / 'supabase/config.toml').write_bytes(sources['supabase/config.toml'])
        previous_version = None
        for index, (name, path) in enumerate(STAGES):
            if previous_version is not None:
                await_cli_second(previous_version)
            before = set((project / 'supabase/migrations').glob('*.sql'))
            suffix = f'jarvis_{index:02d}_{name}'
            run([cli, 'migration', 'new', suffix], cwd=project)
            created = set((project / 'supabase/migrations').glob('*.sql')) - before
            if len(created) != 1:
                raise ValueError('canonical_cli_output_mismatch')
            target = created.pop()
            if not re.fullmatch(r'\d{14}_' + suffix + r'\.sql', target.name):
                raise ValueError('canonical_cli_output_mismatch')
            current_version = target.name[:14]
            if previous_version is not None and current_version <= previous_version:
                raise ValueError('canonical_cli_version_not_increasing')
            previous_version = current_version
            target.write_bytes(sources[path])
            migrations.append({'stage': name, 'path': str(target.relative_to(output)),
                               'sha256': digest(sources[path])})
    files = {str(path.relative_to(output)): {'sha256': digest(path.read_bytes()), 'bytes': path.stat().st_size}
             for path in sorted(output.rglob('*')) if path.is_file()}
    manifest = {'schema': 'jarvis-first-loop-sql-ci/v1', 'reviewedSource': BASE,
                'packagerHead': run(['git', 'rev-parse', 'HEAD']).decode().strip(),
                'stages': [{'name': name, 'path': path, 'sha256': digest(sources[path]),
                            'requiredRunner': 'supabase_admin' if name == 'ovd558_verifier_authority' else 'postgres'} for name, path in STAGES],
                'canonicalCli': version, 'canonicalMigrations': migrations, 'files': files,
                'verdicts': {'source': 'prepared', 'access': 'unrun', 'runtime': 'unrun', 'cleanup': 'unrun',
                             'storage': 'unrun', 'native': 'unrun'}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--canonical', action='store_true', help='Use existing pinned CLI to create a source-only migration artifact')
    args = parser.parse_args()
    try:
        manifest = prepare(args.output.resolve(), args.canonical)
        print(json.dumps({'output': str(args.output), 'verdicts': manifest['verdicts']}))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'preparation_failed: {error}', file=sys.stderr)
        sys.exit(1)
