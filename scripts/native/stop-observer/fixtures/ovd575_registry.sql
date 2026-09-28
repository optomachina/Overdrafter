-- Disposable OVD-575 migration fixture. The Supabase image supplies auth.users
-- and extensions; these narrow stubs reproduce only the existing native tables
-- used by the new migration. No production database is addressed by this file.
create extension if not exists pgcrypto with schema extensions;
create schema engineering_private;
grant usage on schema engineering_private to authenticated, service_role;
create table engineering_private.native_runtime_admissions (id uuid primary key);
create table engineering_private.native_admission_revocations (
  id uuid primary key, runtime_admission_id uuid, input_admission_id uuid
);
create table public.engineering_workers (
  id uuid primary key, current_boot_id uuid, revoked_at timestamptz
);
create table public.engineering_execution_attempts (
  id uuid primary key, task_id uuid not null, organization_id uuid not null,
  project_id uuid not null, worker_id uuid not null, installation_id uuid not null,
  boot_id uuid not null, session_id uuid not null, runtime_admission_id uuid not null,
  input_admission_id uuid not null,
  fence bigint not null, job_text text not null, job_sha256 text not null,
  claimed_at timestamptz not null, deadline_at timestamptz not null,
  lease_expires_at timestamptz not null, phase text not null,
  result_eligible boolean not null, stopped_at timestamptz,
  unique (id,organization_id,project_id)
);
create table engineering_private.native_slots (
  organization_id uuid primary key, active_attempt_id uuid
);
create table engineering_private.native_stop_admissions (id uuid primary key);
create function engineering_private.reject_engineering_history_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode='55000',message='Engineering history is immutable.';
end;
$$;
