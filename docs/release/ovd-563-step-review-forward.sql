-- Source-only continuation after OVD-561; apply only to an owned disposable fixture.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $preflight$
begin
  if current_user <> 'postgres'
    or to_regclass('engineering_private.native_finalizations') is null
    or to_regclass('engineering_private.native_step_reviews') is not null then
    raise exception 'ovd563_preflight_failed';
  end if;
end $preflight$;

create function engineering_private.valid_sha256(p_value text)
returns boolean language sql immutable strict set search_path = '' as $body$
  select p_value ~ '^[0-9a-f]{64}$';
$body$;
create function engineering_private.sha256_hex(p_value bytea)
returns text language sql immutable strict set search_path = '' as $body$
  select encode(extensions.digest(p_value,'sha256'),'hex');
$body$;
revoke all on function engineering_private.valid_sha256(text),
  engineering_private.sha256_hex(bytea)
  from public,anon,authenticated,service_role,engineering_native_verifier;

create table engineering_private.native_step_reviews (
  task_id uuid primary key references engineering_private.native_finalizations(task_id),
  attempt_id uuid not null unique references engineering_private.native_finalizations(attempt_id),
  conversation_id uuid not null references public.engineering_conversations(id),
  organization_id uuid not null,
  project_id uuid not null,
  owner_user_id uuid not null,
  source_snapshot_id uuid not null references public.engineering_snapshots(id),
  candidate_snapshot_id uuid not null unique references public.engineering_snapshots(id),
  candidate_context_sha256 text not null check (engineering_private.valid_sha256(candidate_context_sha256)),
  result_sha256 text not null check (engineering_private.valid_sha256(result_sha256)),
  export_id uuid not null unique,
  source_commit text not null check (source_commit ~ '^[0-9a-f]{40}$'),
  report_sha256 text not null check (engineering_private.valid_sha256(report_sha256)),
  step_sha256 text not null check (engineering_private.valid_sha256(step_sha256)),
  step_bytes bytea not null check (octet_length(step_bytes) between 1 and 2000000),
  created_at timestamptz not null default clock_timestamp(),
  check (source_snapshot_id <> candidate_snapshot_id)
);
alter table engineering_private.native_step_reviews enable row level security;
revoke all on engineering_private.native_step_reviews from public, anon, authenticated, service_role, engineering_native_verifier;
create trigger native_step_reviews_immutable before update or delete
  on engineering_private.native_step_reviews for each row
  execute function engineering_private.reject_engineering_history_mutation();

-- Reverse and the populated-history proof share this exact owner-only guard.
create function engineering_private.assert_empty_native_step_reviews()
returns void language plpgsql security invoker set search_path = '' as $body$
begin
  if current_user <> 'postgres'
    or exists(select 1 from engineering_private.native_step_reviews) then
    raise exception 'ovd563_review_history_present';
  end if;
end $body$;
revoke all on function engineering_private.assert_empty_native_step_reviews()
  from public,anon,authenticated,service_role,engineering_native_verifier;

-- The only writer is the database owner, after the source verifier has checked
-- the independently admitted preview bundle and export report. This function
-- rechecks all finalized lineage and bytes; it grants no verification authority.
create function engineering_private.associate_native_step_review(
  p_task_id uuid, p_source_snapshot_id uuid, p_candidate_snapshot_id uuid,
  p_candidate_context_sha256 text, p_result_sha256 text, p_export_id uuid,
  p_source_commit text, p_report_sha256 text, p_step_sha256 text, p_step_bytes bytea)
returns boolean language plpgsql security invoker set search_path = '' as $body$
declare
  f engineering_private.native_finalizations%rowtype;
  t public.engineering_tasks%rowtype;
  c public.engineering_conversations%rowtype;
  existing engineering_private.native_step_reviews%rowtype;
  payload jsonb;
  permission_denied_code constant text := '42501';
