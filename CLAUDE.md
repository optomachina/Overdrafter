# Claude Code Adapter

Repo operating policy lives in `AGENTS.md`.
Claude Code must treat `AGENTS.md` as the canonical behavioral contract for planning, Linear updates, rolling progress comments, validation gates, complexity classification, demo artifacts, status transitions, and handoff.

Claude-specific notes:
- Read `AGENTS.md` before implementation or review work.
- Do not duplicate policy from `AGENTS.md` here.
- If Claude-specific behavior needs to become durable repo policy, update `AGENTS.md` first and keep this file as a pointer.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
