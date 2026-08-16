# OVD-361 production deployment

Last verified: August 16, 2026

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

On August 16, the first governed production attempt stopped before schema DDL
because the earlier synthetic rehearsal did not reproduce the pinned CLI's
history-repair statement payload. The runner reversed all five repair rows and
re-proved the original 74-row and rollout-off state. Replaying the exact pinned
CLI against a fresh qualified production restore then proved repaired-ledger
fingerprint `b8ea46e15db662015974eb476060abe3` and final-ledger fingerprint
`003aabeb74c993bd942f5d59b29855ac`. The same final state passed the complete
production-postcondition SQL. No customer-content query was used.

The exact production-derived post-push app-schema fingerprint is
`1197ed7b3794163bcfa558c464c065d6d27b2eba31d418fac054cbb3a0672552`.
A normalized SQL diff against OVD-372's clean-head artifact found only the 12
pre-existing `supabase_admin` default grants for future public sequences,
functions, and tables. Those provider-managed baseline grants were absent from
the earlier insufficient-privilege capture; this procedure preserves and pins
them instead of changing an unrelated production privilege contract.

The current credential-safe role export was also replayed on August 16 into a
fresh container using the exact pinned database image. The filtered role file,
schema, application data, and migration ledger restored in one
`ON_ERROR_STOP` transaction. The restored database then passed both the exact
74-row production-precondition verifier and the rollout-all-off verifier. This
qualifies the committed role filter; it does not replace the required fresh
private production export and aggregate comparison immediately before the real
deployment window.

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
export OVD361_DB_CLIENT_IMAGE="public.ecr.aws/supabase/postgres@sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144"
export OVD361_RESTORE_CONTAINER="ovd361-backup-restore"
export OVD361_PRODUCTION_PGPASS_FILE="$(node scripts/manage-ovd373-temporary-db-access.mjs path)"
export OVD361_PRODUCTION_CA_FILE="<private absolute 0600 Supabase CA certificate>"
export OVD361_BILLING_DISABLED_ENV_FILE="<private absolute 0600 env file>"
export OVD373_SUPABASE_PROFILE="supabase"
export OVD361_RESTORE_PASSWORD_FILE="$OVD361_BACKUP_DIR/restore-postgres-password"
export OVD361_RESTORE_PGPASS_FILE="$OVD361_BACKUP_DIR/restore.pgpass"
```

Require Supabase CLI `2.78.1`. Run from a clean checkout of the authorized merge
commit:

```bash
set -euo pipefail
test "$(git rev-parse HEAD)" = "$OVD361_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
supabase link --project-ref "$OVD361_PROJECT_REF" --yes
test "$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml | head -1)" = "$OVD361_PROJECT_REF"
test "$(supabase --version | awk '{print $NF}')" = "2.78.1"
node scripts/verify-ovd373-database-target.mjs --allow-permanent
test ! -e "$OVD361_PRODUCTION_PGPASS_FILE"
test ! -L "$OVD361_PRODUCTION_PGPASS_FILE"
OVD373_TEMP_ACCESS_PREPARED=0
cleanup_ovd373_temp_access() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [[ "$OVD373_TEMP_ACCESS_PREPARED" = "1" ]]; then
    node scripts/manage-ovd373-temporary-db-access.mjs revoke || exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup_ovd373_temp_access EXIT
trap 'exit 130' INT TERM
OVD373_TEMP_ACCESS_PREPARED=1
node scripts/manage-ovd373-temporary-db-access.mjs grant
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
test -f "$OVD361_PRODUCTION_PGPASS_FILE"
test ! -L "$OVD361_PRODUCTION_PGPASS_FILE"
test "$(stat -f '%Lp' "$OVD361_PRODUCTION_PGPASS_FILE")" = "600"
test -f "$OVD361_PRODUCTION_CA_FILE"
test ! -L "$OVD361_PRODUCTION_CA_FILE"
test "$(stat -f '%Lp' "$OVD361_PRODUCTION_CA_FILE")" = "600"
test -f "$OVD361_BILLING_DISABLED_ENV_FILE"
test ! -L "$OVD361_BILLING_DISABLED_ENV_FILE"
test "$(stat -f '%Lp' "$OVD361_BILLING_DISABLED_ENV_FILE")" = "600"
test "$(tr -d '\r\n' < "$OVD361_BILLING_DISABLED_ENV_FILE")" = \
  "BILLING_SELF_SERVICE_ENABLED=false"
