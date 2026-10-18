# OVD-979 notes: keep user corrections through re-extraction, and extract a drawing attached later (DRAFT)

This is a draft. Nothing here has been applied to any Supabase project, and nothing is in `supabase/migrations/`. Promotion is a protected action: it happens only in a migration window that Blaine approves. Base: main `066161de`. Parent: OVD-968, step 3 (GraphMyCode lead, verified).

## Files

- `docs/migration-drafts/ovd-979-a.sql`: replaces `public.api_auto_approve_job_requirements(uuid)` (finding 3f).
- `docs/migration-drafts/ovd-979-a.rollback.sql`: restores the 20260317013000 body verbatim, plus the OVD-535 ACL.
- `docs/migration-drafts/ovd-979-b.sql`: replaces `public.api_request_extraction(uuid)` (finding 1b-b).
- `docs/migration-drafts/ovd-979-b.rollback.sql`: restores the 20260812042000 body verbatim, plus the OVD-736 ACL.
- `supabase/tests/pending/ovd979_reextraction_provenance.sql.pending`: 17 pgTAP assertions. Its header names both drafts, so the ephemeral-db stage (`scripts/ephemeral-db-apply.mjs`) applies the family in stem order (a, then b) and runs the test.

## Problem (verified by reading the migrations in order and by execution)

- **3f.** `api_update_client_part_request` was defined in 20260310110000, 20260313143000, 20260313150000, 20260316170500, 20260402120000 and 20260408120000; OVD-736 changed only its grants. The 20260316170500 version wrote `spec_snapshot.fieldSources[field] = 'user'`. The April versions (20260402120000 and 20260408120000) record corrections only in `spec_snapshot.projectPartProperties.overrides`. `api_auto_approve_job_requirements` (latest definition 20260317013000) decides ownership only from `fieldSources`. Fields with no `fieldSources` entry count as `'auto'`, and any auto field is refreshed whenever `drawing_extractions.updated_at > approved_part_requirements.updated_at`. So when a user saves while an extraction is pending (or being retried), the extraction that finishes later overwrites description, part number, revision, finish, quoteDescription and quoteFinish. Material and tolerance are not affected: the column value always wins for those. Finish is sent to Xometry and SendCutSend (docs/quote-scope-trace.md).
- **1b-b.** A drawing is attached to an existing job in four steps: upload (`uploadFilesToJob`), `api_reconcile_job_parts` (its upsert sets `parts.drawing_file_id`), then `api_request_extraction`. The callers are `use-client-part-controller.ts`, `use-client-project-controller.ts` and `uploads-api.ts`. The legacy `api_attach_job_file` raises `legacy_file_attach_unavailable`. `api_request_extraction` queues `extract_part` only for parts with no `drawing_extractions` row. A part already extracted CAD-only (the worker writes `extractor_version = 'worker-sim-v1'` when no drawing was staged) is therefore never extracted from its new drawing.

## Choice for 3f: option (b) only, and why not (a)

Draft a changes only the ownership decision in auto-approve:

```
user_owned(field) := fieldSources[field] <> 'auto'           -- legacy, unchanged
                     OR projectPartProperties.overrides ? field  -- new
```

Each "refresh from newer extraction" branch now tests `not user_owned` instead of `source = 'auto'`. The override keys used by the update/reset RPCs are `description`, `partNumber`, `revision` and `finish`, the same names auto-approve uses.

- (b) also protects overrides that are already stored, with no data backfill.
- Ownership is checked against the current auto-approve logic. Auto-approve treats exactly description, partNumber, revision and finish as auto-refreshable, and reads `fieldSources` with an `'auto'` default. Its stale auto-refresh path (`v_extraction_newer`, review-needed blockers) is unchanged.
- The legacy term is kept so that ownership written by `api_approve_job_requirements` (internal approval, which sets all four to `'user'` and replaces `spec_snapshot`) and by the March client RPC is not weakened (harness S7).
- Reset is not changed. `api_reset_client_part_property_overrides` removes the override key, so the field becomes auto again (pgTAP A3/A4). A legacy `fieldSources = 'user'` is not touched by reset today, and it still is not.
- Option (a), writing `fieldSources` in the update RPC, was rejected. Reset does not clear `fieldSources` (and must not be changed), so (a) would make every override sticky through a reset. It would also not protect overrides already stored, and it would replace a 300-line SECURITY DEFINER RPC.
- The `fieldSources` and `fieldOverrides` values written back by auto-approve are unchanged (still the legacy provenance), so the draft makes no new value sticky.

