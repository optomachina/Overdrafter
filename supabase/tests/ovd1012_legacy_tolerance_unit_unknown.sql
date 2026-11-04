-- OVD-1012: tolerances stored before the unit-aware extractor (OVD-976) are no longer trusted.
-- Synthetic legacy-shaped fixtures only; the migration and rollback drills all roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(40);

\set user 10120000-0000-4000-8000-000000000001
\set org 10120000-0000-4000-8000-000000000010
\set job 10120000-0000-4000-8000-000000000020
\set auto_job 10120000-0000-4000-8000-000000000021
\set metric 10120000-0000-4000-8000-000000000031
\set override 10120000-0000-4000-8000-000000000032
\set other 10120000-0000-4000-8000-000000000033
\set current 10120000-0000-4000-8000-000000000034
\set nullvalue 10120000-0000-4000-8000-000000000035
\set unapproved 10120000-0000-4000-8000-000000000036
\set entered 10120000-0000-4000-8000-000000000037
\set stamp '2026-10-01 00:00:00+00'
\set legacy '{"tolerances":{"general":"±0.2","tightest":"±0.1","valueInch":0.1,"confidence":0.68}}'

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (:'user', 'authenticated', 'authenticated', 'ovd1012@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id, name, slug) values (:'org', 'OVD-1012 fixture', 'ovd1012-fixture');
insert into public.organization_memberships (organization_id, user_id, role) values (:'org', :'user', 'client');
insert into public.jobs (id, organization_id, created_by, title, status)
values (:'job', :'org', :'user', 'Legacy tolerances', 'ready_to_quote'),
  (:'auto_job', :'org', :'user', 'Legacy tolerance auto approval', 'extracting');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values (:'metric', :'job', :'org', 'Metric legacy', 'ovd1012-metric'),
  (:'override', :'job', :'org', 'Customer override', 'ovd1012-override'),
  (:'other', :'job', :'org', 'Other value', 'ovd1012-other'),
  (:'current', :'job', :'org', 'Unit-aware', 'ovd1012-current'),
  (:'nullvalue', :'job', :'org', 'No value', 'ovd1012-nullvalue'),
  (:'entered', :'job', :'org', 'Entered later', 'ovd1012-entered'),
  (:'unapproved', :'auto_job', :'org', 'Not yet approved', 'ovd1012-unapproved');

insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, updated_at)
values (:'metric', :'org', 'worker-pdf-v3', :'legacy'::jsonb, :'stamp'),
  (:'override', :'org', 'worker-pdf-v3', :'legacy'::jsonb, :'stamp'),
  (:'other', :'org', 'worker-pdf-v3', :'legacy'::jsonb, :'stamp'),
  (:'current', :'org', 'worker-pdf-v3',
    '{"tolerances":{"tightest":"±0.005","valueInch":0.005,"unit":"in","drawingUnits":"inch","confidence":0.68}}', :'stamp'),
  (:'nullvalue', :'org', 'worker-pdf-v3', '{"tolerances":{"tightest":"TYP","valueInch":null}}', :'stamp'),
  (:'entered', :'org', 'worker-pdf-v3', :'legacy'::jsonb, :'stamp'),
  (:'unapproved', :'org', 'worker-pdf-v3',
    '{"description":"Legacy part","material":{"normalized":"6061"},"tolerances":{"tightest":"±0.05","valueInch":0.05,"confidence":0.68}}', :'stamp');

insert into public.approved_part_requirements
  (part_id, organization_id, approved_by, material, quantity, quote_quantities,
   tightest_tolerance_inch, applicable_vendors, spec_snapshot, updated_at)