docker pull "$OVD361_DB_CLIENT_IMAGE"
docker image inspect "$OVD361_DB_CLIENT_IMAGE"
npm run verify:ovd372-head
```

The grant helper reads the already-authenticated Supabase CLI token from the
native macOS Keychain without printing or persisting it, requests Supabase's
exact five-minute `cli_login_postgres` credential, writes only a mode-`0600`
pgpass entry plus non-secret expiry evidence, and changes the ignored local pooler URL to the exact
`cli_login_postgres.<project-ref>` role. The target verifier accepts only that
role during governed work; the original `postgres.<project-ref>` role is accepted
only by the explicit pre-grant setup check. Exact host, port, database, protocol,
and no-embedded-credential checks remain unchanged. The verifier also
rejects alternate project refs, non-Supabase hosts, and symlinked link
artifacts. Stop on any project, commit, dirty-tree, tool-version,
credential-file, or frozen-head mismatch.

The Management API endpoint creates and deletes the project's CLI login role,
so the production freeze also prohibits other linked Supabase CLI database
commands for this project during the window. The credential contract is exactly
300 seconds, matching the provider response observed on August 16, 2026. The
helper rejects shorter or longer responses, records the locally observed expiry,
and rotates the credential between bounded backup phases and under the held
database locks immediately before the push and post-push verification. Approved
read-only production probes proved that both a credential refresh and the full
provider expiry preserve an already-authenticated database session. Backup
capture and production migration use separate initial credentials so local
restore qualification cannot consume the migration window.
If a lifetime check fails, stop, revoke, and restart from a new backup directory;
never weaken the TTL or reuse a partially qualified window.

The session pooler does not apply a startup-only `PGOPTIONS=-c role=postgres`
request to the temporary login. Every direct `psql` client therefore executes
`SET ROLE postgres` in the same connection before protected-schema reads, and
every direct `pg_dump`/`pg_dumpall` client uses its native `--role postgres`
option. The pinned Supabase CLI performs its own equivalent role step-up for
history repair and migration push. Do not replace these explicit steps with a
startup parameter.

The cleanup trap is installed in the same guarded block before the credential
is requested, so every later normal or failed operator-shell exit attempts
server revocation and removes the local pgpass. The credential's server expiry
is a second fail-safe.

Download the project Server root certificate from Supabase Dashboard → Database
Settings → SSL Configuration, store it outside the repository, and set
`OVD361_PRODUCTION_CA_FILE` to that exact mode-`0600` file. This is the
project-specific certificate source documented by Supabase for
`verify-full`; do not substitute a certificate discovered from the live socket.

## Fresh private backup and restore qualification

Capture the cutoff time, migration list, and logical export:

```bash
set -euo pipefail
umask 077
if [[ -e "$OVD361_BACKUP_DIR" || -L "$OVD361_BACKUP_DIR" ]]; then
  echo "Refusing to replace an existing backup path." >&2
  exit 1
fi
mkdir -m 700 "$OVD361_BACKUP_DIR"
test "$(stat -f '%Lp' "$OVD361_BACKUP_DIR")" = "700"

export OVD373_POOLER_URL="$(tr -d '\r\n' < supabase/.temp/pooler-url)"
export PGPASSFILE="$OVD361_PRODUCTION_PGPASS_FILE"
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$OVD361_PRODUCTION_CA_FILE"

node scripts/manage-ovd373-temporary-db-access.mjs refresh
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
supabase migration list --db-url "$OVD373_POOLER_URL" \
  > "$OVD361_BACKUP_DIR/migration-list.txt"

node scripts/manage-ovd373-temporary-db-access.mjs refresh
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
docker run --rm --entrypoint pg_dumpall \
  --env PGPASSFILE=/run/secrets/production.pgpass \
  --env PGSSLMODE=verify-full \
  --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
  --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
  --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
  "$OVD361_DB_CLIENT_IMAGE" \
  --roles-only --role postgres --quote-all-identifiers \
  --no-role-passwords --no-comments --dbname "$OVD373_POOLER_URL" \
  | bash scripts/filter-ovd373-role-dump.sh \
  > "$OVD361_BACKUP_DIR/roles.sql"

