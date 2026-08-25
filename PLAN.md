# OverDrafter Execution Plan

Last updated: August 22, 2026

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
2. **Completed prerequisite: `OVD-408` — Collect and compare every Xometry quote variant**
   - Depend on `OVD-394` for stable no-order connectivity, then replace the
     singular live-adapter and worker-persistence assumption with the bounded
     one-to-many Xometry offer contract.
   - Preserve every purchasable option's provider identifiers, total and unit
     price, lead or arrival time, manufacturing tier, and explicit geographic
     sourcing provenance in a typed `vendor_quote_offers.geographic_origin`
     field that is separate from legacy descriptive `sourcing` text.
   - Include the additive constrained-field migration, generated type updates,
     and an `unknown` compatibility backfill; never infer old-row origin.
   - Group variants under Xometry and provide truthful US-only versus
     all-sourcing comparison. Unknown provenance remains visible as unknown and
     is excluded from US-only results.
   - Keep this implementation separate from `OVD-206` hosted repeatability and
     from `OVD-199` additional-provider certification.
   - PR #377 is squash-merged. The migration and worker revision still require
     a separately authorized production deployment before certification begins.
3. **In-progress prerequisite: `OVD-410` — Pin hosted Xometry authentication to stable outbound egress**
   - The promoted profile passes guarded local cold relaunch and exact snapshot
     restoration, but a fresh Cloud Run probe failed closed with
     `login_required`. The worker and probe Job now share the verified OVD-410
     Direct VPC/Public NAT path; no provider-facing probe has run on that path.
   - The owner approved the High-complexity override and cost-bearing cloud-
     network experiment on August 22, 2026. Keep provider probes, profile
     rotation, snapshot reseeding, uploads, and quote transmission separately
     gated.
   - The bounded shared-egress configuration and sanitized live postconditions
     pass. Before any provider interaction, revoke the worker's snapshot access,
     prove the old object is unreadable, and delete every old generation. Then
     reauthenticate and cold-relaunch the exact retained image on the documented
     short-lived private recovery VM through the same NAT path. After verified
     export and host teardown, seed generation zero and restore only the narrow
     worker access. Prove or disprove source-network binding only through two
     separately authorized independent zero-retry, no-upload fresh-instance
     probes.
   - `OVD-420` supplies one verified, default-deny exact-hostname egress contract
     to both the classifier-only and full recovery commands. Its provider-free
     synthetic proof covers pinned public-address routing for allowed SNI plus
     denied direct/bypass and DNS-rebinding paths without contacting Xometry.
     Recovery remains gated here until `OVD-410` reviews the production hostname
     policy and separately authorizes and completes the live provider,
     credential, cold-relaunch, reseed, and fresh-instance proofs.
4. **`OVD-206` — Validate hosted Xometry automatic quote path**
   - The `OVD-359` safety prerequisite and all dispatch-blocking children are
     closed with deployed evidence.
   - Prove the existing lane on an Xometry-only hosted worker and an explicitly
     Xometry-only organization with the owner-approved validation package in
     `docs/1-0-beta-runbook.md` and no-order/spend guardrails.
   - Capture a real price, lead time, source URL/identifier, lifecycle evidence,
     and a bounded terminal outcome when the vendor cannot quote.
   - This becomes the primary production-certification task only after
     `OVD-410` is resolved and the merged `OVD-408` release is deployed.
5. **`OVD-199` — Certify multi-provider quoting for the 1.0 Founding Beta**
   - `OVD-378` reconciled this contract across the canonical docs, and
     `OVD-379` added the private default-off admission registry. Both are
     complete; the registry remains metadata-only and is not a dispatch grant.
   - After `OVD-206` freezes the Xometry baseline, generalize its permit and
     immediate worker preflight in `OVD-380` without weakening existing
     behavior.
   - Certify Fictiv first after prior written consent, RapidDirect only after an
     explicit contractual exception or official API agreement, and Quickparts
     only after written automation authorization.
   - Keep eMachineShop available as a default-on manual RFQ source. Its public
     terms require express written permission for automated access, so its
     admission policy and browser dispatch stay disabled.
   - Require at least Xometry plus two additional production-certified sources;
     attempt five functioning sources as the preferred target.
6. **`OVD-319` — Certify and enable the scoped 1.0 production beta**
   - Depend on `OVD-408`, `OVD-206`, and `OVD-199`, not billing, and verify the
     published, implemented behavior of the approved safety, complete-offer,
     and multi-provider contracts.
   - Certify the complete signed-in upload-to-handoff journey, monitoring,
     rollback, and truthful failure behavior.
   - Keep automatic rollout bounded to the validated 1.0 lane.
