-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-723: block ITAR/EAR controlled or uncertain uploads at upload time.
--
-- This file is a DRAFT. It is not under supabase/migrations/ and is not part
-- of migration lineage. Promote it only inside a Blaine-approved migration
-- window, as two separate migrations (PHASE 1 EXPAND, then PHASE 2 CONTRACT
-- after the client that sends p_export_declaration_id is deployed). The
-- ROLLBACK section at the end reverses both phases.
--
-- Phase split:
--   PHASE 1 enforces dispatch. Both provider preflights
--     (api_authorize_provider_worker_dispatch and
--     api_authorize_xometry_beta_worker_dispatch) deny a job whose latest
--     declaration is missing, controlled, or unsure, or that has a marking
--     block pending review or confirmed controlled. Foreign providers (weerg,
--     geomiq) and unknown providers have their own explicit rule. The gate
--     lives only in the worker-facing preflights, so old browser clients keep
--     uploading. Their new jobs have no declaration, so dispatch denies them
--     until a declaration exists.
--   PHASE 2 enforces upload only. The old upload RPC signatures raise
--     export_declaration_missing, and the Storage insert policy requires a
--     declaration-backed grant. Apply it after the declaring client is live.
--
-- Verified names this draft binds to (see ovd-723-notes.md):
--   upload RPCs : public.api_prepare_job_file_upload(uuid, text, job_file_kind, text, bigint, text)
--                 public.api_finalize_job_file_upload(uuid, text, text, text, job_file_kind, text, bigint, text)
--                 (current bodies: 20261004110000_reject_empty_job_file_uploads.sql)
--   bucket      : 'job-files', object name org-sha256/<org uuid>/<sha256>/<basename>
--   storage RLS : storage.objects policy "job_files_storage_insert"
--                 (20260815093000_enforce_founding_beta_file_boundaries.sql)
--   preflights  : public.api_authorize_provider_worker_dispatch (20261003170000)
--                 public.api_authorize_xometry_beta_worker_dispatch (20261002182910)
--
-- Model. Declarations attach to the job (the part request), because the
-- upload happens before public.parts rows exist (reconcileJobParts runs after
-- upload). part_id is recorded when known. Every gate fails closed: a missing,
-- unknown, non-latest, or non-clean declaration, an open marking block, or a
-- lookup error denies the upload or the dispatch.
--
-- Reason codes (stable, shared with worker/src/exportControl.ts and
-- src/features/quotes/export-control.ts):
--   export_declaration_missing
--   export_declaration_not_clean
--   export_declaration_stale
--   export_review_pending
--   export_foreign_provider_requires_clean_declaration
--   export_control_lookup_failed
--   export_scan_missing
--
-- pgTAP: supabase/tests/pending/ovd723_export_control_upload_block.sql.pending
-- (parked; rename to supabase/tests/ovd723_export_control_upload_block.sql in
-- the same change that promotes this draft).

-- =====================================================================
-- PHASE 1 - EXPAND (old clients keep uploading; dispatch is gated)
-- =====================================================================

-- 1.1 Declaration record. Append-only: a re-declaration inserts a new row and
-- the latest row (declared_at, id) wins. No FK to jobs so the audit survives
-- job deletion and append-only triggers never block a job cascade.
create table if not exists private.job_export_declarations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  part_id uuid null,
  organization_id uuid not null,
  declared_by uuid null,
  answer text not null
    check (answer in ('not_controlled', 'controlled', 'unsure', 'missing')),
  terms_version text not null check (length(btrim(terms_version)) > 0),
  declared_at timestamptz not null default clock_timestamp(),
  ip_hash text null check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  ua_hash text null check (ua_hash is null or ua_hash ~ '^[0-9a-f]{64}$'),
  -- 'missing' is only written by the one-time backfill, never by a user.
  constraint job_export_declarations_missing_is_system
    check ((answer = 'missing') = (declared_by is null))
);

create index if not exists job_export_declarations_latest_idx
  on private.job_export_declarations (job_id, declared_at desc, id desc);

-- 1.2 Audit log. Append-only (trigger below).
create table if not exists private.export_control_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid null,
  actor uuid null,
  event text not null check (event in (
    'declaration_recorded',
    'marking_block_opened',
    'marking_block_cleared',
    'marking_block_confirmed_controlled',
    'declaration_backfilled_missing',
    'file_scan_recorded_clean',
    'rescan_requested'
  )),
  detail jsonb not null default '{}'::jsonb
);

create index if not exists export_control_events_job_idx
  on private.export_control_events (job_id, at desc);

-- 1.3 Marking blocks. A hit opens a block in blocked_pending_review; only a
-- platform-admin review moves it, and each move is an audit event.
create table if not exists private.job_export_marking_blocks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  organization_id uuid not null,
  part_id uuid null,
  job_file_id uuid null,
  source text not null check (source in ('drawing_text', 'drawing_ocr', 'step_header')),
  patterns text[] not null check (cardinality(patterns) > 0),
  state text not null default 'blocked_pending_review'
    check (state in ('blocked_pending_review', 'cleared_by_admin', 'confirmed_controlled')),
  created_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid null,
  reviewed_at timestamptz null,
  review_note text null,
  constraint job_export_marking_blocks_review_shape check (
    (state = 'blocked_pending_review'
      and reviewed_by is null and reviewed_at is null and review_note is null)
    or (state <> 'blocked_pending_review'
      and reviewed_by is not null and reviewed_at is not null
      and length(btrim(coalesce(review_note, ''))) > 0)
  )
);

