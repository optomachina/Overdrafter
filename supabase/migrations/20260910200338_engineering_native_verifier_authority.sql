-- OVD-505: a verifier principal is separate from worker/gateway credentials.
-- No principal, JWT, login, bucket or runtime admission is provisioned here.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='engineering_native_verifier') then
    create role engineering_native_verifier nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  elsif exists(select 1 from pg_roles where rolname='engineering_native_verifier'
    and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    raise exception 'Existing native verifier role has incompatible authority.';
  end if;
end; $$;
grant engineering_native_verifier to authenticator;
grant usage on schema public,engineering_private to engineering_native_verifier;

create table engineering_private.native_verifier_principals (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version text not null check (policy_version='prepared-native-reports-v1'),
  validator_version text not null check (char_length(validator_version) between 1 and 100),
  admitted_by uuid not null references auth.users(id),
  admitted_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at>admitted_at and expires_at<=admitted_at+interval '30 days'),
  check (revoked_at is null or revoked_at>=admitted_at),
  foreign key (project_id,organization_id) references public.projects(id,organization_id)
);
create function engineering_private.preserve_native_verifier_principal()
returns trigger language plpgsql set search_path='' as $$ begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='Verifier authority history cannot be deleted.'; end if;
  if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
    or old.revoked_at is not null or new.revoked_at is null then
    raise exception using errcode='55000',message='Verifier authority can only be revoked.';
  end if;
  return new;
end; $$;
revoke all on function engineering_private.preserve_native_verifier_principal() from public,anon,authenticated,service_role,engineering_native_verifier;
create trigger native_verifier_principal_immutable before update or delete on engineering_private.native_verifier_principals
  for each row execute function engineering_private.preserve_native_verifier_principal();
alter table engineering_private.native_verifier_principals enable row level security;
revoke all on engineering_private.native_verifier_principals from public,anon,authenticated,service_role,engineering_native_verifier;

-- Supplied only by the qualified stop-evidence validator, alongside the exact
-- admitted terminal-process evidence. Existing/null bindings cannot verify.
alter table engineering_private.native_stop_admissions add column report_binding jsonb;
alter table engineering_private.native_stop_admissions add constraint native_stop_report_binding check (report_binding is null or (
  jsonb_typeof(report_binding)='object'
  and report_binding - array['schema','nativePid','nativeStartTicks','helperPid','candidateRoot','nativeReportSha256']='{}'::jsonb
  and report_binding->>'schema'='overdrafter.native-report-process.v1'
  and jsonb_typeof(report_binding->'nativePid')='number' and (report_binding->>'nativePid')::numeric between 1 and 2147483647
  and (report_binding->>'nativePid')::numeric=trunc((report_binding->>'nativePid')::numeric)
  and jsonb_typeof(report_binding->'helperPid')='number' and (report_binding->>'helperPid')::numeric between 1 and 2147483647
  and (report_binding->>'helperPid')::numeric=trunc((report_binding->>'helperPid')::numeric)
  and report_binding->>'nativeStartTicks' ~ '^[0-9]{18}$'
  and jsonb_typeof(report_binding->'candidateRoot')='string' and char_length(report_binding->>'candidateRoot') between 4 and 4096
  and report_binding->>'nativeReportSha256' ~ '^[0-9a-f]{64}$'
) is true);

create table engineering_private.native_verification_runs (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references engineering_private.native_verifier_principals(id),
  idempotency_key uuid not null,
  manifest_id uuid not null,
  attempt_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  attempt_revision bigint not null check (attempt_revision between 0 and 9007199254740990),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at=created_at+interval '60 seconds'),
  unique (principal_id,idempotency_key),
  unique (id,attempt_id,organization_id,project_id),
  foreign key (manifest_id,attempt_id,organization_id,project_id)
    references engineering_private.native_result_manifests(id,attempt_id,organization_id,project_id)
);
alter table engineering_private.native_verification_runs enable row level security;
revoke all on engineering_private.native_verification_runs from public,anon,authenticated,service_role,engineering_native_verifier;
create trigger native_verification_run_immutable before update or delete on engineering_private.native_verification_runs
  for each row execute function engineering_private.reject_engineering_history_mutation();
