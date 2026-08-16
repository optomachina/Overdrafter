#!/usr/bin/env bash

set -euo pipefail

readonly OVD373_EXPECTED_PROJECT_REF="ozuatdcakezjtevztjlr"
readonly OVD373_EXPECTED_CLI_VERSION="2.78.1"
readonly OVD373_LOCK_CONTAINER="ovd373-production-deployment-lock"
readonly OVD373_LOCK_READY_MESSAGE="OVD-373 deployment locks acquired."
readonly OVD373_REPAIR_VERSIONS=(
  "20260402100000"
  "20260403103000"
  "20260406000000"
  "20260408193000"
  "20260731015400"
)
readonly OVD373_PUSH_MIGRATION_VERSIONS=(
  "20260330144838"
  "20260331000000"
  "20260331000001"
  "20260331010000"
  "20260402120000"
  "20260405103000"
  "20260408120000"
  "20260409000000"
  "20260514120000"
  "20260514120100"
  "20260725090000"
  "20260728190000"
  "20260731015300"
  "20260815090000"
  "20260815093000"
  "20260815100000"
  "20260815184740"
  "20260816011204"
  "20260816015000"
  "20260816015500"
)

require_environment_variable() {
  local variable_name="$1"
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Required environment variable is missing: ${variable_name}" >&2
    exit 1
  fi
}

require_private_file() {
  local file_path="$1"
  local label="$2"
  if [[ ! -f "$file_path" || -L "$file_path" ]]; then
    echo "${label} must be a regular, non-symlink file." >&2
    exit 1
  fi
  if [[ "$(stat -f '%Lp' "$file_path")" != "600" ]]; then
    echo "${label} must have mode 0600." >&2
    exit 1
  fi
}

cleanup_lock_holder() {
  docker rm --force "$OVD373_LOCK_CONTAINER" >/dev/null 2>&1 || true
}

lock_holder_is_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$OVD373_LOCK_CONTAINER" 2>/dev/null)" = "true" ]]
}

OVD373_UPGRADE_SUCCEEDED=0
OVD373_REPAIRS_ATTEMPTED=0
OVD373_PUSH_ADMISSION_MARKER=""

list_applied_repair_versions() {
  docker run --rm --entrypoint psql \
    --env PGPASSFILE=/run/secrets/production.pgpass \
    --env PGSSLMODE=verify-full \
    --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
    --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
    "$OVD361_DB_CLIENT_IMAGE" "$OVD373_POOLER_URL" \
    --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align \
    --command "select version::text from supabase_migrations.schema_migrations where version::text = any (array['20260402100000','20260403103000','20260406000000','20260408193000','20260731015400']) order by array_position(array['20260402100000','20260403103000','20260406000000','20260408193000','20260731015400'], version::text);"
}

list_applied_push_versions() {
  local quoted_versions=""
  local separator=""
  local version
  for version in "${OVD373_PUSH_MIGRATION_VERSIONS[@]}"; do
    quoted_versions+="${separator}'${version}'"
    separator=","
  done

  bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
    docker run --rm --entrypoint psql \
      --env PGPASSFILE=/run/secrets/production.pgpass \
      --env PGSSLMODE=verify-full \
      --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
      --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
      --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
      "$OVD361_DB_CLIENT_IMAGE" "$OVD373_POOLER_URL" \
      --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align \
      --command "with baseline as (select count(*) as row_count, pg_catalog.md5(pg_catalog.string_agg(version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text), E'\\n' order by version::text)) as fingerprint from supabase_migrations.schema_migrations where version::text <> all (array[${quoted_versions}])), output as (select 0 as ordinal, 'baseline:' || row_count::text || ':' || coalesce(fingerprint, '<none>') as value from baseline union all select 1 + array_position(array[${quoted_versions}], version::text) as ordinal, version::text as value from supabase_migrations.schema_migrations where version::text = any (array[${quoted_versions}])) select value from output order by ordinal;"
}

