create or replace function public.api_set_job_selected_vendor_quote_offer(
  p_job_id uuid,
  p_vendor_quote_offer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part_id uuid;
  v_offer public.vendor_quote_offers%rowtype;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_access_job(v_job.id) then
    raise exception 'You do not have access to job %.', p_job_id;
  end if;

  if p_vendor_quote_offer_id is null then
    update public.jobs
    set
      selected_vendor_quote_offer_id = null,
      updated_at = timezone('utc', now())
    where id = v_job.id;

    return v_job.id;
  end if;

  select id
  into v_part_id
  from public.parts
  where job_id = v_job.id
  order by created_at asc
  limit 1;

  if v_part_id is null then
    raise exception 'Job % has no part revisions yet.', p_job_id;
  end if;

  select offer.*
  into v_offer
  from public.vendor_quote_offers offer
  join public.vendor_quote_results result on result.id = offer.vendor_quote_result_id
  where offer.id = p_vendor_quote_offer_id
    and result.part_id = v_part_id;

  if v_offer.id is null then
    raise exception 'Offer % is not valid for job %.', p_vendor_quote_offer_id, p_job_id;
  end if;

  update public.jobs
  set
    selected_vendor_quote_offer_id = v_offer.id,
    updated_at = timezone('utc', now())
  where id = v_job.id;

  return v_job.id;
end;
$$;

grant execute on function public.api_set_job_selected_vendor_quote_offer(uuid, uuid) to authenticated;
