-- OVD-373 pre-push rollout verification.
--
-- Read-only by construction: this script inspects only the commercial rollout
-- control registry. It does not read customer, file, job, quote, or provider
-- rows and does not invoke application functions.

begin read only;

do $ovd373$
declare
  v_count bigint;
  v_enabled_count bigint;
  v_expected_count bigint;
begin
  select
    count(*),
    count(*) filter (where enabled),
    count(*) filter (where capability = any (array[
      'automatic_quote_collection',
      'commercial_admin_mutations',
      'order_administration',
      'promotion_codes'
    ]))
  into v_count, v_enabled_count, v_expected_count
  from private.commercial_rollout_controls;

  if v_count <> 4 or v_expected_count <> 4 or v_enabled_count <> 0 then
    raise exception
      'OVD-373 rollout precondition failed: found % expected controls, % enabled',
      v_count,
      v_enabled_count;
  end if;
end;
$ovd373$;

select 'OVD-373 rollout preconditions passed.' as result;

commit;
