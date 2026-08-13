begin;

-- Rollback: restore private.anchor_operator_quote_validity() from migration
-- 20260812045000. No table data or public API contract changes are involved.
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
  when invalid_datetime_format or datetime_field_overflow then
    -- Leave malformed explicit timestamps untouched for the downstream
    -- normalizer, which clears inferred validity rather than inventing it.
    return new;
end;
$$;

revoke all on function private.anchor_operator_quote_validity()
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
      when invalid_datetime_format or datetime_field_overflow then
        -- The normalizer owns malformed-term handling. Do not let one legacy
        -- payload prevent the safe rows in this migration from being repaired.
        continue;
    end;
  end loop;
end;
$$;

commit;
