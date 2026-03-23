# Solo Linear Workflow (Free Plan)

This workflow is designed for one developer using a free Linear account, with implementation support from Codex and Claude Code.

## Daily default routine

1. Capture the request from Slack, notes, or a quick brainstorm.
2. Create or update a Linear issue manually using one of the templates in `docs/linear-templates/`.
3. Run `.agents/skills/linear-triage-router` to normalize category, priority, labels, and missing information.
4. Run `.agents/skills/linear-feature-scoper` (or `bug-investigation` for defects) to produce a minimal plan and test strategy.
5. Create a branch named with the Linear issue ID (for example: `feature/OD-142-copy-rfq-link`).
6. Implement with `.agents/skills/implement-linear-issue`.
7. Run QA with `.agents/skills/qa-regression-check` and `docs/checklists/qa-checklist.md`.
8. Open a PR using `.github/pull_request_template.md`.
9. Copy the PR link to Linear, move status to **In Review**, then to **Done** after merge.

## New feature flow

1. Create issue using `ui-feature-template.md`.
2. Ask `linear-triage-router` to classify and normalize.
3. Ask `linear-feature-scoper` to produce implementation-ready scope.
4. Branch from the issue ID.
5. Ask implementer to execute.
6. Ask `qa-regression-check` or `qa-reviewer` to validate.
7. Open PR with the template.
8. Update Linear manually.

## Bug flow

1. Create issue using `bug-report-template.md`.
2. Run `bug-investigation` first.
3. If reproducible and scoped, implement with smallest safe fix.
4. Run QA/regression checks.
5. Open PR and update/close the Linear issue.

## Billing flow

1. Create issue using `billing-feature-template.md`.
2. Route conservatively (higher risk by default).
3. Scope with billing specialist guardrails.
4. Confirm backend, webhooks, entitlements, UI, and failure handling.
5. Implement in small safe slices.
6. Test success and failure cases.
7. Open PR with explicit risk and rollback notes.
8. Update Linear manually.

## Example A: small UI feature

Request: “Add a Copy RFQ link button next to the part number and show a success toast.”

- Raw request is captured in Slack.
- Create `OD-101` in Linear via `ui-feature-template.md`.
- Scope: identify component file, copy handler, toast usage, and test targets.
- Implement minimal UI + interaction changes.
- QA: verify button placement, clipboard success, and toast behavior.
- PR: title `OD-101: add copy RFQ link button beside part number`.
- Update Linear: In Progress → In Review → Done.

## Example B: Stripe billing feature

Request: “Add Stripe billing so free orgs can upgrade to Pro in settings.”

Break into child issues when needed:

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
