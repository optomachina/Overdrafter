-- Free quote allowance is independent of commercial entitlements and spend.
-- No policy, window, limit, subject or enrollment is seeded by this migration.
-- Disable new eligibility for rollback; retain receipts and lifecycle fencing.

create table private.free_quote_policies (
  id uuid primary key default gen_random_uuid(),
  revision text not null unique check (length(trim(revision)) between 1 and 200),
  enabled boolean not null,
  subject_kind text not null check (subject_kind in ('organization', 'user')),
  completed_limit integer not null check (completed_limit > 0),
  window_start timestamptz not null,
  window_end timestamptz not null,
  check (isfinite(window_start) and isfinite(window_end) and window_start < window_end),
  -- Disabled historical revisions still exclude overlap: no revision reset.
  exclude using gist (tstzrange(window_start, window_end, '[)') with &&)
);
create table private.free_quote_buckets (
  id uuid primary key,
  policy_id uuid not null references private.free_quote_policies(id) on delete restrict,
  subject_kind text not null check (subject_kind in ('organization', 'user')),
  subject_id uuid not null,
  unique (policy_id, subject_kind, subject_id)
);
create table private.quote_access_admissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  actor_user_id uuid not null,
  job_id uuid not null,
  quote_request_id uuid not null unique,
  quote_run_id uuid not null unique,
  permit_id uuid not null unique,
  approval_reference uuid not null,
  scope_version integer not null check (scope_version > 0),
  scope_fingerprint text not null check (scope_fingerprint ~ '^[a-f0-9]{64}$'),
  notice_revision text not null,
  admission_source text not null check (admission_source in ('commercial_entitlement', 'free_beta')),
  bucket_id uuid references private.free_quote_buckets(id) on delete restrict,
  policy_revision text,
  state text not null check (state in ('unmetered', 'reserved', 'consumed', 'released')),
  created_at timestamptz not null default clock_timestamp(),
  terminal_at timestamptz,
  outcome_reason text,
  -- Evidence survives deletion/invalidation of mutable canonical offer rows.
  qualifying_offer_id uuid,
  qualifying_evidence jsonb,
  unique (organization_id, approval_reference),
  check (isfinite(created_at) and (terminal_at is null or isfinite(terminal_at))),
  check ((admission_source = 'commercial_entitlement' and state = 'unmetered'
          and bucket_id is null and policy_revision is null)
      or (admission_source = 'free_beta' and state <> 'unmetered'
          and bucket_id is not null and policy_revision is not null)),
  check ((state in ('reserved', 'unmetered') and terminal_at is null and outcome_reason is null
          and qualifying_offer_id is null and qualifying_evidence is null)
      or (state = 'released' and terminal_at is not null and outcome_reason is not null and outcome_reason in ('failed', 'canceled', 'no_usable_offer')
          and qualifying_offer_id is null and qualifying_evidence is null)
      or (state = 'consumed' and terminal_at is not null and outcome_reason is not null and outcome_reason = 'usable_quote'
          and qualifying_offer_id is not null and qualifying_evidence is not null and jsonb_typeof(qualifying_evidence) = 'object'))
);
create index quote_access_admissions_bucket_occupied on private.quote_access_admissions(bucket_id)
  where state in ('reserved', 'consumed');

alter table private.free_quote_policies enable row level security;
alter table private.free_quote_policies force row level security;
alter table private.free_quote_buckets enable row level security;
alter table private.free_quote_buckets force row level security;
alter table private.quote_access_admissions enable row level security;
alter table private.quote_access_admissions force row level security;
revoke all on private.free_quote_policies, private.free_quote_buckets, private.quote_access_admissions
  from public, anon, authenticated, service_role;

create function private.lock_free_quote_configuration_write()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('free-quote-config', 0));
  return null;
end;
$$;
create trigger free_quote_configuration_lock before insert or update or delete on private.free_quote_policies
  for each statement execute function private.lock_free_quote_configuration_write();
create function private.guard_free_quote_policy_mutation()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' or (to_jsonb(new) - 'enabled') is distinct from (to_jsonb(old) - 'enabled') then
    raise exception 'free_quote_policy_immutable';
  end if;
  return new;
end;
$$;
create trigger free_quote_policy_immutable before update or delete on private.free_quote_policies
  for each row execute function private.guard_free_quote_policy_mutation();
create trigger free_quote_bucket_immutable before update or delete on private.free_quote_buckets
  for each row execute function private.reject_founding_beta_evidence_mutation();
create function private.guard_quote_access_admission_mutation()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' then raise exception 'quote_access_admission_immutable'; end if;
  if (to_jsonb(new) - array['state','terminal_at','outcome_reason','qualifying_offer_id','qualifying_evidence'])
      is distinct from
     (to_jsonb(old) - array['state','terminal_at','outcome_reason','qualifying_offer_id','qualifying_evidence'])
    or old.state <> 'reserved' or new.state not in ('consumed', 'released') then
    raise exception 'quote_access_admission_immutable';
  end if;
  return new;
