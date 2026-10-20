# OVD-978 notes: restore the client part metadata projection (DRAFT)

This is a draft. Nothing here has been applied to any Supabase project, and nothing is in `supabase/migrations/`. Promoting it is a protected action: Blaine applies it in a migration window. The read-only hosted checks below were run on 2026-10-18 and 2026-10-19 (results are recorded in Linear OVD-978): staging and production both run the `20261011170000` body (md5 `b8ffb62b`), so the defect is live on both, and the malformed-row probes returned 0 on both. This draft patches that deployed body.

Parent: OVD-968 step 3 (GraphMyCode lead, verified locally). Introduced by OVD-670 (PR #640, migration `20261011170000_fix_no_drawing_lifecycle.sql`).

## Files

- `docs/migration-drafts/ovd-978.sql`: one `create or replace function public.api_list_client_part_metadata(uuid[])`, plus a REVOKE and a GRANT that restate the OVD-736 ACL.
- `docs/migration-drafts/ovd-978.rollback.sql`: restores the `20261011170000` body byte for byte. That body is the defective one.
- `docs/migration-drafts/ovd-978-no-drawing-test.patch`: the change to `supabase/tests/client_part_metadata_no_drawing_lifecycle.sql` that has to ship with the promotion (see "Apply order").
- `supabase/tests/pending/ovd978_client_part_metadata_projection.sql.pending`: 48 pgTAP assertions. The extraction payloads are real `buildStoredExtractionPayload` output, and `worker/src/extraction/clientMetadataProjectionPayload.test.ts` fails when a payload literal stops equalling it (OVD-976 added `tolerances.unit` and `tolerances.drawingUnits`, and the literals had drifted). The warning strings are the worker's own templates, including the operator-only model diagnostics the projection must not return.
- `src/features/quotes/client-part-metadata-projection.fixture.json` and `.test.tsx`: the end-to-end guard that was missing (worker payload, then SQL rows, then `normalizeClientPartMetadata`, then the status notice and polling). This test is not a draft. It passes on main today and runs in the normal vitest suite.

## What is broken (the live `20261011170000` body)

| Defect | User impact |
| --- | --- |
| The lifecycle, warnings, missing and review fields, page count and failure fields are nested under `clientExtraction`, but `normalizeClientPartMetadata` (`src/features/quotes/utils.ts`) reads them at the top level | Every part shows lifecycle `uploaded` and "Waiting for drawing metadata". The workspace keeps polling (`uploaded` is an active lifecycle in `client-workspace-polling.ts`). Warnings, missing fields, review fields and page count never appear |
| `warnings` and `missingFields` are read from extraction payload keys that the worker never writes. The worker puts warnings in the `drawing_extractions.warnings` column (`worker/src/index.ts`) | Even with the shape fixed, the warning count and missing fields would always be zero and empty. (The draft reads the column for the count only; see "Data boundary".) |
| The extraction fallbacks are gone: description, part number, revision, material, finish, threads and tolerance come only from the requirement | Drawing data never reaches the editable properties. The user sees `Untitled part` and `Unknown material` |
| `projectPartProperties` (the per-part defaults and overrides from 20260402) is dropped | Saved property overrides are not projected |
| `updatedAt` loses the requirement timestamps and the `nullif(-infinity)` | A part with no extraction and no task gets `updatedAt: "-infinity"` |
| `quoteQuantities` loses `normalize_positive_integer_array` | Duplicate and zero quantities (`[5,10,5,0]`) reach the client |

`20261011170000` meant to make one change: a part with no drawing gets lifecycle `succeeded` instead of `uploaded`. The draft keeps that change.

## The draft, diffed against what it replaces

The body is the `20260402120000` definition byte for byte, except for the changes below. `assemble-draft.mjs` in the evidence folder builds the draft from the migration files and checks the first three:

1. `when not projection.has_drawing_file then 'uploaded'` is changed to `'succeeded'`. This is OVD-670's intended change.
2. and 3. The last material and finish fallbacks, `extraction.extraction ->> 'material'` and `->> 'finish'`, now read the key only when `jsonb_typeof(...) = 'string'`. The worker always writes `material` and `finish` as objects. When both `raw` and `normalized` are null, the old fallback returned the whole object as text, so the client showed `{"raw": null, "reasons": [], ...}` as the material and never listed material or finish as missing. This happens on every CAD-only extraction (`worker-sim-v1`) and on drawings with no material callout. The harness found it with the real worker payload. It has been in `20260402` since April, so restoring that body unchanged would have brought it back.
4. The warning text no longer leaves the database. `extraction.warnings` is not selected into the projection, `warnings` is always `[]`, and `warning_count` is a count of the column's elements that are not operator-only diagnostics. This is a deliberate difference from `20260402`, added after the exact-head review (next section). The first three changes are single lines; this one replaces the `extraction.warnings` select, the `warning_count` expression and the `warnings` output key.

## Data boundary: warning text stays in the database

Found by the exact-head review of 3527be92. `public.drawing_extractions` is internal-only under RLS (`drawing_extractions_internal_only`), and this SECURITY DEFINER function is the only path from it to a client. The worker writes raw operator diagnostics into the `warnings` column (`worker/src/extraction/hybridExtraction.ts`, stored by `worker/src/index.ts`):

- `Model fallback failed for drawing extraction: <provider SDK error message>`. Provider auth and rate-limit messages can carry account details.
- `Model fallback skipped: spend cap reached (<api_reserve_spend reason>). Extraction used deterministic parsing only.` The reason can be a per-run ceiling figure, the operator kill switch, or a spend-ledger database error (`worker/src/spendGuard.ts`).

The `20260402` body returned the column to every member of the organisation (April to 2026-10-11). The live `20261011170000` body reads a payload key the worker never writes, so production exposes none of it today. Applying the first version of this draft would have switched it on. Not cross-tenant, but it is internal provider and spend detail in the network response.

What the client needs: only `warningCount`. `ClientExtractionStatusNotice` (`diagnostics.warningCount`) and `countPartExtractionWarnings` (`clientExtraction.warningCount`) read the count; nothing renders the `warnings` strings. (`ClientMetadataPanel` reads `extraction.warnings.length` from the internal `DrawingExtractionData`, but no page renders it, and the client workspace builds its parts with `extraction: null`, `workspace-api.ts`.) So the draft returns the count and nothing else:

- `warnings` is `[]` for every row. The key stays so the response shape matches `20260402`.
- `warningCount` skips elements that start with `Model fallback `, the prefix of the two operator diagnostics above. They say a model call did not run, not that a field needs review. Counting them also set the lifecycle to `partial`, so a part with nothing to review showed "Review N drawing fields". Every other warning counts, including a warning the worker adds later, so a new customer-relevant warning is not dropped. A new operator-only warning has to use the same prefix (or be added to this filter) to stay out of the count. A count cannot leak text, so the failure mode of a missed prefix is a part shown as `partial`, not a disclosure.
- A `warnings` column that is not a JSON array counts as zero. The `20260402` body raised an error for the whole call, for every part in the requested jobs.
- The raw text stays in `drawing_extractions.warnings` for internal users, and the worker is unchanged. A worker-side alternative (store a customer-safe sentence and log the raw error) would also close this, and is optional: the draft does not rely on it.

How it is pinned:

- pgTAP (`.pending`): the partial part holds one field review warning and one model-fallback failure, and returns `warningCount` 1 and `warnings` `[]`. The complete part holds only a spend-guard warning, and stays `succeeded` with count 0. A whole-response text search finds none of the operator or review strings. A part whose column is a JSON object returns count 0 instead of erroring.
- vitest (`client-part-metadata-projection.test.tsx`): the same rows through `normalizeClientPartMetadata`, and no operator string anywhere in the projected rows.
- worker (`hybridExtraction.test.ts`): the two operator diagnostics keep the `Model fallback ` prefix the SQL filters on.

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
| Warning text | none (reads a payload key the worker never writes) | none: `warnings` is `[]`, `warningCount` skips operator-only diagnostics | the 20260402 text exposure is not restored |

The harness compares owner, `prosecdef`, `provolatile`, language, `proconfig`, result type, the ACL entries, and `has_function_privilege` for anon, authenticated and service_role, before and after the draft. They are identical.

### Security-definer lint

`node scripts/lint-security-definer.mjs docs/migration-drafts/ovd-978.sql` passes the revoke and grant clauses. It reports one failure, `search_path = public starts with public`, in report mode, not enforced. Once promoted, the file would show up as a new failing entry. Hardening the path to `''` is a one-line change. The harness ran the same body under `set search_path = ''` and got identical rows, because every relation and helper the body uses is schema-qualified and the built-ins resolve through `pg_catalog`. The draft keeps `public` because the unit's rule is to keep the replaced function's attributes exactly. Blaine decides whether to harden it when promoting.

## Read-only hosted checks (run first: staging, then production)

These were run read-only on staging and then production on 2026-10-18 and 2026-10-19 (results in Linear OVD-978). Re-run checks 1 to 3 on staging right before the apply, and after it. Each runs in a `begin transaction read only; ... rollback;`. The full statements are in `sql-drafts/OVD-978/hosted-checks.sql` in the evidence folder.

1. `select pg_get_functiondef('public.api_list_client_part_metadata(uuid[])'::regprocedure);` together with owner, `prosecdef`, `proconfig`, `proacl`, `md5(pg_get_functiondef)` and three shape probes (`nested_ovd670_shape_live`, `no_drawing_succeeded`, `warnings_from_column`). `warnings_from_column` looks for `extraction.warnings,` in the definition. It is true for `20260402` and false for this draft, because the draft no longer selects the column text, so read a false after the apply as expected.
2. `select version, name from supabase_migrations.schema_migrations where version in ('20260402120000','20261011170000','20261015074957') order by version;`
3. `has_function_privilege` for anon (expected false), authenticated and service_role (expected true).
4. Parts counted by derived lifecycle, using the branch order of both bodies, with counts that have column warnings and review fields. It returns counts only. Under the live body the client shows every part as `uploaded`; this count says what the draft would show instead.

5. Malformed-row probe (added after the Opus review). Restoring the 20260402 body brings back failure points the live body does not have: `jsonb_array_elements_text` on `extraction -> 'threads'`, `::numeric` casts on `tolerances.valueInch` and the override tolerance, and `::boolean` casts on the `reviewNeeded` flags. One malformed row makes the whole call error for every part in the requested jobs. (The `warnings` column was one more failure point in `20260402`, through `jsonb_array_length`; this draft counts it defensively, so a non-array there no longer matters.) Run this counts-only probe before apply; every count must be 0:

```sql
begin transaction read only;
select
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
3. Apply on staging. Re-run checks 1 and 3; expect `nested_ovd670_shape_live = false`, an identical ACL and `search_path=public`. Open a part with a drawing and confirm the status notice and properties. As an organisation member, call `api_list_client_part_metadata` for one staging job and confirm every returned row has `"warnings": []`.
4. Production, after the staging result is recorded and Blaine approves.

No data migration is needed. The function reads existing rows. Nothing is backfilled.

## Rollback

Apply `docs/migration-drafts/ovd-978.rollback.sql` as a forward migration in a window. It restores the `20261011170000` body byte for byte. CREATE OR REPLACE keeps the ACL, and the harness confirms the attributes are unchanged after rollback. Rolling back brings OVD-978 back (every part reads `uploaded`), so use it only if a signed-in flow breaks and cannot be fixed forward. It does not reopen the warning-text boundary: the restored body reads a payload key the worker never writes and projects no warning text. The test patch must be reverted in the same change, and the promoted `ovd978_*.sql` pgTAP file removed with it. The rollback file needed no change for the data-boundary fix: it is still the `20261011170000` body, byte for byte (the harness checks that rollback output equals the live output).

## What is NOT changed

- No table, column, index, policy, trigger, data or other function changes.
- No grant is widened, and the ACL entry set is the same.
- `user_can_access_job` and the `requested_jobs` access filter are unchanged. A signed-in non-member still gets `[]` (pgTAP and harness).
- The worker and the client normalizer are unchanged. The raw `drawing_extractions.warnings` text stays where it is, internal-only.
- `lastFailureMessage` is still `work_queue.last_error` (the worker's bounded error message). It has been projected that way since `20260402` and the live body does the same, so this draft does not change it. The failed-extraction notice renders it. Whether worker error text should reach the client is a separate question that this draft leaves open; the review of this change did not cover it.
- Known and left alone (present since 20260402, cosmetic): `threads` is `""` rather than `null` when no thread is found; `quoteFinish` and `quoteDescription` come only from `spec_snapshot`.

## How to verify

Locally, with no network and no hosted database, using the PGlite harness in the evidence folder:

```bash
node --experimental-strip-types --no-warnings <evidence>/sql-drafts/OVD-978/harness.mjs <worktree>
npx vitest run src/features/quotes/client-part-metadata-projection.test.tsx
```

The harness loads the exact function bodies from the migrations in order (20260315, 20260316, 20260402, 20261011, plus the OVD-736 lines). It inserts the fixture with the real worker builder's output and checks:

- the pending pgTAP fails 31 of 48 assertions against the live body and passes 48 of 48 against the draft;
- the fixture's `expected.draft` and `expected.liveOvd670` rows are exactly what the SQL returns;
- the attributes and ACL are unchanged;
- the `''` search_path variant returns identical rows;
- rollback restores the OVD-670 output, and re-applying the draft is idempotent;
- the pgTAP payload literals equal the builder output (CI also checks this, in `worker/src/extraction/clientMetadataProjectionPayload.test.ts`);
- the existing OVD-670 test passes before the draft, fails after it, and passes with the patch;
- the hosted checks parse.

Last run, with the data-boundary change: `RESULT: PASS` (pending pgTAP 48 of 48, payload literals equal the builder output). In CI, the ephemeral-db job (report mode) selects the `ovd-978.sql` and `ovd978_*.sql.pending` family and runs the pending pgTAP against a real local Supabase stack. It ran at 3527be92, before the data-boundary change: baseline policy suite 76 files and 3449 assertions passed, `ovd-978.sql` applied, and the 43-assertion pending file passed 43 of 43. It has to run again on the next push, with the 48-assertion file and the changed body.
