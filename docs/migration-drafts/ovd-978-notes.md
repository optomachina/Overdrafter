# OVD-978 notes: restore the client part metadata projection (DRAFT)

This is a draft. Nothing here has been applied to any Supabase project, and nothing is in `supabase/migrations/`. Promoting it is a protected action: Blaine applies it in a migration window. Staging and production were not read while preparing it, so whether either one runs the defective body is **unverified**. The read-only checks below answer that.

Parent: OVD-968 step 3 (GraphMyCode lead, verified locally). Introduced by OVD-670 (PR #640, migration `20261011170000_fix_no_drawing_lifecycle.sql`).

## Files

- `docs/migration-drafts/ovd-978.sql`: one `create or replace function public.api_list_client_part_metadata(uuid[])`, plus a REVOKE and a GRANT that restate the OVD-736 ACL.
- `docs/migration-drafts/ovd-978.rollback.sql`: restores the `20261011170000` body byte for byte. That body is the defective one.
- `docs/migration-drafts/ovd-978-no-drawing-test.patch`: the change to `supabase/tests/client_part_metadata_no_drawing_lifecycle.sql` that has to ship with the promotion (see "Apply order").
- `supabase/tests/pending/ovd978_client_part_metadata_projection.sql.pending`: 43 pgTAP assertions. The extraction payloads are real `buildStoredExtractionPayload` output.
- `src/features/quotes/client-part-metadata-projection.fixture.json` and `.test.tsx`: the end-to-end guard that was missing (worker payload, then SQL rows, then `normalizeClientPartMetadata`, then the status notice and polling). This test is not a draft. It passes on main today and runs in the normal vitest suite.

## What is broken (the live `20261011170000` body)

| Defect | User impact |
| --- | --- |
| The lifecycle, warnings, missing and review fields, page count and failure fields are nested under `clientExtraction`, but `normalizeClientPartMetadata` (`src/features/quotes/utils.ts`) reads them at the top level | Every part shows lifecycle `uploaded` and "Waiting for drawing metadata". The workspace keeps polling (`uploaded` is an active lifecycle in `client-workspace-polling.ts`). Warnings, missing fields, review fields and page count never appear |
| `warnings` and `missingFields` are read from extraction payload keys that the worker never writes. The worker puts warnings in the `drawing_extractions.warnings` column (`worker/src/index.ts`) | Even with the shape fixed, the warnings list and missing fields would always be empty |
| The extraction fallbacks are gone: description, part number, revision, material, finish, threads and tolerance come only from the requirement | Drawing data never reaches the editable properties. The user sees `Untitled part` and `Unknown material` |
| `projectPartProperties` (the per-part defaults and overrides from 20260402) is dropped | Saved property overrides are not projected |
| `updatedAt` loses the requirement timestamps and the `nullif(-infinity)` | A part with no extraction and no task gets `updatedAt: "-infinity"` |
| `quoteQuantities` loses `normalize_positive_integer_array` | Duplicate and zero quantities (`[5,10,5,0]`) reach the client |

`20261011170000` meant to make one change: a part with no drawing gets lifecycle `succeeded` instead of `uploaded`. The draft keeps that change.

## The draft, diffed against what it replaces

The body is the `20260402120000` definition byte for byte, except for three lines. `assemble-draft.mjs` in the evidence folder builds the draft from the migration files and checks this:

1. `when not projection.has_drawing_file then 'uploaded'` is changed to `'succeeded'`. This is OVD-670's intended change.
2. and 3. The last material and finish fallbacks, `extraction.extraction ->> 'material'` and `->> 'finish'`, now read the key only when `jsonb_typeof(...) = 'string'`. The worker always writes `material` and `finish` as objects. When both `raw` and `normalized` are null, the old fallback returned the whole object as text, so the client showed `{"raw": null, "reasons": [], ...}` as the material and never listed material or finish as missing. This happens on every CAD-only extraction (`worker-sim-v1`) and on drawings with no material callout. The harness found it with the real worker payload. It has been in `20260402` since April, so restoring that body unchanged would have brought it back.

Compared with the live `20261011170000` definition:

| Attribute | Live (OVD-670) | Draft | Change |
| --- | --- | --- | --- |
| Signature, return type | `(p_job_ids uuid[]) returns jsonb` | same | none |
| Language, volatility | `sql stable` | same | none |
| `security definer` | yes | yes | none |
| `search_path` | `public` | `public` | none |
| Owner | `postgres` | kept by CREATE OR REPLACE | none |
| ACL | after OVD-736: `postgres`, `authenticated`, `service_role` EXECUTE; no PUBLIC, no anon | kept by CREATE OR REPLACE; the restated `revoke ... from public, anon` and `grant ... to authenticated, service_role` are copied byte for byte from `20261015074957` | none (no-ops where OVD-736 is applied; they never widen) |
| Access check | `public.user_can_access_job(job.id)` in `requested_jobs` | same | none |
| Response shape | nested `clientExtraction` | top level (20260402 shape) | restored |

The harness compares owner, `prosecdef`, `provolatile`, language, `proconfig`, result type, the ACL entries, and `has_function_privilege` for anon, authenticated and service_role, before and after the draft. They are identical.

### Security-definer lint

`node scripts/lint-security-definer.mjs docs/migration-drafts/ovd-978.sql` passes the revoke and grant clauses. It reports one failure, `search_path = public starts with public`, in report mode, not enforced. Once promoted, the file would show up as a new failing entry. Hardening the path to `''` is a one-line change. The harness ran the same body under `set search_path = ''` and got identical rows, because every relation and helper the body uses is schema-qualified and the built-ins resolve through `pg_catalog`. The draft keeps `public` because the unit's rule is to keep the replaced function's attributes exactly. Blaine decides whether to harden it when promoting.

## Read-only hosted checks (run first: staging, then production)

These need Blaine's authorization. Each runs in a `begin transaction read only; ... rollback;`. The full statements are in `sql-drafts/OVD-978/hosted-checks.sql` in the evidence folder.

1. `select pg_get_functiondef('public.api_list_client_part_metadata(uuid[])'::regprocedure);` together with owner, `prosecdef`, `proconfig`, `proacl`, `md5(pg_get_functiondef)` and three shape probes (`nested_ovd670_shape_live`, `no_drawing_succeeded`, `warnings_from_column`).
2. `select version, name from supabase_migrations.schema_migrations where version in ('20260402120000','20261011170000','20261015074957') order by version;`
3. `has_function_privilege` for anon (expected false), authenticated and service_role (expected true).
4. Parts counted by derived lifecycle, using the branch order of both bodies, with counts that have column warnings and review fields. It returns counts only. Under the live body the client shows every part as `uploaded`; this count says what the draft would show instead.

5. Malformed-row probe (added after the Opus review). Restoring the 20260402 body brings back failure points the live body does not have: `jsonb_array_length` on the `warnings` column, `jsonb_array_elements_text` on `extraction -> 'threads'`, `::numeric` casts on `tolerances.valueInch` and the override tolerance, and `::boolean` casts on the `reviewNeeded` flags. One malformed row makes the whole call error for every part in the requested jobs. Run this counts-only probe before apply; every count must be 0:

```sql
begin transaction read only;
select
  (select count(*) from public.drawing_extractions e
    where e.warnings is not null and jsonb_typeof(e.warnings) <> 'array') as warnings_not_array,
  (select count(*) from public.drawing_extractions e
    where e.extraction -> 'threads' is not null and jsonb_typeof(e.extraction -> 'threads') <> 'array') as threads_not_array,
  (select count(*) from public.drawing_extractions e
    where nullif(e.extraction #>> '{tolerances,valueInch}', '') is not null
      and nullif(e.extraction #>> '{tolerances,valueInch}', '') !~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$') as extraction_tolerance_not_numeric,
  (select count(*) from public.approved_part_requirements r
    where nullif(r.spec_snapshot #>> '{projectPartProperties,overrides,tightestToleranceInch}', '') is not null
      and nullif(r.spec_snapshot #>> '{projectPartProperties,overrides,tightestToleranceInch}', '') !~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$') as override_tolerance_not_numeric,
  (select count(*) from public.drawing_extractions e
    where exists (
      select 1
      from unnest(array[
        e.extraction #>> '{extractedDescriptionRaw,reviewNeeded}',
        e.extraction #>> '{extractedPartNumberRaw,reviewNeeded}',
        e.extraction #>> '{extractedRevisionRaw,reviewNeeded}',
        e.extraction #>> '{material,reviewNeeded}',
        e.extraction #>> '{extractedFinishRaw,reviewNeeded}'
      ]) as flag(value)
      where nullif(flag.value, '') is not null
        and lower(flag.value) not in ('true', 'false', 't', 'f', 'yes', 'no', 'on', 'off', '1', '0')
    )) as review_flag_not_boolean;
rollback;
```

If any count is not 0, the draft needs a defensive cast (or a data repair decided by Blaine) before apply: do not apply with a non-zero count. A reviewer also noted that the restored fallback lets the editor show a tolerance from the extraction while `approved_part_requirements.tightest_tolerance_inch` is null (the OVD-683 Xometry gate reads the requirement and blocks until the user confirms); with OVD-976 unshipped a mm drawing shows its mm number as inches, so ship OVD-976 first or in the same window.

Interpretation:

- If check 1 says `nested_ovd670_shape_live = true`, the defect is live. Verify an affected part in the app before calling it an incident.
- If check 2 has no `20261011170000` row, OVD-670 was never applied there. The draft is then still correct and still needed, because it fixes the 20260402 material and finish leak and adds the no-drawing change.

## Apply order (Blaine-approved window only)

1. Run the read-only checks above and record their output on staging.
2. Make one change containing: `npm run migration:new`, with the draft body copied unchanged; rename `supabase/tests/pending/ovd978_client_part_metadata_projection.sql.pending` to `supabase/tests/ovd978_client_part_metadata_projection.sql`; `git apply docs/migration-drafts/ovd-978-no-drawing-test.patch`. The existing OVD-670 test reads `clientExtraction` and uses a fake payload, so it fails against the draft (4 not ok in the harness) until the patch is applied. With the patch it passes.
3. Apply on staging. Re-run checks 1 and 3; expect `nested_ovd670_shape_live = false`, an identical ACL and `search_path=public`. Open a part with a drawing and confirm the status notice and properties.
4. Production, after the staging result is recorded and Blaine approves.

No data migration is needed. The function reads existing rows. Nothing is backfilled.

## Rollback

Apply `docs/migration-drafts/ovd-978.rollback.sql` as a forward migration in a window. It restores the `20261011170000` body byte for byte. CREATE OR REPLACE keeps the ACL, and the harness confirms the attributes are unchanged after rollback. Rolling back brings OVD-978 back (every part reads `uploaded`), so use it only if a signed-in flow breaks and cannot be fixed forward. The test patch must be reverted in the same change.

## What is NOT changed

- No table, column, index, policy, trigger, data or other function changes.
- No grant is widened, and the ACL entry set is the same.
- `user_can_access_job` and the `requested_jobs` access filter are unchanged. A signed-in non-member still gets `[]` (pgTAP and harness).
- The worker and the client normalizer are unchanged.
- Known and left alone (present since 20260402, cosmetic): `threads` is `""` rather than `null` when no thread is found; `quoteFinish` and `quoteDescription` come only from `spec_snapshot`.

## How to verify

Locally, with no network and no hosted database, using the PGlite harness in the evidence folder:

```bash
node --experimental-strip-types --no-warnings <evidence>/sql-drafts/OVD-978/harness.mjs <worktree>
npx vitest run src/features/quotes/client-part-metadata-projection.test.tsx
```

The harness loads the exact function bodies from the migrations in order (20260315, 20260316, 20260402, 20261011, plus the OVD-736 lines). It inserts the fixture with the real worker builder's output and checks:

- the pending pgTAP fails 27 of 43 assertions against the live body and passes 43 of 43 against the draft;
- the fixture's `expected.draft` and `expected.liveOvd670` rows are exactly what the SQL returns;
- the attributes and ACL are unchanged;
- the `''` search_path variant returns identical rows;
- rollback restores the OVD-670 output, and re-applying the draft is idempotent;
- the pgTAP payload literals equal the builder output;
- the existing OVD-670 test passes before the draft, fails after it, and passes with the patch;
- the hosted checks parse.

Last run: `RESULT: PASS`. In CI, the ephemeral-db job (report mode) selects the `ovd-978.sql` and `ovd978_*.sql.pending` family and runs the pending pgTAP against a real local Supabase stack. That run has not happened yet, because nothing has been pushed.
