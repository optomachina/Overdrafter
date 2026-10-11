-- OVD-462 provider session lease: ROLLBACK for docs/migration-drafts/ovd-462.sql (expand phase).
--
-- NOT APPLIED. Run only inside Blaine's migration window, as a forward migration
-- if the expand phase must be withdrawn.
--
-- Safety: the expand phase created only new objects, so rollback drops only
-- those objects. Rows are ephemeral lease state (opaque references, no
-- credentials or customer data); dropping them loses no durable product data.
-- Any worker still calling these RPCs gets an error on its next renew, which the
-- lease manager treats as unconfirmed ownership: it stops before its local
-- deadline and never falls back to another session (fail closed). Stop or drain
-- OVD-464 lease consumers before rollback to avoid aborting in-flight tasks.

drop function if exists public.clear_provider_session_binding_block(text, text, text, bigint);
drop function if exists public.revoke_provider_session_binding(text, text, text, text);
drop function if exists public.report_provider_session_lease_outcome(text, text, text, text, text, uuid, bigint, text);
drop function if exists public.release_provider_session_lease(text, text, text, text, text, uuid, bigint);
drop function if exists public.renew_provider_session_lease(text, text, text, text, text, uuid, bigint);
drop function if exists public.acquire_provider_session_lease(text, text, text, text, text, uuid, integer, integer, integer);
drop function if exists public.provider_session_lease_identity_ok(text, text, text, text);
drop table if exists public.provider_session_leases;
