# Claude Code adapter

Follow `AGENTS.md` as the repository execution contract and the applicable product documents for scope. Use Claude-specific skills or hooks only when they materially improve the requested task; they do not add approval gates or alter ownership.

The PreToolUse hook in `.claude/settings.json` is a best-effort guardrail on Edit/Write/Bash/MCP writes to `supabase/migrations/`. An agent holding a user token cannot be told apart from the user, so the real gate stays at Blaine's merge and apply approval. See "Migration window" in `AGENTS.md`.

For UI work, read `docs/DESIGN.md`. For verification and handoff, follow `docs/agent-development-control-plane.md`.
