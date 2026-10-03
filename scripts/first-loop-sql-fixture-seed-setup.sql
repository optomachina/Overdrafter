-- Synthetic Storage metadata only; no corresponding bytes.
insert into storage.buckets(id,name,public) values('mapping-synthetic','mapping-synthetic',false);
insert into storage.objects(id,bucket_id,name,version)
select pg_temp.n(800+n),'mapping-synthetic','seed-'||n,'pinned-v1' from generate_series(0,2) n;
create function pg_temp.seed_manifest() returns text language sql as $m$
select jsonb_agg(jsonb_build_object('role',(array['assembly','target','companion'])[n+1],
 'path',f->>'path','bytes',f->'bytes','sha256',f->>'sha256','storageObjectId',o.id,
 'storageVersion',o.version,'storageUpdatedAt',o.updated_at) order by n)::text
from public.engineering_snapshots s cross join generate_series(0,2) n
cross join lateral(select s.context_text::jsonb->'files'->n as f) files
join storage.objects o on o.id=pg_temp.n(800+n) where s.id=pg_temp.n(20);
$m$;
