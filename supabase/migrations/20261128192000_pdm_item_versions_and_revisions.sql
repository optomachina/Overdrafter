-- PDM-style assembly identity: items, immutable versions, and formal revisions.
--
-- public.part_versions remains the extraction package fingerprint. This model
-- is the SolidWorks-style history: every upload is a new version, and a
-- release step labels that version. Nothing here is applied to production or
-- staging by this change; local and CI Supabase apply it with the rest of
-- the migration chain.
--
-- Rollback: drop the policies, triggers, and functions in this file, drop
-- public.item_shares, public.assembly_bom_lines, public.item_revisions,
-- public.item_versions, and public.items, then drop the nullable columns on
-- public.parts, public.quote_requests, and public.quote_request_lanes.
-- Existing jobs, files, parts, and quotes stay. Backfill rows disappear with
-- the new tables. Quote columns are nullable and are not read by current
-- single-part flows.

create table public.items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete restrict,
  job_id uuid references public.jobs(id) on delete restrict,
  kind text not null,
  part_number text,
  filename text,
  identity_key text not null,
  display_name text not null,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint items_kind_check check (kind in ('part', 'assembly')),
  constraint items_scope_check check (project_id is not null or job_id is not null),
  constraint items_part_number_check check (part_number is null or char_length(part_number) between 1 and 300),
  constraint items_filename_check check (filename is null or char_length(filename) between 1 and 300),
  constraint items_identity_key_check check (char_length(identity_key) between 1 and 300),
  constraint items_display_name_check check (char_length(display_name) between 1 and 300)
);

create table public.item_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_number integer not null,
  state text not null default 'work_in_progress',
  comment text,
  configuration_name text,
  job_file_id uuid references public.job_files(id) on delete set null,
  drawing_file_id uuid references public.job_files(id) on delete set null,
  content_sha256 text,
  source_part_id uuid references public.parts(id) on delete set null,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint item_versions_number_check check (version_number > 0),
  constraint item_versions_state_check check (
    state in ('work_in_progress', 'pending_approval', 'released', 'obsolete')
  ),
  constraint item_versions_comment_check check (comment is null or char_length(comment) <= 2000),
  constraint item_versions_configuration_check check (
    configuration_name is null or char_length(configuration_name) between 1 and 200
  ),
  constraint item_versions_hash_check check (
    content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  unique (item_id, version_number),
  unique (source_part_id)
);

create table public.item_revisions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  item_version_id uuid not null references public.item_versions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scheme text not null,
  label text not null,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  constraint item_revisions_scheme_check check (scheme in ('numeric', 'alpha')),
  constraint item_revisions_label_check check (
    (scheme = 'numeric' and label ~ '^[0-9]{2,}$')
    or (scheme = 'alpha' and label ~ '^[ABCDEFGHJKLMNPRTUWY]$')
  ),
  unique (item_id, label),
  unique (item_version_id, scheme)
);

