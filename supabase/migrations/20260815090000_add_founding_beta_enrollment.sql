-- OVD-364: add an explicit, audited Founding Beta enrollment boundary.
--
-- Enrollment is intentionally independent from billing entitlements and app
-- roles. An organization must have a current grant, and each acting member
-- must accept the current published notice, before creating a job or draft.

create table private.founding_beta_enrollment_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  actor_user_id uuid not null,
  action text not null,
  reason text not null,
  policy_revision text not null,
  terms_path text not null,
  privacy_path text not null,
  idempotency_key text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint founding_beta_enrollment_events_action_check
    check (action in ('grant', 'revoke')), -- NOSONAR: stable audit action literals
  constraint founding_beta_enrollment_events_reason_check
    check (pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 1000),
  constraint founding_beta_enrollment_events_idempotency_key_check
    check (pg_catalog.length(pg_catalog.btrim(idempotency_key)) between 1 and 200),
  unique (actor_user_id, idempotency_key)
);

create index founding_beta_enrollment_events_org_latest_idx
  on private.founding_beta_enrollment_events (organization_id, id desc);

create table private.founding_beta_notice_acceptances (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  user_id uuid not null,
  policy_revision text not null,
  terms_path text not null,
  privacy_path text not null,
  accepted_at timestamptz not null default pg_catalog.timezone('utc', pg_catalog.now()),
  unique (organization_id, user_id, policy_revision)
);

alter table private.founding_beta_enrollment_events enable row level security;
alter table private.founding_beta_enrollment_events force row level security;
alter table private.founding_beta_notice_acceptances enable row level security;
alter table private.founding_beta_notice_acceptances force row level security;

revoke all on private.founding_beta_enrollment_events
  from public, anon, authenticated, service_role;
revoke all on private.founding_beta_notice_acceptances
  from public, anon, authenticated, service_role;
revoke all on sequence private.founding_beta_enrollment_events_id_seq
  from public, anon, authenticated, service_role;
revoke all on sequence private.founding_beta_notice_acceptances_id_seq
  from public, anon, authenticated, service_role;

create or replace function private.reject_founding_beta_evidence_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Founding Beta evidence is append-only.';
end;
$$;

revoke all on function private.reject_founding_beta_evidence_mutation()
  from public, anon, authenticated, service_role;

create trigger founding_beta_enrollment_events_append_only
before update or delete on private.founding_beta_enrollment_events
for each row execute function private.reject_founding_beta_evidence_mutation();

create trigger founding_beta_notice_acceptances_append_only
before update or delete on private.founding_beta_notice_acceptances
for each row execute function private.reject_founding_beta_evidence_mutation();

create or replace function private.current_founding_beta_notice()
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'policyRevision', 'founding-beta-2026-08-15', -- NOSONAR: canonical notice contract
    'termsPath', '/legal/beta-terms', -- NOSONAR: canonical notice contract
    'privacyPath', '/legal/privacy' -- NOSONAR: canonical notice contract
  );
$$;

revoke all on function private.current_founding_beta_notice()
  from public, anon, authenticated, service_role;

