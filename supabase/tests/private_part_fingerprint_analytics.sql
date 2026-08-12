begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data
) values (
  '83000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'analytics@example.test',
  timezone('utc', now()), '{"provider":"email"}'::jsonb
);

insert into public.organizations (id, name, slug)
values
  ('83000000-0000-4000-8000-000000000002', 'Analytics A', 'analytics-a'),
  ('83000000-0000-4000-8000-000000000003', 'Analytics B', 'analytics-b');

insert into public.canonical_parts (id, organization_id, display_name)
values
  ('83000000-0000-4000-8000-000000000004', '83000000-0000-4000-8000-000000000002', 'A'),
  ('83000000-0000-4000-8000-000000000005', '83000000-0000-4000-8000-000000000003', 'B');

insert into public.part_versions (
  id, canonical_part_id, organization_id, version_state,
  package_fingerprint, cad_content_sha256
) values
  (
    '83000000-0000-4000-8000-000000000006',
    '83000000-0000-4000-8000-000000000004',
    '83000000-0000-4000-8000-000000000002', 'complete',
    repeat('a', 64), repeat('b', 64)
  ),
  (
    '83000000-0000-4000-8000-000000000007',
    '83000000-0000-4000-8000-000000000005',
    '83000000-0000-4000-8000-000000000003', 'complete',
    repeat('a', 64), repeat('b', 64)
  );

select is(
  (
    select count(*)::integer
    from private.part_fingerprint_observations
    where fingerprint_version = 'exact-part-package.v1'
      and package_fingerprint = repeat('a', 64)
  ),
  2,
  'private analytics can count an exact match across organizations'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated', 'private.part_fingerprint_observations', 'SELECT'
  ),
  'authenticated callers cannot inspect exact fingerprint observations'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated', 'private.part_geometry_fingerprints', 'SELECT'
  ),
  'authenticated callers cannot inspect geometry fingerprints'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated', 'private.part_geometry_candidates', 'SELECT'
  ),
  'authenticated callers cannot inspect geometry candidates'
);

select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_register_part_geometry_candidate(uuid,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated callers cannot register geometry candidates'
);

insert into public.jobs (id, organization_id, created_by, title)
values
  (
    '83000000-0000-4000-8000-000000000008',
    '83000000-0000-4000-8000-000000000002',
    '83000000-0000-4000-8000-000000000001', 'A'
  ),
  (
    '83000000-0000-4000-8000-000000000009',
    '83000000-0000-4000-8000-000000000003',
    '83000000-0000-4000-8000-000000000001', 'B'
  );

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, part_version_id
) values
  (
    '83000000-0000-4000-8000-000000000010',
    '83000000-0000-4000-8000-000000000008',
    '83000000-0000-4000-8000-000000000002', 'A', 'a',
    '83000000-0000-4000-8000-000000000006'
  ),
  (
    '83000000-0000-4000-8000-000000000011',
    '83000000-0000-4000-8000-000000000009',
    '83000000-0000-4000-8000-000000000003', 'B', 'b',
    '83000000-0000-4000-8000-000000000007'
  );

select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  public.api_register_part_geometry_candidate(
    '83000000-0000-4000-8000-000000000010', repeat('c', 64),
    'geometry-test.v1', '{"units":"mm"}'::jsonb
  ),
  0,
  'the first geometry observation creates no candidate'
);

select is(
  public.api_register_part_geometry_candidate(
    '83000000-0000-4000-8000-000000000011', repeat('c', 64),
    'geometry-test.v1', '{"units":"mm"}'::jsonb
  ),
  1,
  'the matching geometry observation creates one private candidate'
);

select is(
  (
    select status
    from private.part_geometry_candidates
    where algorithm_version = 'geometry-test.v1'
  ),
  'candidate',
  'geometry equivalence remains an unconfirmed candidate'
);

select is(
  (
    select count(*)::integer
    from public.part_versions
    where id in (
      '83000000-0000-4000-8000-000000000006',
      '83000000-0000-4000-8000-000000000007'
    )
  ),
  2,
  'geometry analytics never merge canonical versions'
);

select is(
  public.api_register_part_geometry_candidate(
    '83000000-0000-4000-8000-000000000011', repeat('c', 64),
    'geometry-test.v1', '{"units":"mm"}'::jsonb
  ),
  0,
  're-registering the same observation creates no duplicate candidate'
);

select is(
  (
    select count(*)::integer
    from private.part_geometry_candidates
    where algorithm_version = 'geometry-test.v1'
  ),
  1,
  'repeated observations remain idempotent'
);

select is(
  public.api_register_part_geometry_candidate(
    '83000000-0000-4000-8000-000000000011', repeat('d', 64),
    'geometry-test.v1', '{"units":"in"}'::jsonb
  ),
  0,
  'changing a geometry observation removes candidates from the prior fingerprint'
);

select is(
  (
    select count(*)::integer
    from private.part_geometry_candidates
    where algorithm_version = 'geometry-test.v1'
  ),
  0,
  'superseded geometry candidates are not retained'
);

select * from finish();

rollback;
