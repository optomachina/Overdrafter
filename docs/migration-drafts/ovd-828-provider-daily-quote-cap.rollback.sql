-- OVD-828 per-supplier daily quote cap rollback. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-828-provider-daily-quote-cap.rollback.sql
--
-- Removes the cap setting RPCs and columns. Effect: the worker's read of
-- api_worker_provider_daily_quote_cap fails and every provider falls back to
-- the worker env default (WORKER_OSHCUT_DAILY_QUOTE_CAP, default 20; RMFG 20).
-- Raised or unlimited caps stop applying at the next dispatch. Kill switch
-- state (engaged or not) and its version are never changed. Run only with
-- Blaine's yes.
--
-- Audit rows are evidence. Export private.provider_daily_quote_cap_audit first,
-- or omit the last two statements to keep the audit trail (it references nothing this
-- rollback drops).

set local lock_timeout = '5s';

drop function if exists public.api_admin_list_provider_daily_quote_caps();
drop function if exists public.api_admin_set_provider_daily_quote_cap(public.vendor_name, integer, boolean, text);
drop function if exists public.api_worker_provider_daily_quote_cap(public.vendor_name);

alter table private.provider_kill_switches
  drop constraint if exists provider_kill_switches_daily_quote_cap_check,
  drop column if exists daily_quote_cap_changed_at,
  drop column if exists daily_quote_cap_changed_by,
  drop column if exists daily_quote_cap_unlimited,
  drop column if exists daily_quote_cap;

-- Evidence: export first, or omit the next two statements to keep the audit
-- trail. Dropping the table drops its append-only triggers with it.
drop table if exists private.provider_daily_quote_cap_audit;
drop function if exists private.provider_daily_quote_cap_audit_immutable();
