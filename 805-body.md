## Linear issue ID

- Issue: OVD-865 (https://linear.app/overdrafter/issue/OVD-865/graph-edge-ci-green-on-head-sha-event-driven-qa-handoff-idempotent)
- This is the main PR for this issue and covers the report-mode stage. These criteria remain after merge: switching to apply mode after 2 days of report logs, and the graph edge, which Grok Bot adds in #799.
- OVD-865 is not a release-outcome parent.

## Summary

This adds an event-driven QA handoff, CI green on head SHA → `qa:ready`, in **REPORT MODE**. It also adds a shared gate and dedupe module and the hourly Mac mini backstop CLI.

**The new `.github/workflows/qa-handoff.yml` needs Blaine's card via Grok Bot before merge. Grok Bot adds the graph edge in #799.**

## Problem

QA handoff currently depends on an hourly poll. It needs to be event-driven and idempotent: hand off exactly once per PR head SHA, after the required checks pass.

## Acceptance criteria addressed

- [x] The workflow triggers on `workflow_run: completed` and re-reads all state through the API.
- [x] Gate: the PR is open, not a draft, and its base is main. The event's head_sha equals the current head. Every required check comes from branch protection (or, when protection is unreadable under `GITHUB_TOKEN`, the documented `REQUIRED_CHECKS` / `DEFAULT_REQUIRED_CHECKS` fallback), is green, and none are pending. Commit statuses can't satisfy Actions checks.
- [x] The dedupe key is `qa-handoff:{pr}:{head_sha}`, stored as a hidden marker comment from trusted authors only. It is re-checked after the per-PR concurrency lock, with a cleanup pass that removes duplicate markers after writing.
- [x] Permissions are `pull-requests: write` and `contents: read` only. It never checks out PR code; it does a sparse checkout of the default branch only.
- [x] The backstop runs the same gate plus the marker check (`scripts/qa-handoff/macmini-backstop.sh`).

## Files changed

- `.github/workflows/qa-handoff.yml` (new)
- `.github/workflows/pr-body-gate.yml`: adds `ready_for_review` so that marking a draft ready re-emits `workflow_run`.
- `scripts/qa-handoff/{gate.mjs,run.mjs,sanitize-log.mjs,macmini-backstop.sh,README.md}`. `sanitize-log.mjs` is the shared helper that strips CR/LF and control characters from every PR-derived log value (the Sonar S5145 fix). `run.mjs` also carries the OVD-877 job-summary fencing and the symlink-safe CLI entry guard.
- Tests: `scripts/qa-handoff/{qa-handoff.test.mjs,qa-handoff-workflow.test.mjs,sanitize-log.test.mjs,step-summary.test.mjs,entrypoint.test.mjs}`.

## Scope

**Included:** the report-mode workflow, the gate module, the backstop CLI, and the tests.

**Not included:**
- Apply mode, which needs these first:
  - Set the repo variable `QA_HANDOFF_TRUSTED_MARKER_AUTHORS` to the backstop login.
  - Create the `qa:ready` label.
- Installing the hourly job on the Mac mini. It wasn't found in the repo or in the mini's crontab, LaunchAgents, or hermes/openclaw cron. This PR provides the script instead. Nothing on the Mac was changed.
- The `graph.v1.yaml` edge, which goes in #799.

## Verification

Commands run:

```bash
bash scripts/preflight.sh lint
bash scripts/preflight.sh typecheck
npx vitest run --maxWorkers=2
npx vitest run --maxWorkers=2 scripts/qa-handoff
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions: 43 test files fail in the full vitest run because of the box environment: OVD-417 docker, camoufox assets, worker adapters, and default-deny/provider-check. None of them are qa-handoff files.

Re-verification on head 8366a81b (1ad7703f merged main 3bd6726a into 9c28b1db with no conflicts and nothing else changed, because strict branch protection requires an up-to-date branch; 8366a81b adds only the entry-guard fix and its test on top, and the branch is still up to date with main 3bd6726a):

```bash
npx eslint --fix scripts/qa-handoff
bash scripts/preflight.sh lint
bash scripts/preflight.sh typecheck
npx vitest run scripts/qa-handoff scripts/test-lane-contract.test.mjs
npm run test:portable-node
```

- eslint on `scripts/qa-handoff`: clean
- lint: PASS
- typecheck: PASS
- vitest, 5 qa-handoff files plus scripts/test-lane-contract.test.mjs: 6 files, 174 tests passed (158 before, plus the 16 in `entrypoint.test.mjs`)
- test:portable-node: 1705 tests, 1703 passed, 0 failed, 2 skipped
- `entrypoint.test.mjs` red check: against the old entry guard, the 6 symlinked-path CLI cases fail and the direct and relative cases pass.
- Hosted CI at the time of this edit: every completed check on 8366a81b had passed (lint, typecheck, build, SonarCloud, the SQL qualification jobs) except Vercel, which failed on its free-tier deploy limit (unrelated to this change). `test` and `browser-test` were still running.

## Proof

Test: scripts/qa-handoff/qa-handoff.test.mjs
Test: scripts/qa-handoff/qa-handoff-workflow.test.mjs
Test: scripts/qa-handoff/entrypoint.test.mjs

## Review findings and coverage

- Final PR head SHA: 8366a81bd7a20b4b4595d8ee7dd847c17161351d
- Sonar issue findings at 8366a81b (SonarCloud analysis of this head, read through its public API): quality gate OK. 0 bugs, 0 vulnerabilities, 0 security hotspots to review, 13 open issues, all code smells. None needs a code change:
  - `javascript:S8786` (`run.mjs:178`): the regex parses the `Link` header returned by api.github.com, which is trusted and bounded input.
  - `javascript:S7758` (`run.mjs:53`): `charCodeAt` is correct here. It matches a backtick, which is a single UTF-16 code unit, so `codePointAt` would behave the same.
  - Style, left as is: `S3776` (`parseArgs` complexity 19 vs 15), `S3800` (`writeStepSummary` return type), `S4624` x4 (nested template literals in log lines), `S9382` x3 (sequential awaits in a loop: pagination follows each response's `next` link, and PRs and duplicate markers are handled one at a time on purpose), `S7688` x2 (`macmini-backstop.sh:16` uses `[` where Sonar prefers `[[`).
  - Resolved: `githubactions:S7631` (`qa-handoff.yml:61`) was marked False positive with the reason recorded on the issue, because the job checks out only the default branch with `persist-credentials: false` and sparse `scripts/qa-handoff`, so no PR or fork code runs. `jssecurity:S5145` (log injection in `run.mjs`) is FIXED by `sanitize-log.mjs`. Both related review threads are resolved.
- Inline review threads: 2, both resolved (the two Sonar findings above). CodeRabbit: skipped (draft PR).
- OVD-877 (#815, job-summary fencing against backticks in branch names) was folded into this branch as 9c28b1db.
- Opus review: round 1 @ 606b2920 and round 2 @ 114fe3b5 returned CHANGES REQUIRED (fixed); round 3 @ 84f68d09 returned APPROVED (https://github.com/optomachina/Overdrafter/pull/805#issuecomment-6220644858); re-review of 84f68d09..7c654dda returned APPROVED (https://github.com/optomachina/Overdrafter/pull/805#issuecomment-6221183587).
- Review at 1ad7703f (both CHANGES REQUIRED, both addressed):
  - Opus (https://github.com/optomachina/Overdrafter/pull/805#issuecomment-6228008713): its one blocking finding was this section being stale, fixed by this body edit. Its delta, merge, workflow and idempotency checks were all OK.
  - Codex (https://github.com/optomachina/Overdrafter/pull/805#issuecomment-6228008433): the CLI entry guard did nothing through a symlinked path. Fixed in 8366a81b with a realpath comparison and `entrypoint.test.mjs`.
- Re-review of 8366a81b: pending. No approval is claimed for this head yet.
- [x] Inspected findings and threads on the final head.

## Tests

The issue's test plan is covered by fixture tests with an in-memory fake API:
- a stale sha does nothing;
- a pending check does nothing;
- all green produces a single handoff;
- a duplicate event or the backstop does nothing;
- a force-push to a new sha produces a re-handoff;
- a draft, closed, or non-main PR does nothing;
- concurrent runs produce one marker;
- the backstop racing the workflow is covered.

A workflow lint test checks permissions, the trigger, concurrency, that there is no PR checkout, and the report-mode default.

An entry-point test starts the real CLI by a relative path, an absolute path, a symlinked directory, a relative path through a symlinked directory and a symlinked file. Each must print the real usage or missing-token error and exit 2, so a symlinked launch can never exit 0 silently. Unit tests cover a missing, dangling or unrelated `argv[1]` and an unresolvable module URL.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

Report mode writes nothing. To roll back, delete the workflow file and revert the `ready_for_review` trigger.

## Documentation

- [x] Docs updated (`scripts/qa-handoff/README.md`)
- [ ] No doc updates needed

## Gate change review

This PR adds `ready_for_review` to the `pull_request` types in `pr-body-gate.yml`. The gate's validation logic is unchanged.

Reviewer: Opus review (Grok Bot), pending Blaine's approval card. Evidence: https://github.com/optomachina/Overdrafter/pull/805#issuecomment-6220644858 (approval @ 84f68d09), https://github.com/optomachina/Overdrafter/pull/805#issuecomment-6221183587 (approval @ 7c654dda). The gate logic is unchanged since both.

## Follow-up items

- [ ] Switch to apply mode after 2 days of report logs.
- [ ] Install the Mac mini hourly backstop.
- [ ] Before apply mode: the first report logs must show `required checks (GET branches/main)`. If they show a fallback source, make unreadable branch protection a no-op in apply mode.