end;
$$;
create trigger quote_access_admission_immutable before update or delete on private.quote_access_admissions
  for each row execute function private.guard_quote_access_admission_mutation();

create function private.resolve_free_quote_policy(p_job_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_org uuid;
  v_policy private.free_quote_policies%rowtype;
  v_subject uuid;
  v_at timestamptz := pg_catalog.clock_timestamp();
begin
  select organization_id into v_org from public.jobs where id = p_job_id;
  if v_org is null or p_actor_user_id is null then
    return jsonb_build_object('configured', false, 'reasonCode', 'free_policy_unavailable');
  end if;
  select * into v_policy from private.free_quote_policies
    where enabled and window_start <= v_at and window_end > v_at;
  if v_policy.id is null then
    return jsonb_build_object('configured', false, 'reasonCode', 'free_policy_unavailable');
  end if;
  v_subject := case v_policy.subject_kind when 'organization' then v_org else p_actor_user_id end;
  return jsonb_build_object('configured', true, 'reasonCode', 'eligible', 'policyRevision', v_policy.revision,
    'policyId', v_policy.id, 'subjectKind', v_policy.subject_kind, 'subjectId', v_subject,
    'bucketId', md5('free-quote-bucket:' || v_policy.id::text || ':' || v_policy.subject_kind || ':' || v_subject::text)::uuid,
    'windowStart', v_policy.window_start, 'windowEnd', v_policy.window_end, 'completedLimit', v_policy.completed_limit);
end;
$$;

create function private.lock_free_quote_capacity(p_job_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_org uuid;
  v_key text;
  v_policy jsonb;
begin
  perform public.require_verified_auth();
  if not public.user_can_edit_job(p_job_id) then raise exception 'quote_access_forbidden'; end if;
  select organization_id into strict v_org from public.jobs where id = p_job_id;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'free_quote_isolation_unsupported'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('free-quote-config', 0));
  for v_key in select key from unnest(array['free-quote-subject:organization:' || v_org::text,
    'free-quote-subject:user:' || auth.uid()::text]) as keys(key) order by key loop
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  end loop;
  -- Fresh statement after waiting; no configuration/capacity rejection before replay.
  v_policy := private.resolve_free_quote_policy(p_job_id, auth.uid());
  if (v_policy ->> 'configured')::boolean then
    insert into private.free_quote_buckets(id, policy_id, subject_kind, subject_id)
    values ((v_policy ->> 'bucketId')::uuid, (v_policy ->> 'policyId')::uuid,
      v_policy ->> 'subjectKind', (v_policy ->> 'subjectId')::uuid)
    on conflict (id) do nothing;
  end if;
  return jsonb_build_object('bucketId', v_policy -> 'bucketId', 'reasonCode', v_policy ->> 'reasonCode');
end;
$$;

-- Called by the access owner only after its independently authorized permit insert.
-- resolve_quote_access is supplied by the following admission migration.
create function private.record_quote_access_admission(
  p_quote_request_id uuid, p_approval_reference uuid, p_admission_source text, p_bucket_id uuid
)
returns uuid language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_existing private.quote_access_admissions%rowtype;
  v_policy jsonb;
  v_access jsonb;
  v_limit integer;
  v_occupied bigint;
  v_id uuid;
begin
  select * into strict v_permit from private.xometry_beta_dispatch_permits
    where quote_request_id = p_quote_request_id and approval_reference = p_approval_reference;
  if v_permit.actor_user_id is distinct from auth.uid() then raise exception 'quote_access_identity_mismatch'; end if;
  select * into v_existing from private.quote_access_admissions where quote_request_id = p_quote_request_id;
  if v_existing.id is not null then
    if v_existing.permit_id <> v_permit.id or v_existing.approval_reference <> p_approval_reference
      or v_existing.admission_source is distinct from p_admission_source
      or v_existing.bucket_id is distinct from p_bucket_id then raise exception 'quote_access_identity_mismatch'; end if;
    return v_existing.id;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'free_quote_isolation_unsupported'; end if;
  -- This recheck must not acquire locks below an already held job lock.
  -- The two-key advisory locks must already be held by the admitted wrapper.
  if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
      and granted and mode in ('ShareLock','ExclusiveLock')
      and classid = ((hashtextextended('free-quote-config', 0) >> 32) & 4294967295)::oid
      and objid = (hashtextextended('free-quote-config', 0) & 4294967295)::oid and objsubid = 1) then
    raise exception 'free_quote_admission_lock_required';
  end if;
  if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
      and granted and mode = 'ExclusiveLock'
      and classid = ((hashtextextended('free-quote-subject:organization:' || v_permit.organization_id::text, 0) >> 32) & 4294967295)::oid
      and objid = (hashtextextended('free-quote-subject:organization:' || v_permit.organization_id::text, 0) & 4294967295)::oid and objsubid = 1)
    or not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
      and granted and mode = 'ExclusiveLock'
      and classid = ((hashtextextended('free-quote-subject:user:' || v_permit.actor_user_id::text, 0) >> 32) & 4294967295)::oid
      and objid = (hashtextextended('free-quote-subject:user:' || v_permit.actor_user_id::text, 0) & 4294967295)::oid and objsubid = 1) then
    raise exception 'free_quote_admission_lock_required';
  end if;
  if not exists (
    select 1 from public.quote_requests request_row
    join public.quote_runs run on run.id = v_permit.quote_run_id and run.quote_request_id = request_row.id
    join public.quote_request_lanes lane on lane.id = v_permit.quote_request_lane_id
    join public.vendor_quote_results result on result.id = v_permit.vendor_quote_result_id
    where request_row.id = p_quote_request_id and request_row.organization_id = v_permit.organization_id
      and request_row.job_id = v_permit.job_id and request_row.requested_by = v_permit.actor_user_id
      and request_row.status = 'queued' and result.status = 'queued'
      and run.organization_id = v_permit.organization_id and run.job_id = v_permit.job_id
      and lane.organization_id = v_permit.organization_id and lane.quote_request_id = request_row.id
      and lane.quote_run_id = run.id and lane.vendor_quote_result_id = result.id
      and lane.scope_version = v_permit.scope_version and lane.scope_fingerprint = v_permit.scope_fingerprint
      and lane.part_id = v_permit.part_id and lane.vendor = v_permit.provider and lane.requested_quantity = 1
      and result.quote_run_id = run.id and result.organization_id = v_permit.organization_id
      and result.part_id = lane.part_id and result.vendor = lane.vendor and result.requested_quantity = lane.requested_quantity
  ) or (select count(*) from public.quote_request_lanes where quote_request_id = p_quote_request_id) <> 1 then
    raise exception 'quote_access_identity_mismatch';
  end if;
  v_access := private.resolve_quote_access(v_permit.job_id, v_permit.actor_user_id);
  if v_access ->> 'state' is distinct from 'eligible' or v_access ->> 'source' is distinct from p_admission_source then
    raise exception 'quote_access_changed';
  end if;
  if p_admission_source = 'free_beta' then
    v_policy := private.resolve_free_quote_policy(v_permit.job_id, v_permit.actor_user_id);
    if (v_policy ->> 'configured')::boolean is not true or (v_policy ->> 'bucketId')::uuid is distinct from p_bucket_id
      or not exists (select 1 from private.free_quote_buckets where id = p_bucket_id
        and policy_id = (v_policy ->> 'policyId')::uuid and subject_kind = v_policy ->> 'subjectKind'
        and subject_id = (v_policy ->> 'subjectId')::uuid) then raise exception 'free_policy_unavailable'; end if;
    v_limit := (v_policy ->> 'completedLimit')::integer;
    select count(*) into v_occupied from private.quote_access_admissions
      where bucket_id = p_bucket_id and state in ('reserved', 'consumed');
    if v_occupied >= v_limit then raise exception 'free_allowance_unavailable'; end if;
  elsif p_admission_source <> 'commercial_entitlement' or p_bucket_id is not null then
    raise exception 'quote_access_source_invalid';
  end if;
  insert into private.quote_access_admissions(organization_id, actor_user_id, job_id, quote_request_id,
    quote_run_id, permit_id, approval_reference, scope_version, scope_fingerprint, notice_revision,
    admission_source, bucket_id, policy_revision, state)
  values (v_permit.organization_id, v_permit.actor_user_id, v_permit.job_id, p_quote_request_id,
    v_permit.quote_run_id, v_permit.id, p_approval_reference, v_permit.scope_version, v_permit.scope_fingerprint,
    v_permit.notice_revision, p_admission_source, p_bucket_id, v_policy ->> 'policyRevision',
    case when p_admission_source = 'free_beta' then 'reserved' else 'unmetered' end)
  returning id into v_id;
  return v_id;
