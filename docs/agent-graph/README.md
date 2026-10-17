# Agent graph spec

`graph.v1.yaml` is the single, tool-neutral definition of how work routes between OverDrafter agents. AGENTS.md, CLAUDE.md, Hermes config and Grok Bot skills are adapters: they point here and must not restate routing. Draft: runtimes are not wired yet. Bump `version` on any change; a change that loosens a gate needs the root agent's countersign and Blaine's OK.