## Change for 1b-b (draft b; depends on draft a)

`api_request_extraction` now also queues a part when all of the following hold:

1. it has a `drawing_file_id`;
2. its extraction row has `extractor_version like 'worker-sim-%'`;
3. no `extract_part` task for the same part with `payload.drawingFileId` equal to the current drawing has completed.

The existing "nothing queued or running for this part" dedupe applies to both branches. The new task's payload adds `reason: 'drawing_attached'` and `drawingFileId`; the worker merges payloads on completion (`worker/src/queue.ts` `mergePayload`), so the completed-task guard works. The payload for a never-extracted part is unchanged byte for byte. A per-job transaction advisory lock, taken after the access checks, serializes concurrent calls. It takes no row lock, so it cannot invert the parts-then-jobs lock order that auto-approve uses. When the worker completes, auto-approve (draft a) refreshes the auto fields from the drawing and keeps user-owned ones (pgTAP B5).

Not re-queued: rows from other producers (`'v1'` default, the importers `dmrifles-import-v1` and `spreadsheet-import-v2`, the pdf extractor), and a part with no drawing. The existing `ovd723_export_control_upload_block.sql` assertion ("extraction queues nothing for a part that already has an extraction") uses a `'v1'` row, so it still holds (pgTAP B7, harness S5).

## Old-vs-new diffs (security attributes)

| Function | SECURITY DEFINER | search_path | Owner | ACL after draft |
| --- | --- | --- | --- | --- |
| `api_auto_approve_job_requirements(uuid)` | kept | `public` (kept) | kept (CREATE OR REPLACE) | service_role only; OVD-535 statements restated verbatim |
| `api_request_extraction(uuid)` | kept | `public` (kept) | kept | authenticated + service_role, not PUBLIC/anon; OVD-736 statements restated verbatim |

Full body diffs are in the harness directory (`auto_approve.old-vs-new.diff`, `request_extraction.old-vs-new.diff`). Draft a is generated from the migration text by `gen-draft-a.mjs`, with an exact match count asserted for every replacement. Draft b changes: an advisory lock is added after the access checks, the enqueue `select` gains a left join and the new branch, and the payload becomes a `case`. `require_verified_auth()` and `user_can_edit_job()` still run first, and no grant is widened. pgTAP G1 to G5 check the attributes and grants.

## Verification done (local only)

The harness lives at `/Users/blainewilson/Documents/Codex/2026-10-18/claude-primary/gmc/sql-drafts/OVD-979/`. It uses PGlite 0.4.3 and pgTAP borrowed from `~/gbrain/node_modules/@electric-sql/pglite`; nothing was installed. It loads the exact migration bodies over stubbed tables.