create index if not exists job_export_marking_blocks_job_idx
  on private.job_export_marking_blocks (job_id, state);

-- 1.4 Short-lived upload grants: prepare (with a clean declaration) issues one
-- for the exact org/sha256 object; the PHASE 2 storage policy requires it.
create table if not exists private.export_cleared_upload_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  declaration_id uuid not null references private.job_export_declarations (id),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  granted_to uuid not null,
  expires_at timestamptz not null
);

create index if not exists export_cleared_upload_grants_lookup_idx
  on private.export_cleared_upload_grants (organization_id, content_sha256, granted_to);

-- 1.5 Append-only enforcement for declarations and events.
create or replace function private.reject_export_control_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'export_control_audit_append_only';
end;
$$;

revoke all on function private.reject_export_control_audit_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists job_export_declarations_append_only on private.job_export_declarations;
create trigger job_export_declarations_append_only
  before update or delete on private.job_export_declarations
  for each row execute function private.reject_export_control_audit_mutation();

drop trigger if exists job_export_declarations_no_truncate on private.job_export_declarations;
create trigger job_export_declarations_no_truncate
  before truncate on private.job_export_declarations
  for each statement execute function private.reject_export_control_audit_mutation();

drop trigger if exists export_control_events_append_only on private.export_control_events;
create trigger export_control_events_append_only
  before update or delete on private.export_control_events
  for each row execute function private.reject_export_control_audit_mutation();

drop trigger if exists export_control_events_no_truncate on private.export_control_events;
create trigger export_control_events_no_truncate
  before truncate on private.export_control_events
  for each statement execute function private.reject_export_control_audit_mutation();

-- 1.6 RLS. The private schema is not exposed (usage revoked from anon and
-- authenticated in 20260303123000), so client reads go through
-- api_get_job_export_control_status. The policies are defense in depth:
-- org members read their own org's rows; platform admins read all.
alter table private.job_export_declarations enable row level security;
alter table private.export_control_events enable row level security;
alter table private.job_export_marking_blocks enable row level security;
alter table private.export_cleared_upload_grants enable row level security;

drop policy if exists job_export_declarations_member_read on private.job_export_declarations;
create policy job_export_declarations_member_read
  on private.job_export_declarations
  for select to authenticated
  using (public.user_can_access_org(organization_id) or public.is_platform_admin());

drop policy if exists export_control_events_member_read on private.export_control_events;
create policy export_control_events_member_read
  on private.export_control_events
  for select to authenticated
  using (public.user_can_access_org(organization_id) or public.is_platform_admin());

drop policy if exists job_export_marking_blocks_member_read on private.job_export_marking_blocks;
create policy job_export_marking_blocks_member_read
  on private.job_export_marking_blocks
  for select to authenticated
  using (public.user_can_access_org(organization_id) or public.is_platform_admin());

revoke all on private.job_export_declarations from public, anon, authenticated;
revoke all on private.export_control_events from public, anon, authenticated;
revoke all on private.job_export_marking_blocks from public, anon, authenticated;
revoke all on private.export_cleared_upload_grants from public, anon, authenticated;

-- 1.7 Constants.
create or replace function private.export_control_terms_version()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'ovd-beta-export-control.v1'::text;
$$;

-- Provider jurisdiction. Foreign (non-US) providers get their own explicit
-- rule in the dispatch gate. Unknown providers are treated as foreign so a
-- new provider cannot silently get the looser rule.
create or replace function private.export_control_provider_jurisdiction(p_provider text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_provider in ('weerg', 'geomiq') then 'foreign'
    when p_provider in (
      'xometry', 'fictiv', 'protolabs', 'sendcutsend', 'oshcut', 'fabworks',
      'ponoko', 'quickparts', 'rapiddirect', 'protolabsnetwork', 'partsbadger',
      'fastdms', 'devzmanufacturing', 'infraredlaboratories', 'emachineshop', 'rmfg'
    ) then 'us'
    else 'unknown'
  end;
$$;

revoke all on function private.export_control_terms_version() from public, anon, authenticated;
revoke all on function private.export_control_provider_jurisdiction(text) from public, anon, authenticated;

create or replace function private.lock_job_export_state(p_job_id uuid, p_exclusive boolean)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_exclusive then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('ovd723:job-export:' || p_job_id::text, 0)
    );
  else
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('ovd723:job-export:' || p_job_id::text, 0)
    );
  end if;
end;
$$;

revoke all on function private.lock_job_export_state(uuid, boolean) from public, anon, authenticated;

