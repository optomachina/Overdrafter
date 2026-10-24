Slice 3 of OVD-828: [OVD-831](https://linear.app/overdrafter/issue/OVD-831) agent-caller auth with scoped, hashed, revocable API keys. **Sensitive** (auth, secrets, migration). The migration is a **draft only**, in `docs/migration-drafts/`; nothing is in `supabase/migrations/` and nothing was applied.

- The draft adds `public.agent_api_keys` with column grants (`key_hash` is not selectable), `private.agent_api_key_audit` (append-only) and `private.agent_api_key_rate_limits`, plus user and admin RPCs.
- Pending pgTAP lives in `supabase/tests/pending/ovd831_agent_api_keys.sql.pending` (101 assertions) and runs in CI via `.github/workflows/ovd831-pending-pgtap.yml`.
- `server/agent-auth/verifier.ts` exports `verifyAgentApiKey(header)`, which returns `{orgId, keyId, scopes}` or a refusal. It uses sha256 over a 256-bit secret, `timingSafeEqual`, and checks revoked, expiry, scope and rate limit on every call, with no cache.

## Hardening checklist mapping / builder summary
| Item | Implementation | Tests |
|---|---|---|
| Key format `ovd_<prefix>_<secret>`; store prefix and hash only; sha256 of a 256-bit secret; constant-time compare | `ovd-831-agent-api-keys.sql` (create RPC, CHECKs on prefix and hash shape); `server/agent-auth/api-key.ts` (parsing hashes and drops the plaintext; `timingSafeEqual`); `verifier.ts` (compares against a dummy hash when the prefix is unknown) | `api-key.test.ts` (format, 32-byte secret, hash matches the database, malformed keys, `timingSafeEqual` called on both match and mismatch); pgTAP K-7 (hash equals sha256 of the secret, no stored row contains the plaintext) |
| Plaintext shown once, never stored or returned again | `key` appears only in the create RPC's response; list and admin list return non-secret columns only | pgTAP K-7 (the list output has no hash, key or secret); `journey.test.ts` |
| Least-privilege scopes, no admin scope, default read-only | CHECK limits scopes to `quotes:read` and `quotes:request`; the create RPC validates and deduplicates them, default `{quotes:read}`; `AGENT_API_KEY_SCOPES` in TS | pgTAP K-7 (admin or empty scope refused, default `quotes:read`); `verifier.test.ts` (read-only key gets 403 on `quotes:request`) |
| Immediate revocation, no cache | The verifier reads the key on every call; the database re-checks `revoked_at` under a row lock when it admits a use; revoke locks the row exclusively | `verifier.test.ts` (refused on the next call; one read per call; revoked between lookup and admission); pgTAP K-8 and K-10; fixture race (revoke waited 1.5 s for an in-flight use, the next use was refused) |
| Expiry required: default 90 days, max 1 year | `expires_at NOT NULL` with a CHECK of at most `created_at + 1 year`; the create RPC enforces both bounds | pgTAP K-7 (missing, over a year, past and default cases); `verifier.test.ts` (expired key refused) |
| Rate limit per key and per org | `private.agent_api_key_rate_limits` table and the admit RPC; defaults in `verifier.ts` | pgTAP K-10 (per-key, per-org, retry-after); `verifier.test.ts` (429 with retry-after, per-org across two keys) |
| No keys in logs, errors, Sentry, analytics; redaction test | `redaction.ts`; every logger field goes through it; repository errors carry a fixed message; only the prefix and key id reach the database. There is no Sentry or analytics in `server/` today, so the redactor is exported for whichever sink comes later | `redaction.test.ts`; `verifier.test.ts` "plaintext key never leaks" (results, logger, console, audit, stored rows and list on every path). Disabling redaction makes it fail |
| Audit of create, revoke and use (key id, endpoint, result; never the key) | `private.agent_api_key_audit`: append-only via trigger, RLS forced, no grants; endpoint must be a bare name; refusal results come from a fixed list | pgTAP K-11 (event counts, every use outcome, no key material, update and delete blocked); `journey.test.ts` (audit sequence) |
| Admin RPCs need AAL2 and platform admin; user create and revoke need AAL2 | `api_admin_list_agent_api_keys` and `api_admin_revoke_agent_api_key` check `current_user_has_aal2() AND is_platform_admin()`; create and revoke check AAL2 plus org membership | pgTAP K-7, K-8, K-9 (aal1, non-admin and org-admin-only callers refused; admin at AAL2 allowed) |
| RLS: org members read non-secret columns; writes only via RPC; `key_hash` never selectable | One SELECT policy (`user_can_access_org(org_id)`); column-level grants; no client insert, update or delete grants | pgTAP K-3, K-4, K-5 |
| pgTAP for RLS (cross-org, anon denied, hash unreadable) and RPC grants | `supabase/tests/pending/ovd831_agent_api_keys.sql.pending` (101 assertions); `.github/workflows/ovd831-pending-pgtap.yml`, same setup as OVD-797; `docs/migration-drafts/ovd-831-fixture.sh` | K-2 (anon), K-4 (cross-org), K-3 (hash), K-6 (exact execute permissions on all 9 functions, `search_path ''`) |

`server/agent-auth/verifier.ts` exports `verifyAgentApiKey(header, opts)`, which returns `{ orgId, keyId, scopes }` or a refusal with a 401, 403, 429 or 503 status. If the database calls fail it refuses with 503. This is the function S5 and S6 will call.

The journey test runs at the service level, as the issue allowed: this slice has no UI or route, and the draft isn't applied. It uses an in-memory store that copies the draft's rules: create at AAL2, see the key once, use it, revoke it, then the revoked key fails.

`docs/migration-drafts/ovd-831-notes.md` has the four OVD-602 allowlist rows to add at promotion and an 8-step promotion checklist (deploy the migration before any route that uses the verifier; roll those routes back before running the rollback).

## Test results

- **`npm run lint`, `npm run typecheck`:** clean.
- **`server/agent-auth` tests:** 58 passed in 5 files.
- **Local fixture** (Postgres 17 + pgTAP, disposable): the draft applies; pgTAP passes 101 of 101; the revoke-vs-use race behaves; the schema after rollback matches the pre-draft schema exactly, including after re-apply and a second rollback. The CI workflow, which runs on the full migration chain, is the more faithful check and hasn't run yet.
- **`npx vitest run --maxWorkers=2`:** 547 files passed, 43 failed (11 tests), 2 skipped. None of the failures is in `server/`. They are in `worker/src/**` and a few `scripts/*` tests (including the known OVD-417 one), and fail with errors like `Cannot find package 'camoufox-js'` and `tsx` not found, because `worker/node_modules` isn't installed in this worktree. The branch only adds files and changes no existing ones. I didn't run the suite on main to confirm these fail there too.

## Notes for the PR

- **Size:** this is well over the 200-line guideline because the draft, its 101-assertion pgTAP, the fixture script and the verifier make up one security unit. If you want it smaller, the clean split is the two commits: the draft and pgTAP first, the verifier second.
- **Review gate:** it touches auth, RLS, SECURITY DEFINER functions and `.github/workflows/`, so it needs Opus review and your OK before merge, and promoting the migration is a separate approval.

## Proof
- `npm run lint`: pass. `npm run typecheck`: pass.
- `npx vitest run --maxWorkers=2`: 589 files passed, 2 skipped, 1 failed. Tests: 11511 passed, 3 failed. All 3 failures are the known docker failures in `qualify-ovd417-four-migration-suffix`.
- Pending pgTAP: see CI `ovd831-pending-pgtap`.


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added draft support for scoped agent API keys, including key creation, listing, revocation, expiry, and rate limits. Key secrets are shown only at creation, while audit records avoid exposing key material.
  * This capability remains in draft and is not applied to Supabase projects.
* **Bug Fixes**
  * Added safeguards to reject invalid, expired, revoked, or insufficiently scoped keys and to limit key usage.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->