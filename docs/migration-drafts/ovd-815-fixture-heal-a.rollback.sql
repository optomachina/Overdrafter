-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-815 DRAFT rollback. No begin/commit; the runner wraps this file.
-- Deletes the whole ledger. Export private.fixture_heal_events and
-- private.fixture_heal_standing_approvals first if needed as evidence.
-- Unwire callers before rollback. Replay is safe: every DROP uses IF EXISTS.
-- DM-1R: pg_dump --schema-only must match the pre-draft baseline exactly.

drop trigger if exists guard_fixture_heal_job_offer_selection on public.jobs;
drop trigger if exists guard_fixture_heal_client_selection on public.client_selections;
drop trigger if exists guard_fixture_heal_published_option on public.published_quote_options;
drop function if exists private.fixture_heal_guard_quote_commitment();
drop function if exists public.api_worker_fixture_heal_record_fingerprint(jsonb);
drop function if exists public.api_worker_fixture_heal_record_certification(jsonb);
drop function if exists public.api_worker_fixture_heal_record_cleanup_item(jsonb);
drop function if exists public.api_worker_fixture_heal_record_event(jsonb);
drop function if exists public.api_worker_fixture_heal_active_standing_approval();
drop function if exists public.api_admin_grant_fixture_heal_standing_approval(text);
drop function if exists public.api_admin_revoke_fixture_heal_standing_approval(uuid, text);
drop table if exists private.fixture_heal_standing_approvals;
drop table if exists private.fixture_heal_events;
drop table if exists private.fixture_heal_cleanup_items;
drop table if exists private.fixture_heal_certifications;
drop table if exists private.fixture_heal_fingerprints;
drop function if exists private.fixture_heal_events_immutable();
drop function if exists private.fixture_heal_standing_approvals_guard();
