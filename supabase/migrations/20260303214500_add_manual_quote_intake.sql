drop policy if exists "quote_artifacts_storage_insert_internal" on storage.objects;
create policy "quote_artifacts_storage_insert_internal"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'quote-artifacts'
  and split_part(name, '/', 1) = 'manual-quotes'
  and exists (
    select 1
    from public.jobs job
    where job.id::text = split_part(name, '/', 2)
      and public.is_internal_user(job.organization_id)
  )
);

drop policy if exists "quote_artifacts_storage_delete_internal" on storage.objects;
create policy "quote_artifacts_storage_delete_internal"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'quote-artifacts'
  and split_part(name, '/', 1) = 'manual-quotes'
  and exists (
    select 1
    from public.jobs job
    where job.id::text = split_part(name, '/', 2)
      and public.is_internal_user(job.organization_id)
  )
);

drop function if exists public.api_record_manual_vendor_quote(
  uuid,
  uuid,
  public.vendor_name,
  public.vendor_status,
  text,
  text,
  text,
  jsonb,
  jsonb
);

create function public.api_record_manual_vendor_quote(
  p_job_id uuid,
  p_part_id uuid,
  p_vendor public.vendor_name,
  p_status public.vendor_status default 'official_quote_received',
  p_summary_note text default null,
  p_source_text text default null,
  p_quote_url text default null,
  p_offers jsonb default '[]'::jsonb,
  p_artifacts jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_quote_run public.quote_runs%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_offer jsonb;
  v_artifact jsonb;
  v_summary_offer jsonb;
  v_summary_total numeric;
  v_summary_unit numeric;
  v_summary_lead integer;
  v_offer_id uuid;
  v_created_new_quote_run boolean := false;
  v_sort_rank integer := 0;
  v_has_pending boolean := false;
  v_has_manual boolean := false;
  v_has_success boolean := false;
  v_supplier text;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.is_internal_user(v_job.organization_id) then
    raise exception 'Only internal users can record manual vendor quotes.';
  end if;

  select *
  into v_part
  from public.parts
  where id = p_part_id
    and job_id = p_job_id;

  if v_part.id is null then
    raise exception 'Part % does not belong to job %', p_part_id, p_job_id;
  end if;

  if jsonb_typeof(coalesce(p_offers, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_offers, '[]'::jsonb)) = 0 then
    raise exception 'At least one offer lane is required for manual quote intake.';
  end if;

  select quote_run.*
  into v_quote_run
  from public.quote_runs quote_run
  left join public.published_quote_packages package
    on package.quote_run_id = quote_run.id
  where quote_run.job_id = p_job_id
    and package.id is null
  order by quote_run.created_at desc
  limit 1;

  if v_quote_run.id is null then
    insert into public.quote_runs (
      job_id,
      organization_id,
      initiated_by,
      status,
      requested_auto_publish
    )
    values (
      p_job_id,
      v_job.organization_id,
      auth.uid(),
      'completed',
      false
    )
    returning * into v_quote_run;

    v_created_new_quote_run := true;
  end if;

  select offer
  into v_summary_offer
  from jsonb_array_elements(p_offers) offer
  order by
    coalesce(nullif(offer ->> 'totalPriceUsd', '')::numeric, 999999999),
    coalesce(nullif(offer ->> 'leadTimeBusinessDays', '')::integer, 999999)
  limit 1;

  if v_summary_offer is null then
    raise exception 'Unable to determine a summary offer for manual quote intake.';
  end if;

  v_summary_total := nullif(v_summary_offer ->> 'totalPriceUsd', '')::numeric;
  v_summary_unit := nullif(v_summary_offer ->> 'unitPriceUsd', '')::numeric;
  v_summary_lead := nullif(v_summary_offer ->> 'leadTimeBusinessDays', '')::integer;
  v_supplier := case
    when p_vendor = 'sendcutsend' then 'SendCutSend'
    when p_vendor = 'protolabs' then 'Protolabs'
    when p_vendor = 'partsbadger' then 'PartsBadger'
    when p_vendor = 'fastdms' then 'FastDMS'
    else initcap(p_vendor::text)
  end;

  insert into public.vendor_quote_results (
    quote_run_id,
    part_id,
    organization_id,
    vendor,
    status,
    unit_price_usd,
    total_price_usd,
    lead_time_business_days,
    quote_url,
    dfm_issues,
    notes,
    raw_payload
  )
  values (
    v_quote_run.id,
    p_part_id,
    v_job.organization_id,
    p_vendor,
    p_status,
    v_summary_unit,
    v_summary_total,
    v_summary_lead,
    p_quote_url,
    '[]'::jsonb,
    to_jsonb(
      array_remove(
        array[
          'Recorded through manual quote intake.',
          nullif(trim(coalesce(p_summary_note, '')), '')
        ],
        null
      )
    ),
    jsonb_build_object(
      'source', 'manual-quote-intake',
      'sourceText', p_source_text,
      'summaryOfferKey', coalesce(nullif(v_summary_offer ->> 'offerId', ''), 'offer-0'),
      'offerCount', jsonb_array_length(p_offers)
    )
  )
  on conflict (quote_run_id, part_id, vendor) do update
    set status = excluded.status,
        unit_price_usd = excluded.unit_price_usd,
        total_price_usd = excluded.total_price_usd,
        lead_time_business_days = excluded.lead_time_business_days,
        quote_url = excluded.quote_url,
        dfm_issues = excluded.dfm_issues,
        notes = excluded.notes,
        raw_payload = excluded.raw_payload,
        updated_at = timezone('utc', now())
  returning * into v_result;

  delete from public.vendor_quote_offers
  where vendor_quote_result_id = v_result.id;

  for v_offer in
    select value
    from jsonb_array_elements(p_offers)
  loop
    insert into public.vendor_quote_offers (
      vendor_quote_result_id,
      organization_id,
      offer_key,
      supplier,
      lane_label,
      sourcing,
      tier,
      quote_ref,
      quote_date,
      unit_price_usd,
      total_price_usd,
      lead_time_business_days,
      ship_receive_by,
      due_date,
      process,
      material,
      finish,
      tightest_tolerance,
      tolerance_source,
      thread_callouts,
      thread_match_notes,
      notes,
      sort_rank,
      raw_payload
    )
    values (
      v_result.id,
      v_job.organization_id,
      coalesce(nullif(v_offer ->> 'offerId', ''), format('offer-%s', v_sort_rank)),
      coalesce(nullif(v_offer ->> 'supplier', ''), v_supplier),
      coalesce(
        nullif(v_offer ->> 'laneLabel', ''),
        nullif(concat_ws(' / ', nullif(v_offer ->> 'sourcing', ''), nullif(v_offer ->> 'tier', '')), ''),
        coalesce(nullif(v_offer ->> 'supplier', ''), v_supplier)
      ),
      nullif(v_offer ->> 'sourcing', ''),
      nullif(v_offer ->> 'tier', ''),
      nullif(v_offer ->> 'quoteRef', ''),
      case
        when nullif(v_offer ->> 'quoteDateIso', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_offer ->> 'quoteDateIso')::date
        else null
      end,
      nullif(v_offer ->> 'unitPriceUsd', '')::numeric,
      nullif(v_offer ->> 'totalPriceUsd', '')::numeric,
      nullif(v_offer ->> 'leadTimeBusinessDays', '')::integer,
      nullif(v_offer ->> 'shipReceiveBy', ''),
      nullif(v_offer ->> 'dueDate', ''),
      nullif(v_offer ->> 'process', ''),
      nullif(v_offer ->> 'material', ''),
      nullif(v_offer ->> 'finish', ''),
      nullif(v_offer ->> 'tightestTolerance', ''),
      nullif(v_offer ->> 'toleranceSource', ''),
      nullif(v_offer ->> 'threadCallouts', ''),
      nullif(v_offer ->> 'threadMatchNotes', ''),
      nullif(v_offer ->> 'notes', ''),
      v_sort_rank,
      v_offer
    )
    returning id into v_offer_id;

    if v_sort_rank = 0 then
      update public.published_quote_options
      set source_vendor_quote_offer_id = v_offer_id
      where source_vendor_quote_id = v_result.id
        and source_vendor_quote_offer_id is null;
    end if;

    v_sort_rank := v_sort_rank + 1;
  end loop;

  insert into public.vendor_quote_artifacts (
    vendor_quote_result_id,
    organization_id,
    artifact_type,
    storage_bucket,
    storage_path,
    metadata
  )
  select
    v_result.id,
    v_job.organization_id,
    coalesce(nullif(artifact ->> 'artifactType', ''), 'uploaded_evidence'),
    coalesce(nullif(artifact ->> 'storageBucket', ''), 'quote-artifacts'),
    artifact ->> 'storagePath',
    coalesce(artifact -> 'metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb)) artifact
  where nullif(artifact ->> 'storagePath', '') is not null
  on conflict (storage_path) do update
    set metadata = excluded.metadata;

  select
    bool_or(status in ('queued', 'running')),
    bool_or(status in ('manual_review_pending', 'manual_vendor_followup')),
    bool_or(status in ('instant_quote_received', 'official_quote_received'))
  into
    v_has_pending,
    v_has_manual,
    v_has_success
  from public.vendor_quote_results
  where quote_run_id = v_quote_run.id;

  update public.quote_runs
  set status = case
    when coalesce(v_has_pending, false) then 'running'
    when coalesce(v_has_success, false) or coalesce(v_has_manual, false) then 'completed'
    else 'failed'
  end
  where id = v_quote_run.id;

  update public.jobs
  set status = case
    when coalesce(v_has_pending, false) then 'quoting'
    when coalesce(v_has_manual, false) then 'awaiting_vendor_manual_review'
    when coalesce(v_has_success, false) then 'internal_review'
    else 'quoting'
  end
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.manual_quote_recorded',
    jsonb_build_object(
      'quoteRunId', v_quote_run.id,
      'vendorQuoteResultId', v_result.id,
      'vendor', p_vendor,
      'offerCount', jsonb_array_length(p_offers),
      'artifactCount', jsonb_array_length(coalesce(p_artifacts, '[]'::jsonb)),
      'createdNewQuoteRun', v_created_new_quote_run
    ),
    p_job_id,
    null
  );

  return jsonb_build_object(
    'quoteRunId', v_quote_run.id,
    'vendorQuoteResultId', v_result.id,
    'createdNewQuoteRun', v_created_new_quote_run
  );
end;
$$;

grant execute on function public.api_record_manual_vendor_quote(
  uuid,
  uuid,
  public.vendor_name,
  public.vendor_status,
  text,
  text,
  text,
  jsonb,
  jsonb
) to authenticated;
