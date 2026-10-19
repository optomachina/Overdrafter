# OVD-979 notes: keep user corrections through re-extraction, and extract a drawing attached later (DRAFT)

This is a draft. Nothing here has been applied to any Supabase project, and nothing is in `supabase/migrations/`. Promotion is a protected action: it happens only in a migration window that Blaine approves. Base: main `066161de`. Parent: OVD-968, step 3 (GraphMyCode lead, verified). Revision 1 addresses the independent review of revision 0 (verdict "revise before promotion", findings R1 to R6 below).

## Apply-order prerequisites (read first)

1. **OVD-976 must be deployed before `ovd-979-b.sql` is applied. This is the only real mitigation for mis-scaled tolerances.** Draft b extracts drawings attached to CAD-only parts. Until the OVD-976 worker change (Linear OVD-976, unit-aware tolerance parsing, branch `fix/ovd976-drawing-tolerance-units`) is deployed, a millimetre drawing ("±0.1") is stored as 0.1 in. Draft a's R3 rule only stops auto-approve from writing that value; the next client save can still adopt it (see R3 below). Verify the deploy before applying b, read-only:
   - Read the worker build of recent extractions: `select extraction ->> 'workerBuildVersion', updated_at from public.drawing_extractions where extractor_version not like 'worker-sim-%' order by updated_at desc limit 5;` (the same value is in the completed task payload, `work_queue.payload ->> 'workerBuildVersion'`). It is the worker's `WORKER_BUILD_VERSION` (default `dev-local`, `worker/src/config.ts`); it proves the deploy only if the deployed value identifies a build that contains the OVD-976 merge commit. Running this on staging or production needs Blaine's OK.
   - If the build value cannot prove it: a canary extraction on staging of a known metric drawing (for example ±0.1 mm) must give `tolerances.valueInch` near 0.0039, not 0.1. A staging extraction is a model run, so it also needs Blaine's OK.
   - Client-side companion: OVD-984 (branch `fix/ovd984-client-tolerance-no-reparse`, commit `342790e6`) stops the client re-parsing raw tolerance text, which removes the client fallback described under R3. It does not remove the server-side lazy seed.
2. `ovd-979-a.sql` before `ovd-979-b.sql`, never b alone. a alone is safe.
3. The OVD-846 SECURITY DEFINER lint decision (R6) is made before promotion.

## Files

- `docs/migration-drafts/ovd-979-a.sql`: replaces `public.api_auto_approve_job_requirements(uuid)` (finding 3f, plus review R1, R2, R3, R4).
- `docs/migration-drafts/ovd-979-a.rollback.sql`: restores the 20260317013000 body verbatim, plus the OVD-535 ACL. Unchanged in revision 1.
- `docs/migration-drafts/ovd-979-b.sql`: replaces `public.api_request_extraction(uuid)` (finding 1b-b, plus review R4).
- `docs/migration-drafts/ovd-979-b.rollback.sql`: restores the 20260812042000 body verbatim, plus the OVD-736 ACL. Unchanged in revision 1.
- `supabase/tests/pending/ovd979_reextraction_provenance.sql.pending`: 38 pgTAP assertions. Its header names both drafts, so the ephemeral-db stage (`scripts/ephemeral-db-apply.mjs`) applies the family in stem order (a, then b) and runs the test.

## Problem (verified by reading the migrations in order and by execution)

- **3f.** `api_update_client_part_request` was defined in 20260310110000, 20260313143000, 20260313150000, 20260316170500, 20260402120000 and 20260408120000; OVD-736 changed only its grants. The 20260316170500 version wrote `spec_snapshot.fieldSources[field] = 'user'`. The April versions (20260402120000 and 20260408120000) record corrections only in `spec_snapshot.projectPartProperties.overrides`. `api_auto_approve_job_requirements` (latest definition 20260317013000) decides ownership only from `fieldSources`. Fields with no `fieldSources` entry count as `'auto'`, and any auto field is refreshed whenever `drawing_extractions.updated_at > approved_part_requirements.updated_at`. So when a user saves while an extraction is pending (or being retried), the extraction that finishes later overwrites description, part number, revision, finish, quoteDescription and quoteFinish. Finish is sent to Xometry and SendCutSend (docs/quote-scope-trace.md).
- **1b-b.** A drawing is attached to an existing job in four steps: upload (`uploadFilesToJob`), `api_reconcile_job_parts` (its upsert sets `parts.drawing_file_id`), then `api_request_extraction`. The callers are `use-client-part-controller.ts`, `use-client-project-controller.ts` and `uploads-api.ts`. The legacy `api_attach_job_file` raises `legacy_file_attach_unavailable`. `api_request_extraction` queues `extract_part` only for parts with no `drawing_extractions` row. A part already extracted CAD-only (the worker writes `extractor_version = 'worker-sim-v1'` when no drawing was staged) is therefore never extracted from its new drawing.

