# Revision-to-Version Bridge

Last updated: March 13, 2026

## Purpose

This document captures the current revision-related behavior that Horizon 3 must preserve while OverDrafter moves toward immutable version entities.

It is intentionally a bridge document, not the final schema design. The goal is to make later version-graph work concrete enough to avoid breaking today’s part workspace, request-edit flow, and replacement-upload continuity.

## Current model inventory

### 1. Revision identity is mostly text metadata today

Current revision identity is spread across these places:

- `approved_part_requirements.revision` stores the editable revision string for the active part record.
- `approved_part_requirements.part_number` and `description` are used with `revision` as the human-facing identity set.
- `approved_part_requirements.spec_snapshot` duplicates `partNumber` and `revision` into a client-safe snapshot payload.
- `JobPartSummary.revision` in the web app is populated from approved requirements first, then falls back to filename parsing.
- `parsePartReference()` in `src/features/quotes/api.ts` infers `partNumber` and `revision` from normalized filenames or titles when approved requirements are absent.

Implication:

Current revision identity is not a first-class entity. It is a mutable text field plus fallback inference from filenames.

### 2. The part workspace is anchored on `job`, not a version entity

Current client routes and part detail loading use `jobId` as the stable workspace key:

- `fetchPartDetail(jobId)` loads the workspace.
- `fetchPartDetail()` selects `jobAggregate.parts[0]` as the active part representation.
- `fetchClientQuoteWorkspaceByJobIds()` also collapses each job to `jobParts[0]` as the primary part.
- `api_update_client_part_request()` selects the first part in the job with `order by created_at asc limit 1`.

Implication:

Today’s "current revision" behavior is effectively "the first part row in the job, with mutable pointers to the latest files for that normalized stem." Any Horizon 3 bridge must preserve a stable current view for `jobId`-based routes even if immutable version rows are introduced underneath.

### 3. Replacement uploads are append-plus-repoint, not destructive replacement

Current upload behavior already preserves useful history at the file row level:

- `uploadFilesToJob()` hashes each file, dedupes within the upload batch, and calls `api_prepare_job_file_upload()` / `api_finalize_job_file_upload()`.
- `job_files` rows are appended for each attachment to a job.
- `organization_file_blobs` dedupes file content across the organization by SHA-256, but each job attachment still creates its own `job_files` row.
- `attachFilesPicker` in `use-client-part-controller.ts` requires every new file to match the existing part’s normalized stem before attaching it to that job.

The current "replacement" semantics come from reconciliation:

- `job_part_file_set()` picks the latest CAD file and latest drawing file per `normalized_name`.
- `api_reconcile_job_parts()` updates the existing `parts` row so `cad_file_id` and `drawing_file_id` point at the newest files for that stem.
- Older `job_files` rows remain in the database, but the active workspace resolves only the newest pair.
- After attach, the UI immediately runs `reconcileJobParts(jobId)` and `requestExtraction(jobId)`.

Implication:

The repo already behaves as if uploads are immutable artifacts and the workspace exposes a mutable "current file set" pointer. Horizon 3 should build on that instead of inventing a separate destructive replacement concept.

### 4. Approved request data is mutable and follows the current part pointer

`api_update_client_part_request()` is the main mutation bridge between UI edits and quote-ready state. It currently:

- updates `jobs` request-level fields such as requested service kinds, quantities, and due date
- updates `parts.quantity` for the selected part row
- upserts `approved_part_requirements` by `part_id`
- overwrites `revision`, `part_number`, and related request metadata in place
- mirrors those values back into `spec_snapshot`
- extends that same snapshot with newer shipping, certification, sourcing, and release metadata

Because `approved_part_requirements` is unique on `part_id`, the current revision text is mutable rather than historical.

Implication:

If immutable version entities are added, this mutation path cannot remain the long-term source of revision history. During the bridge phase it still needs to keep current UI forms working, but it should stop being the only canonical home of revision identity.

### 5. Revision sibling navigation is cross-job and text-matched

The current part workspace shows revision navigation by:

- loading all part summaries in the organization
- matching siblings by identical `partNumber`
- excluding the current `jobId`
- sorting by `revision` text
- navigating between sibling `jobId` routes

This lives in:

- `fetchPartDetail()` in `src/features/quotes/api.ts`
- `revisionOptions` in `src/features/quotes/use-client-part-controller.ts`
- the Prev/Next revision controls in `src/pages/ClientPart.tsx`

Implication:

Current revision lineage is inferred from separate jobs that share a part number. That is a compatibility constraint. Horizon 3 cannot assume all revisions already live inside one explicit lineage graph.

### 6. Downstream quote logic already depends on current revision text

Current quote and publication logic compares approved requirements across jobs to decide whether auto-publication can reuse prior approved state. `api_get_quote_run_readiness()` checks:

- `part_number`
- `revision`
- `description`
- `material`
- `finish`
- `tightest_tolerance_inch`
- `quantity`
- `quote_quantities`
- `requested_by_date`
- `applicable_vendors`

Implication:

Revision text is already part of downstream behavioral equivalence. A future version model must preserve the ability to answer "is this current request equivalent to a previously published one?" without relying on mutable text fields alone.

### 7. Client access uses sanitized snapshots, not direct requirement rows

`approved_part_requirements` is internal-only at the database policy layer. Client surfaces receive a sanitized view through app-layer shaping of `spec_snapshot`.

Implication:

Any version bridge must keep a client-safe projection for current revision metadata. Horizon 3 should not expose internal-only review data just because version entities are added.

## Minimum compatibility strategy

The smallest safe bridge from today’s model to immutable version entities is:

### 1. Keep `job` as the stable workspace container

