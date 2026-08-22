# OverDrafter Execution Plan

Last updated: August 17, 2026

## Purpose

This is the active execution queue. `PRD.md` defines the product contract,
`ROADMAP.md` bridges to the release ladder and promotion rules, and Linear
holds the detailed deferred-feature index plus issue-level state for human
visibility.

If another document or Linear priority implies a different next task, this plan
wins until it is deliberately updated.

Status routing follows `AGENTS.md` and is strict:

- `Human Review` means the complete validation checklist is checked, the PR is
  published and linked, and the rolling comment is `Ready for review`.
- `Blocked` means currently admitted work cannot proceed because of a decision,
  dependency, or required decomposition.
- `Backlog` means the work is deferred or dependency-sequenced and is not
  currently eligible.

## Active release

**OverDrafter 1.0 — Part to Quote (controlled design-partner beta)**

Target customer: a hands-on buyer at an individual, student, freelance, or very
small-company scale who needs a trustworthy price for a manufacturable part.

Release outcome: an invited buyer independently completes the authenticated,
production journey from one package inside the exact supported envelope to
trustworthy, comparable quote decisions from at least three production-
certified sources. Five functioning sources are preferred. This release remains
controlled; it is not public general availability.

Release is evidence-based and currently has no calendar target. “Bug-free” is
not a usable gate, and a first paid customer belongs to the 1.1 commercial
pilot. The measurable 1.0 gates are in `ACCEPTANCE_CRITERIA.md`.

## Scope

### Included

- responsive web only
- sign-in before upload
- the exact non-ITAR CNC-milled aluminum 6061-T6 package envelope in
  `docs/1-0-beta-runbook.md`
- optional PDF requirements, with unsupported or uncertain facts made explicit
- buyer review/correction of quote requirements
- Xometry as the first production-certified security baseline
- at least two additional admitted, production-certified automatic quote
  sources; five functioning sources preferred
- one provider-neutral permit, preflight, session-isolation, finite-failure,
  and normalized-offer contract with versioned provider envelopes
- honest live-offer, provider-guidance, and unsupported terminal states
- comparison and selection for trustworthy offers
- safe official-vendor handoff
- monitoring, bounded recovery, and rollback
- external design-partner validation of the complete journey
- approved customer file-disclosure confirmation, data-handling notice, and
  support path before any proprietary external upload

### Excluded

- anonymous quote creation or account claim/transfer
- subscription activation, manufacturing payment, or in-app ordering
- unadmitted or uncertified automatic vendor integrations
- supplier directory and outreach agents
- geometry/cost intelligence and DFM/DFA services
- CAD/drawing generation, reconstruction, editing, or PDM
- inspection, warehousing, shipping, and fulfillment
- native mobile, desktop, or CAD plug-in release work
- team procurement workflow

Excluded work remains captured in the Linear Product Portfolio & Future
Capability Index and routed through the projects linked from `ROADMAP.md`.
Excluded does not mean rejected; it means not allowed to delay 1.0.

## Exact execution queue

Only the first incomplete item is eligible to be the primary product task.

1. **Completed prerequisite: `OVD-359` — Approve and enforce the beta safety contract**
   - The human owner approved the Terms, Privacy, retention/deletion,
     external-provider disclosure, non-ITAR attestation, support contract, and
     exact validation-package boundary.
   - `OVD-360` removed the former public validation assets, prevents their
     republication, retires the premature paid offer, and records the required
     deployment/history/cache response. Public availability is not permission
     to send.
   - `OVD-361` publishes the approved policies and adds a distinct audited beta-
     enrollment, notice-acceptance, and upload boundary that cannot be widened
     by a manual entitlement or Stripe subscription.
   - `OVD-362` adds the immutable disclosure permit, exact Xometry-only provider
     boundary, and immediate worker-side recheck before external dispatch.
   - `OVD-373` deployed and verified the required enforcement with every
     commercial rollout control off. `OVD-359` and all three children are Done.
