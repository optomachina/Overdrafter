# Claude Code adapter

Follow `AGENTS.md` as the repository execution contract and the applicable product documents for scope. Use Claude-specific skills or hooks only when they materially improve the requested task; they do not add approval gates or alter ownership.

For UI work, read `docs/DESIGN.md`. For verification and handoff, follow `docs/agent-development-control-plane.md`.

Agent routing: see `docs/agent-graph/graph.v1.yaml` (draft). Reviewer routing remains owned by `scripts/fixtures/agent-graph/model-routing.v2.yaml` and `scripts/agent-graph/built-by.mjs`, as documented in `docs/agent-pr-tags.md`. The draft graph's reviewer section is non-authoritative until it models builder-family routing.
