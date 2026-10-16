---
name: verify-overdrafter
description: Drive the real Overdrafter web app (Vite dev server + local Supabase + Playwright) to prove auth, quote and provider journeys work, and capture evidence. Use for explicit acceptance claims, QA re-runs, and the pstack auto-merge verification gate (OVD-840/OVD-842).
---

# Verify Overdrafter

Generated with pstack `create-verification-skill`. You are reading this cold. Proof means re-run evidence from `scripts/verify.sh`, not a claim in a comment. The feature map in `features/` is the maintained source of what to cover; a proof that drives one entry point is incomplete when the map lists others.

## Launch
Two modes, both driven by `scripts/verify.sh`:

- `fixture` (default): no database. Playwright starts `npm run dev -- --host 127.0.0.1 --port 4173` with a dead Supabase URL and runs specs tagged `@fixture` (`npm run e2e:fixture` shape).
- `local`: needs the local Supabase stack (`npm run db:start`, API `127.0.0.1:54321`, Docker required). `verify.sh --prepare` runs `npm run e2e:prepare` (db reset + `seed:dev` + saved auth states under `playwright/.auth/`). Seeded accounts: `client.demo@overdrafter.local` and `estimator.demo@overdrafter.local` (local-only, password in `e2e/auth.mjs`).

Playwright's `webServer` starts and stops the dev server itself. With `reuseExistingServer` on, an already running port 4173 is reused outside CI: `verify.sh` doctor fails when 4173 is already served, so it never drives a server it did not start.

## Doctor
Read-only; run first and whenever results look wrong:
```bash
.agents/skills/verify-overdrafter/scripts/verify.sh --doctor [--mode local]
```
It checks node and `@playwright/test`, every spec the map names, who owns port 4173, and (local mode) that Supabase answers on 54321 and `playwright/.auth/*.json` exist. It exits non-zero with the unmet precondition.

## Drive
```bash
S=.agents/skills/verify-overdrafter/scripts/verify.sh
$S --mode fixture --features auth,quote,provider     # no database
$S --mode local --prepare --features auth,quote       # real local Supabase
$S --mode fixture --features quote --dry-run          # print the playwright command only
```
Features map to specs (see `features/README.md`): `auth` (smoke, client-shell, part-reload, access-scope), `quote` (quote-comparison, intake, sourcing-destination; `npm run e2e:quote-confirmation` is separate and not wrapped), `provider` (admin-operations supplier settings, jarvis-front-door, engineering admin route; fixture only). Each feature file lists entry points, preconditions, steps, evidence and known gaps. Run a single spec by appending `-- <playwright args>`.

## Evidence
`verify.sh` writes `artifacts/verify-overdrafter/<UTC stamp>/` (gitignored): `playwright-report.json`, `run.log`, `manifest.txt` (mode, features, specs, command, exit code, git head with dirty flag, passed/skipped/expected-fail counts) and Playwright traces, videos, and screenshots on failure. Cite the directory, the manifest verdict line and the exact command. Proof standards: drive the real UI path, never internal setters; capture the action and the resulting state; for mutations (shipping address, supplier cap) check a second view after reload; fixture mode proves UI behavior only, not database or RLS behavior, say which mode produced the proof. Read the manifest `tests:` line: a skipped or `test.fail()` journey is reported as such, never as verified through another path.

## Cleanup
Playwright stops the dev server it started. Stop Supabase only if you started it (`npx supabase stop`); never kill by process name. Do not delete `artifacts/verify-overdrafter/`. Local mode mutates only the disposable local database. No production, provider or customer scope is ever touched; this skill makes no network calls beyond localhost.

## Helpers
- `scripts/verify.sh`: doctor, launch, drive and evidence (above).
- `scripts/feature-specs.mjs`: prints the spec list for a feature set (`node scripts/feature-specs.mjs auth,quote`); used by `verify.sh` and the structure test.
- `run`: CI entrypoint (`.github/workflows/verify.yml`, OVD-843). `run --app-root head --out verify-out` drives another checkout (`VERIFY_APP_ROOT`) with this harness in fixture then local mode (local always gets `--prepare`), one evidence dir per mode; `--dry-run` prints the commands. The verdict comes from the repo's `scripts/verify-result-judge.mjs`, which fails closed on skipped, `test.fail()`, timed-out or cancelled journeys, a missing report, a dirty tree, a head SHA mismatch and a spec list that differs from this feature map. CI runs the journeys in one job and judges in a second job that checks out only the base.

Structure is checked by `npx vitest run scripts/verify-overdrafter-skill.test.mjs --maxWorkers=2`.
