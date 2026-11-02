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

## Proof

<!-- proof: replace me -->
<!--
Replace the placeholder with at least one item, one per line. The proof check
(scripts/proof-check.mjs) recognises:

- Test: <path>  (a test file in this diff or already in the repo)
- Command: <cmd>  followed by a fenced block with its output:
  ```text
  <output>
  ```
- Live: <url>
- Screenshot: <image/url>

A change to src/**/*.tsx or src/**/*.css needs a Screenshot item and a journey
test reference: an e2e/journeys/<name>.spec.ts path or the GitHub Actions run
URL of that journey test. A PR that only touches docs/ or *.md files is exempt.
-->

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

<!--
Optional report-only section. Current CI does not require it; an explicit
--door revertable validator invocation checks all fields. Remove this comment
and replace the prompts when supplying a plan. Owner: a routing bot/model id or blaine.
## Revert plan

- Revert: git revert <squash-sha>
- State effects: none
- Why none: TODO explain why no persistent or external state is affected (20+ characters).
- Kill switch: TODO flag name, default off; or none: reason
- Owner: TODO
- Verify after revert: TODO command or check run
- Blast radius: TODO affected surfaces or users (12+ characters).
-->

## Documentation

- [ ] Docs updated
- [ ] No doc updates needed

## Provider go-live

Required only when this PR enables a provider for customers, and CI decides from
the diff content: a registry provider going to `liveAdapter: true` or gaining
production egress (compared per provider), a new provider added to
`REVIEWED_PROVIDER_DISPATCH_ENVELOPES`, or a migration that assigns
`generic_dispatch_enabled = true` or `admission_state = 'approved'` in a SET
clause or an insert. Omit this section on every other PR, including generated
stage 1 and 2 output, registry hardening, permissions docs, kill switch and
disable changes, and cease and desist disables. A PR that edits the PR body
gate itself adds a `## Gate change review` section with a `Reviewer: <name>`
line and an evidence link.

A checked box grants no authority. Generated output stays disabled by default.
Admission happens only when a human applies reviewed SQL; admit SQL is never
committed by a generator. Record Secret Manager secret names only.

Each item needs an evidence link: a GitHub PR, Actions run, or commit URL in
`optomachina/Overdrafter`, or a full Linear issue URL. A bare `OVD-n` and other
URLs are not evidence. Links are format checked only.
Worker secret, egress, admission, rollout, and certification items may be marked
`N/A: <written justification>` (checked `[x]`) when they do not apply to this
stage. The provider:check, per-supplier on/off switch, and legal stance items
cannot be N/A, except the ITAR/EAR item for a US only provider. The envelope
review item is automatic: it stays pre-checked with its signature and needs no
human evidence; the gate rejects it unticked or missing.
See `docs/checklists/provider-go-live-checklist.md`.

### Envelope

- [ ] provider:check green. Evidence:
- [x] Envelope reviewed (automatic). Signed: Grok Bot under Blaine Wilson standing authority.

### Live

- [ ] Worker adapter deployed and Secret Manager secret created (name only). Evidence:
- [ ] Stable egress verified (`verify:xometry-egress`-style). Evidence:

### Admit

- [ ] Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied. Admit SQL is never committed by a generator. Evidence:
- [ ] `automatic_quote_collection` rollout and org enablement. Evidence:
- [ ] Certification run evidence:
- [ ] Per-supplier on/off switch in the admin dashboard (immediate, worker-enforced at generic dispatch) and optional admin daily quote cap (default unlimited), via OVD-829. Evidence:

### Legal stance

- [ ] No stored customer passwords; encrypted session tokens only. Evidence:
- [ ] ITAR/EAR controlled or uncertain uploads are blocked to foreign providers (Geomiq, Weerg) and to LLMs. Evidence:

## Follow-up items

- [ ]
