import json
cur=open('/workspace/ovd/prot.pretty.json').read().rstrip()
A=15368
def checks(names): return {"strict":True,"checks":[{"context":n,"app_id":A} for n in names]}
CUR=["ci","provider-go-live"]
FINAL=CUR+["sensitive-class","same-sha-verdict","model-label"]
j=lambda o: json.dumps(o,indent=2)
full={"required_status_checks":checks(FINAL),"enforce_admins":True,"required_pull_request_reviews":None,"restrictions":None,
 "required_linear_history":False,"allow_force_pushes":False,"allow_deletions":False,"block_creations":False,
 "required_conversation_resolution":False,"lock_branch":False,"allow_fork_syncing":False}
fullcur=dict(full); fullcur["required_status_checks"]=checks(CUR)
R="repos/optomachina/Overdrafter/branches/main/protection"
def patch(names): return f"""gh api -X PATCH {R}/required_status_checks \\
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{json.dumps(checks(names))}
JSON"""
doc=f"""# OVD-921: branch-protection and required-check diff for `main`

> # ⛔ DO NOT APPLY
> **Applied only via Blaine's card through Grok Bot.** Release prepared this document read-only and did not apply anything. Per OVD-921 AC4 and the OVD-840 decision, a branch-protection change needs Blaine's approval card. Making a check required is also a gate change, so per plan §6 it needs a Grok Bot countersign.

- Prepared by Overdrafter Release, 2026-10-17 (America/Phoenix), against `main` @ `d88d5df` (#833).
- Repo: `optomachina/Overdrafter`. Owner type `User`, public. No merge queue (Option B, strict, per `docs/runbooks/merge-queue.md`).
- Sources: `gh api {R}`, `gh api repos/optomachina/Overdrafter/rulesets`, `gh api repos/optomachina/Overdrafter/rules/branches/main`, `.github/workflows/*.yml` on main, PR #813 and #831 heads, and the check-run names on the last 40 PRs' head SHAs.

## 0. Correction to the brief: `enforce_admins` is currently ON
The brief says enforce_admins and code-owner settings are both OFF today. Live state disagrees:
- **`enforce_admins.enabled` is `true`.** Blaine approved it with Option B on 2026-10-16 (`docs/runbooks/merge-queue.md` lines 3-10 and 287).
- **Code-owner review is OFF.** There is no `required_pull_request_reviews` block at all, so code-owner reviews and approving reviews are both not required. `.github/CODEOWNERS` exists but nothing enforces it. That is correct, because agent PRs are authored as `optomachina`, and an author can't approve their own PR.

This diff **leaves both settings exactly as they are**: enforce_admins stays `true`, and reviews stay absent (code owners OFF). If Blaine meant enforce_admins to be OFF, that is a separate decision for a separate card. This diff does not change it.

## 1. CURRENT state (verbatim, nothing redacted)

### 1a. `gh api {R}`
```json
{cur}
```

### 1b. Rulesets
`gh api repos/optomachina/Overdrafter/rulesets` returned:
```json
[]
```
`gh api repos/optomachina/Overdrafter/rules/branches/main` returned:
```json
[]
```
No rulesets exist, so there are no per-ruleset details to fetch. Classic branch protection is the only gate.

## 2. PROPOSED state

### 2a. Check names: what exists today
Branch protection matches the bare check-run name, which is the job `name:`, not `Workflow / job`. Every check below is created by GitHub Actions, `app_id` 15368, the same as the existing two.

| Ask | Check name (exact) | Exists on main? | Evidence | Must land first |
|---|---|---|---|---|
| keep | `ci` | yes | `ci.yml` job `ci`, `if: always()`, aggregates 11 jobs. Present on all 40 sampled PR heads. | — |
| keep | `provider-go-live` | yes | `pr-body-gate.yml` job `provider-go-live`. Has a merge_group no-op. | — |
| (a) blocking sensitive-path | **`sensitive-class`** | **NO** | `.github/workflows/sensitive-class.yml`, job `name: sensitive-class`, exists only on PR **#813** (draft, head `47ad2fa`). Its check run shows up on 4 PR heads (github-actions). It is **report mode**: the job always exits 0 and the header says "is not a required check". The only sensitive-path logic on main today is the "Secret path block" step inside `secret-scan` (`secret-scan.yml`). That step is report mode, the job is `continue-on-error: true`, it has no merge_group trigger, and it covers secrets, not the sensitive classes. | PR #813 (OVD-844, after #818 / OVD-873) merged, **then** a follow-up PR that switches `sensitive-class` to blocking (see 2c). |
| (b) same-SHA QA/review status | **`same-sha-verdict`** (proposed name) | **NO, no workflow or status context exists** | No check run or commit status like this appears on any of the last 40 PR heads. The only statuses seen are `CodeRabbit` and `Vercel`. `qa-handoff` (`qa-handoff.yml`) runs on `workflow_run`, so its check run attaches to the default-branch SHA, not the PR head, and it can't be required. `verify` (`verify.yml`) is the verify skill at head, not QA's verdict. The `overdrafter.verdict/v1` emitter and validator (`scripts/emit-verdict.mjs`, `scripts/verdict-schema.mjs`, OVD-851) are on main. Nothing yet turns a verdict into a status check. The OVD-845 `automerge-eligible` check (Backlog) reads the verdict, but its `neutral` "needs Blaine" conclusion counts as passing for a required check, so it isn't a same-SHA gate. | A new workflow (Engineer, OVD-921 AC2) whose job/check-run name is exactly `same-sha-verdict`. If the Engineer picks another name, update this doc before the card. |
| (c) model-label | **`model-label`** (proposed name) | **NO, no workflow exists** | PR **#831** adds only `docs/agent-graph/model-routing.yaml`, `AGENTS.md`, and `scripts/model-routing-drift.test.mjs`, with no workflow. No `model*` check appears on any sampled PR. | PR #831 (OVD-896/OVD-919) merged, **then** a new workflow with job name exactly `model-label`, report mode first per OVD-896. |

**Plain statement: none of the three new checks exists as a workflow on `main` today.** `sensitive-class` exists only in draft PR #813, in report mode. `same-sha-verdict` and `model-label` don't exist anywhere yet.

### 2b. Proposed final `required_status_checks`
`strict: true` is kept, and `ci` and `provider-go-live` are kept unchanged.
```json
{j(checks(FINAL))}
```

The equivalent full-protection PUT body (only `required_status_checks.checks` differs from current; every other field mirrors the live values):
```json
{j(full)}
```
(`required_signatures` isn't part of the PUT body. It stays `false`, and the PATCH below doesn't touch it.)

### 2c. Preconditions each new check must meet before it goes into protection
These come from `docs/runbooks/merge-queue.md` "Rule for new required checks", plus OVD-921 AC5.
1. Runs on **every** PR. No `paths:` filter. No job-level `if:`, because a skipped job never reports success. Triggers include `merge_group: [checks_requested]` with a no-op step.
2. Runs from trusted code: a base checkout or `workflow_run` / `issue_comment`, never PR-head code. It is added to `REQUIRED_CHECKS` in `scripts/merge-queue-workflows.test.mjs`.
3. Dry run against the last 20 merged PRs shows no false blocks (AC5).
4. Check-specific:
   - `sensitive-class`: an enforce mode where the job **fails** when the detector status isn't `ok` (error, unknown, missing, or partial; architect requirement on OVD-845). It also fails when the PR touches a sensitive class without the recorded Blaine-card approval for the head SHA. The exact pass condition is the Engineer's design under OVD-844/845. It must still report on `edited`/retarget, which it already does.
   - `same-sha-verdict`: QA posts its verdict as a PR comment **after** CI, so a plain `pull_request` job would run too early and never re-run. The workflow must trigger on `issue_comment` (created) and on `pull_request` (`opened`/`synchronize`/`reopened`/`ready_for_review`, which marks the new SHA as failing or pending until a verdict arrives). It writes a **check run** through the Checks API with `GITHUB_TOKEN` (`checks: write`) on the PR **head SHA**, so it carries app_id 15368. Pass only when a valid `overdrafter.verdict/v1` PASS/PASS_NOTES from a non-author verifier names the current head SHA (or the same `git patch-id` after a merge of main, per OVD-851), and the review state is for that SHA too.
   - `model-label`: triggers on `pull_request` `opened`/`synchronize`/`reopened`/`ready_for_review`/`labeled`/`unlabeled`. Fails if there is no `model:*` label, an unknown label, or a label that disagrees with `docs/agent-graph/model-routing.yaml` (from the base checkout). Coordinate with OVD-919 tiers.
5. **`scripts/qa-handoff/gate.mjs` must exclude `same-sha-verdict` before stage 3** (see risk R5).

## 3. Commands (DO NOT RUN; for Blaine's card via Grok Bot)
Use the narrow `PATCH .../required_status_checks` sub-resource. It changes only the check list and `strict`, and leaves `enforce_admins`, reviews, signatures, and the rest untouched. Apply in stages, one check per card, each only after that check meets 2c. Capture a fresh snapshot first:
```bash
gh api {R} > /tmp/ovd921-protection-before.json
gh api repos/optomachina/Overdrafter/rulesets > /tmp/ovd921-rulesets-before.json
```
**Stage 1: add `sensitive-class`** (after #813 and the enforce-mode PR merge)
```bash
{patch(CUR+["sensitive-class"])}
```
**Stage 2: add `model-label`** (after #831 and the `model-label` workflow merge and leave report mode)
```bash
{patch(CUR+["sensitive-class","model-label"])}
```
**Stage 3: add `same-sha-verdict`** (final state, equal to 2b)
```bash
{patch(FINAL)}
```
Single-shot alternative (only if all three are ready at once), as a full PUT:
```bash
gh api -X PUT {R} -H "Accept: application/vnd.github+json" --input - <<'JSON'
{json.dumps(full)}
JSON
```
**Rollback: restore the exact current check set**
```bash
{patch(CUR)}
```
Full-PUT rollback (restores the whole current protection, including enforce_admins `true`):
```bash
gh api -X PUT {R} -H "Accept: application/vnd.github+json" --input - <<'JSON'
{json.dumps(fullcur)}
JSON
```

## 4. Risks
- **R1. A check that never reports blocks every PR.** With `enforce_admins: true`, even `optomachina` (admin) can't merge past a pending required check. The only way out is the rollback PATCH, which needs admin. Causes: a `paths:` filter, a job-level `if:`, a workflow that skips when the base lacks its script (both `sensitive-class.yml` and `qa-handoff.yml` have "SKIPPED, base has no script" branches), a missing `merge_group` trigger if a queue is ever enabled, or `issue_comment` workflows that never fire. Mitigations: stage one check at a time, preconditions 2c, and the verification in §5. Roll back immediately if a fresh PR doesn't get the check within 30 minutes.
- **R2. Check name drift.** Protection matches the exact job `name:` and `app_id` 15368. Renaming a job, moving it into a reusable workflow (which renames it `caller / job`, the way `ovd591-qualification / capability-sql` reads), or posting it as a commit status instead of a check run silently turns it into a check that never reports (R1). `same-sha-verdict` and `model-label` are proposed names. The Engineer must use them verbatim or this doc gets updated before the card. Pin the names in `scripts/merge-queue-workflows.test.mjs`. Also keep `REQUIRED_CHECKS: ci,provider-go-live` in `qa-handoff.yml` and `DEFAULT_REQUIRED_CHECKS` in `scripts/qa-handoff/gate.mjs` in step with protection.
- **R3. Agent PRs are authored as `optomachina`.** (i) Code-owner or approving-review requirements would deadlock, because the author can't approve. They stay OFF. (ii) `optomachina` has admin and write, so it can post commit statuses with any context. That's why every check is pinned to `app_id` 15368 (GitHub Actions) and `same-sha-verdict` must be a check run, not a status. Never use `app_id: -1` (any source). (iii) Same-repo `pull_request` workflows get a write-capable `GITHUB_TOKEN` if a PR edits a workflow's `permissions:`. A PR that edits `.github/workflows/sensitive-class.yml` (or adds a workflow with the same job name under app 15368) could report a fake green. `sensitive-class` must itself flag any `.github/**` change as sensitive. `same-sha-verdict` should run only from default-branch code (`issue_comment` / `workflow_run`).
- **R4. Strict plus same-SHA churn.** `strict: true` forces an update-branch (a new head SHA) whenever main moves. Without patch-id carry-over, every update invalidates QA's verdict and needs a re-confirm, as on #803 (QA re-confirms at `c1fc562b`). `same-sha-verdict` must implement the OVD-851 patch-id carry-over.
- **R5. QA-handoff deadlock.** `qa-handoff` reads the required set from branch protection and hands a PR to QA only when **all** required checks are green. If `same-sha-verdict` is required, it is pending until QA posts, and QA is never handed the PR. `gate.mjs` must exclude it first. Also add the new checks' workflows (`Sensitive class`, the model-label workflow) to `qa-handoff.yml` `workflow_run.workflows`, or handoff fires only when CI or PR body gate finishes. The Mac mini backstop fills that gap hourly.
- **R6. Open PRs at apply time.** About 20 PRs are open. Each needs a new push or re-run to get the new check, and they all show BLOCKED until then.

## 5. Verification after applying (each stage)
```bash
# 1. Protection matches the intended state exactly
gh api {R} --jq '{{strict: .required_status_checks.strict, checks: .required_status_checks.checks, enforce_admins: .enforce_admins.enabled, reviews: .required_pull_request_reviews}}'
#    expect strict=true, enforce_admins=true, reviews=null, checks = the stage's list, every app_id 15368
gh api repos/optomachina/Overdrafter/rulesets   # expect [] (unchanged)

# 2. Each new check reports on a fresh PR head, from GitHub Actions
SHA=$(gh pr view <PR> -R optomachina/Overdrafter --json headRefOid --jq .headRefOid)
gh api "repos/optomachina/Overdrafter/commits/$SHA/check-runs?per_page=100" \\
  --jq '.check_runs[] | select(.name|IN("ci","provider-go-live","sensitive-class","model-label","same-sha-verdict")) | [.name,.status,.conclusion,.app.id] | @tsv'
gh pr checks <PR> -R optomachina/Overdrafter --required
gh pr view <PR> -R optomachina/Overdrafter --json mergeStateStatus   # expect not BLOCKED once the checks pass

# 3. QA handoff still fires: the latest qa-handoff run logs the new required list and still hands off
gh run list -R optomachina/Overdrafter --workflow qa-handoff.yml --limit 3
```
Pass when steps 1-3 hold on one docs-only PR and one sensitive PR within 30 minutes. Otherwise run the rollback PATCH and re-check step 1 shows only `ci` and `provider-go-live`.
"""
open('/workspace/ovd921-branch-protection-diff.md','w').write(doc)
print(len(doc))
