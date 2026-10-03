/** Exact source-only expiry admission. Parent owns Docker, source export, deadline and cleanup. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const target = "20261002041305_enforce_quote_selection_expiry.sql";
const fixture = "supabase/tests/quote_selection_expiry.sql";
const targetHash = "30b0e6c41d1c727df269177bb90292d0117674d7b05bc92cdc4dc2fc84ef3da6";
const fixtureHash = "96f491d6644b0773740ea04d74d1e508453fea0051b8a1747927ceba8dc8b658";
const read = (root, path) => readFileSync(join(root, path), "utf8");
const assert = (value, message) => { if (!value) throw new Error(message); };

export function expiryBaseline({ root, files }) {
  const selected = files.filter((name) => name.slice(0, 14) <= "20260924014552"
    && !name.startsWith("20260910") && !name.startsWith("20260911"));
  const manifest = selected.map((name) => ({ name, sha256: digest(read(root, `supabase/migrations/${name}`)) }));
  assert(selected.length === 112 && digest(JSON.stringify(manifest)) === "793730234388bc9e9ec624f092de5d5194afe3e9d7c304b995ae4fb57b9f72d3", "expiry_baseline_drift");
  assert(digest(read(root, `supabase/migrations/${target}`)) === targetHash, "expiry_target_drift");
  assert(digest(read(root, fixture)) === fixtureHash, "expiry_fixture_drift");
  return selected;
}

function raceSql(setup, kind, order, index) {
  // Alphabetic UUID prefixes avoid accidental Luhn matches when the existing
  // audit guard scans the RPC's prefixed idempotency scope (not a bare UUID).
  const prefix = `ecaaaaa${String.fromCharCode(97 + index)}`;
  const id = (tail) => `'${prefix}-1002-4000-8000-${tail.padStart(12, "0")}'`;
  const job = id("4"), offer = id("12"), org = id("2"), user = id("1"), pack = id("8"), option = id("9");
  const selectCall = kind === "direct"
    ? `public.api_set_job_selected_vendor_quote_offer(${job},${offer})`
    : `public.api_select_quote_option(${pack},${option},'synthetic concurrent selection')`;
  const invalidateCall = `public.api_admin_invalidate_vendor_quote_offer(${offer},'synthetic invalidation race','expiry-race-${index}')`;
  const snapshot = `select jsonb_build_object('job',(select to_jsonb(j) from public.jobs j where id=${job}),
    'selections',(select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]') from public.client_selections s where package_id=${pack}),
    'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_events a where organization_id=${org}),
    'adminAudit',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.commercial_admin_audit_events a where organization_id=${org}))`;
  const send = (action) => `select extensions.dblink_send_query('expiry', $$select public.ovd_expiry_attempt('${action}')$$);`;
  const collect = `insert into outcome select result from extensions.dblink_get_result('expiry') as response(result jsonb);
    select * from extensions.dblink_get_result('expiry') as response(result jsonb);`;
  let exercise;
  if (order === "deadline") {
    exercise = `update public.vendor_quote_offers set valid_until=clock_timestamp()+interval '3 seconds' where id=${offer};
      insert into evidence select pg_temp.expiry_state(), valid_until from public.vendor_quote_offers where id=${offer};
      begin;
      select id from public.jobs where id=${job} for update;
      ${send("select")}
      select pg_temp.expiry_wait();
      do $$begin
        if clock_timestamp() >= (select deadline from evidence) then raise exception 'did_not_observe_wait_before_deadline'; end if;
        while clock_timestamp() <= (select deadline from evidence) loop perform pg_sleep(0.02); end loop;
      end$$;
      commit;
      ${collect}
      do $$begin
        if not exists(select 1 from outcome, evidence where result->>'sqlstate'='P0001'
          and result->>'message'='Quote offer has expired and cannot be selected.'
          and (result->>'startedAt')::timestamptz < deadline
          and (result->>'finishedAt')::timestamptz > deadline
          and before_state=pg_temp.expiry_state()) then raise exception 'deadline_race_result_or_side_effect_mismatch'; end if;
      end$$;`;
  } else if (order === "invalidation-first") {
    exercise = `begin;
      select public.ovd_expiry_attempt('invalidate') as admin_result;
      do $$begin if not exists(select 1 from public.vendor_quote_offers where id=${offer} and invalidated_at is not null) then raise exception 'admin_invalidation_failed'; end if; end$$;
      insert into evidence select pg_temp.expiry_state(), null;
      ${send("select")}
      select pg_temp.expiry_wait();
      commit;
      ${collect}
      do $$begin
        if not exists(select 1 from outcome,evidence where result->>'sqlstate'='P0001'
          and result->>'message' like '%invalidated%'
          and before_state=pg_temp.expiry_state()) then raise exception 'invalidation_first_result_or_side_effect_mismatch'; end if;
      end$$;`;
  } else {
    exercise = `begin;
      insert into outcome select public.ovd_expiry_attempt('select');
      do $$begin if not exists(select 1 from outcome where result->>'ok'='true') then raise exception 'selection_first_failed'; end if; end$$;
      ${send("invalidate")}
      select pg_temp.expiry_wait();
      commit;
      ${collect}
      do $$begin
        if (select count(*) from outcome where result->>'ok'='true')<>2
          or not exists(select 1 from public.vendor_quote_offers where id=${offer} and invalidated_at is not null)
          or not exists(select 1 from public.jobs where id=${job} and selected_vendor_quote_offer_id is null)
          or (select count(*) from public.client_selections where package_id=${pack})<>${kind === "direct" ? 0 : 1}
          or (select count(*) from public.audit_events where package_id=${pack} and event_type='client.quote_option_selected')<>${kind === "direct" ? 0 : 1}
          or (select count(*) from public.commercial_admin_audit_events where organization_id=${org})<>1
        then raise exception 'selection_first_serial_outcome_mismatch: %', jsonb_build_object(
          'outcomes',(select jsonb_agg(result) from outcome),
          'invalidated',(select invalidated_at from public.vendor_quote_offers where id=${offer}),
          'pointer',(select selected_vendor_quote_offer_id from public.jobs where id=${job}),
          'selections',(select count(*) from public.client_selections where package_id=${pack}),
          'audit',(select count(*) from public.audit_events where package_id=${pack} and event_type='client.quote_option_selected'),
          'adminAudit',(select count(*) from public.commercial_admin_audit_events where organization_id=${org})); end if;
      end$$;`;
  }
  return `set search_path=public,extensions; set statement_timeout='15s';
    create extension if not exists dblink with schema extensions;
    begin;
    ${setup.replaceAll("ec410002", prefix).replaceAll("@example.test", `+${index}@example.test`)}
    update public.published_quote_options set source_vendor_quote_offer_id=${offer} where id=${option};
    insert into private.platform_admin_capabilities(user_id,capability,granted_by_user_id,grant_reason)
      values (${user},'billing_admin',${user},'Synthetic expiry concurrency');
    update private.commercial_rollout_controls set enabled=true,revision=revision+1,change_reason='Synthetic expiry concurrency'
      where capability='commercial_admin_mutations';
    commit;
    create or replace function public.ovd_expiry_attempt(action text) returns jsonb language plpgsql as $$
    declare started timestamptz := clock_timestamp();
    begin
      perform set_config('request.jwt.claim.sub',${user},true);
      perform set_config('request.jwt.claims',jsonb_build_object('sub',${user},'role','authenticated','aal','aal2')::text,true);
      set local role authenticated;
      if action='select' then perform ${selectCall}; else perform ${invalidateCall}; end if;
      reset role;
      return jsonb_build_object('ok',true,'startedAt',started,'finishedAt',clock_timestamp());
    exception when others then return jsonb_build_object('ok',false,'sqlstate',sqlstate,'message',sqlerrm,'startedAt',started,'finishedAt',clock_timestamp());
    end$$;
    create function pg_temp.expiry_state() returns jsonb language sql as $$${snapshot}$$;
    create temp table evidence(before_state jsonb,deadline timestamptz);
    create temp table outcome(result jsonb);
    create temp table observed_wait(value jsonb);
    select extensions.dblink_connect('expiry','dbname=postgres user=postgres application_name=quote-expiry-race');
    select extensions.dblink_exec('expiry','set statement_timeout=''12s''');
    create function pg_temp.expiry_wait() returns void language plpgsql as $$
    begin
      for attempt in 1..150 loop
        perform pg_stat_clear_snapshot();
        if exists(select 1 from pg_stat_activity where application_name='quote-expiry-race'
          and wait_event_type='Lock' and pg_backend_pid()=any(pg_blocking_pids(pid))) then
          insert into observed_wait select jsonb_build_object('at',clock_timestamp(),'pid',pid,'blockingPids',pg_blocking_pids(pid),'waitEvent',wait_event)
            from pg_stat_activity where application_name='quote-expiry-race' and wait_event_type='Lock';
          return;
        end if;
        perform pg_sleep(0.02);
      end loop;
      raise exception 'expected_owned_lock_wait_not_observed';
    end$$;
    ${exercise}
    select extensions.dblink_disconnect('expiry');
    do $$begin if exists(select 1 from pg_stat_activity where application_name='quote-expiry-race') then raise exception 'race_session_leaked'; end if; end$$;
    select jsonb_build_object('kind','${kind}','order','${order}','passed',true,
      'wait',(select jsonb_agg(value) from observed_wait),'outcomes',(select jsonb_agg(result) from outcome),
      'deadline',(select deadline from evidence),'final',pg_temp.expiry_state());
    drop function public.ovd_expiry_attempt(text);`;
}

export function rehearseQuoteExpiry({ root, psql, save, sourceRevision, sourceManifestSha256, afterMigration = () => {} }) {
  const report = { sourceRevision, sourceManifestSha256, syntheticOnly: true, migrationSha256: targetHash,
    fixtureSha256: fixtureHash, races: [] };
  const migration = read(root, `supabase/migrations/${target}`);
  psql(migration);
  afterMigration();
  const fixtureSql = read(root, fixture);
  const tap = psql(fixtureSql);
  report.tap = tap;
  save("quote-expiry-proof.json", report);
  assert(/^1\.\.32$/m.test(tap) && (tap.match(/^ok\b/gm)?.length ?? 0) === 32 && !/not ok|Looks like you failed/i.test(tap), "quote_expiry_fixture_failed");
  report.assertions = 32;
  assert(psql("select count(*) from public.organizations where id='ec410002-1002-4000-8000-000000000002';") === "0", "quote_expiry_rollback_failed");
  report.rollbackProved = true;
  const start = fixtureSql.indexOf("insert into auth.users");
  const end = fixtureSql.indexOf("-- Snapshot complete rows as postgres:");
  assert(start > 0 && end > start, "expiry_setup_marker_drift");
  const setup = fixtureSql.slice(start, end);
  const controls = `begin; create extension if not exists pgtap with schema extensions;
    set local search_path=public,extensions; select plan(11);
    ${setup}
    update public.jobs set selected_vendor_quote_offer_id='ec410002-1002-4000-8000-000000000012' where id='ec410002-1002-4000-8000-000000000004';
    select set_config('request.jwt.claim.sub','ec410002-1002-4000-8000-000000000020',true);
    select set_config('request.jwt.claims','{"sub":"ec410002-1002-4000-8000-000000000020","role":"authenticated","aal":"aal1"}',true);
    ${["anon","service_role"].map((role) => `set local role ${role};
      select throws_ok($q$select public.api_set_job_selected_vendor_quote_offer(null,null)$q$,'42501',null,'${role} direct RPC denied');
      select throws_ok($q$select public.api_select_quote_option(null,null,null)$q$,'42501',null,'${role} published RPC denied'); reset role;`).join("\n")}
    set local role service_role;
    select throws_ok($q$insert into public.client_selections(package_id,option_id,organization_id,selected_by) values
      ('ec410002-1002-4000-8000-000000000008','ec410002-1002-4000-8000-000000000009','ec410002-1002-4000-8000-000000000002','ec410002-1002-4000-8000-000000000001')$q$,
      '42501',null,'service direct selection insert denied');
    select throws_ok($q$update public.jobs set selected_vendor_quote_offer_id='ec410002-1002-4000-8000-000000000013' where id='ec410002-1002-4000-8000-000000000004'$q$,
      'P0001','Select quote offers through the guarded selection API.','service pointer assignment denied');
    select throws_ok($q$insert into public.jobs(id,organization_id,created_by,title,status,selected_vendor_quote_offer_id) values
      ('ec410002-1002-4000-8000-000000000021','ec410002-1002-4000-8000-000000000002','ec410002-1002-4000-8000-000000000001','Synthetic bypass','internal_review','ec410002-1002-4000-8000-000000000012')$q$,
      'P0001','Select quote offers through the guarded selection API.','service non-null pointer insertion denied'); reset role;
    set local role authenticated;
    select lives_ok($q$update public.jobs set selected_vendor_quote_offer_id=selected_vendor_quote_offer_id where id='ec410002-1002-4000-8000-000000000004'$q$,'unchanged pointer update allowed');
    select lives_ok($q$update public.jobs set title='Synthetic unrelated edit' where id='ec410002-1002-4000-8000-000000000004'$q$,'unrelated job edit allowed');
    select lives_ok($q$update public.jobs set selected_vendor_quote_offer_id=null where id='ec410002-1002-4000-8000-000000000004'$q$,'null clearing allowed'); reset role;
    select ok(exists(select 1 from public.jobs where id='ec410002-1002-4000-8000-000000000004' and selected_vendor_quote_offer_id is null and title='Synthetic unrelated edit'),'allowed writes actually affected the row');
    select * from finish(); rollback;`;
  const controlsTap = psql(controls);
  save("quote-expiry-controls.json", { sha256: digest(controls), tap: controlsTap });
  assert(/^1\.\.11$/m.test(controlsTap) && (controlsTap.match(/^ok\b/gm)?.length ?? 0) === 11 && !/not ok|Looks like you failed/i.test(controlsTap), "quote_expiry_controls_failed");
  report.controlAssertions = 11;
  let index = 0;
  for (const kind of ["direct", "published"]) {
    for (const order of ["deadline", "invalidation-first", "selection-first"]) {
      const sql = raceSql(setup, kind, order, index++);
      save(`quote-expiry-${kind}-${order}-input.json`, { sha256: digest(sql), sql });
      const transcript = psql(sql, 60_000, "supabase_admin");
      save(`quote-expiry-${kind}-${order}.json`, { transcript });
      report.races.push(JSON.parse(transcript.split("\n").filter((line) => line.startsWith("{")).at(-1)));
      save("quote-expiry-proof.json", report);
    }
  }
}
