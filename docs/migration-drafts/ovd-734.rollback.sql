-- OVD-734 durable permit consumption: ROLLBACK for docs/migration-drafts/ovd-734.sql.
--
-- NOT APPLIED. Run only inside a Blaine-approved migration window, as a forward
-- migration, if the draft must be withdrawn.
--
-- Transaction: this file has no begin/commit of its own. It relies on the
-- migration runner wrapping it in one transaction (the Supabase CLI does), so a
-- refused guard leaves every object in place. If run by hand, use
-- `psql --single-transaction -v ON_ERROR_STOP=1 -f ovd-734.rollback.sql`.
--
-- Order: stop or roll back the OVD-734 worker build FIRST. That worker fails
-- closed without these RPCs, so a rollback under it refuses every generic
-- (non-Xometry) dispatch rather than double-dispatching.
--
-- Safety: the draft created only new objects, so rollback drops only those.
-- Consumption rows are the only record that a permit was used. Dropping them
-- while their permit is still unexpired would let a re-applied draft grant that
-- permit again. The guard below therefore refuses while any consumption row
-- belongs to an unexpired permit. Wait for those permits to expire (generic
-- permits live minutes), or, after recording them out of band, set the operator
-- override in the same transaction:
--
--   set local ovd734.rollback_discard_consumptions = 'confirmed';

do $$
begin
  if pg_catalog.to_regclass('private.provider_dispatch_permit_consumptions') is not null then
    -- RLS is forced and has no policies, so a role without BYPASSRLS would see
    -- zero rows and pass the check below.
    if not exists (select 1 from pg_catalog.pg_roles r
                   where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
      raise exception 'OVD-734 rollback refused: the running role must bypass RLS to see consumptions'
        using errcode = 'P0001';
    end if;
    -- Block every consume and stamp until this transaction ends, so no row can
    -- be committed between the check and the drops below. Consume callers wait
    -- at most their 2s lock_timeout and then fail closed.
    lock table private.provider_dispatch_permit_consumptions in access exclusive mode;
    if coalesce(pg_catalog.current_setting('ovd734.rollback_discard_consumptions', true), '') <> 'confirmed'
       and exists (
         select 1
         from private.provider_dispatch_permit_consumptions consumption
         join private.provider_dispatch_permits permit on permit.id = consumption.permit_id
         where permit.expires_at > pg_catalog.clock_timestamp()
       ) then
      raise exception 'OVD-734 rollback refused: unexpired permits have recorded consumptions'
        using errcode = 'P0001',
              hint = 'Wait for the permits to expire, or set local ovd734.rollback_discard_consumptions = ''confirmed''.';
    end if;
  end if;
end
$$;

drop function if exists public.api_record_provider_dispatch_permit_outcome(uuid, integer, text, text);
drop function if exists public.api_mark_provider_dispatch_permit_side_effect_started(uuid, integer, text);
drop function if exists public.api_consume_provider_dispatch_permit(uuid, uuid, uuid, text, text);
drop function if exists private.provider_dispatch_permit_kill_switch_engaged(public.vendor_name);
drop function if exists private.provider_dispatch_permit_consumption_denial(text);
drop table if exists private.provider_dispatch_permit_consumptions;
drop function if exists private.guard_provider_dispatch_permit_consumption();
