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

commit;
