# PRD to Linear Issue Workflow

1. Read PRD section and extract one implementation-sized outcome.
2. Paste content into `docs/linear-templates/prd-to-project-template.md` when the work is multi-step.
3. For execution issues, create child issues using bug/ui/billing templates as needed.
4. Keep each issue focused on one shippable change.
5. Ensure each issue has explicit acceptance criteria.
6. Add priority and minimal labels (`feature`, `billing`, `spike`, etc.).
7. Route and scope each issue before coding.

When the PRD or planning slice is large enough to merit batch reconciliation:

1. Capture the source material in `planning/raw_notes.md`.
2. Normalize it into `planning/linear_seed.yaml`.
3. Run `python3 tools/linear/import_plan.py` in dry-run mode.
4. Review `planning/linear_import_report.md`.
5. Only then rerun with `--live` if the creates and updates are correct.