end;
$$;

create function private.validate_quote_access_admission(p_quote_request_id uuid, p_permit_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare v_row private.quote_access_admissions%rowtype; v_permit private.xometry_beta_dispatch_permits%rowtype;
begin
  select * into v_row from private.quote_access_admissions where quote_request_id = p_quote_request_id;
  if v_row.id is null then
    return jsonb_build_object('valid', false, 'source', null, 'state', null, 'reasonCode', 'legacy_unrecorded');
  end if;
  select * into v_permit from private.xometry_beta_dispatch_permits where id = p_permit_id;
  if v_permit.id is null or v_row.permit_id <> p_permit_id or v_row.quote_request_id <> v_permit.quote_request_id
    or v_row.quote_run_id <> v_permit.quote_run_id or v_row.organization_id <> v_permit.organization_id
    or v_row.actor_user_id <> v_permit.actor_user_id or v_row.job_id <> v_permit.job_id
    or v_row.scope_fingerprint <> v_permit.scope_fingerprint or v_row.scope_version <> v_permit.scope_version
    or v_row.notice_revision <> v_permit.notice_revision or v_row.approval_reference <> v_permit.approval_reference then
    return jsonb_build_object('valid', false, 'source', null, 'state', null, 'reasonCode', 'quote_access_identity_mismatch');
  end if;
  if v_row.admission_source = 'free_beta' and not exists (
    select 1 from private.free_quote_buckets bucket join private.free_quote_policies policy on policy.id = bucket.policy_id
    where bucket.id = v_row.bucket_id and policy.revision = v_row.policy_revision and policy.enabled
      and bucket.subject_kind = policy.subject_kind
      and bucket.subject_id = case policy.subject_kind when 'organization' then v_row.organization_id else v_row.actor_user_id end
  ) then
    return jsonb_build_object('valid', false, 'source', v_row.admission_source, 'state', v_row.state, 'reasonCode', 'free_policy_unavailable');
  end if;
  -- Valid is receipt identity, NOT worker execution permission; worker requires reserved.
  return jsonb_build_object('valid', true, 'source', v_row.admission_source, 'state', v_row.state, 'reasonCode', 'eligible');
end;
$$;

create function private.free_quote_capacity(p_job_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare v_policy jsonb; v_consumed bigint; v_reserved bigint;
begin
  perform public.require_verified_auth();
  if not public.user_can_edit_job(p_job_id) then raise exception 'quote_access_forbidden'; end if;
  v_policy := private.resolve_free_quote_policy(p_job_id, auth.uid());
  if (v_policy ->> 'configured')::boolean is not true then
    return jsonb_build_object('configured', false, 'eligible', false, 'reasonCode', 'free_policy_unavailable',
      'policyRevision', null, 'windowStart', null, 'windowEnd', null, 'completedLimit', null,
      'completedCount', null, 'reservedCount', null, 'remaining', null);
  end if;
  select count(*) filter (where state = 'consumed'), count(*) filter (where state = 'reserved')
    into v_consumed, v_reserved from private.quote_access_admissions where bucket_id = (v_policy ->> 'bucketId')::uuid;
  return jsonb_build_object('configured', true, 'eligible', true, 'reasonCode', 'eligible',
    'policyRevision', v_policy -> 'policyRevision', 'windowStart', v_policy -> 'windowStart', 'windowEnd', v_policy -> 'windowEnd',
    'completedLimit', v_policy -> 'completedLimit', 'completedCount', v_consumed, 'reservedCount', v_reserved,
    'remaining', greatest((v_policy ->> 'completedLimit')::bigint - v_consumed - v_reserved, 0));
end;
$$;

create function private.release_cancelled_free_quote_job(p_quote_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare v_request public.quote_requests%rowtype; v_row private.quote_access_admissions%rowtype;
begin
  select * into v_request from public.quote_requests where id = p_quote_request_id for update;
  select * into v_row from private.quote_access_admissions where quote_request_id = p_quote_request_id for update;
  if v_row.id is null or v_row.state <> 'reserved' or v_request.status is distinct from 'canceled'::public.quote_request_status then
    return jsonb_build_object('state', v_row.state, 'reasonCode', 'unchanged', 'changed', false);
  end if;
  -- Cancellation holds request -> receipt only. Read the pinned run/permit
  -- without result/offer locks; broken identity retains its hold for diagnosis.
  -- Policy enabled state is deliberately irrelevant to terminal accounting.
  if v_request.organization_id <> v_row.organization_id or v_request.job_id <> v_row.job_id
    or v_request.requested_by <> v_row.actor_user_id
    or not exists (
      select 1 from public.quote_runs run
      join private.xometry_beta_dispatch_permits permit on permit.id = v_row.permit_id
      where run.id = v_row.quote_run_id and run.quote_request_id = v_row.quote_request_id
        and run.organization_id = v_row.organization_id and run.job_id = v_row.job_id
        and permit.quote_request_id = v_row.quote_request_id and permit.quote_run_id = v_row.quote_run_id
        and permit.organization_id = v_row.organization_id and permit.job_id = v_row.job_id
        and permit.actor_user_id = v_row.actor_user_id and permit.approval_reference = v_row.approval_reference
        and permit.scope_version = v_row.scope_version and permit.scope_fingerprint = v_row.scope_fingerprint
        and permit.notice_revision = v_row.notice_revision
    ) then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'identity_indeterminate', 'changed', false);
  end if;
  update private.quote_access_admissions set state = 'released', terminal_at = clock_timestamp(), outcome_reason = 'canceled'
    where id = v_row.id;
  return jsonb_build_object('state', 'released', 'reasonCode', 'canceled', 'changed', true);
end;
$$;

-- Settlement reads canonical evidence; it never locks/writes results or offers.
create function private.finalize_free_quote_job(p_quote_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  v_request public.quote_requests%rowtype;
  v_row private.quote_access_admissions%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_offer public.vendor_quote_offers%rowtype;
  v_at timestamptz;
  v_reason text;
begin
  select * into v_request from public.quote_requests where id = p_quote_request_id for update;
  select * into v_row from private.quote_access_admissions where quote_request_id = p_quote_request_id for update;
  if v_row.id is null or v_row.state <> 'reserved' then
    return jsonb_build_object('state', v_row.state, 'reasonCode', 'unchanged', 'changed', false);
  end if;
  if v_request.id is null or v_request.organization_id <> v_row.organization_id
    or v_request.job_id <> v_row.job_id or v_request.requested_by <> v_row.actor_user_id then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'identity_indeterminate', 'changed', false);
  end if;
  if v_request.status = 'canceled' then return private.release_cancelled_free_quote_job(p_quote_request_id); end if;
  select * into v_permit from private.xometry_beta_dispatch_permits where id = v_row.permit_id;
  select * into v_lane from public.quote_request_lanes where id = v_permit.quote_request_lane_id;
  select * into v_result from public.vendor_quote_results where id = v_permit.vendor_quote_result_id;
  if v_permit.id is null or v_lane.id is null or v_result.id is null
    or v_permit.quote_request_id <> v_row.quote_request_id or v_permit.quote_run_id <> v_row.quote_run_id
    or v_permit.organization_id <> v_row.organization_id or v_permit.actor_user_id <> v_row.actor_user_id
    or v_permit.job_id <> v_row.job_id or v_permit.approval_reference <> v_row.approval_reference
    or v_permit.notice_revision <> v_row.notice_revision or v_permit.scope_version <> v_row.scope_version
    or v_permit.scope_fingerprint <> v_row.scope_fingerprint
    or v_lane.organization_id <> v_row.organization_id or v_lane.quote_request_id <> v_row.quote_request_id
    or v_lane.quote_run_id <> v_row.quote_run_id or v_lane.vendor_quote_result_id <> v_result.id
    or v_lane.scope_version <> v_row.scope_version or v_lane.scope_fingerprint <> v_row.scope_fingerprint
    or v_lane.part_id <> v_permit.part_id or v_lane.vendor <> v_permit.provider or v_lane.requested_quantity <> 1
    or v_result.quote_run_id <> v_row.quote_run_id or v_result.organization_id <> v_row.organization_id
    or v_result.part_id <> v_lane.part_id or v_result.vendor <> v_lane.vendor
    or v_result.requested_quantity <> v_lane.requested_quantity
    or (select count(*) from public.quote_request_lanes where quote_request_id = v_row.quote_request_id) <> 1
    or not exists (select 1 from public.quote_runs where id = v_row.quote_run_id
      and quote_request_id = v_row.quote_request_id and organization_id = v_row.organization_id and job_id = v_row.job_id) then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'identity_indeterminate', 'changed', false);
  end if;
  if v_result.status in ('queued', 'running') then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'in_flight', 'changed', false);
  end if;
  -- A worker task may still be 'running' while cleaning up a committed terminal
  -- result. The result status (queued/running vs terminal), not cleanup, is authority.
  if v_result.status not in ('failed', 'manual_review_pending', 'manual_vendor_followup',
    'instant_quote_received', 'official_quote_received') then
    return jsonb_build_object('state', 'reserved', 'reasonCode', 'outcome_indeterminate', 'changed', false);
  end if;
  v_at := clock_timestamp();
  if v_result.status in ('instant_quote_received', 'official_quote_received') then
    select offer.* into v_offer from public.vendor_quote_offers offer
    where offer.vendor_quote_result_id = v_result.id and offer.organization_id = v_row.organization_id
      and offer.provenance_status in ('trusted_adapter', 'manual_verified') and offer.invalidated_at is null
      and (offer.unit_price_usd is not null or offer.total_price_usd is not null)
      and (offer.unit_price_usd is null or (offer.unit_price_usd::text not in ('NaN','Infinity','-Infinity') and offer.unit_price_usd >= 0))
      and (offer.total_price_usd is null or (offer.total_price_usd::text not in ('NaN','Infinity','-Infinity') and offer.total_price_usd >= 0))
      and offer.quoted_at is not null and isfinite(offer.quoted_at) and offer.quoted_at <= v_at
      and offer.valid_until is not null and isfinite(offer.valid_until)
      and offer.valid_until >= offer.quoted_at and offer.valid_until >= v_at
      and exists (select 1 from private.quote_lane_candidates(v_row.job_id, array['xometry']::public.vendor_name[]) candidate
        where candidate.organization_id = v_row.organization_id and candidate.part_id = v_lane.part_id
          and candidate.vendor = v_lane.vendor and candidate.requested_quantity = v_lane.requested_quantity
          and candidate.scope_version = v_row.scope_version and candidate.scope_fingerprint = v_row.scope_fingerprint)
    order by offer.valid_until desc, offer.id limit 1;
  end if;
  if v_offer.id is not null then
    update private.quote_access_admissions set state = 'consumed', terminal_at = v_at, outcome_reason = 'usable_quote',
      qualifying_offer_id = v_offer.id,
      qualifying_evidence = jsonb_build_object('schema', 'free-quote-completion.v1', 'offerId', v_offer.id,
        'resultId', v_result.id, 'scopeFingerprint', v_row.scope_fingerprint, 'observedAt', v_at,
        'quotedAt', v_offer.quoted_at, 'validUntil', v_offer.valid_until, 'provenance', v_offer.provenance_status,
        'unitPriceUsd', v_offer.unit_price_usd, 'totalPriceUsd', v_offer.total_price_usd, 'outcome', 'complete')
    where id = v_row.id;
    return jsonb_build_object('state', 'consumed', 'reasonCode', 'usable_quote', 'changed', true);
  end if;
  v_reason := case when v_result.status in ('failed','manual_review_pending','manual_vendor_followup') then 'failed' else 'no_usable_offer' end;
  update private.quote_access_admissions set state = 'released', terminal_at = v_at, outcome_reason = v_reason where id = v_row.id;
  return jsonb_build_object('state', 'released', 'reasonCode', v_reason, 'changed', true);
