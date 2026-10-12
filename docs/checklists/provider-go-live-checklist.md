# Provider go-live checklist

Last updated: October 12, 2026

This is the human-gated go-live record for operational and production facts
that CI cannot prove. It does not duplicate `provider:check` (OVD-691). A
checked box grants no authority. Generated catalog, adapter, and registry
output stays disabled by default. Admission happens only when a human applies
reviewed SQL; admit SQL is never committed by a generator. Record Secret
Manager secret names only; never write secret values, cookies, tokens, or
storage-state contents.

Use this checklist with the **Provider go-live** section in
`.github/pull_request_template.md`.

## When the section is required

The `PR body gate` workflow (check name `provider-go-live`) requires the
section only for a change that enables a provider for customers. It reads file
content, not just paths. A change enables a provider when it does any of the
following:

- makes a provider in `provider-integrations/provider-registry.v1.json` go from
  `liveAdapter` false or absent to `true`, or gain production egress
  (`"stable_nat"`). The registry is compared per provider key between the base
  and the head, so turning one provider off never offsets turning another on;
- adds a provider that was not present to `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`
  in `worker/src/providerDispatchEnvelope.ts` (read structurally, whatever the
  formatting);
- adds or changes a migration that assigns `generic_dispatch_enabled = true` or
  `admission_state = 'approved'` in a `SET` clause or inserts such a value.
  Values that only appear in a `WHERE` clause do not count, so a disable
  migration that filters on `approved` is not enabling. Comments are ignored.
  A schema change whose name mentions admission does not count.

The gate runs the detector and validator from the base commit, so a PR cannot
edit them to skip itself. A PR that edits the gate files (the detector, the
validator and its test, or `.github/workflows/pr-body-gate.yml`) needs a **Gate
change review** section with a `Reviewer: <name>` line and an evidence link.
On `merge_group` the check passes with no work, so a required check does not
stall a merge queue.

Everything else does not need the section: stage 1 and 2 `fixture:onboard`
output (`provider:add` is the alias of `--stage=envelope`), registry hardening,
permissions docs, adding a reviewed envelope migration that stays disabled,
the kill switch (OVD-722), the export block (OVD-723), and any disable change
including a cease and desist disable. A change that only lowers an enabling
signal never requires the section.

## Evidence and N/A

Each item needs an evidence link: a GitHub PR, Actions run, or commit URL in
`optomachina/Overdrafter`, or a full Linear issue URL
(`https://linear.app/<workspace>/issue/OVD-n`). A bare `OVD-n` is not evidence.
Links are format checked only. The gate confirms that a GitHub link exists, and
accepts a Linear link by its shape; nothing reads what a link says, so the
named reviewer owns whether it supports the box.

Worker secret, egress, admission, rollout, and certification items may be
marked N/A when they do not apply to the stage being enabled. Check the box
`[x]` and write `N/A: <justification>` with a real sentence (not `n/a`, `tbd`,
`todo`, `none`, or `-`). The envelope, rollback, and legal stance items cannot
be N/A, with one exception: the ITAR/EAR item may be N/A for a US only
provider, with the justification written out.

Repo-verifiable envelope artifacts (readiness doc, fixture, default-deny test,
and reviewed-envelope registry wiring) are enforced by `provider:check`. Those
items appear here only as **provider:check green**.

Commands: `npm run fixture:onboard -- <key> --stage=envelope|live|admit`
generates the offline stages (`npm run provider:add` is the envelope stage
alias). There is no `provider:onboard` command.

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
      committed by a generator. Record the policy revision and an evidence
      link.
- [ ] **`automatic_quote_collection` rollout and org enablement.** Record the
      rollout revision, the organization enablement evidence, and that both
      remain independently disableable.
- [ ] **Certification run evidence.** Link the hosted certification run for
      this provider. Failed certification leaves only this provider disabled.
- [ ] **Rollback/disable steps rehearsed.** Record the disable path: admission
      revision with `generic_dispatch_enabled=false`, rollout off, adapter
      removed from `WORKER_LIVE_ADAPTERS`, and permit revocation. Confirm the
      rehearsal did not enable customer traffic.

## Legal stance

These items record the provider legal stance. None can be N/A except the
ITAR/EAR item for a US only provider (see Evidence and N/A).

- [ ] **Per provider kill switch rehearsal.** Run `npm run provider:kill` for
      this provider on and off, following
      `docs/runbooks/provider-cease-and-desist.md`, and record the run.
- [ ] **Provider turned off the same day.** On a cease and desist, IP or bot
      block, CAPTCHA wall, or account ban, the provider is switched off the
      same day. Name the owner and the runbook step.
- [ ] **About 20 quotes per provider per day.** Record the configured daily
      ceiling and where it is enforced.
- [ ] **Never evade a block.** Never rotate IPs, solve CAPTCHAs, mimic human
      pacing, or retry around a block. Record that the adapter has no such
      path.
- [ ] **No stored customer passwords.** Only encrypted session tokens are
      stored, and the customer can revoke with one click.
- [ ] **ITAR/EAR controlled or uncertain uploads are blocked** to foreign
      providers (Geomiq, Weerg) and to LLMs. Record the block (OVD-723) and its
      test.

## Default-off reminder

Checking every box still does not enable customer traffic. Generated output
is non-authoritative. The production-certified allowlist and routing change
only through the reviewed admit-stage procedure above.
