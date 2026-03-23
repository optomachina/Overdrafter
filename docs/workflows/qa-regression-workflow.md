# QA & Regression Workflow

1. Start from issue acceptance criteria.
2. Review changed surfaces and adjacent risk areas.
3. Run `.agents/skills/qa-regression-check`.
4. Execute automated tests tied to changed behavior.
5. Execute manual checks from `docs/checklists/qa-checklist.md`.
6. Record pass/fail evidence with command output or screenshots where useful.
7. Flag missing tests and recommend follow-ups.
8. Update PR with verification details and unresolved risks.
