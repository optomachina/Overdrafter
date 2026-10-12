#!/usr/bin/env bash
# OVD-722 kill switch compare and set check against a DISPOSABLE local Postgres.
#
# Runs the switch tables and admin RPCs from docs/migration-drafts/ovd-722.sql
# (PHASE 1, from the first table through api_admin_list_provider_kill_switches)
# on a throwaway cluster in a temp directory, with minimal stubs for
# auth.uid() and public.is_platform_admin(). It never connects to any hosted
# database: it starts its own postgres on a unix socket and deletes it on exit.
#
#   bash docs/migration-drafts/ovd-722-race-check.sh
#
# Needs initdb, pg_ctl and psql (PG_BIN overrides the directory).
set -euo pipefail

DRAFT="${OVD722_DRAFT:-$(cd "$(dirname "$0")" && pwd)/ovd-722.sql}"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  id ovd722pg >/dev/null 2>&1 || useradd --system --no-create-home ovd722pg
  chown ovd722pg "$WORK"
  RUN_AS=(runuser -u ovd722pg --)
fi
"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w \
  -o "-c listen_addresses='' -k $WORK -p 54722" start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 54722 -U postgres -d postgres)

# Stubs. The migration role mirrors Supabase's postgres role: not a superuser,
# but BYPASSRLS, and the owner of every security definer function below.
"${PSQL[@]}" <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create role migration_owner nologin bypassrls;
create schema private authorization migration_owner;
create schema auth;
grant usage on schema private, auth to migration_owner;
grant create on schema public to migration_owner;
create type public.vendor_name as enum ('xometry', 'fictiv', 'quickparts', 'weerg', 'geomiq', 'rmfg');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(pg_catalog.current_setting('test.uid', true), '')::uuid $$;
create function public.is_platform_admin() returns boolean language sql stable as
  $$ select pg_catalog.current_setting('test.uid', true) like '00000000-0000-4000-8000-0000007220%' $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid(), public.is_platform_admin() to authenticated, migration_owner;
SQL

{
  echo "set role migration_owner;"
  awk '/^create table if not exists private.provider_kill_switches/{on=1} /^-- Periodic sweep/{on=0} on' "$DRAFT"
} | "${PSQL[@]}"

as_admin() {
  # $1 admin suffix, $2 SQL. Each call is its own session and transaction.
  "${PSQL[@]}" -tA -c "set role authenticated; set test.uid = '00000000-0000-4000-8000-0000007220$1'; $2"
}
expect_conflict() {
  local out
  if out="$(as_admin "$1" "$2" 2>&1)"; then
    echo "FAIL: expected kill_switch_version_conflict, got: $out"; exit 1
  fi
  case "$out" in *kill_switch_version_conflict*) ;; *) echo "FAIL: wrong error: $out"; exit 1;; esac
}
check() {
  local got
  got="$("${PSQL[@]}" -tA -c "$2")"
  [ "$got" = "$3" ] || { echo "FAIL: $1 (got '$got', want '$3')"; exit 1; }
  echo "ok - $1"
}
version_of() { "${PSQL[@]}" -tA -c "select version from private.provider_kill_switches where provider = '$1'"; }

# 1. Engage never needs a version; a release with no version is refused.
as_admin 01 "select public.api_admin_set_provider_kill_switch('fictiv', true, 'C&D drill engage one')" >/dev/null
check "engage without a version succeeds" \
  "select engaged::text || ':' || version from private.provider_kill_switches where provider = 'fictiv'" "true:1"
expect_conflict 01 "select public.api_admin_set_provider_kill_switch('fictiv', false, 'release with no version')"
check "a release without an expected version is refused" \
  "select engaged::text from private.provider_kill_switches where provider = 'fictiv'" "true"

# 2. Stale release (sequential): A decides to release at version 1, B
#    re-engages (version 2), then A's delayed release arrives.
STALE="$(version_of fictiv)"
as_admin 02 "select public.api_admin_set_provider_kill_switch('fictiv', true, 'C&D received, admin B')" >/dev/null
expect_conflict 01 "select public.api_admin_set_provider_kill_switch('fictiv', false, 'admin A stale release', $STALE)"
check "a stale release does not clear a newer engagement" \
  "select engaged::text || ':' || version || ':' || reason from private.provider_kill_switches where provider = 'fictiv'" \
  "true:2:C&D received, admin B"
