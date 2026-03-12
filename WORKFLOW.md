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
    NPM_BIN="$(command -v npm || true)"
    if [ -z "$NPM_BIN" ] && [ -x /opt/homebrew/bin/npm ]; then
      NPM_BIN=/opt/homebrew/bin/npm
    fi
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
  timeout_ms: 3600000

agent:
  max_concurrent_agents: 5
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
---

# OverDrafter Symphony Workflow

You are working on Linear issue {{ issue.identifier }} in the Symphony project for the OverDrafter repository.

Title: {{ issue.title }}
State: {{ issue.state }}
Preferred branch: {{ issue.branch_name }}

Description:
{{ issue.description }}

Operate with these repo rules:

- Work only in the OverDrafter repo cloned into the current issue workspace.
- Run `./scripts/symphony-preflight.sh` before substantial work and before handoff.
- Use the repo-local skills in `.codex/skills/`.
- Keep the diff tightly scoped to the current issue.
- Update docs when repo workflow or product behavior changes.

State behavior:

- `Todo`, `In Progress`, `Rework`: create or switch to the issue branch before any edits, then implement the issue, run targeted verification, commit, push, and open or update a PR before handing off to `Human Review`.
- `Human Review`: do not implement new changes unless review feedback explicitly moves the issue back to `Rework`.
- `Merging`: do not implement new code. Use the `land` skill to land the reviewed PR safely. If no PR exists, stop and report that the issue was moved to `Merging` too early.
- `Done`: only after the PR is actually merged.

Branch rules:

- Never implement on `main`.
- Before editing on `Todo`, `In Progress`, or `Rework`, run `./scripts/symphony-ensure-branch.sh "<target-branch>"`.
- Prefer the Linear branch suggestion shown above. If it is blank, derive a focused branch name from the issue identifier and title.
- If the issue already has a remote branch, reuse it instead of inventing a second branch.

Handoff requirements:

- Report the exact verification commands and outcomes.
- If blocked, explain the blocker precisely and identify the correct state to return to.
- Do not claim completion from local diffs alone when the workflow expects a landed PR.
