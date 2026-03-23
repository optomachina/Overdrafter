# Feature Workflow (Solo + Free Linear)

1. Capture request and create Linear issue from `ui-feature-template.md` (or billing template if relevant).
2. Use `linear-triage-router` to classify and identify missing details.
3. Use `linear-feature-scoper` to create implementation-ready scope.
4. Restate acceptance criteria before coding.
5. Create branch `feature/<ISSUE-ID>-<slug>`.
6. Implement smallest safe change that satisfies acceptance criteria.
7. Run tests and checks appropriate to risk.
8. Run QA/regression checklist.
9. Open PR with issue ID and structured verification evidence.
10. Copy PR link to Linear and move issue through statuses manually.