node scripts/manage-ovd373-temporary-db-access.mjs refresh
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
docker run --rm --entrypoint pg_dump \
  --env PGPASSFILE=/run/secrets/production.pgpass \
  --env PGSSLMODE=verify-full \
  --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
  --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
  --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
  "$OVD361_DB_CLIENT_IMAGE" \
  --schema-only --no-owner --no-comments --role postgres \
  --schema auth --schema storage --schema public --schema private \
  --schema supabase_migrations --dbname "$OVD373_POOLER_URL" \
  | node scripts/prepare-ovd373-schema-restore.mjs \
  > "$OVD361_BACKUP_DIR/full-schema.sql"

node scripts/manage-ovd373-temporary-db-access.mjs refresh
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
docker run --rm --entrypoint pg_dump \
  --env PGPASSFILE=/run/secrets/production.pgpass \
  --env PGSSLMODE=verify-full \
  --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
  --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
  --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
  --volume "$OVD361_BACKUP_DIR:/backup" \
  "$OVD361_DB_CLIENT_IMAGE" \
  --data-only --role postgres \
  --schema auth --schema storage --schema public --schema private \
  --exclude-table storage.buckets_vectors \
  --exclude-table storage.vector_indexes \
  --dbname "$OVD373_POOLER_URL" --file /backup/data.sql

node scripts/manage-ovd373-temporary-db-access.mjs refresh
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
docker run --rm --entrypoint pg_dump \
  --env PGPASSFILE=/run/secrets/production.pgpass \
  --env PGSSLMODE=verify-full \
  --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
  --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
  --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
  --volume "$OVD361_BACKUP_DIR:/backup" \
  "$OVD361_DB_CLIENT_IMAGE" \
  --data-only --role postgres --schema supabase_migrations \
  --dbname "$OVD373_POOLER_URL" --file /backup/ledger-data.sql