create table public.assembly_bom_lines (
  id uuid primary key default gen_random_uuid(),
  assembly_item_version_id uuid not null references public.item_versions(id) on delete cascade,
  child_item_version_id uuid not null references public.item_versions(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quantity integer not null,
  instance_path text not null,
  transform jsonb,
  is_bought_part boolean not null default false,
  configuration_name text,
  created_at timestamptz not null default timezone('utc', now()),
  constraint assembly_bom_lines_quantity_check check (quantity > 0),
  constraint assembly_bom_lines_instance_path_check check (char_length(instance_path) between 1 and 1024),
  constraint assembly_bom_lines_not_self_check check (assembly_item_version_id <> child_item_version_id),
  constraint assembly_bom_lines_transform_check check (
    transform is null or jsonb_typeof(transform) in ('object', 'array')
  ),
  constraint assembly_bom_lines_configuration_check check (
    configuration_name is null or char_length(configuration_name) between 1 and 200
  ),
  unique (assembly_item_version_id, instance_path)
);

create table public.item_shares (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  mode text not null,
  pinned_item_version_id uuid references public.item_versions(id) on delete restrict,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint item_shares_mode_check check (
    mode in ('follow_latest_released', 'follow_latest', 'frozen')
  ),
  constraint item_shares_pin_check check (pinned_item_version_id is not null)
);

alter table public.parts
  add column pdm_item_id uuid references public.items(id) on delete set null,
  add column pdm_item_version_id uuid references public.item_versions(id) on delete set null;

alter table public.quote_requests
  add column item_version_id uuid references public.item_versions(id) on delete set null,
  add column free_quote_item_id uuid references public.items(id) on delete set null,
  add column free_quote_unlimited boolean not null default false;

alter table public.quote_request_lanes
  add column item_version_id uuid references public.item_versions(id) on delete set null;

comment on column public.quote_requests.free_quote_item_id is
  'Free-quote hook. A later change meters one allowance per item, so another version of this item does not consume a second free quote. Null leaves the existing job meter in place.';

comment on column public.quote_requests.free_quote_unlimited is
  'Free-quote hook for beta-allowlisted accounts. Authenticated callers cannot set it. A later change sets it from the allowlist through service_role. This migration leaves it false.';

comment on table public.item_versions is
  'Immutable upload history. version_number is assigned automatically. state released cannot be updated or deleted.';

create unique index items_project_identity_key
  on public.items (organization_id, project_id, identity_key)
  where project_id is not null;

create unique index items_job_identity_key
  on public.items (organization_id, job_id, identity_key)
  where project_id is null;

create index item_versions_item_number_idx
  on public.item_versions (item_id, version_number desc);

create index item_versions_org_state_idx
  on public.item_versions (organization_id, state);

create index item_versions_job_file_idx
  on public.item_versions (job_file_id)
  where job_file_id is not null;

create index item_versions_drawing_file_idx
  on public.item_versions (drawing_file_id)
  where drawing_file_id is not null;

create index item_revisions_item_scheme_idx
  on public.item_revisions (item_id, scheme, created_at desc);

create index assembly_bom_lines_child_idx
  on public.assembly_bom_lines (child_item_version_id);

create index item_shares_item_idx
  on public.item_shares (item_id, created_at desc);

create index parts_pdm_item_version_idx
  on public.parts (pdm_item_version_id)
  where pdm_item_version_id is not null;

create index quote_requests_item_version_idx
  on public.quote_requests (item_version_id)
  where item_version_id is not null;

create index quote_requests_free_quote_item_idx
  on public.quote_requests (free_quote_item_id)
  where free_quote_item_id is not null;

create index quote_request_lanes_item_version_idx
  on public.quote_request_lanes (item_version_id)
  where item_version_id is not null;

create or replace function public.pdm_identity_key(p_part_number text, p_filename text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    lower(btrim(coalesce(nullif(btrim(p_part_number), ''), nullif(btrim(p_filename), '')))),
    ''
  );
$$;

create or replace function public.pdm_item_readable(
  p_organization_id uuid,
  p_project_id uuid,
  p_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    public.user_can_access_org(p_organization_id)
    or (p_project_id is not null and public.user_can_access_project(p_project_id))
    or (p_job_id is not null and public.user_can_access_job(p_job_id))
  );
$$;

create or replace function public.pdm_item_editable(
  p_organization_id uuid,
  p_project_id uuid,
  p_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    (p_job_id is not null and public.user_can_edit_job(p_job_id))
    or (p_project_id is not null and public.user_can_edit_project(p_project_id))
  );
$$;

create or replace function public.pdm_version_writable(
  p_item_id uuid,
  p_job_file_id uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.items item
    where item.id = p_item_id
      and item.organization_id = p_organization_id
      and (
        public.pdm_item_editable(item.organization_id, item.project_id, item.job_id)
        or (
          p_job_file_id is not null
          and exists (
            select 1
            from public.job_files file
            where file.id = p_job_file_id
              and file.organization_id = item.organization_id
              and public.user_can_edit_job(file.job_id)
              and (
                (item.project_id is null and item.job_id = file.job_id)
                or (
                  item.project_id is not null
                  and exists (
                    select 1
                    from public.project_jobs project_job
                    where project_job.project_id = item.project_id
                      and project_job.job_id = file.job_id
                  )
                )
              )
          )
        )
      )
  );
$$;

create or replace function public.pdm_guard_item_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_org uuid;
  v_job_org uuid;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.project_id is distinct from old.project_id
    or new.job_id is distinct from old.job_id
    or new.kind is distinct from old.kind
    or new.part_number is distinct from old.part_number
    or new.filename is distinct from old.filename
    or new.identity_key is distinct from old.identity_key
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'pdm_item_identity_immutable' using errcode = 'P0001';
  end if;

  new.identity_key := public.pdm_identity_key(new.part_number, new.filename);
  if new.identity_key is null then
    raise exception 'pdm_identity_required' using errcode = 'P0001';
  end if;

  if new.project_id is not null then
    select project.organization_id into v_project_org
    from public.projects project
    where project.id = new.project_id;
    if v_project_org is distinct from new.organization_id then
      raise exception 'pdm_item_organization_mismatch' using errcode = 'P0001';
    end if;
  end if;

  if new.job_id is not null then
    select job.organization_id into v_job_org
    from public.jobs job
    where job.id = new.job_id;
    if v_job_org is distinct from new.organization_id then
      raise exception 'pdm_item_organization_mismatch' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

create trigger pdm_guard_item_scope
before insert or update on public.items
for each row execute function public.pdm_guard_item_scope();

create or replace function public.pdm_assign_version_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_org uuid;
begin
  select item.organization_id into v_item_org
  from public.items item
  where item.id = new.item_id;
  if v_item_org is null or v_item_org is distinct from new.organization_id then
    raise exception 'pdm_version_organization_mismatch' using errcode = 'P0001';
  end if;

  if new.state is distinct from 'work_in_progress' then
    raise exception 'pdm_version_starts_in_progress' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pdm-item-version:' || new.item_id::text, 0));
  select coalesce(max(version.version_number), 0) + 1
    into new.version_number
  from public.item_versions version
  where version.item_id = new.item_id;
  return new;
end;
$$;

create trigger pdm_assign_version_number
before insert on public.item_versions
for each row execute function public.pdm_assign_version_number();

create or replace function public.pdm_guard_version_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.state in ('released', 'obsolete') then
      raise exception 'pdm_released_version_locked' using errcode = 'P0001';
    end if;
    return old;
  end if;

  if old.state in ('released', 'obsolete') then
    raise exception 'pdm_released_version_locked' using errcode = 'P0001';
  end if;

  if new.id is distinct from old.id
    or new.item_id is distinct from old.item_id
    or new.organization_id is distinct from old.organization_id
    or new.version_number is distinct from old.version_number
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.source_part_id is distinct from old.source_part_id
  then
    raise exception 'pdm_version_identity_immutable' using errcode = 'P0001';
  end if;

  if new.state is distinct from old.state and not (
    (old.state = 'work_in_progress' and new.state in ('pending_approval', 'obsolete'))
    or (old.state = 'pending_approval' and new.state in ('work_in_progress', 'released', 'obsolete'))
  ) then
    raise exception 'pdm_version_state_transition' using errcode = 'P0001';
  end if;

  if new.state = 'released' and old.state is distinct from 'released' and not exists (
    select 1
    from public.item_revisions revision
    where revision.item_version_id = new.id
      and revision.scheme = 'alpha'
  ) then
    raise exception 'pdm_release_requires_alpha_revision' using errcode = 'P0001';
  end if;

  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create trigger pdm_guard_version_mutation
before update or delete on public.item_versions
for each row execute function public.pdm_guard_version_mutation();

create or replace function public.pdm_guard_revision_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.item_versions%rowtype;
begin
  if tg_op = 'DELETE' or tg_op = 'UPDATE' then
    raise exception 'pdm_revision_immutable' using errcode = 'P0001';
  end if;

  select version.* into v_version
  from public.item_versions version
  where version.id = new.item_version_id;

  if v_version.id is null
    or v_version.item_id is distinct from new.item_id
    or v_version.organization_id is distinct from new.organization_id
  then
    raise exception 'pdm_revision_version_mismatch' using errcode = 'P0001';
  end if;

  if new.scheme = 'alpha' and v_version.state not in ('pending_approval', 'released') then
    raise exception 'pdm_alpha_revision_requires_release_state' using errcode = 'P0001';
  end if;

  if new.scheme = 'numeric' and v_version.state not in ('work_in_progress', 'pending_approval') then
    raise exception 'pdm_numeric_revision_requires_prerelease_state' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger pdm_guard_revision_mutation
before insert or update or delete on public.item_revisions
for each row execute function public.pdm_guard_revision_mutation();

create or replace function public.pdm_guard_bom_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.item_versions%rowtype;
  v_child public.item_versions%rowtype;
  v_parent_kind text;
  v_line public.assembly_bom_lines%rowtype;
begin
  if tg_op = 'DELETE' then
    v_line := old;
  else
    v_line := new;
  end if;

  select version.* into v_parent
  from public.item_versions version
  where version.id = v_line.assembly_item_version_id;

  if v_parent.id is null or v_parent.organization_id is distinct from v_line.organization_id then
    raise exception 'pdm_bom_organization_mismatch' using errcode = 'P0001';
  end if;

  if v_parent.state in ('released', 'obsolete') then
    raise exception 'pdm_released_bom_locked' using errcode = 'P0001';
  end if;

  select item.kind into v_parent_kind
  from public.items item
  where item.id = v_parent.item_id;

  if v_parent_kind is distinct from 'assembly' then
    raise exception 'pdm_bom_parent_not_assembly' using errcode = 'P0001';
  end if;

  if tg_op <> 'DELETE' then
    select version.* into v_child
    from public.item_versions version
    where version.id = new.child_item_version_id;
    if v_child.id is null or v_child.organization_id is distinct from new.organization_id then
      raise exception 'pdm_bom_organization_mismatch' using errcode = 'P0001';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger pdm_guard_bom_mutation
before insert or update or delete on public.assembly_bom_lines
for each row execute function public.pdm_guard_bom_mutation();

create or replace function public.pdm_guard_released_file()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.item_versions version
    where version.state = 'released'
      and (version.job_file_id = old.id or version.drawing_file_id = old.id)
  ) then
    raise exception 'pdm_released_version_file_locked' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger pdm_guard_released_file
