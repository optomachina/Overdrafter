# OVD-831 notes: agent-caller API keys (DRAFT)

OVD-828 slice 3. Draft only. Nothing here is applied to any Supabase project, and nothing is in `supabase/migrations/`. The prod apply is a separate Blaine approval card.

Files:

- `docs/migration-drafts/ovd-831-agent-api-keys.sql`: `public.agent_api_keys`, `private.agent_api_key_audit` (append-only), `private.agent_api_key_rate_limits`, one SELECT policy, column grants, nine functions and one trigger function.
- `docs/migration-drafts/ovd-831-agent-api-keys.rollback.sql`: drops all of it, `if exists` throughout. It deletes every key and the audit trail.
- `docs/migration-drafts/ovd-831-fixture.sh`: disposable local Postgres fixture. It applies the draft, runs the pending pgTAP, runs a two-session revoke-vs-use race, lists policies and ACLs, and checks DM-1R. It starts its own cluster on a unix socket in a temp dir and never connects to a hosted database.
- `supabase/tests/pending/ovd831_agent_api_keys.sql.pending`: pgTAP, 101 assertions (K-1..K-11).
- `.github/workflows/ovd831-pending-pgtap.yml`: same structure as `ovd797-pending-pgtap.yml`. It runs the draft, DM-1R and the pending pgTAP in a throwaway Supabase DB on the runner.
- Server verifier: `server/agent-auth/` (`api-key.ts`, `verifier.ts`, `repository.ts`, `supabase-repository.ts`, `redaction.ts`), with unit tests and a service-level journey test.

## Key format and storage

`ovd_<prefix>_<secret>`

| Part | Shape | Stored |
| --- | --- | --- |
| prefix | 16 lowercase hex chars (8 random bytes) | yes, `key_prefix` (unique, shown in UI, used for lookup) |
| secret | 43 base64url chars (32 random bytes, 256 bits) | no. Only `key_hash = hex(sha256(utf8(secret)))` is stored |

The secret is generated inside `api_create_agent_api_key` with `extensions.gen_random_bytes(32)`. The database generates it so that no caller can register a weak secret by sending its own hash. The plaintext key goes back once, in the `key` field of the create response. It is never stored, never logged by the database (it is a return value, not a statement argument), and no other RPC returns it. `list` and `admin list` return non-secret columns only.

sha256 without a slow KDF is enough here because the input is 256 bits of uniform randomness, so there is nothing to brute force. A slow hash (argon2id) only helps low-entropy secrets such as passwords.

The server verifier (`server/agent-auth/verifier.ts`) parses the header and looks up the row by prefix through `api_service_get_agent_api_key`. It recomputes sha256 with `node:crypto` and compares with `timingSafeEqual`. An unknown prefix is compared against a dummy hash, so a miss and a mismatch take the same path.

## Access model

| Object | anon | authenticated | service_role |
| --- | --- | --- | --- |
| `public.agent_api_keys` | nothing | column SELECT on every column **except `key_hash`**; RLS `agent_api_keys_select_org_member` = `user_can_access_org(org_id)` | nothing (RPCs only) |
| `private.agent_api_key_audit` | nothing | nothing | nothing (RLS forced, no policy; UPDATE/DELETE/TRUNCATE raise) |
| `private.agent_api_key_rate_limits` | nothing | nothing | nothing (RLS forced, no policy) |

No client role has INSERT, UPDATE, DELETE or TRUNCATE on any of the three tables, and there is no write policy. Every write goes through a SECURITY DEFINER RPC owned by the migration role.

`select *` fails for a client because `*` includes `key_hash`. Client code has to name its columns, which the list RPC already does.

## Functions

| Function | Kind | Execute | Guard |
| --- | --- | --- | --- |
| `api_create_agent_api_key(uuid, text, text[], timestamptz)` | DEFINER | authenticated | `auth.uid()`, **AAL2**, `user_can_access_org(org)`. Scopes must be a non-empty subset of `{quotes:read, quotes:request}` (default `{quotes:read}`). Expiry defaults to now + 90 days and must be in `(now, now + 1 year]` |
| `api_list_agent_api_keys(uuid)` | INVOKER | authenticated | RLS and the column grant |
| `api_revoke_agent_api_key(uuid)` | DEFINER | authenticated | **AAL2**, org member, and creator or `is_org_admin(org)`. An unknown or other-org key gets the same `key_not_found`. Idempotent |
| `api_admin_list_agent_api_keys(uuid)` | DEFINER | authenticated | `current_user_has_aal2() AND is_platform_admin()` |
| `api_admin_revoke_agent_api_key(uuid)` | DEFINER | authenticated | `current_user_has_aal2() AND is_platform_admin()` |
| `api_service_get_agent_api_key(text)` | DEFINER | service_role | returns `keyHash`, scopes, expiry, revocation for one prefix |
| `api_service_admit_agent_api_key_use(uuid, text, int, int, int)` | DEFINER | service_role | under `FOR NO KEY UPDATE` re-checks revoked, expired and creator still a member; takes the per-key counter, then the per-org counter only when the key is under its limit; stamps `last_used_at`; audits every outcome |
| `api_service_record_agent_api_key_refusal(uuid, text, text)` | DEFINER | service_role | audits `invalid_secret`, `insufficient_scope`, `revoked` or `expired` (fixed set) |
| `private.agent_api_key_revoke(uuid, uuid, text)` | DEFINER | nobody | shared revoke body |
| `private.agent_api_key_audit_immutable()` | trigger | nobody | append-only audit |

All have `search_path = ''` and fully qualified names. Every function is `revoke all ... from public, anon, authenticated, service_role` first, then granted to exactly one role.