## Draft a: what auto-approve now does

### Ownership (3f): option (b) only, and why not (a)

```
user_owned(field) := fieldSources[field] <> 'auto'             -- legacy, unchanged
                     OR projectPartProperties.overrides ? field  -- new
refresh(field)    := not user_owned and extraction newer and not review_needed
```

Each "refresh from newer extraction" branch tests `refresh(field)`. The override keys used by the update/reset RPCs are `description`, `partNumber`, `revision` and `finish`, the same names auto-approve uses.

- (b) also protects overrides that are already stored, with no data backfill.
- The legacy term is kept so that ownership written by `api_approve_job_requirements` (internal approval, which sets all four to `'user'` and replaces `spec_snapshot`) and by the March client RPC is not weakened (harness S7).
- Reset is not changed. `api_reset_client_part_property_overrides` removes the override key, so the field becomes auto again (pgTAP A3/A4). A legacy `fieldSources = 'user'` is not touched by reset today, and it still is not.
- Option (a), writing `fieldSources` in the update RPC, was rejected. Reset does not clear `fieldSources` (and must not be changed), so (a) would make every override sticky through a reset. It would also not protect overrides already stored, and it would replace a 300-line SECURITY DEFINER RPC.
- The `fieldSources` and `fieldOverrides` values written back by auto-approve are unchanged (still the legacy provenance), so the draft makes no new value sticky.

### R1 (high): editor defaults follow a refreshed field

When `refresh(field)` is true, auto-approve also writes the refreshed value into `spec_snapshot.projectPartProperties.defaults[field]`: `description` gets `quoteDescription` (else `description`), `finish` gets `quoteFinish` (else `finish`), `partNumber` and `revision` their column values. These are the same expressions `seed_project_part_property_defaults` would compute from the refreshed row. It changes only an existing `defaults` object; when there is none, the update RPC seeds it later from the refreshed columns, with the same result. Reset is not changed: it still removes the override key and resolves to the default, which is now the refreshed value. Without this, after CAD-only extraction, a save (which seeds CAD-only defaults), a drawing attach and its extraction: a reset wrote the stale CAD-only value (and auto-approve never repaired it, because the requirement was then newer); the next unrelated save turned every refreshed field into an override (user-owned under draft a); the editor showed stale defaults. pgTAP D3, D4, D5.

### R2 (medium): the 'Unknown material' placeholder no longer blocks an extracted material

A CAD-only auto-approval of a `manufacturing_quote` job stores `material = 'Unknown material'`. Because the requirement column wins the material coalesce, a later drawing extraction never replaced it. Now, when the requirement material is exactly `'Unknown material'` (trimmed), material is not user-owned (no `overrides.material` key, `fieldSources.material` absent or `'auto'`) and the extraction has a material (`material.normalized`, `raw` or `raw_text`), the extracted material replaces the placeholder. Without an extracted material nothing changes (the placeholder stays, also for a job that no longer requires material). The editor default follows (as R1). A user-stored `'Unknown material'` override is kept (pgTAP E1); D1 covers the replacement.

### R3 (medium, blocks): a drawing-attach extraction never fills tolerance

Decision: the conservative option. For a part that has any `extract_part` task with `payload.reason = 'drawing_attached'` (queued only by draft b), auto-approve keeps `tightest_tolerance_inch` at the requirement value instead of `coalesce(requirement, extraction)`. For a CAD-only part that value is null.