recover_pre_push_repairs() {
  local applied_output
  local applied_repairs=()
  local repair_version

  if ! lock_holder_is_running; then
    echo "Deployment locks are absent; refusing repair-ledger recovery writes." >&2
    return 1
  fi

  if ! applied_output="$(list_applied_repair_versions)"; then
    echo "Could not inspect the hosted repair ledger; stop for incident review." >&2
    return 1
  fi

  while IFS= read -r repair_version; do
    if [[ -n "$repair_version" ]]; then
      case "$repair_version" in
        20260402100000|20260403103000|20260406000000|20260408193000|20260731015400)
          applied_repairs+=("$repair_version")
          ;;
        *)
          echo "Unexpected repair version in hosted ledger: $repair_version" >&2
          return 1
          ;;
      esac
    fi
  done <<< "$applied_output"

  for ((index=${#applied_repairs[@]} - 1; index >= 0; index -= 1)); do
    bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
      supabase migration repair --db-url "$OVD373_POOLER_URL" \
      --status reverted --yes "${applied_repairs[$index]}" || return 1
  done

  lock_holder_is_running || return 1
  run_production_sql scripts/verify-ovd372-production-preconditions.sql || return 1
  run_production_sql scripts/verify-ovd373-rollout-preconditions.sql || return 1
  lock_holder_is_running || return 1
}

cleanup_upgrade() {
  local exit_status=$?
  local applied_prefix=""
  trap - EXIT INT TERM
  set +e

  if [[ "$OVD373_UPGRADE_SUCCEEDED" -ne 1 && "$OVD373_REPAIRS_ATTEMPTED" -eq 1 ]]; then
    if [[ -n "$OVD373_PUSH_ADMISSION_MARKER" && -d "$OVD373_PUSH_ADMISSION_MARKER" ]]; then
      if ! lock_holder_is_running; then
        echo "Deployment locks were lost after push admission; refusing recovery writes." >&2
        echo "OVD-373 requires incident review before any recovery action." >&2
      elif ! applied_prefix="$(list_applied_push_versions | node scripts/verify-ovd373-applied-prefix.mjs)"; then
        echo "OVD-373 could not prove the applied migration prefix; refusing recovery writes." >&2
      elif [[ "$applied_prefix" = "zero" ]]; then
        if ! run_production_sql scripts/verify-ovd373-repaired-ledger.sql \
          || ! recover_pre_push_repairs; then
          echo "OVD-373 could not prove zero-prefix repair recovery; incident review is required." >&2
        fi
      else
        echo "OVD-373 detected an applied migration ${applied_prefix}; preserving repair rows for the reviewed resume path." >&2
      fi
    elif ! recover_pre_push_repairs; then
      echo "OVD-373 could not prove repair-only recovery; incident review is required." >&2
    fi
  fi

  cleanup_lock_holder
  if [[ "$OVD373_UPGRADE_SUCCEEDED" -ne 1 ]]; then
    echo "OVD-373 governed production upgrade stopped; every rollout gate remains off." >&2
  fi
  exit "$exit_status"
}

require_lock_holder() {
  if ! lock_holder_is_running; then
    echo "OVD-373 deployment lock holder is not running." >&2
    exit 1
  fi
}

run_production_sql() {
  local sql_file="$1"
  bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
    docker run --rm --entrypoint psql \
      --env PGPASSFILE=/run/secrets/production.pgpass \
      --env PGSSLMODE=verify-full \
      --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
      --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
      --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
      --volume "$PWD:/workspace:ro" \
      "$OVD361_DB_CLIENT_IMAGE" "$OVD373_POOLER_URL" \
      --no-psqlrc --set ON_ERROR_STOP=1 \
      --file "/workspace/${sql_file}"
}

for variable_name in \
  OVD361_PROJECT_REF \
  OVD361_DEPLOY_COMMIT \
  OVD361_BACKUP_DIR \
  OVD361_DB_CLIENT_IMAGE \
  OVD361_PRODUCTION_PGPASS_FILE \
  OVD361_PRODUCTION_CA_FILE \
  OVD361_BILLING_DISABLED_ENV_FILE; do
  require_environment_variable "$variable_name"
done

if [[ "$OVD361_PROJECT_REF" != "$OVD373_EXPECTED_PROJECT_REF" ]]; then
  echo "OVD-373 refuses a non-production project ref." >&2
  exit 1
fi

require_private_file "$OVD361_PRODUCTION_PGPASS_FILE" "Production pgpass file"
require_private_file "$OVD361_PRODUCTION_CA_FILE" "Production CA file"
require_private_file "$OVD361_BILLING_DISABLED_ENV_FILE" "Billing-disabled env file"
if [[ ! -d "$OVD361_BACKUP_DIR" || -L "$OVD361_BACKUP_DIR" ]]; then
  echo "Backup directory must be an existing, non-symlink directory." >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$OVD361_BACKUP_DIR")" != "700" ]]; then
  echo "Backup directory must have mode 0700." >&2
  exit 1
fi
OVD373_PUSH_ADMISSION_MARKER="$OVD361_BACKUP_DIR/.ovd373-db-push-admitted"
if [[ -e "$OVD373_PUSH_ADMISSION_MARKER" || -L "$OVD373_PUSH_ADMISSION_MARKER" ]]; then
  echo "Push admission marker must not exist before the governed upgrade." >&2
  exit 1
fi
if [[ "$(tr -d '\r\n' < "$OVD361_BILLING_DISABLED_ENV_FILE")" != "BILLING_SELF_SERVICE_ENABLED=false" ]]; then
  echo "Billing-disabled env file must contain only BILLING_SELF_SERVICE_ENABLED=false." >&2
  exit 1
fi

test "$(git rev-parse HEAD)" = "$OVD361_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
test "$(supabase --version | awk '{print $NF}')" = "$OVD373_EXPECTED_CLI_VERSION"
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$OVD361_PROJECT_REF"
test "$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml | head -1)" = "$OVD361_PROJECT_REF"
node scripts/verify-ovd373-database-target.mjs
npm run verify:ovd372-head

readonly OVD373_POOLER_URL="$(tr -d '\r\n' < supabase/.temp/pooler-url)"
export PGPASSFILE="$OVD361_PRODUCTION_PGPASS_FILE"
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$OVD361_PRODUCTION_CA_FILE"