7. **`OVD-358` — Run the Founding Beta and record the decision**
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
8. **Release the controlled 1.0 beta**
   - Review every checkbox in `ACCEPTANCE_CRITERIA.md`.
   - Record known non-blocking defects and operating owner.
   - Publish the narrow supported-package promise; do not imply broader CAD,
     DFM, vendor, purchasing, or fulfillment capability.

## Current portfolio disposition

### Current release routing

- `OVD-206`: keep `Blocked`. `OVD-394` proved the dedicated local Xometry
  profile, guarded cold relaunch, and one current no-order standalone quote.
  The profile has now been promoted through the governed hosted revocation and
  generation-zero reseed path. The latest authorized Cloud Run probe failed
  closed before network activation at `guard_verification`; an exact-image,
  network-isolated reproduction localized the defect to closing the last
  restored Camoufox page before creating its guarded replacement. `OVD-410`
  owns the separately scoped, High-complexity and cost-bearing static-egress
  hypothesis; after the localized lifecycle repair it must still prove
  repeatable fresh-instance authentication before the five quote runs, forced
  failure/recovery, and rollback evidence can begin.
- `OVD-408`: Done and squash-merged in PR #377. Read-only inspection of the
  governed diagnostic image proves its multi-offer worker modules are already
  present, while the production migration ledger, `geographic_origin` column,
  and reconciliation RPC are absent. Disabled rollout and an empty vendor queue
  contain this incompatible partial release; it is not production
  certification. `OVD-410` must use an isolated repaired no-upload image that
  excludes OVD-408 until a separately qualified migration-first release deploys
  the complete merged worker. That release and hosted readback remain a
  prerequisite before any `OVD-206` quote transmission.
- `OVD-410`: keep `In Progress` under the recorded High-complexity and cloud-
  cost override. The worker and auth Job now share the exact verified custom
  subnet and manual-address Public NAT path. The completion ceremony must first
  revoke worker snapshot access and delete every prior generation, then use the
  exact retained worker image on the bounded private IAP-only recovery host.
  Verified export and host teardown precede the generation-zero seed and narrow
  access restoration. The first instrumented hosted probe failed closed at the
  now-reproduced restored-page guard lifecycle boundary without enabling
  provider navigation or performing protected actions. Source-network binding
  remains a hypothesis until the localized lifecycle repair and the merged
  `OVD-420` default-deny hostname-egress control are deployed and two separately
  authorized independent no-upload probes succeed. OVD-420 provider-free
  enforcement evidence is not production hostname qualification or
  authentication evidence.
- `OVD-199`: keep `In Progress`; `OVD-378` and the metadata-only `OVD-379`
  admission registry are complete. `OVD-380` permit/preflight integration and
  later provider worker changes reuse the OVD-408 one-to-many contract and wait
  for `OVD-206` to freeze the complete Xometry baseline.
- `OVD-319`: keep in `Backlog` behind `OVD-408`, `OVD-206`, and `OVD-199`; its
  certification scope is independent of the 1.1 billing decision.
- `OVD-359`: Done with all three implementation children and governed hosted
  verification recorded. Any later policy, enrollment, file, permit, or worker
  regression in the production/customer path reopens a fail-closed release
  blocker; it does not silently widen customer-facing provider authority.
- `OVD-407`: Done under the owner-approved High-complexity override. The merged
  standalone live-provider harness bypasses production routing, customer
  disclosure, provider admission, entitlement/rollout, and dispatch permits
  while retaining file-bound non-export-controlled confirmation and local-only
  evidence. `OVD-394` subsequently proved its Xometry path with the public
  synthetic demo bracket; that result is not a customer offer or a
  production-certified lane.
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

> **Next: authorize deployment of the OVD-410 allowlisted failure-stage
> diagnostic to both governed Cloud Run resources, with rollout disabled and no
> probe execution. The first current-image replacement probe failed closed once
> with generic `probe_failed`; it used one task and zero retries, performed no
> file selection or interaction, and left the snapshot unchanged. The deployed
> generic envelope cannot distinguish snapshot restore, browser launch, guarded
> navigation, or cleanup failure. After a quiescent verifier pass, authorize one
> new probe-one execution separately; review that evidence before independently
> authorizing probe two because OVD-206 needs repeatable hosted authentication.**

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
