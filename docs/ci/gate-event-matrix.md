# Gate event matrix

Update this document and `scripts/fixtures/sensitive-paths/gate-event-matrix.json` in the same pull request as any edit to a workflow under `.github/workflows/` that adds or removes `merge_group`, `issue_comment`, `pull_request_target`, or `push`. `scripts/validate-agent-contract.mjs` fails when the workflow, the JSON, and this document disagree.

The machine-readable rows live in the JSON. This page is the map of what each event is allowed to do. Week of 2026-10-26, these paths failed in production and were patched afterwards: `merge_group` (`#1005`, `secret-scan` was required and did not run on the queue), `issue_comment` writer cancels and secondary rate limits (`#972`, `#1007`, `#1009`), and `push` to `main` (`#1013`, vendor PR overlaps failed `main`). `#1010` then keyed required-check concurrency on the head sha so an unrelated `edited` event could not cancel them.

## Rules the check enforces

- Every workflow that triggers on `merge_group`, `issue_comment`, `pull_request_target`, or `push` has a row. Schedule-only workflows (for example `required-checks-rerun.yml`) do not.
- Every workflow writes `on:` as a block with two-space event keys. An inline `on: push` or `on: [push]`, a tab, another indent, no top-level `on:` at all, a `merge_group:` value other than a block, an inline map (`merge_group: { types: [checks_requested] }`) or an empty value (a bare key, `null` or `~`), or a nested `types:` list with an item at another indent or a line that is not an item, fails the check, because the check could not read its triggers and would otherwise treat it as having none. A leading UTF-8 BOM, CRLF line endings, trailing comments, and blank or comment lines between `types:` items are read normally.
- A row marked `required: true` matches `REQUIRED_CHECKS` in `scripts/merge-queue-workflows.test.mjs`. It declares `merge_group` types `checks_requested`, no `paths` filter, and concurrency keyed on `github.event.pull_request.head.sha`.
- `issue_comment` runs only through `commentFilterExpression()` in `scripts/ovd-merge-gate.mjs`. Relay, progress, and the sticky status comment start no job. Fixture: `scripts/fixtures/sensitive-paths/gate-issue-comments.json`.
- The merge-gate client retries a rate-limited 403 or 429 (`retry-after`, or a remaining quota of 0 within the wait cap) and does not retry any other 403. Fixture: `scripts/fixtures/sensitive-paths/gate-rate-limit.json`.
- `push: commit` tests the pushed commit and may fail `main`. `push: report-only` is the only push that may scan other open PRs (`--all`), and that step must pass `--report-only`. Open-PR overlap is not a defect of `main`.
- `merge_group` has no `paths` filter. `verify.yml` omits `types`; every other `merge_group` workflow lists `checks_requested`. Making `verify.yml` required means setting `types: [checks_requested]` in the same PR.

## Workflows

| Workflow | Events | Push | merge_group types | Required |
| --- | --- | --- | --- | --- |
| `.github/workflows/ci.yml` | pull_request, push, merge_group | commit | checks_requested | yes |
| `.github/workflows/companion-artifact.yml` | pull_request, push | commit | | |
| `.github/workflows/companion-task.yml` | pull_request, push | commit | | |
| `.github/workflows/native-sql-proofs.yml` | pull_request, push, workflow_dispatch | commit | | |
| `.github/workflows/ovd-merge-gate.yml` | pull_request_target, issue_comment, workflow_dispatch, merge_group | | checks_requested | |
| `.github/workflows/pr-body-gate.yml` | pull_request, merge_group | | checks_requested | yes |
| `.github/workflows/proof-check.yml` | pull_request, merge_group | | checks_requested | |
| `.github/workflows/secret-scan.yml` | pull_request, merge_group | | checks_requested | yes |
| `.github/workflows/security-definer-lint.yml` | pull_request, merge_group | | checks_requested | |
| `.github/workflows/sensitive-class.yml` | pull_request, merge_group | | checks_requested | |
| `.github/workflows/stop-observer.yml` | pull_request, push | commit | | |
| `.github/workflows/vendor-pr-serialization.yml` | pull_request, merge_group, push, schedule | report-only | checks_requested | |
| `.github/workflows/verify.yml` | pull_request, merge_group | | (types omitted) | |

`ovd-merge-gate.yml` writes the queue check as a no-op success on `merge_group` and evaluates the pull request on `pull_request_target`, `issue_comment`, and `workflow_dispatch`. The queue job does not check out the merge group ref.
