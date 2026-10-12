-- OVD-722 rollback, runnable form. Window 1 packet, not a migration.
--
-- Source: the commented ROLLBACK section of docs/migration-drafts/ovd-722.sql
-- at f3ce78b3fe70c49ad7738e3b4930e9addd7dada4, from "-- begin;" through "-- commit;" with the leading "-- "
-- removed and nothing else changed. scripts/window-1/rehearse.mjs refuses to
-- run if the body below the marker drifts from that section.
--
-- Order: roll back strictly in reverse order of apply (recommended order is
-- 462, 723, 722, so this runs first). It drops the public dispatch RPC names and
-- restores whatever is preserved under private.*_pre_ovd722; run while OVD-723
-- wraps those names (722 applied first), it would delete the export gate silently.
-- Roll the worker back to a build without OVD-722 first (the worker fails
-- closed while api_worker_provider_kill_switch_state is missing).
-- The last block drops private.provider_kill_switch_audit. Export it first, or
-- delete that block to keep the audit trail.
--
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f docs/release/window-1/rollback/ovd-722.rollback.sql
-- ---- body (derived, do not edit) ----
begin;

drop function public.api_request_xometry_beta_dispatch(uuid, text, text, text, uuid, boolean, boolean, boolean);
alter function private.api_request_xometry_beta_dispatch_pre_ovd722(uuid, text, text, text, uuid, boolean, boolean, boolean)
  set schema public;
alter function public.api_request_xometry_beta_dispatch_pre_ovd722(uuid, text, text, text, uuid, boolean, boolean, boolean)
  rename to api_request_xometry_beta_dispatch;
revoke all on function public.api_request_xometry_beta_dispatch(uuid, text, text, text, uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_xometry_beta_dispatch(uuid, text, text, text, uuid, boolean, boolean, boolean)
  to authenticated;

drop function public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean);
alter function private.api_request_provider_dispatch_pre_ovd722(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  set schema public;
alter function public.api_request_provider_dispatch_pre_ovd722(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  rename to api_request_provider_dispatch;
revoke all on function public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  to authenticated;

drop function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
alter function private.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  set schema public;
alter function public.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_xometry_beta_worker_dispatch;
revoke all on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

drop function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
alter function private.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  set schema public;
alter function public.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_provider_worker_dispatch;
revoke all on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

drop function public.api_worker_cancel_provider_disabled_tasks();
drop function public.api_admin_list_provider_kill_switches();
drop function public.api_admin_set_global_kill_switch(boolean, text, bigint);
drop function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint);
drop function public.api_worker_provider_kill_switch_state(public.vendor_name);
drop function private.provider_kill_switch_engaged_text(text);
drop function private.provider_kill_switch_engaged(public.vendor_name);
drop table private.provider_global_kill_switch;
drop table private.provider_kill_switches;
-- Evidence: export first, or omit the next three statements to keep the audit trail.
drop trigger provider_kill_switch_audit_no_truncate on private.provider_kill_switch_audit;
drop trigger provider_kill_switch_audit_no_update_delete on private.provider_kill_switch_audit;
drop table private.provider_kill_switch_audit;
drop function private.provider_kill_switch_audit_immutable();

commit;
