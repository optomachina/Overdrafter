# Supabase migration history reconciliation

Last verified: August 15, 2026

## Purpose

The repository migration directory and the production Supabase migration
ledger must identify the same applied SQL with the same version. A linked
`supabase db push --dry-run` must also leave genuinely absent migrations
pending instead of hiding them through a broad history repair.

This document records statement-level evidence only. It does not authorize a
production migration, migration-history repair, customer-data query, or
provider operation.

## Canonical production lineage

Production stores each migration's statement payload in
`supabase_migrations.schema_migrations.statements`. The byte length and MD5
below match the repository file exactly. Renaming these files therefore
canonicalizes equivalent history without changing SQL or replaying DDL.

| Previous repository version | Production version | Migration | Bytes | MD5 |
| --- | --- | --- | ---: | --- |
| `20260730100000` | `20260731015213` | `secure_commercial_admin_operations` | 13,782 | `c94295fc80d2a1dcd9062f1c66b99d29` |
| `20260730110000` | `20260731015226` | `add_organization_entitlements` | 22,444 | `b26edbaf958e4dbd60a26df36f5ae78d` |
| `20260730120000` | `20260731015235` | `add_manual_quote_request_lifecycle` | 16,497 | `65bbfc66516eb755a615167df51ca70d` |
| `20260730130000` | `20260731015240` | `gate_automatic_quotes_by_entitlement` | 2,176 | `1598257f7b79d5280f5c1d1f87a16342` |
| `20260726120000` | `20260731010001` | `add_spend_caps_and_ledger` | 16,790 | `19273aecad5d2dbb5791fb28db2eca98` |
| `20260802001500` | `20260802020349` | `add_commercial_rollout_controls` | 12,854 | `7a470949b631006e24482faa65cd3b1b` |
| `20260802011500` | `20260802020417` | `gate_entitlement_admin_mutations` | 3,672 | `c33bcb920e4357557696bdb91d81ff16` |
| `20260802013500` | `20260802020418` | `harden_entitlement_rollout_gate` | 2,694 | `1fb97f349303ba51c4edfda30ddc1561` |
| `20260802014500` | `20260802020433` | `linearize_entitlement_admin_rollout_disable` | 1,774 | `5560199eb8978b6f5413972248f61c69` |
| `20260802015500` | `20260802031257` | `gate_automatic_quotes_by_rollout_control_ovd314` | 4,271 | `c9dfc57b400fb14a5fa26d36ec997a38` |
| historical `20260812003732` | `20260812004204` | `restore_job_vendor_preferences` | 17,774 | `252fc29305521494fda75ec0ffa88a7b` |

The restore payload was recovered unchanged from commit
`4d12830a6f2ad2049790db4f9bfb398c42aec813`. Keep
`20260408193000_add_project_and_job_vendor_preferences.sql`: the restore is a
later compatibility repair and does not replace the source migration in a
fresh database replay.

`npm run verify:migration-lineage` pins the seven newly reconciled canonical
files by filename, byte length, and SHA-256; rejects their retired aliases; and
rejects duplicate migration versions.

## Genuinely pending production work

After canonicalizing the six current aliases, restoring the seventh production
version, and adding OVD-371's forward correction, 23 repository migrations
remain local-only.

Catalog evidence proves these 18 are not fully deployed:

- `20260330144838_align_destructive_job_auth_contract`
- `20260331000000_fix_received_at_overwrite_on_resync`
- `20260331000001_add_api_enqueue_debug_vendor_quote`
- `20260331010000_sync_service_line_item_status_from_quote_requests`
- `20260402120000_persist_project_part_property_overrides`
- `20260403103000_harden_client_quote_workspace_lineage`
- `20260405103000_vendor_routing_scores`
- `20260406000000_add_extraction_quality_alerts`
- `20260408120000_add_revision_process_to_property_overrides`
- `20260409000000_add_payments_table`
- `20260514120000_add_hidden_live_quote_vendor_candidates`
- `20260725090000_add_supplier_directory_foundation`
- `20260728190000_mobile_auth_bridge`
- `20260731015300_add_manual_quote_admin_inbox`
- `20260815090000_add_founding_beta_enrollment`
- `20260815093000_enforce_founding_beta_file_boundaries`
- `20260815100000_add_xometry_beta_dispatch_permits`
- `20260815184740_add_xometry_worker_dispatch_preflight`

`20260514120100_seed_hidden_live_quote_vendor_capabilities` is data-only.
Its prerequisite enum values are absent from production, so it is pending and
must not be marked applied without running its ordered prerequisites.