Why SECURITY DEFINER: the create, revoke and service RPCs write tables that no client role may write. The admin RPCs read keys outside the caller's orgs. The service lookup returns `key_hash`, which no role can select directly. List stays INVOKER because RLS already gives exactly the right rows.

### Choices

- **Revocation is immediate.** The verifier reads the row on every call and has no cache. The admit RPC re-checks `revoked_at` under `FOR NO KEY UPDATE` (which also serialises parallel uses of one key; `FOR SHARE` deadlocked them on the `last_used_at` update). A revoke takes `FOR UPDATE`, so it waits for a use in flight to commit, and every use after the revoke commits is refused. The fixture race shows this: the revoke waited 1.5 s, then the next use returned `revoked`.
- **Expiry is required** (NOT NULL, CHECK `expires_at > created_at and expires_at <= created_at + interval '1 year'`). The CHECK uses `created_at`, not `now()`, for the same reasons as OVD-797 DM-10.
- **Creator leaves the org.** The key stops working (`creator_not_member`), so a removed member's key cannot outlive their access. An org admin should still revoke it so the UI shows it as revoked.
- **Rate limits** use fixed windows, one counter per key and one per org. The server passes the window and limits (defaults in `server/agent-auth/verifier.ts`: 60 s, 60 per key, 300 per org), and the RPC bounds-checks them. Only uses with a correct secret are counted, so someone guessing secrets for a known prefix cannot lock out the real key. Guessing a 256-bit secret is not feasible anyway. Expired counters for the key and org are pruned on each admit.
- **Audit.** `create` and `revoke` record the actor. `use` records the key id, the endpoint name (regex `^[a-z][a-z0-9_.:/-]{0,127}$`, so no URLs or query strings) and the result. No audit column can hold key material: results come from a fixed set, and `detail` is only written by `create` (scopes and expiry). A malformed header or an unknown prefix is refused in the server without touching the database (no key id to audit, and no DB amplification).
- **No admin scope exists.** Only `quotes:read` and `quotes:request` are allowed, enforced by CHECK and in the RPC.

## OVD-602 privilege inventory (rows to add at promotion)

Add these to `api_priv_definer_allowlist` in `supabase/tests/api_role_privilege_inventory.sql` in the same change that promotes the draft:

```sql
  ('public.api_admin_list_agent_api_keys(uuid)', 'authenticated', 'admin-aal2', 'OVD-831'),
  ('public.api_admin_revoke_agent_api_key(uuid)', 'authenticated', 'admin-aal2', 'OVD-831'),
  ('public.api_create_agent_api_key(uuid,text,text[],timestamp with time zone)', 'authenticated', 'verified-auth+membership', 'OVD-831'),
  ('public.api_revoke_agent_api_key(uuid)', 'authenticated', 'verified-auth+membership', 'OVD-831'),
```

Nothing else changes in the inventory:

- The service RPCs are granted to `service_role` only, and the inventory covers PUBLIC, anon and authenticated.
- `api_list_agent_api_keys` is SECURITY INVOKER, so it is outside the definer inventory.
- `private.agent_api_key_revoke` and the trigger function are granted to nobody.
- `public.agent_api_keys` has RLS on (check 4), its one policy targets `authenticated` only (check 5), and anon holds no TRUNCATE, so the Q35 debt list is unchanged (check 7).

## How to verify

```bash
bash docs/migration-drafts/ovd-831-fixture.sh
```

It needs Postgres 17 binaries (`PG_BIN`) and `pg_prove` with pgTAP. The stubs are the OVD-797 set plus `public.app_role`, `public.organizations`, `public.organization_memberships`, `user_can_access_org`, `is_org_admin` (bodies from `supabase/migrations`) and pgcrypto in `extensions`.

Expected:

- `ok - K-0 the draft applies cleanly to a fresh fixture`
- pgTAP `1..101`, `Result: PASS`
- `ok - revoke waited <~1.5>s for the in-flight use, then the next use is refused: revoked`
- the policy, table ACL, column ACL (`key_hash` has no ACL) and function ACL listings
- `ok - DM-1R rollback after apply: ...` and `ok - DM-1R re-apply, rollback, rollback replay: ...`

The CI workflow is the faithful proof, because it runs on the full `supabase/migrations` chain in a real local Supabase.

## Promotion checklist (Blaine-approved window only)

1. Run `npm run migration:new` and copy the draft body unchanged. Confirm pgcrypto is still in `extensions` on the target (`select extnamespace::regnamespace from pg_extension where extname = 'pgcrypto'`).
2. Rename `supabase/tests/pending/ovd831_agent_api_keys.sql.pending` to `supabase/tests/ovd831_agent_api_keys.sql`.
3. Add the four OVD-602 allowlist rows above to `supabase/tests/api_role_privilege_inventory.sql`.
4. Delete `.github/workflows/ovd831-pending-pgtap.yml`.
5. Regenerate `src/integrations/supabase/types.ts`.
6. Attach the OVD-602 inventory diff (exactly the four rows), the DM-1R dump diff (empty), and the pgTAP output to the approval card.
7. Deploy order: migration first, then any route that calls `verifyAgentApiKey` (S5/S6). The verifier fails closed (`unavailable`) when the RPCs are missing, so deploying it early refuses every key. It does not admit any.
8. Rollback: roll back or unwire the S5/S6 routes first, export `private.agent_api_key_audit` if it is needed as evidence, then apply `ovd-831-agent-api-keys.rollback.sql`.

- **Invalid-secret audit growth (open, follow-up).** Wrong-secret attempts against a known prefix each write one audit row and are not rate limited (lockout is deliberately avoided). Before exposing the endpoint publicly, add a per-prefix throttle at the edge/server for `invalid_secret` audits.
