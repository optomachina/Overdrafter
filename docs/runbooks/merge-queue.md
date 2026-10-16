# Merge queue for `main` (OVD-854)

Status: **drafted, not applied.** Nothing in this runbook has been run against
GitHub. Turning the queue on changes branch protection, which is a protected
action: it needs Blaine's approval card, and Grok Bot applies it only after
approval.

## Why

Today `main` requires `ci` and `provider-go-live` with `strict: false` and has
no merge queue, so a PR can merge green against a stale base and break `main`.
`strict: true` would fix that by forcing every PR to rebase and rerun before
merge, which serialises merges by hand. A merge queue does the same job
automatically: it builds each PR on top of the current `main` (plus anything
ahead of it in the queue), runs the required checks on that commit, and merges
only that tested commit.

## Workflow audit (merge_group triggers)

A required check that never reports on the `merge_group` event stalls the queue
until it times out. Every workflow that is, or will become, a required check
must trigger on `merge_group`. Audit of `.github/workflows/*` at OVD-854:

| Workflow | Check name (job `name`) | Required | `merge_group` | Behaviour on `merge_group` |
| --- | --- | --- | --- | --- |
| `ci.yml` | `ci` | yes | yes | Full suite on the queue commit; the `ci` aggregate job gates on every dependency |
| `pr-body-gate.yml` | `provider-go-live` | yes | yes (`checks_requested`) | No op pass; the rule is enforced on the `pull_request` run |
| `proof-check.yml` | `proof-check` | no (report mode, future candidate) | yes (`checks_requested`) | No op pass; every other step is `pull_request` only, so the job reports success |
| `companion-artifact.yml`, `companion-task.yml`, `companion-inert-qualified.yml`, `stop-observer.yml`, `native-sql-proofs.yml`, `ovd*-pending-pgtap.yml` | various | no | no | Path-filtered PR checks; not required, so they do not block the queue |
| `ovd591-qualification.yml`, `ovd591-retention-qualification.yml`, `free-quote-sql-qualification.yml` | via `ci` | through `ci` | inherited | `workflow_call` only; they run inside `ci.yml` on every event `ci.yml` handles |

No workflow change was needed. `scripts/merge-queue-workflows.test.mjs` keeps
the required set honest: each required workflow must declare `merge_group`,
keep its check name, and (for the no op workflows) gate every real step to
`pull_request`.

Check names are the bare job `name`s, because branch protection matches the
check run name, not `Workflow / job`: `ci` (job `ci` in `ci.yml`) and
`provider-go-live` (job `provider-go-live` in `pr-body-gate.yml`).

### Rule for new required checks

Any workflow that becomes a required check later, including the automerge
eligibility check (OVD-845) and the sensitive-class check (OVD-844), follows
the same pattern before it is added to protection:

1. Trigger on `merge_group` with `types: [checks_requested]`.
2. If the check reads PR-only data (body, labels, PR files API), add a first
   step `if: github.event_name == 'merge_group'` that echoes a no op, and gate
   every other step on `github.event_name == 'pull_request'`. The
   `pull_request` run enforces the rule; the queue run only reports success.
3. If the check validates code, run it for real on the queue commit (like
   `ci.yml`). Its concurrency group must not collide across queue entries;
   fall back to `github.ref` or `github.sha` when there is no PR number.
4. Add it to `REQUIRED_CHECKS` in `scripts/merge-queue-workflows.test.mjs` and
   to the required checks list below.

## Current settings snapshot

Fill in immediately before applying, from read-only calls:

```bash
gh api repos/optomachina/Overdrafter/branches/main/protection > /tmp/ovd854-protection-before.json
gh api repos/optomachina/Overdrafter/rulesets > /tmp/ovd854-rulesets-before.json
```

| Setting | Value before (fill in) |
| --- | --- |
| `required_status_checks.contexts` | `<ci, provider-go-live>` |
| `required_status_checks.strict` | `<false>` |
| `enforce_admins.enabled` | `<...>` |
| Required reviews | `<...>` |
| Existing rulesets on `main` | `<none?>` |
| Allowed merge methods (repo settings) | `<...>` |

## Drafted settings

