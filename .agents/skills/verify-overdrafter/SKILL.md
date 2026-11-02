---
name: verify-overdrafter
description: Drive the real Overdrafter web app (Vite dev server + local Supabase + Playwright) to prove auth, quote and provider journeys work, and capture evidence. Use for explicit acceptance claims, QA re-runs, and the pstack auto-merge verification gate (OVD-840/OVD-842).
---

# Verify Overdrafter

Generated with pstack `create-verification-skill`. You are reading this cold. Proof means re-run evidence from `scripts/verify.sh`, not a claim in a comment. The feature map in `features/` is the maintained source of what to cover; a proof that drives one entry point is incomplete when the map lists others.

## Launch
Two modes, both driven by `scripts/verify.sh`:

- `fixture` (default): no database. Playwright starts `npm run dev -- --host 127.0.0.1 --port 4173` with a dead Supabase URL and runs specs tagged `@fixture` (`npm run e2e:fixture` shape). `provider` also runs `e2e/admin-operations.config.ts` (its synthetic admin server on 4174).
- `local`: needs the local Supabase stack (`npm run db:start`, API `127.0.0.1:54321`, Docker required). `verify.sh --prepare` runs `npm run e2e:prepare` (db reset + `seed:dev` + saved auth states under `playwright/.auth/`). Seeded accounts: `client.demo@overdrafter.local` and `estimator.demo@overdrafter.local` (local-only, password in `e2e/auth.mjs`).

Playwright's `webServer` starts and stops the dev server itself. Specs that need their own server run under their own config (`e2e/admin-operations.config.ts`, port 4174); `feature-specs.mjs` records the config and port for each spec. With `reuseExistingServer` on, an already running port 4173 is reused outside CI: doctor fails when any TCP listener (HTTP or not) holds a port the selected configs bind, so the run never drives a server it did not start.

Ready means usable, not process up: Playwright waits for `http://127.0.0.1:4173` to answer, then fixture-mode global setup (`e2e/fixture-warmup.mjs`) loads each fixture route once in a real browser before any spec runs. Local mode starts from an empty data dir with `--prepare` (`npm run e2e:prepare`: `db reset` applies every migration, then `seed:dev` and saved auth). Teardown is Playwright's: the dev server it started exits with the run (check 4173 is free afterwards).

Chromium runs sandboxed (`chromiumSandbox: true` in `playwright.config.ts`); never turn that off to get a run through. As root the sandbox refuses to start, so drive as an unprivileged user. The browser build must match the installed `@playwright/test` (`node_modules/playwright-core/browsers.json`); doctor launches it to check both.

Local only: doctor and `--prepare` fail unless `VITE_SUPABASE_URL`, `PLAYWRIGHT_BASE_URL`, `SUPABASE_URL`, `API_URL`, `SUPABASE_DB_URL` and `DB_URL` are unset or point at `127.0.0.1`/`localhost`, and any set service-role, anon or publishable key is a Supabase CLI local demo JWT (`iss` `supabase-demo`, no project `ref`). Opaque or hosted keys fail closed. Only variable names are printed, never values.

## Isolate
Two runs cannot share a machine: the ports are fixed (4173, 4174), local mode shares one Supabase stack on 54321 and one `playwright/.auth/`, and `--prepare` resets that database under any other run. Run one `verify.sh` at a time. Doctor refuses when a config port already has a listener; do not work around that by reusing or killing the other process.

## Doctor
Read-only; run first and whenever results look wrong:
```bash
.agents/skills/verify-overdrafter/scripts/verify.sh --doctor [--mode local]
```
It checks local-only isolation (above), `@playwright/test` and that it can launch sandboxed Chromium, every spec and config the map names, that no listener holds 4173 (or 4174 for `provider`), and (local mode) that Supabase answers on 54321 and `playwright/.auth/*.json` exist. It exits non-zero with the unmet precondition.

## Drive
```bash
S=.agents/skills/verify-overdrafter/scripts/verify.sh
$S --mode fixture --features auth,quote,provider     # no database
$S --mode local --prepare --features auth,quote       # real local Supabase
$S --mode fixture --features quote --dry-run          # print the playwright command only
```
A single requested feature with no specs in the chosen mode exits 2 (`--mode local --features provider`), as do an unknown feature, an empty token such as `auth,`, or a selection that leaves no specs. In a multi-feature request, a feature with no specs in the mode is dropped, logged and written to the manifest as `skipped features: provider (SKIPPED: no local specs)`; it is not run and never counts as a pass. Features map to specs (see `features/README.md`): `auth` (smoke, client-shell, part-reload, access-scope), `quote` (quote-comparison, intake, sourcing-destination; `npm run e2e:quote-confirmation` is separate and not wrapped), `provider` (admin-operations supplier settings, engineering admin route, jarvis-front-door; fixture only). A spec in `PENDING_SPECS` names the issue that unblocks it; it shows as a `PENDING: ...` line in the console (stderr, not `run.log` or `manifest.txt`) and under "Pending" in the judge summary; it is not run and never counted as a pass. Each feature file lists entry points, preconditions, steps, evidence and known gaps. Run a single spec by appending `-- <playwright args>`. `--dry-run` only prints the commands: it runs no doctor, starts no server and writes no evidence dir, so it proves nothing about the app.