chmod 600 "$OVD361_BACKUP_DIR"/*
shasum -a 256 \
  "$OVD361_BACKUP_DIR/roles.sql" \
  "$OVD361_BACKUP_DIR/full-schema.sql" \
  "$OVD361_BACKUP_DIR/data.sql" \
  "$OVD361_BACKUP_DIR/ledger-data.sql"

node scripts/manage-ovd373-temporary-db-access.mjs refresh
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
docker run --rm --entrypoint psql \
  --env PGPASSFILE=/run/secrets/production.pgpass \
  --env PGSSLMODE=verify-full \
  --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
  --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
  --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
  "$OVD361_DB_CLIENT_IMAGE" "$OVD373_POOLER_URL" \
  --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
  --field-separator='|' \
  --command 'set role postgres' \
  --command "select 'auth.users', count(*) from auth.users union all select 'storage.objects', count(*) from storage.objects union all select 'public.jobs', count(*) from public.jobs order by 1;" \
  > "$OVD361_BACKUP_DIR/source-aggregate-counts.txt"

chmod 600 "$OVD361_BACKUP_DIR/source-aggregate-counts.txt"

node scripts/manage-ovd373-temporary-db-access.mjs revoke
OVD373_TEMP_ACCESS_PREPARED=0
node scripts/verify-ovd373-database-target.mjs --allow-permanent
```

The committed role filter follows the pinned CLI's reserved-role handling but
intentionally drops any persistent reserved-role `session_replication_role`
default. The restore enables `replica` only for the single bounded import
connection; every later verification connection keeps normal trigger and
foreign-key behavior.

The separate ledger export is mandatory: the ordinary data export does not
include `supabase_migrations.schema_migrations`.

Restore to a disposable database on the exact pinned image. All restore clients
run inside the container, so no host port is published. The raw temporary
password and restore pgpass file are mode `0600`, mounted read-only, and never
placed in process arguments, environment values, or Docker metadata:

```bash
set -euo pipefail
test -z "$(docker ps --all --quiet --filter name=^/${OVD361_RESTORE_CONTAINER}$)"
test ! -e "$OVD361_RESTORE_PASSWORD_FILE"
test ! -L "$OVD361_RESTORE_PASSWORD_FILE"
test ! -e "$OVD361_RESTORE_PGPASS_FILE"
test ! -L "$OVD361_RESTORE_PGPASS_FILE"
trap 'docker rm --force "$OVD361_RESTORE_CONTAINER" >/dev/null 2>&1 || true; rm -f "$OVD361_RESTORE_PASSWORD_FILE" "$OVD361_RESTORE_PGPASS_FILE"' EXIT
umask 077
openssl rand -hex 32 > "$OVD361_RESTORE_PASSWORD_FILE"
awk '{print "127.0.0.1:5432:*:supabase_admin:" $0}' \
  "$OVD361_RESTORE_PASSWORD_FILE" > "$OVD361_RESTORE_PGPASS_FILE"
chmod 600 "$OVD361_RESTORE_PASSWORD_FILE" "$OVD361_RESTORE_PGPASS_FILE"

docker run --detach \
  --name "$OVD361_RESTORE_CONTAINER" \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password \
  --volume "$OVD361_BACKUP_DIR:/backup:ro" \
  --volume "$PWD:/workspace:ro" \
  --volume "$OVD361_RESTORE_PASSWORD_FILE:/run/secrets/postgres-password:ro" \
  --volume "$OVD361_RESTORE_PGPASS_FILE:/run/secrets/restore.pgpass:ro" \
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

docker exec --env PGPASSFILE=/run/secrets/restore.pgpass \
  "$OVD361_RESTORE_CONTAINER" \
  createdb --host 127.0.0.1 --username supabase_admin \
  --owner postgres ovd361_restore_verify

docker exec --env PGPASSFILE=/run/secrets/restore.pgpass \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --command 'drop schema public;'

docker exec --env PGPASSFILE=/run/secrets/restore.pgpass \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --single-transaction \
  --set ON_ERROR_STOP=1 \
  --file /backup/roles.sql \
  --command 'set role postgres' \
  --file /backup/full-schema.sql \
  --command 'SET session_replication_role = replica' \
  --file /backup/data.sql \
  --file /backup/ledger-data.sql

docker exec --env PGPASSFILE=/run/secrets/restore.pgpass \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --file /workspace/scripts/verify-ovd372-production-preconditions.sql

docker exec --env PGPASSFILE=/run/secrets/restore.pgpass \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --file /workspace/scripts/verify-ovd373-rollout-preconditions.sql

docker exec --env PGPASSFILE=/run/secrets/restore.pgpass \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --tuples-only --no-align --field-separator='|' \
  --command "select 'auth.users', count(*) from auth.users union all select 'storage.objects', count(*) from storage.objects union all select 'public.jobs', count(*) from public.jobs order by 1;" \
  > "$OVD361_BACKUP_DIR/restored-aggregate-counts.txt"

cmp "$OVD361_BACKUP_DIR/source-aggregate-counts.txt" \
  "$OVD361_BACKUP_DIR/restored-aggregate-counts.txt"

docker exec --env PGPASSFILE=/run/secrets/restore.pgpass \
  "$OVD361_RESTORE_CONTAINER" \
  psql --host 127.0.0.1 --username supabase_admin \
  --dbname ovd361_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
  --command "select count(*) as ledger_count, max(version) as ledger_head from supabase_migrations.schema_migrations;"

docker rm --force "$OVD361_RESTORE_CONTAINER"
rm -f "$OVD361_RESTORE_PASSWORD_FILE" "$OVD361_RESTORE_PGPASS_FILE"
trap - EXIT
```

`prepare-ovd373-schema-restore.mjs` preserves the schema dump byte-for-byte except
for one `RESET ROLE` immediately before the first managed default-privilege
statement. Schema objects are therefore created as `postgres`, while the
existing `supabase_admin` session restores default privileges for managed roles.

Require `OVD-372 production preconditions passed.` and
`OVD-373 rollout preconditions passed.` Record only aggregate row counts needed
to prove the restore. Destroy the disposable database after the proof. Stop if
backup capture, hashing, restore, or either restored-database check fails.

## Governed production upgrade

After the disposable restore passes, mint a new five-minute credential for the
database upgrade. Cleanup is already armed, so interruption during the request
still triggers a server-side revocation attempt:

```bash
set -euo pipefail
trap cleanup_ovd373_temp_access EXIT
trap 'exit 130' INT TERM
OVD373_TEMP_ACCESS_PREPARED=1
node scripts/manage-ovd373-temporary-db-access.mjs grant
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
```

The upgrade is a single audited runner, not a sequence of operator copy/paste
steps. Before invoking it, prohibit every concurrent production deploy and
every direct owner/superuser write to
`private.commercial_rollout_controls`. Freeze every Supabase Edge Function
deploy and secret mutation for this project from the first billing-disabled
probe until the runner exits; the solo operator must record that freeze in the
private deployment evidence. Database advisory locks cannot police the Edge
management plane. The runner:

1. re-verifies the linked project, exact commit, clean tree, pinned CLI, frozen
   migration bytes, exact temporary role, at least four minutes of remaining
   credential lifetime, private credential files, and hosted billing-disabled response;
2. holds one session-level deployment lock plus the four existing
   `commercial-rollout:<capability>` locks for the entire database window;
3. verifies the all-off registry and original 74-entry production catalog only
   after those locks are held;
4. applies the five exact history reconciliations and proves the resulting
   79-entry ledger without releasing the locks;
5. rechecks every immutable input, captures and verifies a fresh exact 20-file
   dry-run, refreshes the five-minute credential while the locks remain held,
   requires at least four minutes of remaining lifetime, and immediately invokes
   the real push with no manual gap;
6. refreshes again under the same surviving locks immediately after the push,
   then verifies the final 99-entry ledger, authorization catalog, all-off registry,
   normalized schema fingerprint, and hosted billing-disabled response before
   releasing the locks.

Run it once from the qualified checkout:

```bash
set -euo pipefail
bash scripts/run-ovd373-production-upgrade.sh
```

Require all of these terminal messages:

- `OVD-373 database-target verification passed.`
- `OVD-373 hosted billing-disabled verification passed.` before and after the
  push;
- `OVD-373 rollout preconditions passed.`;
- `OVD-372 production preconditions passed.`;
- `OVD-373 repaired-ledger verification passed.`;
- `OVD-373 deployment-plan verification passed.`;
- `OVD-373 production postconditions passed.`;
- `OVD-373 app-schema verification passed: 1197ed7b3794163bcfa558c464c065d6d27b2eba31d418fac054cbb3a0672552`;
- `OVD-373 governed production upgrade completed successfully.`

After those messages, revoke the short-lived role before releasing the operator
shell. A successful revoke restores the ignored pooler URL to the permanent
project-bound username and removes the local pgpass file:

```bash
set -euo pipefail
node scripts/manage-ovd373-temporary-db-access.mjs revoke
OVD373_TEMP_ACCESS_PREPARED=0
trap - EXIT INT TERM
node scripts/verify-ovd373-database-target.mjs --allow-permanent
test ! -e "$OVD361_PRODUCTION_PGPASS_FILE"
test ! -L "$OVD361_PRODUCTION_PGPASS_FILE"
```

If revocation fails, do not discard the pgpass or claim cleanup. Record the
failure for incident review and rely on the credential's server TTL while the
Management API retry is investigated.

The runner first sets `BILLING_SELF_SERVICE_ENABLED=false` from the exact
private env file. It then probes the hosted Checkout endpoint with the public
project JWT and accepts only the exact current Founding Beta pre-auth disabled
`503` response. The legacy response is rejected because the former function
used the same text for both the flag boundary and runtime-configuration
failure. Therefore the current reviewed `billing-sessions` function must be
deployed before this runner can proceed; that production deployment requires
its own explicit authorization. Generic and legacy `503` responses are
rejected.
The database connection URL comes only from the freshly linked CLI metadata;
the password is supplied through the read-only pgpass mount. No database or
restore password appears in command arguments, environment values, logs, or
Docker metadata.

The lock session blocks every audited rollout-control API writer because those
writers acquire the same advisory key exclusively. It cannot block an owner or
superuser who writes the private table directly, which is why direct writes and
unmanaged deployers are forbidden during this window.

The runner changes migration history only for these five versions, in order;
it does not execute those five historical SQL files:

```text
20260402100000
20260403103000
20260406000000
20260408193000
20260731015400
```

### Repair-only mismatch recovery

If a repair fails or the subsequent dry-run differs, do not push. Identify
which repairs reached the hosted ledger. The governed runner alone may mark
those versions reverted, in reverse order, while its original deployment and
four rollout locks are still held. Every reversal is guarded by the same lock
watchdog as the forward repairs. If the lock session has exited, the runner
refuses every recovery write and stops for incident review; do not execute raw
manual repair commands outside a separately reviewed, lock-owning recovery
runner.

The push helper creates a private atomic admission marker only after its lock
preflight succeeds. If no marker exists, recovery remains in the repair-only
path. If the marker exists, the runner first classifies the hosted migration
rows as zero committed files, an exact nonzero prefix, or an invalid state.
Before classification, it proves that every row outside the 20-file push still
has the qualified 79-row repaired-ledger count and fingerprint, so an
unexpected history row cannot be hidden by the expected-version filter.
Only zero committed files plus the original live lock holder and exact 79-row
ledger may return to repair-only recovery. A nonzero prefix preserves the five
repair rows for the reviewed resume path; lock loss, an invalid prefix, or an
inspection failure performs no recovery write and requires incident review.

Rerun the original live precondition. Require the original 74-entry ledger,
head `20260813005020`, and catalog fingerprint. If reversal or verification
fails, stop for incident review.

The runner's final dry-run parser strips terminal color codes and accepts only
exact bullet records inside the pinned CLI's `Would push these migrations:`
section. It pins exactly these 20 migrations in order:

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

### Partial-push recovery

If the push fails:

- keep enrollment, billing self-service, and all commercial rollout controls
  off;
- never revert the five repaired history rows after any migration DDL commits;
- record the error and run
  `supabase migration list --db-url "$OVD373_POOLER_URL"`;
- continue only when the applied migrations are an exact prefix of the
  20-file manifest, the failed migration is not recorded, and read-only catalog
  evidence shows no unexplained drift;
- if zero migration files committed, first prove the exact 79-row repaired
  ledger fingerprint `b8ea46e15db662015974eb476060abe3`, revert the five
  repairs, and prove the original 74-row preconditions before rerunning the
  base runner from a fresh qualified backup;
- if any migration file committed, never rerun the base runner: create a
  separately reviewed resume profile that pins the exact applied prefix and
  exact remaining suffix before another hosted write;
- for SQL, catalog, permission, or data mismatch, stop and create an
  incident-specific reviewed recovery package as described below; and
- never edit a frozen migration or improvise object-by-object rollback.

The logical export is last-resort replacement-project or self-hosted disaster
recovery, not the default production response.

The successful final state is exactly 99 ledger rows through
`20260816015500`, fingerprint `003aabeb74c993bd942f5d59b29855ac`.

### Reviewed recovery profiles

The base OVD-373 profile rejects every added or edited migration. Do not add a
generic recovery exception.

If a partially applied prefix stops on a catalog or data prerequisite, a new
reviewed recovery package must add one hash-pinned prerequisite migration with
a timestamp before the failed file. The same PR must update the exact recovery
manifest and order, expected ledger set/count/fingerprint, deployment-plan
profile, schema fingerprint, backup replay evidence, interruption test, and
postconditions. Requalify that exact package from a fresh production export
before another hosted write.

If all 20 files committed and only a post-audit fails, the reviewed recovery
package may use a later forward migration, but it must update and requalify the
same exact evidence surfaces. If the failed SQL cannot be made safely retryable
by an earlier prerequisite, there is no generic CLI correction path: stop for
incident authorization. Direct SQL or ledger edits require separate explicit
incident approval and full replay reconciliation.

## Hosted postconditions and private evidence

The runner's postcondition script reads only migration/catalog metadata,
Founding Beta evidence-table aggregates, and the commercial-control registry.
It proves the OVD-361/362 enrollment, notice, upload, Storage, dispatch-permit,
worker-preflight, deferred-foundation, and compatibility-route boundaries
without reading customer content. It also exports and verifies the normalized
`public`/`private` schema under the pinned client image.

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