| Setting | Value |
| --- | --- |
| Required checks | `ci`, `provider-go-live` (GitHub Actions app). Unchanged. |
| Strict (require branches up to date) | off. The queue replaces it. Unchanged (already `false`). |
| `enforce_admins` | unchanged |
| Merge queue | on, `main` only |
| Merge method | squash (`SQUASH`) |
| Build concurrency (`max_entries_to_build`) | 1 |
| Group size (`min_entries_to_merge` / `max_entries_to_merge`) | 1 / 1 |
| Min group wait (`min_entries_to_merge_wait_minutes`) | 0 (group size 1 never waits for company) |
| Check timeout (`check_response_timeout_minutes`) | 60 (longest `ci` path is the 30 minute SQL qualifications plus the 5 minute aggregate) |
| Status check requirement (`grouping_strategy`) | `ALLGREEN`: require all queue entries to pass required checks |

The classic protection keeps the required checks; the queue is a repository
ruleset, because the classic protection REST endpoint cannot enable a merge
queue. The queue waits on the classic required checks as well as any in the
ruleset.

### Apply command

> **DO NOT RUN. Requires Blaine's approval card. Grok Bot applies only after
> approval**, with the card naming this runbook's commit SHA.

```bash
# DO NOT RUN without Blaine's approval card (Grok Bot applies).
gh api --method POST repos/optomachina/Overdrafter/rulesets --input - <<'JSON'
{
  "name": "main merge queue (OVD-854)",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "rules": [
    {
      "type": "merge_queue",
      "parameters": {
        "merge_method": "SQUASH",
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 1,
        "min_entries_to_merge": 1,
        "max_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 0,
        "check_response_timeout_minutes": 60
      }
    }
  ]
}
JSON
```

Record the returned ruleset `id` on the Linear issue; rollback needs it.
Classic protection (`required_status_checks`, `strict: false`,
`enforce_admins`) is not touched. If the snapshot shows `strict: true`, stop and
ask; the drafted state assumes `false`.

## Operating the queue

- **Pinned SHA.** The commit that lands on `main` is the queue commit
  (`gh-readonly-queue/main/pr-<n>-<sha>`) that passed the checks, not the PR
  head. Approval cards and evidence for merged work cite the merged squash SHA
  on `main`; the PR head SHA is the reviewed input, not the shipped commit.
- **Failing entry.** A queue entry whose required check fails is removed from
  the queue. The author fixes it on the PR branch and re-queues. Entries behind
  it rebuild on the new queue state.
- **Infra flakes.** Runner loss, install or network failures before a stage
  starts: re-run the failed job on the queue run, or re-queue the PR if the
  entry was already removed. This does not consume a repair round (AGENTS.md).
  Never fix an infra flake with a code change.
- **Cancelled runs never count as a pass.** A cancelled or timed-out queue run
  is a failure; re-queue rather than force merge.
- **Auto-merge.** Low-risk auto-merge (AGENTS.md) enqueues the PR instead of
  merging it directly; it still merges only after the queue run is green.

## Rollback

Disable or delete the ruleset (Blaine-approved protection change, same as
applying):

```bash
# DO NOT RUN without Blaine's approval card (Grok Bot applies).
gh api --method PUT repos/optomachina/Overdrafter/rulesets/<ruleset-id> -f enforcement=disabled
```

PRs in the queue drop out and merge directly again under classic protection.
The `merge_group` triggers stay in the workflows; with no queue they never fire,
so they are harmless and need no revert.

## Dry-run checklist (after approval and apply)

1. Snapshot recorded above; ruleset `id` recorded on the issue.
2. Enqueue a trivial docs PR. Confirm a `merge_group` run starts on
   `gh-readonly-queue/main/...`, that `ci` and `provider-go-live` both report on
   the queue commit, and that the PR merges as one squash commit whose SHA on
   `main` equals the tested queue commit SHA.
3. Enqueue two PRs where the first has a deliberate failure in a `ci`
   dependency (for example a failing test in a throwaway PR). With build
   concurrency 1 only the first builds. Confirm it fails, is removed, and the
   second then builds on `main` without the first and merges.
4. Confirm `proof-check` reports success on the queue run (no op).
5. Close the throwaway PR and delete its branch.