alter table engineering_private.native_verification_receipts add column verification_run_id uuid unique;
alter table engineering_private.native_verification_receipts add constraint native_receipt_run_scope
  foreign key (verification_run_id,attempt_id,organization_id,project_id)
    references engineering_private.native_verification_runs(id,attempt_id,organization_id,project_id);

-- Finalization can wait on admission/access/snapshot locks after the RPC's
-- initial deadline check. Validate again inside the same transaction, after
-- snapshot insertion and before publishing the finalization record. Failure
-- rolls back the snapshot, newly minted receipt and all other writes together.
create function engineering_private.check_native_verifier_finalization()
returns trigger language plpgsql security definer set search_path='' as $$
declare run_id uuid; r engineering_private.native_verification_runs%rowtype;
  p engineering_private.native_verifier_principals%rowtype; at_time timestamptz;
begin
  select verification_run_id into run_id from engineering_private.native_verification_receipts where id=new.verification_receipt_id;
  if run_id is null then return new; end if;
  select * into r from engineering_private.native_verification_runs where id=run_id;
  select * into p from engineering_private.native_verifier_principals where id=r.principal_id for share;
  at_time := clock_timestamp();
  if p.id is null or p.revoked_at is not null or p.expires_at<=at_time then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  if r.expires_at<=at_time then
    raise exception using errcode='PT409',message='Verification delivery changed or expired.';
  end if;
  return new;
end; $$;
revoke all on function engineering_private.check_native_verifier_finalization() from public,anon,authenticated,service_role,engineering_native_verifier;
create trigger native_verifier_finalization_current before insert on engineering_private.native_result_finalizations
  for each row execute function engineering_private.check_native_verifier_finalization();

create function engineering_private.require_native_verifier()
returns engineering_private.native_verifier_principals language plpgsql security definer set search_path='' as $$
declare p engineering_private.native_verifier_principals%rowtype;
begin
  select * into p from engineering_private.native_verifier_principals where id=auth.uid() for share;
  if p.id is null or p.revoked_at is not null or p.expires_at<=clock_timestamp() then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  return p;
end; $$;
revoke all on function engineering_private.require_native_verifier() from public,anon,authenticated,service_role,engineering_native_verifier;

create function engineering_private.lock_verifier_attempt(p_manifest uuid)
returns public.engineering_execution_attempts language plpgsql security definer set search_path='' as $$
declare p engineering_private.native_verifier_principals%rowtype; m engineering_private.native_result_manifests%rowtype;
  a public.engineering_execution_attempts%rowtype; credential text;
begin
  p := engineering_private.require_native_verifier();
  select * into m from engineering_private.native_result_manifests where id=p_manifest;
  if m.id is null or m.organization_id<>p.organization_id or m.project_id<>p.project_id then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  select * into a from public.engineering_execution_attempts where id=m.attempt_id;
  select credential_sha256 into credential from engineering_private.worker_credentials where worker_id=a.worker_id;
  -- Reuse the exact coordinator locking/access path. This internal credential
  -- never leaves SQL or appears in a receipt; the caller cannot choose it.
  perform engineering_private.lock_native_task(a.worker_id,credential,a.task_id);
  select * into a from public.engineering_execution_attempts where id=m.attempt_id for update;
  return a;
end; $$;
revoke all on function engineering_private.lock_verifier_attempt(uuid) from public,anon,authenticated,service_role,engineering_native_verifier;

