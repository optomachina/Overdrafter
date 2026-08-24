-- OVD-417 local qualification; aggregate ledger evidence only.
begin read only;

do $ovd417$
declare
  v_count bigint;
  v_head text;
  v_fingerprint text;
  v_drift bigint;
begin
  select count(*), max(version::text)
  into v_count, v_head
  from supabase_migrations.schema_migrations;
  if v_count <> 104 or v_head <> '20260822213330' then
    raise exception 'OVD-417 final ledger mismatch: expected 104 migrations through 20260822213330, found % through %', v_count, coalesce(v_head, '<none>');
  end if;

  select count(*), pg_catalog.md5(pg_catalog.string_agg(version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text), E'\n' order by version::text))
  into v_count, v_fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260817054500';
  if v_count <> 100 or v_fingerprint <> '5dabebda8a0fc1a3cf697e00de64418b' then
    raise exception 'OVD-417 frozen 100-row baseline drifted: found % rows with fingerprint %', v_count, coalesce(v_fingerprint, '<none>');
  end if;

  with expected(version) as (values ('20260817133902'), ('20260821223849'), ('20260821223851'), ('20260822213330')),
  actual(version) as (select version::text from supabase_migrations.schema_migrations where version::text > '20260817054500')
  select count(*) into v_drift from ((select * from expected except select * from actual) union all (select * from actual except select * from expected)) as drift;
  if v_drift <> 0 then
    raise exception 'OVD-417 post-baseline migration set drifted (% differences)', v_drift;
  end if;
end
$ovd417$;

commit;
select 'OVD-417 local qualification postconditions passed.' as result;