## Evidence
`verify.sh` writes `artifacts/verify-overdrafter/<UTC stamp>/` (gitignored; `--out DIR` overrides it, relative to the app root): one `playwright-report-<n>.json` per config, `run.log`, `manifest.txt` (mode, features, specs, configs, one command per config, exit codes, git head with dirty flag, summed passed/failed/skipped/expected-fail/flaky counts, verdict) and Playwright traces, videos, and screenshots on failure. Cite the directory, the manifest verdict line and the exact command. Proof standards: drive the real UI path, never internal setters; capture the action and the resulting state; for mutations (shipping address, supplier cap) check a second view after reload; fixture mode proves UI behavior only, not database or RLS behavior, say which mode produced the proof. The verdict fails closed: `FAIL` (exit 1) on any non-zero Playwright exit or failed test; `INCOMPLETE` (exit 3) when anything skipped or was flaky, nothing passed, or a report is missing or unreadable; `PASS` (exit 0) otherwise. Only `PASS` is proof. A passing run keeps no screenshots or traces by default; for visual proof (a PR or QA comment) drive with `-- --trace on`, then run `scripts/trace-shots.sh <evidence dir>` to write each journey's final frame to `shots/`. Mocks sit only at the backend boundary: fixture mode points Supabase at a dead port and the app serves its built-in `?fixture=` data, so everything from the route to the rendered UI is real. Read the manifest `tests:` line: a skipped or `test.fail()` journey is reported as such, never as verified through another path.

## Cleanup
Playwright stops the dev server it started. Stop Supabase only if you started it (`npx supabase stop`); never kill by process name. Run cleanup after a failed run too, then check that 4173 and 4174 are free. Do not delete `artifacts/verify-overdrafter/`; the evidence dir (or `--out`) survives cleanup. Local mode mutates only the disposable local database. No production, provider or customer scope is ever touched; this skill makes no network calls beyond localhost.

## Helpers
- `scripts/verify.sh`: doctor, launch, drive and evidence (above).
- `scripts/feature-specs.mjs`: prints `SKIPPED\t<feature>` for each feature with no specs in the mode, then `<config>\t<spec>` for a feature set (`node scripts/feature-specs.mjs auth,quote`); used by `verify.sh` and the structure test.
- `scripts/verdict.mjs`: sums Playwright JSON report counts and prints the fail-closed verdict.
- `scripts/trace-shots.sh <evidence dir>`: final screencast frame per trace into `<dir>/shots/`; exits 2 when the run kept no traces.
- `scripts/isolation.mjs`: local-only environment check used by doctor and `--prepare`.
- `run`: CI entrypoint (`.github/workflows/verify.yml`, OVD-843). `run --app-root head --out verify-out` drives another checkout (`VERIFY_APP_ROOT`) with this harness in fixture then local mode (local always gets `--prepare`), one evidence dir per mode, with Playwright pinned to `--workers=$VERIFY_WORKERS` (default 1); `--dry-run` prints the commands. Its exit follows `verify.sh` (2 usage, then 1 FAIL, then 3 INCOMPLETE, else 0). In CI the verdict comes from the **base** checkout's `scripts/verify-result-judge.mjs`, which reads every `playwright-report-<i>.json` and fails closed on a missing or unexpected report, skipped, `test.fail()`, timed-out or cancelled journeys, a `verify.sh` verdict other than PASS, a dirty tree, a head SHA mismatch and a spec or config list that differs from this feature map. CI runs the journeys in one job and judges in a second job that checks out only the base.

Structure is checked by `npx vitest run scripts/verify-overdrafter-skill.test.mjs --maxWorkers=2`.

## Upkeep
Keep this skill current with the pstack `maintain-verification-skill` method (slash command `maintain-verification-skill`): when a journey, spec, port or command changes, update `scripts/feature-specs.mjs` and the matching `features/*.md` in the same PR. `node scripts/verify-skill-drift.mjs` reports map drift (weekly in `.github/workflows/verify-skill-drift.yml`).