before update or delete on public.job_files
for each row execute function public.pdm_guard_released_file();

create or replace function public.pdm_guard_share_pin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items%rowtype;
  v_version public.item_versions%rowtype;
begin
  select item.* into v_item from public.items item where item.id = new.item_id;
  if v_item.id is null or v_item.organization_id is distinct from new.organization_id then
    raise exception 'pdm_share_organization_mismatch' using errcode = 'P0001';
  end if;
  if new.project_id is not null and v_item.project_id is distinct from new.project_id then
    raise exception 'pdm_share_project_mismatch' using errcode = 'P0001';
  end if;
  if new.pinned_item_version_id is not null then
    select version.* into v_version
    from public.item_versions version
    where version.id = new.pinned_item_version_id;
    if v_version.id is null or v_version.item_id is distinct from new.item_id then
      raise exception 'pdm_share_version_mismatch' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

create trigger pdm_guard_share_pin
before insert or update on public.item_shares
for each row execute function public.pdm_guard_share_pin();

-- Invoker so current_user is the caller. A security-definer trigger would
-- always see its owner and could not refuse an authenticated UPDATE.
create or replace function public.pdm_guard_quote_pin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.free_quote_unlimited
    and (tg_op = 'INSERT' or old.free_quote_unlimited is distinct from true)
    and current_user not in ('postgres', 'supabase_admin', 'service_role')
  then
    raise exception 'pdm_free_quote_unlimited_locked' using errcode = 'P0001';
  end if;

  if new.item_version_id is not null and new.free_quote_item_id is not null then
    if not exists (
      select 1
      from public.item_versions version
      where version.id = new.item_version_id
        and version.item_id = new.free_quote_item_id
        and version.organization_id = new.organization_id
    ) then
      raise exception 'pdm_quote_pin_mismatch' using errcode = 'P0001';
    end if;
  elsif new.item_version_id is not null then
    if not exists (
      select 1
      from public.item_versions version
      where version.id = new.item_version_id
        and version.organization_id = new.organization_id
    ) then
      raise exception 'pdm_quote_pin_mismatch' using errcode = 'P0001';
    end if;
  elsif new.free_quote_item_id is not null then
    if not exists (
      select 1
      from public.items item
      where item.id = new.free_quote_item_id
        and item.organization_id = new.organization_id
    ) then
      raise exception 'pdm_quote_pin_mismatch' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger pdm_guard_quote_pin
