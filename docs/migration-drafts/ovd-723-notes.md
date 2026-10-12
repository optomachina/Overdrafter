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
6. **More reason codes were needed.** These two are added to the plan's codes:
   `export_declaration_stale` (the upload referenced a declaration that is no
   longer the latest) and `export_control_lookup_failed` (the dispatch lookup
   raised).
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
- Deploy order: PHASE 1 first. The new client calls `api_declare_job_export_status`
  and the 7- and 9-argument upload overloads. Before PHASE 1, those calls fail and
  the client fails closed, so uploads stop. PHASE 2 (old signatures raise
  `export_declaration_missing`, storage grant required, preflight wrappers)
  comes after the client is deployed.
- Backfill: every existing job with files gets a `missing` declaration, so it is
  denied dispatch until the user declares.

## Verification status

- vitest: client gate (`src/features/quotes/api/uploads-export-control.test.ts`,
  `src/features/quotes/export-control.test.ts`), dialog
  (`src/components/quotes/ExportControlDeclarationDialog.test.tsx`), worker
  (`worker/src/exportControl.test.ts`), plus updated existing upload tests.
- pgTAP: `supabase/tests/ovd723_export_control_upload_block.sql` targets the
  draft. **Not executed.** This box has no Docker or local Postgres, and the
  draft isn't applied. It is deliberately not added to any CI path list.
- OVD-319 cert walk (test 8): **not run.** It needs the applied draft. Expected
  results are recorded as pending rows in `docs/providers/acceptance-tables.md`.
