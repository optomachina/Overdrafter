#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly OVD418_EXPECTED_PROJECT_REF="ozuatdcakezjtevztjlr"
readonly OVD418_EXPECTED_CLI_VERSION="2.78.1"
readonly OVD418_EXPECTED_SOURCE_COMMIT="5c3b6864e63ada75561f4ff7019bde70962d6e39"
readonly OVD418_DB_CLIENT_IMAGE="public.ecr.aws/supabase/postgres@sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144"
readonly OVD418_LOCK_CONTAINER="ovd418-production-release-lock"
readonly OVD418_RESTORE_CONTAINER="ovd418-qualified-restore"
readonly OVD418_LOCK_READY_MESSAGE="OVD-418 production release locks acquired."
readonly OVD418_PSQL_ROLE_COMMAND="set role postgres"

OVD418_TEMP_ACCESS_ACTIVE=0
OVD418_LOCK_ACTIVE=0
OVD418_RESTORE_ACTIVE=0
OVD418_POOLER_URL=""

fail() {
  echo "OVD-418 production release stopped: $*" >&2
  exit 1
}

require_environment_variable() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "required environment variable is missing: ${name}"
}

require_absolute_path() {
  local value="$1"
  local label="$2"
  [[ "$value" = /* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "${label} must be an absolute single-line path"
}

require_outside_repository() {
  local file_path="$1"
  local label="$2"
  local resolved_path
  local repository_root
  local common_directory
  local main_worktree_root=""
  if [[ -e "$file_path" || -L "$file_path" ]]; then
    resolved_path="$(realpath "$file_path")"
  else
    resolved_path="$(realpath "$(dirname "$file_path")")/$(basename "$file_path")"
  fi
  repository_root="$(realpath "$(git rev-parse --show-toplevel)")"
  common_directory="$(git rev-parse --git-common-dir)"
  if [[ "$common_directory" != /* ]]; then
    common_directory="$repository_root/$common_directory"
  fi
  common_directory="$(realpath "$common_directory")"
  if [[ "$(basename "$common_directory")" = .git ]]; then
    main_worktree_root="$(dirname "$common_directory")"
  fi
  case "$resolved_path/" in
    "$repository_root/"*)
      fail "${label} must be outside the repository and linked main worktree"
      ;;
  esac
  if [[ -n "$main_worktree_root" ]]; then
    case "$resolved_path/" in
      "$main_worktree_root/"*)
        fail "${label} must be outside the repository and linked main worktree"
        ;;
    esac
  fi
}

file_mode() {
  stat -f '%Lp' "$1"
}

require_private_file() {
  local file_path="$1"
  local label="$2"
  [[ -f "$file_path" && ! -L "$file_path" ]] || fail "${label} must be a regular, non-symlink file"
  [[ "$(file_mode "$file_path")" = "600" ]] || fail "${label} must have mode 0600"
}

require_private_directory() {
  local directory="$1"
  local label="$2"
  [[ -d "$directory" && ! -L "$directory" ]] || fail "${label} must be a directory, not a symlink"
  [[ "$(file_mode "$directory")" = "700" ]] || fail "${label} must have mode 0700"
}

require_absent_path() {
  local file_path="$1"
  [[ ! -e "$file_path" && ! -L "$file_path" ]] || fail "refusing to replace existing evidence: ${file_path}"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$OVD418_RESTORE_ACTIVE" = 1 ]]; then
    if ! docker rm --force "$OVD418_RESTORE_CONTAINER" >/dev/null 2>&1; then
      echo "OVD-418 could not remove the disposable restore container." >&2
      status=1
    fi
  fi
  if [[ -n "${OVD418_EVIDENCE_DIR:-}" ]]; then
    rm -f -- "$OVD418_EVIDENCE_DIR/.restore-password" "$OVD418_EVIDENCE_DIR/.restore.pgpass" || status=1
  fi
  if [[ "$OVD418_LOCK_ACTIVE" = 1 ]]; then
    if ! docker rm --force "$OVD418_LOCK_CONTAINER" >/dev/null 2>&1; then
      echo "OVD-418 could not release the production lock container." >&2
      status=1
    fi
  fi
  if [[ "$OVD418_TEMP_ACCESS_ACTIVE" = 1 ]]; then
    if ! node scripts/manage-ovd373-temporary-db-access.mjs revoke >/dev/null 2>&1; then
      echo "OVD-418 could not confirm temporary credential revocation; incident review is required." >&2
      status=1
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "OVD-418 made no recovery assumption; preserve private evidence and stop for incident review." >&2
  fi
  exit "$status"
}

arm_cleanup() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

authorization_preflight() {
  require_environment_variable OVD418_AUTHORIZATION_FILE
  require_environment_variable OVD418_AUTHORIZATION_SHA256
  require_environment_variable OVD418_DEPLOY_COMMIT
  require_environment_variable OVD418_EVIDENCE_DIR
  require_environment_variable OVD361_PRODUCTION_PGPASS_FILE
  require_environment_variable OVD361_PRODUCTION_CA_FILE
  require_environment_variable OVD418_BILLING_DISABLED_ENV_FILE

  require_absolute_path "$OVD418_AUTHORIZATION_FILE" "authorization file"
  require_absolute_path "$OVD418_EVIDENCE_DIR" "evidence directory"
  require_absolute_path "$OVD361_PRODUCTION_PGPASS_FILE" "temporary pgpass"
  require_absolute_path "$OVD361_PRODUCTION_CA_FILE" "production CA"
  require_absolute_path "$OVD418_BILLING_DISABLED_ENV_FILE" "billing-disabled evidence"

  node scripts/verify-ovd418-production-authorization.mjs \
    --authorization-file "$OVD418_AUTHORIZATION_FILE" \
    --expected-sha256 "$OVD418_AUTHORIZATION_SHA256" \
    --expected-head "$OVD418_DEPLOY_COMMIT"

  [[ "$OVD418_DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "deploy commit is malformed"
  [[ "$(git rev-parse HEAD)" = "$OVD418_DEPLOY_COMMIT" ]] || fail "HEAD does not match the authorized deploy commit"
  [[ -z "$(git status --porcelain)" ]] || fail "authorized checkout is not clean"
  git merge-base --is-ancestor "$OVD418_EXPECTED_SOURCE_COMMIT" HEAD || fail "frozen OVD-417 source is not an ancestor"
  [[ "$(supabase --version | awk '{print $NF}')" = "$OVD418_EXPECTED_CLI_VERSION" ]] || fail "Supabase CLI version drifted"
  [[ "$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml | head -1)" = "$OVD418_EXPECTED_PROJECT_REF" ]] || fail "configured project identity drifted"
  [[ "$OVD418_DB_CLIENT_IMAGE" = "${OVD361_DB_CLIENT_IMAGE:-$OVD418_DB_CLIENT_IMAGE}" ]] || fail "database client image drifted"
  require_private_file "$OVD418_AUTHORIZATION_FILE" "production authorization"
  require_private_file "$OVD361_PRODUCTION_CA_FILE" "production CA"
  require_private_file "$OVD418_BILLING_DISABLED_ENV_FILE" "billing-disabled evidence"
  require_outside_repository "$OVD418_AUTHORIZATION_FILE" "production authorization"
  require_outside_repository "$OVD418_EVIDENCE_DIR" "evidence directory"
  require_outside_repository "$OVD361_PRODUCTION_PGPASS_FILE" "temporary production pgpass"
  require_outside_repository "$OVD361_PRODUCTION_CA_FILE" "production CA"
  require_outside_repository "$OVD418_BILLING_DISABLED_ENV_FILE" "billing-disabled evidence"
  [[ "$(tr -d '\r\n' < "$OVD418_BILLING_DISABLED_ENV_FILE")" = "BILLING_SELF_SERVICE_ENABLED=false" ]] || fail "billing-disabled evidence drifted"
  require_private_directory "$OVD418_EVIDENCE_DIR" "evidence directory"
  npm run verify:ovd417-head
}

authorization_usage_marker_path() {
  printf '%s.used' "$OVD418_AUTHORIZATION_FILE"
}

prepare_authorization_usage() {
  local usage_marker
  usage_marker="$(authorization_usage_marker_path)"
  if [[ "$OVD418_PHASE" = preaudit ]]; then
    require_absent_path "$usage_marker"
    (set -o noclobber; printf 'authorization_sha256=%s\ndeploy_commit=%s\nevidence_dir=%s\n' \
      "$OVD418_AUTHORIZATION_SHA256" "$OVD418_DEPLOY_COMMIT" "$OVD418_EVIDENCE_DIR" > "$usage_marker") || \
      fail "single-use authorization was already consumed"
    chmod 600 "$usage_marker"
  else
    require_private_file "$usage_marker" "single-use authorization marker"
    grep --fixed-strings --line-regexp --quiet "authorization_sha256=${OVD418_AUTHORIZATION_SHA256}" "$usage_marker" || fail "single-use authorization hash changed"
    grep --fixed-strings --line-regexp --quiet "deploy_commit=${OVD418_DEPLOY_COMMIT}" "$usage_marker" || fail "single-use authorization deploy commit changed"
    grep --fixed-strings --line-regexp --quiet "evidence_dir=${OVD418_EVIDENCE_DIR}" "$usage_marker" || fail "single-use authorization evidence directory changed"
  fi
}

verify_session_identity() {
  [[ "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$OVD418_EXPECTED_PROJECT_REF" ]] || fail "linked project ref drifted"
  node scripts/verify-ovd373-database-target.mjs
  node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
}

prepare_temporary_access() {
  node scripts/verify-ovd373-database-target.mjs --allow-permanent
  local expected_pgpass
  expected_pgpass="$(node scripts/manage-ovd373-temporary-db-access.mjs path)"
  [[ "$OVD361_PRODUCTION_PGPASS_FILE" = "$expected_pgpass" ]] || fail "temporary pgpass path is not the governed fixed path"
  node scripts/manage-ovd373-temporary-db-access.mjs grant
  OVD418_TEMP_ACCESS_ACTIVE=1
  verify_session_identity
  require_private_file "$OVD361_PRODUCTION_PGPASS_FILE" "temporary production pgpass"
  OVD418_POOLER_URL="$(tr -d '\r\n' < supabase/.temp/pooler-url)"
  export PGPASSFILE="$OVD361_PRODUCTION_PGPASS_FILE"
  export PGSSLMODE=verify-full
  export PGSSLROOTCERT="$OVD361_PRODUCTION_CA_FILE"
}

refresh_temporary_access() {
  require_lock_holder
  node scripts/manage-ovd373-temporary-db-access.mjs refresh
  verify_session_identity
  require_lock_holder
}

lock_holder_is_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$OVD418_LOCK_CONTAINER" 2>/dev/null)" = "true" ]]
}

require_lock_holder() {
  lock_holder_is_running || fail "production lock holder is not running"
}

acquire_release_locks() {
  [[ -z "$(docker ps --all --quiet --filter name=^/${OVD418_LOCK_CONTAINER}$)" ]] || fail "production lock container already exists"
  docker run --detach \
    --name "$OVD418_LOCK_CONTAINER" \
    --entrypoint psql \
    --env PGPASSFILE=/run/secrets/production.pgpass \
    --env PGSSLMODE=verify-full \
    --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --env 'PGOPTIONS=-c default_transaction_read_only=on' \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
    --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
    --volume "$PWD:/workspace:ro" \
    "$OVD418_DB_CLIENT_IMAGE" "$OVD418_POOLER_URL" \
    --no-psqlrc --set ON_ERROR_STOP=1 \
    --command "$OVD418_PSQL_ROLE_COMMAND" \
    --file /workspace/scripts/hold-ovd418-production-locks.sql >/dev/null
  OVD418_LOCK_ACTIVE=1

  local attempt
  for attempt in {1..60}; do
    require_lock_holder
    if docker logs "$OVD418_LOCK_CONTAINER" 2>&1 | grep --fixed-strings --quiet "$OVD418_LOCK_READY_MESSAGE"; then
      return
    fi
    [[ "$attempt" -lt 60 ]] || fail "production locks were not acquired within 60 seconds"
    sleep 1
  done
}

run_locked() {
  bash scripts/run-ovd373-locked-command.sh "$OVD418_LOCK_CONTAINER" "$@"
}

run_production_sql() {
  local sql_file="$1"
  local output_file="${2:-}"
  local command=(
    docker run --rm --entrypoint psql
    --env PGPASSFILE=/run/secrets/production.pgpass
    --env PGSSLMODE=verify-full
    --env PGSSLROOTCERT=/run/secrets/production-ca.crt
    --env 'PGOPTIONS=-c default_transaction_read_only=on'
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro"
    --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro"
    --volume "$PWD:/workspace:ro"
    "$OVD418_DB_CLIENT_IMAGE" "$OVD418_POOLER_URL"
    --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align
    --command "$OVD418_PSQL_ROLE_COMMAND"
    --file "/workspace/${sql_file}"
  )
  if [[ -n "$output_file" ]]; then
    require_absent_path "$output_file"
    run_locked "${command[@]}" > "$output_file"
    chmod 600 "$output_file"
  else
    run_locked "${command[@]}"
  fi
}

capture_ledger() {
  local output_file="$1"
  require_absent_path "$output_file"
  run_locked docker run --rm --entrypoint psql \
    --env PGPASSFILE=/run/secrets/production.pgpass \
    --env PGSSLMODE=verify-full \
    --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --env 'PGOPTIONS=-c default_transaction_read_only=on' \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
    --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
    "$OVD418_DB_CLIENT_IMAGE" "$OVD418_POOLER_URL" \
    --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --command "$OVD418_PSQL_ROLE_COMMAND" \
    --command "with package(version,sha256) as (values ('20260817133902','331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b'),('20260821223849','0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0'),('20260821223851','18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09'),('20260822213330','65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86')), baseline as (select count(*) count,max(version::text) head,pg_catalog.md5(pg_catalog.string_agg(version::text||':'||pg_catalog.md5(pg_catalog.to_json(statements)::text),E'\\n' order by version::text)) fingerprint from supabase_migrations.schema_migrations where version::text <= '20260817054500'), ledger as (select count(*) count,max(version::text) head,pg_catalog.md5(pg_catalog.string_agg(version::text||':'||pg_catalog.md5(pg_catalog.to_json(statements)::text),E'\\n' order by version::text)) fingerprint from supabase_migrations.schema_migrations) select json_build_object('sourceSha','5c3b6864e63ada75561f4ff7019bde70962d6e39','migrationHashes',(select json_agg(json_build_object('version',version,'sha256',sha256) order by version) from package),'baselineCount',baseline.count,'baselineHead',baseline.head,'baselineFingerprint',baseline.fingerprint,'packageVersions',(select coalesce(json_agg(version::text order by version::text),'[]'::json) from supabase_migrations.schema_migrations where version::text = any(array['20260817133902','20260821223849','20260821223851','20260822213330'])),'unexpectedVersionCount',(select count(*) from supabase_migrations.schema_migrations where version::text > '20260817054500' and version::text <> all(array['20260817133902','20260821223849','20260821223851','20260822213330'])),'ledgerCount',ledger.count,'ledgerHead',ledger.head,'ledgerFingerprint',ledger.fingerprint) from baseline cross join ledger;" > "$output_file"
  chmod 600 "$output_file"
}

classify_ledger() {
  local ledger_file="$1"
  local state
  for state in baseline partial-one final; do
    if node scripts/verify-ovd418-release-state.mjs --ledger-json "$ledger_file" --require-state "$state" >/dev/null 2>&1; then
      echo "$state"
      return
    fi
  done
  fail "ledger is not exact baseline, partial-one, or final; incident review is required"
}

verify_exact_dry_run() {
  local dry_run_file="$1"
  local state="$2"
  node - "$dry_run_file" "$state" <<'NODE'
const fs = require('node:fs');
const [file, state] = process.argv.slice(2);
const output = fs.readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*m/g, '').replaceAll('\r\n', '\n');
const expectedByState = {
  baseline: [
    '20260817133902_add_quote_provider_admission_registry.sql',
    '20260821223849_add_emachineshop_manual_vendor.sql',
    '20260821223851_configure_emachineshop_manual_vendor.sql',
    '20260822213330_add_vendor_quote_offer_geographic_origin.sql',
  ],
  'partial-one': [
    '20260821223849_add_emachineshop_manual_vendor.sql',
    '20260821223851_configure_emachineshop_manual_vendor.sql',
    '20260822213330_add_vendor_quote_offer_geographic_origin.sql',
  ],
};
const header = 'Would push these migrations:';
const lines = output.split('\n');
const start = lines.indexOf(header);
if (start < 0 || lines.filter((line) => line === header).length !== 1 || !expectedByState[state]) {
  throw new Error('dry-run must contain exactly one admitted apply-plan section');
}
const actual = [];
const migrationLineIndexes = [];
for (const [index, line] of lines.entries()) {
  if (/^ • \d{14}_[a-z0-9][a-z0-9_-]*\.sql$/.test(line)) migrationLineIndexes.push(index);
}
for (const line of lines.slice(start + 1)) {
  const match = /^ • (\d{14}_[a-z0-9][a-z0-9_-]*\.sql)$/.exec(line);
  if (match) actual.push(match[1]);
  else if (line !== '') break;
}
if (JSON.stringify(actual) !== JSON.stringify(expectedByState[state])) {
  throw new Error(`dry-run migration order drifted: ${actual.join(',')}`);
}
const expectedIndexes = actual.map((_name, index) => start + 1 + index);
if (JSON.stringify(migrationLineIndexes) !== JSON.stringify(expectedIndexes)) {
  throw new Error('dry-run contained migration entries outside the admitted plan section');
}
NODE
}

capture_and_verify_dry_runs() {
  local prefix="$1"
  local state="$2"
  local first="$OVD418_EVIDENCE_DIR/${prefix}-dry-run-1.txt"
  local second="$OVD418_EVIDENCE_DIR/${prefix}-dry-run-2.txt"
  require_absent_path "$first"
  require_absent_path "$second"
  refresh_temporary_access
  run_locked supabase db push --db-url "$OVD418_POOLER_URL" --include-all --dry-run --yes > "$first" 2>&1
  chmod 600 "$first"
  verify_exact_dry_run "$first" "$state"
  refresh_temporary_access
  run_locked supabase db push --db-url "$OVD418_POOLER_URL" --include-all --dry-run --yes > "$second" 2>&1
  chmod 600 "$second"
  verify_exact_dry_run "$second" "$state"
  cmp --silent "$first" "$second" || fail "the two exact dry-runs were not byte-identical"
}

verify_cloud_run_inventory() {
  require_environment_variable OVD418_CLOUD_RUN_INVENTORY_FILE
  require_absolute_path "$OVD418_CLOUD_RUN_INVENTORY_FILE" "Cloud Run execution inventory"
  require_private_file "$OVD418_CLOUD_RUN_INVENTORY_FILE" "Cloud Run execution inventory"
  require_outside_repository "$OVD418_CLOUD_RUN_INVENTORY_FILE" "Cloud Run execution inventory"
  node - "$OVD418_CLOUD_RUN_INVENTORY_FILE" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const capturedAt = Date.parse(value?.capturedAt);
const age = Date.now() - capturedAt;
if (value?.project !== 'overdrafter-worker-9133'
    || value?.region !== 'us-west1'
    || value?.job !== 'overdrafter-xometry-auth-probe'
    || !Number.isFinite(capturedAt)
    || age < -30_000
    || age > 600_000
    || !Array.isArray(value?.executions)) {
  throw new Error('Cloud Run inventory identity, freshness, or shape drifted');
}
for (const execution of value.executions) {
  const running = Number(execution?.status?.runningCount ?? 0);
  if (typeof execution?.metadata?.name !== 'string'
      || !execution.metadata.name
      || !execution?.status?.completionTime
      || !Number.isFinite(running)
      || running !== 0) {
    throw new Error('Cloud Run inventory contains an incomplete or running execution');
  }
}
NODE
}

write_session_marker() {
  local marker="$1"
  local state="$2"
  require_absent_path "$marker"
  printf 'authorization_sha256=%s\ndeploy_commit=%s\nstate=%s\n' \
    "$OVD418_AUTHORIZATION_SHA256" "$OVD418_DEPLOY_COMMIT" "$state" > "$marker"
  chmod 600 "$marker"
}

require_session_marker() {
  local marker="$1"
  require_private_file "$marker" "release session marker"
  grep --fixed-strings --line-regexp --quiet "authorization_sha256=${OVD418_AUTHORIZATION_SHA256}" "$marker" || fail "release authorization changed"
  grep --fixed-strings --line-regexp --quiet "deploy_commit=${OVD418_DEPLOY_COMMIT}" "$marker" || fail "release deploy commit changed"
}

next_attempt_directory() {
  local phase="$1"
  local index
  local candidate
  for index in {1..99}; do
    candidate="$OVD418_EVIDENCE_DIR/${phase}-attempt-${index}"
    if mkdir -m 700 -- "$candidate" 2>/dev/null; then
      echo "$candidate"
      return
    fi
    [[ -d "$candidate" && ! -L "$candidate" ]] || fail "unsafe attempt-evidence path: $candidate"
  done
  fail "no unused ${phase} evidence attempt remains"
}

capture_private_backup() {
  local roles="$OVD418_EVIDENCE_DIR/backup-roles.sql"
  local schema="$OVD418_EVIDENCE_DIR/backup-schema.sql"
  local data="$OVD418_EVIDENCE_DIR/backup-data.sql"
  local ledger="$OVD418_EVIDENCE_DIR/backup-ledger.sql"
  local counts="$OVD418_EVIDENCE_DIR/source-aggregate-counts.json"
  local file
  for file in "$roles" "$schema" "$data" "$ledger" "$counts"; do require_absent_path "$file"; done

  refresh_temporary_access
  run_locked docker run --rm --entrypoint pg_dumpall \
    --env PGPASSFILE=/run/secrets/production.pgpass --env PGSSLMODE=verify-full --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
    "$OVD418_DB_CLIENT_IMAGE" --roles-only --role postgres --quote-all-identifiers --no-role-passwords --no-comments --dbname "$OVD418_POOLER_URL" \
    | bash scripts/filter-ovd373-role-dump.sh > "$roles"
  refresh_temporary_access
  run_locked docker run --rm --entrypoint pg_dump \
    --env PGPASSFILE=/run/secrets/production.pgpass --env PGSSLMODE=verify-full --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
    "$OVD418_DB_CLIENT_IMAGE" --schema-only --no-owner --role postgres \
    --schema auth --schema storage --schema public --schema private --schema supabase_migrations --dbname "$OVD418_POOLER_URL" \
    | node scripts/prepare-ovd373-schema-restore.mjs > "$schema"
  refresh_temporary_access
  run_locked docker run --rm --entrypoint pg_dump \
    --env PGPASSFILE=/run/secrets/production.pgpass --env PGSSLMODE=verify-full --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" --volume "$OVD418_EVIDENCE_DIR:/evidence" \
    "$OVD418_DB_CLIENT_IMAGE" --data-only --role postgres --schema auth --schema storage --schema public --schema private \
    --exclude-table storage.buckets_vectors --exclude-table storage.vector_indexes --dbname "$OVD418_POOLER_URL" --file /evidence/backup-data.sql
  refresh_temporary_access
  run_locked docker run --rm --entrypoint pg_dump \
    --env PGPASSFILE=/run/secrets/production.pgpass --env PGSSLMODE=verify-full --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" --volume "$OVD418_EVIDENCE_DIR:/evidence" \
    "$OVD418_DB_CLIENT_IMAGE" --data-only --role postgres --schema supabase_migrations --dbname "$OVD418_POOLER_URL" --file /evidence/backup-ledger.sql
  run_production_sql scripts/verify-ovd418-production-preconditions.sql "$counts"
  chmod 600 "$roles" "$schema" "$data" "$ledger" "$counts"
  shasum -a 256 "$roles" "$schema" "$data" "$ledger" > "$OVD418_EVIDENCE_DIR/backup-sha256.txt"
  chmod 600 "$OVD418_EVIDENCE_DIR/backup-sha256.txt"
}

qualify_private_restore() {
  local password_file="$OVD418_EVIDENCE_DIR/.restore-password"
  local pgpass_file="$OVD418_EVIDENCE_DIR/.restore.pgpass"
  local restored_counts="$OVD418_EVIDENCE_DIR/restored-aggregate-counts.json"
  require_absent_path "$password_file"
  require_absent_path "$pgpass_file"
  require_absent_path "$restored_counts"
  [[ -z "$(docker ps --all --quiet --filter name=^/${OVD418_RESTORE_CONTAINER}$)" ]] || fail "restore container already exists"
  openssl rand -hex 32 > "$password_file"
  awk '{print "127.0.0.1:5432:*:supabase_admin:" $0}' "$password_file" > "$pgpass_file"
  chmod 600 "$password_file" "$pgpass_file"
  docker run --detach --name "$OVD418_RESTORE_CONTAINER" \
    --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password \
    --volume "$OVD418_EVIDENCE_DIR:/backup:ro" --volume "$PWD:/workspace:ro" \
    --volume "$password_file:/run/secrets/postgres-password:ro" --volume "$pgpass_file:/run/secrets/restore.pgpass:ro" \
    "$OVD418_DB_CLIENT_IMAGE" >/dev/null
  OVD418_RESTORE_ACTIVE=1
  local attempt
  for attempt in {1..60}; do
    if docker exec "$OVD418_RESTORE_CONTAINER" pg_isready --host 127.0.0.1 --username supabase_admin >/dev/null; then break; fi
    [[ "$attempt" -lt 60 ]] || fail "restore database did not become ready"
    sleep 1
  done
  docker exec --env PGPASSFILE=/run/secrets/restore.pgpass "$OVD418_RESTORE_CONTAINER" \
    createdb --host 127.0.0.1 --username supabase_admin --owner postgres ovd418_restore_verify
  docker exec --env PGPASSFILE=/run/secrets/restore.pgpass "$OVD418_RESTORE_CONTAINER" \
    psql --host 127.0.0.1 --username supabase_admin --dbname ovd418_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 --command 'drop schema public;'
  docker exec --env PGPASSFILE=/run/secrets/restore.pgpass "$OVD418_RESTORE_CONTAINER" \
    psql --host 127.0.0.1 --username supabase_admin --dbname ovd418_restore_verify --no-psqlrc --single-transaction --set ON_ERROR_STOP=1 \
    --file /backup/backup-roles.sql --command 'set role postgres' --file /backup/backup-schema.sql \
    --command 'set session_replication_role = replica' --file /backup/backup-data.sql --file /backup/backup-ledger.sql
  docker exec --env PGPASSFILE=/run/secrets/restore.pgpass "$OVD418_RESTORE_CONTAINER" \
    psql --host 127.0.0.1 --username supabase_admin --dbname ovd418_restore_verify --no-psqlrc --set ON_ERROR_STOP=1 \
    --quiet --tuples-only --no-align --file /workspace/scripts/verify-ovd418-production-preconditions.sql > "$restored_counts"
  chmod 600 "$restored_counts"
  cmp --silent "$OVD418_EVIDENCE_DIR/source-aggregate-counts.json" "$restored_counts" || fail "restored aggregate evidence differs from source"
  docker rm --force "$OVD418_RESTORE_CONTAINER" >/dev/null
  OVD418_RESTORE_ACTIVE=0
  rm -f -- "$password_file" "$pgpass_file"
}

verify_readaudit_files() {
  local output_directory="$1"
  local name
  for name in OVD418_CLIENT_READBACK_FILE OVD418_SECURITY_ADVISOR_FILE OVD418_PERFORMANCE_ADVISOR_FILE; do
    require_environment_variable "$name"
    require_absolute_path "${!name}" "$name"
    require_private_file "${!name}" "$name"
    require_outside_repository "${!name}" "$name"
  done
  node - "$OVD418_CLIENT_READBACK_FILE" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const capturedAt = Date.parse(value?.capturedAt);
const age = Date.now() - capturedAt;
const expected = [
  { resource: 'vendor_quote_offers', select: 'geographic_origin', limit: 0, status: 200 },
  { resource: 'vendor_capability_profiles', select: 'vendor_name,process_types,materials,domestic_us', limit: 0, status: 200 },
];
if (value?.projectRef !== 'ozuatdcakezjtevztjlr'
    || value?.method !== 'GET'
    || !Number.isFinite(capturedAt)
    || age < -30_000
    || age > 600_000
    || JSON.stringify(value?.queries) !== JSON.stringify(expected)) {
  throw new Error('read-only client schema-cache evidence drifted');
}
NODE
  node - "$OVD418_SECURITY_ADVISOR_FILE" "$OVD418_PERFORMANCE_ADVISOR_FILE" <<'NODE'
const fs = require('node:fs');
for (const file of process.argv.slice(2)) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const capturedAt = Date.parse(value?.capturedAt);
  const age = Date.now() - capturedAt;
  if (value?.projectRef !== 'ozuatdcakezjtevztjlr'
      || !Array.isArray(value?.findings)
      || !Number.isFinite(capturedAt)
      || age < -30_000
      || age > 600_000) {
    throw new Error('advisor evidence identity, freshness, or shape drifted');
  }
}
NODE
  shasum -a 256 "$OVD418_CLIENT_READBACK_FILE" "$OVD418_SECURITY_ADVISOR_FILE" "$OVD418_PERFORMANCE_ADVISOR_FILE" > "$output_directory/read-audit-sha256.txt"
  chmod 600 "$output_directory/read-audit-sha256.txt"
}

compare_offer_aggregates() {
  local before_file="$1"
  local after_file="$2"
  node - "$before_file" "$after_file" <<'NODE'
const fs = require('node:fs');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').trim());
const before = read(process.argv[2]);
const after = read(process.argv[3]);
if (!Number.isInteger(before.total_vendor_quote_offers)
    || before.total_vendor_quote_offers !== after.total_vendor_quote_offers
    || after.unknown_geographic_origin_offer_count !== after.total_vendor_quote_offers) {
  throw new Error('offer totals changed or an existing offer was not initialized to unknown provenance');
}
NODE
}

preaudit() {
  [[ -z "$(find "$OVD418_EVIDENCE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail "preaudit requires a new empty evidence directory"
  verify_cloud_run_inventory
  arm_cleanup
  prepare_temporary_access
  acquire_release_locks
  node scripts/verify-ovd373-billing-disabled.mjs
  local preconditions="$OVD418_EVIDENCE_DIR/preaudit-preconditions.json"
  run_production_sql scripts/verify-ovd418-production-preconditions.sql "$preconditions"
  local ledger="$OVD418_EVIDENCE_DIR/preaudit-ledger.json"
  capture_ledger "$ledger"
  local state
  state="$(classify_ledger "$ledger")"
  capture_private_backup
  qualify_private_restore
  if [[ "$state" != final ]]; then
    capture_and_verify_dry_runs preaudit "$state"
  fi
  write_session_marker "$OVD418_EVIDENCE_DIR/preaudit-complete.env" "$state"
  require_lock_holder
  echo "OVD-418 production preaudit passed for exact ${state} state; production remains unchanged."
}

apply_release() {
  local preaudit_marker="$OVD418_EVIDENCE_DIR/preaudit-complete.env"
  require_session_marker "$preaudit_marker"
  [[ ! -e "$OVD418_EVIDENCE_DIR/apply-complete.env" ]] || fail "release package was already applied"
  local preaudit_state
  preaudit_state="$(sed -n 's/^state=//p' "$preaudit_marker")"
  [[ "$preaudit_state" = baseline || "$preaudit_state" = partial-one ]] || fail "final state admits only post-audit"
  local attempt_directory
  attempt_directory="$(next_attempt_directory apply)"
  arm_cleanup
  prepare_temporary_access
  acquire_release_locks
  verify_cloud_run_inventory
  node scripts/verify-ovd373-billing-disabled.mjs
  run_production_sql scripts/verify-ovd418-production-preconditions.sql "$attempt_directory/preconditions.json"
  local ledger="$attempt_directory/ledger-before.json"
  capture_ledger "$ledger"
  local live_state
  live_state="$(classify_ledger "$ledger")"
  if [[ "$live_state" = final ]]; then
    run_production_sql scripts/verify-ovd418-production-postconditions.sql "$attempt_directory/observed-final-postconditions.json"
    compare_offer_aggregates "$OVD418_EVIDENCE_DIR/preaudit-preconditions.json" "$attempt_directory/observed-final-postconditions.json"
    write_session_marker "$OVD418_EVIDENCE_DIR/apply-complete.env" final
    echo "OVD-418 observed and verified the exact final state; use the post-audit command."
    return
  fi
  if [[ "$preaudit_state" = partial-one && "$live_state" != partial-one ]]; then
    fail "partial-one recovery state changed since preaudit"
  fi
  if [[ "$preaudit_state" = baseline && "$live_state" != baseline && "$live_state" != partial-one ]]; then
    fail "baseline release may resume only from exact partial-one"
  fi
  local attempt_relative="${attempt_directory#"$OVD418_EVIDENCE_DIR"/}"
  capture_and_verify_dry_runs "$attempt_relative/apply" "$live_state"
  refresh_temporary_access
  run_production_sql scripts/verify-ovd418-production-preconditions.sql "$attempt_directory/final-preconditions.json"
  require_lock_holder
  run_locked supabase db push --db-url "$OVD418_POOLER_URL" --include-all --yes
  local final_ledger="$attempt_directory/ledger-after.json"
  capture_ledger "$final_ledger"
  node scripts/verify-ovd418-release-state.mjs --ledger-json "$final_ledger" --require-state final
  run_production_sql scripts/verify-ovd418-production-postconditions.sql "$attempt_directory/postconditions.json"
  compare_offer_aggregates "$attempt_directory/final-preconditions.json" "$attempt_directory/postconditions.json"
  write_session_marker "$OVD418_EVIDENCE_DIR/apply-complete.env" final
  require_lock_holder
  echo "OVD-418 exact four-migration release reached the final ledger; worker promotion remains blocked pending post-audit."
}

postaudit() {
  local preaudit_marker="$OVD418_EVIDENCE_DIR/preaudit-complete.env"
  require_session_marker "$preaudit_marker"
  local preaudit_state
  preaudit_state="$(sed -n 's/^state=//p' "$preaudit_marker")"
  if [[ "$preaudit_state" != final ]]; then
    require_session_marker "$OVD418_EVIDENCE_DIR/apply-complete.env"
  fi
  require_absent_path "$OVD418_EVIDENCE_DIR/postaudit-complete.env"
  local attempt_directory
  attempt_directory="$(next_attempt_directory postaudit)"
  verify_readaudit_files "$attempt_directory"
  verify_cloud_run_inventory
  arm_cleanup
  prepare_temporary_access
  acquire_release_locks
  node scripts/verify-ovd373-billing-disabled.mjs
  local ledger="$attempt_directory/ledger.json"
  capture_ledger "$ledger"
  node scripts/verify-ovd418-release-state.mjs --ledger-json "$ledger" --require-state final
  run_production_sql scripts/verify-ovd418-production-postconditions.sql "$attempt_directory/postconditions.json"
  compare_offer_aggregates "$OVD418_EVIDENCE_DIR/preaudit-preconditions.json" "$attempt_directory/postconditions.json"
  run_locked docker run --rm --entrypoint pg_dump \
    --env PGPASSFILE=/run/secrets/production.pgpass --env PGSSLMODE=verify-full --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" --volume "$attempt_directory:/evidence" \
    "$OVD418_DB_CLIENT_IMAGE" --schema-only --no-owner --role postgres --schema public --schema private \
    --dbname "$OVD418_POOLER_URL" --file /evidence/postaudit-app-schema.sql
  chmod 600 "$attempt_directory/postaudit-app-schema.sql"
  shasum -a 256 "$attempt_directory/postaudit-app-schema.sql" > "$attempt_directory/postaudit-app-schema.sha256"
  chmod 600 "$attempt_directory/postaudit-app-schema.sha256"
  write_session_marker "$OVD418_EVIDENCE_DIR/postaudit-complete.env" final
  require_lock_holder
  echo "OVD-418 read-only production post-audit passed; no synthetic row or mutating RPC was used."
}

[[ "$#" = 1 ]] || fail "usage: bash scripts/run-ovd418-production-release.sh <preaudit|apply|postaudit>"
readonly OVD418_PHASE="$1"
authorization_preflight
prepare_authorization_usage
case "$OVD418_PHASE" in
  preaudit) preaudit ;;
  apply) apply_release ;;
  postaudit) postaudit ;;
  *) fail "unknown phase: $OVD418_PHASE" ;;
esac
