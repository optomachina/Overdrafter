-- OVD-345
-- Persist immutable vendor/part/quantity quote scopes and explicit offer validity.
--
-- Commercial validity is vendor-stated only. Historical offers are intentionally
-- left with unknown validity, and historical runs are not assigned speculative
-- scope fingerprints. The separate 14-day collection-freshness presentation
-- rule remains an application concern.
--
-- Rollback: disable lane/validity readers, drop the normalization and lane
-- attachment triggers/functions, then drop the additive lane table and offer
-- validity columns. Historical quote rows remain intact.

-- Worker-trusted hashes are populated by the canonical identity migration. The
-- columns are declared here so quote scopes can prefer them immediately while
-- remaining migration-order safe.
alter table public.organization_file_blobs
add column if not exists trusted_content_sha256 text;
alter table public.job_files
add column if not exists trusted_content_sha256 text;

alter table public.organization_file_blobs
drop constraint if exists organization_file_blobs_trusted_content_sha256_check;
alter table public.organization_file_blobs
add constraint organization_file_blobs_trusted_content_sha256_check
check (trusted_content_sha256 is null or trusted_content_sha256 ~ '^[0-9a-f]{64}$');

alter table public.job_files
drop constraint if exists job_files_trusted_content_sha256_check;
alter table public.job_files
add constraint job_files_trusted_content_sha256_check
check (trusted_content_sha256 is null or trusted_content_sha256 ~ '^[0-9a-f]{64}$');

create or replace function public.api_register_trusted_file_hash(
  p_job_file_id uuid,
  p_content_sha256 text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_file public.job_files%rowtype;
begin
  if p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Trusted file hash must be a lowercase SHA-256 digest.';
  end if;

  select * into v_file
  from public.job_files
  where id = p_job_file_id
  for update;

  if v_file.id is null then
    raise exception 'Job file was not found.';
  end if;

  if v_file.trusted_content_sha256 is not null
    and v_file.trusted_content_sha256 <> p_content_sha256 then
    raise exception 'Stored file content changed after registration.';
  end if;

  update public.job_files
  set trusted_content_sha256 = p_content_sha256
  where id = v_file.id;

  if v_file.blob_id is not null then
    update public.organization_file_blobs
    set trusted_content_sha256 = p_content_sha256
    where id = v_file.blob_id
      and organization_id = v_file.organization_id
      and (trusted_content_sha256 is null or trusted_content_sha256 = p_content_sha256);

    if not found then
      raise exception 'Organization blob hash conflicts with downloaded file content.';
    end if;
  end if;
end;
$$;

revoke all on function public.api_register_trusted_file_hash(uuid, text)
from public, anon, authenticated;
grant execute on function public.api_register_trusted_file_hash(uuid, text)
to service_role;

alter table public.vendor_quote_offers
add column if not exists quoted_at timestamptz,
add column if not exists valid_until timestamptz,
add column if not exists validity_duration_days integer,
add column if not exists validity_source text,
add column if not exists validity_terms text,
add column if not exists provenance_status text not null default 'unverified';

alter table public.vendor_quote_offers
drop constraint if exists vendor_quote_offers_validity_duration_days_check,
drop constraint if exists vendor_quote_offers_validity_source_check,
drop constraint if exists vendor_quote_offers_provenance_status_check;

alter table public.vendor_quote_offers
add constraint vendor_quote_offers_validity_duration_days_check
  check (validity_duration_days is null or validity_duration_days > 0),
add constraint vendor_quote_offers_validity_source_check
  check (
    validity_source is null
    or validity_source in ('vendor_date', 'vendor_duration', 'operator_date', 'operator_duration')
  ),
add constraint vendor_quote_offers_provenance_status_check
  check (provenance_status in ('trusted_adapter', 'manual_verified', 'imported', 'unverified'));

create index if not exists idx_vendor_quote_offers_validity
on public.vendor_quote_offers(valid_until, vendor_quote_result_id)
where valid_until is not null;

create table if not exists public.quote_request_lanes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_request_id uuid not null references public.quote_requests(id) on delete cascade,
  quote_run_id uuid not null references public.quote_runs(id) on delete cascade,
  vendor_quote_result_id uuid unique references public.vendor_quote_results(id) on delete cascade,
  part_id uuid not null references public.parts(id) on delete cascade,
  vendor public.vendor_name not null,
  requested_quantity integer not null,
  scope_version integer not null default 1,
  scope_fingerprint text not null,
  scope_snapshot jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint quote_request_lanes_requested_quantity_check check (requested_quantity > 0),
  constraint quote_request_lanes_scope_version_check check (scope_version > 0),
  constraint quote_request_lanes_scope_fingerprint_check check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint quote_request_lanes_scope_snapshot_check check (jsonb_typeof(scope_snapshot) = 'object'),
  unique (quote_request_id, part_id, vendor, requested_quantity)
);

alter table public.quote_request_lanes enable row level security;

