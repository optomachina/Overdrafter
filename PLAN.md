# OverDrafter Execution Plan

Last updated: August 13, 2026

## Purpose

This is the active execution queue. `PRD.md` defines the product contract,
`ROADMAP.md` bridges to the release ladder and promotion rules, and Linear
holds the detailed deferred-feature index plus issue-level state for human
visibility.

If another document or Linear priority implies a different next task, this plan
wins until it is deliberately updated.

## Active release

**OverDrafter 1.0 — Part to Quote (controlled design-partner beta)**

Target customer: a hands-on buyer at an individual, student, freelance, or very
small-company scale who needs a trustworthy price for a manufacturable part.

Release outcome: an invited buyer independently completes the authenticated,
production journey from one package inside the exact supported envelope to a
trustworthy quote decision and vendor handoff. This release remains controlled;
it is not public general availability.

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
- one production-certified Xometry automatic quote lane
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
- additional automatic vendor integrations
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

1. **`OVD-359` — Approve and enforce the beta safety contract**
   - Name the human owner and approve the Terms, Privacy, retention/deletion,
     external-provider disclosure, non-ITAR attestation, and support contract.
   - Explicitly approve the exact validation-part STEP bytes and complete
     outbound-scope record for Xometry, or require a new synthetic validation
     part.
   - Resolve the existing public serving of those exact STEP bytes: confirm
     public-distribution rights or remove/replace the artifact and record any
     required incident response. Public availability is not permission to send.
   - Implement and verify every dispatch-blocking gap: approved notice before
     upload or an enrollment gate; an immutable disclosure affirmation before
     vendor dispatch; server-enforced beta-organization access that cannot be
     widened by an unrelated manual grant or Stripe subscription; and explicit
     Xometry-only organization and worker configuration.
   - Remove, hide, or replace the current `$49/month` and Upgrade-to-Pro customer
     copy with truthful invitation-only beta language; pricing remains a 1.1
     decision even when Checkout is disabled.
   - Split those changes into bounded child issues after the policy decision if
     needed, but keep `OVD-359` and every child blocking `OVD-206` until the
     deployed enforcement and negative-path tests pass.
   - This is the one current decision and safety gate; no external vendor
     submission starts until it closes.
2. **`OVD-206` — Validate hosted Xometry automatic quote path**
   - Start only after `OVD-359` and all of its dispatch-blocking implementation
     children close.
   - Prove the existing lane on an Xometry-only hosted worker and an explicitly
     Xometry-only organization with the owner-approved validation package in
     `docs/1-0-beta-runbook.md` and no-order/spend guardrails.
   - Capture a real price, lead time, source URL/identifier, lifecycle evidence,
     and a bounded terminal outcome when the vendor cannot quote.
   - This becomes the next product task after `OVD-359`.
3. **`OVD-319` — Certify and enable the scoped 1.0 production beta**
   - Depend on `OVD-206`, not billing, and verify the published, implemented
     behavior of the approved `OVD-359` contract.
   - Certify the complete signed-in upload-to-handoff journey, monitoring,
     rollback, and truthful failure behavior.
   - Keep automatic rollout bounded to the validated 1.0 lane.
4. **`OVD-358` — Run the Founding Beta and record the decision**
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
5. **Release the controlled 1.0 beta**
   - Review every checkbox in `ACCEPTANCE_CRITERIA.md`.
   - Record known non-blocking defects and operating owner.
   - Publish the narrow supported-package promise; do not imply broader CAD,
     DFM, vendor, purchasing, or fulfillment capability.

## Current portfolio disposition

### Finish or correct immediately

- `OVD-356`: merged work awaits a human demo-waiver/completion decision in
  Human Review; it is not active product implementation.
- `OVD-206`: keep queued behind `OVD-359`; it becomes the sole next product
  validation issue only after the policy, access, disclosure, and Xometry-only
  enforcement is deployed and verified.
- `OVD-319`: rewrite around 1.0 certification and remove the billing blocker.
- `OVD-359`: the sole current decision and safety gate in Human Review. It blocks
  every external provider upload, including the proposed `OVD-206` validation
  part,
  until the human-owned contract is approved and every dispatch-blocking gap is
  implemented and verified.
- `OVD-336`: move to Human Review because its rolling plan changes the product's
  access policy and is already classified High complexity. Preserve completed
  journey-progression work; split any remaining UI need from a later pricing or
  entitlement decision.

### Move behind 1.0

- `OVD-228` and `OVD-320`: 1.1 Monetization and First Paid Pilot.
- additional vendor adapters, including RapidDirect, Protolabs, SendCutSend,
  OSH Cut, and other portal work: 1.2 candidate pool.
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
4. Move ordinary paused work to Backlog; use Human Review only for a genuine
   blocker or human decision.
5. Add new ideas to the Linear portfolio index with an evidence link and one
   incubator route; create no issue unless the promotion gate passes.
6. End by writing one sentence: `Next: <issue> because <missing proof>.`

Current sentence:

> **Next: OVD-359 because no file should leave OverDrafter until its owner,
> disclosure, export-control, retention, exact outbound scope, organization
> access, and Xometry-only dispatch contract are approved and enforced. Then do
> OVD-206.**

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