- Why: until OVD-976 ships, a millimetre drawing is stored as inches, and a newly non-null tolerance could pass the OVD-683 Xometry gate at a looser tier (and could change SendCutSend eligibility if vendors were recomputed). Null fails closed today, so keeping null is the safe default.
- Product effect: after an attach, description, part number, revision, finish and material fill in from the drawing, and auto-approve leaves tolerance at the stored value (null for a CAD-only part). `applicable_vendors` is not recomputed (unchanged rule: a stored non-empty list is kept).
- **Limit (review r1, F1): the next save can still adopt the drawing tolerance without the user choosing it.** Two paths, both on main and outside these drafts: (1) the client draft falls back to the extraction tolerance when the requirement has none (`src/features/quotes/utils.ts` `buildRequirementDraft`), so an unrelated save sends 0.1; (2) when the user never saved before the attach, `api_update_client_part_request` seeds `defaults.tightestToleranceInch` lazily from the extraction (20260408120000 `seed_project_part_property_defaults`), and a null override resolves to that default. The reviewer's harness shows the column becoming 0.1000 after an unrelated save in both cases (save sends 0.1, or sends null with override `{tightestToleranceInch: null}`). Only when the user had saved before the attach and the save sends null does tolerance stay null. So R3 is defence in depth, not a mitigation: OVD-976 deployed first is the real one, and OVD-984 removes path (1).
- Not done (considered): pinning `defaults.tightestToleranceInch` to the requirement value on an attach. When a defaults object already exists, the first save already seeded that key (null for a CAD-only part), so the pin changes nothing. Path (2) has no defaults object; creating a partial one would change what the client editor shows as defaults for every other field until the next save. Not worth it ahead of OVD-976.
- Scope: only the attach path. A drawing uploaded together with the part still fills tolerance exactly as today (pgTAP A5); that path carries the same pre-OVD-976 risk on main and is OVD-976's to fix.
- After OVD-976 is deployed this rule can be lifted in a follow-up (one `case` branch). It is deliberately not tied to OVD-976's output shape, which is not merged.
- pgTAP D2.

### R4 (medium, blocks): status rollup never leaves a quoting-or-later state

`job_status` (20260303101500) is `uploaded, extracting, needs_spec_review, ready_to_quote, quoting, awaiting_vendor_manual_review, internal_review, published, client_selected, closed`. Existing transition rules: `api_request_quote` sets `quoting` (20260812044000); cancelling a quote request maps `quoting` to `ready_to_quote` and keeps `client_selected`/`closed` (20261002182714); the request-quote path (20260402100000 and earlier versions) treats `internal_review, published, client_selected, closed` as already received for a part with an existing quote run. Draft a's rollup now updates a job only when its status is `uploaded`, `extracting`, `needs_spec_review` or `ready_to_quote` (an allow-list, so a future enum value is left alone). Draft b: see below. pgTAP Q1 to Q3 (`published`, `client_selected`, `closed`).

This also fixes a case on main: a correction saved while extraction is pending creates the requirement, so the user can request a quote (`quoting`) before the extraction finishes; the completing extraction then moved the job back to `extracting`/`ready_to_quote`. It now stays `quoting`.

What happens to quoted fields when an extraction completes after quoting started: the requirement is refreshed (non-user-owned description, part number, revision, finish, the material placeholder), as pgTAP Q1 to Q3 show. Quote scope is immutable per OVD-345 (20260812041000): the worker builds each lane's `scope_snapshot` (including requirement description, finish, material, tolerance, and the CAD/drawing file ids and hashes) when the vendor task runs (`worker/src/quoteScope.ts`, `worker/src/index.ts` vendor path) and registers it once with `api_register_quote_request_lane`, which refuses a different fingerprint for an already registered lane ("Quote lane was already registered with a different immutable scope."). So offers and registered lanes keep the spec they were quoted on. A vendor task of the same run that has not dispatched yet would register the refreshed values, so one run can carry mixed scopes. That is the same as a user edit or the attach itself during quoting on main (the attach changes `drawing_file_id`, which is in the scope, without draft b). If Blaine prefers, auto-approve could also skip field refreshes for jobs in quoting or later; not done here (see "Needs Blaine").

Observation (not changed): the worker calls auto-approve while its own task is still `running` (`worker/src/index.ts`, then `markTaskCompleted`), so the rollup sees a pending task and writes `extracting`, not `ready_to_quote`. The rollup guard applies either way.

