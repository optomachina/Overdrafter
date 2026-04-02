-- OVE-24: Keep manufacturing_quote service line-item lifecycle aligned with quote_requests
--
-- The bridge table landed in 20260324000000_add_service_request_line_items.sql, but its
-- `status` column stayed at the insert-time default and never tracked quote-request
-- lifecycle changes. During the bridge period, quote_requests remains the client-safe
-- request-intent surface, but the linked manufacturing line item must mirror the latest
-- request status so project/part rollups can treat it as the authoritative unit of work.
--
-- Rollback path: drop the trigger/function added here and rely on quote_requests lifecycle
-- reads only. No client RPC shape changes depend on this migration.

create or replace function public.sync_service_request_line_item_status(
  p_service_request_line_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest_status text := 'open';
begin
  if p_service_request_line_item_id is null then
    return;
  end if;

  select request_row.status::text
  into v_latest_status
  from public.quote_requests request_row
  where request_row.service_request_line_item_id = p_service_request_line_item_id
  order by request_row.created_at desc, request_row.id desc
  limit 1;

  update public.service_request_line_items
  set
    status = coalesce(v_latest_status, 'open'),
    updated_at = timezone('utc', now())
  where id = p_service_request_line_item_id
    and status is distinct from coalesce(v_latest_status, 'open');
end;
$$;

create or replace function public.sync_service_request_line_item_status_from_quote_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_service_request_line_item_status(new.service_request_line_item_id);

  if tg_op = 'UPDATE'
     and old.service_request_line_item_id is distinct from new.service_request_line_item_id then
    perform public.sync_service_request_line_item_status(old.service_request_line_item_id);
  end if;

  return new;
end;
$$;

drop trigger if exists sync_service_request_line_item_status_on_quote_request on public.quote_requests;
create trigger sync_service_request_line_item_status_on_quote_request
after insert or update of status, service_request_line_item_id, created_at
on public.quote_requests
for each row execute function public.sync_service_request_line_item_status_from_quote_request();

with latest_request_status as (
  select distinct on (request_row.service_request_line_item_id)
    request_row.service_request_line_item_id,
    request_row.status::text as latest_status
  from public.quote_requests request_row
  where request_row.service_request_line_item_id is not null
  order by request_row.service_request_line_item_id, request_row.created_at desc, request_row.id desc
)
update public.service_request_line_items line_item
set
  status = coalesce(latest_request_status.latest_status, 'open'),
  updated_at = timezone('utc', now())
from latest_request_status
where latest_request_status.service_request_line_item_id = line_item.id
  and line_item.status is distinct from coalesce(latest_request_status.latest_status, 'open');