values
  (:'metric', :'org', :'user', '6061', 1, array[1], 0.1,
    array['xometry','fictiv','protolabs','sendcutsend']::public.vendor_name[],
    '{"tightestToleranceInch":0.1,"projectPartProperties":{"defaults":{"material":"6061","tightestToleranceInch":0.1},"overrides":{}}}', :'stamp'),
  (:'override', :'org', :'user', '6061', 1, array[1], 0.004, array['xometry']::public.vendor_name[],
    '{"tightestToleranceInch":0.004,"projectPartProperties":{"defaults":{"tightestToleranceInch":0.1},"overrides":{"tightestToleranceInch":0.004}}}', :'stamp'),
  (:'other', :'org', :'user', '6061', 1, array[1], 0.002, array['xometry']::public.vendor_name[],
    '{"tightestToleranceInch":0.002}', :'stamp'),
  (:'current', :'org', :'user', '6061', 1, array[1], 0.005, array['xometry']::public.vendor_name[],
    '{"tightestToleranceInch":0.005,"projectPartProperties":{"defaults":{"tightestToleranceInch":0.005},"overrides":{}}}', :'stamp'),
  (:'nullvalue', :'org', :'user', '6061', 1, array[1], null, array['xometry']::public.vendor_name[], '{}', :'stamp'),
  (:'entered', :'org', :'user', '6061', 1, array[1], 0.1, array['xometry']::public.vendor_name[],
    '{"tightestToleranceInch":0.1}', :'stamp');

create temp table ovd1012_before as
select 'extraction' as kind, part_id, extraction as body, updated_at from public.drawing_extractions
where organization_id = :'org'
union all
select 'requirement', part_id, to_jsonb(requirement) - 'updated_at', updated_at
from public.approved_part_requirements requirement where organization_id = :'org';

-- The bug, before the migration: auto approval copies the unit-blind number as inches.
savepoint ovd1012_before_fix;
select public.api_auto_approve_job_requirements(:'auto_job');
select is((select tightest_tolerance_inch from public.approved_part_requirements where part_id = :'unapproved'),
  0.0500::numeric, 'without the fix a legacy ±0.05 mm value is approved as 0.05 in');
rollback to savepoint ovd1012_before_fix;

\ir fixtures/ovd1012_legacy_tolerance_unit_unknown.inc

-- 1. A metric legacy value copied into the requirement is cleared everywhere it is read.
select is((select tightest_tolerance_inch from public.approved_part_requirements where part_id = :'metric'),
  null::numeric, 'copied legacy tolerance is cleared from the requirement');
select is((select spec_snapshot -> 'tightestToleranceInch' from public.approved_part_requirements where part_id = :'metric'),
  'null'::jsonb, 'snapshot copy is cleared');