-- 1.8 Current state of a job: latest declaration and open/confirmed blocks.
create or replace function private.job_export_upload_denial(
  p_job_id uuid,
  p_declaration_id uuid
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_latest private.job_export_declarations%rowtype;
begin
  if p_declaration_id is null then
    return 'export_declaration_missing';
  end if;

  select declaration.* into v_latest
  from private.job_export_declarations declaration
  where declaration.job_id = p_job_id
  order by declaration.declared_at desc, declaration.id desc
  limit 1;

  if v_latest.id is null then
    return 'export_declaration_missing';
  end if;
  if v_latest.id is distinct from p_declaration_id then
    return 'export_declaration_stale';
  end if;
  if v_latest.answer is distinct from 'not_controlled' then
    return 'export_declaration_not_clean';
  end if;
  if exists (
    select 1
    from private.job_export_marking_blocks block
    where block.job_id = p_job_id
      and block.state in ('blocked_pending_review', 'confirmed_controlled')
  ) then
    return 'export_review_pending';
  end if;
  return null;
end;
$$;

revoke all on function private.job_export_upload_denial(uuid, uuid) from public, anon, authenticated;

create or replace function private.require_clean_export_declaration(
  p_job_id uuid,
  p_declaration_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_denial text;
begin
  perform private.lock_job_export_state(p_job_id, false);
  v_denial := private.job_export_upload_denial(p_job_id, p_declaration_id);
  if v_denial is not null then
    raise exception using
      errcode = 'P0001', -- NOSONAR: stable customer-safe PostgreSQL error contract
      message = v_denial;
  end if;
end;
$$;

revoke all on function private.require_clean_export_declaration(uuid, uuid) from public, anon, authenticated;

-- 1.9 Declaration RPC: the only writer of declarations. Org member with edit
-- rights on the job; terms version must be current. controlled/unsure are
-- recorded (audit) and returned as not upload-allowed.
create or replace function public.api_declare_job_export_status(
  p_job_id uuid,
  p_answer text,
  p_terms_version text,
  p_part_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_declaration_id uuid;
  v_headers jsonb;
  v_ip text;
  v_ua text;
  v_allowed boolean;
begin
  perform public.require_verified_auth();

  if p_answer is null or p_answer not in ('not_controlled', 'controlled', 'unsure') then
    raise exception using errcode = 'P0001', message = 'export_declaration_invalid';
  end if;
  if p_terms_version is distinct from private.export_control_terms_version() then
    raise exception using errcode = 'P0001', message = 'export_terms_version_stale';
  end if;

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null
    or not public.user_can_access_org(v_job.organization_id)
    or not public.user_can_edit_job(v_job.id) then
    raise exception using errcode = '42501', message = 'export_declaration_forbidden';
  end if;
  if p_part_id is not null and not exists (
    select 1 from public.parts part where part.id = p_part_id and part.job_id = v_job.id
  ) then
    raise exception using errcode = 'P0001', message = 'export_declaration_invalid';
  end if;

  begin
    v_headers := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  v_ip := nullif(pg_catalog.btrim(pg_catalog.split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
  v_ua := nullif(v_headers ->> 'user-agent', '');

  perform private.lock_job_export_state(v_job.id, true);

  insert into private.job_export_declarations (
    job_id, part_id, organization_id, declared_by, answer, terms_version, ip_hash, ua_hash
  )
  values (
    v_job.id,
    p_part_id,
    v_job.organization_id,
    auth.uid(),
    p_answer,
    p_terms_version,
    case when v_ip is null then null
      else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('ovd723:ip:' || v_ip, 'UTF8')), 'hex') end,
    case when v_ua is null then null
      else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('ovd723:ua:' || v_ua, 'UTF8')), 'hex') end
  )
  returning id into v_declaration_id;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_job.organization_id, v_job.id, p_part_id, auth.uid(), 'declaration_recorded',
    pg_catalog.jsonb_build_object(
      'declarationId', v_declaration_id,
      'answer', p_answer,
      'termsVersion', p_terms_version
    )
  );

  v_allowed := p_answer = 'not_controlled' and private.job_export_upload_denial(v_job.id, v_declaration_id) is null;

  return pg_catalog.jsonb_build_object(
    'declarationId', v_declaration_id,
    'answer', p_answer,
    'termsVersion', p_terms_version,
    'uploadAllowed', v_allowed,
    'reasonCode', private.job_export_upload_denial(v_job.id, v_declaration_id)
  );
end;
$$;

revoke all on function public.api_declare_job_export_status(uuid, text, text, uuid) from public, anon;
grant execute on function public.api_declare_job_export_status(uuid, text, text, uuid) to authenticated;

