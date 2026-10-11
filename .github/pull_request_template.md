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

Required only when this PR touches a provider go-live path (for example
`test-fixtures/provider-dispatch-envelope/**`,
`worker/src/providerDispatchEnvelope.ts`,
`supabase/migrations/*_reviewed_dispatch_envelope.sql`, or
`provider-integrations/**`; the full list is `PROVIDER_GO_LIVE_PATH_PATTERNS`
in `scripts/validate-pr-body.mjs`). Omit this section on unrelated PRs.

A checked box grants no authority. Generated output stays disabled by default.
Admission happens only when a human applies reviewed SQL; admit SQL never
belongs in `supabase/migrations/`. Record Secret Manager secret names only.
See `docs/checklists/provider-go-live-checklist.md`.

<!--
Rules (enforced by scripts/validate-pr-body.mjs):
- Keep one checkbox line per item and keep each line starting with its label.
- Tick every item: [x]. An unticked box fails, even with N/A.
- After "Evidence:" give a URL, a `backticked command or output`, a 7-40 hex
  commit SHA, or a repo file path. TBD, TODO, <link>, and ... fail.
- N/A is allowed only on Live, rollout, certification, and rollback items, and
  needs a real reason (15+ characters, 3+ words), for example:
  - [x] Certification run passed. Evidence: N/A: fixture-only change, no hosted run yet
- provider:check, envelope review, and the admission revision can never be N/A.
Examples:
  - [x] provider:check green. Evidence: `npm run provider:check` passed on 1a2b3c4d
  - [x] Envelope reviewed by a named reviewer. Evidence: Jane Doe, https://linear.app/overdrafter/issue/OVD-123
-->

### Envelope

- [ ] provider:check green. Evidence:
- [ ] Envelope reviewed by a named reviewer. Evidence:

### Live

- [ ] Worker adapter deployed and Secret Manager secret created (name only). Evidence:
- [ ] Stable egress verified (`verify:xometry-egress`-style). Evidence:

### Admit

- [ ] Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied. Admit SQL was not added to `supabase/migrations/`. Evidence:
- [ ] `automatic_quote_collection` rollout and org enablement. Evidence:
- [ ] Certification run passed. Evidence:
- [ ] Rollback/disable steps rehearsed. Evidence:

## Screenshots or videos (if UI)

Add screenshots, videos, logs, or other evidence.

## Follow-up items

- [ ]
