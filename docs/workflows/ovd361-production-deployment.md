# OVD-361 production deployment

Last verified: August 15, 2026

## Purpose

This is the only authorized procedure for bringing the hosted Supabase project
from migration head `20260813005020` to the OVD-361/362-qualified head
`20260816015500`. It implements OVD-373's fail-closed deployment gate.

Do not substitute `npm run db:push`. The production-first migration set contains
files older than the hosted head and requires `--include-all`.

This procedure authorizes no customer upload, provider dispatch, enrollment,
billing activation, or commercial administration. All commercial rollout
controls stay off throughout the window.

## Recovery boundary

The hosted project is on Supabase Free. It has no operator-accessible managed
daily restore or point-in-time recovery. The pre-deploy export is a tested
logical disaster-recovery artifact, not an in-place snapshot or immediate
rollback. After any migration DDL commits, the immediate recovery path is the
reviewed fix-forward sequence below.

The logical export includes roles, Auth and Storage metadata, application
schemas, migration history, and database rows. It does not include Storage
object bytes, hosted configuration, secrets, Edge Functions, or a portable
hosted encryption root. A replacement-project or self-hosted recovery would
require separate service and Storage work. The export cutoff is the maximum
recovery point; writes after it may be lost.

The August 15 qualification restore passed in isolated Postgres using:

- image `public.ecr.aws/supabase/postgres:17.6.1.005`;
- image ID
  `sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144`;
- database role `supabase_admin`; and
- one `ON_ERROR_STOP` transaction for roles, schema, and application data,
  followed by the separately captured migration-ledger data.

The restored database reproduced the 74-entry ledger through
`20260813005020`, restored only aggregate-verified Auth, Storage-metadata, and
application rows, and passed
`scripts/verify-ovd372-production-preconditions.sql`. Matching only PostgreSQL
major version is not enough: earlier attempts failed on reserved-role ownership
and managed Auth schema-version drift.

Before the real window, take and qualify a fresh private export. Keep it outside
the repository with directory mode `0700` and file mode `0600`. Never put its
paths, hashes, rows, or bytes in Linear or a pull request.

## Immutable deployment inputs

Set these values in the operator shell:

```bash
set -euo pipefail
export OVD361_PROJECT_REF=ozuatdcakezjtevztjlr
export OVD361_DEPLOY_COMMIT="<authorized OVD-373 merge SHA>"
export OVD361_BACKUP_DIR="<private encrypted directory>"
export OVD372_PRODUCTION_DATABASE_URL="<read-only-capable production connection>"
export OVD361_DB_CLIENT_IMAGE="public.ecr.aws/supabase/postgres@sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144"
export OVD361_RESTORE_CONTAINER="ovd361-backup-restore"
export OVD361_RESTORE_PASSWORD="<fresh temporary password>"
```

Require Supabase CLI `2.78.1`. Run from a clean checkout of the authorized merge
commit:

```bash
set -euo pipefail
test "$(git rev-parse HEAD)" = "$OVD361_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
supabase link --project-ref "$OVD361_PROJECT_REF" --yes
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$OVD361_PROJECT_REF"
test "$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml | head -1)" = "$OVD361_PROJECT_REF"
test "$(supabase --version | awk '{print $NF}')" = "2.78.1"
docker pull "$OVD361_DB_CLIENT_IMAGE"
docker image inspect "$OVD361_DB_CLIENT_IMAGE"
npm run verify:ovd372-head
```

Stop on any project, commit, dirty-tree, tool-version, or frozen-head mismatch.

## Fresh private backup and restore qualification

Capture the cutoff time, migration list, and logical export:

