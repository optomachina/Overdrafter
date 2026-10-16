#!/usr/bin/env bash
# OVD-831 agent API keys fixture against a DISPOSABLE local Postgres.
#
# Starts a throwaway cluster in a temp directory (unix socket only, port
# 54831), adds minimal Supabase stubs (anon/authenticated/service_role roles,
# auth.users, auth.uid(), auth.jwt(), private.platform_admin_emails,
# public.organizations, public.organization_memberships, public.app_role,
# public.user_can_access_org(), public.is_org_admin(),
# public.is_platform_admin(), public.current_user_has_aal2(), pgcrypto and
# pgTAP in the extensions schema), then:
#   K-0    applies docs/migration-drafts/ovd-831-agent-api-keys.sql
#   K-1..K-11  runs supabase/tests/pending/ovd831_agent_api_keys.sql.pending
#   revoke vs use race: a use holding FOR SHARE makes a concurrent revoke wait
#   policy listing (pg_policies, table/column ACLs, function ACLs)
#   DM-1R  rollback -> pg_dump --schema-only diff against the pre-draft dump is
#          empty; re-apply, rollback, rollback again -> still empty
# It never connects to any hosted database and deletes the cluster on exit.
#
#   bash docs/migration-drafts/ovd-831-fixture.sh
#
# Needs initdb, pg_ctl, psql, pg_dump (PG_BIN overrides the directory) and
# pg_prove with the pgTAP extension installed for that Postgres.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DRAFT="$HERE/ovd-831-agent-api-keys.sql"
ROLLBACK="$HERE/ovd-831-agent-api-keys.rollback.sql"
TEST="$ROOT/supabase/tests/pending/ovd831_agent_api_keys.sql.pending"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[[ -x "$PG_BIN/initdb" ]] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }
command -v pg_prove >/dev/null || { echo "pg_prove not found" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w \
  -o "-c listen_addresses='' -k $WORK -p 54831" start >/dev/null

CONN=(-h "$WORK" -p 54831 -U postgres -d postgres)
PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 "${CONN[@]}")
echo "fixture: $("${PSQL[@]}" -tA -c 'select version()')"
echo "fixture: socket $WORK port 54831 (disposable, deleted on exit)"

# Stubs. migration_owner mirrors Supabase's postgres role: not a superuser,
# BYPASSRLS, and the owner of the draft's tables and functions.
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
grant usage on schema private to migration_owner;
grant create on schema public, private to migration_owner;
create extension pgcrypto with schema extensions;
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
-- Shapes and bodies copied from supabase/migrations (20260303101500,
-- 20260303123000, 20260325120000, 20260731015213, 20261015074957).
create type public.app_role as enum ('client', 'internal_estimator', 'internal_admin');
create table public.organizations (
  id uuid primary key default gen_random_uuid(), name text not null, slug text not null unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null, created_at timestamptz not null default now(),
  unique (organization_id, user_id));
grant references on public.organizations to migration_owner;
grant select on public.organization_memberships to migration_owner;
create function public.user_can_access_org(p_organization_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id and membership.user_id = auth.uid()) $$;
create function public.is_org_admin(p_organization_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id and membership.user_id = auth.uid()
      and membership.role = 'internal_admin') $$;
create function public.is_platform_admin() returns boolean language sql stable
security definer set search_path = public, auth, private as $$
  select exists (
    select 1 from auth.users app_user
    join private.platform_admin_emails allowlist on lower(allowlist.email) = lower(app_user.email)
    where app_user.id = auth.uid()) $$;
create function public.current_user_has_aal2() returns boolean language sql stable
set search_path = pg_catalog as $$
  select auth.uid() is not null and coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;
revoke all on function public.is_platform_admin(), public.current_user_has_aal2(),
  public.user_can_access_org(uuid), public.is_org_admin(uuid) from public, anon;
grant execute on function public.is_platform_admin(), public.current_user_has_aal2(),
  public.user_can_access_org(uuid), public.is_org_admin(uuid)
  to authenticated, service_role, migration_owner;
create extension pgtap with schema extensions;
SQL

