-- OVD-96: Move enqueueDebugVendorQuote to a server-side RPC
--
-- The client-side enqueueDebugVendorQuote performed a duplicate-check and insert
-- as two separate DB reads with no transaction, creating a TOCTOU race. Two
-- concurrent debug submissions could both pass the check and produce duplicate
-- work_queue tasks. This RPC performs the lookup and conditional insert atomically.

create or replace function public.api_enqueue_debug_vendor_quote(
  p_quote_run_id uuid,
  p_part_id uuid,
  p_vendor public.vendor_name,
  p_requested_quantity integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.vendor_quote_results%rowtype;
  v_existing_task_id uuid;
  v_new_task_id uuid;
begin
  perform public.require_verified_auth();

  -- Verify the caller can access the job associated with this quote run.
  select result.*
  into v_result
  from public.vendor_quote_results result
  join public.quote_runs quote_run on quote_run.id = result.quote_run_id
  where result.quote_run_id = p_quote_run_id
    and result.part_id = p_part_id
    and result.vendor = p_vendor
    and result.requested_quantity = p_requested_quantity
    and public.user_can_edit_job(quote_run.job_id)
  limit 1;

  if v_result.id is null then
    raise exception 'No matching vendor quote lane found, or you do not have permission to access it.';
  end if;

  -- Check for an existing queued or running task for this exact lane.
  select task.id
  into v_existing_task_id
  from public.work_queue task
  where task.quote_run_id = p_quote_run_id
    and task.part_id = p_part_id
    and task.task_type = 'run_vendor_quote'
    and task.status in ('queued', 'running')
    and (task.payload ->> 'vendor') = p_vendor::text
    and (task.payload ->> 'requestedQuantity')::integer = p_requested_quantity
  limit 1;

  if v_existing_task_id is not null then
    return jsonb_build_object(
      'taskId', v_existing_task_id,
      'created', false,
      'reason', 'A debug quote task is already queued or running for this lane.'
    );
  end if;

  insert into public.work_queue (
    organization_id,
    job_id,
    part_id,
    quote_run_id,
    task_type,
    status,
    payload
  )
  select
    v_result.organization_id,
    quote_run.job_id,
    p_part_id,
    p_quote_run_id,
    'run_vendor_quote',
    'queued',
    jsonb_build_object(
      'quoteRunId', p_quote_run_id,
      'partId', p_part_id,
      'vendor', p_vendor,
      'vendorQuoteResultId', v_result.id,
      'requestedQuantity', p_requested_quantity,
      'source', 'xometry-debug-submit'
    )
  from public.quote_runs quote_run
  where quote_run.id = p_quote_run_id
  returning id into v_new_task_id;

  return jsonb_build_object(
    'taskId', v_new_task_id,
    'created', true,
    'reason', null
  );
end;
$$;

grant execute on function public.api_enqueue_debug_vendor_quote(uuid, uuid, public.vendor_name, integer) to authenticated;
