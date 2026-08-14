# PRD to Linear Issue Workflow

1. Read PRD section and extract one implementation-sized outcome.
2. Paste content into `docs/linear-templates/prd-to-project-template.md` when the work is multi-step.
3. For execution issues, create child issues using bug/ui/billing templates as needed.
4. Keep each issue focused on one shippable change.
5. Ensure each issue has explicit acceptance criteria.
6. Add priority and minimal labels (`feature`, `billing`, `spike`, etc.).
7. Route and scope each issue before coding.

When the PRD or planning slice is large enough to merit batch reconciliation:

1. Separate active-release requirements from deferred ideas.
2. Add deferred ideas and evidence links to the Linear Product Portfolio &
   Future Capability Index; do not create issues for them yet.
3. Apply the promotion gate in `ROADMAP.md` to active candidates.
4. Search Linear for overlaps before creating anything.
5. Create only the smallest bounded promoted issues, inside the appropriate
   numbered release, with implementation-ready acceptance criteria.
