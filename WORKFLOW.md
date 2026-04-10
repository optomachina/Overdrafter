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
  max_concurrent_agents: 3
  max_turns: 3
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    Todo: 3
    In Progress: 3
    Rework: 3
    Merging: 1

codex:
  command: codex --config shell_environment_policy.inherit=all --model gpt-5.3-codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
  turn_timeout_ms: 3600000
---

# Symphony Adapter

You are working on Linear issue `{{ issue.identifier }}` in the Symphony project for the OverDrafter repository.

Title: {{ issue.title }}
State: {{ issue.state }}
Description:
{{ issue.description }}

`AGENTS.md` is the canonical behavioral contract for OverDrafter agent runs.
Symphony must follow the same planning, Linear rolling-comment, validation, complexity, demo, artifact, status-transition, and handoff rules defined there.

This file is only the Symphony execution wrapper: it configures workspace setup, issue-branch bootstrapping, concurrency, and Codex invocation.
Do not duplicate the full policy here.

Symphony lifecycle notes:
- Work only in the OverDrafter repo cloned into the current issue workspace.
- When starting a `Todo` issue, move the Linear issue to `In Progress` before implementation; Symphony does not perform this transition automatically.
- Run `./scripts/symphony-preflight.sh` before substantial work and before handoff.
- Never implement on `main`; the `before_run` hook switches to the deterministic issue branch, for example `OVD-29`.
- Reuse an existing matching local or remote issue branch instead of inventing a second branch.
- Use the repo-local skills in `.codex/skills/` when applicable.
- Use the `push` skill for publish flow; it owns pushing the branch and ensuring a PR exists.
- Use the `land` skill only when the issue is in `Merging` and the reviewed PR is ready to land.
- In `Human Review`, do not implement new changes unless review feedback explicitly moves the issue back to `Rework`; use `Human Review` for blocked/decomposition handoff instead of a separate Linear blocked state.
- In `Merging`, do not implement new code; land the reviewed PR or move the issue back to `Rework` if required checks are failing.
- In `Done`, do not make changes; `Complete` in the rolling Linear comment is still allowed only after explicit human confirmation under `AGENTS.md`.
