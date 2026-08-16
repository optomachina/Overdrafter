-- OVD-373 post-repair/pre-push migration-ledger verification.
-- This script is read-only and inspects no customer or provider data.

begin read only;

do $ovd373$
declare
  v_count bigint;
  v_head text;
  v_fingerprint text;
  v_difference_count bigint;
begin
  select count(*), max(version::text)
  into v_count, v_head
  from supabase_migrations.schema_migrations;

  if v_count <> 79 or v_head <> '20260813005020' then
    raise exception
      'OVD-373 repaired ledger mismatch: expected 79 rows through 20260813005020, found % through %',
      v_count,
      coalesce(v_head, '<none>');
  end if;

  with expected(version) as (
    values
      ('20260402100000'),
      ('20260403103000'),
      ('20260406000000'),
      ('20260408193000'),
      ('20260731015400')
  ), actual(version) as (
    select version::text
    from supabase_migrations.schema_migrations
    where version::text = any (array[
      '20260402100000',
      '20260403103000',
      '20260406000000',
      '20260408193000',
      '20260731015400'
    ])
  )
  select count(*)
  into v_difference_count
  from (
    (select * from expected except select * from actual)
    union all
    (select * from actual except select * from expected)
  ) drift;

  if v_difference_count <> 0 then
    raise exception
      'OVD-373 repaired ledger version set drifted (% differences)',
      v_difference_count;
  end if;

  select pg_catalog.md5(
    pg_catalog.string_agg(
      version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
      E'\n'
      order by version::text
    )
  )
  into v_fingerprint
  from supabase_migrations.schema_migrations;

  if v_fingerprint <> '92d2ff85964bc3a325b7a65cfe7d66d7' then
    raise exception
      'OVD-373 repaired ledger fingerprint drifted: %',
      coalesce(v_fingerprint, '<none>');
  end if;
end;
$ovd373$;

select 'OVD-373 repaired-ledger verification passed.' as result;

commit;