select is((select spec_snapshot #> '{projectPartProperties,defaults,tightestToleranceInch}' from public.approved_part_requirements where part_id = :'metric'),
  'null'::jsonb, 'editor default is cleared');
select is((select spec_snapshot #>> '{projectPartProperties,defaults,material}' from public.approved_part_requirements where part_id = :'metric'),
  '6061', 'other editor defaults are kept');
select is((select spec_snapshot -> 'ovd1012LegacyTolerance' from public.approved_part_requirements where part_id = :'metric'),
  jsonb_build_object('extractionId', (select id from public.drawing_extractions where part_id = :'metric'),
    'legacyValueInch', 0.1000, 'tightestToleranceInch', 0.1000,
    'snapshotTightestToleranceInch', 0.1, 'defaultsTightestToleranceInch', 0.1),
  'previous values are kept for the rollback');
select is((select applicable_vendors from public.approved_part_requirements where part_id = :'metric'),
  array['xometry','fictiv','protolabs','sendcutsend']::public.vendor_name[], 'applicable vendors are unchanged');
select is((select resolved.tightest_tolerance_inch from public.approved_part_requirements requirement,
    public.resolve_project_part_property_values(requirement.spec_snapshot #> '{projectPartProperties,overrides}',
      requirement.spec_snapshot #> '{projectPartProperties,defaults}') resolved
  where requirement.part_id = :'metric'), null::numeric, 'resolved editor value is unresolved');

select is((select tightest_tolerance_inch from public.approved_part_requirements where part_id = :'entered'),
  null::numeric, 'a copied legacy value without editor state is cleared too');

-- 2. A customer override is kept; only the legacy default behind it is cleared.
select is((select tightest_tolerance_inch from public.approved_part_requirements where part_id = :'override'),
  0.0040::numeric, 'customer override value is kept');
select is((select spec_snapshot #> '{projectPartProperties,overrides,tightestToleranceInch}' from public.approved_part_requirements where part_id = :'override'),
  '0.004'::jsonb, 'customer override key is kept');
select is((select spec_snapshot #> '{projectPartProperties,defaults,tightestToleranceInch}' from public.approved_part_requirements where part_id = :'override'),
  'null'::jsonb, 'resetting the override cannot bring back the legacy default');
select is((select spec_snapshot -> 'ovd1012LegacyTolerance' -> 'tightestToleranceInch' from public.approved_part_requirements where part_id = :'override'),
  'null'::jsonb, 'marker records that the column was not cleared');

-- 3. Values that are not the legacy copy, and unit-aware or empty extractions, are untouched.
select is((select to_jsonb(requirement) - 'updated_at' from public.approved_part_requirements requirement where part_id = :'other'),
  (select body from ovd1012_before where kind = 'requirement' and part_id = :'other'), 'a different requirement value is untouched');
select is((select to_jsonb(requirement) - 'updated_at' from public.approved_part_requirements requirement where part_id = :'current'),
  (select body from ovd1012_before where kind = 'requirement' and part_id = :'current'), 'a unit-aware requirement is untouched');
select is((select extraction from public.drawing_extractions where part_id = :'current'),
  (select body from ovd1012_before where kind = 'extraction' and part_id = :'current'), 'a unit-aware extraction is untouched');
select is((select extraction from public.drawing_extractions where part_id = :'nullvalue'),
  (select body from ovd1012_before where kind = 'extraction' and part_id = :'nullvalue'), 'a legacy extraction without a value is untouched');

-- 4. Legacy extractions read as unresolved, with the raw text and the old number kept.
select is((select extraction #> '{tolerances,valueInch}' from public.drawing_extractions where part_id = :'metric'),
  'null'::jsonb, 'legacy valueInch is no longer read as inches');
select is((select nullif(extraction #>> '{tolerances,valueInch}', '')::numeric from public.drawing_extractions where part_id = :'metric'),
  null::numeric, 'the SQL readers see no number');
select is((select extraction #>> '{tolerances,unit}' from public.drawing_extractions where part_id = :'metric'),
  'unknown', 'legacy unit is recorded as unknown');
select is((select extraction #>> '{tolerances,tightest}' from public.drawing_extractions where part_id = :'metric'),
  '±0.1', 'raw text is kept');
select is((select extraction #> '{tolerances,reasons}' from public.drawing_extractions where part_id = :'metric'),
  '["legacy_unit_blind_tolerance"]'::jsonb, 'review reason is recorded');
select is((select extraction #> '{tolerances,reviewNeeded}' from public.drawing_extractions where part_id = :'metric'),
  'true'::jsonb, 'tolerance is flagged for review');
select is((select extraction #> '{tolerances,ovd1012LegacyTolerances}' from public.drawing_extractions where part_id = :'metric'),
  (select body -> 'tolerances' from ovd1012_before where kind = 'extraction' and part_id = :'metric'), 'original tolerances are kept');
select is((select count(*)::integer from public.drawing_extractions
  where organization_id = :'org' and extraction #>> '{tolerances,unit}' = 'unknown'), 5, 'every legacy extraction with a value is marked');

-- 5. Timestamps and triggers.
select is((select count(*)::integer from ovd1012_before before
  left join public.drawing_extractions extraction on before.kind = 'extraction' and extraction.part_id = before.part_id
  left join public.approved_part_requirements requirement on before.kind = 'requirement' and requirement.part_id = before.part_id
  where coalesce(extraction.updated_at, requirement.updated_at) <> before.updated_at), 0, 'updated_at is preserved on both tables');
select is((select array_agg(tgenabled::text order by tgname) from pg_trigger
  where tgname in ('touch_approved_part_requirements_updated_at', 'touch_drawing_extractions_updated_at')),
  array['O', 'O'], 'touch triggers are enabled again');

-- 6. Auto approval of a not-yet-approved legacy part no longer approves the number.
select public.api_auto_approve_job_requirements(:'auto_job');
select is((select tightest_tolerance_inch from public.approved_part_requirements where part_id = :'unapproved'),
  null::numeric, 'auto approval leaves the legacy tolerance for the customer');
select is((select spec_snapshot -> 'tightestToleranceInch' from public.approved_part_requirements where part_id = :'unapproved'),
  'null'::jsonb, 'auto approval snapshot carries no tolerance');
select is((select tightest_tolerance_inch from public.approved_part_requirements where part_id = :'metric'),
  null::numeric, 'auto approval elsewhere did not restore it');

-- 7. Idempotent: a second run changes nothing.
create temp table ovd1012_after as
select part_id, extraction as body from public.drawing_extractions where organization_id = :'org'
union all
select part_id, to_jsonb(requirement) from public.approved_part_requirements requirement where organization_id = :'org';
\ir fixtures/ovd1012_legacy_tolerance_unit_unknown.inc
select is((select count(*)::integer from (
  (select part_id, extraction from public.drawing_extractions where organization_id = :'org'
   union all
   select part_id, to_jsonb(requirement) from public.approved_part_requirements requirement where organization_id = :'org')
  except all select part_id, body from ovd1012_after) changed), 0, 'a second run changes no row');

-- 8. Rollback drill restores the legacy values exactly, keeps later entries, then rolls back.
savepoint ovd1012_rollback;
update public.approved_part_requirements set tightest_tolerance_inch = 0.003
where part_id = :'entered';
\ir fixtures/ovd1012_legacy_tolerance_unit_unknown_rollback.inc
select is((select to_jsonb(requirement) - 'updated_at' from public.approved_part_requirements requirement where part_id = :'metric'),
  (select body from ovd1012_before where kind = 'requirement' and part_id = :'metric'), 'rollback restores the cleared requirement exactly');
select is((select to_jsonb(requirement) - 'updated_at' from public.approved_part_requirements requirement where part_id = :'override'),
  (select body from ovd1012_before where kind = 'requirement' and part_id = :'override'), 'rollback restores the cleared default exactly');
select is((select extraction from public.drawing_extractions where part_id = :'metric'),
  (select body from ovd1012_before where kind = 'extraction' and part_id = :'metric'), 'rollback restores the extraction exactly');
select is((select extraction from public.drawing_extractions where part_id = :'unapproved'),
  (select body from ovd1012_before where kind = 'extraction' and part_id = :'unapproved'), 'rollback restores the auto-approved part extraction');
select is((select tightest_tolerance_inch from public.approved_part_requirements where part_id = :'entered'),
  0.0030::numeric, 'rollback keeps a value entered after the migration');
select ok(not (select spec_snapshot ? 'ovd1012LegacyTolerance' from public.approved_part_requirements where part_id = :'entered'),
  'rollback removes the marker from a row it does not restore');
select is((select updated_at from public.drawing_extractions where part_id = :'metric'),
  :'stamp'::timestamptz, 'rollback preserves updated_at');
select is((select array_agg(tgenabled::text order by tgname) from pg_trigger
  where tgname in ('touch_approved_part_requirements_updated_at', 'touch_drawing_extractions_updated_at')),
  array['O', 'O'], 'rollback re-enables the touch triggers');
rollback to savepoint ovd1012_rollback;
select is((select extraction #>> '{tolerances,unit}' from public.drawing_extractions where part_id = :'metric'),
  'unknown', 'rollback drill leaves the migration applied');

select * from finish();
rollback;
