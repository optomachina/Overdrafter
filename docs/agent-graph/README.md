# Agent graph spec

`graph.v1.yaml` is the single, tool-neutral definition of how work routes between OverDrafter agents. AGENTS.md, CLAUDE.md, Hermes config and Grok Bot skills are adapters: they point here and must not restate routing. Draft: runtimes are not wired yet. Bump `version` on any change; a change that loosens a gate needs the root agent's countersign and Blaine's OK.

`node scripts/validate-agent-graph.mjs` fails closed on policy, not only shape. The graph must keep the mandatory routes (sensitive scope goes to Release from triage and to Opus from Jev, QA hands off to the merge gate, and protected merges go to Release) and every mandatory merge gate. Default-path review must span two model families, counting only unconditional reviewer edges. A QA verdict may carry over a rebase only when the recomputed `diff_id` is equal (`rebase_reuse: diff-id-equal`); an equal patch ID is never enough, and a `diff_id` failure rejects reuse (`rebase_reuse_on_error: reject`).
