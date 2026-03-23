# Bug Workflow (Solo + Free Linear)

1. Open a Linear issue with `docs/linear-templates/bug-report-template.md`.
2. Confirm expected vs actual behavior and reproducibility.
3. Run `.agents/skills/bug-investigation`.
4. Separate evidence from hypotheses.
5. Draft minimal safe fix direction.
6. Implement on issue branch (`fix/<ISSUE-ID>-<slug>`).
7. Run targeted tests first, then broader verification.
8. Run `docs/checklists/bugfix-checklist.md` and `docs/checklists/qa-checklist.md`.
9. Open PR with Linear issue ID in title.
10. Update Linear status and link PR manually.
