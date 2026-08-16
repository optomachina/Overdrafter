# Solo Linear Workflow (Free Plan)

This workflow is designed for one developer using a free Linear account, with implementation support from Codex and Claude Code.

## Daily default routine

1. Classify the request as an active-release defect, a promoted slice, or a
   deferred idea.
2. For a deferred idea, add it and its evidence link to the Linear Product
   Portfolio & Future Capability Index, assign one incubator route, and stop.
3. For an active defect or promoted slice, search for an existing issue, then
   create or update one using `docs/linear-templates/` only when needed.
4. Run `.agents/skills/linear-triage-router` to normalize category, priority, labels, and missing information.
5. Run `.agents/skills/linear-feature-scoper` (or `bug-investigation` for defects) to produce a minimal plan and test strategy.
6. Create a branch named with the Linear issue ID (for example: `feature/OVD-142-copy-rfq-link`).
7. Implement with `.agents/skills/implement-linear-issue`.
8. Run QA with `.agents/skills/qa-regression-check` and `docs/checklists/qa-checklist.md`.
9. Open a PR using `.github/pull_request_template.md` and keep its link in the single rolling Linear comment.
10. After every required validation passes, set the rolling comment to **Ready
    for review** and move Linear to **Human Review**.
11. When a human authorizes landing the reviewed PR, move Linear to **Merging**
    and use the `land` skill. After the PR is confirmed merged, set the comment
    to **Complete** and move Linear to **Done** automatically unless an
    acceptance criterion still requires post-merge work.

## New feature flow

1. Add the idea and evidence link to the portfolio index.
2. Apply the promotion gate in `ROADMAP.md`; do not create an issue if it fails.
3. If promoted, create or reuse one bounded issue using `ui-feature-template.md`.
4. Ask `linear-triage-router` to classify and normalize.
5. Ask `linear-feature-scoper` to produce implementation-ready scope.
6. Branch from the issue ID and ask the implementer to execute.
7. Ask `qa-regression-check` or `qa-reviewer` to validate.
8. Open the PR and follow the rolling-comment and status gates in `AGENTS.md`.

## Bug flow

1. Create issue using `bug-report-template.md`.
2. Run `bug-investigation` first.
3. If reproducible and scoped, implement with smallest safe fix.
4. Run QA/regression checks.
5. Open the PR and follow the rolling-comment and status gates in `AGENTS.md`.

## Billing flow

1. Confirm the commercial slice is active and passed the promotion gate;
   otherwise update its portfolio evidence and stop without creating an issue.
2. If promoted, create or reuse an issue with `billing-feature-template.md`.
3. Route conservatively (higher risk by default).
4. Scope with billing specialist guardrails.
5. Confirm backend, webhooks, entitlements, UI, and failure handling.
6. Implement in small safe slices and test success and failure cases.
7. Open a PR with explicit risk and rollback notes.
8. Follow the rolling-comment and status gates in `AGENTS.md`.

## Example A: small UI feature

Assume this request already passed the promotion gate: “Add a Copy RFQ link
button next to the part number and show a success toast.”

- Raw request is captured in Slack.
- Create `OVD-101` in Linear via `ui-feature-template.md`.
- Scope: identify component file, copy handler, toast usage, and test targets.
- Implement minimal UI + interaction changes.
- QA: verify button placement, clipboard success, and toast behavior.
- PR: title `OVD-101: add copy RFQ link button beside part number`.
- Update the rolling comment: In progress → Ready for review → Complete after
  the approved PR is confirmed merged. The corresponding Linear states are In
  Progress → Human Review → Merging → Done.

## Example B: Stripe billing feature

Request: “Add Stripe billing so free orgs can upgrade to Pro in settings.”

This belongs in the 1.1 release description and portfolio evidence until the
commercial model is approved. Create implementation issues only after that
slice is promoted. When promoted, decompose it as needed:

1. Billing UI entry point and plan selection.
2. Checkout session creation endpoint/service.
3. Webhook ingestion and idempotent event handling.
4. Entitlement sync and org plan-state updates.
5. Failure-state UX and retry/admin recovery paths.
6. QA plan for success/failure/replay scenarios.

Notes:

- Stripe/billing is never “just a button”.
- Webhooks drive source-of-truth state.
- Failure handling and logging are mandatory.
- Prefer split issues over one oversized change.
