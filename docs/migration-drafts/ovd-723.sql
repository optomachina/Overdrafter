-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-723: block ITAR/EAR controlled or uncertain uploads at upload time.
-- EXPAND migration (window 1). The CONTRACT migration is a separate draft,
-- ovd-723-contract.sql, for a later window (window 2, about Nov 9).
--
-- This file is a DRAFT. It is not under supabase/migrations/ and is not part
-- of migration lineage. Promote it only inside a Blaine-approved migration
-- window. Rollback: ovd-723.rollback.sql (guarded; refuses while the
-- contract migration is applied).
--
-- Expand is additive only. It creates new tables, functions, and one new
-- Storage policy, adds one value to public.queue_task_type (1.0), and
-- backfills rows into its own new table. It does not change, move, replace,
-- or revoke any existing function or policy:
--   - the legacy 6- and 8-argument upload RPCs keep working unchanged;
--   - "job_files_storage_insert" stays; a second permissive policy is added
--     alongside, which changes nothing until the contract drops the old one;
--   - both provider preflights are unchanged; the new worker calls the new
--     api_check_export_control_dispatch before every preflight.
--
-- What holds after expand (window 1):
--   Upload. The new client declares, then uses the 7- and 9-argument
--     overloads: the job's latest declaration must be not_controlled and
--     unblocked (checked under a shared per-job lock). Prepare issues a
--     single-use grant bound to the exact object (bucket and path, SHA-256,
--     size, user, job, declaration); finalize admits only an object this user
--     owns at that path, written before the grant expired, with that size.
--     An old client, or a direct call to the legacy RPCs, is NOT blocked
--     until the contract migration.
--   Content. The worker verifies the SHA-256 of the bytes it stages; a clean
--     scan is recorded only for bytes whose hash equals the claimed one.
--   Dispatch. The new worker asks api_check_export_control_dispatch before
--     every preflight and stops on any denial: a missing, controlled, or
--     unsure latest declaration (every pre-existing job is backfilled to
--     missing), an open or confirmed marking block, a file without a verified
--     hash and a clean scan bound to its job and content, or a foreign or
--     unknown provider without a clean, unblocked job. An old worker is NOT
--     gated until the contract migration wraps the preflights.
--   Extraction. The new worker asks api_check_export_control_extraction
--     before any CAD or drawing content goes to an extraction model, and
--     again before each model attempt, and sends nothing unless the job's
--     latest declaration is not_controlled with no open or confirmed block. A
--     drawing with any page that yields no text gets no clean scan and is not
--     sent to a model.
--   Rescan. A clean declaration queues a scan only rescan (task
--     export_marking_rescan, 1.16c) for every drawing or STEP file without a
--     scan of its current bytes, so parts extracted before this migration can
--     be released without extraction. The worker task never calls a model,
--     and it retries transient failures on the finite schedule. A file left
--     without a scan (a rescan that failed for good) shows as scanState
--     missing on the part page, whose "Recheck files" action calls
--     api_request_export_marking_rescan (owner, clean declaration only).
--     The worker deploy must precede or accompany the client deploy: an old
--     worker fails the new task type ("Unhandled task type").
--   Review. An admin clearance of a false positive records an admin cleared
--     scan bound to the file, its content hash, and the cleared patterns
--     (1.12a); a later hit on the same bytes and patterns resolves to it, and
--     a new hash or pattern opens a new block.
--
-- What the contract migration adds (server side, any client or worker): the
-- legacy upload RPCs refuse, the old Storage INSERT policy is dropped so only
-- the grant policy remains, and both preflights are wrapped by the export
-- gate. The server side block is complete only after the contract.
--
-- Deploy order: this migration, then the worker and the web client. The
-- contract migration follows once the deployed client uses the declaring
-- overloads and the worker calls the dispatch check.
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
-- WINDOW 1: EXPAND (additive only; no existing object is changed or revoked)
-- =====================================================================

-- 1.0 Task type for the scan only rescan (1.16c). Adding an enum value is
-- additive: no existing value, row, or function changes. PostgreSQL cannot
-- drop an enum value, so the rollback leaves it in place (unused). The value
-- is not used in this transaction; the functions below name it only as text
-- (task_type::text) or through a runtime cast
-- ('export_marking_rescan'::text::public.queue_task_type), which is resolved
-- when they run, never when they are created.
alter type public.queue_task_type add value if not exists 'export_marking_rescan';

-- 1.1 Declaration record. Append-only: a re-declaration inserts a new row and
-- the latest row (declared_at, id) wins. No FK to jobs so the audit survives
-- job deletion and append-only triggers never block a job cascade. No client
-- IP is stored: an unkeyed hash of an IPv4 address is reversible by
-- enumeration, and a keyed hash needs a server secret this draft does not
-- create. The declarer is identified by declared_by and the session's own
-- auth audit trail.
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
    'file_scan_recorded_admin_cleared',
    'export_marking_rescan_queued'
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
  -- SHA-256 of the bytes whose text matched, when the worker staged them. An
  -- admin clearance vouches only for these bytes and these patterns (1.12).
  content_sha256 text null check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
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