-- 1.10 Read RPC for the client (members of the job's org, or platform admins).
create or replace function public.api_get_job_export_control_status(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_latest private.job_export_declarations%rowtype;
  v_open integer;
  v_confirmed integer;
  v_parts_missing_scan integer;
  v_rescans_pending integer;
begin
  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null
    or not (public.user_can_access_org(v_job.organization_id) or public.is_platform_admin()) then
    raise exception using errcode = '42501', message = 'export_status_forbidden';
  end if;

  -- Scan coverage (1.15 rule) and queued rescans (1.18), so an existing job
  -- shows what still holds dispatch after the user declares.
  select count(*) filter (where private.export_control_scan_denial(part.id) is not null)
  into v_parts_missing_scan
  from public.parts part
  where part.job_id = v_job.id;

  select count(*)
  into v_rescans_pending
  from public.work_queue queue
  where queue.job_id = v_job.id
    and queue.task_type::text = 'export_rescan_part'
    and queue.status in ('queued', 'running');

  select declaration.* into v_latest
  from private.job_export_declarations declaration
  where declaration.job_id = v_job.id
  order by declaration.declared_at desc, declaration.id desc
  limit 1;

  select
    count(*) filter (where block.state = 'blocked_pending_review'),
    count(*) filter (where block.state = 'confirmed_controlled')
  into v_open, v_confirmed
  from private.job_export_marking_blocks block
  where block.job_id = v_job.id;

  return pg_catalog.jsonb_build_object(
    'jobId', v_job.id,
    'latestAnswer', v_latest.answer,
    'latestDeclaredAt', v_latest.declared_at,
    'termsVersion', v_latest.terms_version,
    'exportReviewState', case
      when v_confirmed > 0 then 'confirmed_controlled'
      when v_open > 0 then 'blocked_pending_review'
      else 'clear'
    end,
    'partsMissingScan', v_parts_missing_scan,
    'rescansPending', v_rescans_pending
  );
end;
$$;

revoke all on function public.api_get_job_export_control_status(uuid) from public, anon;
grant execute on function public.api_get_job_export_control_status(uuid) to authenticated;

-- 1.11 Marking hits, recorded by the worker (service role only). Opening a
-- block never requires or accepts user input.
create or replace function public.api_record_export_control_marking_hits(
  p_job_id uuid,
  p_part_id uuid,
  p_job_file_id uuid,
  p_source text,
  p_patterns text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_block_id uuid;
begin
  if p_patterns is null or cardinality(p_patterns) = 0
    or p_source is null or p_source not in ('drawing_text', 'drawing_ocr', 'step_header') then
    raise exception using errcode = 'P0001', message = 'export_marking_invalid';
  end if;

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'export_marking_invalid';
  end if;

  perform private.lock_job_export_state(v_job.id, true);

  insert into private.job_export_marking_blocks (
    job_id, organization_id, part_id, job_file_id, source, patterns
  )
  values (v_job.id, v_job.organization_id, p_part_id, p_job_file_id, p_source, p_patterns)
  returning id into v_block_id;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_job.organization_id, v_job.id, p_part_id, null, 'marking_block_opened',
    pg_catalog.jsonb_build_object(
      'blockId', v_block_id,
      'source', p_source,
      'patterns', pg_catalog.to_jsonb(p_patterns),
      'jobFileId', p_job_file_id
    )
  );

  return v_block_id;
end;
$$;

revoke all on function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[])
  from public, anon, authenticated;
grant execute on function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[])
  to service_role;

-- 1.11b Clean marking scans, recorded by the worker (service role only).
-- Dispatch requires a clean scan of record for the dispatched part's own files
-- (1.15). This covers paths that skip extraction: a part that reuses another
-- part's trusted artifacts (api_reuse_trusted_part_version_artifacts), a file
-- reused from the org blob store, or a part extracted before OVD-723. None of
-- them has a scan in its own job until the worker scans it. Hits are not
-- stored here. They open a block (1.11). Rows are keyed on the job_file id,
-- so a scan in one job never vouches for the same bytes in another job.
create table if not exists private.job_file_export_scans (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null,
  job_id uuid not null,
  organization_id uuid not null,
  part_id uuid null,
  source text not null check (source in ('drawing_text', 'drawing_ocr', 'step_header')),
  scanned_at timestamptz not null default clock_timestamp()
);

create index if not exists job_file_export_scans_file_idx
  on private.job_file_export_scans (job_file_id, source);

drop trigger if exists job_file_export_scans_append_only on private.job_file_export_scans;
create trigger job_file_export_scans_append_only
  before update or delete on private.job_file_export_scans
  for each row execute function private.reject_export_control_audit_mutation();

drop trigger if exists job_file_export_scans_no_truncate on private.job_file_export_scans;
create trigger job_file_export_scans_no_truncate
  before truncate on private.job_file_export_scans
  for each statement execute function private.reject_export_control_audit_mutation();

alter table private.job_file_export_scans enable row level security;

drop policy if exists job_file_export_scans_member_read on private.job_file_export_scans;
create policy job_file_export_scans_member_read
  on private.job_file_export_scans
  for select to authenticated
  using (public.user_can_access_org(organization_id) or public.is_platform_admin());

revoke all on private.job_file_export_scans from public, anon, authenticated;

create or replace function public.api_record_export_control_clean_scan(
  p_job_id uuid,
  p_part_id uuid,
  p_job_file_id uuid,
  p_source text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.job_files%rowtype;
  v_scan_id uuid;
begin
  if p_source is null or p_source not in ('drawing_text', 'drawing_ocr', 'step_header') then
    raise exception using errcode = 'P0001', message = 'export_scan_invalid';
  end if;

  select file_row.* into v_file from public.job_files file_row where file_row.id = p_job_file_id;
  if v_file.id is null or v_file.job_id is distinct from p_job_id then
    raise exception using errcode = 'P0001', message = 'export_scan_invalid';
  end if;

  perform private.lock_job_export_state(v_file.job_id, true);

  insert into private.job_file_export_scans (job_file_id, job_id, organization_id, part_id, source)
  values (v_file.id, v_file.job_id, v_file.organization_id, p_part_id, p_source)
  returning id into v_scan_id;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_file.organization_id, v_file.job_id, p_part_id, null, 'file_scan_recorded_clean',
    pg_catalog.jsonb_build_object('scanId', v_scan_id, 'source', p_source, 'jobFileId', v_file.id)
  );

  return v_scan_id;