create function engineering_private.load_native_verification(p_manifest uuid,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p engineering_private.native_verifier_principals%rowtype; a public.engineering_execution_attempts%rowtype;
  m engineering_private.native_result_manifests%rowtype; s engineering_private.native_stop_admissions%rowtype;
  r engineering_private.native_verification_runs%rowtype; context_text text; job jsonb; objects jsonb; at_time timestamptz;
begin
  p := engineering_private.require_native_verifier();
  select * into m from engineering_private.native_result_manifests where id=p_manifest;
  if m.id is null or m.organization_id<>p.organization_id or m.project_id<>p.project_id then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  select * into a from public.engineering_execution_attempts where id=m.attempt_id;
  if not engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id) then
    raise exception using errcode='42501',message='Native verification is unavailable.';
  end if;
  at_time := clock_timestamp();
  if p_key is null then raise exception using errcode='22023',message='Verification delivery identity required.'; end if;
  if p.expires_at<=at_time then raise exception using errcode='42501',message='Native verification is unavailable.'; end if;
  select * into r from engineering_private.native_verification_runs where principal_id=p.id and idempotency_key=p_key;
  if r.id is not null and r.manifest_id<>m.id then
    raise exception using errcode='PT409',message='Verification delivery changed or expired.';
  end if;
  -- Recover an already committed delivery after a lost completion response.
  -- This is a historical receipt, never fresh native execution authority.
  if r.id is not null and exists(select 1 from engineering_private.native_verification_receipts v
    join engineering_private.native_result_finalizations f on f.verification_receipt_id=v.id where v.verification_run_id=r.id) then
    return jsonb_build_object('schema','overdrafter.native-verification-delivery.v1','status','completed',
      'runId',r.id,'manifestId',m.id,'sourceSha256',p.source_sha256,'policy',p.policy_version,
      'result',(select receipt from engineering_private.native_attempt_events where task_id=a.task_id and idempotency_key=r.id and kind='finalized'));
  end if;
  -- Only fresh verification needs current worker authority. Historical reads
  -- above retain current verifier/project authorization after worker revocation.
  a := engineering_private.lock_verifier_attempt(p_manifest);
  select * into s from engineering_private.native_stop_admissions where id=a.stop_admission_id;
  at_time := clock_timestamp();
  if p.expires_at<=at_time or a.phase<>'awaiting_result' or not a.result_eligible or s.report_binding is null
    or s.execution_outcome<>'native_exit_succeeded' or s.verdict<>'all_owned_processes_exited'
    or not exists(select 1 from public.engineering_task_execution x where x.task_id=a.task_id and x.current_attempt_id=a.id)
    or exists(select 1 from engineering_private.native_admission_revocations where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id)
    or s.report_binding->>'nativeReportSha256' is distinct from (select sha256 from engineering_private.native_result_objects where id=(m.objects->>'native')::uuid) then
    raise exception using errcode='PT409',message='Admitted native result evidence required.';
  end if;
  if r.id is null then
    insert into engineering_private.native_verification_runs(principal_id,idempotency_key,manifest_id,attempt_id,organization_id,project_id,attempt_revision,created_at,expires_at)
      values(p.id,p_key,m.id,a.id,a.organization_id,a.project_id,a.revision,at_time,at_time+interval '60 seconds') returning * into r;
  elsif r.manifest_id<>m.id or r.attempt_revision<>a.revision or r.expires_at<=at_time then
    raise exception using errcode='PT409',message='Verification delivery changed or expired.';
  end if;
  select snap.context_text into context_text from public.engineering_snapshots snap where id=a.input_snapshot_id;
  job := a.job_text::jsonb;
  select jsonb_agg(jsonb_build_object('id',o.id,'scope',job->'scope','attemptId',o.attempt_id,'role',o.role,'bytes',o.bytes,'sha256',o.sha256) order by o.role)
    into objects from jsonb_each_text(m.objects) e join engineering_private.native_result_objects o on o.id=e.value::uuid;
  return jsonb_build_object('schema','overdrafter.native-verification-delivery.v1','status','ready','runId',r.id,'manifestId',m.id,
    'expiresAt',r.expires_at,'sourceSha256',p.source_sha256,'policy',p.policy_version,
    'admission',jsonb_build_object('contextText',context_text,'jobText',a.job_text,
      'active',jsonb_build_object('scope',job->'scope','jobId',job->'jobId','attemptId',a.id,'fence',a.fence,
        'inputSnapshotId',a.input_snapshot_id,'contextSha256',job->'contextSha256','outputSnapshotId',a.output_snapshot_id),
      'process',s.report_binding-array['schema','nativeReportSha256'],'objects',objects));