create index if not exists idx_quote_request_lanes_scope_history
on public.quote_request_lanes(
  organization_id,
  vendor,
  part_id,
  requested_quantity,
  scope_fingerprint,
  created_at desc
);

revoke all on public.quote_request_lanes from public, anon, authenticated;
grant all on public.quote_request_lanes to service_role;

create or replace function private.normalize_quote_offer_validity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_raw_quoted_at text := nullif(new.raw_payload ->> 'quotedAt', '');
  v_raw_valid_until text := coalesce(
    nullif(new.raw_payload ->> 'validUntil', ''),
    nullif(new.raw_payload ->> 'validUntilIso', '')
  );
  v_raw_duration text := coalesce(
    nullif(new.raw_payload ->> 'validityDurationDays', ''),
    nullif(new.raw_payload ->> 'validForDays', '')
  );
  v_raw_source text := nullif(new.raw_payload ->> 'validitySource', '');
  v_adapter_source text := coalesce(new.raw_payload ->> 'source', '');
begin
  if v_adapter_source = '' then
    select coalesce(result.raw_payload ->> 'source', '')
    into v_adapter_source
    from public.vendor_quote_results result
    where result.id = new.vendor_quote_result_id;
  end if;
  if new.quoted_at is null then
    if v_raw_quoted_at ~ '^\d{4}-\d{2}-\d{2}([T ].*)?$' then
      new.quoted_at := v_raw_quoted_at::timestamptz;
    elsif new.quote_date is not null then
      new.quoted_at := new.quote_date::timestamp at time zone 'UTC';
    end if;
  end if;

  if new.validity_duration_days is not null and new.validity_duration_days <= 0 then
    new.validity_duration_days := null;
  end if;

  if new.validity_duration_days is null and v_raw_duration ~ '^[1-9]\d*$' then
    new.validity_duration_days := v_raw_duration::integer;
  end if;

  if new.valid_until is null and v_raw_valid_until ~ '^\d{4}-\d{2}-\d{2}$' then
    -- A vendor date is inclusive through that calendar date.
    new.valid_until := ((v_raw_valid_until::date + 1)::timestamp at time zone 'UTC') - interval '1 microsecond';
  elsif new.valid_until is null and v_raw_valid_until ~ '^\d{4}-\d{2}-\d{2}T' then
    new.valid_until := v_raw_valid_until::timestamptz;
  end if;

  if new.valid_until is null
    and new.validity_duration_days is not null
    and new.quoted_at is not null then
    new.valid_until := new.quoted_at + make_interval(days => new.validity_duration_days);
  end if;

  -- When a vendor supplies both a date and a duration, the explicit date is
  -- authoritative. Preserve the original wording in validity_terms, but keep
  -- the normalized duration internally consistent with the date.
  if new.valid_until is not null
    and new.quoted_at is not null
    and new.valid_until >= new.quoted_at then
    new.validity_duration_days := greatest(
      1,
      ceil(extract(epoch from (new.valid_until - new.quoted_at)) / 86400.0)::integer
    );
  end if;

  if new.validity_source is null and v_raw_source in (
    'vendor_date', 'vendor_duration', 'operator_date', 'operator_duration'
  ) then
    new.validity_source := v_raw_source;
  end if;

  if new.validity_source is null then
    if new.valid_until is not null and v_raw_valid_until is not null then
      new.validity_source := case
        when v_adapter_source = 'manual-quote-admin-inbox' then 'operator_date'
        else 'vendor_date'
      end;
    elsif new.validity_duration_days is not null and v_raw_duration is not null then
      new.validity_source := case
        when v_adapter_source = 'manual-quote-admin-inbox' then 'operator_duration'
        else 'vendor_duration'
      end;
    end if;
  end if;

  if new.valid_until is not null
    and new.validity_source in ('vendor_duration', 'operator_duration')
    and v_raw_valid_until is not null then
    new.validity_source := case new.validity_source
      when 'operator_duration' then 'operator_date'
      else 'vendor_date'
    end;
  end if;

  if new.validity_terms is null then
    new.validity_terms := coalesce(
      nullif(new.raw_payload ->> 'validityTerms', ''),
      nullif(new.raw_payload ->> 'originalValidityTerms', '')
    );
  end if;

  if new.provenance_status = 'unverified' then
    if v_adapter_source = 'manual-quote-admin-inbox' then
      new.provenance_status := 'manual_verified';
    elsif v_adapter_source like '%-live-adapter' then
      new.provenance_status := 'trusted_adapter';
    elsif v_adapter_source like '%simulated%' or v_adapter_source = 'simulate' then
      new.provenance_status := 'unverified';
    elsif coalesce(new.raw_payload ->> 'imported', '') = 'true' then
      new.provenance_status := 'imported';
    end if;
  end if;

  return new;
