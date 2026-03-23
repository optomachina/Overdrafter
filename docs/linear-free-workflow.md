# Linear Free Plan Usage Guide (Solo Developer)

## Workspace setup recommendations

- Use one Linear team unless there is a strong reason to split.
- Keep workflow statuses simple: **Backlog**, **Todo**, **In Progress**, **In Review**, **Done**, **Canceled**.
- Keep labels minimal: `bug`, `feature`, `billing`, `spike`, `qa`, `refactor`.

## Issue hygiene

- Keep issues small and implementation-oriented.
- Use parent/child only when work clearly spans multiple shippable issues.
- Paste markdown templates from `docs/linear-templates/` directly into issue descriptions.
- Include acceptance criteria in every actionable issue.

## Priority convention

- **P0**: active outage, data loss, security/privacy breakage.
- **P1**: major user/business impact, no safe workaround.
- **P2**: normal planned work and meaningful fixes.
- **P3**: polish, low-risk maintenance, optional tasks.

## Naming convention

Use concise action-oriented titles:

- `Bug: prevent duplicate quote run submission`
- `Feature: add RFQ link copy button on review page`
- `Billing: sync subscription state from invoice.paid webhook`

## Manual handoffs (free plan friendly)

1. Create issue manually.
2. Update status manually at each handoff.
3. Copy PR links back into Linear manually.
4. Move issue to **Done** only after merge + validation.
