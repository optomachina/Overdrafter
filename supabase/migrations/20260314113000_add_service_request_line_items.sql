do $$
begin
  if not exists (
    select 1
    from pg_type
    where typname = 'service_request_scope'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.service_request_scope as enum ('project', 'job', 'part');
  end if;
end;
$$;

create table if not exists public.service_request_line_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  part_id uuid references public.parts(id) on delete cascade,
  service_type text not null,
  scope public.service_request_scope not null default 'job',
  requested_by_date date,
  service_notes text,
  detail_payload jsonb not null default '{}'::jsonb,
  display_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_request_line_items_anchor_check check (project_id is not null or job_id is not null),
  constraint service_request_line_items_part_requires_job check (part_id is null or job_id is not null)
);

create index if not exists idx_service_request_line_items_job on public.service_request_line_items(job_id, display_order);
create index if not exists idx_service_request_line_items_project on public.service_request_line_items(project_id, display_order);
create index if not exists idx_service_request_line_items_part on public.service_request_line_items(part_id, display_order);
create index if not exists idx_service_request_line_items_org on public.service_request_line_items(organization_id, created_at desc);

drop trigger if exists touch_service_request_line_items_updated_at on public.service_request_line_items;
create trigger touch_service_request_line_items_updated_at
before update on public.service_request_line_items
for each row execute function public.touch_updated_at();

create or replace function public.user_can_access_service_request_line_item(
  p_project_id uuid,
  p_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (p_job_id is not null and public.user_can_access_job(p_job_id))
    or (p_project_id is not null and public.user_can_access_project(p_project_id)),
    false
  );
$$;

create or replace function public.user_can_edit_service_request_line_item(
  p_project_id uuid,
  p_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (p_job_id is not null and public.user_can_edit_job(p_job_id))
    or (p_project_id is not null and public.user_can_edit_project(p_project_id)),
    false
  );
$$;

alter table public.service_request_line_items enable row level security;

drop policy if exists "service_request_line_items_select_accessible" on public.service_request_line_items;
create policy "service_request_line_items_select_accessible"
on public.service_request_line_items
for select
to authenticated
using (public.user_can_access_service_request_line_item(project_id, job_id));

drop policy if exists "service_request_line_items_insert_editable" on public.service_request_line_items;
create policy "service_request_line_items_insert_editable"
on public.service_request_line_items
for insert
to authenticated
with check (public.user_can_edit_service_request_line_item(project_id, job_id));

drop policy if exists "service_request_line_items_update_editable" on public.service_request_line_items;
create policy "service_request_line_items_update_editable"
on public.service_request_line_items
for update
to authenticated
using (public.user_can_edit_service_request_line_item(project_id, job_id))
with check (public.user_can_edit_service_request_line_item(project_id, job_id));

drop policy if exists "service_request_line_items_delete_editable" on public.service_request_line_items;
create policy "service_request_line_items_delete_editable"
on public.service_request_line_items
for delete
to authenticated
using (public.user_can_edit_service_request_line_item(project_id, job_id));

