-- OVD-684: backfill approved_part_requirements.finish rows holding a JSON object
-- (raw extraction payload written before OVD-681). Data-only and idempotent.
-- finish := normalized (if string) else raw (if string) else NULL, object rows only.
-- Empty or whitespace-only normalized/raw strings count as missing (btrim(x) <> '').
-- Review scripts/sql/ovd684-count-object-finish.sql output before applying to prod.
-- IRREVERSIBLE: the replaced object is not retained. BEFORE applying, back up the
-- affected rows, either with
--   select * into public.ovd684_finish_backup
--   from public.approved_part_requirements
--   where finish is not null and pg_input_is_valid(finish, 'jsonb')
--     and jsonb_typeof(finish::jsonb) = 'object';
-- or by exporting that same SELECT to CSV.
-- Prod apply requires Blaine's explicit approval after the count script has run.
update public.approved_part_requirements apr
set finish = case
      when jsonb_typeof(s.j -> 'normalized') = 'string'
           and btrim(s.j ->> 'normalized') <> '' then s.j ->> 'normalized'
      when jsonb_typeof(s.j -> 'raw') = 'string'
           and btrim(s.j ->> 'raw') <> '' then s.j ->> 'raw'
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
