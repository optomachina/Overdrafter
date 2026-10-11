-- OVD-684: backfill approved_part_requirements.finish rows holding a JSON object
-- (raw extraction payload written before OVD-681). Data-only and idempotent.
-- finish := normalized (if string) else raw (if string) else NULL, object rows only.
-- Review scripts/sql/ovd684-count-object-finish.sql output before applying to prod.
-- Rollback: not reversible in place; the replaced object is not retained. Export
-- the affected rows first if a restore path is needed.
update public.approved_part_requirements apr
set finish = case
      when jsonb_typeof(s.j -> 'normalized') = 'string' then s.j ->> 'normalized'
      when jsonb_typeof(s.j -> 'raw') = 'string' then s.j ->> 'raw'
      else null
    end
from (
  select id, finish::jsonb as j
  from public.approved_part_requirements
  where finish is not null
    and case when pg_input_is_valid(finish, 'jsonb')
             then jsonb_typeof(finish::jsonb) = 'object' else false end
) s
where apr.id = s.id;