before insert or update of item_version_id, free_quote_item_id, free_quote_unlimited
on public.quote_requests
for each row execute function public.pdm_guard_quote_pin();

create or replace function public.pdm_guard_lane_pin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.item_version_id is not null and not exists (
    select 1
    from public.item_versions version
    where version.id = new.item_version_id
      and version.organization_id = new.organization_id
  ) then
    raise exception 'pdm_quote_pin_mismatch' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger pdm_guard_lane_pin
before insert or update of item_version_id on public.quote_request_lanes
for each row execute function public.pdm_guard_lane_pin();

create or replace function public.pdm_next_revision_label(p_item_id uuid, p_scheme text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item public.items%rowtype;
  v_alphabet text[] := array['A','B','C','D','E','F','G','H','J','K','L','M','N','P','R','T','U','V','W','Y'];
  v_highest integer := 0;
  v_label text;
  v_index integer;
  v_next integer;
begin
  if p_scheme not in ('numeric', 'alpha') then
    raise exception 'pdm_revision_scheme' using errcode = 'P0001';
  end if;

  select item.* into v_item from public.items item where item.id = p_item_id;
  if v_item.id is null then
    raise exception 'pdm_item_not_found' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and not public.pdm_item_readable(v_item.organization_id, v_item.project_id, v_item.job_id) then
    raise exception 'pdm_item_read_denied' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pdm-revision:' || p_item_id::text, 0));

  if p_scheme = 'numeric' then
    select coalesce(max(revision.label::integer), 0) + 1
      into v_next
    from public.item_revisions revision
    where revision.item_id = p_item_id
      and revision.scheme = 'numeric';
    return lpad(v_next::text, greatest(2, char_length(v_next::text)), '0');
  end if;

  for v_label in
    select revision.label
    from public.item_revisions revision
    where revision.item_id = p_item_id
      and revision.scheme = 'alpha'
  loop
    v_index := array_position(v_alphabet, v_label);
    if v_index is null then
      raise exception 'pdm_revision_label_invalid' using errcode = 'P0001';
    end if;
    if v_index > v_highest then
      v_highest := v_index;
    end if;
  end loop;

  if v_highest = 0 then
    return v_alphabet[1];
  end if;
  if v_highest >= array_length(v_alphabet, 1) then
    raise exception 'pdm_revision_alphabet_exhausted' using errcode = 'P0001';
  end if;
  return v_alphabet[v_highest + 1];
end;
$$;

create or replace function public.pdm_apply_prerelease_revision(
  p_version_id uuid,
  p_created_by uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_version public.item_versions%rowtype;
  v_label text;
  v_revision_id uuid;
begin
  select version.* into v_version
  from public.item_versions version
  where version.id = p_version_id
  for update;

  if v_version.id is null then
    raise exception 'pdm_version_not_found' using errcode = 'P0001';
  end if;
  if v_version.state not in ('work_in_progress', 'pending_approval') then
    raise exception 'pdm_numeric_revision_requires_prerelease_state' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and not public.pdm_version_writable(v_version.item_id, v_version.job_file_id, v_version.organization_id) then
    raise exception 'pdm_item_write_denied' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.item_revisions revision
    where revision.item_version_id = v_version.id
      and revision.scheme = 'numeric'
  ) then
    raise exception 'pdm_revision_already_applied' using errcode = 'P0001';
  end if;

  v_label := public.pdm_next_revision_label(v_version.item_id, 'numeric');
  insert into public.item_revisions (
    item_id, item_version_id, organization_id, scheme, label, created_by
  ) values (
    v_version.item_id, v_version.id, v_version.organization_id, 'numeric', v_label, p_created_by
  )
  returning id into v_revision_id;
  return v_revision_id;
end;
$$;

create or replace function public.pdm_release_item_version(
  p_version_id uuid,
  p_created_by uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_version public.item_versions%rowtype;
  v_label text;
  v_revision_id uuid;
begin
  select version.* into v_version
  from public.item_versions version
  where version.id = p_version_id
  for update;

  if v_version.id is null then
    raise exception 'pdm_version_not_found' using errcode = 'P0001';
  end if;
  if v_version.state is distinct from 'pending_approval' then
    raise exception 'pdm_release_requires_pending_approval' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and not public.pdm_version_writable(v_version.item_id, v_version.job_file_id, v_version.organization_id) then
    raise exception 'pdm_item_write_denied' using errcode = 'P0001';
  end if;

  v_label := public.pdm_next_revision_label(v_version.item_id, 'alpha');
  insert into public.item_revisions (
    item_id, item_version_id, organization_id, scheme, label, created_by
  ) values (
    v_version.item_id, v_version.id, v_version.organization_id, 'alpha', v_label, p_created_by
  )
  returning id into v_revision_id;

  update public.item_versions
  set state = 'released'
  where id = v_version.id;

  return v_revision_id;
end;
$$;

create or replace function public.pdm_record_upload(
  p_organization_id uuid,
  p_project_id uuid,
  p_job_id uuid,
  p_kind text,
  p_part_number text,
  p_filename text,
  p_display_name text,
  p_job_file_id uuid,
  p_comment text,
  p_created_by uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_key text;
  v_item_id uuid;
  v_version_id uuid;
  v_created_by uuid;
begin
  if p_kind not in ('part', 'assembly') then
    raise exception 'pdm_item_kind' using errcode = 'P0001';
  end if;
  if p_project_id is null and p_job_id is null then
    raise exception 'pdm_item_scope_required' using errcode = 'P0001';
  end if;
  v_key := public.pdm_identity_key(p_part_number, p_filename);
  if v_key is null then
    raise exception 'pdm_identity_required' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and not (
    (p_job_id is not null and public.user_can_edit_job(p_job_id))
    or (p_project_id is not null and public.user_can_edit_project(p_project_id))
  ) then
    raise exception 'pdm_item_write_denied' using errcode = 'P0001';
  end if;

  v_created_by := coalesce(p_created_by, auth.uid());

  if p_project_id is not null then
    select item.id into v_item_id
    from public.items item
    where item.organization_id = p_organization_id
      and item.project_id = p_project_id
      and item.identity_key = v_key
    for update;
  else
    select item.id into v_item_id
    from public.items item
    where item.organization_id = p_organization_id
      and item.project_id is null
      and item.job_id = p_job_id
      and item.identity_key = v_key
    for update;
  end if;

  if v_item_id is null then
    begin
      insert into public.items (
        organization_id, project_id, job_id, kind, part_number, filename, display_name, created_by
      ) values (
        p_organization_id, p_project_id, p_job_id, p_kind, nullif(btrim(p_part_number), ''),
        nullif(btrim(p_filename), ''), p_display_name, v_created_by
      )
      returning id into v_item_id;
    exception
      when unique_violation then
        if p_project_id is not null then
          select item.id into v_item_id
          from public.items item
          where item.organization_id = p_organization_id
            and item.project_id = p_project_id
            and item.identity_key = v_key;
        else
          select item.id into v_item_id
          from public.items item
          where item.organization_id = p_organization_id
            and item.project_id is null
            and item.job_id = p_job_id
            and item.identity_key = v_key;
        end if;
        if v_item_id is null then
          raise;
        end if;
    end;
  end if;

  insert into public.item_versions (
    item_id, organization_id, comment, job_file_id, created_by
  ) values (
    v_item_id, p_organization_id, p_comment, p_job_file_id, v_created_by
  )
  returning id into v_version_id;
  return v_version_id;
end;
$$;

create or replace function public.pdm_resolve_share_version(p_share_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case share.mode
    when 'frozen' then share.pinned_item_version_id
    when 'follow_latest_released' then (
      select version.id
      from public.item_versions version
      where version.item_id = share.item_id
        and version.state = 'released'
      order by version.version_number desc
      limit 1
    )
    else (
      select version.id
      from public.item_versions version
      where version.item_id = share.item_id
        and version.state <> 'obsolete'
      order by version.version_number desc
      limit 1
    )
  end
  from public.item_shares share
  where share.id = p_share_id;
$$;

create or replace function public.pdm_released_assembly_unreleased_children(p_assembly_version_id uuid)
returns table (
  bom_line_id uuid,
  child_item_version_id uuid,
  child_state text
)
language sql
stable
security definer
set search_path = ''
as $$
  select line.id, line.child_item_version_id, child.state
  from public.assembly_bom_lines line
  join public.item_versions parent on parent.id = line.assembly_item_version_id
  join public.item_versions child on child.id = line.child_item_version_id
  join public.items item on item.id = parent.item_id
  where line.assembly_item_version_id = p_assembly_version_id
    and parent.state = 'released'
    and child.state is distinct from 'released'
    and (
      auth.uid() is null
      or public.pdm_item_readable(item.organization_id, item.project_id, item.job_id)
    );
$$;

comment on function public.pdm_released_assembly_unreleased_children(uuid) is
  'Warn-only helper. Returns unreleased children of a released assembly version and does not block the release.';

create or replace function public.pdm_backfill_legacy_placements()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_part record;
  v_file record;
  v_project_id uuid;
  v_item_id uuid;
  v_version_id uuid;
  v_key text;
  v_kind text;
  v_items integer := 0;
  v_versions integer := 0;
  v_parts integer := 0;
  v_files integer := 0;
  v_requests integer := 0;
  v_lanes integer := 0;
begin
  for v_part in
    select part.id, part.organization_id, part.job_id, part.name, part.normalized_key,
      part.cad_file_id, part.drawing_file_id, part.created_at, job.created_by as job_created_by
    from public.parts part
    join public.jobs job on job.id = part.job_id
    where part.pdm_item_version_id is null
    order by part.created_at, part.id
  loop
    select project_job.project_id into v_project_id
    from public.project_jobs project_job
    where project_job.job_id = v_part.job_id
    order by project_job.created_at, project_job.id
    limit 1;
    if v_project_id is null then
      select job.project_id into v_project_id
      from public.jobs job
      where job.id = v_part.job_id;
    end if;

    v_key := public.pdm_identity_key(null, v_part.normalized_key);
    v_item_id := null;
    if v_project_id is not null then
      select item.id into v_item_id
      from public.items item
      where item.organization_id = v_part.organization_id
        and item.project_id = v_project_id
        and item.identity_key = v_key;
    else
      select item.id into v_item_id
      from public.items item
      where item.organization_id = v_part.organization_id
        and item.project_id is null
        and item.job_id = v_part.job_id
        and item.identity_key = v_key;
    end if;

    if v_item_id is null then
      insert into public.items (
        organization_id, project_id, job_id, kind, filename, display_name, created_by
      ) values (
        v_part.organization_id, v_project_id, v_part.job_id, 'part',
        v_part.normalized_key, v_part.name, v_part.job_created_by
      )
      returning id into v_item_id;
      v_items := v_items + 1;
    end if;

    insert into public.item_versions (
      item_id, organization_id, state, comment, created_by, job_file_id, drawing_file_id, source_part_id
    ) values (
      v_item_id, v_part.organization_id, 'work_in_progress',
      'Backfilled from the existing part placement.',
      v_part.job_created_by, v_part.cad_file_id, v_part.drawing_file_id, v_part.id
    )
    returning id into v_version_id;
    v_versions := v_versions + 1;

    update public.parts
    set pdm_item_id = v_item_id, pdm_item_version_id = v_version_id
    where id = v_part.id;
    v_parts := v_parts + 1;
  end loop;

  for v_file in
    select file.id, file.organization_id, file.job_id, file.original_name, file.normalized_name,
      file.uploaded_by
    from public.job_files file
    where file.file_kind in ('cad', 'drawing')
      and not exists (
        select 1
        from public.item_versions version
        where version.job_file_id = file.id
          or version.drawing_file_id = file.id
      )
    order by file.created_at, file.id
  loop
    select project_job.project_id into v_project_id
    from public.project_jobs project_job
    where project_job.job_id = v_file.job_id
    order by project_job.created_at, project_job.id
    limit 1;
    if v_project_id is null then
      select job.project_id into v_project_id
      from public.jobs job
      where job.id = v_file.job_id;
    end if;

    v_key := public.pdm_identity_key(null, v_file.normalized_name);
    v_kind := case
      when lower(v_file.original_name) ~ '\.(sldasm|asm)$' then 'assembly'
      else 'part'
    end;
    v_item_id := null;
    if v_project_id is not null then
      select item.id into v_item_id
      from public.items item
      where item.organization_id = v_file.organization_id
        and item.project_id = v_project_id
        and item.identity_key = v_key;
    else
      select item.id into v_item_id
      from public.items item
      where item.organization_id = v_file.organization_id
        and item.project_id is null
        and item.job_id = v_file.job_id
        and item.identity_key = v_key;
    end if;

    if v_item_id is null then
      insert into public.items (
        organization_id, project_id, job_id, kind, filename, display_name, created_by
      ) values (
        v_file.organization_id, v_project_id, v_file.job_id, v_kind,
        v_file.normalized_name, v_file.original_name, v_file.uploaded_by
      )
      returning id into v_item_id;
      v_items := v_items + 1;
    end if;

    insert into public.item_versions (
      item_id, organization_id, state, comment, created_by, job_file_id
    ) values (
      v_item_id, v_file.organization_id, 'work_in_progress',
      'Backfilled from an existing job file.',
      v_file.uploaded_by, v_file.id
    );
    v_versions := v_versions + 1;
    v_files := v_files + 1;
  end loop;

  update public.quote_request_lanes lane
  set item_version_id = part.pdm_item_version_id
  from public.parts part
  where lane.part_id = part.id
    and lane.item_version_id is null
    and part.pdm_item_version_id is not null
    and part.organization_id = lane.organization_id;
  get diagnostics v_lanes = row_count;

  update public.quote_requests request
  set item_version_id = pinned.version_id,
      free_quote_item_id = pinned.item_id
  from (
    select part.job_id,
      (array_agg(part.pdm_item_id))[1] as item_id,
      (array_agg(part.pdm_item_version_id))[1] as version_id
    from public.parts part
    where part.pdm_item_version_id is not null
    group by part.job_id
    having count(*) = 1
  ) pinned
  where request.job_id = pinned.job_id
    and request.item_version_id is null
    and request.free_quote_item_id is null;
  get diagnostics v_requests = row_count;

  return jsonb_build_object(
    'items', v_items,
    'versions', v_versions,
    'partsLinked', v_parts,
    'filesLinked', v_files,
    'quoteRequestsPinned', v_requests,
    'lanesPinned', v_lanes
  );
end;
$$;

revoke all on function public.pdm_identity_key(text, text) from public, anon;
revoke all on function public.pdm_item_readable(uuid, uuid, uuid) from public, anon;
revoke all on function public.pdm_item_editable(uuid, uuid, uuid) from public, anon;
revoke all on function public.pdm_version_writable(uuid, uuid, uuid) from public, anon;
revoke all on function public.pdm_guard_item_scope() from public, anon;
revoke all on function public.pdm_assign_version_number() from public, anon;
revoke all on function public.pdm_guard_version_mutation() from public, anon;
revoke all on function public.pdm_guard_revision_mutation() from public, anon;
revoke all on function public.pdm_guard_bom_mutation() from public, anon;
revoke all on function public.pdm_guard_released_file() from public, anon;
revoke all on function public.pdm_guard_share_pin() from public, anon;
revoke all on function public.pdm_guard_quote_pin() from public, anon;
revoke all on function public.pdm_guard_lane_pin() from public, anon;
revoke all on function public.pdm_next_revision_label(uuid, text) from public, anon;
revoke all on function public.pdm_apply_prerelease_revision(uuid, uuid) from public, anon;
revoke all on function public.pdm_release_item_version(uuid, uuid) from public, anon;
revoke all on function public.pdm_record_upload(uuid, uuid, uuid, text, text, text, text, uuid, text, uuid) from public, anon;
revoke all on function public.pdm_resolve_share_version(uuid) from public, anon;
revoke all on function public.pdm_released_assembly_unreleased_children(uuid) from public, anon;
revoke all on function public.pdm_backfill_legacy_placements() from public, anon, authenticated;

grant execute on function public.pdm_identity_key(text, text) to authenticated, service_role;
grant execute on function public.pdm_item_readable(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.pdm_item_editable(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.pdm_version_writable(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.pdm_guard_item_scope() to authenticated, service_role;
grant execute on function public.pdm_assign_version_number() to authenticated, service_role;
grant execute on function public.pdm_guard_version_mutation() to authenticated, service_role;
grant execute on function public.pdm_guard_revision_mutation() to authenticated, service_role;
grant execute on function public.pdm_guard_bom_mutation() to authenticated, service_role;
grant execute on function public.pdm_guard_released_file() to authenticated, service_role;
grant execute on function public.pdm_guard_share_pin() to authenticated, service_role;
grant execute on function public.pdm_guard_quote_pin() to authenticated, service_role;
grant execute on function public.pdm_guard_lane_pin() to authenticated, service_role;
grant execute on function public.pdm_next_revision_label(uuid, text) to authenticated, service_role;
grant execute on function public.pdm_apply_prerelease_revision(uuid, uuid) to authenticated, service_role;
grant execute on function public.pdm_release_item_version(uuid, uuid) to authenticated, service_role;
grant execute on function public.pdm_record_upload(uuid, uuid, uuid, text, text, text, text, uuid, text, uuid) to authenticated, service_role;
grant execute on function public.pdm_resolve_share_version(uuid) to authenticated, service_role;
grant execute on function public.pdm_released_assembly_unreleased_children(uuid) to authenticated, service_role;
grant execute on function public.pdm_backfill_legacy_placements() to service_role;

alter table public.items enable row level security;
alter table public.items force row level security;
alter table public.item_versions enable row level security;
alter table public.item_versions force row level security;
alter table public.item_revisions enable row level security;
alter table public.item_revisions force row level security;
alter table public.assembly_bom_lines enable row level security;
alter table public.assembly_bom_lines force row level security;
alter table public.item_shares enable row level security;
alter table public.item_shares force row level security;

revoke all on public.items, public.item_versions, public.item_revisions, public.assembly_bom_lines, public.item_shares
  from public, anon, authenticated;

grant select, insert, update on public.items to authenticated;
grant select, insert, update, delete on public.item_versions to authenticated;
grant select, insert on public.item_revisions to authenticated;
grant select, insert, update, delete on public.assembly_bom_lines to authenticated;
grant select, insert, update, delete on public.item_shares to authenticated;
grant all on public.items, public.item_versions, public.item_revisions, public.assembly_bom_lines, public.item_shares
  to service_role;

create policy items_select_accessible
on public.items
for select
to authenticated
using (public.pdm_item_readable(organization_id, project_id, job_id));

create policy items_insert_editors
on public.items
for insert
to authenticated
with check (
  public.pdm_item_editable(organization_id, project_id, job_id)
  and (created_by is null or created_by = auth.uid())
);

create policy items_update_editors
on public.items
for update
to authenticated
using (public.pdm_item_editable(organization_id, project_id, job_id))
with check (public.pdm_item_editable(organization_id, project_id, job_id));

create policy item_versions_select_accessible
on public.item_versions
for select
to authenticated
using (
  exists (
    select 1
    from public.items item
    where item.id = item_versions.item_id
      and public.pdm_item_readable(item.organization_id, item.project_id, item.job_id)
  )
);

create policy item_versions_insert_editors
on public.item_versions
for insert
to authenticated
with check (
  state = 'work_in_progress'
  and public.pdm_version_writable(item_id, job_file_id, organization_id)
);

create policy item_versions_update_editors
on public.item_versions
for update
to authenticated
using (public.pdm_version_writable(item_id, job_file_id, organization_id))
with check (public.pdm_version_writable(item_id, job_file_id, organization_id));

create policy item_versions_delete_editors
on public.item_versions
for delete
to authenticated
using (
  state not in ('released', 'obsolete')
  and public.pdm_version_writable(item_id, job_file_id, organization_id)
);

create policy item_revisions_select_accessible
on public.item_revisions
for select
to authenticated
using (
  exists (
    select 1
    from public.items item
    where item.id = item_revisions.item_id
      and public.pdm_item_readable(item.organization_id, item.project_id, item.job_id)
  )
);

create policy item_revisions_insert_editors
on public.item_revisions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.item_versions version
    where version.id = item_revisions.item_version_id
      and version.item_id = item_revisions.item_id
      and version.organization_id = item_revisions.organization_id
      and public.pdm_version_writable(version.item_id, version.job_file_id, version.organization_id)
  )
);

create policy assembly_bom_lines_select_accessible
on public.assembly_bom_lines
for select
to authenticated
using (
  exists (
    select 1
    from public.item_versions version
    join public.items item on item.id = version.item_id
    where version.id = assembly_bom_lines.assembly_item_version_id
      and public.pdm_item_readable(item.organization_id, item.project_id, item.job_id)
  )
);

create policy assembly_bom_lines_insert_editors
on public.assembly_bom_lines
for insert
to authenticated
with check (
  exists (
    select 1
    from public.item_versions version
    where version.id = assembly_bom_lines.assembly_item_version_id
      and version.organization_id = assembly_bom_lines.organization_id
      and version.state not in ('released', 'obsolete')
      and public.pdm_version_writable(version.item_id, version.job_file_id, version.organization_id)
  )
);

create policy assembly_bom_lines_update_editors
on public.assembly_bom_lines
for update
to authenticated
using (
  exists (
    select 1
    from public.item_versions version
    where version.id = assembly_bom_lines.assembly_item_version_id
      and version.state not in ('released', 'obsolete')
      and public.pdm_version_writable(version.item_id, version.job_file_id, version.organization_id)
  )
)
with check (
  exists (
    select 1
    from public.item_versions version
    where version.id = assembly_bom_lines.assembly_item_version_id
      and version.organization_id = assembly_bom_lines.organization_id
      and version.state not in ('released', 'obsolete')
      and public.pdm_version_writable(version.item_id, version.job_file_id, version.organization_id)
  )
);

create policy assembly_bom_lines_delete_editors
on public.assembly_bom_lines
for delete
to authenticated
using (
  exists (
    select 1
    from public.item_versions version
    where version.id = assembly_bom_lines.assembly_item_version_id
      and version.state not in ('released', 'obsolete')
      and public.pdm_version_writable(version.item_id, version.job_file_id, version.organization_id)
  )
);

create policy item_shares_select_accessible
on public.item_shares
for select
to authenticated
using (
  exists (
    select 1
    from public.items item
    where item.id = item_shares.item_id
      and public.pdm_item_readable(item.organization_id, item.project_id, item.job_id)
  )
);

create policy item_shares_insert_editors
on public.item_shares
for insert
to authenticated
with check (
  (created_by is null or created_by = auth.uid())
  and exists (
    select 1
    from public.items item
    where item.id = item_shares.item_id
      and item.organization_id = item_shares.organization_id
      and public.pdm_item_editable(item.organization_id, item.project_id, item.job_id)
  )
);

create policy item_shares_update_editors
on public.item_shares
for update
to authenticated
using (
  exists (
    select 1
    from public.items item
    where item.id = item_shares.item_id
      and public.pdm_item_editable(item.organization_id, item.project_id, item.job_id)
  )
)
with check (
  exists (
    select 1
    from public.items item
    where item.id = item_shares.item_id
      and item.organization_id = item_shares.organization_id
      and public.pdm_item_editable(item.organization_id, item.project_id, item.job_id)
  )
);

create policy item_shares_delete_editors
on public.item_shares
for delete
to authenticated
using (
  exists (
    select 1
    from public.items item
    where item.id = item_shares.item_id
      and public.pdm_item_editable(item.organization_id, item.project_id, item.job_id)
  )
);

select public.pdm_backfill_legacy_placements();
