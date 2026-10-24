Closes OVD-837. Synthetic, PII-free staging seed with a prod-ref **allowlist** guard. No files added to `supabase/migrations`.

## Files
- `supabase/seed/staging.sql` — idempotent seed (fixed UUIDs, ON CONFLICT); single batch, no BEGIN/COMMIT (runs via MCP `execute_sql`). Fake `@example.test` emails, synthetic CAD paths only.
- `supabase/seed/staging-counts.sql` — read-only per-table counts. `supabase/seed/staging-smoke.sql` — OVD-813 history SELECT (read-only, LIMIT).
- `scripts/seed-staging.mjs` (+ `scripts/seed-staging.test.mjs`) — exits non-zero unless target ref is exactly `ldmambwtksfvqdufhaam`; refuses prod `ozuatdcakezjtevztjlr` and unknown refs. DB URL from `STAGING_DATABASE_URL` (never printed).
- `supabase/seed/README.md`.

## Staging replay (ref `ldmambwtksfvqdufhaam`, overdrafter-staging, us-west-1) — 2026-10-16 ~10:00–10:45 PT
Prod `ozuatdcakezjtevztjlr` was never touched.
**Migrations:** staging started empty (0 public tables, no history). All **153/153** migrations from main @ `fa070483` (`20251106035356` … `20261015074957`) applied via Supabase MCP `execute_sql`, batched in order with a `supabase_migrations.schema_migrations` row per file. `list_migrations` shows 153; set difference vs repo = ∅; 71 public tables.
Caveats: (1) `20260324010000_add_work_queue_reaper_index` ran with `CREATE INDEX` (no CONCURRENTLY) because execute_sql runs in a transaction; (2) a batch must end after any `ALTER TYPE … ADD VALUE` (first attempt failed `55P04` on `oshcut` and rolled back cleanly, then re-batched).

**Guard:** `--check-target` → staging exit 0; prod ref exit 1; unknown ref exit 1.

**Seed counts** (before → after run 1 → after run 2, identical = idempotent):
| table | before | run 1 | run 2 |
|---|---|---|---|
| auth.users | 0 | 3 | 3 |
| organizations | 0 | 2 | 2 |
| organization_memberships | 0 | 3 | 3 |
| jobs | 0 | 3 | 3 |
| organization_file_blobs | 0 | 4 | 4 |
| job_files | 0 | 4 | 4 |
| parts | 0 | 3 | 3 |
| approved_part_requirements | 0 | 3 | 3 |
| quote_requests | 0 | 4 | 4 |
| quote_runs | 0 | 4 | 4 |
| vendor_quote_results | 0 | 9 | 9 |
| …with raw_payload.fixtureSanity | 0 | 8 | 8 |
| private.provider_kill_switches | 18 | 18 | 18 |
| private.provider_global_kill_switch | 1 | 1 | 1 |
| canonical_parts / part_versions / part_fingerprint_observations / part_deadline_history (trigger) | 0 | 3 each | 3 each |
| sourcing_destination_history (trigger) | 0 | 2 | 2 |

**OVD-813 history SELECT** (`staging-smoke.sql`): 4 rows (>0) — xometry own ×2, fictiv/protolabs peer. PASS.

## Checks
- `preflight.sh lint` PASS, `typecheck` PASS
- `npx vitest run --maxWorkers=2`: 593 files pass; only `scripts/qualify-ovd417-four-migration-suffix.test.mjs` fails (3, known OVD-417 docker).

## Secrets/env for Blaine's card
None created. Optional local/CI name used by the runner: `STAGING_DATABASE_URL` (staging DB connection string; only needed for the psql path — MCP path needs nothing).
