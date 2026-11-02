# Claude Code adapter

Follow `AGENTS.md` as the repository execution contract and the applicable product documents for scope. Use Claude-specific skills or hooks only when they materially improve the requested task; they do not add approval gates or alter ownership.

When a hosted check fails, apply the infra-versus-code rule in `AGENTS.md` before editing a test or a gate. A `cancelled` job is not a pass. Classify a new gate or safety file in the same PR. For Xometry page drift, follow `docs/provider-integration.md` and `.codex/skills/add-quote-provider/references/repair.md`, and do not overlap another open vendor-adapter PR.

For UI work, read `docs/DESIGN.md`. For verification and handoff, follow `docs/agent-development-control-plane.md`.

Agent routing: see `docs/agent-graph/graph.v1.yaml` (draft). Reviewer routing remains owned by `scripts/fixtures/agent-graph/model-routing.v2.yaml` and `scripts/agent-graph/built-by.mjs`, as documented in `docs/agent-pr-tags.md`. The draft graph's reviewer section is non-authoritative until it models builder-family routing.