## Draft b: what request_extraction now does (1b-b; depends on draft a)

`api_request_extraction` now also queues a part when all of the following hold:

1. it has a `drawing_file_id`;
2. its extraction row has `extractor_version like 'worker-sim-%'`;
3. no `extract_part` task for the same part with `payload.drawingFileId` equal to the current drawing has completed.

The existing "nothing queued or running for this part" dedupe applies to both branches. The new task's payload adds `reason: 'drawing_attached'` and `drawingFileId`; the worker merges payloads on completion (`worker/src/queue.ts` `mergePayload`), so the completed-task guard works. The payload for a never-extracted part is unchanged byte for byte. A per-job transaction advisory lock, taken after the access checks, serializes concurrent calls. It takes no row lock, so it cannot invert the parts-then-jobs lock order that auto-approve uses. When the worker completes, auto-approve (draft a) refreshes the auto fields from the drawing and keeps user-owned ones (pgTAP B5).

Job status (R4): a request that queued at least one never-extracted part sets `extracting` exactly as on main (the behaviour for a new upload is unchanged, including on a quoted job). A request that queued only `drawing_attached` tasks sets `extracting` only for a job in a pre-quote state (pgTAP B1b); a job in quoting or later keeps its status and the task still runs (Q1 to Q3). Keeping the new-upload behaviour was deliberate: changing how a new part on a quoted job moves the job is outside OVD-979 and was not analysed here (listed under "Needs Blaine").

Not re-queued: rows from other producers (`'v1'` default, the importers `dmrifles-import-v1` and `spreadsheet-import-v2`, the pdf extractor), and a part with no drawing. The existing `ovd723_export_control_upload_block.sql` assertion ("extraction queues nothing for a part that already has an extraction") uses a `'v1'` row, so it still holds (pgTAP B7, harness S5).

## Old-vs-new diffs (security attributes)

| Function | SECURITY DEFINER | search_path | Owner | Return | ACL after draft |
| --- | --- | --- | --- | --- | --- |
| `api_auto_approve_job_requirements(uuid)` | kept | `public` (kept) | kept (CREATE OR REPLACE) | `integer`, same count | service_role only; OVD-535 statements restated verbatim |
| `api_request_extraction(uuid)` | kept | `public` (kept) | kept | `integer`, same count | authenticated + service_role, not PUBLIC/anon; OVD-736 statements restated verbatim |

The function header (signature through `as $$`) is byte-identical to the replaced definition for both functions (harness `old-vs-new.mjs`). Full body diffs: harness `auto_approve.old-vs-new.diff` (+109/-14) and `request_extraction.old-vs-new.diff` (+47/-7). Draft a is generated from the migration text by `gen-draft-a.mjs`, with an exact match count asserted for every replacement. Every change is listed in the draft headers. `require_verified_auth()` and `user_can_edit_job()` still run first in b, and no grant is widened. pgTAP G1 to G5 check the attributes and grants.

## Verification done (local only)

Harness: `/Users/blainewilson/Documents/Codex/2026-10-18/claude-primary/gmc/sql-drafts/OVD-979/` (PGlite 0.4.3 and pgTAP borrowed from `~/gbrain/node_modules/@electric-sql/pglite`; nothing installed; exact migration bodies over stubbed tables).

