-- OVD-707 (group a) ROLLBACK for docs/migration-drafts/ovd-707-a.sql. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-707-a.rollback.sql
--
-- DRAFT. NOT APPLIED. Run only to undo ovd-707-a.sql after it has been applied
-- in a Blaine-approved window, and only after ovd-707-b-seed.rollback.sql.
--
-- Effect: removes the provider definition tables, their RPCs and helpers.
-- Nothing reads them before PR 2, and the worker keeps resolving providers
-- from provider-registry.v1.json, so dispatch is unaffected. The kill
-- switches (OVD-722/771) are not touched.
--
-- Audit rows are evidence. If any admin-written audit row exists (anything
-- other than the seed's own rows), the rollback refuses unless the operator
-- first exports the audit table and then sets, in the same session:
--   set ovd707.rollback_discard_audit = 'exported';
-- Every statement is drop ... if exists, so re-running is a no-op.

set local lock_timeout = '5s';

do $guard$
begin
  if pg_catalog.to_regclass('private.provider_audit_log') is null then
    return;
  end if;
  lock table private.provider_audit_log in share row exclusive mode;
  if exists (select 1 from private.provider_audit_log where action not in ('seed', 'seed_rollback'))
    and coalesce(pg_catalog.current_setting('ovd707.rollback_discard_audit', true), '') <> 'exported' then
    raise exception 'ovd707_rollback_audit_rows_present'
      using errcode = 'P0001',
            hint = 'Export private.provider_audit_log, then set ovd707.rollback_discard_audit = ''exported''.';
  end if;
end;
$guard$;

drop function if exists public.api_service_list_active_provider_definitions();
drop function if exists public.api_admin_list_provider_definition_history(uuid);
drop function if exists public.api_admin_list_provider_definitions();
drop function if exists public.api_admin_retire_provider_definition(uuid, text);
drop function if exists public.api_admin_reopen_provider_definition(uuid, text);
drop function if exists public.api_admin_suspend_provider_definition(uuid, text);
drop function if exists public.api_admin_activate_provider_definition(uuid, text, boolean);
drop function if exists public.api_admin_record_provider_dry_run(uuid, boolean, text, text, boolean);
drop function if exists public.api_admin_reject_provider_definition(uuid, text);
drop function if exists public.api_admin_approve_provider_definition(uuid, text, boolean);
drop function if exists public.api_admin_submit_provider_definition(uuid, text);
drop function if exists public.api_admin_update_provider_definition_draft(uuid, jsonb, text);
drop function if exists public.api_admin_create_provider_definition(text, jsonb, text);

do $helpers$
begin
  -- These take the table row type, so they go before the tables.
  if pg_catalog.to_regtype('private.provider_definitions') is not null then
    drop function if exists private.move_provider_definition(uuid, uuid, text, private.provider_status[], private.provider_status, text);
    drop function if exists private.provider_approved_contributors(private.provider_definitions);
    drop function if exists private.require_provider_status(private.provider_definitions, private.provider_status[], text);
    drop function if exists private.lock_provider_definition(uuid);
    drop function if exists private.provider_definition_state(private.provider_definitions);
    drop function if exists private.provider_definition_payload(private.provider_definitions);
  end if;
end;
$helpers$;

drop function if exists private.require_provider_four_eyes(uuid, boolean, boolean);
drop function if exists private.write_provider_audit(uuid, uuid, text, jsonb, jsonb, text);
drop function if exists private.provider_request_id();
drop function if exists private.provider_definition_check_input(jsonb);
drop function if exists private.provider_definition_reason(text);
drop function if exists private.require_provider_definition_admin();

-- Dropping a table fires no row or truncate trigger.
drop table if exists private.provider_audit_log;
alter table if exists private.provider_definitions
  drop constraint if exists provider_definitions_approved_revision_fk;
drop table if exists private.provider_definition_revisions;
drop table if exists private.provider_definitions;
drop table if exists private.provider_definition_override_emails;

drop function if exists private.provider_audit_log_immutable();
drop function if exists private.provider_definition_revisions_guard();
drop function if exists private.provider_definitions_no_delete();
drop function if exists private.provider_admission_is_valid(jsonb, text);
drop function if exists private.provider_credential_ref_is_name(text);
drop function if exists private.provider_hosts_are_valid(text[]);
drop type if exists private.provider_status;
