-- OVD-462 provider session lease: ROLLBACK for docs/migration-drafts/ovd-462.sql (expand phase).
--
-- NOT APPLIED. Run only inside Blaine's migration window, as a forward migration
-- if the expand phase must be withdrawn.
--
-- Transaction: this file has no begin/commit of its own. It relies on the
-- migration runner wrapping it in one transaction (the Supabase CLI does), so a
-- refused guard leaves every object in place. If run by hand, use
-- `psql --single-transaction -v ON_ERROR_STOP=1 -f ovd-462.rollback.sql`.
--
-- Safety: the expand phase created only new objects, so rollback drops only
-- those objects. Lease history (released / expired / cleared / revoked rows) is
-- ephemeral. Occupant rows are NOT: an 'active' row is a live owner, and a
-- 'blocked' row records a manual-follow-up fence (login_required,
-- challenge_required, corrupt_state, missing_session, operator owner_revoked).
-- Dropping a blocked row would make that binding grantable again after a
-- re-apply with no human follow-up. The guard below therefore refuses to run
-- while any occupant exists. Resolve or export them first, or, after recording
-- the blocked bindings out of band, set the documented operator override in the
-- same transaction:
--
--   set local ovd462.rollback_discard_occupants = 'confirmed';
--
-- Any worker still calling these RPCs gets an error on its next renew, which the
-- lease manager treats as unconfirmed ownership: it stops before its local
-- deadline and never falls back to another session (fail closed). Stop or drain
-- OVD-464 lease consumers before rollback to avoid aborting in-flight tasks.

do $$
begin
  -- Nested so the lock and the occupant query only run when the table exists.
  if pg_catalog.to_regclass('public.provider_session_leases') is not null then
    -- RLS is forced and has no policies, so a role without BYPASSRLS would see
    -- zero occupants and pass the check below.
    if not exists (select 1 from pg_catalog.pg_roles r
                   where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
      raise exception 'OVD-462 rollback refused: the running role must bypass RLS to see occupants'
        using errcode = 'P0001';
    end if;
    -- Block every lease RPC until this transaction ends, so no occupant can be
    -- committed between the check and the drops below.
    lock table public.provider_session_leases, public.provider_session_bindings in access exclusive mode;
    if coalesce(pg_catalog.current_setting('ovd462.rollback_discard_occupants', true), '') <> 'confirmed'
       and exists (select 1 from public.provider_session_leases where state in ('active', 'blocked')) then
      raise exception 'OVD-462 rollback refused: provider_session_leases has active or blocked occupants'
        using errcode = 'P0001',
              hint = 'Resolve or export the occupants, or set local ovd462.rollback_discard_occupants = ''confirmed''.';
    end if;
  end if;
end
$$;

drop function if exists public.clear_provider_session_binding_block(text, text, text, bigint, text, text);
drop function if exists public.revoke_provider_session_binding(text, text, text, text, text, text);
drop function if exists public.report_provider_session_lease_outcome(text, text, text, text, text, uuid, bigint, text);
drop function if exists public.release_provider_session_lease(text, text, text, text, text, uuid, bigint);
drop function if exists public.renew_provider_session_lease(text, text, text, text, text, uuid, bigint);
drop function if exists public.acquire_provider_session_lease(text, text, text, text, text, uuid, integer, integer, integer);
drop function if exists private.provider_session_lease_identity_ok(text, text, text, text);
drop table if exists public.provider_session_leases;
drop table if exists public.provider_session_bindings;
