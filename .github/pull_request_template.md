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

## Provider go-live

Required only when this PR touches `worker/src/providerDispatchEnvelope.ts`,
`supabase/migrations/*_reviewed_dispatch_envelope.sql`, or
`provider-integrations/**` (registry and manifests). Omit this section on
unrelated PRs so the existing PR-body gate stays unchanged.

A checked box grants no authority. Generated output stays disabled by default.
Admission happens only when a human applies reviewed SQL; admit SQL never
belongs in `supabase/migrations/`. Record Secret Manager secret names only.

N/A must be checked `[x]` and include a real justification (not placeholders
such as `N/A: x`, `n/a`, `-`, or `tbd`). Admission items cannot be N/A.
Every item needs evidence: a link, command output, a SHA, or a path.
See `docs/checklists/provider-go-live-checklist.md`.

### Envelope

- [ ] provider:check green
- [ ] Envelope reviewed by a named reviewer. Evidence:

### Live

- [ ] Worker adapter deployed and Secret Manager secret created (name only). Evidence:
- [ ] Stable egress verified (`verify:xometry-egress`-style). Evidence:

### Admit

- [ ] Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied. Admit SQL was not added to `supabase/migrations/`. Evidence:
- [ ] `automatic_quote_collection` rollout and org enablement. Evidence:
- [ ] Certification run evidence:
- [ ] Rollback/disable steps rehearsed. Evidence:

## Screenshots or videos (if UI)

Add screenshots, videos, logs, or other evidence.

## Follow-up items

- [ ]
