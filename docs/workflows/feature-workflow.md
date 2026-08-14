# Feature Workflow (Solo + Free Linear)

1. Classify the request against the active release and the promotion gate in `ROADMAP.md`.
2. If deferred, add the idea and evidence link to the Linear portfolio index and stop without creating an issue.
3. If promoted, search for an existing issue, then create one from `ui-feature-template.md` only when needed.
4. Use `linear-triage-router` to classify and identify missing details.
5. Use `linear-feature-scoper` to create implementation-ready scope.
6. Restate acceptance criteria before coding.
7. Create branch `feature/<ISSUE-ID>-<slug>`.
8. Implement the smallest safe change that satisfies acceptance criteria.
9. Run tests, risk-appropriate checks, and the QA/regression checklist.
10. Open a PR with the issue ID and structured verification evidence.
11. Keep the PR link in the single rolling Linear comment and follow the status gates in `AGENTS.md`.
