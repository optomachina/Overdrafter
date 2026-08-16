#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly OVD373_EXPECTED_PROJECT_REF="ozuatdcakezjtevztjlr"
readonly OVD373_EXPECTED_CLI_VERSION="2.78.1"
readonly OVD373_LOCK_CONTAINER="ovd373-production-postaudit-lock"
readonly OVD373_LOCK_READY_MESSAGE="OVD-373 deployment locks acquired."
readonly OVD373_PSQL_ROLE_COMMAND='set role postgres'

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

lock_holder_is_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$OVD373_LOCK_CONTAINER" 2>/dev/null)" = "true" ]]
}

require_lock_holder() {
  if ! lock_holder_is_running; then
    echo "OVD-373 post-audit lock holder is not running." >&2
    exit 1
  fi
}

cleanup_lock_holder() {
  docker rm --force "$OVD373_LOCK_CONTAINER" >/dev/null 2>&1 || true
}

refresh_access() {
  require_lock_holder
  node scripts/manage-ovd373-temporary-db-access.mjs refresh
  node scripts/verify-ovd373-database-target.mjs
  node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240
  require_lock_holder
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
      --command "$OVD373_PSQL_ROLE_COMMAND" \
      --file "/workspace/${sql_file}"
}

for variable_name in \
  OVD361_PROJECT_REF \
  OVD361_DEPLOY_COMMIT \
  OVD361_POSTAUDIT_DIR \
  OVD361_DB_CLIENT_IMAGE \
  OVD361_PRODUCTION_PGPASS_FILE \
  OVD361_PRODUCTION_CA_FILE; do
  require_environment_variable "$variable_name"
done

if [[ "$OVD361_PROJECT_REF" != "$OVD373_EXPECTED_PROJECT_REF" ]]; then
  echo "OVD-373 refuses a non-production project ref." >&2
  exit 1
fi

require_private_file "$OVD361_PRODUCTION_PGPASS_FILE" "Production pgpass file"
require_private_file "$OVD361_PRODUCTION_CA_FILE" "Production CA file"
if [[ ! -d "$OVD361_POSTAUDIT_DIR" || -L "$OVD361_POSTAUDIT_DIR" ]]; then
  echo "Post-audit directory must be an existing, non-symlink directory." >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$OVD361_POSTAUDIT_DIR")" != "700" ]]; then
  echo "Post-audit directory must have mode 0700." >&2
  exit 1
fi

readonly OVD373_POSTAUDIT_SCHEMA="$OVD361_POSTAUDIT_DIR/hosted-app-schema.sql"
if [[ -e "$OVD373_POSTAUDIT_SCHEMA" || -L "$OVD373_POSTAUDIT_SCHEMA" ]]; then
  echo "Refusing to replace existing post-audit schema evidence." >&2
  exit 1
fi

[[ "$(git rev-parse HEAD)" == "$OVD361_DEPLOY_COMMIT" ]]
[[ -z "$(git status --porcelain)" ]]
[[ "$(supabase --version | awk '{print $NF}')" == "$OVD373_EXPECTED_CLI_VERSION" ]]
[[ "$(tr -d '\r\n' < supabase/.temp/project-ref)" == "$OVD361_PROJECT_REF" ]]
node scripts/verify-ovd373-database-target.mjs
node scripts/manage-ovd373-temporary-db-access.mjs assert-remaining 240

readonly OVD373_POOLER_URL="$(tr -d '\r\n' < supabase/.temp/pooler-url)"
export PGPASSFILE="$OVD361_PRODUCTION_PGPASS_FILE"
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$OVD361_PRODUCTION_CA_FILE"

[[ -z "$(docker ps --all --quiet --filter name=^/${OVD373_LOCK_CONTAINER}$)" ]]
trap cleanup_lock_holder EXIT
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
  --command "$OVD373_PSQL_ROLE_COMMAND" \
  --file /workspace/scripts/hold-ovd373-production-locks.sql >/dev/null

for attempt in {1..60}; do
  require_lock_holder
  if docker logs "$OVD373_LOCK_CONTAINER" 2>&1 | grep --fixed-strings --quiet "$OVD373_LOCK_READY_MESSAGE"; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    echo "OVD-373 post-audit locks were not acquired within 60 seconds." >&2
    exit 1
  fi
  sleep 1
done

run_production_sql scripts/verify-ovd373-rollout-preconditions.sql
run_production_sql scripts/verify-ovd373-temporary-role.sql
run_production_sql scripts/verify-ovd373-production-postconditions.sql
refresh_access

bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
  docker run --rm --entrypoint pg_dump \
    --env PGPASSFILE=/run/secrets/production.pgpass \
    --env PGSSLMODE=verify-full \
    --env PGSSLROOTCERT=/run/secrets/production-ca.crt \
    --volume "$OVD361_PRODUCTION_PGPASS_FILE:/run/secrets/production.pgpass:ro" \
    --volume "$OVD361_PRODUCTION_CA_FILE:/run/secrets/production-ca.crt:ro" \
    --volume "$OVD361_POSTAUDIT_DIR:/evidence" \
    "$OVD361_DB_CLIENT_IMAGE" \
    --schema-only --no-owner --no-comments --role postgres \
    --schema public --schema private --dbname "$OVD373_POOLER_URL" \
    --file /evidence/hosted-app-schema.sql

chmod 600 "$OVD373_POSTAUDIT_SCHEMA"
bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
  node scripts/verify-ovd373-schema-fingerprint.mjs < "$OVD373_POSTAUDIT_SCHEMA"
bash scripts/run-ovd373-locked-command.sh "$OVD373_LOCK_CONTAINER" \
  node scripts/verify-ovd373-billing-disabled.mjs
run_production_sql scripts/verify-ovd373-rollout-preconditions.sql
require_lock_holder

echo "OVD-373 production post-audit completed successfully."