-- 1.4 Short-lived, single-use upload grants. Prepare (with a clean
-- declaration) issues one for one exact object: bucket and full path
-- (org-sha256/<org>/<sha256>/<basename>), the expected SHA-256 and size, the
-- user, the job, and the declaration. The Storage INSERT policy (1.18) admits
-- only that object, only before expires_at, and only while the grant is
-- unfinalized; (bucket_id, name) is unique in storage.objects, so the path can
-- be written once. Finalize (1.13) consumes the grant.
create table if not exists private.export_cleared_upload_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  declaration_id uuid not null references private.job_export_declarations (id),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  storage_bucket text not null check (storage_bucket = 'job-files'),
  storage_path text not null,
  granted_to uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  finalized_at timestamptz null,
  job_file_id uuid null,
  constraint export_cleared_upload_grants_path_shape check (
    storage_path = 'org-sha256/' || organization_id::text || '/' || content_sha256
      || '/' || pg_catalog.split_part(storage_path, '/', 4)
    and pg_catalog.split_part(storage_path, '/', 4) <> ''
    and pg_catalog.split_part(storage_path, '/', 5) = ''
  ),
  constraint export_cleared_upload_grants_finalized_shape
    check ((finalized_at is null) = (job_file_id is null))
);

create index if not exists export_cleared_upload_grants_object_idx
  on private.export_cleared_upload_grants (storage_bucket, storage_path, granted_to);

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
-- new provider cannot silently get the looser rule. RapidDirect (China) and
-- Protolabs Network (Hubs, a non-US partner network) are foreign.
create or replace function private.export_control_provider_jurisdiction(p_provider text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_provider in ('weerg', 'geomiq', 'rapiddirect', 'protolabsnetwork') then 'foreign'
    when p_provider in (
      'xometry', 'fictiv', 'protolabs', 'sendcutsend', 'oshcut', 'fabworks',
      'ponoko', 'quickparts', 'partsbadger', 'fastdms', 'devzmanufacturing',
      'infraredlaboratories', 'emachineshop', 'rmfg'
    ) then 'us'
    else 'unknown'
  end;
$$;

revoke all on function private.export_control_terms_version() from public, anon, authenticated;
revoke all on function private.export_control_provider_jurisdiction(text) from public, anon, authenticated;

-- Per-job export state lock. Every writer of export state (declarations,
-- marking blocks, block reviews, clean scans) takes it exclusively. Every
-- reader that authorizes an upload, a Storage object, a finalize, or a
-- dispatch takes it shared and then reads in a NEW statement, so a volatile
-- caller reads with a snapshot taken after any conflicting writer committed.
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
  v_ua text;
  v_allowed boolean;
  v_rescans integer := 0;
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
  v_ua := nullif(v_headers ->> 'user-agent', '');

  perform private.lock_job_export_state(v_job.id, true);

  insert into private.job_export_declarations (
    job_id, part_id, organization_id, declared_by, answer, terms_version, ua_hash
  )
  values (
    v_job.id,
    p_part_id,
    v_job.organization_id,
    auth.uid(),
    p_answer,
    p_terms_version,
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

  -- A clean declaration releases files only once each has a clean scan of
  -- its current bytes. Files uploaded before it (above all parts extracted
  -- before OVD-723, which extraction never revisits) get a scan only rescan
  -- (1.16c); the worker scans them without any model call.
  if v_allowed then
    v_rescans := private.queue_export_marking_rescans(v_job.id);
  end if;

  return pg_catalog.jsonb_build_object(
    'declarationId', v_declaration_id,
    'answer', p_answer,
    'termsVersion', p_terms_version,
    'uploadAllowed', v_allowed,
    'reasonCode', private.job_export_upload_denial(v_job.id, v_declaration_id),
    'rescansQueued', v_rescans
  );
end;
$$;

revoke all on function public.api_declare_job_export_status(uuid, text, text, uuid) from public, anon;
grant execute on function public.api_declare_job_export_status(uuid, text, text, uuid) to authenticated;

-- 1.10 Read RPC for the client (members of the job's org, or platform admins).
-- scanState (private.job_export_scan_state, 1.16c) tells the part page whether
-- a file still waits for a scan of its current bytes and what the owner can
-- do about it.
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
begin
  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null
    or not (public.user_can_access_org(v_job.organization_id) or public.is_platform_admin()) then
    raise exception using errcode = '42501', message = 'export_status_forbidden';
  end if;

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
    'scanState', private.job_export_scan_state(v_job.id)
  );
end;
$$;

revoke all on function public.api_get_job_export_control_status(uuid) from public, anon;
grant execute on function public.api_get_job_export_control_status(uuid) to authenticated;

-- 1.11 Marking hits, recorded by the worker (service role only). Opening a
-- block never requires or accepts user input. p_content_sha256 is the hash of
-- the bytes whose text matched (null when no staged bytes exist). Answer:
--   {"blockId", "resolved": false}  a block is open or confirmed for this job,
--     file, and source (a repeat hit returns it and opens nothing), or a new
--     block was opened;
--   {"blockId", "resolved": true}   a platform admin already cleared a block
--     for this same job, file, source, and content hash whose patterns include
--     every pattern found now. The hit is that reviewed false positive: no new
--     block opens, and the admin cleared scan of these bytes is recorded
--     (1.12a) so dispatch admits them. A different hash or any new pattern is
--     not covered and opens a block.
create or replace function public.api_record_export_control_marking_hits(
  p_job_id uuid,
  p_part_id uuid,
  p_job_file_id uuid,
  p_source text,
  p_patterns text[],
  p_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_block_id uuid;
  v_cleared private.job_export_marking_blocks%rowtype;
  v_hash text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_content_sha256, ''))), '');