create or replace function public.api_replace_job_service_request_line_items(
  p_job_id uuid,
  p_items jsonb default '[]'::jsonb,
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_single_part_id uuid;
  v_items jsonb := case
    when jsonb_typeof(coalesce(p_items, '[]'::jsonb)) = 'array' then coalesce(p_items, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_requested_service_kinds text[] := '{}'::text[];
  v_fallback_requested_service_kinds text[] := public.normalize_requested_service_kinds(
    p_requested_service_kinds,
    p_primary_service_kind
  );
  v_primary_service_kind text;
  v_shared_service_notes text := nullif(trim(coalesce(p_service_notes, '')), '');
  v_default_quote_quantities integer[] := public.normalize_positive_integer_array(
    p_requested_quote_quantities,
    null
  );
  v_quote_requested_by_date date := p_requested_by_date;
  v_quote_quantities integer[] := v_default_quote_quantities;
  v_item_row record;
  v_item jsonb;
  v_display_order integer;
  v_service_type text;
  v_scope public.service_request_scope;
  v_requested_by_date date;
  v_item_notes text;
  v_detail_payload jsonb;
  v_raw_quote_quantities integer[];
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to edit job %.', p_job_id;
  end if;

  select case when count(*) = 1 then max(id) else null end
  into v_single_part_id
  from public.parts
  where job_id = v_job.id;

  delete from public.service_request_line_items
  where job_id = v_job.id;

  for v_item_row in
    select item.value, item.ordinality::integer - 1 as display_order
    from jsonb_array_elements(v_items) with ordinality as item(value, ordinality)
  loop
    v_item := v_item_row.value;
    v_display_order := v_item_row.display_order;
    v_service_type := public.normalize_requested_service_kinds(
      array[coalesce(nullif(trim(coalesce(v_item ->> 'serviceType', '')), ''), 'manufacturing_quote')],
      p_primary_service_kind
    )[1];

    if v_service_type = any(v_requested_service_kinds) then
      continue;
    end if;

    v_scope := case
      when v_item ->> 'scope' = 'project' and v_job.project_id is not null then 'project'::public.service_request_scope
      when v_item ->> 'scope' = 'part' and v_single_part_id is not null then 'part'::public.service_request_scope
      else 'job'::public.service_request_scope
    end;
    v_item_notes := nullif(trim(coalesce(v_item ->> 'serviceNotes', '')), '');
    v_requested_by_date := case
      when nullif(trim(coalesce(v_item ->> 'requestedByDate', '')), '') is null then p_requested_by_date
      else (v_item ->> 'requestedByDate')::date
    end;
    v_raw_quote_quantities := array(
      select greatest(value::integer, 1)
      from jsonb_array_elements_text(coalesce(v_item -> 'detailPayload' -> 'requestedQuoteQuantities', '[]'::jsonb)) as item_value(value)
      where value ~ '^\d+$'
    );
    v_detail_payload := case
      when v_service_type in ('manufacturing_quote', 'sourcing_only') then jsonb_build_object(
        'requestedQuoteQuantities',
        to_jsonb(
          public.normalize_positive_integer_array(
            coalesce(v_raw_quote_quantities, v_default_quote_quantities),
            null
          )
        )
      )
      else '{}'::jsonb
    end;

    insert into public.service_request_line_items (
      organization_id,
      project_id,
      job_id,
      part_id,
      service_type,
      scope,
      requested_by_date,
      service_notes,
      detail_payload,
      display_order
    )
    values (
      v_job.organization_id,
      v_job.project_id,
      v_job.id,
      case when v_scope = 'part' or v_single_part_id is not null then v_single_part_id else null end,
      v_service_type,
      v_scope,
      v_requested_by_date,
      v_item_notes,
      v_detail_payload,
      v_display_order
    );

    v_requested_service_kinds := array_append(v_requested_service_kinds, v_service_type);
  end loop;

  if coalesce(array_length(v_requested_service_kinds, 1), 0) = 0 then
    v_requested_service_kinds := coalesce(v_fallback_requested_service_kinds, array['manufacturing_quote']::text[]);

    for v_display_order in 1..coalesce(array_length(v_requested_service_kinds, 1), 0) loop
      v_service_type := v_requested_service_kinds[v_display_order];
      v_detail_payload := case
        when v_service_type in ('manufacturing_quote', 'sourcing_only') then jsonb_build_object(
          'requestedQuoteQuantities',
          to_jsonb(v_default_quote_quantities)
        )
        else '{}'::jsonb
      end;

      insert into public.service_request_line_items (
        organization_id,
        project_id,
        job_id,
        part_id,
        service_type,
        scope,
        requested_by_date,
        service_notes,
        detail_payload,
        display_order
      )
      values (
        v_job.organization_id,
        v_job.project_id,
        v_job.id,
        v_single_part_id,
        v_service_type,
        case when v_single_part_id is not null then 'part'::public.service_request_scope else 'job'::public.service_request_scope end,
        p_requested_by_date,
        v_shared_service_notes,
        v_detail_payload,
        v_display_order - 1
      );
    end loop;
  end if;

  select public.normalize_primary_service_kind(v_requested_service_kinds, p_primary_service_kind)
  into v_primary_service_kind;

  if v_shared_service_notes is null then
    select case
      when count(*) > 0 and count(distinct coalesce(service_notes, '')) = 1
        then max(service_notes)
      else null
    end
    into v_shared_service_notes
    from public.service_request_line_items
    where job_id = v_job.id;
  end if;

  select
    service_request_line_item.requested_by_date,
    public.normalize_positive_integer_array(
      array(
        select greatest(value::integer, 1)
        from jsonb_array_elements_text(
          coalesce(service_request_line_item.detail_payload -> 'requestedQuoteQuantities', '[]'::jsonb)
        ) as requested_quantity(value)
        where value ~ '^\d+$'
      ),
      null
    )
  into v_quote_requested_by_date, v_quote_quantities
  from public.service_request_line_items service_request_line_item
  where service_request_line_item.job_id = v_job.id
    and service_request_line_item.service_type in ('manufacturing_quote', 'sourcing_only')
  order by
    case when service_request_line_item.service_type = 'manufacturing_quote' then 0 else 1 end,
    service_request_line_item.display_order asc
  limit 1;

  update public.jobs
  set
    requested_service_kinds = v_requested_service_kinds,
    primary_service_kind = v_primary_service_kind,
    service_notes = v_shared_service_notes,
    requested_quote_quantities = coalesce(v_quote_quantities, '{}'::integer[]),
    requested_by_date = v_quote_requested_by_date
  where id = v_job.id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.service_requests_replaced',
    jsonb_build_object(
      'jobId', v_job.id,
      'requestedServiceKinds', v_requested_service_kinds,
      'primaryServiceKind', v_primary_service_kind
    ),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

grant execute on function public.api_replace_job_service_request_line_items(
  uuid,
  jsonb,
  text[],
  text,
  text,
  integer[],
  date
) to authenticated;

drop function if exists public.api_create_job(
  uuid,
  text,
  text,
  text,
  text[],
  text[],
  text,
  text,
  integer[],
  date,
  jsonb
);

create or replace function public.api_create_job(
  p_organization_id uuid,
  p_title text,
  p_description text default null,
  p_source text default 'client',
  p_tags text[] default '{}'::text[],
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null,
  p_service_requests jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  v_job_id := public.api_create_job(
    p_organization_id,
    p_title,
    p_description,
    p_source,
    p_tags,
    p_requested_service_kinds,
    p_primary_service_kind,
    p_service_notes,
    p_requested_quote_quantities,
    p_requested_by_date
  );

  perform public.api_replace_job_service_request_line_items(
    v_job_id,
    p_service_requests,
    p_requested_service_kinds,
    p_primary_service_kind,
    p_service_notes,
    p_requested_quote_quantities,
    p_requested_by_date
  );

  return v_job_id;
end;
$$;

grant execute on function public.api_create_job(
  uuid,
  text,
  text,
  text,
  text[],
  text[],
  text,
  text,
  integer[],
  date,
  jsonb
) to authenticated;

drop function if exists public.api_create_client_draft(
  text,
  text,
  uuid,
  text[],
  text[],
  text,
  text,
  integer[],
  date,
  jsonb
);

create or replace function public.api_create_client_draft(
  p_title text,
  p_description text default null,
  p_project_id uuid default null,
  p_tags text[] default '{}'::text[],
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null,
  p_service_requests jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  v_job_id := public.api_create_client_draft(
    p_title,
    p_description,
    p_project_id,
    p_tags,
    p_requested_service_kinds,
    p_primary_service_kind,
    p_service_notes,
    p_requested_quote_quantities,
    p_requested_by_date
  );

  perform public.api_replace_job_service_request_line_items(
    v_job_id,
    p_service_requests,
    p_requested_service_kinds,
    p_primary_service_kind,
    p_service_notes,
    p_requested_quote_quantities,
    p_requested_by_date
  );

  return v_job_id;
end;
$$;

grant execute on function public.api_create_client_draft(
  text,
  text,
  uuid,
  text[],
  text[],
  text,
  text,
  integer[],
  date,
  jsonb
) to authenticated;

drop function if exists public.api_update_client_part_request(
  uuid,
  text[],
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  text,
  text,
  integer,
  integer[],
  date,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb
);

create or replace function public.api_update_client_part_request(
  p_job_id uuid,
  p_requested_service_kinds text[] default null,
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_description text default null,
  p_part_number text default null,
  p_revision text default null,
  p_material text default '',
  p_finish text default null,
  p_tightest_tolerance_inch numeric default null,
  p_process text default null,
  p_notes text default null,
  p_quantity integer default 1,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null,
  p_shipping jsonb default '{}'::jsonb,
  p_certifications jsonb default '{}'::jsonb,
  p_sourcing jsonb default '{}'::jsonb,
  p_release jsonb default '{}'::jsonb,
  p_service_requests jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  v_job_id := public.api_update_client_part_request(
    p_job_id,
    p_requested_service_kinds,
    p_primary_service_kind,
    p_service_notes,
    p_description,
    p_part_number,
    p_revision,
    p_material,
    p_finish,
    p_tightest_tolerance_inch,
    p_process,
    p_notes,
    p_quantity,
    p_requested_quote_quantities,
    p_requested_by_date,
    p_shipping,
    p_certifications,
    p_sourcing,
    p_release
  );

  perform public.api_replace_job_service_request_line_items(
    p_job_id,
    coalesce(p_service_requests, '[]'::jsonb),
    p_requested_service_kinds,
    p_primary_service_kind,
    p_service_notes,
    p_requested_quote_quantities,
    p_requested_by_date
  );

  return v_job_id;
end;
$$;

grant execute on function public.api_update_client_part_request(
  uuid,
  text[],
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  text,
  text,
  integer,
  integer[],
  date,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) to authenticated;

insert into public.service_request_line_items (
  organization_id,
  project_id,
  job_id,
  part_id,
  service_type,
  scope,
  requested_by_date,
  service_notes,
  detail_payload,
  display_order
)
select
  job.organization_id,
  job.project_id,
  job.id,
  case when single_part.part_count = 1 then single_part.part_id else null end,
  requested_service_kind.service_type,
  case
    when single_part.part_count = 1 then 'part'::public.service_request_scope
    else 'job'::public.service_request_scope
  end,
  job.requested_by_date,
  job.service_notes,
  case
    when requested_service_kind.service_type in ('manufacturing_quote', 'sourcing_only') then jsonb_build_object(
      'requestedQuoteQuantities',
      to_jsonb(coalesce(job.requested_quote_quantities, '{}'::integer[]))
    )
    else '{}'::jsonb
  end,
  requested_service_kind.display_order
from public.jobs job
left join (
  select
    part.job_id,
    count(*) as part_count,
    max(part.id) as part_id
  from public.parts part
  group by part.job_id
) single_part on single_part.job_id = job.id
cross join lateral (
  select
    value as service_type,
    ordinality::integer - 1 as display_order
  from unnest(
    case
      when coalesce(array_length(job.requested_service_kinds, 1), 0) > 0
        then public.normalize_requested_service_kinds(job.requested_service_kinds, job.primary_service_kind)
      else array['manufacturing_quote']::text[]
    end
  ) with ordinality as requested_service_kind(value, ordinality)
) requested_service_kind
where not exists (
  select 1
  from public.service_request_line_items existing
  where existing.job_id = job.id
);
