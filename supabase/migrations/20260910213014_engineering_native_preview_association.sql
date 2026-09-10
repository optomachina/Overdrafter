-- OVD-505: preview association is independent of native verification/adoption.
-- No bucket, export writer, credential or deployed caller is provisioned.
-- Existing principals retain no preview capability; a newly qualified principal
-- must explicitly opt in. Principal immutability prevents in-place escalation.
alter table engineering_private.native_verifier_principals add column preview_policy_version text
  check(preview_policy_version is null or preview_policy_version='prepared-native-preview-v1');
create table engineering_private.native_preview_exports (
  id uuid primary key,
  snapshot_id uuid not null references engineering_private.native_result_finalizations(output_snapshot_id),
  organization_id uuid not null,
  project_id uuid not null,
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  source_commit text not null check (source_commit ~ '^[0-9a-f]{40}$'),
  process jsonb not null,
  objects jsonb not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  admitted_by uuid not null references auth.users(id),
  admitted_at timestamptz not null default clock_timestamp(),
  unique(id,snapshot_id),
  foreign key(snapshot_id,organization_id,project_id) references public.engineering_snapshots(id,organization_id,project_id)
);
comment on table engineering_private.native_preview_exports is
  'Qualified completed read-only export admission and immutable two-object registry. No API writer grants. Loader must establish qualified source/process, normal shutdown and immutable bytes; worker claims cannot admit themselves.';
create function engineering_private.check_native_preview_export()
returns trigger language plpgsql set search_path='' as $$
declare o jsonb; ids uuid[] := '{}'; roles text[] := '{}'; s public.engineering_snapshots%rowtype;
begin
  select * into s from public.engineering_snapshots where id=new.snapshot_id;
  if new.context_sha256 is distinct from s.context_sha256 or (jsonb_typeof(new.process)='object'
    and new.process-array['nativePid','helperPid','nativeStartTicks','candidateRoot']='{}'::jsonb
    and jsonb_typeof(new.process->'nativePid')='number' and (new.process->>'nativePid')::numeric between 1 and 2147483647
    and (new.process->>'nativePid')::numeric=trunc((new.process->>'nativePid')::numeric)
    and jsonb_typeof(new.process->'helperPid')='number' and (new.process->>'helperPid')::numeric between 1 and 2147483647
    and (new.process->>'helperPid')::numeric=trunc((new.process->>'helperPid')::numeric)
    and new.process->>'nativePid'<>new.process->>'helperPid'
    and new.process->>'nativeStartTicks' ~ '^[1-9][0-9]{16,18}$'
    and jsonb_typeof(new.process->'candidateRoot')='string' and char_length(new.process->>'candidateRoot') between 4 and 4096
  ) is not true then raise exception using errcode='23514',message='Exact preview context/process required.'; end if;
  if jsonb_typeof(new.objects) is distinct from 'array' or jsonb_array_length(new.objects)<>2 or octet_length(new.objects::text)>1024 then
    raise exception using errcode='23514',message='Two bounded preview objects required.';
  end if;
  for o in select value from jsonb_array_elements(new.objects) loop
    if (jsonb_typeof(o)='object' and o-array['id','role','bytes','sha256']='{}'::jsonb
      and jsonb_typeof(o->'id')='string' and o->>'id'=(o->>'id')::uuid::text and (o->>'id')::uuid<>'00000000-0000-0000-0000-000000000000'
      and not ((o->>'id')::uuid=any(ids)) and o->>'role' in ('bundle','report') and not(o->>'role'=any(roles))
      and jsonb_typeof(o->'bytes')='number' and (o->>'bytes')::numeric=trunc((o->>'bytes')::numeric)
      and (o->>'bytes')::numeric between 1 and case o->>'role' when 'bundle' then 3000000 else 128000 end
      and jsonb_typeof(o->'sha256')='string' and o->>'sha256' ~ '^[0-9a-f]{64}$') is not true then
      raise exception using errcode='23514',message='Exact preview object identity required.';
    end if;
    ids:=array_append(ids,(o->>'id')::uuid);roles:=array_append(roles,o->>'role');
  end loop;
  return new;