2. **`OVD-206` — Validate hosted Xometry automatic quote path**
   - The `OVD-359` safety prerequisite and all dispatch-blocking children are
     closed with deployed evidence.
   - Prove the existing lane on an Xometry-only hosted worker and an explicitly
     Xometry-only organization with the owner-approved validation package in
     `docs/1-0-beta-runbook.md` and no-order/spend guardrails.
   - Capture a real price, lead time, source URL/identifier, lifecycle evidence,
     and a bounded terminal outcome when the vendor cannot quote.
   - This is the current primary production-certification task.
3. **`OVD-199` — Certify multi-provider quoting for the 1.0 Founding Beta**
   - Start with `OVD-378`, which reconciles this contract across the canonical
     docs, then add the private default-off admission registry.
   - After `OVD-206` freezes the Xometry baseline, generalize its permit and
     immediate worker preflight without weakening existing behavior.
   - Certify Fictiv first after prior written consent, RapidDirect only after an
     explicit contractual exception or official API agreement, and Quickparts
     only after written automation authorization.
   - Keep eMachineShop available as a default-on manual RFQ source. Its public
     terms require express written permission for automated access, so its
     admission policy and browser dispatch stay disabled.
   - Require at least Xometry plus two additional production-certified sources;
     attempt five functioning sources as the preferred target.
4. **`OVD-319` — Certify and enable the scoped 1.0 production beta**
   - Depend on `OVD-206` and `OVD-199`, not billing, and verify the published,
     implemented behavior of the approved safety and multi-provider contracts.
   - Certify the complete signed-in upload-to-handoff journey, monitoring,
     rollback, and truthful failure behavior.
   - Keep automatic rollout bounded to the validated 1.0 lane.
5. **`OVD-358` — Run the Founding Beta and record the decision**
   - Use the program in `docs/founding-beta-program.md`. Invite the founder's
     qualified personal contacts first under the same safeguards as every
     participant; friendship is not an access or eligibility bypass.
   - Recruit at least three target users who bring their own eligible parts;
     target five participants if capacity and useful segment diversity support
     it. Public recruitment is optional, not a release prerequisite.
   - Observe unaided completion, record where they stall, and fix only problems
     that block the committed journey or product truth.
   - Require five total production attempts across the participants, with every
     attempt reaching a truthful terminal state and at least three live offers
     received.
   - Stop at four weeks from first activation or twenty automatic-provider
     runs, and publish the sanitized value, effort, reliability, support, and
     economics report that feeds the 1.1 paid-pilot decision.
6. **Release the controlled 1.0 beta**
   - Review every checkbox in `ACCEPTANCE_CRITERIA.md`.
   - Record known non-blocking defects and operating owner.
   - Publish the narrow supported-package promise; do not imply broader CAD,
     DFM, vendor, purchasing, or fulfillment capability.

## Current portfolio disposition

### Current release routing

- `OVD-206`: keep `In Progress`; its safety prerequisite is complete, the
  semantic-scope repair is deployed, and the remaining proof is hosted Xometry
  repeatability, forced failure/recovery, and rollback evidence.
- `OVD-199`: keep `In Progress`; its docs child may proceed now, its metadata-
  only admission registry follows, and permit/worker changes wait for `OVD-206`
  to freeze the Xometry baseline.
- `OVD-319`: keep in `Backlog` behind `OVD-206` and `OVD-199`; its certification
  scope is independent of the 1.1 billing decision.
- `OVD-359`: Done with all three implementation children and governed hosted
  verification recorded. Any later policy, enrollment, file, permit, or worker
  regression in the production/customer path reopens a fail-closed release
  blocker; it does not silently widen customer-facing provider authority.
- `OVD-407`: proceed under the owner-approved High-complexity override. Restore
  standalone live-provider evaluation without production routing, customer
  disclosure, provider admission, entitlement/rollout, dispatch permits,
  anti-bot certification, or order-prevention affirmations. Evaluation runs
  retain file-bound non-export-controlled confirmation, remain direct adapter
  invocations with local evidence, and do not become customer offers or
  production-certified lanes.
