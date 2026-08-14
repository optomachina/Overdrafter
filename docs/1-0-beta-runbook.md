# OverDrafter 1.0 Controlled Beta Runbook

Last updated: August 12, 2026

## Purpose

This runbook turns the 1.0 product boundary into an operable release contract.
It is the shared reference for `OVD-206`, `OVD-359`, `OVD-319`, and `OVD-358`.
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

### Geometry boundary

The only geometry certified for repeatable unattended automatic pricing is the
controlled validation STEP file below. OverDrafter 1.0 does not promise a numeric
part-size, feature, wall-thickness, tool-access, or other geometry envelope for
customer-supplied files because it does not yet characterize geometry reliably.
An external STEP file that otherwise matches the manufacturing fields may
still receive vendor manual review, provider guidance, or an unsupported result.

That explicit non-promise is the geometry limit for the beta: customer copy
must not infer compatibility from file extension or material alone. Automated
geometry classification is an incubator capability and is not required to
release 1.0. The 1.0 outcome remains a truthful sourcing state and safe handoff,
not a guaranteed instant price.

### Controlled validation package for `OVD-206`

The repeatability proof proposes the checked-in
`public/fixtures/1093-05589-02.STEP` file without its PDF drawing. The STEP
contains the part identifier `1093-05589-02` and real geometry; only the PDF is
documented as scrubbed. Therefore the STEP is **not approved for external
submission merely because it is checked in**. `OVD-359` must record explicit
human confirmation that OverDrafter has authority to disclose these exact
bytes to Xometry and that the model is non-ITAR and not otherwise export-
controlled. If that confirmation cannot be made, replace it with an inspected
synthetic validation part and update this manifest before `OVD-206` begins.

The Vite build copies `public/` into the deployed site, and the production
domain was observed serving these exact STEP bytes at
`/fixtures/1093-05589-02.STEP` on August 12, 2026. Treat that as a pre-existing
public-distribution exposure, not as evidence of permission. Before `OVD-359`
closes, the human owner must either confirm and retain evidence of the right to
distribute the model publicly, or remove/replace the public artifact and review
whether any notification or incident record is required. Permission for public
distribution and permission to submit the model to Xometry are separate
decisions; both must be affirmative before this file can remain the validation
package.

Proposed immutable file identity:

- repository path: `public/fixtures/1093-05589-02.STEP`
- original filename: `1093-05589-02.STEP`
- SHA-256: `4111602b512ea575c010184f904675c92b8977028088c372033a7754d1e9f043`
- size: `254205` bytes
- embedded product identifier: `1093-05589-02`
- model units: inch
- drawing: none

Proposed approved requirements:

- process: CNC milling
- material: aluminum 6061-T6
- quantity: `1`
- finish: as machined
- tightest tolerance: `+/- 0.005 in`
- description: `Controlled OVD-206 quote-lane validation part`
- part number: `1093-05589`
- revision: `02`
- requested delivery date: none
- threads, inserts, inspection, certifications, supplied material, special
  sourcing, release, shipping, and notes: none
- vendor: Xometry

The similarly named checked-in PDF requests Type II black anodize and is an
extraction regression fixture; it is deliberately excluded from this
as-machined automatic-lane proof.

Before any external submission, `OVD-359` must retain an owner-approved export
of the complete `quote-lane-scope.v1` record in an access-controlled evidence
location. Linear receives only a redacted approval reference, never the full
scope artifact or file bytes. That approved record pins the run-generated part,
file, and requirement IDs; capture timestamp; recorded MIME type; full
`specification` JSON; and every value above. The approver must check that the
specification adds no requirement outside this manifest. All five `OVD-206`
runs must use that same approved scope fingerprint. Any file-byte, identifier,
timestamp, MIME, requirement, or specification change invalidates the approval
and restarts the series.

## Customer disclosure checkpoint

Before any external vendor work is queued, the signed-in customer must see and
affirm all of the following in one explicit confirmation step:

1. the destination provider, initially Xometry;
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

## Data handling and support gate

The repository currently contains placeholder Terms and Privacy copy. Therefore
external proprietary-part enrollment is blocked until a human owner approves
and publishes all of the following:

- Terms of Service that cover account responsibility and quote limitations;
- a Privacy Policy and design-partner data-handling notice that state storage,
  external-provider disclosure, retention, deletion, diagnostic access, and
  incident-contact practices;
- a named support route for access, deletion, quote-correction, and suspected
  disclosure incidents; and
- links to the exact published revisions in the `OVD-319` evidence record.

The current signed-in account surface also presents Free/Pro packaging, a
`$49/month` price, and an Upgrade action even though packaging and pricing are
unapproved 1.1 hypotheses. Before the Founding Beta, that customer-facing offer
must be removed, hidden, or replaced with truthful invitation-only beta copy,
and the disabled billing path must be verified. A server-side Checkout failure
does not make an unapproved price claim acceptable beta copy.

Because public signup and upload are technically reachable today, the owner
must also choose one pre-beta mitigation: publish and require the approved
notice before any upload, or gate upload itself to enrolled organizations. The
selected mitigation, the pre-dispatch disclosure affirmation and immutable
server record, and a server-enforced beta-organization access boundary must be
deployed and verified before `OVD-359` closes. Approval alone does not unblock
`OVD-206`. Split the implementation into bounded child issues if needed and
keep every child in the blocking chain. Until then, do not recruit external
participants or represent the current public path as the 1.0 beta.

No checked-in validation part may be sent to an external provider until its exact bytes
have the authority and export-control approval above. No external participant
may upload a proprietary package for `OVD-358` before this gate closes and the
participant accepts the approved notice.

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
  closed before any `OVD-206` or `OVD-319` external-provider window. The
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
  quote-certification windows and `OVD-319` for beta enablement.
- Before each certification session, confirm the named session owner and age.
  Camoufox remains the anti-bot compatibility engine proven in PR #236 after
  Patchright sessions were silently degraded by Cloudflare. PR #277 later made
  Playwright the default after it loaded Xometry's material API correctly with
  the same production storage state. The current Cloud Run deployment supports
  that Playwright storage-state path, not a persistent Camoufox profile; its
  ordinary writable filesystem is not durable across instances or revisions.
  For hosted 1.0 certification, set
  `XOMETRY_BROWSER_ENGINE=playwright`, follow
  [Bootstrap Live Vendor Login State](../worker/README.md#bootstrap-live-vendor-login-state),
  run `npm --prefix worker run auth:xometry` from the repository root, publish
  the resulting storage state as a new secret version using the documented
  [Cloud Run deployment path](../worker/README.md#cloud-run-deployment), and
  prove the old state is no longer active before retrying. If Playwright shows
  Cloudflare/no-op behavior, `401` material failures, or another anti-bot block,
  stop the window. Use a persistent Camoufox profile for local compatibility
  validation, then either install its runtime, mount durable profile storage,
  and verify the hosted path or resolve the provider path before certification
  resumes. The PR #236 local quote did not prove unattended reliability;
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
