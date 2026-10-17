# Merge queue for `main` (OVD-854)

Status: **Option B (strict) and `enforce_admins` were approved by Blaine on
2026-10-16 and are now in force.** A read-back of the protection on 2026-10-16
after they were applied showed `strict` and `enforce_admins` both `true`, with
`ci` and `provider-go-live` as the required checks. To re-verify the live
settings, run:

```bash
gh api repos/optomachina/Overdrafter/branches/main/protection --jq '{strict: .required_status_checks.strict, enforce_admins: .enforce_admins.enabled}'
```

The `land` skill (`.codex/skills/land/SKILL.md`, step 8) handles strict mode
through `.codex/skills/land/land_strict_merge.sh` (OVD-889). It brings an
out-of-date PR current with the update-branch API as a merge (never a rebase or
force push), proves the new head is that merge, waits for `ci` and
`provider-go-live` on the new head, and merges with
`gh pr merge --match-head-commit <head>`, failing closed on any mismatch,
timeout or unknown state. The manual fallback is the same sequence by hand:
`gh pr update-branch`, re-check state, head and both checks on the new head,
then `gh pr merge --match-head-commit <head>`. The `gh api` commands under Option B
stay here as the rollback and re-apply reference. **Option A (merge queue) is
not applied** and still needs the repo moved to an organization. Any further change
to branch protection is a protected action that needs Blaine's approval card,
and Grok Bot applies it only after approval.

