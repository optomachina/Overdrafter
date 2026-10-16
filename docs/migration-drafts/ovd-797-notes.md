# OVD-797 notes: Jarvis channels data model (DRAFT) + RLS

Draft only. Nothing here is applied to any Supabase project, and nothing is in `supabase/migrations/`. The prod apply is a separate Blaine approval card (OVD-795 decision 3).

Files:

- `docs/migration-drafts/ovd-797-jarvis-channels.sql`: ten `public.jarvis_*` tables, one `public.jarvis_tier` domain (`owner|beta|paid`, shared by `tier` and `min_tier`), RLS on each, seven SELECT policies, explicit grants, seed rows for four channels (all disabled), and one read only guard function.
- `docs/migration-drafts/ovd-797-jarvis-channels.rollback.sql`: drops the function, the ten tables (children first) and the domain, all `if exists`. It deletes all Jarvis data.
- `docs/migration-drafts/ovd-797-fixture.sh`: disposable local Postgres fixture (DM-1..DM-11, DM-1R, policy listing). It starts its own cluster on a unix socket in a temp dir and never connects to a hosted database.
- `supabase/tests/pending/ovd797_jarvis_channels.sql.pending`: pgTAP, 74 assertions.
- `.github/workflows/ovd797-pending-pgtap.yml`: same structure as `ovd766-pending-pgtap.yml`. It runs in a throwaway local Supabase DB on the runner: apply draft, DM-1R dump diff, re-apply, pending pgTAP, rollback twice.

The architect comment names the files `ovd-795-*`. They are `ovd-797-*` here so they key to this issue, like every other draft in this directory.

## Tables

| Table | Key / uniqueness | Client read (authenticated) |
| --- | --- | --- |
| `jarvis_access_grants` | `user_id` PK; tier `owner\|beta\|paid`; active when `revoked_at is null` | platform admin at AAL2 only |
| `jarvis_channel_settings` | `channel` PK; `enabled` default false; `min_tier` default `owner` | platform admin at AAL2 only |
| `jarvis_conversations` | `user_id` UNIQUE (one conversation per user) | own |
| `jarvis_channel_identities` | UNIQUE `(channel, external_id_hash)`; hash must be 64 hex chars | own |
| `jarvis_link_codes` | `code_hash` PK; `expires_at <= created_at + 10 min` CHECK | none (server only) |
| `jarvis_messages` | `conversation_id` FK; `body` must be a JSON object | own conversation |
| `jarvis_decisions` | `message_id` UNIQUE; `best_guess` NOT NULL; resolution shape CHECK | own conversation |
| `jarvis_control_commands` | UNIQUE `(graph_run_id, idempotency_key)`; kind `pause\|resume\|cancel\|steer`; status `queued\|applied\|rejected` | runs in own conversation |
| `jarvis_inbound_events` | PK `(channel, idempotency_key)` | none (server only) |
| `jarvis_outbound_deliveries` | UNIQUE `(message_id, channel)` | none (server only) |

Every `channel` column references `jarvis_channel_settings(channel)`, so a channel cannot be used before it has a switch row. The seed creates `web`, `slack`, `telegram` and `imessage`, all `enabled = false`, `min_tier = 'owner'`.

## Access model

