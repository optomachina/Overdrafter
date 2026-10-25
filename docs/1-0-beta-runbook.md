# OverDrafter 1.0 Controlled Beta Runbook

Last updated: October 23, 2026

## Purpose

Dates, checkpoints, cuts and the critical path are in
[`docs/plans/beta-launch-plan.md`](plans/beta-launch-plan.md) (approved
October 11, 2026). Its provider scope was superseded on October 20; the
[1.0 launch contract](#10-launch-contract) below is current.

This runbook turns the 1.0 product boundary into an operable release contract.
It is the shared reference for `OVD-206`, `OVD-359`, `OVD-199`, `OVD-319`,
`OVD-358`, and `OVD-686`.
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
first CNC validation package, disclosure checkpoint, evidence record, and
operating procedure for that scope. Process-specific provider routes require
their own exact qualified envelopes before customer enablement.

## 1.0 launch contract

Reconciled on October 23, 2026 from Blaine's recorded decisions. This section
is the one launch contract for `OVD-199`, `OVD-206`, `OVD-319`, `OVD-358`, and
`OVD-686`. `ACCEPTANCE_CRITERIA.md`, `PLAN.md`,
`docs/founding-beta-program.md`, and `docs/plans/beta-launch-plan.md` point
here; where an older line in one of them disagrees, this section wins until
Blaine changes it. Each `TODO(Blaine)` marks a decision that belongs to Blaine.
This section records the options and does not make the decision.

### Demo readiness vs launch readiness

These are two different bars. Read every gate, checkbox and date in the 1.0
docs against the bar it belongs to.

- **Demo readiness** means the product can be shown: a walkthrough on staging
  or a local full stack, with simulated or seeded offers allowed (for example
  the October 24–25 friends demonstration and the `OVD-1011` journey on seeded
  data). Demo readiness enables no customer, sends no invitation, and does not
  satisfy any launch gate.
- **Launch readiness** means a customer beta can be enabled. It requires every
  [launch gate](#launch-gates) to pass on the frozen release candidate in
  production. Only launch readiness lets `OVD-319` enable the beta or
  `OVD-358` send an invitation.

**Current launch-readiness verdict: NO-GO for a customer beta.** The Codex
readiness review's no-go stands. There are zero priced production runs, and
`OVD-206` has not started. A successful demo does not change this verdict. Only
the launch gates below, followed by Blaine's explicit release decision, can
change it.

### Provider scope

The controlling decisions are Blaine's October 13 decision (recorded on
`OVD-206`) and his October 20 decision (recorded on `OVD-199` and `OVD-319`).
They supersede the September 28 seven-provider list, the October 3 "Xometry
plus all seven" bar, and the October 11 five-provider plan.

| Package                                                                           | Automatic providers                   | Provider runs per package |
| --------------------------------------------------------------------------------- | ------------------------------------- | ------------------------- |
| CNC validation package ([envelope](#exact-cnc-first-validation-package-envelope)) | Xometry, Fictiv and Quickparts        | 3                         |
| Sheet-metal validation package                                                    | RMFG, through its published quote API | 1                         |

- 1.0 ships only when all four providers are independently admitted and
  production-certified, each for its own envelope. The beta-enablement
  preflight fails unless all four qualify. A provider that fails is never
  dropped or replaced silently. `TODO(Blaine)` B1: if one of the four cannot
  certify on the release candidate, choose between slipping, substituting a
  provider that passes the same gates, and shipping a narrower set.
- Weerg, Geomiq and OSH Cut are 1.1, as are SendCutSend and the other
  providers 6+. A quote-only owner clearance, a merged adapter, or a local live
  evaluation does not add any of them to the launch set or count toward it.
- Send-to-all-applicable stays behind a default-off flag. It never sends a
  sheet-metal package to a CNC-only provider or a CNC package to RMFG.
- eMachineShop stays a default-on manual RFQ source and never counts as an
  automatic provider.
- `TODO(Blaine)` B2: this repository does not record the sheet-metal validation
  package or its exact envelope (process, material, thickness, file format,
  quantity). Approve both. Also decide whether participants may bring their
  own sheet-metal parts in 1.0, or whether RMFG is proved only on the
  sheet-metal validation part.
- `TODO(Blaine)` B3: on October 22 Blaine directed that every adapter ship,
  and open PR #913 records quote-only owner clearance for Weerg, Geomiq, OSH
  Cut and SendCutSend. The provider permissions matrix and the registry
  `oneDotZero` list still mark Geomiq, OSH Cut and SendCutSend as 1.0. Confirm
  that the directive means merged adapters and local live evaluations in the
  1.1 project and does not widen the four-provider launch set. `OVD-1004` then
  narrows those flags under an exact-head review. This change does not touch
  them.

### Session rules

- `OVD-206`: the five consecutive runs share one approved scope fingerprint
  and run over at least two separate Xometry provider sessions, as
  `ACCEPTANCE_CRITERIA.md` requires.
- `OVD-319`: a second, separately established Xometry provider session must
  also be proved before beta enablement, in addition to the `OVD-206`
  sessions. Separately established means a new authentication of the company
  account through the documented recovery path, seeded as a new profile
  generation. A fresh instance that restores the same snapshot is the same
  session. `TODO(Blaine)` B4: choose the proof. This contract proposes one
  priced run of the CNC validation package on the new session (one Xometry
  run). The alternative is two no-upload authentication probes, which every
  `OVD-419` promotion already runs and which do not show that the session can
  quote.
- Fictiv and Quickparts certification each record one named session owner and
  the session age on the company-controlled account. RMFG has no browser
  session; its certification records the API key owner and rotation date
  instead.
- Every certification window also follows the session-owner, session-age, and
  fresh-instance probe rules in
  [Operating and rollback rules](#operating-and-rollback-rules).

### Run budget

Counting rule, proposed for `TODO(Blaine)` B5: one provider run is one provider
task that reaches adapter invocation for one provider and one package. Failed
runs and retries count. A denial before the adapter, a kill-switch no-traffic
check, and an `OVD-723` export walk send nothing and do not count.

Certification runs happen before participant activation and do not draw on the
participant cap:

| Certification step                        | Provider runs                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OVD-206` series                          | 5 Xometry, plus 1 if the forced failure uses a real run                                                     |
| `OVD-319` second-session proof            | 1 Xometry, if B4 chooses the priced run                                                                     |
| `OVD-319` walk                            | 3 per CNC attempt and 1 per sheet-metal attempt: 4 for one of each, 8 if both repeat after the restore step |
| Fictiv, Quickparts and RMFG certification | not defined; `TODO(Blaine)` B6                                                                              |

The participant program (`OVD-358`) keeps the default cap of twenty
automatic-provider runs or four weeks, whichever comes first. With
send-to-all-applicable routing, a CNC package uses 3 runs and a sheet-metal
package uses 1:

| Program size                                                     | Provider runs | Fits the 20-run cap                         |
| ---------------------------------------------------------------- | ------------- | ------------------------------------------- |
| Release minimum: 5 attempts, all CNC                             | 15            | Yes, with 5 left for retries or sheet metal |
| Research target: 10 packages, all CNC                            | 30            | No                                          |
| Research target: 10 packages, `c` CNC and `10 - c` sheet metal   | `10 + 2c`     | Only when `c` is 5 or less                  |
| October 11 cohort: about 10 teams with 2 to 3 jobs each, all CNC | 60 to 90      | No                                          |

`TODO(Blaine)` B7: before participant activation, choose one option and record
it in `PLAN.md` and `ACCEPTANCE_CRITERIA.md`:

- **A (proposed):** keep the twenty-run cap and set the research target to six
  CNC packages (18 runs, 2 in reserve). Each sheet-metal package used in place
  of a CNC package frees 2 runs.
- **B:** approve a separately approved experiment with a cap of at least
  thirty runs plus a retry reserve and a recorded spend ceiling, so ten CNC
  packages fit.

`TODO(Blaine)` B8: the October 11 cohort does not fit a twenty- or thirty-run
program. Decide whether it becomes a post-1.0 experiment with its own cap.

### Launch gates

**Launch readiness.** These are the go/no-go gates. A demo, a staging run or a seeded journey does not pass any of them. Every gate below must pass on the frozen release candidate before `OVD-319`
enables the beta and before `OVD-358` sends an invitation. Evidence goes in the
owning issue's rolling comment, as in [Evidence record](#evidence-record).

1. **Security closure.** `OVD-1018` (restrict `project_jobs` writes to the RPC
   path) has forward and rollback SQL, a pgTAP regression, a staging drill, and
   a production apply in a Blaine window. The other open 1.0 security
   findings are each fixed and deployed, or accepted in writing by Blaine:
   `OVD-746` (verified auth gate on client write RPCs; it targets migration
   window 2, about November 9), `OVD-949` (rollback files that re-grant
   `anon`), and `OVD-734` (durable permit consumption). `TODO(Blaine)` B9:
   decide which of those three must be fixed rather than accepted.
2. **Extraction (`OVD-1067`).** On production, a new part uploaded with the
   approved drawing either gets approved requirements or lands in a review
   hold. It never fails `extract_part` because zero requirements were
   auto-approved, and the part page shows the stored suggestions instead of
   "Unknown material". `TODO(Blaine)` B10: choose the fix. One option is the
   production setting `DRAWING_EXTRACTION_TITLE_BLOCK_APPROVAL=1`, which
   reverses the PR #884 default while `OVD-1034` is open and must also be
   passed by the deploy script. The other is the code fix that turns a zero
   approval count into a review hold.
3. **Wake on submit.** Stable egress pins the production worker to
   scale-to-zero (`min-instances=0`, `max-instances=1`), so a customer's queued
   task waits until something wakes the worker. On the release candidate, a
   customer submission must start worker processing without an operator wake
   request, and the worker must return to zero after the queue drains. No
   Linear issue is filed yet. `TODO(Blaine)` B11: set the longest acceptable
   time from submission to first claim.
4. **Shipping destination (`OVD-1068`).** A customer whose shipping address is
   missing or unconfirmed confirms it inside the quote confirmation dialog;
   the scope check then re-runs and the request continues without leaving the
   flow.
5. **Xometry baseline (`OVD-206`).** Five consecutive hosted runs of the
   approved validation package on one scope fingerprint return real Xometry
   offers that pass the live-offer gate. A forced failure ends in a finite
   safe state, and rollback is executed. Prerequisites: the `OVD-419` retry
   (`OVD-527`, then `OVD-528`, then `OVD-529`), `OVD-416` reconciliation, and
   Blaine's separate go for the window.
6. **Provider certification (`OVD-199`).** Fictiv (`OVD-395`, `OVD-566`) and
   Quickparts (`OVD-396`, `OVD-429`, `OVD-430`) are admitted and
   production-certified for the CNC envelope, and RMFG (`OVD-580`) for the
   sheet-metal envelope, through the provider-neutral permit and preflight
   (`OVD-380`). `docs/providers/acceptance-tables.md` records each provider's
   `OVD-722` kill-switch result and `OVD-723` export walk.
7. **Real-stack UI (`OVD-1011`).** The steps 1 to 7 browser journey passes on
   the real stack, then again after the live quantity-one run with real offers.
8. **Launch audit (`OVD-686`).** The three-day audit runs on the frozen
   candidate after gate 6 and before the `OVD-319` walk. Every High finding is
   fixed and verified, or accepted by Blaine through Grok Bot.
   `TODO(Blaine)` B12: Linear lists `OVD-319` as a blocker of `OVD-686`, but
   the October 11 plan runs the audit before the `OVD-319` walk. Confirm the
   order so the Linear relation can be corrected.
9. **Certification walk and release decision (`OVD-319`).** The walk passes,
   including the second-session proof above, one CNC attempt with offers from
   all three CNC providers, one RMFG sheet-metal attempt, forced failure,
   rollout disablement, restore, and a repeat. The run-budget decision (B7) is
   recorded, and Blaine makes the explicit release decision.

`TODO(Blaine)` B13: the October 23 checkpoint no longer decides the provider
count (October 20). Record its outcome, and confirm or move the October 31
release candidate, the November 6 Xometry certification, and the November 13
beta target. On October 23, `OVD-206` had not started: the `OVD-419` retry
stopped at its first no-upload probe on October 21 and rolled back.

### Decision register

| ID  | Decision for Blaine                                                                              |
| --- | ------------------------------------------------------------------------------------------------ |
| B1  | What to do if one of the four providers cannot certify                                           |
| B2  | Sheet-metal validation package and envelope; whether participants bring sheet-metal parts        |
| B3  | Whether the October 22 "every adapter ships" directive widens the launch set; the `in_1_0` flags |
| B4  | Form of the second-session proof                                                                 |
| B5  | Provider-run counting rule                                                                       |
| B6  | Certification runs for Fictiv, Quickparts and RMFG                                               |
| B7  | Run cap and research package count (option A or B)                                               |
| B8  | The October 11 cohort                                                                            |
| B9  | Fix or accept `OVD-746`, `OVD-949` and `OVD-734`                                                 |
| B10 | `OVD-1067` fix path                                                                              |
| B11 | Wake-on-submit time bound                                                                        |
| B12 | `OVD-686` and `OVD-319` order                                                                    |
| B13 | October 23 checkpoint outcome and the later dates                                                |

## Exact CNC-first validation package envelope

The first same-package comparison milestone accepts one part per quote request
with all of the following properties:

- one `.step` or `.stp` file submitted as one discrete part; assemblies,
  multi-part packages, meshes, and sheet-metal flat patterns are outside this
  CNC validation envelope
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

The 1.0 launch set is Xometry, Fictiv and Quickparts for this CNC package and
RMFG for the sheet-metal validation package (see
[Provider scope](#provider-scope)). RMFG has a separately qualified
process-specific envelope and is never a CNC quote source. Weerg, Geomiq and
OSH Cut are 1.1. Until a route is qualified and admitted, it remains
unsupported or provider guidance rather than a live automatic offer.

This CNC package envelope is not a universal provider capability claim.
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
additional provider certifications. The release proof requires Xometry,
Fictiv and Quickparts to be independently admitted and production-certified
automatic quote sources for the same disclosed CNC package, and RMFG for the
sheet-metal package. The full contract, including the go/no-go gates, is the
[1.0 launch contract](#10-launch-contract).

Every automatic source must independently support its applicable 1.0 envelope
and have provider-specific disclosure authority, session
ownership, certification, monitoring, rollback, and no-order evidence. Manual
RFQ sources and standalone evaluation results do not count toward the launch
set or establish RMFG process-specific qualification.

Certification alone is not the customer-path proof. Before release, at least
one unaided eligible CNC participant attempt must return one current,
independently traceable live offer from each of Xometry, Fictiv and Quickparts
for the same disclosed package and scope. At least one sheet-metal attempt,
on a participant's part or the sheet-metal validation part (B2), must return a
current, independently traceable live RMFG offer inside its envelope. Manual
review or inapplicable routing never counts as a live offer.

Provider admission is distinct from adapter code, enum/catalog presence,
organization preference, or a historical quote. Missing or incomplete policy
is disabled. RapidDirect is outside the 1.0 launch set and is not a release
gate.
Production and certification runs perform no login automation, session capture,
selector discovery, upload, or quote request before the provider is admitted.
The owner-approved `OVD-407` exception permits those actions only
through the standalone live-provider evaluation harness, without granting
production admission or customer-routing eligibility.

eMachineShop is a default-on manual RFQ source only. New manual quote requests
record it as the requested vendor and the existing manual intake accepts an
operator-recorded supplier quote, but its disabled admission policy and absent
live adapter prevent automated browsing, upload, or RFQ submission.

The operational evidence register is the Linear document
[Founding Beta Provider Readiness & Admission Matrix](https://linear.app/overdrafter/document/founding-beta-provider-readiness-and-admission-matrix-75a9239a3092).
It records current readiness evidence; this runbook and the
canonical repository documents remain the product and safety policy.

After OVD-410 live acceptance, the final OVD-408 worker digest follows the
fail-closed pre-mutation, parity, rollback, and evidence contract in
[`docs/workflows/ovd419-final-digest-release.md`](workflows/ovd419-final-digest-release.md).
That local contract does not authorize the build, deployment, provider-facing
probes, networking, credentials, or any production mutation.

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
supplier commitment is created. Pricing and packaging remain unapproved 1.2
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
  browser profile. Provisioning, exact-runtime profile seeding, and fresh-
  instance no-upload authentication probes must all pass before certification
  resumes. A successful local cold relaunch or one historical fresh-instance
  probe is insufficient after credential rotation. OVD-410 now records the
  completed fixed-NAT recovery ceremony, verified export and teardown,
  generation-zero reseed, narrow-access restoration, and two independent
  one-task, zero-retry fresh-instance probes that authenticated without
  interaction, file selection, mutation, or profile persistence. This satisfies
  the session/network prerequisite only; OVD-419 must still complete the
  migration-first OVD-408 release and hosted readback before OVD-206 quote
  certification begins. The PR #236 local quote did not prove unattended
  reliability;
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
