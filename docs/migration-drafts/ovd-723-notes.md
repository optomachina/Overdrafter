# OVD-723 notes: block ITAR/EAR controlled or uncertain uploads

**NEEDS BLAINE MIGRATION WINDOW - not applied.** All SQL is in
[`ovd-723.sql`](ovd-723.sql). Nothing under `supabase/migrations/` changed.

## Verified names (read in code)

| Thing | Real name | Where verified |
| --- | --- | --- |
| Upload client path | `uploadFilesToJob` and `createJobsFromUploadFiles` in `src/features/quotes/api/uploads-api.ts`; callers `use-client-home-controller.ts`, `use-client-project-controller.ts`, `src/pages/JobCreate.tsx` | source |
| Upload RPCs | `public.api_prepare_job_file_upload(uuid, text, job_file_kind, text, bigint, text)` and `public.api_finalize_job_file_upload(uuid, text, text, text, job_file_kind, text, bigint, text)` | current bodies in `20261004110000_reject_empty_job_file_uploads.sql` |
| Storage bucket | `job-files`; object name `org-sha256/<org uuid>/<sha256>/<basename>` (`public.build_org_file_blob_storage_path`) | `uploads-api.ts`, migrations |
| Storage insert policy | `"job_files_storage_insert"` on `storage.objects` | `20260815093000_enforce_founding_beta_file_boundaries.sql` |
| Generic preflight | `public.api_authorize_provider_worker_dispatch`, called from `worker/src/providerDispatchPreflight.ts`; it delegates `vendor = 'xometry'` to the Xometry preflight | `20261003170000_ovd459_provider_dispatch_preflight.sql` |
| Xometry preflight | `public.api_authorize_xometry_beta_worker_dispatch`, called from `worker/src/xometryDispatchPreflight.ts` | `20261002182910_free_confirmed_quote_access.sql` |
| Denial helper | `private.provider_dispatch_authorization_denial(text)` | `20261003170000` |
| Drawing text | `extractPdfText` in `worker/src/extraction/pdfDrawing.ts` (OCR fallback is internal to it) | source |

## Plan assumptions that were wrong

1. **Declarations can't key on `part_id`.** Upload happens before
   `public.parts` rows exist (`reconcileJobParts` runs after upload). The table
   is `private.job_export_declarations` keyed on `job_id` (the part request),
   with a nullable `part_id`. The RPC is `api_declare_job_export_status`, not
   `api_declare_part_export_status`.
2. **No `export_review_state` column.** The state comes from
   `private.job_export_marking_blocks` (`blocked_pending_review`,
   `cleared_by_admin`, `confirmed_controlled`). Clients read it through
   `api_get_job_export_control_status`.
3. **No `provider_jurisdiction` column.** Jurisdiction is the SQL function
   `private.export_control_provider_jurisdiction` plus the worker constant
   `FOREIGN_JURISDICTION_PROVIDERS`. Unknown providers are treated as foreign.
4. **RLS read access is not the real boundary.** Usage on the `private` schema is
   revoked from `anon` and `authenticated`. The member/admin read policies are
   defense in depth; clients read through the status RPC.
5. **Gating the RPC alone doesn't stop storage writes.** The client uploads
   bytes directly to Storage between prepare and finalize. So prepare issues a
   15 minute, single use grant for one exact object (bucket, full path,
   SHA-256, size, user, job, declaration) in `private.export_cleared_upload_grants`,
   and window 1 adds `current_user_has_export_cleared_upload(bucket_id, name)`
   to `"job_files_storage_insert"`. See "Codex cross review" below.
6. **More reason codes were needed.** These three are added to the plan's codes:
   `export_declaration_stale` (the upload referenced a declaration that is no
   longer the latest), `export_control_lookup_failed` (the dispatch lookup
   raised), and `export_scan_missing` (a file the part sends has no clean scan
   of record in its own job; see "Reused files and skipped extraction").
7. **No separate OCR source.** OCR runs inside `extractPdfText`, so its hits are
   recorded as `drawing_text`. The `drawing_ocr` source exists for a later split.
8. **No help-article system.** The article is `docs/help/export-controlled-files.md`.
   The terms clause is in `src/pages/LegalPolicies.tsx`.
9. **`xometryDispatchPreflight.ts` was only seen through an import in the plan.**
   It exists. The gate is in SQL, and the TS change only adds the export codes
   to the closed vocabulary of bounded denials.

## Behavior notes

- The client asks before creating any project, draft job, or file, so a
  `controlled` or `unsure` answer creates nothing and makes no server call.
  Those answers are not recorded server-side on that path because there is no
  job yet. The RPC does accept and audit them when called for an existing job.
