# OverDrafter 1.0 Controlled Beta Runbook

Last updated: August 17, 2026

## Purpose

This runbook turns the 1.0 product boundary into an operable release contract.
It is the shared reference for `OVD-206`, `OVD-359`, `OVD-199`, `OVD-319`, and `OVD-358`.
The customer-research cohort, limits, evidence, and operating protocol are in
[`docs/founding-beta-program.md`](founding-beta-program.md).

**1.0 is a controlled design-partner beta, not general availability.** Beta
enrollment and automatic quote collection are invitation-only; collection is
granted to named organizations through an audited server-side control, and
self-service billing remains off. The current implementation still permits
public account creation and pre-quote file upload. This planning reset does not
pretend that path is enrollment-gated: `OVD-359` must either require approved
policy acceptance before upload or create a bounded issue to restrict upload to
enrolled organizations before 1.0 certification. A signed-in account alone
never authorizes external vendor automation.

`PRD.md` remains authoritative for product intent, `PLAN.md` for sequencing,
and `ACCEPTANCE_CRITERIA.md` for the release gates. This runbook defines the
exact supported package, disclosure checkpoint, evidence record, and operating
procedure for that scope.

## Exact 1.0 package envelope

The controlled beta accepts one part per quote request with all of the following
properties:

- one `.step` or `.stp` file submitted as one discrete part; assemblies,
  multi-part packages, meshes, and sheet-metal flat patterns are outside the
  customer promise
- declared inch or millimetre model units; unitless geometry is unsupported
- CNC milling, not turning or another manufacturing process
- aluminum 6061-T6
- quantity `1`
- as-machined finish
- standard dimensional tolerance of `+/- 0.005 in` or looser
- no threads, inserts, special inspection, certification, material-provision,
  or export-control requirement
- customer attestation that the package is non-ITAR, is not otherwise export-
  controlled, and may legally be disclosed to the named quote provider

An optional PDF drawing may be uploaded only when it describes the same part
and does not add a requirement outside this envelope. A conflict, an unknown
unit, a tighter tolerance, a special finish, or another extra requirement must
be resolved before dispatch or end in a truthful provider-guidance or
unsupported state. The system never drops a drawing requirement merely to make
the package appear eligible.

The common package envelope is not a universal provider capability claim.
Each provider must also have a versioned admitted envelope that names its
verified process, material, file-format/size, drawing, quantity, geography, and
compliance limits. A provider receives only the exact source or conversion-
derivative bytes named by the customer's current confirmation and permit; the
original remains preserved. Conversion never silently broadens eligibility.

### Geometry boundary

`OVD-206` will test repeatable unattended automatic pricing only with the private
controlled validation package described below. That bounded evidence will not
certify a numeric part-size, feature, wall-thickness, tool-access, or other
geometry envelope for customer-supplied files because OverDrafter does not yet
characterize geometry reliably.
An external STEP file that otherwise matches the manufacturing fields may
still receive vendor manual review, provider guidance, or an unsupported result.

That explicit non-promise is the geometry limit for the beta: customer copy
must not infer compatibility from file extension or material alone. Automated
geometry classification is an incubator capability and is not required to
release 1.0. The 1.0 outcome remains a truthful sourcing state and safe handoff,
not a guaranteed instant price.

### Controlled validation package for `OVD-206`

The former checked-in validation STEP/PDF pair was publicly served and is now
retired. It is not eligible for `OVD-206`, must not be restored from repository
history, and is blocked from both source and built output by an automated
containment guard. The owner must separately record the response decision for
historical repository blobs, deployments, forks, and caches.

`OVD-359` records approval of a different sanitized native STEP plus matching
PDF for Xometry-only disclosure. The package remains private. Exact paths,
source identifiers, hashes, and complete outbound requirements live only in an
access-controlled approval artifact; authorization to disclose it to Xometry
does not authorize public distribution or use as demo data.

Before any external submission, the approved `quote-lane-scope.v1` record must
pin the exact private bytes, run-generated file and requirement IDs, recorded
MIME types, complete specification, vendor, quantity, and requested date. All
five `OVD-206` runs must use the same approved scope fingerprint. Any change to
the bytes, identifiers, timestamps, MIME types, requirements, or specification
invalidates approval and restarts the series. `OVD-362` must also enforce the
server-authoritative Xometry dispatch permit before the first upload. After the
worker stages the exact approved files, a service-role-only preflight must
recheck the permit, current beta and automatic access, rollout, Xometry-only
provider configuration, and staged/current scope fingerprints immediately
before adapter invocation. The live adapter must refuse browser launch without
that bounded authorization.

