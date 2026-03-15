drop policy if exists "quote_artifacts_storage_read_drawing_previews" on storage.objects;
create policy "quote_artifacts_storage_read_drawing_previews"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'quote-artifacts'
  and exists (
    select 1
    from public.drawing_preview_assets asset
    join public.parts part on part.id = asset.part_id
    where asset.storage_path = name
      and public.user_can_access_job(part.job_id)
  )
);
