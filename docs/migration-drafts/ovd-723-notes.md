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
   15-minute grant for the exact org/sha256 object (`private.export_cleared_upload_grants`),
   and PHASE 2 adds `current_user_has_export_cleared_upload(name)` to
   `"job_files_storage_insert"`.
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
- Phase split. **PHASE 1 enforces dispatch.** It wraps both preflights
  (`api_authorize_provider_worker_dispatch` and
  `api_authorize_xometry_beta_worker_dispatch`). They deny a job whose latest
  declaration is missing, controlled, or unsure, or that has a marking block
  pending review or confirmed controlled. Foreign providers (weerg, geomiq) and
  unknown providers have their own explicit rule. Only the worker calls these
  preflights, so the gate doesn't break old browser clients. Jobs those clients
  create have no declaration, though, so dispatch denies them until someone
  declares. **PHASE 2 enforces upload only.** The old upload signatures raise
  `export_declaration_missing`, and the Storage insert policy requires a
  declaration-backed grant.
- Deploy order: PHASE 1 first, then the client and worker together, then
  PHASE 2. The new client calls `api_declare_job_export_status` and the 7- and
  9-argument upload overloads. Before PHASE 1, those calls fail and the client
  fails closed, so uploads stop. Deploy the worker *after* PHASE 1, because it
  calls `api_record_export_control_marking_hits` and
  `api_record_export_control_clean_scan`, and a failed record fails the task.
  Between PHASE 1 and the worker deploy, the old worker records no scans, so
  every dispatch is denied with `export_scan_missing`. That fails closed, but
  keep the window short. The old worker doesn't know the new codes and reports
  them as a generic terminal denial. PHASE 2 comes after the client is
  deployed.
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
- **Dispatch rule (PHASE 1).** `export_control_dispatch_denial_for_task` reads
  the task's `part_id` and, after the job-level rule passes, calls
  `private.export_control_scan_denial`. That function returns
  `export_scan_missing` in four cases: the part is missing, the drawing has no
  drawing scan, the CAD file reference is dangling, or a STEP CAD file has no
  `step_header` scan.
- **Worker.** Extraction records a clean drawing scan. If the drawing text
  could not be read, nothing is recorded and dispatch stays denied. The
  trusted-reuse branch scans the target part's own staged drawing before the
  task completes (`scanStagedDrawingForExportMarkings`). A hit there opens a
  block on the target job. Every quote task scans the STEP header and records
  a clean scan before the preflight. A failed record fails the task.
- **Remediation (existing jobs, 1.18).** Parts extracted before the deploy
  have no drawing scan, so dispatch denies them with `export_scan_missing`.
  The backfill also marks every existing job `missing`. Running
  `api_request_extraction` again doesn't fix this. Its current body
  (`20260812042000`) only queues `extract_part` for parts with no
  `drawing_extractions` row, so an extracted part is never re-queued and never
  scanned. Instead:
  - A member declares on the existing job through `api_declare_job_export_status`,
    using the same three answers with no default. `controlled` and `unsure` are
    recorded and keep the job denied. The UI is `ExportControlJobStatusPanel`
    on the part page.
  - A member, or a platform admin from the internal job page, requests
    `api_request_export_control_rescan`. It queues one `export_rescan_part`
    task per part (a new `queue_task_type` value). The worker scans the
    part's own drawing text and STEP header and records hits or clean scans.
    It never re-runs extraction or calls a provider. An unreadable drawing or
    a missing file records nothing and fails the task, so dispatch stays
    denied.
  - `api_get_job_export_control_status` now also returns `partsMissingScan`
    and `rescansPending`.
- **Known limits.** Only PDF drawings and STEP CAD headers have a scanner. The
  rule doesn't cover other CAD formats (for example `.sldprt`, `.x_t`, `.igs`),
  so it neither scans nor holds them. That is unchanged from before. Closing
  that gap means either a scanner per format or denying dispatch for unscanned
  formats, and that call needs a product decision. Each quote task appends one
  STEP scan row per vendor attempt. The rows are small and append-only.

Tests: `worker/src/exportControl.test.ts` covers the reference model, the record
and fail-closed behavior, the reuse-branch wiring, and draft assertions
(per-file keying, the phase split, and the rollback), plus the existing-part
rescan. The pending pgTAP section 8 covers the SQL rule, including a reused
copy of the same bytes being denied. Section 9 covers an existing job: the
declaration, the `api_request_extraction` skip, the rescan RPC, and admission
after fresh clean scans.

## Verification status

- vitest: client gate (`src/features/quotes/api/uploads-export-control.test.ts`,
  `src/features/quotes/export-control.test.ts`), dialog
  (`src/components/quotes/ExportControlDeclarationDialog.test.tsx`), worker
  (`worker/src/exportControl.test.ts`, which also checks that the SQL
  foreign-provider list exactly equals `FOREIGN_JURISDICTION_PROVIDERS`), plus
  updated existing upload tests and `worker/src/jev/operationalTask.test.ts`.
- pgTAP: `supabase/tests/pending/ovd723_export_control_upload_block.sql.pending`
  targets the draft. **Not executed.** This box has no Docker or local
  Postgres, and the draft isn't applied. The policy runner stages but does not
  execute non-`.sql` files, so the suite stays out of CI until the migration
  window, when it is renamed back to `supabase/tests/ovd723_export_control_upload_block.sql`.
- OVD-319 cert walk (test 8): **not run.** It needs the applied draft. Expected
  results are recorded as pending rows in `docs/providers/acceptance-tables.md`.
