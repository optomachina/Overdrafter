-- OVD-1012 rollback draft: restore the unit-blind tolerances the migration set aside.
-- Data only. Restores a row only while it is still in the state the migration left:
-- - an extraction that still carries tolerances.ovd1012LegacyTolerances (a re-extraction
--   replaces the whole payload and is kept);
-- - a requirement column, snapshot copy or editor default that is still null. A value the
--   customer or staff entered since then is kept; the marker is removed either way.
-- updated_at is preserved as in the migration. Restoring brings back the OVD-1012 exposure.
set local lock_timeout = '5s';

do $ovd1012_rollback$
declare
  v_row record;
  v_spec jsonb;
  v_marker jsonb;
  v_restore_column boolean;
begin
  alter table public.approved_part_requirements disable trigger touch_approved_part_requirements_updated_at;
  alter table public.drawing_extractions disable trigger touch_drawing_extractions_updated_at;

  for v_row in
    select requirement.id, requirement.tightest_tolerance_inch, requirement.spec_snapshot
    from public.approved_part_requirements requirement
    where jsonb_typeof(requirement.spec_snapshot -> 'ovd1012LegacyTolerance') = 'object'
    order by requirement.id
    for update
  loop
    v_marker := v_row.spec_snapshot -> 'ovd1012LegacyTolerance';
    v_spec := v_row.spec_snapshot - 'ovd1012LegacyTolerance';
    v_restore_column := v_row.tightest_tolerance_inch is null
      and coalesce(jsonb_typeof(v_marker -> 'tightestToleranceInch') = 'number', false)
      and not coalesce((v_spec #> '{projectPartProperties,overrides}') ? 'tightestToleranceInch', false);

    if v_restore_column
      and jsonb_typeof(v_marker -> 'snapshotTightestToleranceInch') = 'number'
      and coalesce(jsonb_typeof(v_spec -> 'tightestToleranceInch'), 'null') = 'null' then
      v_spec := jsonb_set(v_spec, '{tightestToleranceInch}', v_marker -> 'snapshotTightestToleranceInch');
    end if;
    if jsonb_typeof(v_marker -> 'defaultsTightestToleranceInch') = 'number'
      and jsonb_typeof(v_spec #> '{projectPartProperties,defaults}') = 'object'
      and coalesce(jsonb_typeof(v_spec #> '{projectPartProperties,defaults,tightestToleranceInch}'), 'null') = 'null' then
      v_spec := jsonb_set(v_spec, '{projectPartProperties,defaults,tightestToleranceInch}',
        v_marker -> 'defaultsTightestToleranceInch');
    end if;

    update public.approved_part_requirements
    set tightest_tolerance_inch = case
          when v_restore_column then (v_marker ->> 'tightestToleranceInch')::numeric
          else tightest_tolerance_inch
        end,
        spec_snapshot = v_spec
    where id = v_row.id;
  end loop;

  update public.drawing_extractions extraction
  set extraction = jsonb_set(extraction.extraction, '{tolerances}',
    extraction.extraction #> '{tolerances,ovd1012LegacyTolerances}')
  where jsonb_typeof(extraction.extraction #> '{tolerances,ovd1012LegacyTolerances}') = 'object';

  alter table public.drawing_extractions enable trigger touch_drawing_extractions_updated_at;
  alter table public.approved_part_requirements enable trigger touch_approved_part_requirements_updated_at;
end;
$ovd1012_rollback$;
