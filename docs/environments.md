# Environments map and machine baseline

Draft, 2026-10-18. Names and versions only; no secret values. Detail for
staging variables lives in `staging-env-wiring.md`.

## Deployment tiers

| Tier | Frontend/API | Database | Worker | Rules |
| --- | --- | --- | --- | --- |
| Local | Vite + `.env` | local Supabase (Docker) | local | disposable |
| CI | GitHub Actions | amd64 SQL fixtures only | none | fixtures refuse non-CI env |
| Preview (staging) | Vercel Preview | `overdrafter-staging` (`ldmambwtksfvqdufhaam`) | Cloud Run `overdrafter-cad-worker-staging`, simulate mode | default target for all agent work |
| Production | Vercel Production, auto-deploys on `main` | `ozuatdcakezjtevztjlr` | Cloud Run worker | Blaine's explicit OK only; DB migrations land before merge |

## Machines and agents

| Where | Role | Notes |
| --- | --- | --- |
| MacBook Pro | primary dev, Vercel/prod-capable | audited 2026-10-18, see below |
| Mac mini | canonical gbrain (port 3131 on tailnet), jobs worker | checkout stale (main 2026-09-10); not audited |
| Windows Workstation | planned | SSH refused (no authorized key); not audited |
| Cloud Run (GCP) | CAD worker, staging + prod | the only confirmed cloud compute |
| Agent clouds (Claude cloud sessions, ChatGPT Dots, Grok Bot) | agents, not machines | staging-only; no prod credentials |

## Baseline (every dev machine)

- Node 22, pnpm, git, gh, Supabase CLI, Tailscale.
- Repo checked out at current `main`.
- Claude Code and Codex logged in; gbrain HTTP client with a per-machine OAuth client (tokens expire 2026-11-17).
- Secrets only under `~/.config/overdrafter/` (mode 600, dir 700), sourced from Bitwarden.

Extras by role:

- Docker + local Supabase: only where SQL qualification runs (Apple Silicon needs the dind recipe).
- Vercel CLI and prod access: MacBook only.
- Cloud/agent boxes: staging credentials only.

## MacBook Pro audit (2026-10-18)

| Item | Result |
| --- | --- |
| Node | v22.22.3 OK |
| pnpm | 10.30.3 OK |
| git / gh | 2.53.0 / 2.100.0 OK |
| Supabase CLI | 2.78.1, behind (2.121.0 available) |
| Vercel CLI | 59.15.1 OK |
| Docker | 29.3.0 OK |
| Tailscale | 1.102.4 OK |
| Claude Code / Codex | 2.1.289 / 0.160.0 installed; Claude login expired per memory |
| `~/.config/overdrafter` | `jev.env` 600, `gbrain-clients/` 700 OK |
| Repo vs `origin/main` | up to date |

## Mac mini audit (2026-10-18, read-only over SSH as `jarvis@100.75.35.69`)

The `.local` alias in `~/.ssh/config` does not resolve from the MacBook; use the Tailscale address.

| Item | Result |
| --- | --- |
| Node | v26.11.1, DRIFT: baseline is Node 22 |
| pnpm / git / gh | 10.33.0 / 2.52.0 / 2.100.0 OK |
| Supabase CLI | 2.75.0, behind |
| Vercel CLI | 59.15.1 OK (mini does not need it under the role rules) |
| Docker | 29.3.1 OK |
| Tailscale | 1.94.1, behind the MacBook's 1.102.4 |
| Claude Code / Codex | 2.1.296 / 0.162.1 installed; login state not checked |
| `~/.config/overdrafter` | MISSING (no secrets dir) |
| `~/Documents/GitHub/Overdrafter` | HEAD 3b16e406 (2026-09-10), 3 dirty files: stale, feeds gbrain autopilot |
| `~/Overdrafter` | HEAD 2cb6e66c (2026-10-14), clean: second checkout, purpose unknown |

## Fixes applied 2026-10-18

- MacBook: Supabase CLI 2.78.1 to 2.121.0 (brew).
- Mini: installed keg-only `node@22` (22.23.3) at `/opt/homebrew/opt/node@22/bin/node`. The default `node` stays 26 on purpose: the OpenClaw gateway/node LaunchAgents hardcode `/opt/homebrew/opt/node/bin/node`, so use Node 22 explicitly (PATH prefix) for Overdrafter work. gbrain runs on bun and is unaffected.
- Mini: `~/Documents/GitHub/Overdrafter` (the checkout gbrain autopilot reads) fast-forwarded to `90bcda9e` (main). Dirty edits to `PLAN.md` and `docs/engineering-control-plane.md` and untracked `output/` were backed up first to `~/backups/overdrafter-stale-checkout-20261018/` on the mini; `output/` is still in place.
- Mini Tailscale: the running daemon is Tailscale.app 1.102.2 (current). The 1.94.1 in brew is a stale CLI with an errored LaunchAgent; left alone.

## Not fixed

- Mini Supabase CLI stays at 2.75.0: brew refuses `supabase/tap` as untrusted; trusting a tap is Blaine's call.
- Mini `~/Overdrafter` (clean, 88 commits behind) untouched; purpose unknown.
- `grok-box` (Linux) and `workstation` (Windows): SSH username/key unknown; not audited.

## Other nodes seen on the tailnet

- `grok-box` (Linux, offline 16 min at audit): likely the Grok Bot host; not audited.
- `workstation` (Windows): online; SSH login still refused.

## Open items

1. Trust `supabase/tap` on the mini (or install the CLI another way), then upgrade.
2. Give SSH username/key for `grok-box` and `workstation`, then audit.
3. Decide whether mini `~/Overdrafter` is retired or canonical.
4. `claude auth login` on the MacBook; rotate gbrain tokens before 2026-11-17.
5. Confirm cloud inventory (Gmail connector unauthorized; GCP Cloud Run worker is the only confirmed cloud compute).
