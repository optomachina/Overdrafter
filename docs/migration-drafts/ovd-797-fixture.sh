#!/usr/bin/env bash
# OVD-797 Jarvis channels fixture against a DISPOSABLE local Postgres.
#
# Starts a throwaway cluster in a temp directory (unix socket only, port
# 54797), adds minimal Supabase stubs (anon/authenticated/service_role roles,
# auth.users, auth.uid(), auth.jwt(), private.platform_admin_emails,
# public.is_platform_admin(), public.current_user_has_aal2(), pgTAP in the
# extensions schema), then:
#   DM-1   applies docs/migration-drafts/ovd-797-jarvis-channels.sql
#   DM-2..DM-11  runs supabase/tests/pending/ovd797_jarvis_channels.sql.pending
#   DM-3/DM-9    concurrent double inserts from two sessions leave one row
#   policy listing (pg_policies, table ACLs, guard ACL)
#   DM-1R  rollback -> pg_dump --schema-only diff against the pre-draft dump is
#          empty; re-apply, rollback, rollback again -> still empty
# It never connects to any hosted database and deletes the cluster on exit.
#
#   bash docs/migration-drafts/ovd-797-fixture.sh
#
# Needs initdb, pg_ctl, psql, pg_dump (PG_BIN overrides the directory) and
# pg_prove with the pgTAP extension installed for that Postgres.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DRAFT="$HERE/ovd-797-jarvis-channels.sql"
ROLLBACK="$HERE/ovd-797-jarvis-channels.rollback.sql"
TEST="$ROOT/supabase/tests/pending/ovd797_jarvis_channels.sql.pending"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }
command -v pg_prove >/dev/null || { echo "pg_prove not found" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w \
  -o "-c listen_addresses='' -k $WORK -p 54797" start >/dev/null

CONN=(-h "$WORK" -p 54797 -U postgres -d postgres)
PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 "${CONN[@]}")
echo "fixture: $("${PSQL[@]}" -tA -c 'select version()')"
echo "fixture: socket $WORK port 54797 (disposable, deleted on exit)"

# Stubs. migration_owner mirrors Supabase's postgres role: not a superuser,
# BYPASSRLS, and the owner of the draft's tables and function.
"${PSQL[@]}" <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role migration_owner nologin bypassrls;
create schema auth;
create schema private;
create schema extensions;
alter database postgres set search_path = "$user", public, extensions;
grant usage on schema auth, extensions to anon, authenticated, service_role, migration_owner;
grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to migration_owner;
create table auth.users (
  id uuid primary key, aud text, role text, email text, email_confirmed_at timestamptz);
grant references on auth.users to migration_owner;
create table private.platform_admin_emails (email text primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claim', true), ''),
                  nullif(pg_catalog.current_setting('request.jwt.claims', true), ''))::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
-- Bodies copied from supabase/migrations (20260325120000, 20260731015213).
create function public.is_platform_admin() returns boolean language sql stable
security definer set search_path = public, auth, private as $$
  select exists (
    select 1 from auth.users app_user
    join private.platform_admin_emails allowlist on lower(allowlist.email) = lower(app_user.email)
    where app_user.id = auth.uid()) $$;
create function public.current_user_has_aal2() returns boolean language sql stable
set search_path = pg_catalog as $$
  select auth.uid() is not null and coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;
revoke all on function public.is_platform_admin(), public.current_user_has_aal2() from public, anon;
grant execute on function public.is_platform_admin(), public.current_user_has_aal2()
  to authenticated, service_role, migration_owner;
create extension pgtap with schema extensions;
SQL

dump() { "$PG_BIN/pg_dump" --schema-only --no-owner --restrict-key=ovd797 "${CONN[@]}" -f "$1"; }
apply_draft() { { echo "set role migration_owner;"; cat "$DRAFT"; } | "${PSQL[@]}" --single-transaction; }
apply_rollback() { { echo "set role migration_owner;"; cat "$ROLLBACK"; } | "${PSQL[@]}" --single-transaction; }
dump_diff() {
  dump "$WORK/$1.sql"
  if diff -u "$WORK/pre.sql" "$WORK/$1.sql"; then
    echo "ok - DM-1R $2: pg_dump --schema-only diff is empty ($(wc -l <"$WORK/pre.sql") schema lines compared)"
  else
    echo "FAIL: DM-1R $2: schema differs from the pre-draft dump"; exit 1
  fi
}

dump "$WORK/pre.sql"

