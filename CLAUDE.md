@AGENTS.md

## Claude Code

- Treat `npm run ci:local` as the canonical local mirror of required GitHub merge checks.
- Use scoped verification while iterating, but do not describe a code change as merge-ready until `npm run ci:local` passes or a documented exception applies.
- In PR bodies and workpad updates, distinguish clearly between `Scoped verification` and `CI-parity verification`.
- Docs-only or workflow-doc changes may use narrower verification when they do not affect runtime behavior, build behavior, test behavior, or repository automation.
