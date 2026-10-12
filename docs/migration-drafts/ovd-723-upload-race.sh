#!/usr/bin/env bash
# OVD-723 finding 1: Storage upload authorization vs. a concurrent declaration.
#
# Two-session race on a DISPOSABLE local database only (synthetic fixture
# lane). Never point it at a hosted project. It needs a database that has every
# migration under supabase/migrations/ plus docs/migration-drafts/ovd-723.sql
# applied, and it commits synthetic rows.
#
# Session A declares `controlled` and holds its transaction open for 4 s.
# Session B, 1 s later, inserts the granted Storage object as the member.
# Expected with the draft: B waits for A's commit, then is denied by the
# job-files INSERT policy ("new row violates row-level security policy"),
# and no object exists. A control run with no concurrent writer is admitted.
#
# Usage: PSQL="psql -h 127.0.0.1 -U supabase_admin -d postgres" ./ovd-723-upload-race.sh
set -euo pipefail

: "${PSQL:?set PSQL to a psql command for the disposable database}"
psql_run() { $PSQL -X -At -v ON_ERROR_STOP=1 "$@"; }

ORG=00000000-0000-4000-8000-00000000c234
JOB=00000000-0000-4000-8000-00000000c236
MEMBER=00000000-0000-4000-8000-00000000c232
ADMIN=00000000-0000-4000-8000-00000000c231

who() { # $1 user id
  printf "set role authenticated;\nselect set_config('request.jwt.claims', json_build_object('sub', '%s', 'role', 'authenticated', 'aal', 'aal2')::text, false);\nselect set_config('request.jwt.claim.sub', '%s', false);\n" "$1" "$1"
}

psql_run >/dev/null <<SQL
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('$ADMIN', 'authenticated', 'authenticated', 'race723-admin@example.com', now()),
  ('$MEMBER', 'authenticated', 'authenticated', 'race723-member@example.com', now())
on conflict (id) do nothing;
insert into private.platform_admin_emails (email) values ('race723-admin@example.com') on conflict do nothing;
insert into public.organizations (id, name, slug) values ('$ORG', 'Race 723', 'race-723') on conflict (id) do nothing;
insert into public.organization_memberships (organization_id, user_id, role) values
  ('$ORG', '$ADMIN', 'internal_admin'), ('$ORG', '$MEMBER', 'client') on conflict do nothing;
insert into public.jobs (id, organization_id, created_by, title) values ('$JOB', '$ORG', '$MEMBER', 'race 723')
on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('job-files', 'job-files', false) on conflict (id) do nothing;
$(who "$ADMIN")
select public.api_admin_set_founding_beta_enrollment('$ORG', true, 'race 723', 'race723-grant');
reset role;
$(who "$MEMBER")
select public.api_accept_founding_beta_notice('$ORG', 'founding-beta-2026-08-15');
SQL

prepare() { # $1 hash
  psql_run <<SQL | tail -1
$(who "$MEMBER")
select public.api_declare_job_export_status('$JOB', 'not_controlled', 'ovd-beta-export-control.v1') ->> 'declarationId' as decl \gset
select public.api_prepare_job_file_upload('$JOB', 'race.step', 'cad', null, 10, '$1', :'decl'::uuid) ->> 'status';
SQL
}

insert_object() { # $1 hash
  $PSQL -X -At <<SQL 2>&1 | grep -E "^B|ERROR" || true
$(who "$MEMBER")
select 'B insert start ' || clock_timestamp()::time;
insert into storage.objects (bucket_id, name, owner, metadata)
values ('job-files', 'org-sha256/$ORG/$1/race.step', '$MEMBER', '{"size": 10}');
select 'B finished ' || clock_timestamp()::time;
SQL
}

race_hash=$(printf 'a%.0s' $(seq 64))
echo "prepare: $(prepare "$race_hash")"
$PSQL -X -At <<SQL 2>&1 | grep -E "^A" &
$(who "$MEMBER")
begin;
select 'A declared ' || (public.api_declare_job_export_status('$JOB', 'controlled', 'ovd-beta-export-control.v1') ->> 'answer') || ' (uncommitted) ' || clock_timestamp()::time;
select pg_sleep(4);
commit;
select 'A committed ' || clock_timestamp()::time;
SQL
sleep 1
insert_object "$race_hash"
wait
echo "race object rows: $(psql_run -c "select count(*) from storage.objects where name like '%/$race_hash/race.step'")"

control_hash=$(printf 'b%.0s' $(seq 64))
echo "control prepare: $(prepare "$control_hash")"
insert_object "$control_hash"
echo "control object rows: $(psql_run -c "select count(*) from storage.objects where name like '%/$control_hash/race.step'")"
