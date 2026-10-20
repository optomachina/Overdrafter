-- OVD-771 service kill switch rollback. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-771.rollback.sql
--
-- Removes the service_role kill switch RPCs. Effect: the CLI emergency brake
-- (scripts/provider-kill.mjs) stops working until the draft is re-applied;
-- the admin UI (MFA-gated) still works. Run only with Blaine's yes.
--
-- Audit rows are evidence. The audit table is append-only, so rows written by
-- the service path (actor 'cli:service_role') cannot be removed, and their
-- actor cannot be cast back to uuid. When any exist, `actor` stays text and the
-- `operator` column and check constraint are KEPT; only the functions are
-- dropped (the admin RPCs keep working against the text column). When none
-- exist, the audit table is restored to its exact OVD-722 shape. Switch state
-- (engaged or not) is never changed by this rollback.
-- Re-running is a no-op (guarded on actor's column type, OVD-949).

set local lock_timeout = '5s';

drop function if exists public.api_service_list_provider_kill_switches();
drop function if exists public.api_service_set_global_kill_switch(boolean, text, text, bigint);
drop function if exists public.api_service_set_provider_kill_switch(public.vendor_name, boolean, text, text, bigint);

do $restore$
declare v_actor_type text;
begin
  lock table private.provider_kill_switch_audit in share row exclusive mode;
  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_actor_type
  from pg_catalog.pg_attribute a
  where a.attrelid = 'private.provider_kill_switch_audit'::regclass
    and a.attname = 'actor' and not a.attisdropped;
  if v_actor_type is null then
    raise exception 'OVD-771 rollback: private.provider_kill_switch_audit.actor not found';
  end if;
  if v_actor_type <> 'uuid' then
    if exists (select 1 from private.provider_kill_switch_audit where actor = 'cli:service_role') then
      raise notice 'OVD-771 rollback: cli:service_role audit rows exist; keeping actor as text and the operator column as evidence';
      return;
    end if;
    alter table private.provider_kill_switch_audit
      drop constraint if exists provider_kill_switch_audit_actor_operator_check;
    alter table private.provider_kill_switch_audit
      alter column actor type uuid using actor::uuid;
  end if;
  alter table private.provider_kill_switch_audit
    drop constraint if exists provider_kill_switch_audit_actor_operator_check;
  alter table private.provider_kill_switch_audit
    drop column if exists operator;
end;
$restore$;