begin
  if p_patterns is null or cardinality(p_patterns) = 0
    or p_source is null or p_source not in ('drawing_text', 'drawing_ocr', 'step_header')
    or (v_hash is not null and v_hash !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = 'P0001', message = 'export_marking_invalid';
  end if;

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'export_marking_invalid';
  end if;

  perform private.lock_job_export_state(v_job.id, true);

  select block.id into v_block_id
  from private.job_export_marking_blocks block
  where block.job_id = v_job.id
    and block.job_file_id is not distinct from p_job_file_id
    and block.source = p_source
    and block.state in ('blocked_pending_review', 'confirmed_controlled')
  order by block.created_at, block.id
  limit 1;
  if v_block_id is not null then
    return pg_catalog.jsonb_build_object('blockId', v_block_id, 'resolved', false);
  end if;

  if p_job_file_id is not null and v_hash is not null then
    select block.* into v_cleared
    from private.job_export_marking_blocks block
    where block.job_id = v_job.id
      and block.job_file_id = p_job_file_id
      and block.source = p_source
      and block.state = 'cleared_by_admin'
      and block.content_sha256 = v_hash
      and p_patterns <@ block.patterns
    order by block.reviewed_at desc, block.id desc
    limit 1;
    if v_cleared.id is not null and private.record_admin_cleared_scan(v_cleared.id) then
      return pg_catalog.jsonb_build_object('blockId', v_cleared.id, 'resolved', true);
    end if;
  end if;

  insert into private.job_export_marking_blocks (
    job_id, organization_id, part_id, job_file_id, source, patterns, content_sha256
  )
  values (v_job.id, v_job.organization_id, p_part_id, p_job_file_id, p_source, p_patterns, v_hash)
  returning id into v_block_id;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_job.organization_id, v_job.id, p_part_id, null, 'marking_block_opened',
    pg_catalog.jsonb_build_object(
      'blockId', v_block_id,
      'source', p_source,
      'patterns', pg_catalog.to_jsonb(p_patterns),
      'jobFileId', p_job_file_id,
      'contentSha256', v_hash
    )
  );

  return pg_catalog.jsonb_build_object('blockId', v_block_id, 'resolved', false);
end;
$$;

revoke all on function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[], text)
  from public, anon, authenticated;
grant execute on function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[], text)
  to service_role;

-- 1.11b Clean marking scans, recorded by the worker (service role only).
-- Dispatch requires a clean scan of record for the dispatched part's own files
-- (1.15). This covers paths that skip extraction: a part that reuses another
-- part's trusted artifacts (api_reuse_trusted_part_version_artifacts), a file
-- reused from the org blob store, or a part extracted before OVD-723. None of
-- them has a scan in its own job until the worker scans it. Hits are not
-- stored here. They open a block (1.11). A row vouches only for one file id,
-- in one job, with one content hash: the hash of the bytes the worker read.
-- Dispatch (1.15) matches all three against the file's CURRENT job_id and
-- content_sha256, so a row that is later repointed (job_files is updatable by
-- internal org roles) or moved to another job loses its clean status.
create table if not exists private.job_file_export_scans (
  id uuid primary key default gen_random_uuid(),
  job_file_id uuid not null,
  job_id uuid not null,
  organization_id uuid not null,
  part_id uuid null,
  source text not null check (source in ('drawing_text', 'drawing_ocr', 'step_header')),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  scanned_at timestamptz not null default clock_timestamp(),
  -- Set only on a scan written by an admin clearance (1.12): the cleared block
  -- and the patterns it cleared. The text of these bytes did match; a platform
  -- admin reviewed it as a false positive. A worker scan leaves both null.
  cleared_block_id uuid null,
  cleared_patterns text[] null,
  constraint job_file_export_scans_cleared_shape check (
    (cleared_block_id is null) = (cleared_patterns is null)
    and (cleared_patterns is null or cardinality(cleared_patterns) > 0)
  )
);

create index if not exists job_file_export_scans_file_idx
  on private.job_file_export_scans (job_file_id, job_id, content_sha256, source);

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

-- p_content_sha256 is the SHA-256 the worker computed over the bytes it
-- scanned. It must equal the file's claimed content_sha256 (and its verified
-- trusted_content_sha256 when set); otherwise the call raises
-- export_content_hash_mismatch and nothing is recorded, so dispatch stays
-- denied. The part, when given, must be in the same job and reference the file.
create or replace function public.api_record_export_control_clean_scan(
  p_job_id uuid,
  p_part_id uuid,
  p_job_file_id uuid,
  p_source text,
  p_content_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.job_files%rowtype;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_content_sha256, '')));
  v_scan_id uuid;
begin
  if p_source is null or p_source not in ('drawing_text', 'drawing_ocr', 'step_header')
    or v_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'export_scan_invalid';
  end if;

  select file_row.* into v_file from public.job_files file_row where file_row.id = p_job_file_id;
  if v_file.id is null or v_file.job_id is distinct from p_job_id then
    raise exception using errcode = 'P0001', message = 'export_scan_invalid';
  end if;
  if p_part_id is not null and not exists (
    select 1
    from public.parts part
    where part.id = p_part_id
      and part.job_id = v_file.job_id
      and v_file.id in (part.cad_file_id, part.drawing_file_id)
  ) then
    raise exception using errcode = 'P0001', message = 'export_scan_invalid';
  end if;

  perform private.lock_job_export_state(v_file.job_id, true);

  -- Re-read under the lock: the row may have been repointed since.
  select file_row.* into v_file from public.job_files file_row where file_row.id = p_job_file_id;
  if v_file.id is null or v_file.job_id is distinct from p_job_id then
    raise exception using errcode = 'P0001', message = 'export_scan_invalid';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(v_file.content_sha256, ''))) is distinct from v_hash
    or (v_file.trusted_content_sha256 is not null and v_file.trusted_content_sha256 is distinct from v_hash) then
    raise exception using errcode = 'P0001', message = 'export_content_hash_mismatch';
  end if;

  insert into private.job_file_export_scans (
    job_file_id, job_id, organization_id, part_id, source, content_sha256
  )
  values (v_file.id, v_file.job_id, v_file.organization_id, p_part_id, p_source, v_hash)
  returning id into v_scan_id;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_file.organization_id, v_file.job_id, p_part_id, null, 'file_scan_recorded_clean',
    pg_catalog.jsonb_build_object(
      'scanId', v_scan_id, 'source', p_source, 'jobFileId', v_file.id, 'contentSha256', v_hash
    )
  );

  return v_scan_id;