end;
$$;

create function private.fence_free_quote_result()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare v_request_id uuid; v_request_status public.quote_request_status; v_state text;
begin
  select admission.quote_request_id into v_request_id from private.quote_access_admissions admission
    where admission.quote_run_id = new.quote_run_id and admission.admission_source = 'free_beta';
  if v_request_id is null then return new; end if;
  -- The result row is already locked by UPDATE. Read status ONLY after the request
  -- row lock is obtained, before the existing AFTER result-status reducer.
  select status into v_request_status from public.quote_requests where id = v_request_id for update;
  select state into v_state from private.quote_access_admissions where quote_request_id = v_request_id;
  if v_request_status = 'canceled' or v_state = 'released' then raise exception 'free_quote_terminal_fenced'; end if;
  if v_state = 'consumed' and new.status not in ('instant_quote_received', 'official_quote_received') then
    raise exception 'free_quote_terminal_fenced';
  end if;
  return new;
end;
$$;
create trigger fence_free_quote_result before update of status on public.vendor_quote_results
  for each row execute function private.fence_free_quote_result();

create function private.settle_terminal_free_quote_result()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare v_request_id uuid; v_current_status public.vendor_status;
begin
  -- SET CONSTRAINTS ALL IMMEDIATE must not classify success before offers exist.
  if new.status not in ('failed','manual_review_pending','manual_vendor_followup') then return null; end if;
  select status into v_current_status from public.vendor_quote_results where id = new.id;
  if v_current_status not in ('failed','manual_review_pending','manual_vendor_followup') then return null; end if;
  select quote_request_id into v_request_id from private.quote_access_admissions
    where quote_run_id = new.quote_run_id and admission_source = 'free_beta' and state = 'reserved';
  if v_request_id is not null then perform private.finalize_free_quote_job(v_request_id); end if;
  return null;
