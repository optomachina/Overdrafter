# PDM versions and revisions

An assembly upload is one item with a tree of exact child versions. This is the SolidWorks PDM history model. It is separate from `part_versions`, which still records the extraction package fingerprint for a placement.

Nothing in this change is applied to production or staging. The migration runs only when local or CI Supabase applies `supabase/migrations`.

## Records

- **Item.** A part or assembly inside one organization. The identity is the part number when one is present, otherwise the filename. Inside a project, that identity is one item. A job that is not in a project keeps its own item, so the same filename in two loose jobs stays two items.
- **Version.** Every upload or save appends the next version (`1`, `2`, `3`, …). Versions are never overwritten. `created_by`, `created_at`, and a comment are stored on the row. A new version starts as `work_in_progress`.
- **Revision.** A label on one version. Prerelease labels are numeric (`01`, `02`, then `10`, `100`) and stay inside the signed 32-bit range. Released labels are single letters `A` through `Y`, skipping `I`, `O`, `Q`, `S`, `X`, and `Z`, and including `V`. The scheme (`numeric` or `alpha`) is stored on the revision. A label is unique per item. The sequence does not fill gaps; the next label follows the highest one already used. After `Y` the alpha sequence stops. An alpha label is written only by the release operation when a signed-in user calls it.
- **State.** `work_in_progress` → `pending_approval` → `released`, and `obsolete` from either pre-release state. `released` and `obsolete` rows cannot be updated or deleted. The job file and drawing attached to a released or obsolete version cannot be updated or deleted. A later change is a new work-in-progress version, and the next release takes the next letter.
- **BOM snapshot.** Each assembly version stores child lines: exact `child_item_version_id`, quantity, instance path, optional transform, bought-part flag, and optional configuration. `pdm_released_assembly_unreleased_children` lists unreleased children of a released assembly. That is a warning. Release still succeeds.
- **Quotes.** `quote_requests.item_version_id` and `quote_request_lanes.item_version_id` are nullable pins. Existing quote rows keep working when the pin is null.
- **Shares.** `item_shares.mode` is `follow_latest_released`, `follow_latest`, or `frozen`. Every share also stores the version it was created against. Frozen resolution returns that version. The other modes resolve the newest matching version. `pdm_resolve_share_version` does that.

Signed-in users can execute the read helpers (`pdm_item_readable`, `pdm_item_editable`, `pdm_version_writable`), the revision allocator, and the unreleased-child warning. Those five are on the authenticated security-definer allowlist. Trigger functions and the backfill run as the table owner and are executable by `service_role` only. A signed-in user cannot call `pdm_delete_unlocked_item` directly.

## Free-quote hooks

These fields are stored for a later change. This migration does not change who consumes a free quote.

- `quote_requests.free_quote_item_id` is the item, not the version. A later meter can count one allowance per item, so a new version of that item does not consume another free quote. Null leaves the current job meter alone.
- `quote_requests.free_quote_unlimited` defaults to false. Authenticated callers cannot set it. A later change sets it from the beta allowlist through `service_role`. This migration does not grant unlimited quotes to any account.

## Backfill

`pdm_backfill_legacy_placements` runs at the end of the migration and can be run again. It is idempotent.

- Each existing part becomes a work-in-progress version. Parts are not released. Deleting a job or project removes that work-in-progress history. A released or obsolete version blocks the delete with `pdm_released_history_blocks_delete`. A project-scoped item does not store a job id, so deleting one job in the project leaves the item. Deleting a placement clears `source_part_id` on a draft version. A released version keeps that link and blocks the placement delete.
- The identity key is the part number when one is present, otherwise the same filename stem `normalize_file_basename` already stores on placements. A later upload that adds a part number still finds a filename-only item with that stem. Two different part numbers stay two items. If the part number and the filename stem already belong to different items, the upload stops with `pdm_identity_conflict`.
- Parts that share a filename key inside one project become one item. Versions follow `created_at`. The earliest is version 1. A placement whose CAD file is `.sldasm` or `.asm` is an assembly.
- The same filename on a job with no project stays a separate item. Two jobs in one project that both contain that filename collapse. That is the main backfill risk: historical placements are ordered by time, not by a drawing revision, and drawing part numbers are not read.
- A job in more than one project is scoped to the earliest `project_jobs` row.
- A part's CAD file and drawing stay on that part's version. Other CAD and drawing files become their own work-in-progress version. A `.sldasm` or `.asm` file is an assembly; everything else is a part.
- A quote lane pins to its part's version when the lane scope has no CAD hash or that hash matches the version file. A quote request pins only when its job has exactly one part and no lane names a different CAD hash. A multi-part request stays unpinned and keeps its status.
- `part_versions` rows are left as they are.

## Rollback

Drop the policies, triggers, and functions added by `20261128192000_pdm_item_versions_and_revisions.sql`, then drop `item_shares`, `assembly_bom_lines`, `item_revisions`, `item_versions`, and `items`, then drop `parts.pdm_item_id`, `parts.pdm_item_version_id`, and the new quote columns. Jobs, files, parts, and quotes remain. Backfill rows disappear with the new tables.