end;
$$;

revoke all on function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text, text)
  to service_role;

-- 1.12a Admin cleared scan. A false positive cleared by a platform admin
-- vouches for exactly the bytes and patterns that were reviewed: the block's
-- file id, its job, its content hash, and its source. It is recorded as a scan
-- of record (cleared_block_id, cleared_patterns set) only while the file is
-- still in that job with that same claimed hash (and verified hash, when
-- set). Otherwise nothing is recorded: the bytes changed, and the worker must
-- scan them again. Idempotent. Returns whether such a scan exists now. The
-- caller holds the job's exclusive export lock.
create or replace function private.record_admin_cleared_scan(p_block_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_block private.job_export_marking_blocks%rowtype;
  v_file public.job_files%rowtype;
  v_scan_id uuid;
begin
  select block.* into v_block
  from private.job_export_marking_blocks block
  where block.id = p_block_id and block.state = 'cleared_by_admin';
  if v_block.id is null or v_block.job_file_id is null or v_block.content_sha256 is null then
    return false;
  end if;

  select file_row.* into v_file from public.job_files file_row where file_row.id = v_block.job_file_id;
  if v_file.id is null
    or v_file.job_id is distinct from v_block.job_id
    or pg_catalog.lower(pg_catalog.btrim(coalesce(v_file.content_sha256, ''))) is distinct from v_block.content_sha256
    or (v_file.trusted_content_sha256 is not null and v_file.trusted_content_sha256 is distinct from v_block.content_sha256) then
    return false;
  end if;

  if exists (
    select 1
    from private.job_file_export_scans scan
    where scan.job_file_id = v_file.id
      and scan.job_id = v_file.job_id
      and scan.content_sha256 = v_block.content_sha256
      and scan.source = v_block.source
      and scan.cleared_block_id = v_block.id
  ) then
    return true;
  end if;

  insert into private.job_file_export_scans (
    job_file_id, job_id, organization_id, part_id, source, content_sha256,
    cleared_block_id, cleared_patterns
  )
  values (
    v_file.id, v_file.job_id, v_file.organization_id, v_block.part_id, v_block.source,
    v_block.content_sha256, v_block.id, v_block.patterns
  )
  returning id into v_scan_id;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_file.organization_id, v_file.job_id, v_block.part_id, v_block.reviewed_by, 'file_scan_recorded_admin_cleared',
    pg_catalog.jsonb_build_object(
      'scanId', v_scan_id, 'blockId', v_block.id, 'source', v_block.source,
      'jobFileId', v_file.id, 'contentSha256', v_block.content_sha256,
      'patterns', pg_catalog.to_jsonb(v_block.patterns)
    )
  );

  return true;
end;
$$;

revoke all on function private.record_admin_cleared_scan(uuid)
  from public, anon, authenticated, service_role;

-- 1.12 Admin review. Users cannot clear a block; only platform admins can,
-- with a mandatory note, and every decision is an audit event. Clearing a
-- false positive also records the admin cleared scan of the reviewed bytes
-- (1.12a), so the part becomes dispatchable once nothing else holds it; a
-- later hit on the same bytes and patterns resolves to this clearance
-- (1.11), and a new hash or pattern opens a new block.
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
  v_scan_recorded boolean := false;
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

  if p_decision = 'cleared_by_admin' then
    v_scan_recorded := private.record_admin_cleared_scan(v_block.id);
  end if;

  return pg_catalog.jsonb_build_object(
    'blockId', v_block.id,
    'state', v_block.state,
    'scanRecorded', v_scan_recorded
  );
end;
$$;

revoke all on function public.api_review_export_control_block(uuid, text, text) from public, anon;
grant execute on function public.api_review_export_control_block(uuid, text, text) to authenticated;