check "the refused release wrote no audit row" \
  "select count(*) from private.provider_kill_switch_audit where reason = 'admin A stale release'" "0"

# 3. Stale release (concurrent): B's engage holds the row lock; A's release,
#    decided on the version B is about to replace, waits on the lock. After B
#    commits, A must see the new version and be refused.
STALE="$(version_of fictiv)"
"${PSQL[@]}" -c "begin; set local role authenticated;
  set local test.uid = '00000000-0000-4000-8000-000000722002';
  select public.api_admin_set_provider_kill_switch('fictiv', true, 'admin B engages under lock');
  select pg_catalog.pg_sleep(2); commit;" >/dev/null &
B_PID=$!
sleep 0.5
A_OUT="$WORK/a.out"
( as_admin 01 "select public.api_admin_set_provider_kill_switch('fictiv', false, 'admin A racing release', $STALE)" \
  >"$A_OUT" 2>&1; echo "exit=$?" >>"$A_OUT" ) &
A_PID=$!
wait "$B_PID"
wait "$A_PID" || true
grep -q kill_switch_version_conflict "$A_OUT" || { echo "FAIL: racing release was not refused:"; cat "$A_OUT"; exit 1; }
echo "ok - a release that waited on the lock behind an engage is refused"
check "the switch is still engaged by admin B" \
  "select engaged::text || ':' || reason from private.provider_kill_switches where provider = 'fictiv'" \
  "true:admin B engages under lock"

# 4. changedAt is taken after the lock wait: a release queued behind a
#    2 second lock holder records a time after the holder's own time.
CURRENT="$(version_of fictiv)"
"${PSQL[@]}" -c "begin; set local role authenticated;
  set local test.uid = '00000000-0000-4000-8000-000000722002';
  select public.api_admin_set_provider_kill_switch('fictiv', true, 'admin B holds the lock');
  select pg_catalog.pg_sleep(2); commit;" >/dev/null &
B_PID=$!
sleep 0.5
as_admin 01 "select public.api_admin_set_provider_kill_switch('fictiv', true, 'admin A engage after wait')" >/dev/null
wait "$B_PID"
check "changedAt is captured after the lock wait (at least 1s after the holder)" \
  "select (max(at) filter (where reason = 'admin A engage after wait')
          - max(at) filter (where reason = 'admin B holds the lock')) >= interval '1 second'
   from private.provider_kill_switch_audit" "t"
check "concurrent engages each bump the version" \
  "select version from private.provider_kill_switches where provider = 'fictiv'" "$((CURRENT + 2))"

# 5. A release with the current version succeeds.
CURRENT="$(version_of fictiv)"
as_admin 01 "select public.api_admin_set_provider_kill_switch('fictiv', false, 'release at the current version', $CURRENT)" >/dev/null
check "a release at the current version succeeds" \
  "select engaged::text from private.provider_kill_switches where provider = 'fictiv'" "false"

# 6. Global switch follows the same rule.
as_admin 01 "select public.api_admin_set_global_kill_switch(true, 'global brake drill one')" >/dev/null
G="$("${PSQL[@]}" -tA -c "select version from private.provider_global_kill_switch")"
as_admin 02 "select public.api_admin_set_global_kill_switch(true, 'global brake by admin B')" >/dev/null
expect_conflict 01 "select public.api_admin_set_global_kill_switch(false, 'stale global release', $G)"
check "a stale global release does not clear a newer global engagement" \
  "select engaged::text from private.provider_global_kill_switch" "true"

# 7. A missing provider row is materialized engaged, then locked.
"${PSQL[@]}" -c "delete from private.provider_kill_switches where provider = 'geomiq'"
expect_conflict 01 "select public.api_admin_set_provider_kill_switch('geomiq', false, 'release a missing row', 5)"
as_admin 01 "select public.api_admin_set_provider_kill_switch('geomiq', false, 'release a missing row', 0)" >/dev/null
check "a missing row can be released only at version 0" \
  "select engaged::text || ':' || version from private.provider_kill_switches where provider = 'geomiq'" "false:1"

# 8. Forced RLS with no policies: a role granted SELECT by mistake sees nothing.
"${PSQL[@]}" -c "grant usage on schema private to authenticated;
  grant select on private.provider_kill_switches to authenticated;" >/dev/null
