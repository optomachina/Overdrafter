---
tracker:
  kind: linear
  project_slug: "symphony-2adc02253734"
  active_states:
    - "Todo"
    - "In Progress"
    - "Rework"
    - "Merging"

polling:
  interval_ms: 30000

workspace:
  root: /Users/blainewilson/code/overdrafter-symphony-workspaces

hooks:
  after_create: |
    git clone https://github.com/optomachina/Overdrafter.git .
    ./scripts/symphony-preflight.sh
    NPM_BIN=""
    for candidate in /opt/homebrew/bin/npm npm /usr/local/bin/npm; do
      if [ "$candidate" = "npm" ]; then
        resolved_candidate="$(command -v npm || true)"
      else
        resolved_candidate="$candidate"
      fi

      if [ -n "$resolved_candidate" ] && [ -x "$resolved_candidate" ] && "$resolved_candidate" --version >/dev/null 2>&1; then
        NPM_BIN="$resolved_candidate"
        break
      fi
    done
    if [ -z "$NPM_BIN" ]; then
      echo "Symphony bootstrap failed: npm is not available in PATH." >&2
      exit 1
    fi
    "$NPM_BIN" ci
    (
      cd worker
      "$NPM_BIN" ci
    )
  before_run: |
    ./scripts/symphony-preflight.sh
    issue_id="$(basename "$PWD")"
    ./scripts/symphony-ensure-branch.sh "$issue_id"
  timeout_ms: 3600000

agent:
  max_concurrent_agents: 5
  max_retry_backoff_ms: 300000

codex:
  command: codex --config shell_environment_policy.inherit=all --model gpt-5.3-codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
  turn_timeout_ms: 3600000
---

# OverDrafter Symphony Workflow

You are working on Linear issue {{ issue.identifier }} in the Symphony project for the OverDrafter repository.

Title: {{ issue.title }}
State: {{ issue.state }}
Description:
{{ issue.description }}

Operate with these repo rules:

- Work only in the OverDrafter repo cloned into the current issue workspace.
- Run `./scripts/symphony-preflight.sh` before substantial work and before handoff.
- Use the repo-local skills in `.codex/skills/`.
- Use `push` as the publish skill. It is responsible for both pushing the branch and ensuring a PR exists.
- Keep the diff tightly scoped to the current issue.
- Run local Codex `/review` before the branch is handed off for PR review.
- Update docs when repo workflow or product behavior changes.

State behavior:

- `Todo`, `In Progress`, `Rework`: the workspace hook will switch to an issue branch before Codex starts. After that, implement the issue, run targeted verification, run local Codex `/review`, commit, use the `push` skill to publish the branch and ensure the PR exists, and keep the PR description concrete. When helpful, use the PR-body render and validate scripts as optional hygiene tooling.
- `Human Review`: do not implement new changes unless review feedback explicitly moves the issue back to `Rework`. Native GitHub Codex review and human review both happen in this state.
- `Merging`: do not implement new code. Use the `land` skill to land the reviewed PR safely. If no PR exists, stop and report that the issue was moved to `Merging` too early. If required checks are failing, move the issue back to `Rework`. If the PR is merely waiting on in-flight checks, keep it in `Merging`.
- `Done`: only after the PR is actually merged.

Human Review transition rule:

- After a scoped change is committed, pushed, attached to the Linear issue, and the verification plus local Codex review evidence is written to the workpad, ensure the PR exists and that its description matches the actual change before moving the issue to `Human Review`.
- Document whether local Codex `/review` found material issues and how they were resolved or deferred.
- If you used the PR-body helper flow, document whether `gh pr view --json body --jq .body | npm run validate:pr-body -- --stdin` passed and fix the PR body if it did not.
- If verification surfaces pre-existing unrelated repo failures outside the current issue scope, document them precisely in the workpad and still move to `Human Review`.
- Keep an issue in `In Progress` only when one of these is still true:
  - the scoped implementation is incomplete
  - the branch has not been pushed
  - no PR exists yet
  - the PR description is still materially incomplete or misleading for the current diff
  - the verification failure was introduced by the current change
  - local Codex `/review` has not been run yet
  - review feedback has already requested more implementation work
- Do not spend extra continuation turns chasing unrelated baseline repo debt after the PR and workpad handoff are complete.

Branch rules:

- Never implement on `main`.
- The `before_run` hook switches from `main` to a deterministic issue branch named from the Linear identifier, for example `OVD-29`.
- If a matching remote or local issue branch already exists, reuse it instead of inventing a second branch.

Handoff requirements:

- Report the exact verification commands and outcomes.
- Report that local Codex `/review` was run and summarize any unresolved findings.
- Report whether PR-body helper validation was run and its result when the helper flow was used.
- Distinguish clearly between issue-scoped failures and unrelated baseline repo failures.
- If blocked, explain the blocker precisely and identify the correct state to return to.
- Do not claim completion from local diffs alone when the workflow expects a landed PR.