-- 1.13 Upload RPCs (expand). The legacy 6- and 8-argument RPCs are not
-- touched in window 1. New overloads take p_export_declaration_id with no
-- default (so PostgREST never finds the signatures ambiguous), check the
-- declaration, and reach the upload logic through two private delegates. In
-- window 1 the delegates call the legacy RPCs; the contract migration moves
-- the legacy bodies into private cores and repoints only the delegates.
create or replace function private.job_file_prepare_delegate(
  p_job_id uuid,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text,
  p_size_bytes bigint,
  p_content_sha256 text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  return public.api_prepare_job_file_upload(
    p_job_id, p_original_name, p_file_kind, p_mime_type, p_size_bytes, p_content_sha256
  );
end;
$$;

create or replace function private.job_file_finalize_delegate(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text,
  p_size_bytes bigint,
  p_content_sha256 text
)
returns uuid
language plpgsql
set search_path = ''
as $$
begin
  return public.api_finalize_job_file_upload(
    p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
    p_mime_type, p_size_bytes, p_content_sha256
  );
end;
$$;

revoke all on function private.job_file_prepare_delegate(
  uuid, text, public.job_file_kind, text, bigint, text
) from public, anon, authenticated, service_role;
revoke all on function private.job_file_finalize_delegate(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) from public, anon, authenticated, service_role;

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
    return private.job_file_prepare_delegate(
      p_job_id, p_original_name, p_file_kind, p_mime_type, p_size_bytes, p_content_sha256
    );
  end if;

  -- Declaration first: a denied call writes no job_files, blobs, or grants.
  perform private.require_clean_export_declaration(v_job.id, p_export_declaration_id);

  v_result := private.job_file_prepare_delegate(
    p_job_id, p_original_name, p_file_kind, p_mime_type, p_size_bytes, p_content_sha256
  );

  if v_result ->> 'status' = 'upload_required' then
    insert into private.export_cleared_upload_grants (
      organization_id, job_id, declaration_id, content_sha256, size_bytes,
      storage_bucket, storage_path, granted_to, expires_at
    )
    values (
      v_job.organization_id,
      v_job.id,
      p_export_declaration_id,
      pg_catalog.lower(pg_catalog.btrim(p_content_sha256)),
      p_size_bytes,
      v_result ->> 'storageBucket',
      v_result ->> 'storagePath',
      auth.uid(),
      pg_catalog.clock_timestamp() + interval '15 minutes'
    );
  end if;

  return v_result;
end;
$$;

-- Finalize registers the object only when this user owns the object at the
-- exact granted path, it was written before the grant expired, its size is
-- the granted size, and the job's latest declaration is still the clean one
-- (checked under the shared lock). The core runs first so its own denials
-- (empty file, path, missing object, Founding Beta) keep their precedence; a
-- missing grant then raises file_upload_grant_missing, which rolls back
-- everything the core wrote. The grant is consumed on success.
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
  v_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_content_sha256, '')));
  v_expected_path text;
  v_grant_ids uuid[];
  v_file_id uuid;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null or not public.user_can_edit_job(v_job.id) then
    return private.job_file_finalize_delegate(
      p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
      p_mime_type, p_size_bytes, p_content_sha256
    );
  end if;

  perform private.require_clean_export_declaration(v_job.id, p_export_declaration_id);

  v_file_id := private.job_file_finalize_delegate(
    p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
    p_mime_type, p_size_bytes, p_content_sha256
  );

  if v_hash ~ '^[0-9a-f]{64}$' then
    v_expected_path := public.build_org_file_blob_storage_path(
      v_job.organization_id, v_hash, p_original_name
    );
  end if;

  select pg_catalog.array_agg(grant_row.id) into v_grant_ids
  from private.export_cleared_upload_grants grant_row
  join storage.objects object_row
    on object_row.bucket_id = grant_row.storage_bucket
   and object_row.name = grant_row.storage_path
  where grant_row.granted_to = auth.uid()
    and grant_row.job_id = v_job.id
    and grant_row.organization_id = v_job.organization_id
    and grant_row.storage_bucket = p_storage_bucket
    and grant_row.storage_path = p_storage_path
    and grant_row.storage_path = v_expected_path
    and grant_row.content_sha256 = v_hash
    and grant_row.size_bytes = p_size_bytes
    and grant_row.finalized_at is null
    and coalesce(object_row.owner_id, object_row.owner::text) = auth.uid()::text
    and object_row.created_at <= grant_row.expires_at
    and (
      object_row.metadata ->> 'size' is null
      or object_row.metadata ->> 'size' = p_size_bytes::text
    );

  if v_grant_ids is null then
    raise exception using
      errcode = 'P0001', -- NOSONAR: stable customer-safe PostgreSQL error contract
      message = 'file_upload_grant_missing';
  end if;

  update private.export_cleared_upload_grants grant_row
  set finalized_at = pg_catalog.clock_timestamp(),
      job_file_id = v_file_id
  where grant_row.id = any (v_grant_ids)
    and grant_row.finalized_at is null;

  return v_file_id;
end;
$$;

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