echo "== DM-1 apply draft"
apply_draft
echo "ok - DM-1 the draft applies cleanly to a fresh fixture"
"${PSQL[@]}" -tA -c "select 'tables: ' || count(*) || ', rls on: ' || count(*) filter (where relrowsecurity)
  from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'jarvis\_%'"

echo "== DM-2..DM-11 pgTAP (pending test staged without its suffix)"
mkdir "$WORK/tests"
cp "$TEST" "$WORK/tests/ovd797_jarvis_channels.sql"
PGHOST="$WORK" PGPORT=54797 PGUSER=postgres PGDATABASE=postgres \
  pg_prove --verbose --failures "$WORK/tests/ovd797_jarvis_channels.sql"

echo "== DM-3 / DM-9 concurrent double insert (two sessions)"
"${PSQL[@]}" <<'SQL'
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000797e01', 'ovd797-race@example.test');
SQL
race() {
  # $1 label, $2 INSERT ... ON CONFLICT DO NOTHING, $3 count query
  "${PSQL[@]}" -c "begin; $2; select pg_catalog.pg_sleep(2); commit;" >/dev/null &
  local first=$!
  sleep 0.5
  local t0 t1
  t0=$(date +%s.%N)
  "${PSQL[@]}" -c "$2" >/dev/null
  t1=$(date +%s.%N)
  wait "$first"
  local got
  got="$("${PSQL[@]}" -tA -c "$3")"
  local waited
  waited=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", b - a }')
  [ "$got" = "1" ] || { echo "FAIL: $1 left $got rows"; exit 1; }
  echo "ok - $1: second session waited ${waited}s on the first, then did nothing; rows = $got"
  # A plain concurrent duplicate (no ON CONFLICT) gets unique_violation.
  local plain="${2% on conflict*}"
  "${PSQL[@]}" -c "begin; delete from ${4}; $plain; select pg_catalog.pg_sleep(2); commit;" >/dev/null &
  first=$!
  sleep 0.5
  local out
  if out="$("${PSQL[@]}" -c "$plain" 2>&1)"; then echo "FAIL: $1 plain duplicate succeeded"; exit 1; fi
  wait "$first"
  case "$out" in *duplicate\ key*) echo "ok - $1: a plain concurrent duplicate is rejected (unique_violation)";;
    *) echo "FAIL: $1 wrong error: $out"; exit 1;; esac
  got="$("${PSQL[@]}" -tA -c "$3")"
  [ "$got" = "1" ] || { echo "FAIL: $1 left $got rows after plain race"; exit 1; }
}
race "DM-3 inbound (slack, Ev797race)" \
  "insert into public.jarvis_inbound_events (channel, idempotency_key) values ('slack', 'Ev797race') on conflict do nothing" \
  "select count(*) from public.jarvis_inbound_events where channel = 'slack' and idempotency_key = 'Ev797race'" \
  "public.jarvis_inbound_events where idempotency_key = 'Ev797race'"
race "DM-9 control (run ...e9, key race-1)" \
  "insert into public.jarvis_control_commands (graph_run_id, kind, actor_user_id, idempotency_key) values ('00000000-0000-4000-8000-0000007979e9', 'pause', '00000000-0000-4000-8000-000000797e01', 'race-1') on conflict do nothing" \
  "select count(*) from public.jarvis_control_commands where graph_run_id = '00000000-0000-4000-8000-0000007979e9' and idempotency_key = 'race-1'" \
  "public.jarvis_control_commands where idempotency_key = 'race-1'"

echo "== RLS policy listing"
"${PSQL[@]}" -P pager=off -c "select tablename, policyname, cmd, roles, qual
  from pg_policies where schemaname = 'public' and tablename like 'jarvis\_%' order by tablename, policyname"
"${PSQL[@]}" -P pager=off -c "select c.relname, c.relrowsecurity as rls, c.relacl
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'jarvis\_%'
  order by c.relname"
"${PSQL[@]}" -P pager=off -c "select p.oid::regprocedure as function, p.prosecdef as security_definer,
  p.proconfig, p.proacl from pg_proc p where p.proname like 'jarvis\_%'"

echo "== DM-1R rollback"
"${PSQL[@]}" -c "delete from auth.users where id = '00000000-0000-4000-8000-000000797e01'" >/dev/null
apply_rollback
dump_diff post-rollback "rollback after apply"
apply_draft
apply_rollback
apply_rollback
dump_diff post-rerollback "re-apply, rollback, rollback replay"
echo "fixture: PASS"