These three versions have production definitions that appear manually present
or superseded, but they are not approved for history repair until a clean-head
catalog comparison proves exact behavioral equivalence:

- `20260402100000_include_service_line_item_id_in_vendor_quote_queue_payload`
- `20260408193000_add_project_and_job_vendor_preferences`
- `20260731015400_add_commercial_account_admin_api`

Do not use `supabase migration repair`, `db push --include-all`, or manual
inserts into the migration ledger to silence any item in this list.

## Shared-version SQL mismatch

Repository and production both record
`20260714032603_fix_client_drawing_preview_storage_path`, but the applied SQL
differs:

- repository: 518 bytes, MD5 `f1bffdde0d2e8bbdd1e884c4a05c4403`
- production: 466 bytes, MD5 `e156fa6ab8aff278227ebdf61494ed5b`

The production storage policy lacks the repository condition that binds
`asset.storage_bucket` to `storage.objects.bucket_id`. Migration listing and
normal push cannot detect or replay a shared version. Correct this through a
new forward access-control migration with its own review and tests; never edit,
repair, or replay the historical version.

OVD-371 adds the repository-only forward correction
`20260816011204_restore_drawing_preview_storage_bucket_binding`. It
recreates only `quote_artifacts_storage_read_drawing_previews` and requires
the preview metadata bucket to match the Storage object's bucket in addition
to the existing path and authorized-job checks. This paragraph records the
reviewed repository repair; production remains unchanged until Gates 2 and 3
are completed through the governed OVD-361 deployment checkpoint.
`npm run verify:migration-lineage` must not treat this new version as canonical
production lineage until a post-deploy audit independently matches its
production-recorded version, byte length, and content hash.

## Governed deployment gates

Production deployment remains blocked until all gates below pass.

### Gate 1 — repository lineage

1. Merge the filename-only reconciliation and exact restore payload.
2. Run a clean local migration reset to prove the changed July ordering is
   dependency-safe and the full repository head remains reproducible.
3. Run `npm run verify:migration-lineage` and `npm run verify`.
4. Confirm linked migration listing has no unexplained remote-only versions and
   linked dry-run makes no production writes.

Stop if any hash, version, reset, or dry-run result differs from this document.
Rollback is a repository revert; production has not changed.

### Gate 2 — pending-head safety

1. Merge and verify
   `20260816011204_restore_drawing_preview_storage_bucket_binding` without
   editing or replaying the shared historical version.
2. Resolve the three manual/superseded candidates through clean-head catalog
   comparison, including data and Storage effects.
3. Verify the data-only vendor-capability seed against an isolated or staging
   database.
4. Confirm each older product area in the pending list is intentionally
   approved for production.
5. Exercise the complete ordered head on a fresh isolated database and a
   production-equivalent staging environment.
6. Rehearse either a full pre-deploy snapshot restore or the exact staged
   roll-forward path, and record which recovery path the production operator
   will use if the head applies only partially.

Stop on destructive DDL, unexpected data rewrites, policy broadening, schema
drift, failed tests, or an unclassified migration. Do not partially deploy the
Founding Beta migrations around an unresolved earlier migration.

### Gate 3 — production migration and re-audit

1. Take the normal platform backup/snapshot and record the pre-deploy migration
   list and authorization catalog.
2. Use the repository's governed full-head `npm run db:push` path only after
   Gates 1 and 2 are approved.
3. Immediately rerun the read-only RLS/RPC/storage authorization audit.
4. Keep enrollment default-off and automatic provider rollout disabled.
5. Perform behavioral checks only with synthetic identities in staging or an
   isolated Supabase branch; no customer file or provider traffic is authorized
   by this document.

Stop if the push fails, the catalog differs from the staged result, reads
regress, or a new write path bypasses Founding Beta eligibility/current-notice
enforcement. Keep enrollment and automatic provider rollout disabled. If the
head applies only partially, use the recovery path rehearsed in Gate 2: restore
the full pre-deploy snapshot when that path was approved and tested, otherwise
complete the exact staged fix-forward from the reviewed commit. Do not improvise
object-by-object rollback or restore the known-vulnerable drawing-preview
predicate without an explicit incident decision.

## Read-only evidence query

The production-side proof used only migration metadata:

```sql
select
  version,
  name,
  cardinality(statements) as statement_count,
  length(array_to_string(statements, '')) as sql_bytes,
  md5(array_to_string(statements, '')) as sql_md5
from supabase_migrations.schema_migrations
order by version;
```

Do not include statement payloads, credentials, customer data, or raw
production rows in repository artifacts.