end; $$;
revoke all on function engineering_private.check_native_preview_export() from public,anon,authenticated,service_role,engineering_native_verifier;
create trigger native_preview_export_check before insert on engineering_private.native_preview_exports
  for each row execute function engineering_private.check_native_preview_export();
create table engineering_private.native_preview_revocations (
  export_id uuid primary key references engineering_private.native_preview_exports(id),
  revoked_by uuid not null references auth.users(id),
  reason text not null check(char_length(reason) between 1 and 500),
  revoked_at timestamptz not null default clock_timestamp()
);
create table engineering_private.native_preview_runs (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references engineering_private.native_verifier_principals(id),
  idempotency_key uuid not null,
  export_id uuid not null references engineering_private.native_preview_exports(id),
  created_at timestamptz not null,
  expires_at timestamptz not null check(expires_at=created_at+interval '60 seconds'),
  unique(principal_id,idempotency_key), unique(id,export_id)
);
create table engineering_private.native_preview_receipts (
  export_id uuid primary key,
  snapshot_id uuid not null,
  run_id uuid not null unique,
  step_sha256 text not null check(step_sha256 ~ '^[0-9a-f]{64}$'),
  step_bytes integer not null check(step_bytes between 1 and 2000000),
  policy_version text not null check(policy_version='prepared-native-preview-v1'),
  attached_at timestamptz not null default clock_timestamp(),
  foreign key(export_id,snapshot_id) references engineering_private.native_preview_exports(id,snapshot_id),
  foreign key(run_id,export_id) references engineering_private.native_preview_runs(id,export_id)
);
do $$ declare n text; begin
  foreach n in array array['native_preview_exports','native_preview_revocations','native_preview_runs','native_preview_receipts'] loop
    execute format('alter table engineering_private.%I enable row level security',n);
    execute format('revoke all on engineering_private.%I from public,anon,authenticated,service_role,engineering_native_verifier',n);
    execute format('create trigger native_preview_immutable before update or delete on engineering_private.%I for each row execute function engineering_private.reject_engineering_history_mutation()',n);
  end loop;
end; $$;

-- Same ordering for load/complete: principal, snapshot, export, owner access.
-- Export FOR UPDATE serializes revocation's FK lock, and snapshot serializes
-- competing exports. No native worker slot, lease, task or head is mutated.
create function engineering_private.lock_native_preview(p_export uuid)
returns engineering_private.native_preview_exports language plpgsql security definer set search_path='' as $$
declare p engineering_private.native_verifier_principals%rowtype; e engineering_private.native_preview_exports%rowtype; owner_id uuid;
begin
  p:=engineering_private.require_native_verifier();
  if p.preview_policy_version is distinct from 'prepared-native-preview-v1' then
    raise exception using errcode='42501',message='Preview verification unavailable.'; end if;
  select * into e from engineering_private.native_preview_exports where id=p_export;
  if e.id is null or e.organization_id<>p.organization_id or e.project_id<>p.project_id then
    raise exception using errcode='42501',message='Preview verification unavailable.';
  end if;
  perform 1 from public.engineering_snapshots where id=e.snapshot_id for update;
  perform 1 from engineering_private.native_preview_exports where id=e.id for update;
  select a.owner_user_id into owner_id from engineering_private.native_result_finalizations f
    join public.engineering_execution_attempts a on a.id=f.attempt_id where f.output_snapshot_id=e.snapshot_id;
  perform 1 from engineering_private.engineering_operators where organization_id=e.organization_id and user_id=owner_id for share;
  perform 1 from public.organization_memberships where organization_id=e.organization_id and user_id=owner_id for share;
  perform 1 from public.projects where id=e.project_id for share;
  perform 1 from public.project_memberships where project_id=e.project_id and user_id=owner_id for share;
  if p.expires_at<=clock_timestamp() or not engineering_private.engineering_actor_access(owner_id,e.organization_id,e.project_id)
    or exists(select 1 from engineering_private.native_preview_revocations where export_id=e.id) then
    raise exception using errcode='42501',message='Preview verification unavailable.';
  end if;
  return e;