begin
  if current_user <> 'postgres' then
    raise exception 'ovd563_owner_required' using errcode=permission_denied_code;
  end if;
  if p_task_id is null or p_source_snapshot_id is null or p_candidate_snapshot_id is null
    or p_export_id is null or not engineering_private.valid_sha256(p_candidate_context_sha256)
    or not engineering_private.valid_sha256(p_result_sha256) or p_source_commit !~ '^[0-9a-f]{40}$'
    or not engineering_private.valid_sha256(p_report_sha256)
    or not engineering_private.valid_sha256(p_step_sha256)
    or p_step_bytes is null or octet_length(p_step_bytes) not between 1 and 2000000
    or engineering_private.sha256_hex(p_step_bytes) is distinct from p_step_sha256 then
    raise exception 'ovd563_invalid_step_identity' using errcode='22023';
  end if;
  select * into t from public.engineering_tasks where id=p_task_id;
  if t.id is null then raise exception 'ovd563_finalized_result_required' using errcode=permission_denied_code; end if;
  perform pg_advisory_xact_lock(hashtextextended('engineering:'||t.conversation_id::text,0));
  select * into c from public.engineering_conversations where id=t.conversation_id for share;
  select * into t from public.engineering_tasks where id=p_task_id for share;
  select * into f from engineering_private.native_finalizations where task_id=p_task_id for share;
  lock table engineering_private.engineering_operators, public.organization_memberships,
    public.project_memberships, public.projects in share mode;
  if f.task_id is null or c.id is null or t.execution_state<>'succeeded'
    or t.verification_state<>'passed' or c.head_snapshot_id is distinct from f.snapshot_id
    or f.snapshot_id is distinct from p_candidate_snapshot_id
    or f.candidate_context_text is null
    or engineering_private.sha256_hex(convert_to(f.candidate_context_text,'UTF8')) is distinct from p_candidate_context_sha256
    or not engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id) then
    raise exception 'ovd563_stale_or_unverified_result' using errcode=permission_denied_code;
  end if;
  payload := f.payload_text::jsonb;
  if payload->>'inputSnapshotId' is distinct from p_source_snapshot_id::text
    or payload->>'candidateSnapshotId' is distinct from p_candidate_snapshot_id::text
    or payload->>'candidateContextSha256' is distinct from p_candidate_context_sha256
    or payload->>'resultSha256' is distinct from p_result_sha256
    or payload->>'attemptId' is distinct from f.attempt_id::text
    or payload->>'organizationId' is distinct from t.organization_id::text
    or payload->>'projectId' is distinct from t.project_id::text then
    raise exception 'ovd563_finalization_lineage_mismatch' using errcode=permission_denied_code;
  end if;
  select * into existing from engineering_private.native_step_reviews where task_id=p_task_id;
  if existing.task_id is not null then
    if existing.attempt_id=f.attempt_id and existing.source_snapshot_id=p_source_snapshot_id
      and existing.candidate_snapshot_id=p_candidate_snapshot_id
      and existing.candidate_context_sha256=p_candidate_context_sha256
      and existing.result_sha256=p_result_sha256 and existing.export_id=p_export_id
      and existing.source_commit=p_source_commit and existing.report_sha256=p_report_sha256
      and existing.step_sha256=p_step_sha256 and existing.step_bytes=p_step_bytes then
      return false;
    end if;
    raise exception 'ovd563_conflicting_review_replay' using errcode='23505';
  end if;
  insert into engineering_private.native_step_reviews(task_id,attempt_id,conversation_id,
    organization_id,project_id,owner_user_id,source_snapshot_id,candidate_snapshot_id,
    candidate_context_sha256,result_sha256,export_id,source_commit,report_sha256,step_sha256,step_bytes)
  values(p_task_id,f.attempt_id,t.conversation_id,t.organization_id,t.project_id,t.owner_user_id,
    p_source_snapshot_id,p_candidate_snapshot_id,p_candidate_context_sha256,p_result_sha256,
    p_export_id,p_source_commit,p_report_sha256,p_step_sha256,p_step_bytes);
  return true;
end $body$;
revoke all on function engineering_private.associate_native_step_review(
  uuid,uuid,uuid,text,text,uuid,text,text,text,bytea)
  from public,anon,authenticated,service_role,engineering_native_verifier;