end;
$$;
create constraint trigger settle_terminal_free_quote_result after update of status on public.vendor_quote_results
  deferrable initially deferred for each row execute function private.settle_terminal_free_quote_result();

create or replace function public.reconcile_vendor_quote_offers(
  p_vendor_quote_result_id uuid,
  p_result jsonb,
  p_offers jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_offers jsonb := coalesce(p_offers, '[]'::jsonb);
  v_request_id uuid;
  v_request_status public.quote_request_status;
  v_meter_state text;
begin
  -- Metered canonical writer: result -> request -> offers -> receipt.
  -- Legacy/commercial behavior is retained; no offer-only meter trigger exists.
  select admission.quote_request_id into v_request_id
  from public.vendor_quote_results result
  join private.quote_access_admissions admission on admission.quote_run_id = result.quote_run_id
  where result.id = p_vendor_quote_result_id and admission.admission_source = 'free_beta';
  if v_request_id is not null then
    perform 1 from public.vendor_quote_results where id = p_vendor_quote_result_id for update;
    select status into v_request_status from public.quote_requests where id = v_request_id for update;
    select state into v_meter_state from private.quote_access_admissions where quote_request_id = v_request_id;
    if v_request_status = 'canceled' or v_meter_state = 'released' then raise exception 'free_quote_terminal_fenced'; end if;
  end if;
  if pg_catalog.jsonb_typeof(p_result) <> 'object' then
    raise exception 'Vendor quote result finalization must be a JSON object.';
  end if;

  if pg_catalog.jsonb_typeof(v_offers) <> 'array' then
    raise exception 'Vendor quote offers must be a JSON array.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_offers) as entry(value)
    where nullif(entry.value ->> 'vendor_quote_result_id', '')::uuid
      is distinct from p_vendor_quote_result_id
  ) then
    raise exception 'Every offer must belong to vendor quote result %.', p_vendor_quote_result_id;
  end if;

  update public.vendor_quote_results
  set status = (p_result ->> 'status')::public.vendor_status,
      unit_price_usd = (p_result ->> 'unit_price_usd')::numeric,
      total_price_usd = (p_result ->> 'total_price_usd')::numeric,
      lead_time_business_days = (p_result ->> 'lead_time_business_days')::integer,
      quote_url = p_result ->> 'quote_url',
      dfm_issues = p_result -> 'dfm_issues',
      notes = p_result -> 'notes',
      raw_payload = p_result -> 'raw_payload',
      updated_at = pg_catalog.timezone('utc', pg_catalog.now())
  where id = p_vendor_quote_result_id;

  if not found then
    raise exception 'Vendor quote result % was not found.', p_vendor_quote_result_id;
  end if;

  insert into public.vendor_quote_offers (
    vendor_quote_result_id,
    organization_id,
    offer_key,
    supplier,
    lane_label,
    sourcing,
    geographic_origin,
    tier,
    quote_ref,
    quote_date,
    quoted_at,
    valid_until,
    validity_duration_days,
    validity_source,
    validity_terms,
    provenance_status,
    unit_price_usd,
    total_price_usd,
    lead_time_business_days,
    ship_receive_by,
    process,
    material,
    finish,
    tightest_tolerance,
    notes,
    sort_rank,
    raw_payload
  )
  select
    offer.vendor_quote_result_id,
    offer.organization_id,
    offer.offer_key,
    offer.supplier,
    offer.lane_label,
    offer.sourcing,
    offer.geographic_origin,
    offer.tier,
    offer.quote_ref,
    offer.quote_date,
    offer.quoted_at,
    offer.valid_until,
    offer.validity_duration_days,
    offer.validity_source,
    offer.validity_terms,
    offer.provenance_status,
    offer.unit_price_usd,
    offer.total_price_usd,
    offer.lead_time_business_days,
    offer.ship_receive_by,
    offer.process,
    offer.material,
    offer.finish,
    offer.tightest_tolerance,
    offer.notes,
    offer.sort_rank,
    offer.raw_payload
  from pg_catalog.jsonb_populate_recordset(
    null::public.vendor_quote_offers,
    v_offers
  ) as offer
  on conflict (vendor_quote_result_id, offer_key) do update
  set organization_id = excluded.organization_id,
      supplier = excluded.supplier,
      lane_label = excluded.lane_label,
      sourcing = excluded.sourcing,
      geographic_origin = excluded.geographic_origin,
      tier = excluded.tier,
      quote_ref = excluded.quote_ref,
      quote_date = excluded.quote_date,
      quoted_at = excluded.quoted_at,
      valid_until = excluded.valid_until,
      validity_duration_days = excluded.validity_duration_days,
      validity_source = excluded.validity_source,
      validity_terms = excluded.validity_terms,
      provenance_status = excluded.provenance_status,
      unit_price_usd = excluded.unit_price_usd,
      total_price_usd = excluded.total_price_usd,
      lead_time_business_days = excluded.lead_time_business_days,
      ship_receive_by = excluded.ship_receive_by,
      process = excluded.process,
      material = excluded.material,
      finish = excluded.finish,
      tightest_tolerance = excluded.tightest_tolerance,
      notes = excluded.notes,
      sort_rank = excluded.sort_rank,
      raw_payload = excluded.raw_payload,
      updated_at = pg_catalog.timezone('utc', pg_catalog.now());

  delete from public.vendor_quote_offers as existing
  where existing.vendor_quote_result_id = p_vendor_quote_result_id
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_offers) as entry(value)
      where entry.value ->> 'offer_key' = existing.offer_key
    );
  if v_request_id is not null then
    perform private.finalize_free_quote_job(v_request_id);
  end if;