- RLS is enabled on all ten tables. `anon` has no privilege on any of them (revoked from `public`, `anon` and `authenticated` first, so Supabase's default ACL does not leak through).
- `authenticated` gets SELECT on seven tables. The policies limit it to its own rows: `auth.uid()` matches the conversation owner or the identity owner, or the control command's run appears in its conversation. Grants and channel settings need `public.is_platform_admin() and public.current_user_has_aal2()`.
- No client role has INSERT, UPDATE, DELETE or TRUNCATE on any table, and there is no write policy. All writes go through `service_role` in server code (it has BYPASSRLS on Supabase). Admin changes to grants and switches go through server endpoints that check AAL2, not direct table writes.

### Run ownership

There is no runs table yet (the graph is OVD-801). A run belongs to the user whose conversation carries it, meaning a `jarvis_messages` row with that `graph_run_id`. The guard is stricter: it counts a run as owned only when every message that carries it is in the caller's conversation.

## The one function: `public.jarvis_control_command_guard(uuid, text)`

It returns a verdict and writes nothing. Server code calls it with the user's session. On `ok` it inserts the command with the service role. If clients could insert directly, the guard would just be advice, so they get no insert path (DM-8).

| Verdict | When |
| --- | --- |
| `ok` | the caller owns the run and has an active grant, or the caller is a platform admin at AAL2 |
| `not_authenticated` | no `auth.uid()` |
| `invalid_command` | null run or unknown kind |
| `aal2_required` | a platform admin without AAL2, on a run it does not own |
| `no_access` | the caller owns the run but its grant is revoked or missing |
| `not_owner` | anything else, including an unknown run (no existence leak) |

Shape: `language plpgsql stable security definer set search_path = ''`. Every name is fully qualified (`public.`, `auth.`, `pg_catalog.`). Privileges: `revoke all ... from public, anon, service_role`, then `grant execute ... to authenticated` only. A service role session has no `auth.uid()`, so it could only ever get `not_authenticated`. Admin is checked with `public.is_platform_admin()` and `public.current_user_has_aal2()`. It does not copy `api_admin_set_provider_kill_switch`, which has no AAL2 check.

### Why SECURITY DEFINER (the architect's "none unless justified")

The verdict needs rows that RLS hides from the caller, and that is the point of it:

1. **"not owned by me alone".** To refuse a run that also appears in another user's conversation, the guard has to see other users' messages and conversations. As SECURITY INVOKER it would see only the caller's rows and would report `ok` for a run shared with someone else.
2. **Admin at AAL2 may control any run** (OVD-795 section 13). An admin has no SELECT policy on other users' messages. As INVOKER, every non-owned run would look unknown, and an admin could not be told apart from a stranger.
3. **The caller's own grant.** `jarvis_access_grants` is admin-only to read, so a non-admin INVOKER cannot see its own `revoked_at`.

What limits the risk: it is read only (STABLE, no DML), it takes no user id argument (it always uses `auth.uid()`), it returns one of six fixed strings and never any row data, `search_path` is empty, and only `authenticated` can execute it. The alternative would be broader SELECT policies (for example, admins reading every message), which exposes more than a fixed verdict.

No other function is added. The RLS policies call the existing `public.is_platform_admin()` (SECURITY DEFINER, already granted to `authenticated` by OVD-736) and `public.current_user_has_aal2()`.

## Choices and deviations

- **DM-10 CHECK uses `created_at`, not `now()`.** A CHECK that calls `now()` is not immutable. It would also be checked again on every UPDATE, and it would fail on a dump and restore once the code was older than 10 minutes. The CHECK is `expires_at > created_at and expires_at <= created_at + interval '10 minutes'`, with `created_at default now()`. A writer could backdate `created_at`, but only the service role writes. The issuing endpoint must not set `created_at` (OVD-806 R-cases).
- **Hashes are shape-checked.** `external_id_hash` and `code_hash` must match `^[0-9a-f]{64}$` (HMAC-SHA256 hex), so a plain iMessage handle or Telegram chat id is rejected at the database.
- **Identity uniqueness ignores `revoked_at`**, as the architect specified (`UNIQUE(channel, external_id_hash)`). To relink a revoked external id to another user, the server deletes or reuses the old row. This draft has no per-user, per-channel uniqueness, so multiple Slack workspaces stay open. That is a decision for OVD-806.
- **Decision resolution shape.** Either everything is unresolved, or `resolution`, `resolved_at` and `chosen` are all set. A skip or timeout records the best guess in `chosen` ("proceeds and records it"). `resolved_by` is null for a timeout.
- **Control status.** `applied_at_checkpoint` is set exactly when `status = 'applied'`.
- `on delete cascade` from `auth.users` on user-owned rows (a user deletion removes their Jarvis data). `granted_by` and `resolved_by` are `on delete set null`.

## How to verify

```bash
bash docs/migration-drafts/ovd-797-fixture.sh
```

It needs Postgres 17 binaries (`PG_BIN`, default `/usr/lib/postgresql/<latest>/bin`) and `pg_prove` with pgTAP. Its stubs: `anon`, `authenticated`, `service_role` (BYPASSRLS), a non-superuser BYPASSRLS `migration_owner` that applies the draft (mirroring Supabase's `postgres`), `auth.users`, `auth.uid()` and `auth.jwt()` (Supabase bodies), `private.platform_admin_emails`, and `public.is_platform_admin()` and `public.current_user_has_aal2()` copied from `supabase/migrations`.

Steps and expected lines:

- DM-1: `ok - DM-1 the draft applies cleanly to a fresh fixture`, `tables: 10, rls on: 10`.
- DM-2..DM-11: pgTAP `1..74`, `Result: PASS`.
- DM-3 / DM-9 concurrency: two real sessions. The first inserts and holds its transaction for 2 s. The second's `on conflict do nothing` waits on it, then inserts nothing, leaving 1 row. A plain concurrent duplicate gets `unique_violation`.
- RLS policy listing: `pg_policies`, the table ACLs and the guard ACL.
- DM-1R: the `pg_dump --schema-only` diff against the pre-draft dump is empty after rollback, and still empty after re-apply, rollback and a rollback replay. A rollback mutated to leave the guard behind makes the fixture exit 1 with the leftover `CREATE FUNCTION` in the diff.

## Promotion (Blaine-approved window only)

1. `npm run migration:new` and copy the draft body unchanged.
2. Rename `supabase/tests/pending/ovd797_jarvis_channels.sql.pending` to `supabase/tests/ovd797_jarvis_channels.sql`.
3. Delete `.github/workflows/ovd797-pending-pgtap.yml`.
4. Regenerate `src/integrations/supabase/types.ts`.