## Customer disclosure checkpoint

Before any external vendor work is queued, the signed-in customer must see and
affirm all of the following in one explicit confirmation step:

1. exactly one destination provider per confirmation (Xometry is the baseline);
2. the exact CAD and drawing filenames to be disclosed;
3. the normalized process, material, finish, tolerance, quantity, and any
   drawing-derived requirements that will be sent;
4. that the customer has authority to share the files and requirements with
   that provider;
5. that the package is non-ITAR and not otherwise export-controlled;
6. that OverDrafter requests a quote only and has no authority to place or pay
   for a manufacturing order; and
7. the applicable OverDrafter data-handling notice and provider terms/privacy
   links.

The server-side record must preserve the actor, organization, timestamp, notice
revision, named provider, exact outbound file identities, normalized
requirements, and immutable disclosure-scope fingerprint. Changing any of
those facts requires a new confirmation and a new quote scope.

## Multi-provider release gate

`OVD-206` freezes the Xometry security and certification baseline. `OVD-199`
then owns the provider-neutral admission registry, compatible generalized
permit/preflight, isolated worker routing, normalized result contract, and
additional provider certifications. Release requires Xometry plus at least two
additional production-certified quote sources; five functioning sources are
preferred.

Provider admission is distinct from adapter code, enum/catalog presence,
organization preference, or a historical quote. Missing or incomplete policy
is disabled. Fictiv requires prior written consent; RapidDirect requires an
explicit contractual exception or official API agreement; Quickparts requires
written automation authorization for production/customer use. Production and
certification runs perform no login automation, session capture, selector
discovery, upload, or quote request before the controlling permission evidence
is verified. The owner-approved `OVD-407` exception permits those actions only
through the standalone live-provider evaluation harness, without granting
production admission or customer-routing eligibility.

eMachineShop is a default-on manual RFQ source only. New manual quote requests
record it as the requested vendor and the existing manual intake accepts an
operator-recorded supplier quote, but its disabled admission policy, absent
live adapter, and terms restriction prevent automated browsing, upload, or RFQ
submission.

