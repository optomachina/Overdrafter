begin;

-- Rollback: restore private.anchor_operator_quote_validity() from migration
-- 20260812045000 and private.normalize_quote_offer_validity() from migration
-- 20260812041000. The backfill below intentionally corrects persisted validity
-- fields and is not mechanically reversible; restore those rows from a
-- pre-deployment backup only if the corrected commercial dates must be undone.
--
-- Operator-entered durations are anchored before the general validity
-- normalization trigger runs. Preserve an explicit vendor/operator quote
-- timestamp first so the trigger never replaces it with the capture time.
create or replace function private.anchor_operator_quote_validity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_raw_duration text := coalesce(
    nullif(new.raw_payload ->> 'validityDurationDays', ''),
    nullif(new.raw_payload ->> 'validForDays', '')
  );
  v_raw_quoted_at text := nullif(new.raw_payload ->> 'quotedAt', '');
  v_source text := coalesce(
    new.validity_source,
    nullif(new.raw_payload ->> 'validitySource', '')
  );
begin
  if v_source = 'operator_duration'
    and (
      new.validity_duration_days is not null
      or v_raw_duration ~ '^[1-9]\d*$'
    )
    and new.quoted_at is null then
    if v_raw_quoted_at ~ '^\d{4}-\d{2}-\d{2}([T ].*)?$' then
      new.quoted_at := v_raw_quoted_at::timestamptz;
    elsif v_raw_quoted_at is null and new.quote_date is not null then
      new.quoted_at := new.quote_date::timestamp at time zone 'UTC';
    elsif v_raw_quoted_at is null then
      new.quoted_at := coalesce(new.created_at, pg_catalog.now());
    end if;
  end if;

  return new;
exception
  when data_exception then
    -- Leave malformed explicit timestamps untouched for the downstream
    -- normalizer, which clears inferred validity rather than inventing it.
    return new;
end;
$$;

revoke all on function private.anchor_operator_quote_validity()
from public, anon, authenticated, service_role;

-- Treat every malformed external date/time representation as unknown validity.
-- PostgreSQL uses several data-exception subclasses for bad timestamps (for
-- example invalid zones and out-of-range offsets), not only 22007 and 22008.
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
    new.valid_until := ((v_raw_valid_until::date + 1)::timestamp at time zone 'UTC')
      - interval '1 microsecond';
  elsif new.valid_until is null and v_raw_valid_until ~ '^\d{4}-\d{2}-\d{2}T' then
    new.valid_until := v_raw_valid_until::timestamptz;
  end if;

  if new.valid_until is null
    and new.validity_duration_days is not null
    and new.quoted_at is not null then
    new.valid_until := new.quoted_at + make_interval(days => new.validity_duration_days);
  end if;

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
  when data_exception then
    -- Preserve the original payload and terms, but never infer commercial
    -- validity from any malformed external date, duration, or time zone.
    new.valid_until := null;
    new.validity_duration_days := null;
    new.validity_source := null;
    return new;
end;
$$;

revoke all on function private.normalize_quote_offer_validity()
from public, anon, authenticated, service_role;

-- Repair offers captured after the original anchoring trigger shipped. Reset
-- valid_until so the existing normalizer derives it again from the corrected
-- quote timestamp and the vendor/operator terms already stored on the row.
do $$
declare
  v_offer record;
  v_explicit_quoted_at timestamptz;
begin
  for v_offer in
    select
      offer.id,
      offer.quote_date,
      offer.quoted_at,
      nullif(offer.raw_payload ->> 'quotedAt', '') as raw_quoted_at
    from public.vendor_quote_offers offer
    where coalesce(
      nullif(offer.raw_payload ->> 'validitySource', ''),
      offer.validity_source
    ) = 'operator_duration'
      and (
        nullif(offer.raw_payload ->> 'quotedAt', '') is not null
        or offer.quote_date is not null
      )
      and (
        offer.validity_duration_days is not null
        or coalesce(
          nullif(offer.raw_payload ->> 'validityDurationDays', ''),
          nullif(offer.raw_payload ->> 'validForDays', '')
        ) ~ '^[1-9]\d*$'
      )
  loop
    begin
      if v_offer.raw_quoted_at is not null then
        v_explicit_quoted_at := v_offer.raw_quoted_at::timestamptz;
      else
        v_explicit_quoted_at := v_offer.quote_date::timestamp at time zone 'UTC';
      end if;

      if v_offer.quoted_at is distinct from v_explicit_quoted_at then
        update public.vendor_quote_offers
        set quoted_at = v_explicit_quoted_at,
            valid_until = null
        where id = v_offer.id;
      end if;
    exception
      when data_exception then
        -- Clear the incorrectly inferred fields. The broadened normalizer
        -- preserves the raw payload while keeping malformed validity unknown.
        update public.vendor_quote_offers
        set quoted_at = null,
            valid_until = null,
            validity_duration_days = null,
            validity_source = null
        where id = v_offer.id;
    end;
  end loop;
end;
$$;

commit;