```bash
set -euo pipefail
mkdir -p "$OVD361_BACKUP_DIR"
chmod 700 "$OVD361_BACKUP_DIR"

supabase migration list --linked \
  > "$OVD361_BACKUP_DIR/migration-list.txt"

supabase db dump --linked --role-only \
  --file "$OVD361_BACKUP_DIR/roles.sql"

supabase db dump --linked \
  --schema auth,storage,public,private,supabase_migrations \
  --file "$OVD361_BACKUP_DIR/full-schema.sql"

supabase db dump --linked --data-only --use-copy \
  --exclude storage.buckets_vectors \
  --exclude storage.vector_indexes \
  --file "$OVD361_BACKUP_DIR/data.sql"

supabase db dump --linked --data-only --use-copy \
  --schema supabase_migrations \
  --file "$OVD361_BACKUP_DIR/ledger-data.sql"

chmod 600 "$OVD361_BACKUP_DIR"/*
shasum -a 256 \
  "$OVD361_BACKUP_DIR/roles.sql" \
  "$OVD361_BACKUP_DIR/full-schema.sql" \
  "$OVD361_BACKUP_DIR/data.sql" \
  "$OVD361_BACKUP_DIR/ledger-data.sql"

docker run --rm --entrypoint psql \
  "$OVD361_DB_CLIENT_IMAGE" "$OVD372_PRODUCTION_DATABASE_URL" \
  --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align \
  --field-separator='|' \
  --command "select 'auth.users', count(*) from auth.users union all select 'storage.objects', count(*) from storage.objects union all select 'public.jobs', count(*) from public.jobs order by 1;" \
  > "$OVD361_BACKUP_DIR/source-aggregate-counts.txt"

chmod 600 "$OVD361_BACKUP_DIR/source-aggregate-counts.txt"
```

The separate ledger export is mandatory: the ordinary data export does not
include `supabase_migrations.schema_migrations`.

Restore to a disposable database on the exact pinned image. The container is
bound only to local port `65432`; `supabase_admin` authenticates with the fresh
temporary password:

```bash
set -euo pipefail
test -z "$(docker ps --all --quiet --filter name=^/${OVD361_RESTORE_CONTAINER}$)"
trap 'docker rm --force "$OVD361_RESTORE_CONTAINER" >/dev/null 2>&1 || true' EXIT

docker run --detach \
  --name "$OVD361_RESTORE_CONTAINER" \
  --publish 127.0.0.1:65432:5432 \
  --env POSTGRES_PASSWORD="$OVD361_RESTORE_PASSWORD" \
  --volume "$OVD361_BACKUP_DIR:/backup:ro" \
  --volume "$PWD:/workspace:ro" \
  "$OVD361_DB_CLIENT_IMAGE"

for attempt in {1..60}; do
  if docker exec "$OVD361_RESTORE_CONTAINER" pg_isready \
    --host 127.0.0.1 --username supabase_admin; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "Restore database did not become ready within 60 seconds." >&2
    exit 1
  fi
  sleep 1
done

docker exec --env PGPASSWORD="$OVD361_RESTORE_PASSWORD" \
  "$OVD361_RESTORE_CONTAINER" \
  createdb --host 127.0.0.1 --username supabase_admin ovd361_restore_verify

docker exec --env PGPASSWORD="$OVD361_RESTORE_PASSWORD" \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --single-transaction \
  --set ON_ERROR_STOP=1 \
  --file /backup/roles.sql \
  --file /backup/full-schema.sql \
  --command 'SET session_replication_role = replica' \
  --file /backup/data.sql \
  --file /backup/ledger-data.sql

docker exec --env PGPASSWORD="$OVD361_RESTORE_PASSWORD" \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --file /workspace/scripts/verify-ovd372-production-preconditions.sql

docker exec --env PGPASSWORD="$OVD361_RESTORE_PASSWORD" \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --tuples-only --no-align --field-separator='|' \
  --command "select 'auth.users', count(*) from auth.users union all select 'storage.objects', count(*) from storage.objects union all select 'public.jobs', count(*) from public.jobs order by 1;" \
  > "$OVD361_BACKUP_DIR/restored-aggregate-counts.txt"

cmp "$OVD361_BACKUP_DIR/source-aggregate-counts.txt" \
  "$OVD361_BACKUP_DIR/restored-aggregate-counts.txt"

docker exec --env PGPASSWORD="$OVD361_RESTORE_PASSWORD" \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --command "select count(*) as ledger_count, max(version) as ledger_head from supabase_migrations.schema_migrations;"

docker rm --force "$OVD361_RESTORE_CONTAINER"
trap - EXIT
```