exception
  when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    -- Preserve the original terms but never infer validity from malformed data.
    new.valid_until := null;
    new.validity_duration_days := null;
    new.validity_source := null;
    return new;
end;
$$;

drop trigger if exists normalize_quote_offer_validity
on public.vendor_quote_offers;
create trigger normalize_quote_offer_validity
before insert or update of quote_date, quoted_at, valid_until, validity_duration_days, validity_source, validity_terms, provenance_status, raw_payload
on public.vendor_quote_offers
for each row execute function private.normalize_quote_offer_validity();

create or replace function private.quote_scope_fingerprint(p_scope_snapshot jsonb)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, extensions
as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_scope_snapshot::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.api_register_quote_request_lane(
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_result public.vendor_quote_results%rowtype;
  v_quote_request_id uuid;
  v_part public.parts%rowtype;
  v_cad_file public.job_files%rowtype;
  v_drawing_file public.job_files%rowtype;
  v_scope_fingerprint text;
  v_existing_lane public.quote_request_lanes%rowtype;
begin
  select * into v_result
  from public.vendor_quote_results
  where id = p_vendor_quote_result_id
  for update;

  if v_result.id is null then
    raise exception 'Vendor quote result was not found.';
  end if;

  select quote_run.quote_request_id into v_quote_request_id
  from public.quote_runs quote_run
  where quote_run.id = v_result.quote_run_id;

  if v_quote_request_id is null then
    raise exception 'Vendor quote result is not linked to a quote request.';
  end if;

  if p_scope_snapshot is null
    or pg_catalog.jsonb_typeof(p_scope_snapshot) <> 'object'
    or p_scope_snapshot ->> 'schema' <> 'quote-lane-scope.v1'
    or p_scope_snapshot ->> 'vendor' <> v_result.vendor::text
    or (p_scope_snapshot ->> 'quantity')::integer <> v_result.requested_quantity
    or p_scope_snapshot #>> '{part,id}' <> v_result.part_id::text then
    raise exception 'Quote scope does not match the vendor result lane.';
  end if;

  select * into v_part
  from public.parts
  where id = v_result.part_id;

  select * into v_cad_file
  from public.job_files
  where id = v_part.cad_file_id;

  if v_cad_file.id is null
    or p_scope_snapshot #>> '{part,cad,fileId}' <> v_cad_file.id::text
    or p_scope_snapshot #>> '{part,cad,sha256}' is null
    or p_scope_snapshot #>> '{part,cad,sha256}' <> v_cad_file.trusted_content_sha256 then
    raise exception 'Quote scope CAD does not match the worker-trusted staged file.';
  end if;

  if v_part.drawing_file_id is null then
    if p_scope_snapshot #> '{part,drawing}' is distinct from 'null'::jsonb then
      raise exception 'Quote scope includes an unexpected drawing.';
    end if;
  else
    select * into v_drawing_file
    from public.job_files
    where id = v_part.drawing_file_id;

    if v_drawing_file.id is null
      or p_scope_snapshot #>> '{part,drawing,fileId}' <> v_drawing_file.id::text
      or p_scope_snapshot #>> '{part,drawing,sha256}' is null
      or p_scope_snapshot #>> '{part,drawing,sha256}' <> v_drawing_file.trusted_content_sha256 then
      raise exception 'Quote scope drawing does not match the worker-trusted staged file.';
    end if;
  end if;

  v_scope_fingerprint := private.quote_scope_fingerprint(p_scope_snapshot);

  insert into public.quote_request_lanes (
    organization_id, quote_request_id, quote_run_id, vendor_quote_result_id,
    part_id, vendor, requested_quantity, scope_version, scope_fingerprint,
    scope_snapshot
  ) values (
    v_result.organization_id, v_quote_request_id, v_result.quote_run_id, v_result.id,
    v_result.part_id, v_result.vendor, v_result.requested_quantity, 1,
    v_scope_fingerprint, p_scope_snapshot
  )
  on conflict (quote_request_id, part_id, vendor, requested_quantity) do nothing;

  if not found then
    select * into v_existing_lane
    from public.quote_request_lanes
    where quote_request_id = v_quote_request_id
      and part_id = v_result.part_id
      and vendor = v_result.vendor
      and requested_quantity = v_result.requested_quantity;

    if v_existing_lane.vendor_quote_result_id <> v_result.id
      or v_existing_lane.scope_fingerprint <> v_scope_fingerprint then
      raise exception 'Quote lane was already registered with a different immutable scope.';
    end if;
  end if;
end;
$$;

revoke all on function public.api_register_quote_request_lane(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.api_register_quote_request_lane(uuid, jsonb)
to service_role;

-- Internal helpers and trigger functions are not Data API endpoints. PostgreSQL
-- otherwise grants new functions to PUBLIC by default, even in a private schema.
revoke all on function private.normalize_quote_offer_validity()
from public, anon, authenticated;
revoke all on function private.quote_scope_fingerprint(jsonb)
from public, anon, authenticated;