dump() {
  local out="$1"
  "$PG_BIN/pg_dump" --schema-only --no-owner --restrict-key=ovd831 "${CONN[@]}" -f "$out"
}
apply_draft() { { echo "set role migration_owner;"; cat "$DRAFT"; } | "${PSQL[@]}" --single-transaction; }
apply_rollback() { { echo "set role migration_owner;"; cat "$ROLLBACK"; } | "${PSQL[@]}" --single-transaction; }
dump_diff() {
  local name="$1" label="$2"
  dump "$WORK/$name.sql"
  if diff -u "$WORK/pre.sql" "$WORK/$name.sql"; then
    echo "ok - DM-1R $label: pg_dump --schema-only diff is empty ($(wc -l <"$WORK/pre.sql") schema lines compared)"
  else
    echo "FAIL: DM-1R $label: schema differs from the pre-draft dump" >&2; exit 1
  fi
}

dump "$WORK/pre.sql"

echo "== K-0 apply draft"
apply_draft
echo "ok - K-0 the draft applies cleanly to a fresh fixture"

echo "== K-1..K-11 pgTAP (pending test staged without its suffix)"
mkdir "$WORK/tests"
cp "$TEST" "$WORK/tests/ovd831_agent_api_keys.sql"
PGHOST="$WORK" PGPORT=54831 PGUSER=postgres PGDATABASE=postgres \
  pg_prove --verbose --failures "$WORK/tests/ovd831_agent_api_keys.sql"

echo "== revoke vs use race (two sessions)"
"${PSQL[@]}" <<'SQL'
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000831e01', 'ovd831-race@example.test');
insert into public.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000008310e0', 'race', 'ovd831-race');
insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-0000008310e0', '00000000-0000-4000-8000-000000831e01', 'client');
insert into public.agent_api_keys (id, org_id, created_by, name, key_prefix, key_hash, expires_at)
values ('00000000-0000-4000-8000-0000008311e9', '00000000-0000-4000-8000-0000008310e0',
        '00000000-0000-4000-8000-000000831e01', 'race', 'abababababababab', repeat('c', 64), now() + interval '1 day');
SQL
# Session 1 admits a use and holds its transaction for 2 s. Session 2's revoke
# must wait for it (FOR SHARE vs FOR UPDATE), and every later use is refused.
"${PSQL[@]}" -c "begin; set local role service_role;
  select public.api_service_admit_agent_api_key_use('00000000-0000-4000-8000-0000008311e9', 'quotes.read', 60, 10, 10);
  select pg_catalog.pg_sleep(2); commit;" >/dev/null &
first=$!
sleep 0.5
t0=$(date +%s.%N)
"${PSQL[@]}" -c "select private.agent_api_key_revoke('00000000-0000-4000-8000-0000008311e9', null, 'revoked')" >/dev/null
t1=$(date +%s.%N)
wait "$first"
waited=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", b - a }')
after="$("${PSQL[@]}" -tA -c "set role service_role; select public.api_service_admit_agent_api_key_use('00000000-0000-4000-8000-0000008311e9', 'quotes.read', 60, 10, 10) ->> 'result'")"
[[ "$after" = "revoked" ]] || { echo "FAIL: use after revoke returned $after" >&2; exit 1; }
echo "ok - revoke waited ${waited}s for the in-flight use, then the next use is refused: $after"
"${PSQL[@]}" -c "delete from public.organizations where id = '00000000-0000-4000-8000-0000008310e0';
  delete from auth.users where id = '00000000-0000-4000-8000-000000831e01'" >/dev/null

echo "== RLS policy and privilege listing"
"${PSQL[@]}" -P pager=off -c "select schemaname, tablename, policyname, cmd, roles, qual
  from pg_policies where tablename like 'agent\_api\_key%' order by 1, 2, 3"
"${PSQL[@]}" -P pager=off -c "select c.oid::regclass, c.relrowsecurity as rls, c.relforcerowsecurity as forced, c.relacl
  from pg_class c where c.relkind = 'r' and c.relname like 'agent\_api\_key%' order by 1"
"${PSQL[@]}" -P pager=off -c "select attname, attacl from pg_attribute
  where attrelid = 'public.agent_api_keys'::regclass and attnum > 0 and not attisdropped order by attnum"
"${PSQL[@]}" -P pager=off -c "select p.oid::regprocedure as function, p.prosecdef as definer, p.proconfig, p.proacl
  from pg_proc p where p.proname like '%agent\_api\_key%' order by 1::text"

echo "== DM-1R rollback"
apply_rollback
dump_diff post-rollback "rollback after apply"
apply_draft
apply_rollback
apply_rollback
dump_diff post-rerollback "re-apply, rollback, rollback replay"
echo "fixture: PASS"
