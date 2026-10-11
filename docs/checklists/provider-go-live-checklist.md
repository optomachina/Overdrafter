# Provider go-live checklist

Last updated: October 11, 2026

This is the human-gated go-live record for operational and production facts
that CI cannot prove. It does not duplicate `provider:check` (OVD-691). A
checked box grants no authority. Generated catalog, adapter, and registry
output stays disabled by default. Admission happens only when a human applies
reviewed SQL. Admit SQL never belongs in `supabase/migrations/`. Record Secret
Manager secret names only; never write secret values, cookies, tokens, or
storage-state contents.

Use this checklist with the **Provider go-live** section in
`.github/pull_request_template.md`.

## When CI requires it

`scripts/validate-pr-body.mjs` requires the PR section when any changed path
(including either side of a rename) matches `PROVIDER_GO_LIVE_PATH_PATTERNS`.
Patterns are root-anchored globs, not substrings:

- `test-fixtures/provider-dispatch-envelope/**`
- `worker/src/providerDispatchEnvelope.ts` (`REVIEWED_PROVIDER_DISPATCH_ENVELOPES`)
- `supabase/migrations/*_reviewed_dispatch_envelope.sql`
- `provider-integrations/**`
- `worker/src/generated/providerRegistry.ts`
- `scripts/provider-registry.mjs`, `scripts/provider-sync.mjs`,
  `scripts/provider-check.mjs`
- `worker/scripts/generated/provider-secrets.sh`

CI diffs with `git diff --name-status --no-renames` and re-runs when the PR
description is edited.

## PR section rules

- **Headings.** The section is `## Provider go-live` or `### Provider go-live`
  (case-insensitive). It ends at the next heading of the same or a higher
  level, so `###` subsections under a `##` section count. Headings and
  checkboxes inside fenced code blocks (```` ``` ```` or `~~~`) are ignored.
- **One line per item.** Each item needs its own checkbox line that starts
  with the template label (for example `- [x] provider:check green.`). A line
  that lists several items satisfies at most the one whose label it starts
  with. Duplicate lines for one item fail.
- **Tick every item.** `[ ]` fails, including `[ ]` with N/A.
- **Evidence.** After `Evidence:`, give a URL, a backticked command or output,
  a 7-40 character hex commit SHA, or a repo file path. A bare tick, empty
  evidence, or placeholders (`TBD`, `TODO`, `<link>`, `...`) fail.
- **N/A.** Allowed only on non-admission items (worker adapter and secret,
  egress, rollout, certification, rollback), still ticked, written as
  `Evidence: N/A: <reason>`. The reason needs at least 15 characters and 3
  words; `x`, `n/a`, `-`, `tbd`, `todo`, `none`, and `...` fail.
- **Admission items cannot be N/A:** provider:check green, envelope reviewed by
  a named reviewer, and the approved admission revision. A PR that changes a
  path above is treated as part of admitting a provider, so these always need
  evidence.

Repo-verifiable envelope artifacts (readiness doc, fixture, default-deny test,
and reviewed-envelope registry wiring) are enforced by `provider:check`. Those
items appear here only as **provider:check green**.

## Envelope

- [ ] **provider:check green.** `npm run provider:check` passed for this
      provider on the current revision.
- [ ] **Envelope reviewed by a named reviewer.** Record the reviewer name, the
      envelope revision, and an evidence link. Review does not admit the
      provider.

## Live

- [ ] **Worker adapter deployed and Secret Manager secret created (name
      only).** Record the adapter key, that it remains absent from live lists
      until a human enables it, and the Secret Manager secret name (for
      example `QUICKPARTS_STORAGE_STATE_SECRET_NAME`). Do not record secret
      values.
- [ ] **Stable egress verified.** Record the `verify:xometry-egress`-style
      command that was run, the provider hosts that were in scope, and an
      evidence link.

## Admit

- [ ] **Approved admission revision reviewed and applied.** A human reviewed
      and applied a revision with `generic_dispatch_enabled=true`. The SQL
      stayed in a review-only stub until that human moved it; it was never
      committed to `supabase/migrations/` by a generator. Record the policy
      revision and an evidence link.
- [ ] **`automatic_quote_collection` rollout and org enablement.** Record the
      rollout revision, the organization enablement evidence, and that both
      remain independently disableable.
- [ ] **Certification run passed.** Link the hosted certification run for
      this provider. Failed certification leaves only this provider disabled.
- [ ] **Rollback/disable steps rehearsed.** Record the disable path: admission
      revision with `generic_dispatch_enabled=false`, rollout off, adapter
      removed from `WORKER_LIVE_ADAPTERS`, and permit revocation. Confirm the
      rehearsal did not enable customer traffic.

## Default-off reminder

Checking every box still does not enable customer traffic. Generated output
is non-authoritative. The production-certified allowlist and routing change
only through the reviewed admit-stage procedure above.