- `OVD-336`: keep in `Backlog`. Preserve completed journey-progression work;
  split any remaining UI need from a later pricing or entitlement decision if
  customer evidence promotes it.

### Move behind 1.0

- `OVD-228` and `OVD-320`: 1.1 Monetization and First Paid Pilot.
- providers beyond the admitted 1.0 certification set, including later sheet/
  laser lanes and missing classic Protolabs or SendCutSend adapters: 1.2
  candidate pool unless promoted through the evidence gate.
- internal manual-request operations: 1.2 unless external validation proves it
  is required for a trustworthy 1.0 outcome.
- all CAD-native, supplier-network, intelligence, fulfillment, and mobile work:
  2.0 or an incubator as routed in `ROADMAP.md`.

### Close or de-duplicate during normal triage

- merge the duplicated synthetic-corpus trees (`OVD-272/316/317/318` versus
  `OVD-326/327/328/329`) into the newer surviving set
- reconcile overlapping Protolabs (`OVD-200`, `OVD-297`) and OSH Cut
  (`OVD-211`, `OVD-299`) work before either is promoted
- treat archived hosting and adapter tasks still marked In Progress as stale
  history, not active work; supersede them where `OVD-206` owns the remaining
  launch proof

This cleanup is portfolio hygiene, not permission to start the surviving
future issues.

## Work admission rule

Before starting any issue, answer all five questions:

1. Which unchecked 1.0 acceptance criterion does it satisfy?
2. What customer evidence makes it necessary now?
3. What is the smallest reversible slice?
4. What current work stops if this begins?
5. What measurable result closes it?

If question 1 has no direct answer, add the idea and its evidence link to the
Linear portfolio index and return to the head of the queue. Do not create an
issue during that brainstorm. A production/security incident may interrupt the
queue; feature curiosity may not.

## Weekly operating cadence

Run a 30-minute review once a week:

1. Read production evidence and the active Linear issue's rolling comment.
2. Update the 1.0 gate checklist with verified facts only.
3. Choose the single smallest missing proof.
4. Move ordinary paused or dependency-sequenced work to `Backlog`; move
   currently admitted work stopped by decisions, dependencies, or decomposition
   to `Blocked`; reserve `Human Review` for work that satisfies the complete
   validation, linked-PR, and `Ready for review` rolling-comment gate in
   `AGENTS.md`.
5. Add new ideas to the Linear portfolio index with an evidence link and one
   incubator route; create no issue unless the promotion gate passes.
6. End by writing one sentence: `Next: <issue> because <missing proof>.`

Current sentence:

> **Next: complete OVD-206's hosted Xometry repeatability, forced-failure,
> recovery, and rollback proof because it is the baseline that provider-neutral
> permit and worker changes must preserve. OVD-378 may land concurrently as a
> non-overlapping source-of-truth prerequisite for the later admission registry.**

## Decision log

### August 12, 2026 — Release reset

- Chose a narrow 1.0 quote decision over the broader manufacturing co-pilot.
- Made authentication-before-upload the supported 1.0 path; anonymous claim is
  a later growth experiment.
- Separated production readiness (1.0) from monetization (1.1).
- Chose one certified live quote lane over expanding the vendor portfolio.
- Replaced a date and “bug-free” aspiration with repeatability, truthful
  outcomes, and external-user completion evidence.
- Defined 1.0 as a controlled design-partner beta; general availability remains
  unscheduled.
- Preserved broader ideas in one Linear portfolio index with incubators used
  only as routing categories.

## Completed foundation

The repository already contains substantial foundations for authentication,
upload, extraction/review, quote request persistence, multi-vendor fan-out,
manual fallback, comparison/selection, vendor links, billing, mobile, supplier,
and geometry work. Shipped code remains available; being built does not make a
capability part of the current release promise.

Historical milestones, prior plan reviews, and superseded launch sequences are
available in Git and Linear history. They are intentionally omitted here so
this file answers one question quickly: **what should I work on next?**
