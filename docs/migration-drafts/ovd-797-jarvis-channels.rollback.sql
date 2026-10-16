-- OVD-797 Jarvis channels rollback. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-797-jarvis-channels.rollback.sql
--
-- Removes everything docs/migration-drafts/ovd-797-jarvis-channels.sql adds:
-- the control command guard and the ten jarvis_* tables (their policies,
-- indexes, constraints and grants go with them). The schema returns to its
-- exact pre-draft shape (fixture: empty pg_dump --schema-only diff).
--
-- DATA LOSS: every Jarvis conversation, message, decision, identity link,
-- link code, control command, inbound claim and delivery row is deleted.
-- Run only with Blaine's yes. Replaying it is a no-op (if exists throughout).

set local lock_timeout = '5s';

drop function if exists public.jarvis_control_command_guard(uuid, text);

-- Children first, so no drop depends on cascade.
drop table if exists public.jarvis_outbound_deliveries;
drop table if exists public.jarvis_inbound_events;
drop table if exists public.jarvis_control_commands;
drop table if exists public.jarvis_decisions;
drop table if exists public.jarvis_messages;
drop table if exists public.jarvis_link_codes;
drop table if exists public.jarvis_channel_identities;
drop table if exists public.jarvis_conversations;
drop table if exists public.jarvis_channel_settings;
drop table if exists public.jarvis_access_grants;