end;
$$;

revoke all on function public.reconcile_vendor_quote_offers(uuid, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.reconcile_vendor_quote_offers(uuid, jsonb, jsonb)
to service_role;

comment on function public.reconcile_vendor_quote_offers(uuid, jsonb, jsonb) is
  'Atomically finalizes the parent quote result, upserts its complete current offer set, and removes stale rows while preserving administrative invalidation fields on stable keys.';

create or replace function public.api_cancel_quote_request(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.quote_requests%rowtype;
  v_quote_run public.quote_runs%rowtype;
  v_has_terminal_vendor_outcome boolean := false;
  v_canceled_at timestamptz := timezone('utc', now());
begin
  perform public.require_verified_auth();

  select *
  into v_request
  from public.quote_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    return jsonb_build_object(
      'jobId', null,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'status', 'not_requested',
      'reasonCode', 'not_found',
      'reason', 'Quote request not found.'
    );
  end if;

  if not public.user_can_edit_job(v_request.job_id) then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', null,
      'status', v_request.status,
      'reasonCode', 'forbidden',
      'reason', 'You do not have permission to cancel this quote request.'
    );
  end if;

  select *
  into v_quote_run
  from public.quote_runs
  where quote_request_id = v_request.id
  order by created_at desc, id desc
  limit 1
  for update;

  if v_request.status = 'canceled' then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'already_canceled',
      'reason', 'This quote request is already canceled.'
    );
  end if;

  if v_request.status = 'received' then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'already_received',
      'reason', 'A quote response has already been received for this request.'
    );
  end if;

  if v_request.status not in ('queued', 'requesting') then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'not_cancelable',
      'reason', 'Only queued or requesting quote requests can be canceled.'
    );
  end if;

  if v_quote_run.id is not null then
    select exists(
      select 1
      from public.vendor_quote_results result
      where result.quote_run_id = v_quote_run.id
        and result.status in (
          'instant_quote_received',
          'official_quote_received',
          'manual_review_pending',
          'manual_vendor_followup'
        )
    )
    into v_has_terminal_vendor_outcome;
  end if;

  if v_has_terminal_vendor_outcome then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'not_cancelable',
      'reason', 'This quote request already produced a terminal vendor outcome and cannot be canceled.'
    );
  end if;

  update public.quote_requests
  set
    status = 'canceled',
    failure_reason = null,
    received_at = null,
    failed_at = null,
    canceled_at = v_canceled_at
  where id = v_request.id;

  if v_quote_run.id is not null then
    update public.work_queue
    set
      status = 'cancelled',
      locked_at = null,
      locked_by = null,
      last_error = 'Canceled by client request.',
      payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
        'canceledAt', v_canceled_at,
        'canceledBy', auth.uid(),
        'cancellationSource', 'client-request'
      )
    where quote_run_id = v_quote_run.id
      and task_type = 'run_vendor_quote'
      and status = 'queued';

    update public.quote_runs
    set status = 'failed'
    where id = v_quote_run.id;
  end if;

  update public.jobs
  set status = case
    when status in ('closed', 'client_selected') then status
    when status = 'quoting' then 'ready_to_quote'
    else status
  end
  where id = v_request.job_id;

  -- Request/run/queue/jobs locks already held; never acquire result or offer.
  perform private.release_cancelled_free_quote_job(v_request.id);

  perform public.log_audit_event(
    v_request.organization_id,
    'job.quote_request_canceled',
    jsonb_build_object(
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'requestedVendors', v_request.requested_vendors,
      'canceledAt', v_canceled_at,
      'clientTriggered', true
    ),
    v_request.job_id,
    null
  );

  return jsonb_build_object(
    'jobId', v_request.job_id,
    'accepted', true,
    'canceled', true,
    'quoteRequestId', v_request.id,
    'quoteRunId', v_quote_run.id,
    'status', 'canceled',
    'reasonCode', 'canceled',
    'reason', 'Quote request canceled.'
  );
end;
$$;

grant execute on function public.api_cancel_quote_request(uuid) to authenticated;


-- No direct client/service table or private helper authority. Existing SECURITY
-- DEFINER wrappers, owned by the migration owner, are the only entrypoints.
revoke all on function private.lock_free_quote_configuration_write(),
  private.guard_free_quote_policy_mutation(), private.guard_quote_access_admission_mutation(),
  private.resolve_free_quote_policy(uuid,uuid), private.lock_free_quote_capacity(uuid),
  private.record_quote_access_admission(uuid,uuid,text,uuid),
  private.validate_quote_access_admission(uuid,uuid), private.free_quote_capacity(uuid),
  private.release_cancelled_free_quote_job(uuid), private.finalize_free_quote_job(uuid),
  private.fence_free_quote_result(), private.settle_terminal_free_quote_result()
  from public, anon, authenticated, service_role;