- `node run.mjs <worktree>`: baseline reproduces both bugs (6 expected failures). Drafts 15/15. Both rollbacks restore the 0317 and 0812 bodies byte for byte and replay twice.
- `node pgtap-run.mjs <worktree> draft|baseline`: 38/38 with the drafts; 21/38 without. The same with the reviewer's enum-typed `jobs.status` stub (`reviewer-r1/runtest.mjs`): 38/38 and 21/38. The revision-0 drafts under this test: 29/38.
- Mutation testing: the harness `mutate-r1.mjs` (7 mutants) and the r1 reviewer's `reviewer-r1/mymut.mjs` (14 mutants). Every mutant is caught except N2 (placeholder compared case-insensitively: a harmless widening, no behaviour to assert against) and N14 (advisory lock removed: needs two concurrent connections, which PGlite does not have).
- `node mutate-r1.mjs <worktree> <scratch>`: each new rule removed from a scratch copy of the drafts is caught: R1 sync (B9, D1, D3, D4, D5), R2 placeholder (D1, D4), R2 ownership checks (E1, H1), R3 (D2), R4 rollup guard in a (Q1 to Q3), R4 guard in b (Q1 to Q3), b never flipping on an attach (B1b).
- Reviewer mutants and the assertions that catch them: N1 defaults written into overrides (test errors: material required), N3 allow-list without needs_spec_review (F2), N4 tolerance rule inverted (A5, D2), N5 new-part branch guarded (N1), N6 rollup disabled (B5b, F1, F2), N7 completed-task dedupe removed (R1), N8 `drawing_file_id is not null` dropped (D-1, D0), N9 override ownership dropped (A2, A4, B5, B8), N10 defaults sync also on owned fields (B8, B9), N11 attach marker ignores reason (A5), N12 placeholder ignores fieldSources.material (H1), N13 any extractor version re-queued (B7). N2 and N14 survive, as above.
- The reviewer's harness (`adv.mjs`, `mat.mjs`): the C4 stale-defaults observations no longer reproduce; material becomes the drawing material and tolerance stays null after an attach.
- Not verified: the real schema (triggers such as the canonical part version assignment and the part deadline history, the `job_status` enum type in place of the stub's text column), real access helpers, and real concurrency. The CI ephemeral-db stage covers the first two. The advisory lock has no concurrency test (single connection).

## Read-only hosted checks to run first (staging, then production; need Blaine's OK)

```sql
-- 1. Live definitions match main (expect bodies equal to 20260317013000 / 20260812042000).
select pg_get_functiondef('public.api_auto_approve_job_requirements(uuid)'::regprocedure);
select pg_get_functiondef('public.api_request_extraction(uuid)'::regprocedure);
select pg_get_functiondef('public.api_update_client_part_request(uuid,text[],text,text,text,text,text,text,text,text,numeric,text,text,integer,integer[],date,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
select p.proname, p.prosecdef, p.proconfig, p.proacl from pg_proc p
where p.oid in ('public.api_auto_approve_job_requirements(uuid)'::regprocedure, 'public.api_request_extraction(uuid)'::regprocedure);
-- 2. Ledger.
select version, name from supabase_migrations.schema_migrations
where version in ('20260317013000','20260402120000','20260408120000','20260812042000','20260924001152','20261015074957','20261011170000')
order by version;
-- 3. Corrections already reverted: rows whose stored override for the field is a
--    non-empty string that differs (trimmed) from the requirement column.
--    JSON null and '' overrides (a cleared field, which resolves to its default)
--    are not counted.
select
  count(*) filter (where jsonb_typeof(o->'description') = 'string' and nullif(trim(o->>'description'),'') is not null
                     and trim(o->>'description') is distinct from nullif(trim(r.description),'')) as description_reverted,
  count(*) filter (where jsonb_typeof(o->'partNumber') = 'string' and nullif(trim(o->>'partNumber'),'') is not null
                     and trim(o->>'partNumber') is distinct from nullif(trim(r.part_number),'')) as part_number_reverted,
  count(*) filter (where jsonb_typeof(o->'revision') = 'string' and nullif(trim(o->>'revision'),'') is not null
                     and trim(o->>'revision') is distinct from nullif(trim(r.revision),'')) as revision_reverted,
  count(*) filter (where jsonb_typeof(o->'finish') = 'string' and nullif(trim(o->>'finish'),'') is not null
                     and trim(o->>'finish') is distinct from nullif(trim(r.finish),'')) as finish_reverted
from public.approved_part_requirements r
cross join lateral (select r.spec_snapshot #> '{projectPartProperties,overrides}' as o) x
where jsonb_typeof(o) = 'object';
-- 4. Parts draft b would re-extract on their next request (each is one paid model run).
select count(*) from public.parts p join public.drawing_extractions e on e.part_id = p.id
where p.drawing_file_id is not null and e.extractor_version like 'worker-sim-%';
-- 5. Parts with stale legacy ownership whose overrides no longer hold the key (legacy term keeps them user-owned).
select count(*) from public.approved_part_requirements r
where jsonb_typeof(r.spec_snapshot #> '{projectPartProperties,overrides}') = 'object'
  and exists (select 1 from jsonb_each_text(coalesce(r.spec_snapshot -> 'fieldSources','{}')) s(k,v)
              where v <> 'auto' and not (r.spec_snapshot #> '{projectPartProperties,overrides}') ? s.k);
-- 6. Parts R2 would fill on their next extraction (placeholder material, not user-owned).
select count(*) from public.approved_part_requirements r
where trim(r.material) = 'Unknown material'
  and not coalesce((r.spec_snapshot #> '{projectPartProperties,overrides}') ? 'material', false)
  and coalesce(nullif(trim(r.spec_snapshot #>> '{fieldSources,material}'), ''), 'auto') = 'auto';
```

Query 3 counts, per field, requirement rows whose stored override is a non-empty string different from the column (on main, an auto-approve refresh is the writer that produces this). It is a lower bound of reverted corrections: a revert followed by a fresh user save is no longer visible. It identifies affected rows; it does not repair them. Repairing them is a separate decision, because the user must confirm the value.

## Why this cannot be split (for the PR body)

Drafts a and b and the pending test are one change. b alone would re-extract attached drawings through the current auto-approve and overwrite user corrections; a's R3 and R4 rules read b's `drawing_attached` marker and status behaviour; and the single pending test (picked up as one draft family by `scripts/ephemeral-db-apply.mjs`) asserts both together, so splitting them would leave a test that cannot pass against either draft alone. The PR is over the 200-line guideline mostly because of that test.

## Apply order and window plan

1. Confirm OVD-976 is deployed to the worker (prerequisite for b).
2. Run the read-only checks above (staging, then production) and record the results.
3. In one window: `ovd-979-a.sql`, then `ovd-979-b.sql`.
4. Promotion: `npm run migration:new` twice (a before b), with the bodies copied unchanged. Rename the pending test to `supabase/tests/ovd979_reextraction_provenance.sql`. Add a vitest text pin for the new auto-approve migration, because `src/features/quotes/auto-approve-migration.test.ts` pins the old 20260317013000 file, which stays immutable and will no longer be the live definition.
5. Afterwards, watch `work_queue` rows with `task_type = 'extract_part'` and `payload ->> 'reason' = 'drawing_attached'`, their outcome, and the spend guard. The count from query 4 bounds the extra model runs; they occur only when a user flow calls `api_request_extraction` for that job, not at apply time.

## R6: promotion blocker to decide first (OVD-846 SECURITY DEFINER lint)

`node scripts/lint-security-definer.mjs docs/migration-drafts/ovd-979-a.sql docs/migration-drafts/ovd-979-b.sql` reports, for both functions (report mode):

```
missing SET search_path = '' (or a pinned list without public first) (search_path = public starts with public)
```

The drafts keep `set search_path = public` exactly, as required for this unit. The lint's baseline covers only byte-identical existing definitions, so a re-created function in a new migration must comply; adding a baseline entry instead is `gate_loosening` (Grok Bot countersign plus Blaine's card). Blaine chooses one before promotion:

