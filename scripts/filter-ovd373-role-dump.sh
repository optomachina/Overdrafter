#!/usr/bin/env bash

set -euo pipefail

readonly OVD373_RESERVED_ROLES='anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin'
readonly OVD373_SAFE_SETTINGS='pgaudit.*|pgrst.*|session_replication_role|statement_timeout|track_io_timing'

sed -E 's/^\\(un)?restrict .*$/-- &/' \
  | sed -E "s/^CREATE ROLE \"(${OVD373_RESERVED_ROLES})\"/-- &/" \
  | sed -E "s/^ALTER ROLE \"(${OVD373_RESERVED_ROLES})\"/-- &/" \
  | sed -E 's/ (NOSUPERUSER|NOREPLICATION)//g' \
  | sed -E "s/^-- (.* SET \"(${OVD373_SAFE_SETTINGS})\" .*)/\1/" \
  | sed -E "s/GRANT \".*\" TO \"(${OVD373_RESERVED_ROLES})\"/-- &/" \
  | sed -E '/^--/d' \
  | uniq

echo 'RESET ALL;'
