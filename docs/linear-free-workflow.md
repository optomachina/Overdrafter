# Linear Free Plan Usage Guide (Solo Developer)

## Workspace posture

- Use one Linear team unless there is a strong reason to split.
- Use the existing team workflow and the status gates in `AGENTS.md`.
- Keep labels minimal: `bug`, `feature`, `billing`, `spike`, `qa`, `refactor`.
- Protect the free-plan issue budget: deferred ideas are document entries, not
  speculative issues.

## Issue hygiene

- Keep issues small and implementation-oriented.
- Use parent/child only when work clearly spans multiple shippable issues.
- Paste markdown templates from `docs/linear-templates/` directly into issue descriptions.
- Include acceptance criteria in every actionable issue.
- Maintain exactly one rolling progress comment per active issue, following
  `AGENTS.md`.
- Create issues only for active-release defects or bounded slices that passed
  the promotion gate in `ROADMAP.md`.

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

## Handoffs

1. Update the rolling progress comment before changing issue status.
2. Keep the PR and demo or waiver in the comment's Artifacts section.
3. After every required validation checkbox passes, set the rolling comment to
   `Ready for review` and move the Linear issue to `Human Review`.
4. Use rolling-comment `Complete` and Linear `Done` only after explicit human
   confirmation.

The live Overdraft workflow has no separate `Ready for review` or `Complete`
issue states. Do not create them ad hoc; the rolling comment carries that finer
status while Linear uses `Human Review` and `Done`.

## Idea capture and promotion

The
[OverDrafter Product Portfolio & Future Capability Index](https://linear.app/overdrafter/document/overdrafter-product-portfolio-and-future-capability-index-e5566af77774)
is the single detailed home for deferred ideas.

1. Ground the idea in the active repo contracts.
2. Add it to one capability family in the portfolio index with its evidence
   link and one incubator route.
3. Do not create an issue during the same brainstorm.
4. At portfolio review, apply the promotion gate in `ROADMAP.md`.
5. If promoted, place the smallest bounded slice in a numbered release and
   give it explicit acceptance criteria.

Guardrails:

- Numbered release project descriptions are authoritative for committed scope.
- Incubators are routing categories, not execution queues.
- Avoid speculative milestones and narrative parent issues.
- Search for an existing issue before creating a promoted one.