end;
$$;

revoke all on function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text)
  to service_role;

-- 1.12 Admin review. Users cannot clear a block; only platform admins can,
-- with a mandatory note, and every decision is an audit event.
create or replace function public.api_review_export_control_block(
  p_block_id uuid,
  p_decision text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block private.job_export_marking_blocks%rowtype;
begin
  perform public.require_verified_auth();
  if not public.is_platform_admin() then
    raise exception using errcode = '42501', message = 'export_review_admin_required';
  end if;
  if p_decision is null or p_decision not in ('cleared_by_admin', 'confirmed_controlled')
    or length(pg_catalog.btrim(coalesce(p_note, ''))) = 0 then
    raise exception using errcode = 'P0001', message = 'export_review_invalid';
  end if;

  select block.* into v_block
  from private.job_export_marking_blocks block
  where block.id = p_block_id;
  if v_block.id is null then
    raise exception using errcode = 'P0001', message = 'export_review_invalid';
  end if;

  perform private.lock_job_export_state(v_block.job_id, true);

  update private.job_export_marking_blocks
  set state = p_decision,
      reviewed_by = auth.uid(),
      reviewed_at = pg_catalog.clock_timestamp(),
      review_note = pg_catalog.btrim(p_note)
  where id = v_block.id
    and state = 'blocked_pending_review'
  returning * into v_block;

  if not found then
    raise exception using errcode = 'P0001', message = 'export_review_not_pending';
  end if;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_block.organization_id, v_block.job_id, v_block.part_id, auth.uid(),
    case p_decision
      when 'cleared_by_admin' then 'marking_block_cleared'
      else 'marking_block_confirmed_controlled'
    end,
    pg_catalog.jsonb_build_object('blockId', v_block.id, 'note', v_block.review_note)
  );

  return pg_catalog.jsonb_build_object('blockId', v_block.id, 'state', v_block.state);
end;
$$;

revoke all on function public.api_review_export_control_block(uuid, text, text) from public, anon;
grant execute on function public.api_review_export_control_block(uuid, text, text) to authenticated;

-- 1.13 Upload RPCs. The current bodies move unchanged to private cores; the
-- old public signatures keep delegating (expand) and new overloads that take
-- p_export_declaration_id check the declaration first. The new overloads have
-- no default for p_export_declaration_id, so PostgREST never finds the two
-- signatures ambiguous.
alter function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) set schema private;
alter function private.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) rename to job_file_prepare_core;
revoke all on function private.job_file_prepare_core(
  uuid, text, public.job_file_kind, text, bigint, text
) from public, anon, authenticated;

alter function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) set schema private;
alter function private.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) rename to job_file_finalize_core;
revoke all on function private.job_file_finalize_core(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) from public, anon, authenticated;

-- Old signatures (expand: unchanged behavior; PHASE 2 replaces the bodies).
create or replace function public.api_prepare_job_file_upload(
  p_job_id uuid,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.job_file_prepare_core(
    p_job_id, p_original_name, p_file_kind, p_mime_type, p_size_bytes, p_content_sha256
  );
end;
$$;

create or replace function public.api_finalize_job_file_upload(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.job_file_finalize_core(
    p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
    p_mime_type, p_size_bytes, p_content_sha256
  );
end;
$$;

-- New overloads (declaration required).
create or replace function public.api_prepare_job_file_upload(
  p_job_id uuid,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text,
  p_size_bytes bigint,
  p_content_sha256 text,
  p_export_declaration_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_result jsonb;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null or not public.user_can_edit_job(v_job.id) then
    -- Same contract as the core so job existence is not disclosed differently.
    return private.job_file_prepare_core(
      p_job_id, p_original_name, p_file_kind, p_mime_type, p_size_bytes, p_content_sha256
    );
  end if;

  -- Declaration first: a denied call writes no job_files, blobs, or grants.
  perform private.require_clean_export_declaration(v_job.id, p_export_declaration_id);

  v_result := private.job_file_prepare_core(
    p_job_id, p_original_name, p_file_kind, p_mime_type, p_size_bytes, p_content_sha256
  );

  if v_result ->> 'status' = 'upload_required' then
    insert into private.export_cleared_upload_grants (
      organization_id, job_id, declaration_id, content_sha256, granted_to, expires_at
    )
    values (
      v_job.organization_id,
      v_job.id,
      p_export_declaration_id,
      lower(btrim(p_content_sha256)),
      auth.uid(),
      pg_catalog.clock_timestamp() + interval '15 minutes'
    );
  end if;

  return v_result;
end;
$$;

create or replace function public.api_finalize_job_file_upload(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text,
  p_size_bytes bigint,
  p_content_sha256 text,
  p_export_declaration_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_file_id uuid;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null or not public.user_can_edit_job(v_job.id) then
    return private.job_file_finalize_core(
      p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
      p_mime_type, p_size_bytes, p_content_sha256
    );
  end if;

  perform private.require_clean_export_declaration(v_job.id, p_export_declaration_id);

  v_file_id := private.job_file_finalize_core(
    p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
    p_mime_type, p_size_bytes, p_content_sha256
  );

  delete from private.export_cleared_upload_grants grant_row
  where grant_row.organization_id = v_job.organization_id
    and grant_row.content_sha256 = lower(btrim(p_content_sha256))
    and grant_row.granted_to = auth.uid();

  return v_file_id;
end;
$$;

revoke all on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) from public, anon;
grant execute on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) to authenticated;
revoke all on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) from public, anon;
grant execute on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) to authenticated;
revoke all on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text, uuid
) from public, anon;
grant execute on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text, uuid
) to authenticated;
revoke all on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text, uuid
) from public, anon;
grant execute on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text, uuid
) to authenticated;