- `node run.mjs <worktree>`: the baseline reproduces both bugs (S1: all four corrections overwritten; S3: 0 tasks on attach). The drafts pass 15/15 checks. Both rollbacks restore the 0317 and 0812 bodies byte for byte and replay twice.
- `node pgtap-run.mjs <worktree> draft|baseline`: the pending pgTAP passes 17/17 with the drafts. On baseline, 12/17 pass and A2, A4, B1, B3 and B5 fail as expected.
- Not verified: the real schema (triggers such as the canonical part version assignment and the part deadline history), real access helpers, and real concurrency. The CI ephemeral-db stage covers the first two. The advisory lock has no concurrency test (single connection).

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
-- 3. Corrections already reverted (stored override differs from the column auto-approve wrote).
select
  count(*) filter (where o ? 'description' and nullif(trim(o->>'description'),'') is distinct from nullif(trim(r.description),'')) as description_reverted,
  count(*) filter (where o ? 'partNumber'  and nullif(trim(o->>'partNumber'),'')  is distinct from nullif(trim(r.part_number),'')) as part_number_reverted,
  count(*) filter (where o ? 'revision'    and nullif(trim(o->>'revision'),'')    is distinct from nullif(trim(r.revision),'')) as revision_reverted,
  count(*) filter (where o ? 'finish'      and nullif(trim(o->>'finish'),'')      is distinct from nullif(trim(r.finish),'')) as finish_reverted
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
```

Query 3 is a lower bound: a revert followed by a fresh user save is no longer visible. It identifies affected rows; it does not repair them. Repairing them is a separate decision, because the user must confirm the value.

## Apply order and window plan

1. Run the read-only checks above (staging, then production) and record the results.
2. In one window: `ovd-979-a.sql`, then `ovd-979-b.sql`. b without a would re-extract attached drawings and could overwrite user corrections, so never apply b alone. a alone is safe.
3. Promotion: `npm run migration:new` twice (a before b), with the bodies copied unchanged. Rename the pending test to `supabase/tests/ovd979_reextraction_provenance.sql`. Add a vitest text pin for the new auto-approve migration, because `src/features/quotes/auto-approve-migration.test.ts` pins the old 20260317013000 file, which stays immutable and will no longer be the live definition.
4. Afterwards, watch `work_queue` rows with `task_type = 'extract_part'` and `payload ->> 'reason' = 'drawing_attached'`, their outcome, and the spend guard. The count from query 4 bounds the extra model runs; they occur only when a user flow calls `api_request_extraction` for that job, not at apply time.

## Promotion blocker to decide first: OVD-846 SECURITY DEFINER lint

`node scripts/lint-security-definer.mjs docs/migration-drafts/ovd-979-a.sql docs/migration-drafts/ovd-979-b.sql` reports, for both functions:

```
missing SET search_path = '' (or a pinned list without public first) (search_path = public starts with public)
```

This was run in report mode. The drafts keep `set search_path = public` exactly, as the unit requires. The lint's baseline covers only byte-identical existing definitions, so a re-created function in a new migration must comply; adding a baseline entry instead is `gate_loosening` (Grok Bot countersign plus Blaine's card). Choose one before promotion:

1. **`set search_path = pg_catalog, public`.** Recommended. Name resolution is identical: PostgreSQL searches `pg_catalog` first whenever it is not listed, and the temp schema is never searched for functions or operators. It passes the lint (first schema is not `public`) with no gate loosening. It is still a visible attribute change (`proconfig`), so pgTAP G1 must be updated to match.
2. **`set search_path = ''`.** Strictest. Both bodies already qualify every table, type and function they own with `public.` and use only built-ins otherwise. Before choosing this, re-run the harness with the change.
3. **Keep `public` and add a baseline entry.** This is gate loosening.

## Rollback

Apply `ovd-979-b.rollback.sql`, then `ovd-979-a.rollback.sql`. Both are idempotent and restore the exact prior bodies and ACLs. Rows written while the drafts were live keep their values. Queued `drawing_attached` tasks stay in `work_queue`; if needed, cancel them by hand with a reviewed statement.

## Interaction with OVD-978

OVD-978 redefines `public.api_list_client_part_metadata(uuid[])`, the client projection, in its own migration. Neither unit replaces a function the other replaces, so the SQL apply order does not matter. The projection reads the latest `extract_part` task per part (status, `failureCode`, `failureMessage`) and ignores other payload keys, so a `drawing_attached` task shows as an ordinary extraction. One user-visible note: until OVD-978 lands, the projection's shape bug keeps every part on "Waiting for drawing metadata". The data that b extracts is correct but not shown in the client, so ship 978 in the same window or earlier for the fix to be visible.

Also related, not conflicting: the `ovd-766-c` draft replaces `api_reconcile_job_parts`, which b only calls, adding a verified-auth and edit guard that b's caller already satisfies.

## What is NOT changed (and remaining risks, for backlog)

- `api_update_client_part_request`, `api_reset_client_part_property_overrides`, `api_approve_job_requirements` and the projection are untouched.
- Display: `src/features/quotes/utils.ts` `getApprovedFieldOwnership` reads `fieldOverrides`/`fieldSources` only. The internal requirement card can still label a client-overridden field "auto". This is a client-only follow-up, not a data-loss issue.
- Trusted reuse: if the new CAD-plus-drawing package exactly matches a completed version elsewhere in the organization, the worker takes the reuse path. Its `on conflict (part_id) do nothing` keeps the CAD-only row, so the drawing data is not copied. Draft b queues once and does not loop (harness S4), but that part still gets no drawing data. This needs a follow-up in `api_reuse_trusted_part_version_artifacts`.
- A `drawing_attached` task that failed is queued again by the next request, the same as a never-extracted part today.
- Requesting extraction sets the job status to `extracting`, and completion reruns the auto-approve status rollup. This is the existing behavior for any newly queued part. Attaching a drawing to a job that has already been quoted now triggers it too.
- Replacing an existing drawing with a different one (the first extraction was pdf) is not re-queued. No provenance records which drawing an old extraction used.
- Observation: the codebase stamps `timestamptz` columns with `timezone('utc', now())`, which is correct only in a UTC session (Supabase's default). The harness pins its fixtures to the same expression.