- An upload with zero files doesn't ask.
- One window. Upload, Storage, and dispatch enforcement ship in ONE migration
  in window 1 (there is no longer a PHASE 1 / PHASE 2 split; see "Codex cross
  review", finding 3). Both preflights (`api_authorize_provider_worker_dispatch`
  and `api_authorize_xometry_beta_worker_dispatch`) deny a job whose latest
  declaration is missing, controlled, or unsure, or that has a marking block
  pending review or confirmed controlled. Foreign providers (weerg, geomiq) and
  unknown providers have their own explicit rule. The legacy upload
  signatures raise `export_declaration_missing`, and the Storage insert policy
  requires an exact grant backed by the declaration.
- Deploy order inside window 1: the migration, then the web client and the
  worker right after it. Between the migration and the client deploy, the old
  client's uploads fail closed with `export_declaration_missing` (the browser
  shows the raw code until the new client loads). Before the migration, the
  new client's calls fail and it fails closed too, so the order only decides
  which side shows the short outage; migration first is preferred because no
  byte can reach Storage without the gate. Deploy the worker after the
  migration, because it calls `api_record_export_control_marking_hits` and the
  five argument `api_record_export_control_clean_scan`, and a failed record fails
  the task. Between the migration and the worker deploy, the old worker records
  no scans, so every dispatch is denied with `export_scan_missing`. That fails
  closed, but keep the gap short. The old worker doesn't know the new codes and
  reports them as a generic terminal denial.
- The worker reads at most 256 KB of a staged STEP file for the header scan
  (`readStagedStepHeaderPrefix`). If the read fails, the task fails.
- Backfill: every existing job with files gets a `missing` declaration, so it is
  denied dispatch until the user declares.

## Reused files and skipped extraction

QA asked whether files that skip extraction are ever scanned. Before this
change, some were not. These are the paths:

| Path | Where | Scanned before this change? |
| --- | --- | --- |
| Org blob reuse: the same bytes uploaded again in the org. `prepare` returns `reused` and attaches the existing blob as a new `job_files` row with no Storage upload. | `job_file_prepare_core` (body from `20261004110000`), `uploadFilesToJob` | Partly. Extraction still runs for the new part unless trusted reuse (next row) applies. The STEP header is scanned on every quote. |
| Trusted artifact reuse: a part whose trusted CAD and drawing hashes match a completed part version in the same org copies that part's `drawing_extractions` and preview assets, and the task completes **without extraction**. The source part can be in a different job. | `handleExtractTask` in `worker/src/index.ts` → `api_reuse_trusted_part_version_artifacts` (`20260812042000`) | **No.** The drawing scan runs only inside extraction, so the reusing part's drawing was never scanned in its own job. A block on the source part's job doesn't hold the target job, because blocks are keyed on `job_id`. A source extracted before OVD-723 was never scanned at all. |
| In-job duplicate (`duplicate_in_job`), and duplicates within one upload batch | prepare core, `uploadFilesToJob` | Not applicable. Nothing is attached. |
| Legacy attach (`api_attach_job_file`) | `20260815093000` | Not applicable. It always raises `legacy_file_attach_unavailable`. |
| Job or part duplication | none found | No RPC or client path duplicates a job or part. `importSpreadsheetQuotes`'s "duplicate" handling only rejects ambiguous workbook matches. |

Fix (fail closed):

- **Scan of record.** `private.job_file_export_scans` stores clean scan results,
  keyed on the `job_files.id` in its own job, never on `content_sha256`. A
  scan of the same bytes in another job doesn't count. The worker writes rows
  through the service-role RPC `api_record_export_control_clean_scan`, which
  checks that the file belongs to the job. Hits still open blocks through
  `api_record_export_control_marking_hits`.
- **Dispatch rule.** `export_control_dispatch_denial_for_task` reads the
  task's `job_id` and `part_id` and, after the job rule passes, calls
  `private.export_control_scan_denial(job, part)`. It returns
  `export_scan_missing` when the part is missing or not in the task's job, or
  when any file the part sends (`export_control_file_denial`) is missing, is
  not in the part's job, has no hash verified by the worker equal to its claimed
  `content_sha256`, or (drawing and STEP CAD) has no clean scan matching its
  id, its current job, and its current hash.
- **Worker.** Extraction records a clean drawing scan. If the drawing text
  could not be read, nothing is recorded and dispatch stays denied. The
  trusted-reuse branch scans the target part's own staged drawing before the
  task completes (`scanStagedDrawingForExportMarkings`). A hit there opens a
  block on the target job. Every quote task scans the STEP header and records
  a clean scan before the preflight. A failed record fails the task.
- **Remediation.** Parts extracted before the deploy have no drawing scan, so
  they are denied with `export_scan_missing` until extraction runs again
  (`api_request_extraction`). That covers every existing job, which the
  backfill also marks `missing`.
