-- OVD-1012: stop trusting drawing tolerances stored before the unit-aware extractor (OVD-976).
-- ovd: idempotent
-- Data only: no function, table, grant or policy change. Sorts after 20261101130300.
-- Apply only in an approved window. Rollback draft: docs/migration-drafts/ovd-1012.rollback.sql.
--
-- Before OVD-976 the worker stored the smallest number after a plus-minus sign as inches
-- whatever the drawing units, so a metric +/-0.1 mm drawing holds tolerances.valueInch = 0.1.
-- That reads as a loose 0.1 in: it passes the Xometry beta's standard-tolerance gate
-- (>= 0.005 in), lets auto approval add SendCutSend, and is copied into the approved
-- requirement. Those payloads have no tolerances.unit key; every payload the worker has stored
-- since OVD-976 has one. This migration:
--
-- 1. approved_part_requirements, for parts whose extraction is unit-blind:
--    - clears tightest_tolerance_inch and spec_snapshot.tightestToleranceInch where the stored
--      value is the number copied from that extraction and the customer has no tolerance
--      override;
--    - clears spec_snapshot.projectPartProperties.defaults.tightestToleranceInch where it is
--      that number, so resetting an override cannot bring it back.
--    A customer override, any other value and applicable_vendors are left unchanged. The
--    previous values are kept in spec_snapshot.ovd1012LegacyTolerance.
-- 2. drawing_extractions: sets tolerances.valueInch to null and tolerances.unit to 'unknown',
--    keeps the raw text, marks reviewNeeded with reason 'legacy_unit_blind_tolerance' and keeps
--    the previous tolerances object in tolerances.ovd1012LegacyTolerances.
--
-- Afterwards auto approval, the editor defaults and the client all read an unresolved
-- tolerance, so the customer must enter it before a Xometry beta request (fail closed).
-- updated_at on both tables is preserved (their touch triggers are disabled inside this one
-- statement only) so auto approval's extraction-newer refresh and the client's staleness checks
-- see no change. Idempotent: a marked payload has a unit key, so a second run matches nothing.
set local lock_timeout = '5s';

do $ovd1012_legacy_tolerance$
declare
  v_row record;
  v_spec jsonb;
  v_clear_column boolean;
  v_clear_defaults boolean;
  v_requirements integer := 0;
  v_extractions integer := 0;
begin
  -- Canonical lock order (docs/ovd979-lock-order.md): approved_part_requirements, then
  -- drawing_extractions. Disabling a trigger holds each table against writers until commit.
  alter table public.approved_part_requirements disable trigger touch_approved_part_requirements_updated_at;
  alter table public.drawing_extractions disable trigger touch_drawing_extractions_updated_at;

  for v_row in
    select requirement.id,
           requirement.tightest_tolerance_inch,
           requirement.spec_snapshot,
           extraction.id as extraction_id,
           case
             when jsonb_typeof(extraction.extraction #> '{tolerances,valueInch}') = 'number'
               or (extraction.extraction #>> '{tolerances,valueInch}') ~ '^\s*[0-9]*\.?[0-9]+\s*$'
               then round(btrim(extraction.extraction #>> '{tolerances,valueInch}')::numeric, 4)
           end as legacy_value_inch
    from public.approved_part_requirements requirement
    join public.drawing_extractions extraction on extraction.part_id = requirement.part_id
    where jsonb_typeof(extraction.extraction -> 'tolerances') = 'object'
      and not ((extraction.extraction -> 'tolerances') ? 'unit')
      and case jsonb_typeof(extraction.extraction #> '{tolerances,valueInch}')
            when 'number' then true
            when 'string' then btrim(extraction.extraction #>> '{tolerances,valueInch}') <> ''
            else false
          end
      and not (requirement.spec_snapshot ? 'ovd1012LegacyTolerance')
    order by requirement.id
    for update of requirement
  loop
    continue when v_row.legacy_value_inch is null;

    v_spec := v_row.spec_snapshot;
    v_clear_column := coalesce(v_row.tightest_tolerance_inch = v_row.legacy_value_inch, false)
      and not coalesce((v_spec #> '{projectPartProperties,overrides}') ? 'tightestToleranceInch', false);
    v_clear_defaults := case
      when jsonb_typeof(v_spec #> '{projectPartProperties,defaults,tightestToleranceInch}') = 'number'
        then round((v_spec #>> '{projectPartProperties,defaults,tightestToleranceInch}')::numeric, 4)
          = v_row.legacy_value_inch
      else false
    end;

    continue when not v_clear_column and not v_clear_defaults;

    v_spec := v_spec || jsonb_build_object('ovd1012LegacyTolerance', jsonb_build_object(
      'extractionId', v_row.extraction_id,
      'legacyValueInch', v_row.legacy_value_inch,
      'tightestToleranceInch', case when v_clear_column then v_row.tightest_tolerance_inch end,
      'snapshotTightestToleranceInch',
        case when v_clear_column then v_row.spec_snapshot -> 'tightestToleranceInch' end,
      'defaultsTightestToleranceInch',
        case when v_clear_defaults then v_row.spec_snapshot #> '{projectPartProperties,defaults,tightestToleranceInch}' end
    ));
    if v_clear_column and jsonb_typeof(v_spec -> 'tightestToleranceInch') is not null then
      v_spec := jsonb_set(v_spec, '{tightestToleranceInch}', 'null'::jsonb);
    end if;
    if v_clear_defaults then
      v_spec := jsonb_set(v_spec, '{projectPartProperties,defaults,tightestToleranceInch}', 'null'::jsonb);
    end if;

    update public.approved_part_requirements
    set tightest_tolerance_inch = case when v_clear_column then null else tightest_tolerance_inch end,
        spec_snapshot = v_spec
    where id = v_row.id;
    v_requirements := v_requirements + 1;
  end loop;

  update public.drawing_extractions extraction
  set extraction = jsonb_set(
    extraction.extraction,
    '{tolerances}',
    (extraction.extraction -> 'tolerances') || jsonb_build_object(
      'valueInch', null,
      'unit', 'unknown',
      'reviewNeeded', true,
      'reasons', case
          when jsonb_typeof(extraction.extraction #> '{tolerances,reasons}') = 'array'
            then extraction.extraction #> '{tolerances,reasons}'
          else '[]'::jsonb
        end || to_jsonb('legacy_unit_blind_tolerance'::text),
      'ovd1012LegacyTolerances', extraction.extraction -> 'tolerances'
    )
  )
  where jsonb_typeof(extraction.extraction -> 'tolerances') = 'object'
    and not ((extraction.extraction -> 'tolerances') ? 'unit')
    and case jsonb_typeof(extraction.extraction #> '{tolerances,valueInch}')
          when 'number' then true
          when 'string' then btrim(extraction.extraction #>> '{tolerances,valueInch}') <> ''
          else false
        end;
  get diagnostics v_extractions = row_count;

  alter table public.drawing_extractions enable trigger touch_drawing_extractions_updated_at;
  alter table public.approved_part_requirements enable trigger touch_approved_part_requirements_updated_at;

  raise notice 'OVD-1012: % approved requirement(s) and % extraction(s) no longer trust a unit-blind tolerance.',
    v_requirements, v_extractions;
end;
$ovd1012_legacy_tolerance$;
