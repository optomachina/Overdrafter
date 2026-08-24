#!/usr/bin/env bash

# Local-only disposable qualification; this is never a deployment command.
set -euo pipefail
set -o noclobber
umask 077
export PGSSLMODE=disable

readonly OVD417_SOURCE_SHA='5c3b6864e63ada75561f4ff7019bde70962d6e39'
readonly OVD417_BASELINE_HEAD='20260817054500'
readonly OVD417_BASELINE_FINGERPRINT='5dabebda8a0fc1a3cf697e00de64418b'
readonly OVD417_INJECTED_VERSION='20260818000000'
readonly OVD417_SUPABASE_CLI_VERSION='2.78.1'
readonly OVD417_DB_CLIENT_IMAGE='public.ecr.aws/supabase/postgres@sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144'
readonly OVD417_FILES=(
  '20260817133902_add_quote_provider_admission_registry.sql'
  '20260821223849_add_emachineshop_manual_vendor.sql'
  '20260821223851_configure_emachineshop_manual_vendor.sql'
  '20260822213330_add_vendor_quote_offer_geographic_origin.sql'
)
readonly OVD417_HASHES=(
  '331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b'
  '0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0'
  '18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09'
  '65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86'
)

fail() {
  local failure_message="$*"
  echo "OVD-417 qualification stopped: $failure_message" >&2
  exit 1
}
require() {
  local variable_name="$1"
  [[ -n "${!variable_name:-}" ]] || fail "missing environment variable $variable_name"
}
regular_file() {
  local file_path="$1"
  local file_label="$2"
  [[ -f "$file_path" && ! -L "$file_path" ]] || fail "$file_label must be a regular non-symlink file"
}
directory() {
  local directory_path="$1"
  local directory_label="$2"
  [[ -d "$directory_path" && ! -L "$directory_path" ]] || fail "$directory_label must be an existing non-symlink directory"
}
empty_directory() {
  local directory_path="$1"
  local directory_label="$2"
  node - "$directory_path" "$directory_label" <<'NODE'
const { readdirSync } = require('node:fs');
const [directory, label] = process.argv.slice(2);
if (readdirSync(directory).length !== 0) throw new Error(`${label} must be empty`);
NODE
}