- **Known limits.** Only PDF drawings and STEP CAD headers have a scanner. The
  rule doesn't scan other CAD formats (for example `.sldprt`, `.x_t`, `.igs`);
  it only requires their verified hash, so markings inside them are not
  detected. That is unchanged from before. Closing
  that gap means either a scanner per format or denying dispatch for unscanned
  formats, and that call needs a product decision. Each quote task appends one
  STEP scan row per vendor attempt. The rows are small and append-only.

Tests: `worker/src/exportControl.test.ts` covers the reference model, the record
and fail-closed behavior, the reuse-branch wiring, and draft assertions
(keying per file, job, and hash, the single window, the exact grant, and
the rollback). The pending pgTAP sections 8 and 9 cover the SQL rules,
including a reused copy of the same bytes, a repointed row, and a moved row
being denied.

## Verification status

- vitest: client gate (`src/features/quotes/api/uploads-export-control.test.ts`,
  `src/features/quotes/export-control.test.ts`), dialog
  (`src/components/quotes/ExportControlDeclarationDialog.test.tsx`), worker
  (`worker/src/exportControl.test.ts`, which also checks that the SQL
  foreign-provider list exactly equals `FOREIGN_JURISDICTION_PROVIDERS`), plus
  updated existing upload tests and `worker/src/jev/operationalTask.test.ts`.
- pgTAP: `supabase/tests/pending/ovd723_export_control_upload_block.sql.pending`
  targets the draft. **Executed locally, 95/95 pass** (2026-10-12) on a
  disposable Docker `supabase/postgres:17.6.1.095` with all 148 migrations
  plus the draft, applied in one transaction and rolled back. The Storage and
  GoTrue services were not run, so `storage.objects`, `storage.buckets`, and
  the GoTrue columns of `auth.users` came from a minimal local shim; the
  Storage service's own write path is not exercised. The same suite against
  the previous draft fails the new assertions for finding 2. The policy runner
  stages but does not execute non-`.sql` files, so the suite stays out of CI
  until the migration window, when it is renamed back to
  `supabase/tests/ovd723_export_control_upload_block.sql`.
- Race (finding 1): `ovd-723-upload-race.sh`, run on a second disposable
  container. Previous draft: the member's Storage insert did not wait for the
  uncommitted `controlled` declaration and committed an object. This draft:
  the insert waited for the declaration to commit, then was denied, and no
  object exists; a control run without a concurrent writer is admitted.
- OVD-319 cert walk (test 8): **not run.** It needs the applied draft. Expected
  results are recorded as pending rows in `docs/providers/acceptance-tables.md`.

## Codex cross review (window 1 hardening)

A static Codex review of head `96d8b7a` raised four findings. Each was
reproduced on a disposable local database before the fix.

| # | Finding | Verified | Fix |
| --- | --- | --- | --- |
| 1 | Storage authorization raced declaration changes (helper STABLE, no lock) | Yes. An insert committed while a `controlled` declaration held the exclusive lock. | The helper is VOLATILE, takes the shared lock for the job, then reads in a new statement. Writers take the lock exclusively. Finalize and dispatch check again under the same lock. |
| 2 | Grant covered an org/hash namespace; bytes never checked | Yes. After preparing `safe.step`, an `evil.pdf` under the same org/hash was accepted and finalized with the safe hash. | The grant names one bucket and path, hash, size, user, job, declaration; single use (`finalized_at`). Finalize needs an object this user owns at that path, written before the grant expired, with the granted size. The hash is verified by the worker (below). |
| 3 | Phase 1 left the legacy RPCs and Storage policy open | Yes. After declaring `controlled`, legacy prepare returned `upload_required` and legacy finalize registered the file. | One window: legacy signatures raise, the Storage policy is replaced in the same migration. |
| 4 | Clean scans not bound to job or content | Yes, for the internal org roles (`internal_estimator`, `internal_admin`; `job_files_update_internal`). A `client` member cannot update `job_files`. A repointed CAD row and a drawing moved to another job kept the part admitted. | Scans store the scanned hash; dispatch matches file id, current job, and current hash, and the part and file must be in the task's job. |

### Callers checked for window 1

The legacy and new upload RPCs are called only by
`src/features/quotes/api/uploads-api.ts` (web client). Nothing in `api/`,
`server/`, `ios/`, or `worker/` calls them. `worker/src/tools/importDmriflesQuotes.ts`
and `scripts/seed-dev.mjs` write `job-files` with the service role, which is
not subject to Storage RLS; they are internal tools, and a job they create has
no declaration, so dispatch still denies it.

### Guarantees

- **Never dispatchable.** Controlled or uncertain bytes never reach a provider:
  dispatch checks again the job's latest declaration and blocks under the shared
  lock, and requires, for each file the part sends, a hash verified from the
  bytes the worker staged that equals the claimed hash, and (drawing, STEP) a
  clean scan of those exact bytes in that job.
