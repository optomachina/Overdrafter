# Fixture heal runbook (OVD-796)

Owner: Blaine. Follow the [recapture authorization](../../AGENTS.md#fixture-heal-recapture-and-certification-ovd-796-62-ovd-816), [class-S policy](../../AGENTS.md#fixture-heal-class-s-auto-merge-ovd-796-d8-ovd-816), and [Selector repair](../provider-integration.md#selector-repair). If this runbook and `docs/provider-integration.md` disagree, the stricter rule applies until they are aligned.

## What runs today

| Slice | Issue | Scope | Status |
| --- | --- | --- | --- |
| 1 | OVD-813 | Sanity gate on both live persist paths, per-process pause, page line | Live |
| 2 | OVD-817 | Durable pause/release and certification permit | Planned |
| 3 | OVD-814 | Locator packs and hydration | Planned |
| 4 | OVD-815 | Ledger and internal-quote guards | Planned |
| 5 | OVD-818 | Fingerprints and scheduling | Planned |
| 6 | OVD-820 | AI comparison on change | Planned |
| 7 | OVD-819 | Cleanup ledger and orphan sweep | Planned |
| 8 | OVD-821 | Certification runner and rotation | Planned |
| 9 | OVD-823 | Repair loop and heal-guard | Planned |
| 10 | OVD-816 | Standing authorization and policy (this document) | Policy recorded; class S dormant until OVD-823 and OVD-845 |
| 11 | OVD-824 | Re-confirmation, evidence and backfill | Planned |
| 12 | OVD-822 | Revision and standing-approval integration | Planned |

Only slice 1 is live. Commands below for planned slices (`--stage=repair`, `fixture:heal-guard`) do not exist yet. The remaining procedures describe the target workflow, not runnable automation today. This policy does not deploy code or grant kill-switch release capability.

## How drift is detected

The four layers are a sanity check on every live quote, daily fingerprints with AI comparison only on change, rotating certifications covering every live supplier at least every 14 days, and error triggers. Only sanity is live today. Daily loads are unauthenticated; authenticated fingerprints come passively from session probes and real quotes. AI is advisory and can raise severity, never lower it.

OVD-796 §6.1, corrected by the binding first-outlier decision:

| Trigger | First action |
| --- | --- |
| `selector_drift`, `unexpected_ui_state`, persistent `configuration_required` twice in 24 h | Certification now |
| Sanity hard hold | Pause and certify now |
| First outlier | Pause, hold, log and certify now |
| Fingerprint diff at least `selector` | Certify now |
| Certification fail | Pause and open a `fixture-repair` case |
| `login_required`, `mfa_required`, CAPTCHA or `blocked` | No repair; OVD-763 session refresh, then a human if unresolved |

The §4.3 diff classes are:

| Diff | Meaning and response |
| --- | --- |
| `none` | Hashes equal; no action |
| `cosmetic` | Structure only; log; after three consecutive days propose a baseline refresh |
| `label` | Labels changed; AI compare and queue certification |
| `selector` | Count or visibility changed; AI compare and certify now |
| `route` | Final path changed; AI compare and certify now |
| `host` | New request host; certify and route to Blaine for security review |
| `price_shape` | Pricing region shape changed; pause and certify now |
| `blocked` | Challenge or rate limit; alert `monitor_blocked`, no drift repair |

A fingerprint-only diff does not engage a switch, except `price_shape`. Baseline fingerprint files are outside the class-S path exception and need Blaine. `blocked`, login, MFA and CAPTCHA are never drift. Stop the repair run; hand session recovery to OVD-763, then a human. Never bypass a challenge.

## When a supplier is paused

The structured page line has source `fixture_heal.pause`, severity `page`, and context fields `provider`, `codes`, `runId`, `vendorQuoteResultId`, and `brakeCommand`. The held result is `manual_review_pending`, with offers withheld. The customer sees pending, never a number.

The FIRST outlier pauses. Slice 1's pause is per process: a restart clears it and another instance does not carry it. Make the pause durable by running the paged command through the authorized operator path:

```bash
npm run provider:kill -- <key> --on --reason "fixture-heal sanity <code> run <runId>" --operator "<name>"
```

Use the [C&D runbook](provider-cease-and-desist.md#step-1-engage-the-ovd-722-kill-switch) for auth paths, operator identity, the reason of at least 10 characters, AAL2 admin handling and verification. Observe its pending infrastructure caveats; a page is not proof of durable engagement.

The pause never lifts on a timer. Only a passing re-verify (certification) or an evidenced heal outcome releases the local pause; durable switch release has the stricter rules below. Paused suppliers may run verified internal test quotes only, subject to every kill-switch checkpoint. Internal test quotes are always held, even when their sanity check passes. Suspect findings (`price_floor`, `qty_echo`) and unavailable history hold a quote without declaring supplier drift; unavailable echo is informational in slice 1.

## How a repair runs

The planned §6.2 loop runs in an isolated Engineer worktree on Opus, not inside the production worker:

1. Brief: assemble the trigger, pack, fingerprints, diff, redacted evidence, schemas, golden part and tolerances; exclude secrets and account text.
2. Recapture: `npm run fixture:onboard -- <key> --stage=repair --capture` walks the golden-part flow read-only with the cleanup ledger active, under the scoped standing authorization.
3. Propose: edit only the supplier's locator pack and its pack-local synthetic browser fixture.
4. Local proof: run the affected provider browser fixture test, `npm run provider:check`, and `fixture:heal-guard`.
5. Validate: run `--stage=repair --certify` using the proposed pack at both quantities, full cleanup and §5.5 comparison to known-good.
6. Classify: classify the pack diff; hosted `heal-guard` recomputes the class and refuses files outside the permitted set.
7. PR: include the old/new selector table, fingerprint diff, certification comparison and cleanup verification; keep raw captures and private evidence out of the public repo.
8. Review: independent Opus review and QA; eligible S uses the standing OK, every other class gets Blaine's card.
9. Post-merge: obtain Blaine's protected worker deploy, certify post-deploy and at +24 h, then release only under the kill-switch rules below.

Stop after at most 3 propose-validate iterations or 2 live certification uploads per repair case; mark `needs_human` with the evidence bundle. At most 2 certification uploads per supplier per day are allowed, counting production uploads that day. Do not reset a budget by opening another case.

Allowed edits are `provider-integrations/<key>/locators.v<N+1>.json` and `provider-integrations/<key>/fixtures/locators.v<N+1>.html` only. Never edit validators, tolerances, sanity code, golden known-good values, envelopes, hooks, `worker/src/adapters/**` or `worker/src/fixtureHeal/**` in the repair loop.

Cleanup is ledger-first, runs in `finally`, and verifies every created item. Never clear a cart or touch another run's items. Orphans get at most three daily sweep retries, then human handling. Xometry uses archive if available, otherwise expire with Blaine's approval recorded in the pack. C&D/global stops override cleanup.

## Approvals

The highest class wins (§7):

| Class | Surface | Who merges |
| --- | --- | --- |
| S | Selectors, pack fingerprint fields, masks, terminal-signal additions only | Standing OK only when all gates below are available and pass |
| S->P | Price cell selector move | S only if both quantities pass and `labels.priceKinds` is unchanged; otherwise Blaine |
| P | Price meaning, label maps, read-price/read-echo arguments, tolerances, sanity or known-good values | Blaine, four-eyes or AAL2 override with reason |
| F | Flow steps, routes, hosts, cleanup or terminal-signal removal | Blaine; security review for hosts |
| E | Envelope or admission | Blaine; normal protected change process |
| C | Adapter or fixture-heal code, including adapter-local browser fixtures | Blaine |
| H | Failed certification, missing/stale known-good, login, MFA, CAPTCHA, block or ToS | Human only; Blaine, with legal for ToS |

The [standing recapture and certification authorization](../../AGENTS.md#fixture-heal-recapture-and-certification-ovd-796-62-ovd-816) covers only admitted suppliers cleared for paid automation in the [permissions matrix](../providers/permissions-matrix.md). Use internal-org golden parts marked `raw_payload.fixtureHeal.internal = true`, never publishable or selectable. Keep the flow quote-only, with an active cleanup ledger touching only this run's items and the iteration/upload caps above. No checkout, order, account or credential change, or supplier message is authorized. Stop for login, MFA, CAPTCHA, block or ToS signals. Envelope/admit stages and production worker deploys remain protected.

The [class-S exception](../../AGENTS.md#fixture-heal-class-s-auto-merge-ovd-796-d8-ovd-816) requires current-head hosted CI green, Jev not risky, independent Opus review without open actionable findings, a QA pass, `heal-guard` class S and certification evidence. Only these two globs qualify, for one supplier:

- `provider-integrations/*/locators.v*.json`
- `provider-integrations/*/fixtures/locators.v*.html`

These paths remain sensitive under `provider_dispatch`; the sensitive list is not narrowed. The category is dormant until hosted heal-guard (OVD-823) and the eligibility check (OVD-845) exist and the latter reads the verdict. Until then every pack PR goes to Blaine. Missing/failing verdicts, other files, and classes P/F/E/C/H require a Blaine card. Changing this policy needs Blaine's explicit OK.

Certification evidence must meet §5.5 at both quantities: exact normalized material, thickness, finish, quantity and currency echo; identical tier labels; price within +/-7.5% or +/-2 dollars (whichever is larger) for known-good at most 30 days old, or +/-15% or +/-3 dollars for 31-90 days. Missing or older known-good cannot auto-pass. Arithmetic must be within max(0.01 dollars times quantity, 0.5% of total); unit price at quantity 10 must not exceed 1.02 times that at quantity 1. Lead time within two business days is informational. Cleanup must be verified, and the +24 h certification is required for auto-release.

## Kill switches

Kill switches always win.

This table describes the planned slice-2 behavior, not capability granted by this policy. Today the operator makes a slice-1 pause durable using the page command and the [C&D runbook](provider-cease-and-desist.md).

| Event | Switch action |
| --- | --- |
| Sanity hard hold, first outlier, `price_shape`, certification fail | Engage; automation records operator `fixture-heal` with a reason of at least 10 characters |
| Fingerprint-only selector/route/host diffs | No switch action; certify |
| `blocked` | No switch action; session recovery owns it |
| Merged class-S repair, deployed, post-deploy and +24 h certifications pass | Release only if the current row's operator is `fixture-heal`, via the current CAS version; a stale version refuses release |
| Human-engaged switch | Never auto-release |
| Any class other than S | Release by Blaine |

A switch engaged by a human is never auto-released. Certification and recapture go through all kernel checkpoints. A killed supplier can be certified only under the certification-permit exception (OVD-817), scoped to the internal org and golden parts. Until that code exists, there is no exception to use. Under a `C&D` or `global` reason there is no traffic at all, not even cleanup; record orphans for manual handling. For other kill reasons, cleanup may touch only the run's own ledger items under the cleanup contract.

Operator live tools (`eval:live-provider`, `smoke:vendor-workflow`, sweeps) do not read the switch. Do not run them for an engaged provider; stop any already running through the operator procedure.

## Rollback

- Bad class-S pack after merge: engage the kill switch first if prices may be wrong, `git revert` the squash commit, redeploy the worker through the normal protected deploy with Blaine, then re-certify. Do not auto-release a human-engaged brake.
- Revoke the standing OK by removing the AGENTS.md class-S subsection. After OVD-822, setting `revoked_at` on the standing-approval row also revokes it through the approved admin path.
- The slice 1 sanity gate has no runtime flag. Rollback is `git revert` of its PR plus a protected worker deploy.
- Quotes issued between the last green certification and detected drift are flagged for re-confirmation by slice 11 (OVD-824, planned). Accepted quotes require human follow-up; this backfill does not run today.

No SQL by hand.

## Review checklist for a fixture-repair PR

- [ ] Only `provider-integrations/*/locators.v*.json` and `provider-integrations/*/fixtures/locators.v*.html` changed, for one supplier.
- [ ] `heal-guard` reports class S at the current head.
- [ ] Certification at both quantities meets §5.5 tolerance, with echo matched.
- [ ] cleanup is verified for every created item.
- [ ] The provider's browser fixture test and `npm run provider:check` pass.
- [ ] The old/new selector table and fingerprint diff are present.
- [ ] No raw page capture, account text, customer data, cookies, tokens or secrets appear in the diff.
- [ ] The supplier's kill switch state and who engaged it are recorded.
- [ ] Independent Opus review has no open actionable findings and QA passed.
- [ ] Anything not class S has a Blaine approval card.
- [ ] Hosted CI, Jev and the eligibility check pass at the current head; dormant gates are not treated as passes.

## What always needs a human

- CAPTCHA, new-device prompts, changed passwords and non-TOTP 2FA; OVD-763 handles only its authorized password/TOTP refresh.
- ToS changes, C&D, permissions decisions and bot-protection escalation.
- Flow, route, host, pricing meaning, tolerance and envelope changes outside the standing OK.
- Validation failures, missing or older-than-90-day known-good values, and first supplier baselines.
- Releasing any human-engaged kill switch and orphans left after three sweeps.
- Order-time price disagreement affecting an already-accepted customer quote.