**Blocker: the merge queue (Option A) cannot be applied to this repo as it is
owned today.** GitHub's docs say: "Pull request merge queues are available in
any public repository owned by an organization, or in private repositories
owned by organizations using GitHub Enterprise Cloud"
([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
`optomachina/Overdrafter` is a public repo owned by a **User** account (read-only
check at OVD-854: `gh api repos/optomachina/Overdrafter --jq .owner.type`
returned `User`). Two separate decisions for Blaine follow:

1. **Prerequisite for Option A:** move the repo to an organization. This is its
   own decision and is out of scope for OVD-854. See
   [Prerequisite: organization ownership](#prerequisite-organization-ownership).
2. **Option B, applicable now:** turn on `strict: true` ("Require branches to be
   up to date before merging") on the classic branch protection. Approved by
   Blaine on 2026-10-16 together with `enforce_admins`, and now in force (see
   Status). See
   [Option B: strict up to date checks](#option-b-strict-up-to-date-checks-applicable-now).

Option B is in force. Option A stays drafted so it can be applied once
the repo is org-owned.

## Why

Before Option B, `main` required `ci` and `provider-go-live` with
`strict: false` and had no merge queue, so a PR could merge green against a
stale base and break `main`. `strict: true` (now in force) fixes that by blocking the merge until the PR branch contains
the current `main` and the required checks have passed on it. Merges are then
serialised by hand (update the branch, wait for checks, merge). A merge queue
does the same job automatically: it builds each PR on top of the current `main`
(plus anything ahead of it in the queue), runs the required checks on that
commit, and merges only that tested commit.

## Workflow audit (merge_group triggers)

This matters for Option A only. Under Option B the `merge_group` triggers never
fire and are harmless.

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
keep its check name, have no job-level `if:` that could skip the job, and (for
the no op workflows) gate every real step to `pull_request`.

**`provider-go-live` is not re-checked by the queue.** Its `merge_group` run is
a no op pass. The rule is evaluated only on the PR's own `pull_request` run,
against the PR's merge base, never against the queue commit. That is by design
(the queue run has no PR body to read), so do not rely on the queue to catch a
provider enablement that only appears once the PR is combined with newer
`main`.

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
   every other step on `github.event_name == 'pull_request'`. Do not put an
   `if:` on the job itself: a skipped job never reports success. The
   `pull_request` run enforces the rule; the queue run only reports success.
3. If the check validates code, run it for real on the queue commit (like
   `ci.yml`). Its concurrency group must not collide across queue entries;
   fall back to `github.ref` or `github.sha` when there is no PR number.
4. Add it to `REQUIRED_CHECKS` in `scripts/merge-queue-workflows.test.mjs` and
   to the required checks list below.

## Current settings snapshot

Fill in immediately before applying either option, from read-only calls:

```bash
gh api repos/optomachina/Overdrafter --jq '{owner_type: .owner.type, visibility: .visibility, allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}' > /tmp/ovd854-repo-before.json
gh api repos/optomachina/Overdrafter/branches/main/protection > /tmp/ovd854-protection-before.json
gh api repos/optomachina/Overdrafter/rulesets > /tmp/ovd854-rulesets-before.json
```

| Setting | Value before (fill in) |
| --- | --- |
| `owner.type` | `<User>` (Option A needs `Organization`; if `User`, stop and use Option B) |
| `required_status_checks.contexts` | `<ci, provider-go-live>` |
| `required_status_checks.strict` | `<false>` |
| `enforce_admins.enabled` | `<false>` |
| Required reviews | `<...>` |
| Existing rulesets on `main` | `<none?>` |
| Allowed merge methods (repo settings) | `<...>` |

Values at drafting time (OVD-854, read-only): `owner.type` `User`, public;
checks `ci` and `provider-go-live` (app id 15368, GitHub Actions); `strict`
`false`; `enforce_admins` `false`.

## Prerequisite: organization ownership

Option A needs `optomachina/Overdrafter` to be transferred to a GitHub
organization (public org repos get merge queues on any plan). This is a
separate decision for Blaine, not part of OVD-854, because a transfer has
knock-on effects that each need their own check:

- Vercel: the Git integration and project link must be re-pointed to the org
  repo, and the Vercel team must have access to the org.
- Supabase: any GitHub integration (branching, migrations) must be reconnected.
- GitHub Actions secrets and variables: repo secrets move with the repo, but
  anything defined at the user level, and any app installations, must be
  re-granted on the org.
- URLs: GitHub redirects the old `optomachina/Overdrafter` URL, but remotes,
  badges, docs links, `gh api repos/optomachina/...` commands (including the
  ones in this runbook) and any webhook consumers should be updated.
- Branch protection, rulesets and required checks: re-verify after transfer
  with the snapshot step above.

Only once `owner.type` reads `Organization` does Option A apply.

## Option A: merge queue (needs org ownership)

### Drafted settings

| Setting | Value |
| --- | --- |
| Required checks | `ci`, `provider-go-live` (GitHub Actions app). Unchanged. |
| Strict (require branches up to date) | off. The queue replaces it. If Option B was applied first, set it back to `false` (Option B rollback) in the same approval. |
| `enforce_admins` | unchanged |
| Merge queue | on, `main` only |
| Merge method | squash (`SQUASH`) |
| Build concurrency (`max_entries_to_build`) | 1 |
| Group size (`min_entries_to_merge` / `max_entries_to_merge`) | 1 / 1 |
| Min group wait (`min_entries_to_merge_wait_minutes`) | 0 (group size 1 never waits for company) |
| Check timeout (`check_response_timeout_minutes`) | 90 (see below) |
| Status check requirement (`grouping_strategy`) | `ALLGREEN`: require all queue entries to pass required checks |

Check timeout: the longest `ci` path is `ovd591-qualification` (30 minute job
timeout) then `test` (`needs: ovd591-qualification`, 20 minutes) then the `ci`
aggregate (5 minutes): 55 minutes of job time before any runner queue wait.
60 would leave only 5 minutes of margin, so the draft uses 90.

The classic protection keeps the required checks; the queue is a repository
ruleset, because the classic protection REST endpoint cannot enable a merge
queue. The queue waits on the classic required checks as well as any in the
ruleset.

### Apply command

> **DO NOT RUN. Requires Blaine's approval card and an org-owned repo. Grok Bot
> applies only after approval**, with the card naming this runbook's commit
> SHA. On a User-owned repo this call fails or has no effect.

```bash
# DO NOT RUN without Blaine's approval card (Grok Bot applies).
# Precondition: gh api repos/<org>/Overdrafter --jq .owner.type == "Organization"
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
        "check_response_timeout_minutes": 90
      }
    }
  ]
}
JSON
```

Replace `optomachina` with the org name after the transfer. Record the returned
ruleset `id` on the Linear issue; rollback needs it. Classic protection
(`required_status_checks`, `enforce_admins`) is not touched.

### Operating the queue

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
- **Auto-merge and the `land` skill.** Low-risk auto-merge (AGENTS.md) enqueues
  the PR instead of merging it directly; it still merges only after the queue
  run is green. `.codex/skills/land/SKILL.md` (steps 9 to 11) must be updated
  in the same change that applies the queue: with a queue, `gh pr merge
  --squash --delete-branch` and `gh pr merge --auto --squash --delete-branch`
  enqueue the PR rather than merge it, the merge method comes from the ruleset
  (the `--squash` flag does not choose it), and branch deletion happens only
  after the queue merges (rely on the repo's `delete_branch_on_merge` setting).
  The skill's "record the merge, move to Done" step must wait for the PR state
  to read `MERGED` after the queue lands it, not run when the merge command
  returns.

### Rollback

Disable or delete the ruleset (Blaine-approved protection change, same as
applying):

```bash
# DO NOT RUN without Blaine's approval card (Grok Bot applies).
gh api --method PUT repos/optomachina/Overdrafter/rulesets/<ruleset-id> -f enforcement=disabled
```

PRs in the queue drop out and merge directly again under classic protection.
The `merge_group` triggers stay in the workflows; with no queue they never fire,
so they are harmless and need no revert.

### Dry-run checklist (after approval and apply)

1. Snapshot recorded above (`owner.type` is `Organization`); ruleset `id`
   recorded on the issue.
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

## Option B: strict up to date checks (applicable now)

Works on a User-owned repo. It closes the stale-base gap: a PR cannot merge
until its branch contains the current `main` and `ci` and `provider-go-live`
have passed on that state. It does not serialise automatically; after each
merge, every other open PR goes out of date and must be updated (which reruns
both checks, since both trigger on `synchronize`) before it can merge.

### Applied settings (in force since 2026-10-16)

| Setting | Before | After (approved and in force, 2026-10-16) |
| --- | --- | --- |
| `required_status_checks.strict` | `false` | `true` |
| `required_status_checks.checks` | `ci`, `provider-go-live` (app 15368) | unchanged |
| `enforce_admins` | `false` | `true` (approved with Option B; a separate setting from the call below) |
| Everything else in classic protection | as snapshotted | unchanged |

The call below targets the `required_status_checks` sub-resource with `PATCH`,
so it does not touch `enforce_admins`, reviews, or any other protection
setting. `enforce_admins` was approved with Option B but is a separate setting:
it is turned on in the branch protection settings UI, or with
`gh api --method POST repos/optomachina/Overdrafter/branches/main/protection/enforce_admins`
(rollback: the same path with `--method DELETE`). The `PATCH` call restates the
two required checks with their app id so they cannot be dropped or rebound to
another app. The commands below stay as the rollback and re-apply reference;
running either one again is a protected change that needs Blaine's approval
card.

### Apply command

> **Reference only: both settings are already in force (see Status).** Do not
> re-run this unless the read-back shows the protection has drifted, and then
> only with Blaine's approval card. Grok Bot applies protection changes only
> after approval, with the card naming this runbook's commit SHA.

```bash
# Reference only (already in force). Re-run only with Blaine's approval card.
gh api --method PATCH repos/optomachina/Overdrafter/branches/main/protection/required_status_checks --input - <<'JSON'
{
  "strict": true,
  "checks": [
    { "context": "ci", "app_id": 15368 },
    { "context": "provider-go-live", "app_id": 15368 }
  ]
}
JSON
```

Verify (read-only) that only `strict` and `enforce_admins` changed:

```bash
gh api repos/optomachina/Overdrafter/branches/main/protection > /tmp/ovd854-protection-after.json
diff <(jq -S . /tmp/ovd854-protection-before.json) <(jq -S . /tmp/ovd854-protection-after.json)
# Expected diff: required_status_checks.strict false -> true and
# enforce_admins.enabled false -> true; nothing else.
```

If the snapshot shows the required checks differ from `ci` and
`provider-go-live` (app 15368), stop and ask; the drafted call would overwrite
them.

### Operating under strict

- **Out-of-date PRs.** Update the branch (`gh pr update-branch <n>`, or the
  "Update branch" button), wait for `ci` and `provider-go-live` to pass on the
  new head, then merge. The merged commit is then tested against the `main`
  it lands on, unless another PR merged in between, in which case GitHub
  blocks the merge again.
- **Auto-merge and the `land` skill.** GitHub auto-merge does not update an
  out-of-date branch by itself; `gh pr merge --auto` waits until someone
  updates it. The `land` skill handles strict mode through
  `.codex/skills/land/land_strict_merge.sh` (`SKILL.md` steps 8 to 11,
  OVD-889). As a manual fallback, update an
  out-of-date PR with `gh pr update-branch`, wait for `ci` and
  `provider-go-live` on the new head, re-check the PR state and head by hand,
  and merge with `gh pr merge --match-head-commit <head>` pinned to the head
  you checked, so GitHub refuses the merge if the head moved. A "not up to
  date" block means update and re-check, never `Rework`.
- **Infra flakes and cancelled runs.** Same policy as the queue: re-run the
  failed job, never fix a flake with a code change, a cancelled run is not a
  pass.
- **`provider-go-live`** runs on the updated PR head, so under strict it is
  checked against the current `main` merge base.

### Rollback

```bash
# DO NOT RUN without Blaine's approval card (Grok Bot applies).
gh api --method PATCH repos/optomachina/Overdrafter/branches/main/protection/required_status_checks --input - <<'JSON'
{
  "strict": false,
  "checks": [
    { "context": "ci", "app_id": 15368 },
    { "context": "provider-go-live", "app_id": 15368 }
  ]
}
JSON
```

### Dry-run checklist (after approval and apply)

1. Snapshot recorded; the after/before diff shows only `strict` and
   `enforce_admins` changed.
2. Open two trivial docs PRs from the same `main`. Merge the first. Confirm
   the second shows "This branch is out-of-date" and cannot merge.
3. Update the second branch; confirm `ci` and `provider-go-live` rerun on the
   new head, then merge it.
4. Close any throwaway PR and delete its branch.
