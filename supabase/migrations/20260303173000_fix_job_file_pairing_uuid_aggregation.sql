create or replace function public.job_part_file_set(p_job_id uuid)
returns table (
  normalized_name text,
  cad_file_id uuid,
  drawing_file_id uuid
)
language sql
stable
set search_path = public
as $$
  with normalized_keys as (
    select distinct file.normalized_name
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
  ),
  latest_cad as (
    select distinct on (file.normalized_name)
      file.normalized_name,
      file.id as cad_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind = 'cad'
    order by file.normalized_name, file.created_at desc, file.id desc
  ),
  latest_drawing as (
    select distinct on (file.normalized_name)
      file.normalized_name,
      file.id as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind = 'drawing'
    order by file.normalized_name, file.created_at desc, file.id desc
  )
  select
    keyset.normalized_name,
    cad.cad_file_id,
    drawing.drawing_file_id
  from normalized_keys keyset
  left join latest_cad cad
    on cad.normalized_name = keyset.normalized_name
  left join latest_drawing drawing
    on drawing.normalized_name = keyset.normalized_name;
$$;

create or replace function public.api_reconcile_job_parts(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_total_parts integer := 0;
  v_matched_pairs integer := 0;
  v_missing_drawings integer := 0;
  v_missing_cad integer := 0;
begin
  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_access_org(v_job.organization_id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  delete from public.parts part
  where part.job_id = p_job_id
    and not exists (
      select 1
      from public.job_part_file_set(p_job_id) fs
      where fs.normalized_name = part.normalized_key
    );

  insert into public.parts (
    job_id,
    organization_id,
    name,
    normalized_key,
    cad_file_id,
    drawing_file_id,
    quantity
  )
  select
    p_job_id,
    v_job.organization_id,
    fs.normalized_name,
    fs.normalized_name,
    fs.cad_file_id,
    fs.drawing_file_id,
    1
  from public.job_part_file_set(p_job_id) fs
  on conflict (job_id, normalized_key) do update
    set cad_file_id = excluded.cad_file_id,
        drawing_file_id = excluded.drawing_file_id,
        updated_at = timezone('utc', now());

  update public.job_files
  set matched_part_key = normalized_name
  where job_id = p_job_id
    and file_kind in ('cad', 'drawing');

  select
    count(*)::integer,
    count(*) filter (where cad_file_id is not null and drawing_file_id is not null)::integer,
    count(*) filter (where cad_file_id is not null and drawing_file_id is null)::integer,
    count(*) filter (where cad_file_id is null and drawing_file_id is not null)::integer
  into
    v_total_parts,
    v_matched_pairs,
    v_missing_drawings,
    v_missing_cad
  from public.job_part_file_set(p_job_id);

  perform public.log_audit_event(
    v_job.organization_id,
    'job.parts_reconciled',
    jsonb_build_object(
      'totalParts', coalesce(v_total_parts, 0),
      'matchedPairs', coalesce(v_matched_pairs, 0),
      'missingDrawings', coalesce(v_missing_drawings, 0),
      'missingCad', coalesce(v_missing_cad, 0)
    ),
    p_job_id,
    null
  );

  return jsonb_build_object(
    'totalParts', coalesce(v_total_parts, 0),
    'matchedPairs', coalesce(v_matched_pairs, 0),
    'missingDrawings', coalesce(v_missing_drawings, 0),
    'missingCad', coalesce(v_missing_cad, 0)
  );
end;
$$;