supabase secrets set \
  --env-file "$OVD361_BILLING_DISABLED_ENV_FILE" \
  --project-ref "$OVD361_PROJECT_REF"
node scripts/verify-ovd373-billing-disabled.mjs

test -z "$(docker ps --all --quiet --filter name=^/${OVD373_LOCK_CONTAINER}$)"
trap cleanup_upgrade EXIT
trap 'exit 130' INT TERM

docker run --detach \
  --name "$OVD373_LOCK_CONTAINER" \
  --entrypoint psql \
  --env PGPASSFILE=/run/secrets/production.pgpass \
  --env PGSSLMODE=verify-full \
  --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
  --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
  --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
  --volume "$PWD:/workspace:ro" \
  "$OVD361_DB_CLIENT_IMAGE" "$OVD373_POOLER_URL" \
  --no-psqlrc --set ON_ERROR_STOP=1 \
  --file /workspace/scripts/hold-ovd373-production-locks.sql >/dev/null

for attempt in {1..60}; do
  require_lock_holder
  if docker logs "$OVD373_LOCK_CONTAINER" 2>&1 | grep --fixed-strings --quiet "$OVD373_LOCK_READY_MESSAGE"; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    echo "OVD-373 deployment locks were not acquired within 60 seconds." >&2
    exit 1
  fi
  sleep 1
done

run_production_sql scripts/verify-ovd373-rollout-preconditions.sql
run_production_sql scripts/verify-ovd372-production-preconditions.sql

for repair_version in "${OVD373_REPAIR_VERSIONS[@]}"; do
  require_lock_holder
  OVD373_REPAIRS_ATTEMPTED=1
  bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
    supabase migration repair --db-url "$OVD373_POOLER_URL" \
    --status applied --yes "$repair_version"
done

require_lock_holder
run_production_sql scripts/verify-ovd373-repaired-ledger.sql

# Re-prove every immutable input immediately before the dry-run and push.
test "$(git rev-parse HEAD)" = "$OVD361_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
test "$(supabase --version | awk '{print $NF}')" = "$OVD373_EXPECTED_CLI_VERSION"
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$OVD361_PROJECT_REF"
node scripts/verify-ovd373-database-target.mjs
npm run verify:ovd372-head
run_production_sql scripts/verify-ovd373-rollout-preconditions.sql
node scripts/verify-ovd373-billing-disabled.mjs
require_lock_holder

readonly OVD373_FINAL_DRY_RUN="$OVD361_BACKUP_DIR/db-push-final-dry-run.txt"
supabase db push --db-url "$OVD373_POOLER_URL" \
  --include-all --dry-run >"$OVD373_FINAL_DRY_RUN" 2>&1
node scripts/verify-ovd373-deployment-plan.mjs \
  --dry-run-file "$OVD373_FINAL_DRY_RUN" \
  --repair-versions 20260402100000,20260403103000,20260406000000,20260408193000,20260731015400

# Close the final dry-run-to-push gap by re-proving every mutable boundary.
test "$(git rev-parse HEAD)" = "$OVD361_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
test "$(supabase --version | awk '{print $NF}')" = "$OVD373_EXPECTED_CLI_VERSION"
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$OVD361_PROJECT_REF"
node scripts/verify-ovd373-database-target.mjs
npm run verify:ovd372-head
run_production_sql scripts/verify-ovd373-repaired-ledger.sql
run_production_sql scripts/verify-ovd373-rollout-preconditions.sql
node scripts/verify-ovd373-billing-disabled.mjs
require_lock_holder
bash scripts/run-ovd373-locked-command.sh \
  --admission-marker "$OVD373_PUSH_ADMISSION_MARKER" \
  "$OVD373_LOCK_CONTAINER" \
  supabase db push --db-url "$OVD373_POOLER_URL" --include-all --yes

require_lock_holder
bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
  supabase migration list --db-url "$OVD373_POOLER_URL"
run_production_sql scripts/verify-ovd373-production-postconditions.sql

readonly OVD373_POST_PUSH_SCHEMA="$OVD361_BACKUP_DIR/post-push-app-schema.sql"
bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
  docker run --rm --entrypoint pg_dump \
    --env PGPASSFILE=/run/secrets/production.pgpass \
    --env PGSSLMODE=verify-full \
    --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
    --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
    --volume "$OVD361_BACKUP_DIR:/backup" \
    "$OVD361_DB_CLIENT_IMAGE" \
    --schema-only --no-owner --no-comments \
    --schema public --schema private \
    --dbname "$OVD373_POOLER_URL" \
    --file "/backup/$(basename "$OVD373_POST_PUSH_SCHEMA")"
bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
  node scripts/verify-ovd373-schema-fingerprint.mjs < "$OVD373_POST_PUSH_SCHEMA"
bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
  node scripts/verify-ovd373-billing-disabled.mjs

require_lock_holder
OVD373_UPGRADE_SUCCEEDED=1
echo "OVD-373 governed production upgrade completed successfully."