end; $$;
revoke all on function engineering_private.load_native_verification(uuid,uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.load_native_verification(uuid,uuid) to engineering_native_verifier;
create function public.api_load_native_verification(p_manifest uuid,p_key uuid)
returns jsonb language sql security invoker set search_path='' as $$ select engineering_private.load_native_verification(p_manifest,p_key); $$;
revoke all on function public.api_load_native_verification(uuid,uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function public.api_load_native_verification(uuid,uuid) to engineering_native_verifier;

create function engineering_private.complete_native_verification(p_run uuid,p_context_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p engineering_private.native_verifier_principals%rowtype; r engineering_private.native_verification_runs%rowtype;
  a public.engineering_execution_attempts%rowtype; v engineering_private.native_verification_receipts%rowtype; credential text;
begin
  p := engineering_private.require_native_verifier();
  select * into r from engineering_private.native_verification_runs where id=p_run;
  if r.id is null or r.principal_id<>p.id then raise exception using errcode='42501',message='Native verification is unavailable.'; end if;
  a := engineering_private.lock_verifier_attempt(r.manifest_id);
  if p.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='Native verification is unavailable.'; end if;
  select * into v from engineering_private.native_verification_receipts where verification_run_id=r.id;
  if v.id is null then
    if r.expires_at<=clock_timestamp() or a.revision<>r.attempt_revision then
      raise exception using errcode='PT409',message='Verification delivery changed or expired.';
    end if;
    insert into engineering_private.native_verification_receipts(id,attempt_id,organization_id,project_id,manifest_id,stop_admission_id,
      job_sha256,context_text,policy_version,validator_version,verification_run_id)
      values(gen_random_uuid(),a.id,a.organization_id,a.project_id,r.manifest_id,a.stop_admission_id,a.job_sha256,
        p_context_text,p.policy_version,p.validator_version,r.id) returning * into v;
  elsif v.context_text is distinct from p_context_text then
    raise exception using errcode='PT409',message='Verification delivery content differs.';
  end if;
  select credential_sha256 into credential from engineering_private.worker_credentials where worker_id=a.worker_id;
  return engineering_private.finalize_native_result(a.worker_id,credential,a.boot_id,a.task_id,a.id,v.id,r.attempt_revision,r.id);
end; $$;
revoke all on function engineering_private.complete_native_verification(uuid,text) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.complete_native_verification(uuid,text) to engineering_native_verifier;
create function public.api_complete_native_verification(p_run uuid,p_context_text text)
returns jsonb language sql security invoker set search_path='' as $$ select engineering_private.complete_native_verification(p_run,p_context_text); $$;
revoke all on function public.api_complete_native_verification(uuid,text) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function public.api_complete_native_verification(uuid,text) to engineering_native_verifier;

-- Read-only access to the exact registered objects of a current verification
-- run. A restrictive companion policy prevents unrelated PUBLIC policies from
-- expanding this machine role's storage access.
create function engineering_private.native_verifier_can_read_object(p_bucket text,p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from engineering_private.native_result_objects o
    join engineering_private.native_verifier_principals p on p.id=auth.uid()
      and p.organization_id=o.organization_id and p.project_id=o.project_id
    join engineering_private.native_verification_runs r on r.principal_id=p.id and r.attempt_id=o.attempt_id
    join engineering_private.native_result_manifests m on m.id=r.manifest_id and m.objects->>o.role=o.id::text
    join public.engineering_execution_attempts a on a.id=r.attempt_id
    where o.bucket_id=p_bucket and o.object_key=p_name and p.revoked_at is null and p.expires_at>statement_timestamp()
      and r.expires_at>statement_timestamp() and a.phase='awaiting_result' and a.result_eligible
      and engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id)
      and not exists(select 1 from engineering_private.native_admission_revocations
        where runtime_admission_id=a.runtime_admission_id or input_admission_id=a.input_admission_id)
  );
$$;
revoke all on function engineering_private.native_verifier_can_read_object(text,text) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.native_verifier_can_read_object(text,text) to engineering_native_verifier;
grant usage on schema storage to engineering_native_verifier;
grant select on storage.objects to engineering_native_verifier;
create policy native_verifier_registered_read on storage.objects for select to engineering_native_verifier
  using (engineering_private.native_verifier_can_read_object(bucket_id,name));
create policy native_verifier_registered_only on storage.objects as restrictive for select to engineering_native_verifier
  using (engineering_private.native_verifier_can_read_object(bucket_id,name));