create or replace function private.resolve_founding_beta_access_state(
  p_organization_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_notice jsonb := private.current_founding_beta_notice();
  v_latest_action text;
  v_state text;
begin
  select event_row.action
  into v_latest_action
  from private.founding_beta_enrollment_events event_row
  where event_row.organization_id = p_organization_id
  order by event_row.id desc
  limit 1;

  if v_latest_action is null then
    v_state := 'not_enrolled';
  elsif v_latest_action = 'revoke' then
    v_state := 'revoked';
  elsif not exists (
    select 1
    from private.founding_beta_notice_acceptances acceptance
    where acceptance.organization_id = p_organization_id
      and acceptance.user_id = p_user_id
      and acceptance.policy_revision = v_notice ->> 'policyRevision'
  ) then
    v_state := 'notice_required';
  else
    v_state := 'eligible';
  end if;

  return v_notice || pg_catalog.jsonb_build_object('state', v_state);
end;
$$;

revoke all on function private.resolve_founding_beta_access_state(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.current_user_has_current_founding_beta_access(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select auth.uid() is not null
    and private.resolve_founding_beta_access_state(
      p_organization_id,
      auth.uid()
    ) ->> 'state' = 'eligible';
$$;

revoke all on function public.current_user_has_current_founding_beta_access(uuid)
  from public, anon;
grant execute on function public.current_user_has_current_founding_beta_access(uuid)
  to authenticated;

create or replace function public.api_get_founding_beta_access_state(
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_organization_id uuid := p_organization_id;
begin
  perform public.require_verified_auth();

  if v_organization_id is null then
    v_organization_id := public.current_user_home_organization_id();
  end if;

  if v_organization_id is null then
    raise exception 'A home workspace is still being prepared for this account.';
  end if;

  if not public.user_can_access_org(v_organization_id) then
    raise exception 'You do not have access to this Founding Beta organization.';
  end if;

  return private.resolve_founding_beta_access_state(v_organization_id, auth.uid());
end;
$$;

revoke all on function public.api_get_founding_beta_access_state(uuid)
  from public, anon;
grant execute on function public.api_get_founding_beta_access_state(uuid)
  to authenticated;

create or replace function public.api_accept_founding_beta_notice(
  p_organization_id uuid,
  p_policy_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_notice jsonb := private.current_founding_beta_notice();
  v_latest_action text;
begin
  perform public.require_verified_auth();

  if not public.user_can_access_org(p_organization_id) then
    raise exception 'You do not have access to this Founding Beta organization.';
  end if;

  if pg_catalog.btrim(coalesce(p_policy_revision, ''))
    <> v_notice ->> 'policyRevision'
  then
    raise exception 'The current Founding Beta notice must be accepted.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_organization_id::text || ':' || auth.uid()::text || ':' || p_policy_revision,
      0
    )
  );

  select event_row.action
  into v_latest_action
  from private.founding_beta_enrollment_events event_row
  where event_row.organization_id = p_organization_id
  order by event_row.id desc
  limit 1;

  if v_latest_action is distinct from 'grant' then
    raise exception 'This organization is not currently enrolled in the Founding Beta.';
  end if;

  insert into private.founding_beta_notice_acceptances (
    organization_id,
    user_id,
    policy_revision,
    terms_path,
    privacy_path
  )
  values (
    p_organization_id,
    auth.uid(),
    v_notice ->> 'policyRevision',
    v_notice ->> 'termsPath',
    v_notice ->> 'privacyPath'
  )
  on conflict (organization_id, user_id, policy_revision) do nothing;

  return private.resolve_founding_beta_access_state(p_organization_id, auth.uid());
end;
$$;

revoke all on function public.api_accept_founding_beta_notice(uuid, text)
  from public, anon;
grant execute on function public.api_accept_founding_beta_notice(uuid, text)
  to authenticated;

create or replace function public.api_admin_set_founding_beta_enrollment(
  p_organization_id uuid,
  p_enrolled boolean,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_notice jsonb := private.current_founding_beta_notice();
  v_action text := case when p_enrolled then 'grant' else 'revoke' end;
  v_existing private.founding_beta_enrollment_events%rowtype;
  v_event_id bigint;
begin
  perform public.require_verified_auth();

  if not public.is_platform_admin() then
    raise exception 'Platform administrator access is required.';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for Founding Beta administration.';
  end if;

  if p_enrolled is null then
    raise exception 'Founding Beta enrollment intent is required.';
  end if;

  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = p_organization_id
  ) then
    raise exception 'Founding Beta organization was not found.';
  end if;

  if pg_catalog.length(pg_catalog.btrim(coalesce(p_reason, '')))
    not between 1 and 1000
  then
    raise exception 'A reason between 1 and 1000 characters is required.';
  end if;

  if pg_catalog.length(pg_catalog.btrim(coalesce(p_idempotency_key, '')))
    not between 1 and 200
  then
    raise exception 'An idempotency key between 1 and 200 characters is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'founding-beta:' || v_actor_user_id::text || ':'
        || pg_catalog.btrim(p_idempotency_key),
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('founding-beta:' || p_organization_id::text, 0)
  );

  select *
  into v_existing
  from private.founding_beta_enrollment_events event_row
  where event_row.actor_user_id = v_actor_user_id
    and event_row.idempotency_key = pg_catalog.btrim(p_idempotency_key);

  if v_existing.id is not null then
    if v_existing.organization_id is distinct from p_organization_id
      or v_existing.action is distinct from v_action
      or v_existing.reason is distinct from pg_catalog.btrim(p_reason)
    then
      raise exception 'Idempotency key has already been used for a different Founding Beta operation.';
    end if;

    return pg_catalog.jsonb_build_object(
      'eventId', v_existing.id,
      'replayed', true,
      'organizationId', p_organization_id, -- NOSONAR: stable public response key
      'enrolled', p_enrolled -- NOSONAR: stable public response key
    );
  end if;

  begin
    insert into private.founding_beta_enrollment_events (
      organization_id,
      actor_user_id,
      action,
      reason,
      policy_revision,
      terms_path,
      privacy_path,
      idempotency_key
    )
    values (
      p_organization_id,
      v_actor_user_id,
      v_action,
      pg_catalog.btrim(p_reason),
      v_notice ->> 'policyRevision',
      v_notice ->> 'termsPath',
      v_notice ->> 'privacyPath',
      pg_catalog.btrim(p_idempotency_key)
    )
    returning id into v_event_id;
  exception
    when unique_violation then
      raise exception 'Idempotency key has already been used for a different Founding Beta operation.';
  end;

  return pg_catalog.jsonb_build_object(
    'eventId', v_event_id,
    'replayed', false,
    'organizationId', p_organization_id,
    'enrolled', p_enrolled
  );
end;
$$;

revoke all on function public.api_admin_set_founding_beta_enrollment(
  uuid,
  boolean,
  text,
  text
) from public, anon;
grant execute on function public.api_admin_set_founding_beta_enrollment(
  uuid,
  boolean,
  text,
  text
) to authenticated;

create or replace function public.api_admin_get_founding_beta_enrollment(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_latest private.founding_beta_enrollment_events%rowtype;
begin
  perform public.require_verified_auth();

  if not public.is_platform_admin() then
    raise exception 'Platform administrator access is required.';
  end if;

  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = p_organization_id
  ) then
    raise exception 'Founding Beta organization was not found.';
  end if;

  select *
  into v_latest
  from private.founding_beta_enrollment_events event_row
  where event_row.organization_id = p_organization_id
  order by event_row.id desc
  limit 1;

  return private.current_founding_beta_notice() || pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'enrolled', coalesce(v_latest.action = 'grant', false),
    'latestAction', v_latest.action,
    'latestEventId', v_latest.id,
    'latestEventAt', v_latest.created_at
  );
end;
$$;

revoke all on function public.api_admin_get_founding_beta_enrollment(uuid)
  from public, anon;
grant execute on function public.api_admin_get_founding_beta_enrollment(uuid)
  to authenticated;

drop policy if exists "jobs_insert_members" on public.jobs;
create policy "jobs_insert_members"
on public.jobs
for insert
to authenticated
with check (
  public.user_can_access_org(organization_id)
  and public.current_user_has_current_founding_beta_access(organization_id)
);

-- Remove historical compatibility overloads so no executable draft-creation
-- path can retain the pre-beta authorization contract.
drop function if exists public.api_create_job(uuid, text, text, text);
drop function if exists public.api_create_job(uuid, text, text, text, text[]);
drop function if exists public.api_create_job(uuid, text, text, text, text[], integer[], date);
drop function if exists public.api_create_client_draft(text, text, uuid, text[]);
drop function if exists public.api_create_client_draft(text, text, uuid, text[], integer[], date);

create or replace function public.api_create_job(
  p_organization_id uuid,
  p_title text,
  p_description text default null,
  p_source text default 'client', -- NOSONAR: preserved public RPC default
  p_tags text[] default '{}'::text[],
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_pricing_policy_id uuid;
  v_requested_service_kinds text[] := public.normalize_requested_service_kinds(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_primary_service_kind text := public.normalize_primary_service_kind(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_requested_quote_quantities integer[] := public.normalize_positive_integer_array(
    p_requested_quote_quantities,
    null
  );
begin
  perform public.require_verified_auth();

  if not public.user_can_access_org(p_organization_id) then
    raise exception 'You do not have access to organization %', p_organization_id;
  end if;

  if not public.current_user_has_current_founding_beta_access(p_organization_id) then
    raise exception 'Founding Beta access and current notice acceptance are required.';
  end if;

  v_pricing_policy_id := public.get_active_pricing_policy_id(p_organization_id);

  insert into public.jobs (
    organization_id,
    created_by,
    title,
    description,
    source,
    active_pricing_policy_id,
    tags,
    requested_service_kinds,
    primary_service_kind,
    service_notes,
    requested_quote_quantities,
    requested_by_date
  )
  values (
    p_organization_id,
    auth.uid(),
    p_title,
    p_description,
    coalesce(nullif(trim(p_source), ''), 'client'),
    v_pricing_policy_id,
    coalesce(p_tags, '{}'::text[]),
    v_requested_service_kinds,
    v_primary_service_kind,
    nullif(trim(coalesce(p_service_notes, '')), ''),
    v_requested_quote_quantities,
    p_requested_by_date
  )
  returning id into v_job_id;

  perform public.log_audit_event(
    p_organization_id,
    'job.created',
    jsonb_build_object(
      'title', p_title,
      'source', coalesce(p_source, 'client'),
      'requestedServiceKinds', v_requested_service_kinds,
      'primaryServiceKind', v_primary_service_kind,
      'requestedQuoteQuantities', v_requested_quote_quantities,
      'requestedByDate', p_requested_by_date
    ),
    v_job_id,
    null
  );

  return v_job_id;
end;
$$;

revoke all on function public.api_create_job(
  uuid,
  text,
  text,
  text,
  text[],
  text[],
  text,
  text,
  integer[],
  date
) from public, anon;
grant execute on function public.api_create_job(
  uuid,
  text,
  text,
  text,
  text[],
  text[],
  text,
  text,
  integer[],
  date
) to authenticated;

-- api_create_client_draft delegates to the gated api_create_job function. Its
-- current signature is retained; legacy signatures above are removed.
revoke all on function public.api_create_client_draft(
  text,
  text,
  uuid,
  text[],
  text[],
  text,
  text,
  integer[],
  date
) from public, anon;
grant execute on function public.api_create_client_draft(
  text,
  text,
  uuid,
  text[],
  text[],
  text,
  text,
  integer[],
  date
) to authenticated;