Require `OVD-372 production preconditions passed.` Record only aggregate row
counts needed to prove the restore. Destroy the disposable database after the
proof. Stop if backup capture, hashing, restore, or the restored-catalog check
fails.

## Live preconditions

Before any migration-history write:

1. Run the live all-off and catalog verifiers:

   ```bash
   set -euo pipefail
   docker run --rm --entrypoint psql \
     --volume "$PWD:/workspace:ro" \
     "$OVD361_DB_CLIENT_IMAGE" "$OVD372_PRODUCTION_DATABASE_URL" \
     --no-psqlrc --set ON_ERROR_STOP=1 \
     --file /workspace/scripts/verify-ovd373-rollout-preconditions.sql

   docker run --rm --entrypoint psql \
     --volume "$PWD:/workspace:ro" \
     "$OVD361_DB_CLIENT_IMAGE" "$OVD372_PRODUCTION_DATABASE_URL" \
     --no-psqlrc --set ON_ERROR_STOP=1 \
     --file /workspace/scripts/verify-ovd372-production-preconditions.sql
   ```

2. Require both `OVD-373 rollout preconditions passed.` and
   `OVD-372 production preconditions passed.`

The verifier pins the 74-entry ledger, head `20260813005020`, catalog
fingerprints, owners, ACLs, RLS, policies, triggers, and the five reconciliation
preconditions. It reads no customer, file, quote, billing, or Storage-object
rows.

## Five history reconciliations

Run these one at a time and in this order:

```bash
set -euo pipefail
supabase migration repair --linked --status applied 20260402100000
supabase migration repair --linked --status applied 20260403103000
supabase migration repair --linked --status applied 20260406000000
supabase migration repair --linked --status applied 20260408193000
supabase migration repair --linked --status applied 20260731015400
supabase migration list --linked
```

These commands change only migration history. They do not execute the five SQL
files. No other version may be marked applied.

### Repair-only mismatch recovery

If a repair fails or the subsequent dry-run differs, do not push. Identify
which repairs succeeded and mark only those versions reverted, in reverse
order. If all five succeeded, the complete reversal is:

```bash
set -euo pipefail
supabase migration repair --linked --status reverted 20260731015400
supabase migration repair --linked --status reverted 20260408193000
supabase migration repair --linked --status reverted 20260406000000
supabase migration repair --linked --status reverted 20260403103000
supabase migration repair --linked --status reverted 20260402100000
```

Rerun the original live precondition. Require the original 74-entry ledger,
head `20260813005020`, and catalog fingerprint. If reversal or verification
fails, stop for incident review.

## Exact dry-run

Capture the linked dry-run without editing its output:

```bash
set -euo pipefail
supabase db push --linked --include-all --dry-run \
  2>&1 | tee "$OVD361_BACKUP_DIR/db-push-dry-run.txt"
```

Then run the local, read-only plan verifier:

```bash
set -euo pipefail
node scripts/verify-ovd373-deployment-plan.mjs \
  --dry-run-file "$OVD361_BACKUP_DIR/db-push-dry-run.txt" \
  --repair-versions 20260402100000,20260403103000,20260406000000,20260408193000,20260731015400
```

It must print `OVD-373 deployment-plan verification passed.` It pins the
production project, OVD-372 ancestry, five repair versions, and exactly these
20 migrations in order:

```text
20260330144838_align_destructive_job_auth_contract.sql
20260331000000_fix_received_at_overwrite_on_resync.sql
20260331000001_add_api_enqueue_debug_vendor_quote.sql
20260331010000_sync_service_line_item_status_from_quote_requests.sql
20260402120000_persist_project_part_property_overrides.sql
20260405103000_vendor_routing_scores.sql
20260408120000_add_revision_process_to_property_overrides.sql
20260409000000_add_payments_table.sql
20260514120000_add_hidden_live_quote_vendor_candidates.sql
20260514120100_seed_hidden_live_quote_vendor_capabilities.sql
20260725090000_add_supplier_directory_foundation.sql
20260728190000_mobile_auth_bridge.sql
20260731015300_add_manual_quote_admin_inbox.sql
20260815090000_add_founding_beta_enrollment.sql
20260815093000_enforce_founding_beta_file_boundaries.sql
20260815100000_add_xometry_beta_dispatch_permits.sql
20260815184740_add_xometry_worker_dispatch_preflight.sql
20260816011204_restore_drawing_preview_storage_bucket_binding.sql
20260816015000_restrict_extraction_quality_alert_evaluator.sql
20260816015500_restore_production_first_quote_contracts.sql
```

