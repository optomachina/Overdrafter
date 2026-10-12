#!/usr/bin/env bash
# Window 1 restore drill. Disposable and local only; no network host.
#
# Proves the README's backup step end to end on synthetic data:
#   "production" = a socket only cluster with the Supabase shim, every main
#   migration and synthetic rows; it is dumped the way `supabase db dump` does
#   (application schemas as schema.sql, data with COPY as data.sql, roles
#   excluded, storage policies via storage-policies.sql), counted with smoke-counts.sql and inventoried; then
#   scripts/window-1/restore-check.mjs restores the dump into a second, empty
#   socket only cluster and must pass.
# Usage: bash scripts/window-1/restore-drill.sh   (needs local PostgreSQL binaries)
set -euo pipefail
cd "$(dirname "$0")/../.."

bin="${OVD_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}"
work="$(mktemp -d /tmp/w1drill.XXXXXX)"
chmod 755 "$work"
as_owner=()
if [ "$(id -u)" = 0 ]; then chown postgres "$work"; as_owner=(runuser -u postgres --); fi

cleanup() {
  for c in prod target; do
    [ -d "$work/$c" ] && "${as_owner[@]}" "$bin/pg_ctl" -D "$work/$c" -m fast -w stop >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

start() {
  "${as_owner[@]}" mkdir -p "$work/$1.s"
  "${as_owner[@]}" "$bin/initdb" -D "$work/$1" -U postgres -A trust --no-sync -E UTF8 --locale=C.UTF-8 >/dev/null
  "${as_owner[@]}" "$bin/pg_ctl" -D "$work/$1" -l "$work/$1.log" -w \
    -o "-c listen_addresses='' -c unix_socket_directories=$work/$1.s -c fsync=off" start >/dev/null
  [ "$("$bin/psql" -X -At -h "$work/$1.s" -U postgres -d postgres -c 'show listen_addresses')" = "" ]
}
q() { local c="$1"; shift; "$bin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/$c.s" -U postgres -d postgres "$@"; }

start prod
start target
for c in prod target; do
  q "$c" -f scripts/window-1/supabase-shim.sql
  q "$c" -c 'alter database postgres set search_path = "$user", public, extensions'
done

for f in supabase/migrations/*.sql; do
  if grep -qiE 'concurrently|^\s*(begin|commit)\s*;' "$f"; then q prod -f "$f" >/dev/null; else q prod -1 -f "$f" >/dev/null; fi
done

# Synthetic rows only.
q prod <<'SQL'
insert into auth.users (id, aud, role, email)
select gen_random_uuid(), 'authenticated', 'authenticated', 'drill' || g || '@example.invalid'
from generate_series(1, 5) g;
insert into public.organizations (name, slug)
select 'Drill org ' || g, 'drill-org-' || g from generate_series(1, 3) g;
SQL

dump="$work/dump"
mkdir -p "$dump"
apps=(-n public -n private -n engineering_private)
"$bin/pg_dump" -h "$work/prod.s" -U postgres -d postgres --schema-only "${apps[@]}" -f "$dump/schema.sql"
"$bin/pg_dump" -h "$work/prod.s" -U postgres -d postgres --data-only "${apps[@]}" -n auth -n storage -f "$dump/data.sql"
"$bin/psql" -X -A -t -q -h "$work/prod.s" -U postgres -d postgres -f scripts/window-1/smoke-counts.sql > "$dump/counts.prod.json"
"$bin/psql" -X -A -t -q -h "$work/prod.s" -U postgres -d postgres -f scripts/window-1/storage-policies.sql > "$dump/storage-policies.sql"
echo "production counts: $(cat "$dump/counts.prod.json")"

# Real Supabase schema dumps omit the public schema itself; the empty target already has it.
sed -i -E '/^CREATE SCHEMA public;$/d; /^COMMENT ON SCHEMA public IS/d' "$dump/schema.sql"

OVD_PSQL="$bin/psql" node scripts/window-1/restore-check.mjs --target "postgresql:///postgres?host=$work/target.s&user=postgres" --dump "$dump"
