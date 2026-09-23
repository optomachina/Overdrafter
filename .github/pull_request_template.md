Remove the prompt text once each section is filled. Keep the PR description concrete and aligned with the actual diff.

## Linear issue ID

- Issue: <!-- e.g. OD-123 -->
- Does this one bounded change satisfy the named issue's source acceptance criteria? List any post-merge criteria that will remain; otherwise create a child issue before publishing.
- Is this the issue's main PR? For a direct same-change follow-up, link the earlier PR and explain why the original acceptance criteria still require this repair.
- Confirm the named issue is not a release-outcome parent.

## Summary

Describe the change briefly.

## Problem

What problem does this PR solve?

## Acceptance criteria addressed

- [ ]
- [ ]

## Files changed

List key files or areas touched.

## Scope

What is included in this PR?
What is intentionally not included?

## Verification

List exact commands run locally and whether they passed.

Commands run:

```bash
# npm run verify
```

Results:

- [ ] all listed verification passed
- [ ] unrelated baseline failures are described below

Baseline failures or exceptions:

## Review findings and coverage

- Final PR head SHA:
- Sonar issue findings: link or query, count, and disposition (including an observed zero; a green gate alone is insufficient).
- CodeRabbit: completed review head or unavailable/rate-limited/stale; open threads and dispositions.
- Codex and other reviewers: completed review head or unavailable/stale; open threads and dispositions.
- [ ] Inspected findings and threads on the final head; actionable current-change findings are resolved or have evidence-backed dispositions. Missing or stale review is not counted as clean.

## Tests

- What tests were added or updated?
- If none were added, explain why.

## Migration notes

- [ ] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

- What could go wrong?
- How would this be rolled back if needed?

## Documentation

- [ ] Docs updated
- [ ] No doc updates needed

## Screenshots or videos (if UI)

Add screenshots, videos, logs, or other evidence.

## Follow-up items

- [ ]
