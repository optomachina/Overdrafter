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
- For larger planning decompositions, prefer the repo-native seed flow:
  - capture raw notes in `planning/raw_notes.md`
  - normalize them into `planning/linear_seed.yaml`
  - dry-run `python3 tools/linear/import_plan.py`
  - review `planning/linear_import_report.md`
  - only then rerun with `--live` if the plan is clean

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

## Optional repo-native import flow

Use this when a brainstorm, PRD section, or roadmap slice needs multiple issues created or reconciled at once.

1. Ground the work in repo docs first.
2. Capture source material in `planning/raw_notes.md`.
3. Normalize the output into `planning/linear_seed.yaml`.
4. Run `python3 tools/linear/import_plan.py` for a dry-run.
5. Review `planning/linear_import_report.md` for creates, updates, overlaps, and deferred items.
6. If the report is correct, rerun with `--live`.

Guardrails:

- Dry-run is the default.
- Exact-title dedupe happens within the target project.
- Completed issues are reported as overlaps and not auto-mutated.
- Deferred items stay out of default live import unless explicitly included.