1. **`set search_path = pg_catalog, public`.** Recommended; the independent review agrees. Name resolution is identical: PostgreSQL searches `pg_catalog` first whenever it is not listed, and the temp schema is never searched for functions or operators. Every relation and type in both bodies is `public.`-qualified. It passes the lint with no gate loosening. It is a visible attribute change (`proconfig`), so pgTAP G1 and the rollback expectations must change with it.
2. **`set search_path = ''`.** Strictest. Re-run the harness with the change before choosing it.
3. **Keep `public` and add a baseline entry.** This is gate loosening.

## Rollback

Apply `ovd-979-b.rollback.sql`, then `ovd-979-a.rollback.sql`. Both are idempotent and restore the exact prior bodies and ACLs. Rows written while the drafts were live keep their values (including refreshed editor defaults and replaced placeholder materials). Queued `drawing_attached` tasks stay in `work_queue`; if needed, cancel them by hand with a reviewed statement. After rollback, auto-approve no longer reads the `drawing_attached` marker, so a later run may fill tolerance from such a part's extraction again.

## Interaction with OVD-978 and OVD-976

OVD-978 redefines `public.api_list_client_part_metadata(uuid[])`, the client projection, in its own migration. Neither unit replaces a function the other replaces, so the SQL apply order does not matter. The projection reads the latest `extract_part` task per part (status, `failureCode`, `failureMessage`) and ignores other payload keys, so a `drawing_attached` task shows as an ordinary extraction. Until OVD-978 lands, the projection's shape bug keeps every part on "Waiting for drawing metadata", so ship 978 in the same window or earlier for the fix to be visible.

