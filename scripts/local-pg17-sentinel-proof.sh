#!/usr/bin/env bash
# OVD-879 staging sentinel proof against a THROWAWAY local PostgreSQL 17.
#
# Starts a disposable cluster in a mktemp directory (unix socket only,
# listen_addresses=''), adds a minimal Supabase shim (anon/authenticated/
# service_role roles, auth.users/auth.sessions, auth.uid()/jwt()/role(),
# storage.buckets/objects, pgcrypto and uuid-ossp in extensions, Supabase's
# default privileges in public), applies every file in supabase/migrations, and
# then runs:
#   1  no overdrafter schema: the seed raises STAGING_SENTINEL_MISSING and the
#      row count of every user table (all non-system schemas) is unchanged
#   2  schema and table but no marker row: same raise, same zero writes
#   3  bootstrap-marker.sql, then the seed succeeds with the expected counts;
#      a second seed run leaves every count identical
#   4  inserting env = 'prod' into the marker fails its CHECK
#   5  as anon and as authenticated, selecting the marker is denied
#   6  the static tests (scripts/staging-sentinel.test.mjs, seed-staging.test.mjs)
# The seed is run the way scripts/seed-staging.mjs runs it: one psql
# --single-transaction run that first asserts the staging ref with set local, so
# the OVD-837 ref guard passes and only the sentinel decides.
#
# It never connects to any hosted database: libpq connection variables
# (PGHOST, PGHOSTADDR, PGSERVICE, PGPORT) must be unset, every psql call names
# the cluster's socket directory, and the cluster is stopped and deleted on exit.
#
#   bash scripts/local-pg17-sentinel-proof.sh
#
# Needs initdb, pg_ctl and psql from PostgreSQL 17 (PG_BIN overrides the
# directory) and node with the repo's dependencies installed (case 6).
set -euo pipefail

for var in PGHOST PGHOSTADDR PGSERVICE PGPORT; do
  if [[ -n "${!var:-}" ]]; then
    echo "sentinel-proof: refusing to run with $var set; unset every libpq connection variable" >&2
    exit 2
  fi
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
SEED="$ROOT/supabase/seed/staging.sql"
COUNTS="$ROOT/supabase/seed/staging-counts.sql"
BOOTSTRAP="$ROOT/supabase/staging/bootstrap-marker.sql"
STAGING_REF="ldmambwtksfvqdufhaam"
PORT=54879
for bin in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$bin" ]] || { echo "sentinel-proof: $PG_BIN/$bin not found; set PG_BIN" >&2; exit 2; }
done

WORK="$(mktemp -d)"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
  echo "cleanup: cluster stopped and $WORK deleted"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w \
  -o "-c listen_addresses='' -k $WORK -p $PORT" start >/dev/null

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
echo "cluster: $("${PSQL[@]}" -tA -c 'select version()')"
echo "cluster: unix socket $WORK port $PORT, listen_addresses='$("${PSQL[@]}" -tA -c 'show listen_addresses')' (disposable, deleted on exit)"

FAILURES=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }

# Supabase shim: only what the migrations and the seed reference.
"${PSQL[@]}" <<'SQL'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create schema storage;
create schema extensions;
alter database postgres set search_path = "$user", public, extensions;
set search_path = "$user", public, extensions;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges for objects postgres creates in public.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
  confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255),
  recovery_sent_at timestamptz, email_change_token_new varchar(255), email_change varchar(255),
  email_change_sent_at timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb,
  raw_user_meta_data jsonb, is_super_admin boolean, created_at timestamptz, updated_at timestamptz,
  phone text unique, phone_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz,
  is_sso_user boolean not null default false, is_anonymous boolean not null default false);
