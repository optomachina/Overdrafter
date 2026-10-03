-- SOURCE-ONLY staged first-loop mapping. Not an active migration. Apply only in
-- an independently authorized disposable qualification/deployment procedure.
-- Prerequisites: native ownership plus staged OVD-560 result registry.
-- No rows, buckets, credentials, roles or grants are created by this contract.
begin;
create table engineering_private.native_artifact_inputs (
  id uuid primary key,
  input_admission_id uuid not null references engineering_private.native_input_admissions(id),
  ordinal integer not null check (ordinal between 0 and 2),
  storage_object_id uuid not null references storage.objects(id),
  storage_version text not null check (length(storage_version) between 1 and 1024),
  storage_updated_at timestamptz not null,
  byte_length integer not null check (byte_length between 1 and 16000000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  unique (input_admission_id, ordinal)
);
create table engineering_private.native_artifact_outputs (
  attempt_id uuid not null references public.engineering_execution_attempts(id),
  role text not null check (role in ('assembly','target','companion','result','identity','preservation','native')),
  bucket_id text not null references storage.buckets(id),
  object_name text generated always as ('native-results/' || attempt_id::text || '/' || role) stored,
  primary key (attempt_id, role),
  unique (bucket_id, object_name)
);
create function engineering_private.preserve_native_artifact_mapping()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Native artifact mapping is immutable.' using errcode = '55000';
end;
$$;
create trigger native_artifact_inputs_immutable before update or delete
  on engineering_private.native_artifact_inputs for each row
  execute function engineering_private.preserve_native_artifact_mapping();
create trigger native_artifact_outputs_immutable before update or delete
  on engineering_private.native_artifact_outputs for each row
  execute function engineering_private.preserve_native_artifact_mapping();
alter table engineering_private.native_artifact_inputs enable row level security;
alter table engineering_private.native_artifact_outputs enable row level security;
revoke all on engineering_private.native_artifact_inputs, engineering_private.native_artifact_outputs
  from public, anon, authenticated, service_role;
revoke all on function engineering_private.preserve_native_artifact_mapping()
  from public, anon, authenticated, service_role;
commit;