OVD-976 is a worker change with no SQL overlap; it is an ordering prerequisite for b (top of this file).

Also related, not conflicting: the `ovd-766-c` draft replaces `api_reconcile_job_parts`, which b only calls, adding a verified-auth and edit guard that b's caller already satisfies.

## Needs Blaine (undecided)

1. R6 lint: option 1, 2 or 3 above.
2. Reset of a field that was user-owned when the extraction completed resolves to the default seeded at the first save, not to the extracted value (probe: a correction saved while extraction was pending, extraction completes, reset description writes `USER DESC`, not `EXTRACTED DESC 1`; harness `probe-owned-reset.mjs`). The field is auto again, and the next newer extraction refreshes it, but nothing reruns auto-approve in the meantime. R1 as specified updates defaults only for refreshed fields. Option: also update `defaults[field]` to the extracted value for a user-owned field when the extraction is newer (no column change). Trade-off: a later save whose override equals the new default drops the override, so that field becomes auto. Not implemented.
3. R4: whether auto-approve should also skip field refreshes (not only status) for jobs in quoting or later. Today and in this draft the requirement is refreshed; registered lanes are immutable, but undispatched lanes of the same run pick up refreshed values.
4. R4: whether a brand-new part added to a quoted job should keep flipping the job to `extracting` (kept as on main in this draft).
5. R3: lift the attach tolerance rule once OVD-976 is deployed (follow-up), or keep it.
6. F4: accept that a failed drawing-attach task moves a pre-quote job to `needs_spec_review` (the user sees the job needing review although the CAD-only data was fine), or ignore `drawing_attached` failures in the rollup.

## What is NOT changed (and remaining risks, for backlog)

- `api_update_client_part_request`, `api_reset_client_part_property_overrides`, `api_approve_job_requirements` and the projection are untouched.
- R5 display label: `src/features/quotes/utils.ts` `getApprovedFieldOwnership` reads only `fieldOverrides`/`fieldSources`, so after draft a a client-overridden field is user-owned in the database but can still be labelled "auto" on the internal requirement card, and may show `staleAuto`. Display only, no data loss. Not changed here: the client fix (also treat `projectPartProperties.overrides` having the key as "user") belongs in `src/`, outside this draft unit, and would mislabel fields as protected if it shipped before draft a is promoted. Backlog item, to ship with or after promotion, with a Vitest case.
- Concurrency (from the review, low): auto-approve reads the requirement without `FOR UPDATE`. A user save that commits between that read and the upsert can be overwritten. This exists on main; not closed here. Backlog: read with `FOR UPDATE` after checking the lock order against `api_update_client_part_request` and `load_editable_project_part_context`.
- Trusted reuse: if the new CAD-plus-drawing package exactly matches a completed version elsewhere in the organization, the worker takes the reuse path. Its `on conflict (part_id) do nothing` keeps the CAD-only row, so the drawing data is not copied. Draft b queues once and does not loop (harness S4), but that part still gets no drawing data. This needs a follow-up in `api_reuse_trusted_part_version_artifacts`.
- A `drawing_attached` task that failed is queued again by the next request, the same as a never-extracted part today. A failed drawing task turns a previously succeeded part into "failed" in the lifecycle projection (20261011170000).
- **Behaviour change (review r1, F4):** a failed `drawing_attached` task now makes the next auto-approve run move a pre-quote job (for example `ready_to_quote`) to `needs_spec_review`, because the rollup counts failed `extract_part` tasks for the job. On main, attaching a drawing queues nothing, so this cannot happen. A successful retry rolls it back to `ready_to_quote` (pgTAP F1, F2). Jobs in quoting or later are not moved (R4). Not changed here; see "Needs Blaine".
- Replacing an existing drawing with a different one (the first extraction was pdf) is not re-queued. No provenance records which drawing an old extraction used.
- Observation: the codebase stamps `timestamptz` columns with `timezone('utc', now())`, which is correct only in a UTC session (Supabase's default). The harness pins its fixtures to the same expression.