Do not force Horizon 1 or active client routes to navigate by version ID. `jobId` should remain the stable entry point while a "current version" pointer is introduced underneath it.

### 2. Introduce immutable version records for effective file sets

Each replacement-style upload should create a new immutable version candidate for the job’s part lineage instead of rewriting history in place.

For the bridge phase:

- preserve existing `job_files` append behavior
- treat the selected CAD+drawing combination as the versionable design package
- keep a current pointer that resolves the workspace’s active files

This lets the app continue to show "current files" while preserving prior file-set history explicitly instead of only implicitly through old `job_files` rows.

### 3. Treat current revision text as mirrored metadata during transition

Until all consumers move to version entities, the bridge should continue to support:

- editable `partNumber`
- editable `revision`
- editable release-related RFQ fields
- current client-safe summary rendering

The safest transition is dual representation:

- canonical revision/version identity moves to immutable version-side records
- legacy current-state columns and snapshots continue to be populated from the active version during the bridge period

That keeps existing request editors, summaries, and quote logic alive while the schema catches up.

### 4. Split "historical pinning" from "current pointers"

Current records mix both concerns. Horizon 3 should separate them:

- current workspace state should read through a current pointer
- quote runs, published packages, extraction records, and future audit trails should pin the specific version they were created from

Without that split, later replacement uploads can silently change the meaning of old review or quote records.

### 5. Preserve normalized-stem continuity

The current attach flow requires filename stem continuity within a job. Horizon 3 should keep that rule as the compatibility path for "this upload is a new version of the same line item" until a richer lineage model exists.

That means normalized stem should remain one of the bridge keys even after explicit version entities exist.

## Migration-sensitive hotspots

These areas are the highest-risk bridge points because they currently assume mutable current rows:

### `src/features/quotes/api.ts`

- `parsePartReference()` and `fetchJobPartSummaries...()` infer identity from filenames when approved requirements are missing.
- `fetchPartDetail()` computes revision siblings by `partNumber` across jobs.
- `fetchPartDetail()` and `fetchClientQuoteWorkspaceByJobIds()` collapse each job to its first part row.
- `updateClientPartRequest()` still writes mutable revision text into the current requirement record.
- `uploadFilesToJob()` plus `reconcileJobParts()` implement current replacement continuity.

### `src/features/quotes/use-client-part-controller.ts`

- attach flow assumes replacement uploads stay on the same `jobId`
- revision navigation assumes sibling jobs rather than an explicit version timeline
- display title and request draft resolution assume one current revision string

### `src/pages/ClientPart.tsx`

- revision controls navigate across sibling `jobId` routes, not within a version timeline for one lineage object

### `supabase/migrations/20260308113000_fix_job_file_reconcile_and_add_org_blob_dedupe.sql`

- `job_part_file_set()` selects latest files by `created_at`
- `api_reconcile_job_parts()` mutates `parts.cad_file_id` and `parts.drawing_file_id`
- upload prepare/finalize RPCs create append-only job file attachments, which are the best existing foundation for immutable version creation

### `supabase/migrations/20260310110000_add_client_part_request_update.sql`

- this migration introduced the mutable client request-update bridge for `part_number`, `revision`, and other current part metadata

### `supabase/migrations/20260313143000_add_request_service_intent.sql`

- service-intent fields were added to the same request-update RPC instead of being moved to a separate immutable request/version model

### `supabase/migrations/20260313150000_expand_client_part_request_rfq_metadata.sql`

- request edits mutate the active part requirement row rather than producing historical revision snapshots
- the RPC assumes the first part in the job is the editable current part
- newer release-sensitive RFQ metadata is now stored in the same mutable snapshot path as `revision`

### Current downstream SQL

- `api_get_quote_run_readiness()` already uses `part_number` plus `revision` and other fields as a published-equivalence test
- later version work must keep that comparison possible while shifting off mutable-only storage

## Horizon dependencies

### Horizon 1 dependency: part workspace revision-upload continuity

`horizon1.md` explicitly calls out "improve revision-upload continuity on a line item." That work depends on this bridge because today’s continuity is implemented as:

- same `jobId`
- same normalized filename stem
- append new files
- repoint the current part to the latest files

If Horizon 1 improves the UX without a bridge, it risks hard-coding mutable replacement behavior deeper into the workspace.

### Horizon 2 dependency: richer RFQ metadata

`horizon2.md` explicitly includes "revision and release status" in richer RFQ metadata. That work depends on this bridge because revision text and release context currently live inside mutable request metadata and `spec_snapshot`.

If Horizon 2 expands those fields before a bridge exists, it increases the amount of revision-sensitive state that later has to be untangled from mutable rows.

### Horizon 2 dependency: assembly-aware workflows

Assembly-aware uploads will need a lineage-safe answer to:

- which child file set is current
- which revision/release metadata applies to that child
- which quote or review artifacts were created from which design package

That cannot be solved cleanly if part identity remains only "first part row in a job plus mutable revision text."

## Bridge rules for Horizon 3 follow-on work

Later implementation work in Horizon 3 should treat these as non-negotiable bridge rules:

1. Do not break `jobId`-based workspace routing during the bridge.
2. Do not turn replacement uploads back into destructive overwrite semantics.
3. Do not rely on mutable `approved_part_requirements.revision` as the only revision source once immutable version rows exist.
4. Do not lose the ability to render a current client-safe revision summary.
5. Do not let quote, extraction, or publication history silently drift when new uploads become current.

## Recommended next design step

The next Horizon 3 design pass should define:

- the lineage object that groups same-part revisions over time
- the immutable version object that captures an effective file set
- the current pointer that keeps existing workspace flows stable
- the minimum dual-write or compatibility-view strategy for current app surfaces

That design can proceed without guessing as long as it preserves the current invariants documented here.