check "forced RLS hides rows from a mistakenly granted role" \
  "set role authenticated; select count(*) from private.provider_kill_switches" "0"
check "RLS is enabled and forced on all three tables" \
  "select bool_and(relrowsecurity and relforcerowsecurity) from pg_catalog.pg_class
   where oid in ('private.provider_kill_switches'::regclass, 'private.provider_global_kill_switch'::regclass,
                 'private.provider_kill_switch_audit'::regclass)" "t"
check "the list RPC still reads every row through security definer" \
  "set role authenticated; set test.uid = '00000000-0000-4000-8000-000000722001';
   select jsonb_array_length(public.api_admin_list_provider_kill_switches() -> 'providers')" "6"

# 9. The sweep handles rows one at a time: a row level trigger exception on one
#    row skips that row (it stays queued) and never stops the other rows.
"${PSQL[@]}" <<'SQL'
create table public.work_queue (
  id uuid primary key, job_id uuid, quote_run_id uuid, task_type text, status text,
  payload jsonb, locked_at timestamptz, locked_by text, last_error text);
create table public.vendor_quote_results (id uuid primary key, status text, notes jsonb, raw_payload jsonb);
grant all on public.work_queue, public.vendor_quote_results to migration_owner;
create function public.ovd722_fence_stub() returns trigger language plpgsql as
  $$ begin raise exception 'free_quote_terminal_fenced' using errcode = 'P0001'; end $$;
create trigger ovd722_fence before update on public.vendor_quote_results
  for each row when (old.id = '00000000-0000-4000-8000-0000007229ff') execute function public.ovd722_fence_stub();
insert into public.work_queue (id, job_id, quote_run_id, task_type, status, payload) values
  ('00000000-0000-4000-8000-0000007228a1', '00000000-0000-4000-8000-0000007227a1', '00000000-0000-4000-8000-0000007226a1',
   'run_vendor_quote', 'queued', '{"vendor":"xometry","vendorQuoteResultId":"00000000-0000-4000-8000-0000007229a1"}'),
  ('00000000-0000-4000-8000-0000007228ff', '00000000-0000-4000-8000-0000007227a1', '00000000-0000-4000-8000-0000007226a1',
   'run_vendor_quote', 'queued', '{"vendor":"fictiv","vendorQuoteResultId":"00000000-0000-4000-8000-0000007229ff"}'),
  ('00000000-0000-4000-8000-0000007228a2', '00000000-0000-4000-8000-0000007227a2', '00000000-0000-4000-8000-0000007226a2',
   'run_vendor_quote', 'queued', '{"vendor":"weerg","vendorQuoteResultId":"00000000-0000-4000-8000-0000007229a2"}');
insert into public.vendor_quote_results (id, status) values
  ('00000000-0000-4000-8000-0000007229a1', 'queued'),
  ('00000000-0000-4000-8000-0000007229ff', 'queued'),
  ('00000000-0000-4000-8000-0000007229a2', 'queued');
SQL
{
  echo "set role migration_owner;"
  awk '/^-- Periodic sweep/{on=1} /^-- PHASE 2 ENFORCE/{on=0} on' "$DRAFT"
} | "${PSQL[@]}"
SWEEP="$("${PSQL[@]}" -tA -c "set role service_role; select public.api_worker_cancel_provider_disabled_tasks()")"
echo "$SWEEP" | grep -q '"cancelled": 2' || { echo "FAIL: sweep result: $SWEEP"; exit 1; }
echo "$SWEEP" | grep -q '"skipped": 1' || { echo "FAIL: sweep result: $SWEEP"; exit 1; }
echo "ok - one failing row is skipped and the other rows are cancelled ($SWEEP)"
check "the skipped row stays queued, with its lane untouched" \
  "select (select status from public.work_queue where id = '00000000-0000-4000-8000-0000007228ff')
     || ':' || (select status from public.vendor_quote_results where id = '00000000-0000-4000-8000-0000007229ff')" "queued:queued"
check "the other rows are cancelled and their lanes end failed" \
  "select count(*) from public.work_queue q join public.vendor_quote_results r
     on r.id = (q.payload ->> 'vendorQuoteResultId')::uuid
   where q.status = 'cancelled' and r.status = 'failed'" "2"

echo "ovd-722 race check: all passed"
