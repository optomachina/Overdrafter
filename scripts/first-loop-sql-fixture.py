#!/usr/bin/env python3
"""Generate rollback-only SQL; never connect, launch processes, or read credentials."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def literal(value):
    return "'" + json.dumps(value, separators=(',', ':')).replace("'", "''") + "'::jsonb"

def generate(preclaim='', poststop='', reader='', seed_setup='', seed_manifest='', registry=''):
    ownership = (ROOT / 'supabase/tests/engineering_native_ownership.sql').read_text()
    marker = "set local role service_role;\nselect is(pg_temp.claim(2,30,201)"
    if ownership.count(marker) != 1:
        raise ValueError('ownership fixture claim boundary changed')
    prefix = ownership.split(marker)[0]
    if not prefix.startswith('begin;\n'):
        raise ValueError('ownership fixture transaction boundary changed')
    prefix = prefix.replace('begin;\n', "begin;\nset local statement_timeout='30s';\nset local lock_timeout='5s';\n", 1)
    admission_marker = 'insert into engineering_private.native_input_admissions(id,snapshot_id,'
    if prefix.count(admission_marker) != 1:
        raise ValueError('ownership fixture seed admission boundary changed')
    prefix = prefix.replace(admission_marker, seed_setup + '\n' + admission_marker)
    if seed_manifest:
        digest_marker = "context_sha256,pg_temp.h(7),pg_temp.h(8),pg_temp.h(10)"
        if prefix.count(digest_marker) != 1:
            raise ValueError('ownership fixture seed manifest boundary changed')
        prefix = prefix.replace(digest_marker, "context_sha256,(" + seed_manifest.strip() + "),pg_temp.h(8),pg_temp.h(10)")
    template = (ROOT / 'scripts/first-loop-sql-fixture.sql').read_text()
    for name in ('manifest', 'journal'):
        value = json.loads((ROOT / f'scripts/native/stop-observer/fixtures/{name}.json').read_text())
        template = template.replace(f'@@{name.upper()}@@', literal(value))
    if registry:
        start = template.index('-- Metadata only:')
        end = template.index("select jsonb_build_object('syntheticOnly'", start)
        template = template[:start] + registry + '\n' + template[end:]
    return ('\\set ON_ERROR_STOP on\n-- SYNTHETIC METADATA ONLY. SQL/runtime/storage/native qualification UNRUN.\n' + prefix +
            '\n' + preclaim + '\n' +
            template.replace('@@POSTSTOP@@', poststop).replace('@@READER@@', reader) +
            '\nselect * from finish();\nrollback;\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('preclaim', 'poststop', 'reader', 'seed-setup', 'seed-manifest', 'registry'):
        parser.add_argument('--' + option, type=Path, help='Reviewed SQL fragment; must not contain transaction boundaries')
    args = parser.parse_args()
    fragments = {key: path.read_text() if path else '' for key, path in vars(args).items()}
    # Explicit local source fragments are code, not untrusted user data.
    print(generate(**fragments), end='')