-- 1.14 Storage helper for the PHASE 2 insert policy. True only for an
-- unexpired grant for this user and this exact org/sha256 object whose
-- declaration is still the latest, clean, and unblocked.
create or replace function public.current_user_has_export_cleared_upload(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org text := pg_catalog.split_part(coalesce(p_object_name, ''), '/', 2);
  v_sha text := pg_catalog.split_part(coalesce(p_object_name, ''), '/', 3);
begin
  if auth.uid() is null or v_sha !~ '^[0-9a-f]{64}$'
    or v_org !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from private.export_cleared_upload_grants grant_row
    where grant_row.organization_id = v_org::uuid
      and grant_row.content_sha256 = v_sha
      and grant_row.granted_to = auth.uid()
      and grant_row.expires_at > pg_catalog.clock_timestamp()
      and private.job_export_upload_denial(grant_row.job_id, grant_row.declaration_id) is null
  );
exception when others then
  return false; -- fail closed
end;
$$;

revoke all on function public.current_user_has_export_cleared_upload(text) from public, anon;
grant execute on function public.current_user_has_export_cleared_upload(text) to authenticated;

-- 1.15 Dispatch gate evaluation (used by the 1.16 preflight wrappers).
-- Returns null only when the job's latest declaration is not_controlled and
-- no marking block is open or confirmed. The task-level check then also
-- requires a clean scan of record for the part's files
-- (export_control_scan_denial). Foreign providers are checked first,
-- as their own explicit rule with their own reason code. Any lookup error is
-- a denial.
create or replace function private.export_control_dispatch_denial(
  p_job_id uuid,
  p_provider text
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_answer text;
  v_blocked boolean;
begin
  if p_job_id is null then
    return 'export_declaration_missing';
  end if;

  perform private.lock_job_export_state(p_job_id, false);

  select declaration.answer into v_answer
  from private.job_export_declarations declaration
  where declaration.job_id = p_job_id
  order by declaration.declared_at desc, declaration.id desc
  limit 1;

  v_blocked := exists (
    select 1
    from private.job_export_marking_blocks block
    where block.job_id = p_job_id
      and block.state in ('blocked_pending_review', 'confirmed_controlled')
  );

  -- Foreign (or unknown) jurisdiction: explicit, independent rule.
  if private.export_control_provider_jurisdiction(p_provider) is distinct from 'us' then
    if v_answer is distinct from 'not_controlled' or v_blocked then
      return 'export_foreign_provider_requires_clean_declaration';
    end if;
  end if;

  if v_answer is null or v_answer = 'missing' then
    return 'export_declaration_missing';
  end if;
  if v_answer is distinct from 'not_controlled' then
    return 'export_declaration_not_clean';
  end if;
  if v_blocked then
    return 'export_review_pending';
  end if;
  return null;
exception when others then
  return 'export_control_lookup_failed';
end;
$$;

-- Scan rule: every file the dispatched part sends must have a clean scan of
-- record in its own job. The drawing needs a drawing scan, and a STEP CAD file
-- needs a header scan. A missing part or file reference is a denial. Other CAD
-- formats have no scanner yet, so this rule doesn't cover them (see notes).
create or replace function private.export_control_scan_denial(p_part_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_part public.parts%rowtype;
  v_cad public.job_files%rowtype;
begin
  if p_part_id is null then
    return 'export_scan_missing';
  end if;

  select part_row.* into v_part from public.parts part_row where part_row.id = p_part_id;
  if v_part.id is null then
    return 'export_scan_missing';
  end if;

  if v_part.drawing_file_id is not null and not exists (
    select 1
    from private.job_file_export_scans scan
    where scan.job_file_id = v_part.drawing_file_id
      and scan.source in ('drawing_text', 'drawing_ocr')
  ) then
    return 'export_scan_missing';
  end if;

  if v_part.cad_file_id is not null then
    select file_row.* into v_cad from public.job_files file_row where file_row.id = v_part.cad_file_id;
    if v_cad.id is null then
      return 'export_scan_missing';
    end if;
    if pg_catalog.lower(pg_catalog.btrim(v_cad.original_name)) ~ '\.(step|stp)$' and not exists (
      select 1
      from private.job_file_export_scans scan
      where scan.job_file_id = v_cad.id
        and scan.source = 'step_header'
    ) then
      return 'export_scan_missing';
    end if;
  end if;

  return null;
end;
$$;

create or replace function private.export_control_dispatch_denial_for_task(
  p_work_queue_task_id uuid,
  p_provider text
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_part_id uuid;
  v_vendor text;
  v_denial text;
begin
  select task_row.job_id, task_row.part_id, task_row.payload ->> 'vendor'
  into v_job_id, v_part_id, v_vendor
  from public.work_queue task_row
  where task_row.id = p_work_queue_task_id;

  v_denial := private.export_control_dispatch_denial(v_job_id, coalesce(v_vendor, p_provider));
  if v_denial is not null then
    return v_denial;
  end if;
  return private.export_control_scan_denial(v_part_id);
exception when others then
  return 'export_control_lookup_failed';
end;
$$;

revoke all on function private.export_control_dispatch_denial(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.export_control_dispatch_denial_for_task(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.export_control_scan_denial(uuid)
  from public, anon, authenticated, service_role;

-- 1.16 Dispatch preflights. The existing bodies move unchanged to private
-- cores; the public names become wrappers that run the export gate first,
-- holding the shared per-job export lock until commit so a declaration or a
-- marking block cannot interleave with the decision.
alter function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) set schema private;
alter function private.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) rename to xometry_beta_worker_dispatch_core;
revoke all on function private.xometry_beta_worker_dispatch_core(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;

alter function public.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) set schema private;
alter function private.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) rename to provider_worker_dispatch_core;
revoke all on function private.provider_worker_dispatch_core(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_denial text;
begin
  v_denial := private.export_control_dispatch_denial_for_task(p_work_queue_task_id, 'xometry');
  if v_denial is not null then
    return pg_catalog.jsonb_build_object('authorized', false, 'reasonCode', v_denial);
  end if;
  return private.xometry_beta_worker_dispatch_core(
    p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
    p_expected_worker_name, p_expected_claimed_at
  );
end;
$$;

create or replace function public.api_authorize_provider_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_denial text;
begin
  -- Xometry keeps its legacy response shape; its wrapper applies the gate.
  if p_scope_snapshot ->> 'vendor' = 'xometry' then
    return public.api_authorize_xometry_beta_worker_dispatch(
      p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
      p_expected_worker_name, p_expected_claimed_at
    );
  end if;

  v_denial := private.export_control_dispatch_denial_for_task(
    p_work_queue_task_id,
    p_scope_snapshot ->> 'vendor'
  );
  if v_denial is not null then
    return private.provider_dispatch_authorization_denial(v_denial);
  end if;
  return private.provider_worker_dispatch_core(
    p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
    p_expected_worker_name, p_expected_claimed_at
  );
end;
$$;

revoke all on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;
revoke all on function public.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;

-- 1.17 One-time backfill: every existing job with files and no declaration
-- gets an explicit 'missing' row (denied until the user declares).
insert into private.job_export_declarations (job_id, organization_id, declared_by, answer, terms_version)
select job_row.id, job_row.organization_id, null, 'missing', private.export_control_terms_version()
from public.jobs job_row
where exists (select 1 from public.job_files file_row where file_row.job_id = job_row.id)
  and not exists (
    select 1 from private.job_export_declarations declaration where declaration.job_id = job_row.id
  );

insert into private.export_control_events (organization_id, job_id, actor, event, detail)
select declaration.organization_id, declaration.job_id, null, 'declaration_backfilled_missing',
  pg_catalog.jsonb_build_object('declarationId', declaration.id)
from private.job_export_declarations declaration
where declaration.answer = 'missing';

-- 1.18 Existing jobs. Every job that predates the deploy has a backfilled
-- 'missing' declaration (1.17) and no scan of record, so dispatch denies it
-- twice over: export_declaration_missing, then export_scan_missing.
--
-- Declaration: an org member with edit rights declares on the existing job
-- through api_declare_job_export_status (1.9), the same RPC and the same three
-- answers as at upload. Nothing defaults; controlled and unsure are recorded
-- and keep the job denied (export_declaration_not_clean).
--
-- Rescan: api_request_extraction (20260812042000) only queues extract_part
-- for parts with no drawing_extractions row, so it never re-runs extraction,
-- and never scans, for a part that was already extracted. This RPC queues one
-- export_rescan_part task per part that has a drawing or CAD file. The worker
-- scans that part's own drawing text and STEP header and records hits
-- (1.11) or clean scans (1.11b); it never re-runs extraction or calls a
-- provider. A drawing whose text can't be read records nothing and fails the
-- task, so dispatch stays denied. An org member with edit rights or a
-- platform admin can request it. Scanning sends nothing outside, so the
-- declaration state doesn't gate the rescan; dispatch still needs both.
--
-- The new enum value is only used inside function bodies and compared as
-- text, so nothing uses it before this migration commits (ALTER TYPE ... ADD
-- VALUE in a transaction).
alter type public.queue_task_type add value if not exists 'export_rescan_part';

create or replace function public.api_request_export_control_rescan(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_requested_as text;
  v_count integer := 0;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null then
    raise exception using errcode = '42501', message = 'export_rescan_forbidden';
  end if;
  if public.user_can_access_org(v_job.organization_id) and public.user_can_edit_job(v_job.id) then
    v_requested_as := 'member';
  elsif public.is_platform_admin() then
    v_requested_as := 'platform_admin';
  else
    raise exception using errcode = '42501', message = 'export_rescan_forbidden';
  end if;

  with enqueued as (
    insert into public.work_queue (organization_id, job_id, part_id, task_type, payload)
    select
      v_job.organization_id, v_job.id, part.id, 'export_rescan_part',
      pg_catalog.jsonb_build_object(
        'partId', part.id,
        'jobId', v_job.id,
        'requestedBy', auth.uid(),
        'requestedAs', v_requested_as
      )
    from public.parts part
    where part.job_id = v_job.id
      and (part.drawing_file_id is not null or part.cad_file_id is not null)
      and not exists (
        select 1 from public.work_queue queue
        where queue.part_id = part.id
          and queue.task_type::text = 'export_rescan_part'
          and queue.status in ('queued', 'running')
      )
    returning id
  )
  select count(*)::integer into v_count from enqueued;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_job.organization_id, v_job.id, null, auth.uid(), 'rescan_requested',
    pg_catalog.jsonb_build_object('requestedAs', v_requested_as, 'tasksQueued', v_count)
  );

  return pg_catalog.jsonb_build_object(
    'jobId', v_job.id,
    'requestedAs', v_requested_as,
    'tasksQueued', v_count
  );
end;
$$;

revoke all on function public.api_request_export_control_rescan(uuid) from public, anon;
grant execute on function public.api_request_export_control_rescan(uuid) to authenticated;

-- =====================================================================
-- PHASE 2 - CONTRACT (upload enforcement only; apply only after the
-- declaring client is deployed. Dispatch is already gated by PHASE 1.)
-- =====================================================================

-- 2.1 Old upload signatures fail closed: no declaration, no upload.
create or replace function public.api_prepare_job_file_upload(
  p_job_id uuid,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001', -- NOSONAR: stable customer-safe PostgreSQL error contract
    message = 'export_declaration_missing';
end;
$$;

create or replace function public.api_finalize_job_file_upload(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'export_declaration_missing';
end;
$$;

-- 2.2 Storage: no object is written without a declaration-backed grant.
drop policy if exists "job_files_storage_insert" on storage.objects;
create policy "job_files_storage_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'job-files'
  and name ~ '^org-sha256/[0-9a-f-]{36}/[0-9a-f]{64}/[a-z0-9._-]+$'
  and exists (
    select 1
    from public.jobs job
    where job.organization_id::text = split_part(name, '/', 2)
      and public.user_can_edit_job(job.id)
      and public.current_user_has_current_founding_beta_access(job.organization_id)
  )
  and public.current_user_has_export_cleared_upload(name)
);

-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Run in this order. Declarations, events, and blocks are audit data: the
-- rollback keeps the tables (they are inert once nothing reads them). Drop
-- them only with Blaine's explicit approval, after exporting them.
--
-- R2 (undo PHASE 2; upload enforcement only):
--   -- restore "job_files_storage_insert" exactly as in 20260815093000 (without
--   -- the current_user_has_export_cleared_upload clause).
--   -- re-run the PHASE 1 section 1.13 old-signature delegating wrappers.
--   -- dispatch stays gated: the 1.16 wrappers belong to PHASE 1.
--
-- R1 (undo PHASE 1; run R2 first if PHASE 2 was applied):
--   -- dispatch preflight wrappers (1.16):
--   drop function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
--   alter function private.provider_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)
--     rename to api_authorize_provider_worker_dispatch;
--   alter function private.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
--     set schema public;
--   drop function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
--   alter function private.xometry_beta_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)
--     rename to api_authorize_xometry_beta_worker_dispatch;
--   alter function private.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
--     set schema public;
--   -- restate the original grants (service_role only) for both functions, as in
--   -- 20261003170000 and 20261002182910.
--   -- upload RPCs (1.13):
--   drop function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text, uuid);
--   drop function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text, uuid);
--   drop function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text);
--   drop function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text);
--   alter function private.job_file_prepare_core(uuid, text, public.job_file_kind, text, bigint, text)
--     rename to api_prepare_job_file_upload;
--   alter function private.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)
--     set schema public;
--   alter function private.job_file_finalize_core(uuid, text, text, text, public.job_file_kind, text, bigint, text)
--     rename to api_finalize_job_file_upload;
--   alter function private.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)
--     set schema public;
--   -- restate the revoke/grant pairs for both from 20261004110000.
--   drop function public.current_user_has_export_cleared_upload(text);
--   drop function public.api_review_export_control_block(uuid, text, text);
--   drop function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[]);
--   drop function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text);
--   drop function public.api_get_job_export_control_status(uuid);
--   drop function public.api_declare_job_export_status(uuid, text, text, uuid);
--   drop function private.export_control_dispatch_denial_for_task(uuid, text);
--   drop function private.export_control_scan_denial(uuid);
--   drop function private.export_control_dispatch_denial(uuid, text);
--   drop function private.require_clean_export_declaration(uuid, uuid);
--   drop function private.job_export_upload_denial(uuid, uuid);
--   drop function private.lock_job_export_state(uuid, boolean);
--   drop function private.export_control_provider_jurisdiction(text);
--   drop function private.export_control_terms_version();
--   drop table private.export_cleared_upload_grants;
--   -- keep private.job_export_declarations, private.export_control_events,
--   -- private.job_export_marking_blocks, private.job_file_export_scans and
--   -- their triggers (audit retention).
