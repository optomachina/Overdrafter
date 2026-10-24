## Linear issue ID

- Issue: OVD-677 (https://linear.app/overdrafter/issue/OVD-677)
- This is a split-out supporting PR. The issue's main PR is #743 (https://github.com/optomachina/Overdrafter/pull/743).
- OVD-677 is not a release-outcome parent.

## Summary

This PR brings the provider go-live checklist in line with Blaine Wilson's Oct 16, 2026 decisions. It covers the PR body gate (`scripts/validate-pr-body.mjs`), its renderer (`scripts/render-pr-body.mjs`), the PR template, `docs/checklists/provider-go-live-checklist.md` and the `add-quote-provider` skill:

- The block-evasion attestation (IP rotation, CAPTCHA solving, human pacing, retrying around a block) is removed.
- The envelope review is automatic. It is pre-checked and signed "Grok Bot under Blaine Wilson standing authority"; the renderer fills it and the gate never fails on it.
- One **per-supplier on/off switch** item replaces the rollback/disable rehearsal, the per provider kill switch rehearsal and the same-day turn-off items. The switch is immediate and worker-enforced at generic dispatch, with an optional admin daily quote cap (default unlimited). The item cannot be N/A. It is satisfied by OVD-829, which merged as #792.
- There is no default daily quote cap anywhere, so the "about 20 quotes per provider per day" item is removed.
- "No stored customer passwords; encrypted session tokens only" stays, decoupled from one-click revoke.
- ITAR/EAR is unchanged.

## Gate loosening

gate_loosening: true

This PR loosens the gate behind the required check `provider-go-live`. Taken from the diff of `scripts/validate-pr-body.mjs` (`PROVIDER_GO_LIVE_REQUIRED_ITEMS`, origin/main...this branch), the validator no longer requires these six checklist items:

1. `envelope-reviewer`: "Envelope reviewed by a named reviewer." It is now an `auto: true` item, pre-checked and signed "Grok Bot under Blaine Wilson standing authority". The validator consumes the line if it is there and never fails on it.
2. `rollback`: "Rollback/disable steps rehearsed." Removed.
3. `kill-switch`: "Per provider kill switch rehearsal (`npm run provider:kill`, `docs/runbooks/provider-cease-and-desist.md`)." Removed.
4. `same-day-off`: "Provider is turned off the same day on a C&D, IP or bot block, CAPTCHA wall, or account ban." Removed.
5. `rate-limit`: "Traffic stays at about 20 quotes per provider per day." Removed.
6. `no-evasion`: "Never rotate IPs, solve CAPTCHAs, mimic human pacing, or retry around a block." Removed.

Items 2–4 are replaced by one new required item, `supplier-switch` ("Per-supplier on/off switch in the admin dashboard … via OVD-829"), which cannot be N/A. `no-passwords` stays required, but its text drops the "with one click revoke" clause.

**Merging is card-only.** Dropping these items loosens the gate behind the required check `provider-go-live`. Release sends Blaine a countersign card after review and QA, and only that countersign can merge this PR. #743 merges after this PR.

## Problem

The `provider-go-live` job runs the base branch's copy of the validator, so a PR cannot change its own gate. #743 (OSH Cut live readiness) carries this checklist rewrite. Because the gate is checked against main's old item list, #743 cannot pass without re-adding items Blaine removed or marking `na: false` items N/A, and neither is honest. Landing the checklist change on main first unblocks #743.

## Scope

Included, taken unchanged from `ovd-677-oshcut-live-readiness`: `scripts/validate-pr-body.mjs`, `scripts/validate-pr-body.test.mjs`, `scripts/render-pr-body.mjs`, `scripts/render-pr-body.test.mjs`, `.github/pull_request_template.md`, `docs/checklists/provider-go-live-checklist.md`, `.codex/skills/add-quote-provider/SKILL.md`.

Not included: the OSH Cut adapter, registry, envelope or any other #743 code; `scripts/provider-enablement-detect.mjs` (unchanged); workflows; migrations. No provider is enabled by this PR.

## Verification

Commands run on `ovd-677-gate-checklist` @ 55df0c5e (one commit on top of `origin/main`, 0 behind), on a Linux box. Head is now 135089be, which only merges `origin/main` (#825, secret-scan files, no overlap with this PR). The two test files were re-run there: `Tests 74 passed (74)`.

```bash
bash scripts/preflight.sh lint
bash scripts/preflight.sh typecheck
npx vitest run --maxWorkers=2 scripts/validate-pr-body.test.mjs scripts/render-pr-body.test.mjs
```

Results:

- [x] lint: `preflight: lint PASS`
- [x] typecheck: `preflight: typecheck PASS`
- [x] vitest: `Test Files 2 passed (2)`, `Tests 74 passed (74)`
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: none on Linux. On an earlier Windows checkout, `provider go-live docs and workflows > runs the gate in its own small workflow` failed only because `core.autocrlf=true` rewrote `.github/workflows/pr-body-gate.yml` with CRLF line endings. This PR does not touch that workflow or that test.

## Tests

`validate-pr-body.test.mjs` and `render-pr-body.test.mjs` are updated for the new item list. The tests cover:

- the automatic envelope item: pre-checked, signed, never a blocker, and rejected as a `providerGoLive` input;
- the per-supplier switch item, which cannot be N/A;
- no-passwords being required without one-click revoke, and rejecting N/A;
- the removed items (CAPTCHA/IP rotation, named reviewer, one-click revoke) no longer appearing in the template or checklist, and the docs stating there is no default daily quote cap.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

- Risks: the gate becomes less strict for the items Blaine removed. That is the intended decision. The automatic envelope item matches any `envelope reviewed` line, so it can absorb one unchecked envelope line. This is a known minor from the #743 review.
- Rollback: revert this PR. The gate then goes back to the old item list.

## Documentation

- [x] Docs updated (`docs/checklists/provider-go-live-checklist.md` decision records, PR template, `add-quote-provider` skill)
- [ ] No doc updates needed

## Gate change review

This PR edits the PR body gate itself (`scripts/validate-pr-body.mjs`, `scripts/render-pr-body.mjs` and their tests), so it runs against the base copy and cannot check its own replacement.

- Reviewer: pending (Blaine card via Release) (owner of the Oct 16, 2026 go-live checklist decisions this implements). Evidence: https://github.com/optomachina/Overdrafter/commit/4084bea7e33c1c181080d73cc395a6633d54eea4 (checklist and gate rewrite per the decisions), https://github.com/optomachina/Overdrafter/commit/87a8672c66837c7d00a4504735c5d94106209434 (daily cap decision), and the Opus review of the same change on #743: https://github.com/optomachina/Overdrafter/pull/743#issuecomment-6210658311

## Follow-up items

- [ ] After merge, rerun `provider-go-live` on #743.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
