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

hooks:
  after_create: |
    git clone https://github.com/optomachina/Overdrafter.git .
    ./scripts/symphony-preflight.sh
    npm ci
    npm --prefix worker ci
  before_run: |
    ./scripts/symphony-preflight.sh
    issue_id="$(basename "$PWD")"
    ./scripts/symphony-ensure-branch.sh "$issue_id"
  timeout_ms: 3600000

agent:
  max_concurrent_agents: 3
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    Todo: 3
    In Progress: 3
    Rework: 2
    Merging: 1

codex:
  command: bash ./scripts/symphony-agent.sh
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

# Symphony adapter

Work on Linear issue `{{ issue.identifier }}` in its isolated workspace.

Title: {{ issue.title }}
State: {{ issue.state }}
Description:
{{ issue.description }}

The configured launcher must admit the exact issue/workspace assignment before starting this app-server. Follow `AGENTS.md`. Treat repository and durable controller state as authoritative. Reuse the deterministic issue branch, preserve other owners' work, and update Linear only at meaningful lifecycle transitions. Continue through reversible implementation, targeted verification, PR creation, review repair, and authorized landing while the issue remains eligible.

If the same failure recurs three times, emit a causal blocker receipt and return it to the controller instead of renaming or blindly retrying the unit. Protected actions remain closed unless the exact action is currently authorized.