-- Returns only current verified geometry to the authenticated conversation owner.
-- A known but not yet associated result has a distinct unavailable state.
create function public.api_read_native_step_review(
  p_conversation_id uuid, p_task_id uuid, p_candidate_snapshot_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $body$
declare
  t public.engineering_tasks%rowtype;
  c public.engineering_conversations%rowtype;
  f engineering_private.native_finalizations%rowtype;
  review engineering_private.native_step_reviews%rowtype;
  payload jsonb;
  permission_denied_code constant text := '42501';
  status_key constant text := 'status';
  context_digest_key constant text := 'candidateContextSha256';
  result_digest_key constant text := 'resultSha256';
begin
  if auth.role() is distinct from 'authenticated'
    or auth.uid() is null or p_conversation_id is null or p_task_id is null
    or p_candidate_snapshot_id is null then
    raise exception 'ovd563_review_unavailable' using errcode=permission_denied_code;
  end if;
  select * into c from public.engineering_conversations where id=p_conversation_id for share;
  select * into t from public.engineering_tasks where id=p_task_id and conversation_id=p_conversation_id for share;
  lock table engineering_private.engineering_operators, public.organization_memberships,
    public.project_memberships, public.projects in share mode;
  if c.id is null or t.id is null or c.owner_user_id is distinct from auth.uid()
    or t.owner_user_id is distinct from auth.uid()
    or t.organization_id is distinct from c.organization_id
    or t.project_id is distinct from c.project_id
    or not engineering_private.engineering_access(c.organization_id,c.project_id) then
    raise exception 'ovd563_review_unavailable' using errcode=permission_denied_code;
  end if;
  select * into f from engineering_private.native_finalizations where task_id=t.id;
  if f.task_id is null or t.execution_state<>'succeeded' or t.verification_state<>'passed' then
    if c.head_snapshot_id is distinct from p_candidate_snapshot_id then
      raise exception 'ovd563_stale_review' using errcode='PT409';
    end if;
    return jsonb_build_object(status_key,'unavailable','reason','not_verified');
  end if;
  if f.snapshot_id is distinct from p_candidate_snapshot_id
    or c.head_snapshot_id is distinct from f.snapshot_id then
    raise exception 'ovd563_stale_review' using errcode='PT409';
  end if;
  select * into review from engineering_private.native_step_reviews where task_id=t.id;
  if review.task_id is null then
    return jsonb_build_object(status_key,'unavailable','reason','not_exported');
  end if;
  payload := f.payload_text::jsonb;
  if review.conversation_id is distinct from c.id
    or review.organization_id is distinct from c.organization_id
    or review.project_id is distinct from c.project_id
    or review.owner_user_id is distinct from auth.uid()
    or review.attempt_id is distinct from f.attempt_id
    or review.source_snapshot_id is distinct from (payload->>'inputSnapshotId')::uuid
    or review.candidate_snapshot_id is distinct from f.snapshot_id
    or review.candidate_context_sha256 is distinct from payload->>context_digest_key
    or review.result_sha256 is distinct from payload->>result_digest_key
    or review.candidate_context_sha256 is distinct from
      engineering_private.sha256_hex(convert_to(f.candidate_context_text,'UTF8'))
    or review.step_sha256 is distinct from engineering_private.sha256_hex(review.step_bytes) then
    raise exception 'ovd563_review_integrity_failure' using errcode=permission_denied_code;
  end if;
  return jsonb_build_object(status_key,'ready','taskId',t.id,'attemptId',review.attempt_id,
    'sourceSnapshotId',review.source_snapshot_id,'candidateSnapshotId',review.candidate_snapshot_id,
    context_digest_key,review.candidate_context_sha256,result_digest_key,review.result_sha256,
    'exportId',review.export_id,'sourceCommit',review.source_commit,
    'reportSha256',review.report_sha256,'stepSha256',review.step_sha256,
    'stepBytes',octet_length(review.step_bytes),
    'stepBase64',translate(encode(review.step_bytes,'base64'),E'\n\r',''));
end $body$;
revoke all on function public.api_read_native_step_review(uuid,uuid,uuid)
  from public,anon,service_role,engineering_native_verifier;
grant execute on function public.api_read_native_step_review(uuid,uuid,uuid) to authenticated;
commit;
