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
`.github/pull_request_template.md`. CI requires that section only for PRs that
touch `worker/src/providerDispatchEnvelope.ts`,
`supabase/migrations/*_reviewed_dispatch_envelope.sql`, or
`provider-integrations/**`. Mark an item N/A only when it is checked `[x]` and
has a real justification (not placeholders such as `N/A: x`, `n/a`, `-`, or
`tbd`). Admission items cannot be N/A. Every item needs evidence: a link,
command output, a SHA, or a path.

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
- [ ] **Certification run evidence.** Link the hosted certification run for
      this provider. Failed certification leaves only this provider disabled.
- [ ] **Rollback/disable steps rehearsed.** Record the disable path: admission
      revision with `generic_dispatch_enabled=false`, rollout off, adapter
      removed from `WORKER_LIVE_ADAPTERS`, and permit revocation. Confirm the
      rehearsal did not enable customer traffic.

## Default-off reminder

Checking every box still does not enable customer traffic. Generated output
is non-authoritative. The production-certified allowlist and routing change
only through the reviewed admit-stage procedure above.
