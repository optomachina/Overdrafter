# RLS deny-case coverage (OVD-847)

Every row level security change in `supabase/migrations/*.sql` needs pgTAP
deny cases in `supabase/tests/**/*.sql`. `scripts/check-rls-deny-coverage.mjs`
checks this on every PR.

## What counts as a change

The checker reads each added or modified migration with a tolerant tokenizer
(comments, string literals and `$$` / `$tag$` bodies are blanked out) and
collects:

- `CREATE POLICY`, `ALTER POLICY` (including `RENAME TO`) and `DROP POLICY`
  give a `(schema.table, policy)` entry.
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
  give a table-level entry (`policy: null`).
- `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` and `NO FORCE ROW LEVEL SECURITY`
  always fail. Weakening RLS needs Blaine.

Unqualified table names resolve to `public`. Policy statements built
dynamically inside `DO` blocks or functions (`execute format(...)`) are not
seen; write those as plain statements, or tag their tests anyway.

## Deny tag convention

Each entry's table needs three deny cases, each in a block opened by a comment
line in a pgTAP file:

```sql
-- deny: anon public.widgets
set local role anon;
select throws_ok($$select id from public.widgets$$, '42501', null, 'anon cannot read widgets');
reset role;

-- deny: other_user public.widgets
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222"}';
select is_empty($$select id from public.widgets$$, 'a non-owner sees no widgets');
reset role;

-- deny: role_boundary public.widgets
set local role authenticated;
select results_eq(
  $$select count(*)::int from public.widgets where owner_id <> auth.uid()$$,
  $$values (0)$$,
  'authenticated callers never see service-role-only rows'
);
reset role;
-- end deny
```

| Case | Proves |
| --- | --- |
| `anon` | the `anon` role is denied |
| `other_user` | another authenticated user (non-owner, other organization) is denied |
| `role_boundary` | the role boundary holds: authenticated vs `service_role`, or non-admin vs admin |

Rules:

- The tag is `-- deny: <case> <schema.table>`, one table per line, always
  schema-qualified. Consecutive tag lines share one block, so a single
  assertion can cover several tables.
- A block runs to the next `-- deny:` tag, a `-- end deny` line, or the end of
  the file.
- The block must contain a deny assertion: `throws_ok`, `throws_like`,
  `throws_ilike`, `throws_matching`, `throws_imatching`, `is_empty`, or a
  zero-row `results_eq` / `set_eq` / `bag_eq` / `is` (a `count(...)` compared
  with `0`, or an empty array/set).
- The file's SQL (outside comments) must reference the table.
- Coverage is per table: once a table has all three cases, every policy on it
  is covered.

Malformed tags (unknown case, unqualified table, no assertion, table not
referenced) are reported as warnings and do not count.

## Baseline

`scripts/rls-deny-baseline.json` lists the policies and RLS-enabled tables that
existed before this convention and have no tagged tests. Unchanged baseline
entries pass. A PR that changes a baseline entry must add its deny tests.

The baseline can only shrink. On a PR the checker compares the PR's baseline
with the base commit's and fails on any added entry. After adding deny tests
for a baseline table, regenerate it:

```sh
node scripts/check-rls-deny-coverage.mjs --write-baseline
```

The vitest suite (`scripts/check-rls-deny-coverage.test.mjs`) fails while the
committed baseline is out of date with the tree.

## Gate loosening

Per the release plan (§6), a PR that grows the baseline or relaxes this check
is classified `gate_loosening` and needs a Grok Bot countersign on top of
Blaine's card. Diff mode compares the head against the base commit and flags:

| Reason `kind` | Trigger |
| --- | --- |
| `baseline_entry_added` | the head baseline lists an entry the base baseline does not |
| `baseline_entry_widened` | a same `(table, policy)` entry gains or changes fields |
| `baseline_unreadable` | the head baseline is not a valid `ovd847.rls-deny-baseline.v1` document |
| `checker_changed` / `checker_removed` | `scripts/check-rls-deny-coverage.mjs` is edited or deleted |
| `ci_job_changed` / `ci_job_removed` | a workflow's `rls-deny-coverage` job, or a non-comment line elsewhere naming `rls-deny`, changes or goes away |

Any edit to the checker or its job counts ("needs review"); the checker does
not try to judge whether the edit is harmless. A file the base commit does not
have yet is being introduced, not loosened, so the PR that adds the checker
is not flagged. Because CI runs the base copy of the checker, a PR cannot
change the detection to hide itself.

The JSON report carries a top-level field (diff mode only), for OVD-845:

```json
"gate_loosening": {
  "detected": true,
  "reasons": [{ "kind": "baseline_entry_added", "path": "scripts/rls-deny-baseline.json", "message": "..." }],
  "requires": ["grokbot_countersign", "blaine_card"]
}
```

The human report and the CI step summary print
`GATE LOOSENING: needs Grok Bot countersign + Blaine's card` followed by the
reasons.

This is report only. `gate_loosening` does not change `ok` or the exit code,
including under `--enforce`. Baseline growth still also raises its existing
`baseline_growth` finding, so `--enforce` fails on it exactly as before; a
checker or workflow edit alone never fails the build.

## Running it

```sh
# Diff mode, as CI runs it (HEAD^1 is the base as merged):
node scripts/check-rls-deny-coverage.mjs --base-ref HEAD^1 --head-ref HEAD
# Full tree against the baseline:
node scripts/check-rls-deny-coverage.mjs --all
```

Flags: `--json` prints the JSON report (schema `ovd847.rls-deny-coverage.v1`)
instead of the human report, `--json-out <file>` also writes it to a file, and
`--enforce` exits 1 on findings. Without `--enforce` the checker is in report
mode and exits 0.

CI runs the `rls-deny-coverage` job in `.github/workflows/ci.yml`
in report mode. The checker runs from the base commit's copy, so a PR cannot
edit it to skip itself; the PR that introduces it runs the head copy.