end; $$;
revoke all on function engineering_private.lock_native_preview(uuid) from public,anon,authenticated,service_role,engineering_native_verifier;

create function engineering_private.native_preview_receipt_json(p_export uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('status','ready','snapshotId',e.snapshot_id,'contextSha256',e.context_sha256,'exportId',e.id,
    'policy',r.policy_version,'step',jsonb_build_object('sha256',r.step_sha256,'bytes',r.step_bytes),
    'bundle',jsonb_build_object('id',o->>'id','bytes',(o->>'bytes')::integer,'sha256',o->>'sha256',
      'bucketId','engineering-native-previews','objectKey',e.organization_id::text||'/'||e.project_id::text||'/'||e.id::text||'/'||(o->>'id')))
  from engineering_private.native_preview_receipts r join engineering_private.native_preview_exports e on e.id=r.export_id
    cross join lateral jsonb_array_elements(e.objects) o where e.id=p_export and o->>'role'='bundle';
$$;
revoke all on function engineering_private.native_preview_receipt_json(uuid) from public,anon,authenticated,service_role,engineering_native_verifier;

create function engineering_private.load_native_preview(p_export uuid,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e engineering_private.native_preview_exports%rowtype; p engineering_private.native_verifier_principals%rowtype;
  r engineering_private.native_preview_runs%rowtype; s public.engineering_snapshots%rowtype; result jsonb; at_time timestamptz;
begin
  e:=engineering_private.lock_native_preview(p_export);p:=engineering_private.require_native_verifier();
  if p_key is null then raise exception using errcode='22023',message='Preview delivery identity required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('native-preview:'||p.id::text||':'||p_key::text,0));
  if p.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='Preview verification unavailable.'; end if;
  select * into r from engineering_private.native_preview_runs where principal_id=p.id and idempotency_key=p_key;
  if r.id is not null and r.export_id<>e.id then raise exception using errcode='PT409',message='Preview delivery changed.'; end if;
  result:=engineering_private.native_preview_receipt_json(e.id);
  at_time:=clock_timestamp();
  -- Bind the key even for historical delivery; it cannot later name a different
  -- export merely because no new receipt was needed for the first response.
  if r.id is null then
    insert into engineering_private.native_preview_runs(principal_id,idempotency_key,export_id,created_at,expires_at)
      values(p.id,p_key,e.id,at_time,at_time+interval '60 seconds') returning * into r;
  end if;
  if p.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='Preview verification unavailable.'; end if;
  if result is not null then return jsonb_build_object('schema','overdrafter.native-preview-delivery.v1','status','completed',
    'exportId',e.id,'sourceSha256',p.source_sha256,'policy','prepared-native-preview-v1','result',result); end if;
  if exists(select 1 from engineering_private.native_preview_receipts pv where pv.snapshot_id=e.snapshot_id
    and not exists(select 1 from engineering_private.native_preview_revocations x where x.export_id=pv.export_id)) then
    raise exception using errcode='PT409',message='Snapshot already has another preview.';
  end if;
  if r.expires_at<=clock_timestamp() then raise exception using errcode='PT409',message='Preview delivery expired.'; end if;
  select * into s from public.engineering_snapshots where id=e.snapshot_id;
  return jsonb_build_object('schema','overdrafter.native-preview-delivery.v1','status','ready','runId',r.id,'exportId',e.id,
    'sourceSha256',p.source_sha256,'policy','prepared-native-preview-v1','expiresAt',r.expires_at,'contextText',s.context_text,
    'admission',jsonb_build_object('exportId',e.id,'scope',jsonb_build_object('organizationId',e.organization_id,'projectId',e.project_id),
      'snapshotId',e.snapshot_id,'contextSha256',e.context_sha256,'sourceCommit',e.source_commit,'process',e.process,'objects',e.objects));
end; $$;
revoke all on function engineering_private.load_native_preview(uuid,uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.load_native_preview(uuid,uuid) to engineering_native_verifier;
create function public.api_load_native_preview(p_export uuid,p_key uuid)
returns jsonb language sql security invoker set search_path='' as $$ select engineering_private.load_native_preview(p_export,p_key); $$;
revoke all on function public.api_load_native_preview(uuid,uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function public.api_load_native_preview(uuid,uuid) to engineering_native_verifier;

create function engineering_private.complete_native_preview(p_run uuid,p_step_sha256 text,p_step_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r engineering_private.native_preview_runs%rowtype; p engineering_private.native_verifier_principals%rowtype;
  e engineering_private.native_preview_exports%rowtype; v engineering_private.native_preview_receipts%rowtype;
begin
  p:=engineering_private.require_native_verifier();
  select * into r from engineering_private.native_preview_runs where id=p_run;
  if r.id is null or r.principal_id<>p.id then raise exception using errcode='42501',message='Preview verification unavailable.'; end if;
  e:=engineering_private.lock_native_preview(r.export_id);
  select * into v from engineering_private.native_preview_receipts where export_id=e.id;
  if v.export_id is not null then
    if v.step_sha256 is distinct from p_step_sha256 or v.step_bytes is distinct from p_step_bytes then
      raise exception using errcode='PT409',message='Preview delivery changed.'; end if;
    return engineering_private.native_preview_receipt_json(e.id);
  end if;
  if r.expires_at<=clock_timestamp() then raise exception using errcode='PT409',message='Preview delivery expired.'; end if;
  if exists(select 1 from engineering_private.native_preview_receipts pv where pv.snapshot_id=e.snapshot_id
    and not exists(select 1 from engineering_private.native_preview_revocations x where x.export_id=pv.export_id)) then
    raise exception using errcode='PT409',message='Snapshot already has another preview.'; end if;
  insert into engineering_private.native_preview_receipts(export_id,snapshot_id,run_id,step_sha256,step_bytes,policy_version)
    values(e.id,e.snapshot_id,r.id,p_step_sha256,p_step_bytes,'prepared-native-preview-v1');
  -- Cover any FK/trigger wait after earlier eligibility checks; rollback all.
  if r.expires_at<=clock_timestamp() or p.expires_at<=clock_timestamp() then
    raise exception using errcode='PT409',message='Preview delivery expired.'; end if;
  return engineering_private.native_preview_receipt_json(e.id);
end; $$;
revoke all on function engineering_private.complete_native_preview(uuid,text,integer) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.complete_native_preview(uuid,text,integer) to engineering_native_verifier;
create function public.api_complete_native_preview(p_run uuid,p_step_sha256 text,p_step_bytes integer)
returns jsonb language sql security invoker set search_path='' as $$ select engineering_private.complete_native_preview(p_run,p_step_sha256,p_step_bytes); $$;
revoke all on function public.api_complete_native_preview(uuid,text,integer) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function public.api_complete_native_preview(uuid,text,integer) to engineering_native_verifier;

create function engineering_private.get_native_preview(p_snapshot uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.engineering_snapshots%rowtype; owner_id uuid; export_id uuid;
begin
  select * into s from public.engineering_snapshots where id=p_snapshot;
  select a.owner_user_id into owner_id from engineering_private.native_result_finalizations f
    join public.engineering_execution_attempts a on a.id=f.attempt_id where f.output_snapshot_id=p_snapshot;
  if owner_id is distinct from auth.uid() or owner_id is null
    or not engineering_private.engineering_actor_access(owner_id,s.organization_id,s.project_id) then
    raise exception using errcode='42501',message='Candidate preview unavailable.'; end if;
  select r.export_id into export_id from engineering_private.native_preview_receipts r where r.snapshot_id=s.id
    and not exists(select 1 from engineering_private.native_preview_revocations x where x.export_id=r.export_id);
  if export_id is not null then return engineering_private.native_preview_receipt_json(export_id); end if;
  return jsonb_build_object('status','unavailable','snapshotId',s.id,'contextSha256',s.context_sha256,'reason','no_admitted_preview');
end; $$;
revoke all on function engineering_private.get_native_preview(uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.get_native_preview(uuid) to authenticated;
create function public.api_get_native_preview(p_snapshot uuid)
returns jsonb language sql security invoker set search_path='' as $$ select engineering_private.get_native_preview(p_snapshot); $$;
revoke all on function public.api_get_native_preview(uuid) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function public.api_get_native_preview(uuid) to authenticated;

create function engineering_private.native_preview_can_read(p_bucket text,p_name text,p_verifier boolean)
returns boolean language sql stable security definer set search_path='' as $$
  select p_bucket='engineering-native-previews' and exists(
    select 1 from engineering_private.native_preview_exports e
    join engineering_private.native_result_finalizations f on f.output_snapshot_id=e.snapshot_id
    join public.engineering_execution_attempts a on a.id=f.attempt_id
    cross join lateral jsonb_array_elements(e.objects) o
    where p_name=e.organization_id::text||'/'||e.project_id::text||'/'||e.id::text||'/'||(o->>'id')
      and not exists(select 1 from engineering_private.native_preview_revocations x where x.export_id=e.id)
      and engineering_private.engineering_actor_access(a.owner_user_id,e.organization_id,e.project_id)
      and ((not p_verifier and a.owner_user_id=auth.uid() and o->>'role'='bundle'
        and exists(select 1 from engineering_private.native_preview_receipts v where v.export_id=e.id))
      or (p_verifier and exists(select 1 from engineering_private.native_preview_runs r
        join engineering_private.native_verifier_principals p on p.id=r.principal_id
        where r.export_id=e.id and p.id=auth.uid() and p.organization_id=e.organization_id and p.project_id=e.project_id
          and p.preview_policy_version='prepared-native-preview-v1' and p.revoked_at is null and p.expires_at>statement_timestamp() and r.expires_at>statement_timestamp()
          and not exists(select 1 from engineering_private.native_preview_receipts v where v.export_id=e.id)))));
$$;
revoke all on function engineering_private.native_preview_can_read(text,text,boolean) from public,anon,authenticated,service_role,engineering_native_verifier;
grant execute on function engineering_private.native_preview_can_read(text,text,boolean) to anon,authenticated,engineering_native_verifier;
create policy native_preview_verifier_read on storage.objects for select to engineering_native_verifier
  using(engineering_private.native_preview_can_read(bucket_id,name,true));
alter policy native_verifier_registered_only on storage.objects using(
  engineering_private.native_verifier_can_read_object(bucket_id,name) or engineering_private.native_preview_can_read(bucket_id,name,true));
create policy native_preview_owner_read on storage.objects for select to authenticated
  using(engineering_private.native_preview_can_read(bucket_id,name,false));
create policy native_preview_owner_only on storage.objects as restrictive for select to anon,authenticated
  using(bucket_id<>'engineering-native-previews' or engineering_private.native_preview_can_read(bucket_id,name,false));
create policy native_preview_no_insert on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id<>'engineering-native-previews');
create policy native_preview_no_update on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'engineering-native-previews') with check(bucket_id<>'engineering-native-previews');
create policy native_preview_no_delete on storage.objects as restrictive for delete to anon,authenticated
  using(bucket_id<>'engineering-native-previews');