-- 1.14 Storage helper for the job-files INSERT policy (1.18). True only for
-- an unexpired, unfinalized grant to this user for this exact bucket and
-- path, whose job's latest declaration is still the granted one, clean, and
-- unblocked. VOLATILE on purpose: it takes the shared per-job lock and then
-- evaluates the declaration in a new statement, so it waits for a concurrent
-- declaration or marking writer and then sees what that writer committed.
-- Storage (storage-api) evaluates this policy in its permission check before
-- it accepts the bytes; the final row write may run with elevated rights, so
-- finalize (1.13) repeats every check against the stored row.
create or replace function public.current_user_has_export_cleared_upload(
  p_bucket_id text,
  p_object_name text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant record;
begin
  if auth.uid() is null or p_bucket_id is distinct from 'job-files' or p_object_name is null then
    return false;
  end if;

  for v_grant in
    select grant_row.job_id, grant_row.declaration_id
    from private.export_cleared_upload_grants grant_row
    where grant_row.storage_bucket = p_bucket_id
      and grant_row.storage_path = p_object_name
      and grant_row.granted_to = auth.uid()
      and grant_row.finalized_at is null
      and grant_row.expires_at > pg_catalog.clock_timestamp()
    order by grant_row.created_at desc
  loop
    perform private.lock_job_export_state(v_grant.job_id, false);
    if private.job_export_upload_denial(v_grant.job_id, v_grant.declaration_id) is null then
      return true;
    end if;
  end loop;
  return false;
exception when others then
  return false; -- fail closed
end;
$$;

revoke all on function public.current_user_has_export_cleared_upload(text, text) from public, anon;
grant execute on function public.current_user_has_export_cleared_upload(text, text) to authenticated;

-- 1.15 Dispatch gate evaluation (used by the 1.16 check and, after the
-- contract migration, by the preflight wrappers).
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

-- Scan rule: every file the dispatched part sends must be in the task's job,
-- have a worker-verified hash equal to its claimed content_sha256, and (for
-- the drawing and a STEP CAD file) have a clean scan of record bound to the
-- same file id, the file's CURRENT job, and the file's CURRENT content hash.
-- A repointed or moved job_files row therefore loses its clean status. A
-- missing part or file reference is a denial. Other CAD formats have no
-- scanner yet; they still need the verified hash (see notes).
create or replace function private.export_control_file_denial(
  p_job_id uuid,
  p_file_id uuid,
  p_scan_sources text[]
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_file public.job_files%rowtype;
  v_hash text;
begin
  select file_row.* into v_file from public.job_files file_row where file_row.id = p_file_id;
  if v_file.id is null or v_file.job_id is distinct from p_job_id then
    return 'export_scan_missing';
  end if;
  v_hash := pg_catalog.lower(pg_catalog.btrim(coalesce(v_file.content_sha256, '')));
  if v_hash !~ '^[0-9a-f]{64}$' or v_file.trusted_content_sha256 is distinct from v_hash then
    return 'export_scan_missing';
  end if;
  if p_scan_sources is not null and not exists (
    select 1
    from private.job_file_export_scans scan
    where scan.job_file_id = v_file.id
      and scan.job_id = v_file.job_id
      and scan.content_sha256 = v_hash
      and scan.source = any (p_scan_sources)
  ) then
    return 'export_scan_missing';
  end if;
  return null;
end;
$$;

create or replace function private.export_control_scan_denial(p_job_id uuid, p_part_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_part public.parts%rowtype;
  v_cad public.job_files%rowtype;
  v_denial text;
begin
  if p_job_id is null or p_part_id is null then
    return 'export_scan_missing';
  end if;

  select part_row.* into v_part from public.parts part_row where part_row.id = p_part_id;
  if v_part.id is null or v_part.job_id is distinct from p_job_id then
    return 'export_scan_missing';
  end if;

  if v_part.drawing_file_id is not null then
    v_denial := private.export_control_file_denial(
      v_part.job_id, v_part.drawing_file_id, array['drawing_text', 'drawing_ocr']
    );
    if v_denial is not null then
      return v_denial;
    end if;
  end if;

  if v_part.cad_file_id is not null then
    select file_row.* into v_cad from public.job_files file_row where file_row.id = v_part.cad_file_id;
    v_denial := private.export_control_file_denial(
      v_part.job_id,
      v_part.cad_file_id,
      case
        when pg_catalog.lower(pg_catalog.btrim(coalesce(v_cad.original_name, ''))) ~ '\.(step|stp)$'
          then array['step_header']
        else null
      end
    );
    if v_denial is not null then
      return v_denial;
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
  return private.export_control_scan_denial(v_job_id, v_part_id);
exception when others then
  return 'export_control_lookup_failed';
end;
$$;

revoke all on function private.export_control_dispatch_denial(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.export_control_dispatch_denial_for_task(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.export_control_scan_denial(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.export_control_file_denial(uuid, uuid, text[])
  from public, anon, authenticated, service_role;

-- 1.16 Dispatch check for the worker (expand). The existing preflights are
-- not touched in window 1. The new worker calls this before every preflight
-- and treats anything but {"allowed": true} as a denial. The contract
-- migration also wraps both preflights, so the gate then holds on the
-- server for any worker.
create or replace function public.api_check_export_control_dispatch(
  p_work_queue_task_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_denial text;
begin
  v_denial := private.export_control_dispatch_denial_for_task(p_work_queue_task_id, p_provider);
  if v_denial is not null then
    return pg_catalog.jsonb_build_object('allowed', false, 'reasonCode', v_denial);
  end if;
  return pg_catalog.jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.api_check_export_control_dispatch(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_check_export_control_dispatch(uuid, text)
  to service_role;

-- 1.16b Extraction check for the worker (expand). Asked before any CAD or
-- drawing content is sent to an extraction model. Allowed only when the job's
-- latest declaration is not_controlled and no marking block is open or
-- confirmed; the provider jurisdiction plays no part. In window 1 the legacy
-- upload path is still open, so an undeclared job (a stale tab, a direct API
-- call, a service-role import) can hold files; this check keeps them away
-- from the model. Any lookup error is a denial.
create or replace function private.export_control_extraction_denial(p_job_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_answer text;
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

  if v_answer is null or v_answer = 'missing' then
    return 'export_declaration_missing';
  end if;
  if v_answer is distinct from 'not_controlled' then
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
exception when others then
  return 'export_control_lookup_failed';
end;
$$;

revoke all on function private.export_control_extraction_denial(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.api_check_export_control_extraction(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_denial text;
begin
  v_denial := private.export_control_extraction_denial(p_job_id);
  if v_denial is not null then
    return pg_catalog.jsonb_build_object('allowed', false, 'reasonCode', v_denial);
  end if;
  return pg_catalog.jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.api_check_export_control_extraction(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_check_export_control_extraction(uuid)
  to service_role;

-- 1.16c Scan only rescan (expand). Queues one export_marking_rescan task
-- per file a part of the job sends that needs a scan (the part's drawing, or
-- its CAD file when named .step/.stp, as in the dispatch denial) and has no scan of record for its id, its current job, and its
-- current content hash, unless such a task is already queued or running.
-- The worker task (handleExportMarkingRescanTask) stages the bytes, verifies
-- their hash, scans drawing text or the STEP header, and records a clean scan
-- or opens a block. It never calls a model. This closes the gap that
-- api_request_extraction leaves: it skips a part that already has an
-- extraction, so a part extracted before OVD-723 would otherwise never get a
-- drawing scan and stay export_scan_missing. Called by the declare RPC (1.9)
-- after a clean declaration, by the job owner through
-- api_request_export_marking_rescan, and by the service role through
-- api_queue_export_marking_rescan. A file whose last scan of the same bytes
-- (a rescan, or the part's extraction) ended drawing_unread or
-- step_header_incomplete is not queued again (the answer would not change).
-- Extraction (extract_part) scans the part's drawing and STEP header itself,
-- so a new upload needs no rescan. Returns the number of tasks queued.
-- Final outcome of the latest scan of one file's bytes in its job: a
-- completed export_marking_rescan task (payload exportScanOutcome), or an
-- extract_part task that scanned the part's files (payload
-- exportScanOutcomes, keyed by job file id; written on completion and on the
-- failure that an unread drawing causes). A drawing that could not be read
-- (drawing_unread) or a STEP header that ended before ENDSEC;
-- (step_header_incomplete) gives the same answer for the same bytes, so
-- neither is queued again for that hash; replacing the file (a new hash)
-- queues a fresh rescan. Null when there is no such outcome. The job and
-- task type predicates match work_queue's (status, task_type) index, so a
-- status read does not walk every completed task.
create or replace function private.export_rescan_final_outcome(
  p_job_id uuid,
  p_job_file_id uuid,
  p_content_sha256 text
)
returns text
language sql
stable
set search_path = ''
as $$
  select latest.outcome
  from (
    select coalesce(
      queue.payload -> 'exportScanOutcomes' -> p_job_file_id::text ->> 'outcome',
      queue.payload ->> 'exportScanOutcome'
    ) as outcome
    from public.work_queue queue
    where queue.job_id = p_job_id
      and (
        (
          queue.status = 'completed'
          and queue.task_type = 'export_marking_rescan'::text::public.queue_task_type
          and queue.payload ->> 'jobFileId' = p_job_file_id::text
          and queue.payload ->> 'contentSha256' = p_content_sha256
        )
        or (
          queue.status in ('completed', 'failed')
          and queue.task_type = 'extract_part'::text::public.queue_task_type
          and queue.payload -> 'exportScanOutcomes' -> p_job_file_id::text ->> 'contentSha256' = p_content_sha256
        )
      )
    order by queue.updated_at desc, queue.created_at desc, queue.id desc
    limit 1
  ) latest
  where latest.outcome in ('drawing_unread', 'step_header_incomplete');
$$;

revoke all on function private.export_rescan_final_outcome(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- Scan state of a job for the part page (1.10). Over every file a part of
-- the job sends that needs a scan, the same files the dispatch denial checks
-- (export_control_scan_denial: the part's drawing, and its CAD file when
-- named .step/.stp), with a well formed hash and no scan of record for its
-- current bytes. A replaced file that no part references any more (an older
-- drawing under the same base name) does not count:
--   pending                 a rescan of the file, or an extraction of the
--                           job, is queued or running;
--   drawing_unread          the last rescan of these bytes could not read
--                           every page (replace the drawing);
--   step_header_incomplete  the last rescan of these bytes found no complete
--                           STEP header (replace the STEP file);
--   missing                 nothing will scan the file on its own (a failed
--                           rescan, an old worker, or none queued); the owner
--                           can requeue it (api_request_export_marking_rescan).
-- The most actionable state wins (missing first). complete when no such file.
create or replace function private.job_export_scan_state(p_job_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select unscanned.state
      from (
        select
          case
            when exists (
              select 1
              from public.work_queue queue
              where queue.job_id = file_row.job_id
                and queue.status in ('queued', 'running')
                and (
                  (queue.task_type::text = 'export_marking_rescan'
                    and queue.payload ->> 'jobFileId' = file_row.id::text)
                  or queue.task_type::text = 'extract_part'
                )
            ) then 'pending'
            else coalesce(
              private.export_rescan_final_outcome(
                file_row.job_id, file_row.id, pg_catalog.lower(pg_catalog.btrim(file_row.content_sha256))
              ),
              'missing'
            )
          end as state
        from public.job_files file_row
        where file_row.job_id = p_job_id
          and exists (
            select 1
            from public.parts part
            where part.job_id = file_row.job_id
              and (
                part.drawing_file_id = file_row.id
                or (
                  part.cad_file_id = file_row.id
                  and pg_catalog.lower(pg_catalog.btrim(coalesce(file_row.original_name, ''))) ~ '\.(step|stp)$'
                )
              )
          )
          and pg_catalog.lower(pg_catalog.btrim(coalesce(file_row.content_sha256, ''))) ~ '^[0-9a-f]{64}$'
          and not exists (
            select 1
            from private.job_file_export_scans scan
            where scan.job_file_id = file_row.id
              and scan.job_id = file_row.job_id
              and scan.content_sha256 = pg_catalog.lower(pg_catalog.btrim(file_row.content_sha256))
          )
      ) unscanned
      order by case unscanned.state
        when 'missing' then 1
        when 'drawing_unread' then 2
        when 'step_header_incomplete' then 3
        else 4
      end
      limit 1
    ),
    'complete'
  );
$$;

revoke all on function private.job_export_scan_state(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.queue_export_marking_rescans(p_job_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_count integer := 0;
begin
  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null then
    return 0;
  end if;

  -- Serializes with declarations, scans and other queue calls for this job,
  -- so two callers cannot queue the same file twice.
  perform private.lock_job_export_state(v_job.id, true);

  with candidates as (
    select
      file_row.id as job_file_id,
      pg_catalog.lower(pg_catalog.btrim(file_row.content_sha256)) as content_sha256,
      (
        select part.id
        from public.parts part
        where part.job_id = file_row.job_id
          and file_row.id in (part.cad_file_id, part.drawing_file_id)
        order by part.id
        limit 1
      ) as part_id
    from public.job_files file_row
    where file_row.job_id = v_job.id
      -- Only files a part of the job sends, as in the dispatch denial and
      -- job_export_scan_state; a replaced file no part references is skipped.
      and exists (
        select 1
        from public.parts part
        where part.job_id = file_row.job_id
          and (
            part.drawing_file_id = file_row.id
            or (
              part.cad_file_id = file_row.id
              and pg_catalog.lower(pg_catalog.btrim(coalesce(file_row.original_name, ''))) ~ '\.(step|stp)$'
            )
          )
      )
      and pg_catalog.lower(pg_catalog.btrim(coalesce(file_row.content_sha256, ''))) ~ '^[0-9a-f]{64}$'
      and not exists (
        select 1
        from private.job_file_export_scans scan
        where scan.job_file_id = file_row.id
          and scan.job_id = file_row.job_id
          and scan.content_sha256 = pg_catalog.lower(pg_catalog.btrim(file_row.content_sha256))
      )
      and not exists (
        select 1
        from public.work_queue queue
        where queue.job_id = file_row.job_id
          and queue.task_type::text = 'export_marking_rescan'
          and queue.status in ('queued', 'running')
          and queue.payload ->> 'jobFileId' = file_row.id::text
      )
      and private.export_rescan_final_outcome(
        file_row.job_id, file_row.id, pg_catalog.lower(pg_catalog.btrim(file_row.content_sha256))
      ) is null
  ),
  queued as (
    insert into public.work_queue (organization_id, job_id, part_id, task_type, payload)
    select
      v_job.organization_id,
      v_job.id,
      candidate.part_id,
      'export_marking_rescan'::text::public.queue_task_type,
      pg_catalog.jsonb_build_object(
        'jobId', v_job.id,
        'jobFileId', candidate.job_file_id,
        'contentSha256', candidate.content_sha256
      )
    from candidates candidate
    returning id
  )
  select count(*)::integer into v_count from queued;

  if v_count > 0 then
    insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
    values (
      v_job.organization_id, v_job.id, null, auth.uid(), 'export_marking_rescan_queued',
      pg_catalog.jsonb_build_object('tasksQueued', v_count)
    );
  end if;

  return v_count;
end;
$$;

revoke all on function private.queue_export_marking_rescans(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.api_queue_export_marking_rescan(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job_id is null or not exists (select 1 from public.jobs job_row where job_row.id = p_job_id) then
    raise exception using errcode = 'P0001', message = 'export_rescan_invalid';
  end if;
  return private.queue_export_marking_rescans(p_job_id);
end;
$$;

revoke all on function public.api_queue_export_marking_rescan(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_queue_export_marking_rescan(uuid)
  to service_role;

-- Owner recovery. A file whose rescan failed for good (a transient Storage or
-- RPC error through every retry, or an old worker that does not know the task
-- type during the deploy gap) is never queued again on its own, and a clean
-- declaration shows no other action. The part page offers "Recheck files"
-- (scanState missing, 1.10), which calls this. It requires a verified user
-- who can edit the job and a clean, unblocked latest declaration (checked
-- under the job lock), and it only queues scan only rescans; it records no
-- scan and changes no declaration or block.
create or replace function public.api_request_export_marking_rescan(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_latest_id uuid;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null
    or not public.user_can_access_org(v_job.organization_id)
    or not public.user_can_edit_job(v_job.id) then
    raise exception using errcode = '42501', message = 'export_rescan_forbidden';
  end if;

  perform private.lock_job_export_state(v_job.id, true);

  select declaration.id into v_latest_id
  from private.job_export_declarations declaration
  where declaration.job_id = v_job.id
  order by declaration.declared_at desc, declaration.id desc
  limit 1;
  if private.job_export_upload_denial(v_job.id, v_latest_id) is not null then
    raise exception using errcode = 'P0001', message = 'export_rescan_not_allowed';
  end if;

  return private.queue_export_marking_rescans(v_job.id);
end;
$$;

revoke all on function public.api_request_export_marking_rescan(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_export_marking_rescan(uuid)
  to authenticated;

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
where declaration.answer = 'missing'
  and not exists (
    select 1
    from private.export_control_events event_row
    where event_row.event = 'declaration_backfilled_missing'
      and event_row.job_id = declaration.job_id
      and event_row.detail ->> 'declarationId' = declaration.id::text
  );

-- 1.18 Storage (expand). A second job-files INSERT policy is added
-- alongside the existing "job_files_storage_insert" (20260815093000), which
-- is not touched. Permissive policies combine with OR, so in window 1 this
-- policy changes nothing; the contract migration drops the old policy, and
-- then this one alone decides: no job-files object without an exact,
-- declaration backed grant (1.14). Creating a policy takes ACCESS EXCLUSIVE
-- on storage.objects; the lock timeout makes the migration fail fast (and
-- roll back whole) rather than queue every Storage read and write behind a
-- long running query. On a timeout, rerun at lower traffic.
set local lock_timeout = '3s';
drop policy if exists "job_files_storage_insert_export_cleared" on storage.objects;
create policy "job_files_storage_insert_export_cleared"
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
  and public.current_user_has_export_cleared_upload(bucket_id, name)
);

-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Executable and guarded: docs/migration-drafts/ovd-723.rollback.sql. It
-- refuses while the contract migration is applied (roll that back first),
-- drops only what this migration created, and keeps the audit tables.
