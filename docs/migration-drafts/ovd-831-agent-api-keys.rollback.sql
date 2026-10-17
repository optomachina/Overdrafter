-- OVD-831 agent API keys rollback. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-831-agent-api-keys.rollback.sql
--
-- Removes everything docs/migration-drafts/ovd-831-agent-api-keys.sql adds:
-- nine functions, the audit trigger function, and the three tables (their
-- policy, indexes, constraints, triggers and grants go with them). The schema
-- returns to its exact pre-draft shape (fixture: empty pg_dump --schema-only
-- diff).
--
-- DATA LOSS: every agent API key stops working and is deleted, and the key
-- audit trail is deleted. Export private.agent_api_key_audit first if it is
-- needed as evidence. Roll the server verifier back (or leave it unwired)
-- first: without the service RPCs it refuses every key with "unavailable".
-- Run only with Blaine's yes. Replaying it is a no-op (if exists throughout).

set local lock_timeout = '5s';

drop function if exists public.api_service_record_agent_api_key_refusal(uuid, text, text);
drop function if exists public.api_service_admit_agent_api_key_use(uuid, text, integer, integer, integer);
drop function if exists public.api_service_get_agent_api_key(text);
drop function if exists public.api_admin_revoke_agent_api_key(uuid);
drop function if exists public.api_admin_list_agent_api_keys(uuid);
drop function if exists public.api_revoke_agent_api_key(uuid);
drop function if exists private.agent_api_key_revoke(uuid, uuid, text);
drop function if exists public.api_list_agent_api_keys(uuid);
drop function if exists public.api_create_agent_api_key(uuid, text, text[], timestamptz);

-- OVD-924 AC3 throwaway: this rollback deliberately leaves private.agent_api_key_rate_limits behind (DM-1R must fail). Reverted in the next commit.
-- drop table if exists private.agent_api_key_rate_limits;
drop table if exists private.agent_api_key_audit;
drop function if exists private.agent_api_key_audit_immutable();
drop table if exists public.agent_api_keys;
