alter type public.queue_task_type add value if not exists 'generate_cad_preview';

create table if not exists public.cad_preview_assets (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.parts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_cad_file_id uuid not null references public.job_files(id) on delete cascade,
  source_content_sha256 text,
  display_style text not null default 'hidden_lines_removed',
  view_orientation text not null default 'isometric',
  renderer_version text not null,
  storage_bucket text not null default 'quote-artifacts',
  storage_path text not null,
  mime_type text not null default 'image/svg+xml',
  width integer not null,
  height integer not null,
  generated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint cad_preview_assets_display_style_check
    check (display_style in ('hidden_lines_removed')),
  constraint cad_preview_assets_view_orientation_check
    check (view_orientation in ('isometric')),
  constraint cad_preview_assets_dimensions_check
    check (width > 0 and height > 0),
  unique (part_id, display_style, view_orientation),
  unique (storage_bucket, storage_path)
);

create index if not exists idx_cad_preview_assets_source_file
on public.cad_preview_assets(source_cad_file_id);

create index if not exists idx_cad_preview_assets_organization
on public.cad_preview_assets(organization_id, generated_at desc);

drop trigger if exists touch_cad_preview_assets_updated_at on public.cad_preview_assets;
create trigger touch_cad_preview_assets_updated_at
before update on public.cad_preview_assets
for each row execute function public.touch_updated_at();

alter table public.cad_preview_assets enable row level security;

drop policy if exists "cad_preview_assets_select_accessible" on public.cad_preview_assets;
create policy "cad_preview_assets_select_accessible"
on public.cad_preview_assets
for select
to authenticated
using (
  exists (
    select 1
    from public.parts part
    where part.id = cad_preview_assets.part_id
      and public.user_can_access_job(part.job_id)
  )
);

revoke all on table public.cad_preview_assets from anon, authenticated;
grant select on table public.cad_preview_assets to authenticated;
grant all on table public.cad_preview_assets to service_role;

drop policy if exists "quote_artifacts_storage_read_cad_previews" on storage.objects;
create policy "quote_artifacts_storage_read_cad_previews"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'quote-artifacts'
  and exists (
    select 1
    from public.cad_preview_assets asset
    join public.parts part on part.id = asset.part_id
    where asset.storage_path = objects.name
      and asset.storage_bucket = objects.bucket_id
      and public.user_can_access_job(part.job_id)
  )
);