create table auth.sessions (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz, updated_at timestamptz, factor_id uuid, aal text, not_after timestamptz,
  refreshed_at timestamp, user_agent text, ip inet, tag text);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claim', true), ''),
                  nullif(pg_catalog.current_setting('request.jwt.claims', true), ''))::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
                  (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create table storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text,
  owner uuid, owner_id text, metadata jsonb, user_metadata jsonb, path_tokens text[], version text,
  created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (pg_catalog.string_to_array(name, '/'))[1:pg_catalog.array_length(pg_catalog.string_to_array(name, '/'), 1) - 1] $$;
create function storage.filename(name text) returns text language sql immutable as $$
  select (pg_catalog.string_to_array(name, '/'))[pg_catalog.array_length(pg_catalog.string_to_array(name, '/'), 1)] $$;
SQL

# Each migration in its own psql run, as the files are written (some use
# create index concurrently, which cannot run inside a transaction block).
migration_count=0
for migration in "$ROOT"/supabase/migrations/*.sql; do
  if ! "${PSQL[@]}" -f "$migration" >/dev/null 2>"$WORK/migration.err"; then
    echo "setup: migration failed: ${migration#"$ROOT"/}"
    head -5 "$WORK/migration.err"
    exit 1
  fi
  migration_count=$((migration_count + 1))
done
echo "setup: applied $migration_count migrations from supabase/migrations"

# Row count of every table in every non-system schema, one "schema.table n" line each.
snapshot() {
  "${PSQL[@]}" -tA -F ' ' <<'SQL'
select format('%I.%I', n.nspname, c.relname),
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from only %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg\_toast%'
  and n.nspname not like 'pg\_temp%'
order by 1;
SQL
}

# Rows inserted, updated or deleted in user tables since startup, committed or
# not (an aborted insert still counts), so a zero delta means the seed never
# attempted a write. A backend flushes its statistics as it exits, which can
# finish just after psql returns, hence the short wait. Case 3 is the control:
# the same counter must rise when the seed does write.
attempted_writes() {
  sleep 1
  "${PSQL[@]}" -tA -c "select pg_catalog.pg_stat_clear_snapshot();" \
    -c "select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from pg_catalog.pg_stat_user_tables;" | tail -1
}

# The runner's seed invocation (scripts/seed-staging.mjs psqlArgs).
run_seed() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres \
    --single-transaction -q -c "set local ovd837.seed_target_ref = '$STAGING_REF'" -f "$SEED" 2>&1
}

expect_sentinel_refusal() {
  local label="$1" before after writes_before writes_after output status
  before="$(snapshot)"
  writes_before="$(attempted_writes)"
  set +e
  output="$(run_seed)"
  status=$?
  set -e
  after="$(snapshot)"
  writes_after="$(attempted_writes)"
  echo "  seed exit $status: $(grep -m1 'ERROR' <<<"$output" || echo "$output" | head -1)" >&2
  echo "  user tables snapshotted: $(wc -l <<<"$before"), rows: $(awk '{s += $2} END {print s}' <<<"$before") before, $(awk '{s += $2} END {print s}' <<<"$after") after"
  echo "  attempted row writes (pg_stat_user_tables): $writes_before before, $writes_after after"
  if [[ $status -ne 0 ]] && grep -q 'STAGING_SENTINEL_MISSING' <<<"$output"; then
    pass "$label: seed raised STAGING_SENTINEL_MISSING"
  else
    fail "$label: seed did not raise STAGING_SENTINEL_MISSING"
  fi
  if [[ "$before" == "$after" ]]; then
    pass "$label: every user table row count identical before/after"
  else
    fail "$label: row counts changed"
    diff <(echo "$before") <(echo "$after") || true
  fi
  if [[ "$writes_before" == "$writes_after" ]]; then
    pass "$label: zero row writes attempted"
  else
    fail "$label: $((writes_after - writes_before)) row writes attempted"
  fi
}

echo
echo "== case 1: no overdrafter schema"
"${PSQL[@]}" -tA -c "select 'overdrafter schema present: ' || exists (select 1 from pg_namespace where nspname = 'overdrafter')"
expect_sentinel_refusal "case 1"

echo
echo "== case 2: schema and table, no marker row"
"${PSQL[@]}" <<'SQL'
create schema overdrafter;
create table overdrafter.environment_marker (
  env text primary key check (env = 'staging'),
  created_at timestamptz not null default now());
SQL
"${PSQL[@]}" -tA -c "select 'marker rows: ' || count(*) from overdrafter.environment_marker"
expect_sentinel_refusal "case 2"
"${PSQL[@]}" -c "drop schema overdrafter cascade"

echo
echo "== case 3: bootstrap, then seed twice"
"${PSQL[@]}" -f "$BOOTSTRAP"
"${PSQL[@]}" -f "$BOOTSTRAP"
"${PSQL[@]}" -tA -c "select 'marker rows after two bootstraps: ' || string_agg(env, ',') || ' (' || count(*) || ')' from overdrafter.environment_marker"
writes_before_seed="$(attempted_writes)"
set +e
first_output="$(run_seed)"
first_status=$?
set -e
first_counts="$("${PSQL[@]}" -tA -F ' | ' -f "$COUNTS")"
first_snapshot="$(snapshot)"
writes_after_seed="$(attempted_writes)"
echo "  seed run 1 exit $first_status${first_output:+: $first_output}"
echo "  attempted row writes (pg_stat_user_tables): $writes_before_seed before, $writes_after_seed after"
echo "  staging-counts.sql after run 1 (table | total | fixture):"
sed 's/^/    /' <<<"$first_counts"
vendor_count="$("${PSQL[@]}" -tA -c "select count(*) from unnest(enum_range(null::public.vendor_name))")"
expected_counts="auth.users 3 3
public.organizations 2 2
public.organization_memberships 3 3
public.jobs 3 3
public.organization_file_blobs 4 4
public.job_files 4 4
public.parts 3 3
public.approved_part_requirements 3 3
public.quote_requests 4 4
public.quote_runs 4 4
public.vendor_quote_results 9 9
vendor_quote_results with fixtureSanity 8 8
private.provider_kill_switches $vendor_count $vendor_count
private.provider_global_kill_switch 1 1"
actual_counts="$(awk -F ' \\| ' 'NR <= 15 && $1 !~ /engaged$/ {print $1, $2, $3}' <<<"$first_counts")"
if [[ $first_status -eq 0 ]]; then pass "case 3: seed succeeded after bootstrap"; else fail "case 3: seed failed after bootstrap"; fi
if [[ $writes_after_seed -gt $writes_before_seed ]]; then
  pass "case 3: write counter control: the seed's writes are visible ($((writes_after_seed - writes_before_seed)) rows)"
else
  fail "case 3: write counter control: the seed's writes were not counted"
fi
if [[ "$actual_counts" == "$expected_counts" ]]; then
  pass "case 3: seeded counts match the expected fixture counts ($vendor_count kill switches)"
else
  fail "case 3: seeded counts differ from expected"
  diff <(echo "$expected_counts") <(echo "$actual_counts") || true
fi
trigger_rows="$(awk -F ' \\| ' 'NR > 15 && $3 == 0 {print $1}' <<<"$first_counts")"
if [[ -z "$trigger_rows" ]]; then pass "case 3: every trigger-derived table has fixture rows"; else fail "case 3: no trigger rows in: $trigger_rows"; fi
set +e
second_output="$(run_seed)"
second_status=$?
set -e
second_counts="$("${PSQL[@]}" -tA -F ' | ' -f "$COUNTS")"
second_snapshot="$(snapshot)"
echo "  seed run 2 exit $second_status${second_output:+: $second_output}"
if [[ $second_status -eq 0 && "$first_counts" == "$second_counts" ]]; then
  pass "case 3: second seed run idempotent (staging-counts.sql identical)"
else
  fail "case 3: second seed run changed staging-counts.sql or failed"
  diff <(echo "$first_counts") <(echo "$second_counts") || true
fi
if [[ "$first_snapshot" == "$second_snapshot" ]]; then
  pass "case 3: second seed run left every user table row count identical ($(wc -l <<<"$first_snapshot") tables)"
else
  fail "case 3: second seed run changed user table row counts"
  diff <(echo "$first_snapshot") <(echo "$second_snapshot") || true
fi

echo
echo "== case 4: env = 'prod' violates the CHECK"
set +e
prod_output="$("${PSQL[@]}" -c "insert into overdrafter.environment_marker (env) values ('prod')" 2>&1)"
prod_status=$?
set -e
echo "  $prod_output"
if [[ $prod_status -ne 0 ]] && grep -q 'violates check constraint "environment_marker_env_check"' <<<"$prod_output"; then
  pass "case 4: insert env='prod' rejected by environment_marker_env_check"
else
  fail "case 4: insert env='prod' was not rejected by the CHECK"
fi
"${PSQL[@]}" -tA -c "select 'marker rows: ' || string_agg(env, ',') from overdrafter.environment_marker"

echo
echo "== case 5: API roles cannot read the marker"
"${PSQL[@]}" -tA -c "select 'rls enabled: ' || relrowsecurity || ', policies: ' || (select count(*) from pg_policies where schemaname = 'overdrafter') from pg_class where oid = 'overdrafter.environment_marker'::regclass"
for role in anon authenticated; do
  set +e
  role_output="$("${PSQL[@]}" -c "set role $role" -c "select env from overdrafter.environment_marker" 2>&1)"
  role_status=$?
  set -e
  echo "  $role: $role_output"
  if [[ $role_status -ne 0 ]] && grep -q 'permission denied' <<<"$role_output"; then
    pass "case 5: select as $role denied"
  else
    fail "case 5: select as $role was not denied"
  fi
  # Table-level revoke on its own: grant schema usage inside a transaction that
  # is never committed (ON_ERROR_STOP ends the session, which rolls it back).
  set +e
  table_output="$("${PSQL[@]}" -c "begin" -c "grant usage on schema overdrafter to $role" -c "set role $role" \
    -c "select env from overdrafter.environment_marker" 2>&1)"
  table_status=$?
  set -e
  echo "  $role with schema usage: $(head -1 <<<"$table_output")"
  if [[ $table_status -ne 0 ]] && grep -q 'permission denied for table environment_marker' <<<"$table_output"; then
    pass "case 5: select as $role denied by the table revoke even with schema usage"
  else
    fail "case 5: select as $role with schema usage was not denied by the table revoke"
  fi
done
if [[ "$("${PSQL[@]}" -tA -c "select has_schema_privilege('anon', 'overdrafter', 'usage') or has_schema_privilege('authenticated', 'overdrafter', 'usage')")" == "f" ]]; then
  pass "case 5: temporary schema usage grants rolled back"
else
  fail "case 5: a temporary schema usage grant persisted"
fi

echo
echo "== case 6: static tests"
set +e
VITEST_BIN="$ROOT/node_modules/.bin/vitest"
if [[ ! -x "$VITEST_BIN" ]]; then echo "FAIL case 6: $VITEST_BIN missing; run npm ci first" >&2; exit 1; fi
(cd "$ROOT" && "$VITEST_BIN" run --maxWorkers=2 scripts/staging-sentinel.test.mjs scripts/seed-staging.test.mjs 2>&1) | tee "$WORK/vitest.out" | grep -E '✓|✗|×|Test Files|Tests '
vitest_status=${PIPESTATUS[0]}
set -e
if [[ $vitest_status -eq 0 ]]; then pass "case 6: static tests"; else fail "case 6: static tests (vitest exit $vitest_status)"; fi

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "RESULT: PASS (all six cases)"
else
  echo "RESULT: FAIL ($FAILURES checks failed)"
  exit 1
fi
