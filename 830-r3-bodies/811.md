Closes OVD-839. Docs + a guard script; no prod changes, no files in `supabase/migrations`.

## What
- `docs/runbooks/staging.md`: staging project `overdrafter-staging` / ref `ldmambwtksfvqdufhaam` / us-west-1, who may use it, unpause/reset/reseed (OVD-837 seed, PR #810), read-only smoke reads, **staging-first migration flow** (staging apply + smoke pass → only then prod; **prod apply stays manual via Blaine's approval card**), release smoke reads default to staging (prod read needs Blaine's explicit OK), PR/release-notes evidence template, rollback notes (every promoted migration ships `.rollback.sql`; drill on staging; staging recovery = drop/recreate or reseed, never from prod), execute_sql caveats (CONCURRENTLY, enum ADD VALUE), double-check-the-ref rule.
- `scripts/staging-reset-guard.mjs` (+ 24 tests): allowlist of exactly `ldmambwtksfvqdufhaam`; refuses prod `ozuatdcakezjtevztjlr`, unknown/malformed refs, any URL mentioning the prod ref. No network/DB.
- Linked from `RUNBOOK.md`, `docs/workflows/ovd418-qualified-database-release.md`, `docs/workflows/ovd361-production-deployment.md`.

## Staging evidence (ref `ldmambwtksfvqdufhaam`; prod never touched) — 2026-10-16 PT
**Dry run, all repo migrations on fresh staging:** 153/153 from main @ `fa070483` applied cleanly via Supabase MCP `execute_sql` (details in #810). PASS.
**Rollback drill** — `docs/migration-drafts/ovd-831-agent-api-keys.sql` (unpromoted draft), object counts in public+private (rels / funcs / policies / `agent_api_key%` rels):
| step | result |
|---|---|
| baseline | 471 / 366 / 137 / 0 |
| apply draft | 484 / 376 / 138 / 13 — PASS |
| rollback | 471 / 366 / 137 / 0 — PASS (back to baseline) |
| re-apply | 484 / 376 / 138 / 13 — PASS |
| final rollback (restore staging = main) | 471 / 366 / 137 / 0 |
**Guard:** `node scripts/staging-reset-guard.mjs` → staging exit 0, prod ref exit 1, unknown ref exit 1. (OVD-837 `seed-staging.mjs --check-target` same.)
**Template example — OVD-813 history SELECT on staging** (`supabase/seed/staging-smoke.sql` from #810):
- staging ref: `ldmambwtksfvqdufhaam`; migration id: n/a (read-only smoke); result: 4 rows (>0) → PASS; ~10:50 PT 2026-10-16.

## Checks
- `preflight.sh lint` PASS, `typecheck` PASS
- `npx vitest run --maxWorkers=2`: 593 files pass; only `scripts/qualify-ovd417-four-migration-suffix.test.mjs` fails (known OVD-417 docker).

## Secrets/env for Blaine's card
None. Runbook refers to an operator-local `STAGING_DB_URL` / `STAGING_DATABASE_URL` connection string (never committed); no new Vercel env or GitHub secret.
