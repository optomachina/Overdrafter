-- OVD-418 shared production rollout and work-quiescence verification.
--
-- The calling script must already have opened a read-only transaction and set
-- the local `ovd418.audit_phase` parameter to `precondition` or
-- `postcondition`. This include emits no result rows and performs no writes.

do $ovd418_quiescence$
declare
  v_audit_phase text := pg_catalog.current_setting('ovd418.audit_phase');
  v_count bigint;
  v_enabled_count bigint;
  v_expected_count bigint;
begin
  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where enabled),
    pg_catalog.count(*) filter (where capability = any (array[
      'automatic_quote_collection',
      'commercial_admin_mutations',
      'order_administration',
      'promotion_codes'
    ]))
  into v_count, v_enabled_count, v_expected_count
  from private.commercial_rollout_controls;

  if v_count <> 4 or v_expected_count <> 4 or v_enabled_count <> 0 then
    raise exception
      'OVD-418 rollout % failed: % total, % recognized, % enabled',
      v_audit_phase,
      v_count,
      v_expected_count,
      v_enabled_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.work_queue
  where status::text = any (array['queued', 'running']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 work queue is not quiescent: % queued or running tasks (including vendor work)',
      v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.quote_requests
  where status::text = any (array['queued', 'requesting']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 quote requests are not quiescent: % queued or requesting requests',
      v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.quote_runs
  where status::text = any (array['queued', 'running']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 quote runs are not quiescent: % queued or running runs',
      v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.vendor_quote_results
  where status::text = any (array['queued', 'running']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 vendor quote results are not quiescent: % queued or running results',
      v_count;
  end if;
end;
$ovd418_quiescence$;