- **Never registered.** A `job_files` row is created only by finalize, which
  checks again the declaration under the lock and needs a matching grant and
  object. A declaration change that commits before finalize makes finalize
  fail.
- **Raw Storage presence.** An object can be written only if, at the moment of
  the Storage permission check (serialized with declaration and marking
  writers), the job's latest declaration was the granted clean one with no
  open block, and an unexpired, unfinalized grant for that exact path and user
  existed. Storage (storage-api) checks permission before it accepts the bytes
  and may write the final row with elevated rights, so a declaration that
  changes during the transfer cannot stop those bytes. They stay an orphan:
  no `job_files` row, unreadable by any client (the read policy needs a
  `job_files` row), never staged, never dispatched. Orphans are grants with no
  `finalized_at` whose path has an object. SQL cannot delete Storage bytes;
  deleting orphans needs the Storage API with the service role (not built).
- **Content hash.** SQL cannot read object bytes, so finalize cannot compare
  the hash. It checks owner, exact path, size (Storage metadata), and time
  window (written before the grant expired). The SHA-256 is checked when the worker first stages the file
  (`api_register_trusted_file_hash` records the staged hash), before any scan
  or dispatch: a clean scan is refused (`export_content_hash_mismatch`) and
  dispatch denies (`export_scan_missing`) unless the staged hash equals the
  claimed one. Rejecting at finalize itself would need finalize to run in a
  server function that downloads and hashes the object.

### Residual risks

- Orphaned objects from a declaration change during a transfer, or from a
  finalize that never ran, stay in Storage until a cleanup job deletes them.
- An object this user wrote earlier at the same path (a retry, or an orphan
  from before window 1) can be finalized under a new grant and a fresh clean
  declaration. Its hash is still verified by the worker before any scan or
  dispatch.
- Native CAD formats are verified by hash but not scanned for markings.
- The internal org roles can still edit `job_files` and `parts`; edits only
  remove admission, they cannot create it.

## Window 1 rehearsal follow up

The window 1 rehearsal (packet PR #687) applied head `673fbe33` and found six
main pgTAP suites that pass on main and fail after the draft. Each was
reproduced on a disposable local database, and the cause was split into
behavior and fixtures.

Behavior fixed in the draft:

- **Wrapper order.** The dispatch wrappers ran the export gate before the
  core, so an unknown task answered `export_declaration_missing` instead of
  the core's `scope_mismatch` or `dispatch_task_not_running`, and every core
  denial lost precedence. The wrappers now call the core first, inside a
  subtransaction. A core denial is returned unchanged. When the core
  authorizes and the export gate denies, the wrapper raises SQLSTATE `OV723`,
  which rolls back everything the core wrote (for example a consumed permit),
  and returns the export denial. The wrappers keep `search_path = pg_catalog`,
  as on main.
- **Finalize order.** The new finalize now runs the core first, so empty
  file, path, missing object and Founding Beta denials keep their codes. The
  grant check follows; when it fails, the whole call rolls back.
- **Grant time check.** Finalize no longer requires the object to be written
  after the grant was created (owner, exact path, size and the expiry bound
  remain). A same user retry or pre window orphan can then be finalized under
  a new grant and a clean declaration, and the worker still verifies its hash.
- **Lock timeout.** `set local lock_timeout = '3s'` precedes the
  `storage.objects` policy swap.

Fixtures updated in the suites (no assertion changed or removed):
`provider_dispatch_preflight`, `provider_dispatch_preflight_concurrency`,
`xometry_beta_dispatch_permits` and `free_confirmed_quote_access` seed a clean
declaration, verified hashes and clean scans just before their authorization
assertions. `empty_file_upload_rejection` and `founding_beta_file_boundaries`
route prepare and finalize through `pg_temp` helpers that use the declaring
overloads with a seeded clean declaration, and issue a grant before a Storage
write that must succeed. Every seeding block checks
`to_regclass('private.job_export_declarations')` first, so on main (draft not
applied) it does nothing and the suites run exactly as before.

### Decision for Blaine: the backfill

Window 1 backfills a `missing` declaration for every existing job with files.
Undeclared counts as uncertain, so each of those jobs is refused dispatch
until its owner declares, and (because no scans exist before the new worker)
until extraction runs again. Count the affected jobs on production before the
window (read only):

```sql
select count(*) as jobs_refused_dispatch_until_declared,
       count(distinct job.organization_id) as organizations
from public.jobs job
where exists (select 1 from public.job_files file where file.job_id = job.id);
```

Local check (disposable Docker, all 148 migrations, 2026-10-12): every main
suite was run without and with the draft (draft committed, so the dblink
concurrency suites see it). No suite that passes without the draft fails with
it. The OVD-723 pending suite passes 95/95.
