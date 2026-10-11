-- OVD-684: READ-ONLY count of approved_part_requirements rows whose `finish`
-- (a text column) holds a JSON object, i.e. the raw extraction payload
-- {raw, reasons, confidence, normalized, reviewNeeded} written before OVD-681.
-- Run this first and review the numbers before applying the OVD-684 migration.
-- Contains no DML/DDL.
select
  count(*) as object_rows,
  count(*) filter (where jsonb_typeof(j -> 'normalized') = 'string'
                     and btrim(j ->> 'normalized') <> '') as will_use_normalized,
  count(*) filter (where not (jsonb_typeof(j -> 'normalized') = 'string'
                                and btrim(j ->> 'normalized') <> '')
                     and jsonb_typeof(j -> 'raw') = 'string'
                     and btrim(j ->> 'raw') <> '') as will_use_raw,
  count(*) filter (where not (jsonb_typeof(j -> 'normalized') = 'string'
                                and btrim(j ->> 'normalized') <> '')
                     and not (jsonb_typeof(j -> 'raw') = 'string'
                                and btrim(j ->> 'raw') <> '')) as will_become_null
from (
  select case when pg_input_is_valid(finish, 'jsonb') then finish::jsonb end as j
  from public.approved_part_requirements
  where finish is not null
) s
where jsonb_typeof(j) = 'object';