assert_disposable_url() {
  local database_url="$1"
  local database_label="$2"
  node - "$database_url" "$database_label" <<'NODE'
const [value, label] = process.argv.slice(2);
const url = new URL(value);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${label} must be loopback-only PostgreSQL`);
if (url.search || url.hash) throw new Error(`${label} must not contain connection query or fragment parameters`);
if (!/^\/ovd417_[A-Za-z0-9_]+$/.test(url.pathname)) throw new Error(`${label} database name must be an unescaped ovd417_ identifier`);
NODE
}

assert_distinct_database_urls() {
  local -a database_urls=("$@")
  node - "${database_urls[@]}" <<'NODE'
const values = process.argv.slice(2);
const keys = values.map((value) => {
  const url = new URL(value);
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname;
  return `${host}:${url.port || '5432'}${url.pathname}`;
});
if (new Set(keys).size !== keys.length) throw new Error('clean, recovery, and restored databases must be pairwise distinct');
NODE
}

verify_tool_versions() {
  local actual_supabase_version
  actual_supabase_version="$(supabase --version)"
  [[ "$actual_supabase_version" = "$OVD417_SUPABASE_CLI_VERSION" ]] || fail "Supabase CLI must be exactly $OVD417_SUPABASE_CLI_VERSION; found $actual_supabase_version"
}

docker_db_url() {
  local database_url="$1"
  node - "$database_url" <<'NODE'
const url = new URL(process.argv[2]);
url.hostname = 'host.docker.internal';
process.stdout.write(url.toString());
NODE
}

docker_superuser_db_url() {
  local database_url="$1"
  node - "$database_url" <<'NODE'
const url = new URL(process.argv[2]);
url.hostname = 'host.docker.internal';
url.username = 'supabase_admin';
process.stdout.write(url.toString());
NODE
}

db_psql() {
  local database_url="$1"
  shift
  local -a psql_arguments=("$@")
  docker run --rm --interactive --entrypoint psql "$OVD417_DB_CLIENT_IMAGE" \
    "$(docker_db_url "$database_url")" --no-psqlrc "${psql_arguments[@]}"
}

db_dump() {
  local database_url="$1"
  shift
  local -a dump_arguments=("$@")
  docker run --rm --entrypoint pg_dump "$OVD417_DB_CLIENT_IMAGE" \
    --dbname "$(docker_db_url "$database_url")" "${dump_arguments[@]}"
}

db_superuser_psql() {
  local database_url="$1"
  shift
  local -a psql_arguments=("$@")
  docker run --rm --interactive --entrypoint psql "$OVD417_DB_CLIENT_IMAGE" \
    "$(docker_superuser_db_url "$database_url")" --no-psqlrc "${psql_arguments[@]}"
}

verify_frozen_source_and_hashes() {
  git cat-file -e "${OVD417_SOURCE_SHA}^{commit}"
  git merge-base --is-ancestor "$OVD417_SOURCE_SHA" HEAD
  local index actual
  for index in "${!OVD417_FILES[@]}"; do
    actual="$(shasum -a 256 "supabase/migrations/${OVD417_FILES[$index]}" | awk '{print $1}')"
    [[ "$actual" = "${OVD417_HASHES[$index]}" ]] || fail "reviewed migration hash drifted: ${OVD417_FILES[$index]}"
    cmp --silent "supabase/migrations/${OVD417_FILES[$index]}" "$OVD417_TEMP_PROJECT_DIR/supabase/migrations/${OVD417_FILES[$index]}" || fail "temporary project migration drifted: ${OVD417_FILES[$index]}"
  done
}

ledger_evidence() {
  local database_url="$1"
  local evidence_output="$2"
  db_psql "$database_url" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "with package(version,sha256) as (values ('20260817133902','331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b'),('20260821223849','0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0'),('20260821223851','18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09'),('20260822213330','65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86')), baseline as (select count(*) count,max(version::text) head,pg_catalog.md5(pg_catalog.string_agg(version::text||':'||pg_catalog.md5(pg_catalog.to_json(statements)::text),E'\\n' order by version::text)) fingerprint from supabase_migrations.schema_migrations where version::text <= '${OVD417_BASELINE_HEAD}'), ledger as (select count(*) count,max(version::text) head,pg_catalog.md5(pg_catalog.string_agg(version::text||':'||pg_catalog.md5(pg_catalog.to_json(statements)::text),E'\\n' order by version::text)) fingerprint from supabase_migrations.schema_migrations) select json_build_object('sourceSha','${OVD417_SOURCE_SHA}','migrationHashes',(select json_agg(json_build_object('version',version,'sha256',sha256) order by version) from package),'baselineCount',baseline.count,'baselineHead',baseline.head,'baselineFingerprint',baseline.fingerprint,'packageVersions',(select coalesce(json_agg(version::text order by version::text),'[]'::json) from supabase_migrations.schema_migrations where version::text = any(array['20260817133902','20260821223849','20260821223851','20260822213330'])),'unexpectedVersionCount',(select count(*) from supabase_migrations.schema_migrations where version::text > '${OVD417_BASELINE_HEAD}' and version::text <> all(array['20260817133902','20260821223849','20260821223851','20260822213330'])),'ledgerCount',ledger.count,'ledgerHead',ledger.head,'ledgerFingerprint',ledger.fingerprint) from baseline cross join ledger;" > "$evidence_output"
}

assert_zero_customer_aggregates() {
  local database_url="$1"
  local evidence_label="$2"
  local evidence_output="$OVD417_EVIDENCE_DIR/${evidence_label}-sanitized-aggregate-counts.txt"
  db_psql "$database_url" --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator='|' --command "select 'auth.users',count(*) from auth.users union all select 'storage.objects',count(*) from storage.objects union all select 'public.organizations',count(*) from public.organizations union all select 'public.jobs',count(*) from public.jobs union all select 'public.quote_requests',count(*) from public.quote_requests union all select 'public.vendor_quote_offers',count(*) from public.vendor_quote_offers order by 1;" > "$evidence_output"
  if rg --quiet '\|[1-9][0-9]*$' "$evidence_output"; then
    fail "$evidence_label has customer-row aggregate evidence"
  fi
}

run_qualification_pgtap() {
  local database_url="$1"
  local evidence_label="$2"
  supabase test db \
    supabase/tests/quote_provider_admission_registry.sql \
    supabase/tests/manual_quote_request_lifecycle.sql \
    supabase/tests/manual_quote_admin_inbox.sql \
    supabase/tests/vendor_quote_offer_geographic_origin.sql \
    --db-url "$database_url" --workdir "$PWD" > "$OVD417_EVIDENCE_DIR/$evidence_label-pgtap.txt"
}
dump_schema() {
  local database_url="$1"
  local output_path="$2"
  db_dump "$database_url" --schema-only --no-owner --no-comments --schema public --schema private > "$output_path"
}
dump_ledger() {
  local database_url="$1"
  local output_path="$2"
  db_dump "$database_url" --data-only --no-owner --no-comments --table supabase_migrations.schema_migrations > "$output_path"
}
compare() {
  local first_label="$1"
  local first_database_url="$2"
  local second_label="$3"
  local second_database_url="$4"
  dump_schema "$first_database_url" "$OVD417_EVIDENCE_DIR/$first_label-schema.sql"; dump_schema "$second_database_url" "$OVD417_EVIDENCE_DIR/$second_label-schema.sql"
  dump_ledger "$first_database_url" "$OVD417_EVIDENCE_DIR/$first_label-ledger.sql"; dump_ledger "$second_database_url" "$OVD417_EVIDENCE_DIR/$second_label-ledger.sql"
  node scripts/compare-ovd372-app-schema.mjs "$OVD417_EVIDENCE_DIR/$first_label-schema.sql" "$OVD417_EVIDENCE_DIR/$second_label-schema.sql"
  node scripts/compare-ovd372-app-schema.mjs "$OVD417_EVIDENCE_DIR/$first_label-ledger.sql" "$OVD417_EVIDENCE_DIR/$second_label-ledger.sql"
}
compare_ledger() {
  local first_label="$1"
  local second_label="$3"
  local second_database_url="$4"
  regular_file "$OVD417_EVIDENCE_DIR/$first_label-ledger.sql" "$first_label ledger evidence"
  dump_ledger "$second_database_url" "$OVD417_EVIDENCE_DIR/$second_label-ledger.sql"
  node scripts/compare-ovd372-app-schema.mjs "$OVD417_EVIDENCE_DIR/$first_label-ledger.sql" "$OVD417_EVIDENCE_DIR/$second_label-ledger.sql"
}

for variable in OVD417_CLEAN_DATABASE_URL OVD417_RECOVERY_DATABASE_URL OVD417_RESTORED_DATABASE_URL OVD417_TEMP_PROJECT_DIR OVD417_EVIDENCE_DIR; do require "$variable"; done
[[ "$#" = 0 ]] || fail 'environment-only command; no arguments accepted'
verify_tool_versions
directory "$OVD417_TEMP_PROJECT_DIR" 'temporary project copy'; directory "$OVD417_EVIDENCE_DIR" 'local evidence directory'; empty_directory "$OVD417_EVIDENCE_DIR" 'local evidence directory'
assert_disposable_url "$OVD417_CLEAN_DATABASE_URL" 'clean database'; assert_disposable_url "$OVD417_RECOVERY_DATABASE_URL" 'recovery database'; assert_disposable_url "$OVD417_RESTORED_DATABASE_URL" 'restored database'
assert_distinct_database_urls "$OVD417_CLEAN_DATABASE_URL" "$OVD417_RECOVERY_DATABASE_URL" "$OVD417_RESTORED_DATABASE_URL"

readonly OVD417_INJECTED_FAILURE_FILE="$OVD417_TEMP_PROJECT_DIR/supabase/migrations/${OVD417_INJECTED_VERSION}_injected_qualification_failure.sql"
[[ ! -e "$OVD417_INJECTED_FAILURE_FILE" && ! -L "$OVD417_INJECTED_FAILURE_FILE" ]] || fail 'injected failure path already exists'
trap 'rm -f -- "$OVD417_INJECTED_FAILURE_FILE"' EXIT INT TERM
verify_frozen_source_and_hashes

ledger_evidence "$OVD417_CLEAN_DATABASE_URL" "$OVD417_EVIDENCE_DIR/clean-baseline-ledger.json"
node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/clean-baseline-ledger.json" --require-state baseline
ledger_evidence "$OVD417_RECOVERY_DATABASE_URL" "$OVD417_EVIDENCE_DIR/recovery-baseline-ledger.json"
node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/recovery-baseline-ledger.json" --require-state baseline
ledger_evidence "$OVD417_RESTORED_DATABASE_URL" "$OVD417_EVIDENCE_DIR/restored-baseline-ledger.json"
node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/restored-baseline-ledger.json" --require-state baseline
assert_zero_customer_aggregates "$OVD417_CLEAN_DATABASE_URL" clean-baseline
assert_zero_customer_aggregates "$OVD417_RECOVERY_DATABASE_URL" recovery-baseline
assert_zero_customer_aggregates "$OVD417_RESTORED_DATABASE_URL" restored-baseline
supabase db push --db-url "$OVD417_CLEAN_DATABASE_URL" --include-all --dry-run --workdir "$OVD417_TEMP_PROJECT_DIR" --yes > "$OVD417_EVIDENCE_DIR/clean-dry-run.txt" 2>&1
node scripts/verify-ovd417-deployment-plan.mjs --dry-run-file "$OVD417_EVIDENCE_DIR/clean-dry-run.txt"
supabase db push --db-url "$OVD417_CLEAN_DATABASE_URL" --include-all --workdir "$OVD417_TEMP_PROJECT_DIR" --yes
ledger_evidence "$OVD417_CLEAN_DATABASE_URL" "$OVD417_EVIDENCE_DIR/clean-final-ledger.json"
node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/clean-final-ledger.json" --require-state final
db_psql "$OVD417_CLEAN_DATABASE_URL" --set ON_ERROR_STOP=1 < scripts/verify-ovd417-qualification-postconditions.sql
assert_zero_customer_aggregates "$OVD417_CLEAN_DATABASE_URL" clean
run_qualification_pgtap "$OVD417_CLEAN_DATABASE_URL" clean

ledger_evidence "$OVD417_RECOVERY_DATABASE_URL" "$OVD417_EVIDENCE_DIR/baseline-ledger.json"
node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/baseline-ledger.json" --require-state baseline
assert_zero_customer_aggregates "$OVD417_RECOVERY_DATABASE_URL" recovery-pre-injection
supabase db push --db-url "$OVD417_RECOVERY_DATABASE_URL" --include-all --dry-run --workdir "$OVD417_TEMP_PROJECT_DIR" --yes > "$OVD417_EVIDENCE_DIR/recovery-dry-run.txt" 2>&1
node scripts/verify-ovd417-deployment-plan.mjs --dry-run-file "$OVD417_EVIDENCE_DIR/recovery-dry-run.txt"

printf '%s\n' "raise exception 'OVD-417 injected local qualification failure';" > "$OVD417_INJECTED_FAILURE_FILE"
if supabase db push --db-url "$OVD417_RECOVERY_DATABASE_URL" --include-all --workdir "$OVD417_TEMP_PROJECT_DIR" --yes; then fail 'injected interruption unexpectedly completed'; fi
ledger_evidence "$OVD417_RECOVERY_DATABASE_URL" "$OVD417_EVIDENCE_DIR/partial-ledger.json"
node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/partial-ledger.json" --require-state partial-one
if node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/partial-ledger.json" --require-state final; then fail 'partial prefix incorrectly admitted worker promotion'; fi
rm -f -- "$OVD417_INJECTED_FAILURE_FILE"
verify_frozen_source_and_hashes

supabase db push --db-url "$OVD417_RECOVERY_DATABASE_URL" --include-all --workdir "$OVD417_TEMP_PROJECT_DIR" --yes
ledger_evidence "$OVD417_RECOVERY_DATABASE_URL" "$OVD417_EVIDENCE_DIR/recovered-ledger.json"
node scripts/verify-ovd417-applied-prefix.mjs --ledger-json "$OVD417_EVIDENCE_DIR/recovered-ledger.json" --require-state final
db_psql "$OVD417_RECOVERY_DATABASE_URL" --set ON_ERROR_STOP=1 < scripts/verify-ovd417-qualification-postconditions.sql
assert_zero_customer_aggregates "$OVD417_RECOVERY_DATABASE_URL" recovered
run_qualification_pgtap "$OVD417_RECOVERY_DATABASE_URL" recovered

db_dump "$OVD417_RECOVERY_DATABASE_URL" --schema-only --no-owner \
  --schema auth --schema storage --schema public --schema private --schema supabase_migrations \
  | node scripts/prepare-ovd373-schema-restore.mjs > "$OVD417_EVIDENCE_DIR/recovered-backup-schema.sql"
db_dump "$OVD417_RECOVERY_DATABASE_URL" --data-only --no-owner --no-comments \
  --schema auth --schema storage --schema public --schema private \
  --exclude-table=storage.buckets_vectors --exclude-table=storage.vector_indexes \
  > "$OVD417_EVIDENCE_DIR/recovered-data.sql"
db_dump "$OVD417_RECOVERY_DATABASE_URL" --data-only --no-owner --no-comments \
  --schema supabase_migrations > "$OVD417_EVIDENCE_DIR/recovered-ledger-data.sql"
db_superuser_psql "$OVD417_RESTORED_DATABASE_URL" --set ON_ERROR_STOP=1 --quiet \
  --command 'drop schema if exists auth cascade; drop schema if exists storage cascade; drop schema if exists public cascade; drop schema if exists private cascade; drop schema if exists supabase_migrations cascade;'
db_superuser_psql "$OVD417_RESTORED_DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 --quiet \
  --command 'set role postgres' --file - < "$OVD417_EVIDENCE_DIR/recovered-backup-schema.sql"
db_superuser_psql "$OVD417_RESTORED_DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 --quiet \
  --command 'set session_replication_role = replica' --file - < "$OVD417_EVIDENCE_DIR/recovered-data.sql"
db_superuser_psql "$OVD417_RESTORED_DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 --quiet \
  --command 'set session_replication_role = replica' --file - < "$OVD417_EVIDENCE_DIR/recovered-ledger-data.sql"
db_psql "$OVD417_RESTORED_DATABASE_URL" --set ON_ERROR_STOP=1 < scripts/verify-ovd417-qualification-postconditions.sql
assert_zero_customer_aggregates "$OVD417_RESTORED_DATABASE_URL" restored
run_qualification_pgtap "$OVD417_RESTORED_DATABASE_URL" restored
compare clean "$OVD417_CLEAN_DATABASE_URL" recovered "$OVD417_RECOVERY_DATABASE_URL"
compare_ledger recovered "$OVD417_RECOVERY_DATABASE_URL" restored "$OVD417_RESTORED_DATABASE_URL"
echo 'OVD-417 local four-migration qualification passed.'
