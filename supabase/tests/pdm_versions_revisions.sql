-- PDM item versions, revision labels, released locks, BOM snapshots, and backfill.
-- Rolls back. Applies only against a database that already ran the PDM migration.
begin;
set local search_path = public, extensions;

create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values
  ('a4a40000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pdm-editor@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb),
  ('a4a40000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pdm-other@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb),
  ('a4a40000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pdm-reader@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb);

insert into public.organizations (id, name, slug)
values
  ('a4a40000-0000-4000-8000-000000000010', 'PDM org', 'pdm-org'),
  ('a4a40000-0000-4000-8000-000000000011', 'PDM other org', 'pdm-other-org');

insert into public.organization_memberships (organization_id, user_id, role)
values
  ('a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'client'),
  ('a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000003', 'client'),
  ('a4a40000-0000-4000-8000-000000000011', 'a4a40000-0000-4000-8000-000000000002', 'client');

insert into public.projects (id, organization_id, owner_user_id, name)
values (
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000001',
  'PDM project'
);

insert into public.project_memberships (project_id, user_id, role)
values (
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000001',
  'owner'
);

insert into public.jobs (id, organization_id, created_by, title, project_id)
values
  ('a4a40000-0000-4000-8000-000000000020', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'PDM behavior', 'a4a40000-0000-4000-8000-000000000030'),
  ('a4a40000-0000-4000-8000-000000000021', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'PDM unscoped', null),
  ('a4a40000-0000-4000-8000-000000000022', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'PDM backfill A', 'a4a40000-0000-4000-8000-000000000030'),
  ('a4a40000-0000-4000-8000-000000000025', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'PDM backfill B', 'a4a40000-0000-4000-8000-000000000030'),
  ('a4a40000-0000-4000-8000-000000000023', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'PDM single quote', 'a4a40000-0000-4000-8000-000000000030'),
  ('a4a40000-0000-4000-8000-000000000026', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'PDM multi quote', 'a4a40000-0000-4000-8000-000000000030'),
  ('a4a40000-0000-4000-8000-000000000027', 'a4a40000-0000-4000-8000-000000000011', 'a4a40000-0000-4000-8000-000000000002', 'PDM other job', null);

insert into public.project_jobs (project_id, job_id, created_by)
values
  ('a4a40000-0000-4000-8000-000000000030', 'a4a40000-0000-4000-8000-000000000020', 'a4a40000-0000-4000-8000-000000000001'),
  ('a4a40000-0000-4000-8000-000000000030', 'a4a40000-0000-4000-8000-000000000022', 'a4a40000-0000-4000-8000-000000000001'),
  ('a4a40000-0000-4000-8000-000000000030', 'a4a40000-0000-4000-8000-000000000025', 'a4a40000-0000-4000-8000-000000000001'),
  ('a4a40000-0000-4000-8000-000000000030', 'a4a40000-0000-4000-8000-000000000023', 'a4a40000-0000-4000-8000-000000000001'),
  ('a4a40000-0000-4000-8000-000000000030', 'a4a40000-0000-4000-8000-000000000026', 'a4a40000-0000-4000-8000-000000000001');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_path, original_name, normalized_name, file_kind
) values
  ('a4a40000-0000-4000-8000-000000000040', 'a4a40000-0000-4000-8000-000000000020', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'pdm/frame.sldprt', 'frame.sldprt', 'frame.sldprt', 'cad'),
  ('a4a40000-0000-4000-8000-000000000041', 'a4a40000-0000-4000-8000-000000000022', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'pdm/bracket-a.sldprt', 'bracket.sldprt', 'bracket', 'cad'),
  ('a4a40000-0000-4000-8000-000000000042', 'a4a40000-0000-4000-8000-000000000022', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'pdm/bracket-a.slddrw', 'bracket.slddrw', 'bracket-drawing', 'drawing'),
  ('a4a40000-0000-4000-8000-000000000043', 'a4a40000-0000-4000-8000-000000000022', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'pdm/loose.sldprt', 'loose.sldprt', 'loose.sldprt', 'cad'),
  ('a4a40000-0000-4000-8000-000000000044', 'a4a40000-0000-4000-8000-000000000022', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000001', 'pdm/dolly.sldasm', 'dolly.SLDASM', 'dolly.sldasm', 'cad');

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, created_at)
values
  ('a4a40000-0000-4000-8000-000000000050', 'a4a40000-0000-4000-8000-000000000022', 'a4a40000-0000-4000-8000-000000000010', 'Bracket', 'bracket', 'a4a40000-0000-4000-8000-000000000041', 'a4a40000-0000-4000-8000-000000000042', '2020-01-01 00:00:00+00'),
  ('a4a40000-0000-4000-8000-000000000051', 'a4a40000-0000-4000-8000-000000000025', 'a4a40000-0000-4000-8000-000000000010', 'Bracket later', 'bracket', null, null, '2020-02-01 00:00:00+00'),
  ('a4a40000-0000-4000-8000-000000000052', 'a4a40000-0000-4000-8000-000000000021', 'a4a40000-0000-4000-8000-000000000010', 'Bracket other job', 'bracket', null, null, '2020-03-01 00:00:00+00'),
  ('a4a40000-0000-4000-8000-000000000053', 'a4a40000-0000-4000-8000-000000000023', 'a4a40000-0000-4000-8000-000000000010', 'Pin me', 'pin-me', null, null, '2020-04-01 00:00:00+00'),
  ('a4a40000-0000-4000-8000-000000000054', 'a4a40000-0000-4000-8000-000000000026', 'a4a40000-0000-4000-8000-000000000010', 'Left', 'left-plate', null, null, '2020-05-01 00:00:00+00'),
  ('a4a40000-0000-4000-8000-000000000055', 'a4a40000-0000-4000-8000-000000000026', 'a4a40000-0000-4000-8000-000000000010', 'Right', 'right-plate', null, null, '2020-05-02 00:00:00+00');

insert into public.quote_requests (id, organization_id, job_id, requested_by, requested_vendors)
values
  ('a4a40000-0000-4000-8000-000000000060', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000023', 'a4a40000-0000-4000-8000-000000000001', array['xometry']::public.vendor_name[]),
  ('a4a40000-0000-4000-8000-000000000061', 'a4a40000-0000-4000-8000-000000000010', 'a4a40000-0000-4000-8000-000000000026', 'a4a40000-0000-4000-8000-000000000001', array['xometry']::public.vendor_name[]);

insert into public.quote_runs (id, job_id, organization_id, initiated_by, quote_request_id)
values (
  'a4a40000-0000-4000-8000-000000000070',
  'a4a40000-0000-4000-8000-000000000026',
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000001',
  'a4a40000-0000-4000-8000-000000000061'
);

insert into public.quote_request_lanes (
  id, organization_id, quote_request_id, quote_run_id, part_id, vendor, requested_quantity,
  scope_fingerprint, scope_snapshot
) values (
  'a4a40000-0000-4000-8000-000000000080',
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000061',
  'a4a40000-0000-4000-8000-000000000070',
  'a4a40000-0000-4000-8000-000000000054',
  'xometry',
  1,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{}'::jsonb
);

-- Version numbers are assigned. A matching part number stays one item.
select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  'PN-1',
  'frame-a.sldprt',
  'Frame',
  'a4a40000-0000-4000-8000-000000000040',
  'first upload',
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset first_

select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  'PN-1',
  'frame-b.sldprt',
  'Frame renamed',
  null,
  'second upload',
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset second_

select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  'PN-2',
  'frame-a.sldprt',
  'Other part',
  null,
  null,
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset other_part_

select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  null,
  'a4a40000-0000-4000-8000-000000000021',
  'part',
  null,
  'frame-a.sldprt',
  'Unscoped frame',
  null,
  null,
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset unscoped_

select is(
  (select version_number from public.item_versions where id = :'first_version_id'::uuid),
  1,
  'the first upload is version 1'
);
select is(
  (select version_number from public.item_versions where id = :'second_version_id'::uuid),
  2,
  'a re-upload of the same part number is version 2'
);
select is(
  (select item_id from public.item_versions where id = :'first_version_id'::uuid),
  (select item_id from public.item_versions where id = :'second_version_id'::uuid),
  'a matching part number stays the same item'
);
select is(
  (select state from public.item_versions where id = :'second_version_id'::uuid),
  'work_in_progress',
  'a new upload starts work in progress'
);
select ok(
  (select item_id from public.item_versions where id = :'other_part_version_id'::uuid)
    is distinct from (select item_id from public.item_versions where id = :'first_version_id'::uuid),
  'a different part number is a different item even when the filename matches'
);
select ok(
  (select item_id from public.item_versions where id = :'unscoped_version_id'::uuid)
    is distinct from (select item_id from public.item_versions where id = :'other_part_version_id'::uuid),
  'a job with no project does not merge into another job that reused the filename'
);

select is(
  public.pdm_next_revision_label(
    (select item_id from public.item_versions where id = :'first_version_id'::uuid),
    'numeric'
  ),
  '01',
  'the first prerelease revision is 01'
);
select public.pdm_apply_prerelease_revision(
  :'first_version_id'::uuid,
  'a4a40000-0000-4000-8000-000000000001'
);
select is(
  public.pdm_next_revision_label(
    (select item_id from public.item_versions where id = :'first_version_id'::uuid),
    'numeric'
  ),
  '02',
  'the next prerelease revision is 02'
);

select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  null,
  'numeric-pad.sldprt',
  'Numeric pad',
  null,
  null,
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset pad_

insert into public.item_revisions (item_id, item_version_id, organization_id, scheme, label)
select item_id, id, organization_id, 'numeric', '09'
from public.item_versions
where id = :'pad_version_id'::uuid;
select is(
  public.pdm_next_revision_label(
    (select item_id from public.item_versions where id = :'pad_version_id'::uuid),
    'numeric'
  ),
  '10',
  'numeric revisions continue past 09 without a fixed width'
);

select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  null,
  'numeric-hundred.sldprt',
  'Numeric hundred',
  null,
  null,
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset hundred_

insert into public.item_revisions (item_id, item_version_id, organization_id, scheme, label)
select item_id, id, organization_id, 'numeric', '99'
from public.item_versions
where id = :'hundred_version_id'::uuid;
select is(
  public.pdm_next_revision_label(
    (select item_id from public.item_versions where id = :'hundred_version_id'::uuid),
    'numeric'
  ),
  '100',
  'numeric revisions grow to 100'
);

create temporary table pdm_alpha_seed (seed text primary key, expected text not null);
insert into pdm_alpha_seed (seed, expected)
values ('H', 'J'), ('N', 'P'), ('P', 'R'), ('R', 'T'), ('W', 'Y');

create temporary table pdm_alpha_item (seed text primary key, item_id uuid not null);
do $$
declare
  v_seed record;
  v_version_id uuid;
  v_item_id uuid;
begin
  for v_seed in select seed from pdm_alpha_seed order by seed loop
    v_version_id := public.pdm_record_upload(
      'a4a40000-0000-4000-8000-000000000010',
      'a4a40000-0000-4000-8000-000000000030',
      'a4a40000-0000-4000-8000-000000000020',
      'part',
      null,
      v_seed.seed || '-alpha.sldprt',
      v_seed.seed,
      null,
      null,
      'a4a40000-0000-4000-8000-000000000001'
    );
    update public.item_versions set state = 'pending_approval' where id = v_version_id;
    insert into public.item_revisions (item_id, item_version_id, organization_id, scheme, label)
    select item_id, id, organization_id, 'alpha', v_seed.seed
    from public.item_versions
    where id = v_version_id
    returning item_id into v_item_id;
    insert into pdm_alpha_item (seed, item_id) values (v_seed.seed, v_item_id);
  end loop;
end
$$;

select is(
  public.pdm_next_revision_label(item.item_id, 'alpha'),
  seed.expected,
  'alpha revision after ' || seed.seed || ' is ' || seed.expected
)
from pdm_alpha_item item
join pdm_alpha_seed seed on seed.seed = item.seed
order by seed.seed;

select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  null,
  'alpha-end.sldprt',
  'Alpha end',
  null,
  null,
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset alpha_end_

update public.item_versions set state = 'pending_approval' where id = :'alpha_end_version_id'::uuid;
insert into public.item_revisions (item_id, item_version_id, organization_id, scheme, label)
select item_id, id, organization_id, 'alpha', 'Y'
from public.item_versions
where id = :'alpha_end_version_id'::uuid;
select throws_ok(
  format(
    'select public.pdm_next_revision_label(%L::uuid, %L)',
    (select item_id from public.item_versions where id = :'alpha_end_version_id'::uuid),
    'alpha'
  ),
  'P0001',
  'pdm_revision_alphabet_exhausted',
  'the alpha scheme stops after Y'
);

update public.item_versions
set state = 'pending_approval'
where id = :'pad_version_id'::uuid;
select throws_ok(
  format(
    $sql$insert into public.item_revisions (item_id, item_version_id, organization_id, scheme, label)
      select item_id, id, organization_id, 'alpha', %L
      from public.item_versions where id = %L::uuid$sql$,
    excluded.label,
    :'pad_version_id'
  ),
  '23514',
  null,
  'alpha label ' || excluded.label || ' cannot be stored'
)
from (values ('I'), ('O'), ('Q'), ('S'), ('X'), ('Z')) as excluded(label);

update public.item_versions
set state = 'pending_approval'
where id = :'first_version_id'::uuid;
select throws_ok(
  format('update public.item_versions set state = %L where id = %L::uuid', 'released', :'first_version_id'),
  'P0001',
  'pdm_release_requires_alpha_revision',
  'a version cannot become released without an alpha revision'
);
select public.pdm_release_item_version(
  :'first_version_id'::uuid,
  'a4a40000-0000-4000-8000-000000000001'
);
select is(
  (select label from public.item_revisions where item_version_id = :'first_version_id'::uuid and scheme = 'alpha'),
  'A',
  'the first release is revision A even after numeric prerelease labels'
);
select is(
  (select state from public.item_versions where id = :'first_version_id'::uuid),
  'released',
  'release locks the version as released'
);
select throws_ok(
  format('update public.item_versions set comment = %L where id = %L::uuid', 'changed', :'first_version_id'),
  'P0001',
  'pdm_released_version_locked',
  'a released version row cannot be updated'
);
select throws_ok(
  format('delete from public.item_versions where id = %L::uuid', :'first_version_id'),
  'P0001',
  'pdm_released_version_locked',
  'a released version row cannot be deleted'
);
select throws_ok(
  format('update public.job_files set original_name = %L where id = %L::uuid', 'renamed.sldprt', 'a4a40000-0000-4000-8000-000000000040'),
  'P0001',
  'pdm_released_version_file_locked',
  'the file of a released version cannot be updated'
);

select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  'PN-1',
  'frame-c.sldprt',
  'Frame',
  null,
  'after release',
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset after_release_
select is(
  (select version_number from public.item_versions where id = :'after_release_version_id'::uuid),
  3,
  'a change after release starts the next version'
);
select is(
  (select state from public.item_versions where id = :'after_release_version_id'::uuid),
  'work_in_progress',
  'the version after a release is work in progress'
);
update public.item_versions set state = 'pending_approval' where id = :'after_release_version_id'::uuid;
select public.pdm_release_item_version(
  :'after_release_version_id'::uuid,
  'a4a40000-0000-4000-8000-000000000001'
);
select is(
  (select label from public.item_revisions where item_version_id = :'after_release_version_id'::uuid and scheme = 'alpha'),
  'B',
  'the next release takes the next alpha letter'
);

-- Assembly BOM snapshot. The child stays unreleased on purpose.
select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'assembly',
  null,
  'dolly.sldasm',
  'Dolly',
  null,
  null,
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset dolly_
select public.pdm_record_upload(
  'a4a40000-0000-4000-8000-000000000010',
  'a4a40000-0000-4000-8000-000000000030',
  'a4a40000-0000-4000-8000-000000000020',
  'part',
  null,
  'caster.sldprt',
  'Caster',
  null,
  null,
  'a4a40000-0000-4000-8000-000000000001'
) as version_id \gset caster_

insert into public.assembly_bom_lines (
  assembly_item_version_id, child_item_version_id, organization_id, quantity, instance_path,
  transform, is_bought_part, configuration_name
) values (
  :'dolly_version_id'::uuid,
  :'caster_version_id'::uuid,
  'a4a40000-0000-4000-8000-000000000010',
  4,
  'dolly/caster:1',
  '{"translation":[0,0,0]}'::jsonb,
  true,
  'Default'
);
select is(
  (select quantity from public.assembly_bom_lines where assembly_item_version_id = :'dolly_version_id'::uuid),
  4,
  'a BOM line stores the child quantity'
);
select ok(
  (select is_bought_part from public.assembly_bom_lines where instance_path = 'dolly/caster:1'),
  'a BOM line stores the bought-part flag'
);
select throws_ok(
  format(
    $sql$insert into public.assembly_bom_lines (
      assembly_item_version_id, child_item_version_id, organization_id, quantity, instance_path
    ) values (%L::uuid, %L::uuid, %L::uuid, 1, 'self')$sql$,
    :'dolly_version_id', :'dolly_version_id', 'a4a40000-0000-4000-8000-000000000010'
  ),
  '23514',
  null,
  'a BOM line cannot reference its own assembly version'
);
select throws_ok(
  format(
    $sql$insert into public.assembly_bom_lines (
      assembly_item_version_id, child_item_version_id, organization_id, quantity, instance_path
    ) values (%L::uuid, %L::uuid, %L::uuid, 0, 'zero')$sql$,
    :'dolly_version_id', :'caster_version_id', 'a4a40000-0000-4000-8000-000000000010'
  ),
  '23514',
  null,
  'a BOM quantity must be positive'
);
select throws_ok(
  format(
    $sql$insert into public.assembly_bom_lines (
      assembly_item_version_id, child_item_version_id, organization_id, quantity, instance_path
    ) values (%L::uuid, %L::uuid, %L::uuid, 1, 'dolly/caster:1')$sql$,
    :'dolly_version_id', :'caster_version_id', 'a4a40000-0000-4000-8000-000000000010'
  ),
  '23505',
  null,
  'an instance path is unique inside one assembly version'
);

update public.item_versions set state = 'pending_approval' where id = :'dolly_version_id'::uuid;
select lives_ok(
  format(
    'select public.pdm_release_item_version(%L::uuid, %L::uuid)',
    :'dolly_version_id',
    'a4a40000-0000-4000-8000-000000000001'
  ),
  'releasing an assembly does not block on an unreleased child'
);
select is(
  (select count(*)::integer from public.pdm_released_assembly_unreleased_children(:'dolly_version_id'::uuid)),
  1,
  'the helper flags the unreleased child without changing the release'
);
select throws_ok(
  format(
    'update public.assembly_bom_lines set quantity = 5 where assembly_item_version_id = %L::uuid',
    :'dolly_version_id'
  ),
  'P0001',
  'pdm_released_bom_locked',
  'a released assembly BOM snapshot cannot change'
);

insert into public.item_shares (
  id, organization_id, project_id, item_id, mode, pinned_item_version_id, created_by
)
select
  'a4a40000-0000-4000-8000-000000000090',
  organization_id,
  'a4a40000-0000-4000-8000-000000000030',
  item_id,
  'frozen',
  :'first_version_id'::uuid,
  'a4a40000-0000-4000-8000-000000000001'
from public.item_versions
where id = :'first_version_id'::uuid;
insert into public.item_shares (
  id, organization_id, project_id, item_id, mode, pinned_item_version_id, created_by
)
select
  'a4a40000-0000-4000-8000-000000000091',
  organization_id,
  'a4a40000-0000-4000-8000-000000000030',
  item_id,
  'follow_latest',
  :'first_version_id'::uuid,
  'a4a40000-0000-4000-8000-000000000001'
from public.item_versions
where id = :'first_version_id'::uuid;
insert into public.item_shares (
  id, organization_id, project_id, item_id, mode, pinned_item_version_id, created_by
)
select
  'a4a40000-0000-4000-8000-000000000092',
  organization_id,
  'a4a40000-0000-4000-8000-000000000030',
  item_id,
  'follow_latest_released',
  :'first_version_id'::uuid,
  'a4a40000-0000-4000-8000-000000000001'
from public.item_versions
where id = :'first_version_id'::uuid;

select is(
  public.pdm_resolve_share_version('a4a40000-0000-4000-8000-000000000090'),
  :'first_version_id'::uuid,
  'a frozen share stays on the pinned version'
);
select is(
  public.pdm_resolve_share_version('a4a40000-0000-4000-8000-000000000091'),
  :'after_release_version_id'::uuid,
  'follow latest resolves the newest non-obsolete version'
);
select is(
  public.pdm_resolve_share_version('a4a40000-0000-4000-8000-000000000092'),
  :'after_release_version_id'::uuid,
  'follow latest released resolves the newest released version'
);

-- Legacy placements become work-in-progress history. Nothing is released.
select public.pdm_backfill_legacy_placements() as result \gset backfill_
select is((:'backfill_result'::jsonb ->> 'partsLinked')::integer, 6, 'backfill links every unlinked part');
select is(
  (select count(*)::integer from public.items item
    join public.item_versions version on version.item_id = item.id
    where version.source_part_id = 'a4a40000-0000-4000-8000-000000000050'),
  1,
  'the earliest bracket placement is a version of one item'
);
select is(
  (select version.version_number from public.item_versions version
    where version.source_part_id = 'a4a40000-0000-4000-8000-000000000050'),
  1,
  'the earlier bracket placement is version 1'
);
select is(
  (select version.version_number from public.item_versions version
    where version.source_part_id = 'a4a40000-0000-4000-8000-000000000051'),
  2,
  'a later same-name part in the same project is version 2 of that item'
);
select is(
  (select version.item_id from public.item_versions version
    where version.source_part_id = 'a4a40000-0000-4000-8000-000000000050'),
  (select version.item_id from public.item_versions version
    where version.source_part_id = 'a4a40000-0000-4000-8000-000000000051'),
  'same project and filename backfill into one item'
);
select ok(
  (select version.item_id from public.item_versions version
    where version.source_part_id = 'a4a40000-0000-4000-8000-000000000052')
    is distinct from (select version.item_id from public.item_versions version
      where version.source_part_id = 'a4a40000-0000-4000-8000-000000000050'),
  'the same filename on a job with no project stays its own item'
);
select is(
  (select state from public.item_versions where source_part_id = 'a4a40000-0000-4000-8000-000000000050'),
  'work_in_progress',
  'backfill does not release existing parts'
);
select is(
  (select job_file_id from public.item_versions where source_part_id = 'a4a40000-0000-4000-8000-000000000050'),
  'a4a40000-0000-4000-8000-000000000041'::uuid,
  'backfill keeps the part CAD file on version 1'
);
select is(
  (select count(*)::integer from public.item_versions where job_file_id = 'a4a40000-0000-4000-8000-000000000042'
    or drawing_file_id = 'a4a40000-0000-4000-8000-000000000042'),
  1,
  'a part drawing stays on that part version instead of becoming another item'
);
select is(
  (select item.kind from public.items item
    join public.item_versions version on version.item_id = item.id
    where version.job_file_id = 'a4a40000-0000-4000-8000-000000000044'),
  'assembly',
  'an orphan SolidWorks assembly file backfills as an assembly'
);
select ok(
  (select item_version_id is not null and free_quote_item_id is not null and free_quote_unlimited = false
    from public.quote_requests where id = 'a4a40000-0000-4000-8000-000000000060'),
  'a single-part quote pins to that part version and stays on the normal free-quote allowance'
);
select ok(
  (select item_version_id is null and free_quote_item_id is null and status = 'queued'
    from public.quote_requests where id = 'a4a40000-0000-4000-8000-000000000061'),
  'a multi-part quote request keeps its status and stays unpinned'
);
select ok(
  (select item_version_id is not null from public.quote_request_lanes
    where id = 'a4a40000-0000-4000-8000-000000000080'),
  'a quote lane pins to the part version'
);
select is(
  ((public.pdm_backfill_legacy_placements()) ->> 'partsLinked')::integer,
  0,
  'running the backfill again does not create another part version'
);

-- deny: anon public.items
set local role anon;
select throws_ok($$select id from public.items$$, '42501', null, 'anon cannot read items');
reset role;
-- end deny

-- deny: anon public.item_versions
set local role anon;
select throws_ok($$select id from public.item_versions$$, '42501', null, 'anon cannot read item versions');
reset role;
-- end deny

-- deny: anon public.item_revisions
set local role anon;
select throws_ok($$select id from public.item_revisions$$, '42501', null, 'anon cannot read item revisions');
reset role;
-- end deny

-- deny: anon public.assembly_bom_lines
set local role anon;
select throws_ok($$select id from public.assembly_bom_lines$$, '42501', null, 'anon cannot read BOM lines');
reset role;
-- end deny

-- deny: anon public.item_shares
set local role anon;
select throws_ok($$select id from public.item_shares$$, '42501', null, 'anon cannot read item shares');
reset role;
-- end deny

-- deny: other_user public.items
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select is_empty($$select id from public.items$$, 'another organization sees no items');
reset role;
-- end deny

-- deny: other_user public.item_versions
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select is_empty($$select id from public.item_versions$$, 'another organization sees no versions');
reset role;
-- end deny

-- deny: other_user public.item_revisions
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select is_empty($$select id from public.item_revisions$$, 'another organization sees no revisions');
reset role;
-- end deny

-- deny: other_user public.assembly_bom_lines
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select is_empty($$select id from public.assembly_bom_lines$$, 'another organization sees no BOM lines');
reset role;
-- end deny

-- deny: other_user public.item_shares
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select is_empty($$select id from public.item_shares$$, 'another organization sees no shares');
reset role;
-- end deny

-- deny: role_boundary public.items
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
select throws_ok(
  $$select public.pdm_record_upload(
    'a4a40000-0000-4000-8000-000000000010',
    'a4a40000-0000-4000-8000-000000000030',
    'a4a40000-0000-4000-8000-000000000020',
    'part', null, 'reader-upload.sldprt', 'Reader', null, null,
    'a4a40000-0000-4000-8000-000000000003')$$,
  'P0001',
  'pdm_item_write_denied',
  'a same-org member who is not an editor cannot upload a version'
);
reset role;
-- end deny

-- deny: role_boundary public.item_versions
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
select is(
  (select count(*)::integer from public.item_versions where state = 'released' and organization_id <> 'a4a40000-0000-4000-8000-000000000010'),
  0,
  'an authenticated member sees no released versions from another organization'
);
reset role;
-- end deny

-- deny: role_boundary public.item_revisions
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
select is(
  (select count(*)::integer from public.item_revisions where organization_id <> 'a4a40000-0000-4000-8000-000000000010'),
  0,
  'an authenticated member sees no revisions from another organization'
);
reset role;
-- end deny

-- deny: role_boundary public.assembly_bom_lines
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
select is(
  (select count(*)::integer from public.assembly_bom_lines where organization_id <> 'a4a40000-0000-4000-8000-000000000010'),
  0,
  'an authenticated member sees no BOM lines from another organization'
);
reset role;
-- end deny

-- deny: role_boundary public.item_shares
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
select is(
  (select count(*)::integer from public.item_shares where organization_id <> 'a4a40000-0000-4000-8000-000000000010'),
  0,
  'an authenticated member sees no shares from another organization'
);
reset role;
-- end deny

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
select ok(
  (select count(*) > 0 from public.items),
  'the job editor can read the organization items'
);
select lives_ok(
  $$select public.pdm_record_upload(
    'a4a40000-0000-4000-8000-000000000010',
    'a4a40000-0000-4000-8000-000000000030',
    'a4a40000-0000-4000-8000-000000000020',
    'part', null, 'editor-upload.sldprt', 'Editor upload', null, null,
    'a4a40000-0000-4000-8000-000000000001')$$,
  'the job editor can record a new upload'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
select ok(
  (select count(*) > 0 from public.items),
  'another member of the same organization can read items'
);
reset role;
grant update (free_quote_unlimited) on public.quote_requests to authenticated;
create policy pdm_test_quote_update
on public.quote_requests
for update
to authenticated
using (true)
with check (true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a4a40000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true);
select throws_ok(
  $$update public.quote_requests set free_quote_unlimited = true where id = 'a4a40000-0000-4000-8000-000000000060'$$,
  'P0001',
  'pdm_free_quote_unlimited_locked',
  'an authenticated member cannot mark a quote unlimited'
);
reset role;

select * from finish();
rollback;