The operational evidence register is the Linear document
[Founding Beta Provider Readiness & Admission Matrix](https://linear.app/overdrafter/document/founding-beta-provider-readiness-and-admission-matrix-75a9239a3092).
It records current permission and readiness evidence; this runbook and the
canonical repository documents remain the product and safety policy.

Before each production or certification adapter launch, the worker must recheck
current enrollment/notice, entitlement, rollout, provider admission and policy
revision, exact provider envelope, permit/task/lane identity, staged and current
scope, source and any outbound derivative hashes, and isolated session
ownership. MFA, CAPTCHA, anti-bot, changed terms, export-control ambiguity, or
purchasing behavior stops that provider lane for manual review.

The standalone `OVD-407` evaluation harness is not a production or
certification lane. It may launch an authenticated provider session and upload
operator-selected evaluation files without those admission, disclosure,
preflight, anti-bot-certification, or order-prevention dependencies. Technical
portal barriers may still produce captured failure evidence, but they do not
revoke the repository's permission to run another evaluation. Evaluation
results remain local and do not enter customer quote tables. The exception does
not waive export-control classification: the operator must explicitly confirm
the selected files are non-export-controlled, and the harness binds that
confirmation to private staged copies, verifies their exact file digests, and
uploads captured in-memory copies so later browser waits cannot swap the bytes.

## Data handling and support gate

Policy revision `founding-beta-2026-08-15` publishes the owner-approved Terms
at `/legal/beta-terms`, the Privacy/data-handling notice at `/legal/privacy`,
and the monitored support route `blaineswilson@gmail.com`. Operators use
`docs/workflows/founding-beta-support.md` for withdrawal, deletion, and incident
requests. External proprietary-part enrollment remains blocked until the
complete OVD-361 access boundary is deployed and verified, including:

- Terms of Service that cover account responsibility and quote limitations;
- a Privacy Policy and design-partner data-handling notice that state storage,
  external-provider disclosure, retention, deletion, diagnostic access, and
  incident-contact practices;
- the named support route for access, deletion, quote-correction, and suspected
  disclosure incidents; and
- links to the exact published revisions in the `OVD-319` evidence record.

Platform administrators manage organization enrollment from the Founding Beta
enrollment card on `/internal/admin`. The card reads the authoritative event
state and requires an authenticator code plus a reason before the existing
append-only grant/revoke RPC records a change. Signup, membership, role,
billing, and automatic-quote entitlement never imply enrollment.

Customer-facing account, part, project, request, and landing surfaces now
describe the Founding Beta as free and invitation-only. They provide no upgrade
action or Checkout entry point and state that no payment card, order, or
supplier commitment is created. Pricing and packaging remain unapproved 1.1
hypotheses. Governed production verification proved
`BILLING_SELF_SERVICE_ENABLED=false`; every certification and beta window must
recheck that server-side control because a hidden client action is not a
substitute.

`OVD-361` deployed the published policy, notice acceptance, and server-enforced
enrollment/upload boundary. `OVD-362` deployed the exact pre-dispatch
disclosure, immutable permit, and Xometry-only worker recheck. Governed
production verification completed through `OVD-373` with every commercial
rollout control off, so `OVD-359` and both children are closed. Any failed
recheck of these boundaries blocks provider traffic and beta recruitment.

The completed production schema upgrade and recovery evidence for these
boundaries remains governed by `docs/workflows/ovd361-production-deployment.md`.
Its postcondition verifier passed with every commercial rollout control
disabled; later provider work must preserve that evidence and use the normal
reviewed forward-migration path.

No checked-in validation part may be sent to an external provider until its exact bytes
have the authority and export-control approval above. An external participant
may upload a proprietary package for `OVD-358` only after enrollment and
current-notice acceptance are reverified.

## Supported web surface for the beta

- Current stable desktop Chrome is the primary supported completion path.
- The critical journey is checked at `390 px`, `768 px`, and `1440 px` viewport
  widths; phone and tablet layouts must preserve content and recovery actions,
  even when the final vendor handoff is easier on desktop.
- Current stable Safari and Firefox receive a smoke pass before release. A
  browser-specific failure needs either a documented safe fallback or removal
  of that browser from customer-facing support claims.
- The critical path receives a keyboard-only pass, visible-focus check,
  programmatic-label/status check, and an automated accessibility scan. These
  are bounded release checks, not a claim of universal accessibility coverage.

## Evidence record

`ACCEPTANCE_CRITERIA.md` defines what must be proven; it is not a live status
board. Verified evidence is recorded in the single rolling Linear comment for
the issue that owns it:

- `OVD-206`: hosted validation-package repeatability and forced-failure evidence
- `OVD-199`: provider admission, authorization, certification, normalized-offer,
  failure/manual-follow-up, rollback, and multi-provider release evidence
- `OVD-359`: approved Terms, Privacy/data-handling, disclosure-attestation,
  retention/deletion, support, notice-version, and implementation-gap evidence
- `OVD-319`: deployed end-to-end, authorization, disclosure, browser,
  accessibility, monitoring, rollback, legal/data-handling, and release-decision
  evidence
- `OVD-358`: Founding Beta intake/readiness, participant consent, cohort,
  external attempts, customer/staff effort, direct cost, observations, weekly
  summaries, and completion decision, without attaching proprietary customer
  files to Linear

Every evidence link must be sanitized and access-appropriate. A checkbox is
checked only after its evidence exists. The final release decision is recorded
in `OVD-319` and requires an explicit human acceptance of remaining risk.

## Operating and rollback rules

- `OVD-359` and all of its dispatch-blocking implementation children must be
  closed before any `OVD-206`, `OVD-199`, or `OVD-319` external-provider
  window. The
  deployed path must reject absent, stale, or scope-mismatched disclosure
  affirmation and must reject organizations outside the explicit beta
  enrollment boundary. A manual grant or Stripe subscription is not beta
  enrollment and must not bypass that boundary.
- Pin both selection layers before every 1.0 run: the deployed worker must have
  `WORKER_LIVE_ADAPTERS=xometry`, and the named organization must have explicit
  `org_vendor_configs` rows whose effective enabled set is exactly `xometry`.
  Do not rely on the legacy no-row default, which includes additional vendors.
  Verify the customer surface names only Xometry and stop if any non-Xometry
  lane or task is created.
  This exact-Xometry rule governs the `OVD-206` baseline series only. Later
  provider certification windows must pin the exact admitted provider set for
  that issue and prove every other provider remains disabled; legacy fallback
  is never acceptable.
- Before enabling the lane, use the read and guarded change APIs in
  [Commercial Rollout Controls](workflows/commercial-rollout-controls.md#inspect-state),
  but do **not** execute that document's Stripe/billing rollout steps. The 1.0
  subset is: verify the deployed enforcement migrations; confirm every control
  and `BILLING_SELF_SERVICE_ENABLED` are off; prove the disabled-automatic path
  creates no vendor work; prove the beta-organization boundary still rejects
  an otherwise entitled non-enrolled organization; use a bounded audited
  administration window only if the named organization needs its expiring
  capability grant; close that admin window; then enable
  `automatic_quote_collection` only for the recorded quote-certification
  window. Record the control revision, enrolled organization and capability,
  rejected non-enrolled control case, effective vendor list, operator, reason,
  idempotency key, and preflight evidence in the owning issue: `OVD-206` for
  the Xometry baseline window, the relevant `OVD-199` certification child for
  each additional provider window, and `OVD-319` for beta enablement.
- Before each certification session, confirm the named session owner and age.
  Camoufox remains the anti-bot compatibility engine proven in PR #236 after
  Patchright sessions were silently degraded by Cloudflare. PR #277 later made
  Playwright the default after it loaded Xometry's material API correctly with
  the same production storage state. The current private Cloud Run deployment
  uses Camoufox snapshot mode with a pinned launch identity restored into local
  ephemeral storage; it does not mount a live network profile or use the legacy
  `XOMETRY_STORAGE_STATE_JSON` binding. For hosted 1.0 certification, create
  the profile with the exact production Linux image and the same governed
  outbound-network path as the fresh worker, seed the private object once with
  a generation-zero precondition, and run the documented
  [two-execution no-upload authentication probe](../worker/README.md#durable-hosted-profile-snapshots)
  from fresh zero-scale jobs before retrying. If Playwright shows
  Cloudflare/no-op behavior, `401` material failures, or another anti-bot block,
  stop the window. If a fresh storage-state browser becomes anonymous, stop
  using that path. Restore a closed-browser profile snapshot from a private,
  versioned object into local ephemeral storage; run the browser only against
  that local directory; close it fully; and replace the object with a
  generation precondition. Never mount Cloud Storage FUSE or NFS as the live
  browser profile. Provisioning, exact-runtime profile seeding, and a fresh
  instance no-upload authentication probes must both pass before certification
  resumes. A successful local cold relaunch or one historical fresh-instance
  probe is insufficient after credential rotation. Current evidence shows the
  worker and auth Job used Cloud Run's dynamic outbound pool when a later fresh
  probe returned `login_required`. The `OVD-410` High-complexity and cloud-cost
  approval is recorded, and the bounded
  [stable-egress workflow](workflows/ovd410-stable-egress.md) now passes its live
  configuration verifier. Before either probe, use that workflow's separately
  authorized private recovery host to run the exact retained image through the
  same NAT, complete full snapshot revocation and generation-zero reseeding,
  and remove the recovery host/profile/archive. Separately authorize two
  independent no-upload probes before certification resumes. The PR #236 local
  quote did not prove unattended reliability;
  repeated attempts degraded after roughly ten quotes.
- Automatic collection remains server-blocked outside named beta organizations,
  including while the global collection control is temporarily enabled.
- The worker may request quotes but may not place orders, submit payment, or
  create purchase orders.
- Stop new dispatch immediately for suspected wrong-file disclosure, wrong-
  organization access, requirement mismatch, uncontrolled duplicate runs,
  unbounded queue state, vendor-session compromise, or spend-control failure.
- Use the exact [automatic-quote rollback procedure](workflows/commercial-rollout-controls.md#rollback)
  to disable automatic collection while keeping upload, review, existing-result
  access, and safe provider guidance available. Verify the read API reports the
  new state and the audit event contains the expected revision and operator.
- Record the incident or failed run, preserve sanitized diagnostic evidence,
  correct the scoped fault, and repeat the relevant certification gate before
  re-enabling the lane.