Stop on any missing, extra, altered, or reordered migration.

## Governed push

Only after every prior gate passes, run once:

```bash
set -euo pipefail
supabase db push --linked --include-all
```

Do not split the sequence and do not use the plain npm `db:push` shortcut.

### Partial-push recovery

If the push fails:

- keep enrollment, billing self-service, and all commercial rollout controls
  off;
- never revert the five repaired history rows after any migration DDL commits;
- record the error and run `supabase migration list --linked`;
- continue only when the applied migrations are an exact prefix of the
  20-file manifest, the failed migration is not recorded, and read-only catalog
  evidence shows no unexplained drift;
- for a transient failure, rerun the same pinned
  `supabase db push --linked --include-all`; already applied files are skipped;
- for SQL, catalog, permission, or data mismatch, stop and create a separately
  reviewed forward correction; and
- never edit a frozen migration or improvise object-by-object rollback.

The logical export is last-resort replacement-project or self-hosted disaster
recovery, not the default production response.

## Hosted postconditions

After a complete push, run:

```bash
set -euo pipefail
supabase migration list --linked

docker run --rm --entrypoint psql \
  --volume "$PWD:/workspace:ro" \
  "$OVD361_DB_CLIENT_IMAGE" "$OVD372_PRODUCTION_DATABASE_URL" \
  --no-psqlrc --set ON_ERROR_STOP=1 \
  --file /workspace/scripts/verify-ovd373-production-postconditions.sql

docker run --rm --entrypoint pg_dump \
  --volume "$OVD361_BACKUP_DIR:/backup" \
  "$OVD361_DB_CLIENT_IMAGE" \
  --schema-only --no-owner --no-comments \
  --schema public --schema private \
  --dbname "$OVD372_PRODUCTION_DATABASE_URL" \
  --file /backup/post-push-app-schema.sql

node scripts/verify-ovd373-schema-fingerprint.mjs \
  < "$OVD361_BACKUP_DIR/post-push-app-schema.sql"
```

Require:

- 99 migration rows and head `20260816015500`;
- no local/remote migration mismatch;
- `OVD-373 production postconditions passed.`;
- the OVD-372 normalized `public`/`private` schema SHA-256
  `fee2fd099b1237e90059fb44c1e2ca42d63343677bada9a75a16a6f8a38791e8`;
- every commercial rollout control disabled.

The postcondition script reads only migration/catalog metadata and the
commercial-control registry. It proves the OVD-361/362 enrollment, notice,
upload, Storage, dispatch-permit, worker-preflight, deferred-foundation, and
compatibility-route boundaries without reading customer content.

Record the Supabase Security Advisor result separately in the private operator
evidence. It is not an automated gate in this runbook because the pinned CLI
does not expose the hosted advisor. The pre-push baseline is one existing error
for `public.extraction_quality_summary`; any additional error keeps the release
blocked for review.

If any post-audit fails, do not mark migration history reverted. Keep every
gate off and fix forward with a reviewed migration. For confirmed data
corruption, stop writes and invoke a separately authorized disaster-recovery
procedure.

## Frozen-head guard retirement

The temporary `verify:ovd372-head` check intentionally prevents any migration
from being added before this upgrade is finished. Retire it only after:

1. the hosted postcondition verifier passes;
2. the production schema fingerprint matches;
3. the human confirms deployment; and
4. OVD-361/373 record the authorized commit and hosted evidence.

Then remove `verify:ovd372-head` from root `npm run verify` and its required CI
step. Keep the verifier, npm target, frozen manifest, qualification documents,
and deployment evidence as historical artifacts.

## Stop conditions

Stop on any project-ref, commit, dirty-tree, CLI-version, backup/restore,
precondition, repair, manifest, dry-run, permission, schema-hash, or
postcondition mismatch. Stop if the fresh export cannot be restored on the
pinned image or if the fix-forward recovery boundary is no longer accepted.
