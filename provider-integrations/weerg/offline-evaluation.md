# Weerg local evaluation preparation (OVD-432)

The September 7 offline implementation adds `createWeergPortalDefinition` and
`runWeergLocalEvaluationPreflight`. This is a bounded preparation slice, not an
operational adapter or a provider observation. The public envelope remains at
`envelope_defined`; no catalog, routing, admission or production state changes.

The entry point uses the shared portal kernel to verify captured exact bytes and
the provider/action/origin/path/hash approval tuple. Reviewed envelope facts must
match the actual filename, material, quantity and drawing presence. Unknown or
manual-review envelope decisions deny disclosure. Even an eligible package ends
as `unavailable: weerg_reviewed_portal_binding_missing` before browser launch.
The original homepage route placeholders and impossible upload selector were
inert. September 28 route observations below replace the placeholders; no
upload selector, currency or live offer anchor is inferred.

Synthetic unit tests exercise package binding, denial before launch, finite
classification and shared normalization. They establish no live portal facts.
Missing geography and validity remain unknown in normalized synthetic offers.
There is no purchasing capability, persistence or remote evidence destination.

## Remaining operational work

Confirm the observed login/upload routes and obtain separately authorized
observations for material/configuration controls, stable option IDs, quote
containers, currency, quantity, lead time and validity anchors. Review the bindings
and minimal scrubbed fixtures before making the entry point interaction-capable.
Shared local harness wiring is already present; retain its exact-file approval,
isolated sessions and local-only evidence.
Actual evaluation requires separate exact provider/action/origin/file approval.
OVD-432 remains incomplete; synthetic checks cannot satisfy operational criteria.

## Local harness bridge

`createWeergPortalDefinition()` and `runWeergLocalEvaluationPreflight(config,
input)` now accept omitted reviewed facts. Their default projection uses only the
actual package filename, exact material, quantity and drawing presence. Process,
account access, tolerance completeness and reviewed geometry stay unknown, even
when arbitrary `spec_snapshot` metadata suggests otherwise. The v2 adapter emits
an `unsupported` terminal state with `weerg_envelope_unknown` reason codes; this
means evaluation is unsupported until the missing facts are reviewed, not that
Weerg cannot manufacture the part. No browser launches. Explicit eligible facts
still yield `weerg_reviewed_portal_binding_missing` without interaction.

The no-argument factory is the provider-owned interface for the sole integrator's
CLI-only registry. This patch does not change that shared registry or claim the
CLI is wired. The definition's account mode states a required mode; it does not
prove an account exists or that authentication works.

## Account evidence and operator handoff

For the September 7 source work, account existence, access, isolated-session
validity and automation permission were unknown. September 28 controller
observations below establish authenticated access in its browser. They do not
establish an isolated automation session or automation permission. Do not create
an account, read cookies or infer a reusable session from the manifest.

Before a live test, record reviewed process/material/quantity/drawing/tolerance/
geometry facts; reviewed exact portal origins and real upload/configuration/offer
anchors; an existing isolated session; and an exact provider/action/origin/path/
SHA-256/quantity approval tuple with the file-bound non-export-controlled
confirmation. Recheck the current bytes and approval immediately before launch.
Account maintenance, provider interaction and file disclosure need their own
exact authorization. Stop for authentication expiry, CAPTCHA, drift or ambiguity;
keep artifacts scrubbed and local. No live test, certification or production
admission follows from these synthetic offline tests.

## September 27 recovery and superseded quote-test packet

The 2 mm cube proposal below is superseded by the September 28 candidate. Its
small size had no demonstrated suitability for a practical CNC quote.

The current `origin/main` source at `14de6d0c` still has an intentional
prelaunch stop: reviewed Weerg login/upload routes, controls, and offer anchors
have not been retained. The eligible synthetic path returns
`weerg_reviewed_portal_binding_missing` before session resolution or browser
launch. The retained OVD-432 handoff contains no live provider failure receipt.
An older operations note says a Weerg account was activated, but it does not
establish current access or an isolated session. Do not classify missing account
access as the cause without current nonsecret evidence.

The candidate CAD file is the repository's generic, synthetic 2 mm solid:

| Field | Proposed exact value or unresolved prerequisite |
| --- | --- |
| Provider and action | `weerg`, `quote_only`; no checkout or order |
| Account scope | `existing_authenticated_account`; current access and isolated session unverified |
| CAD file in this checkout | `/Users/blainewilson/.codex/worktrees/ovd432-provider-recovery/Overdrafter/worker/src/extraction/fixtures/minimal-solid.step` |
| CAD SHA-256 | `445b5b42fab753aadf4f8d31762a487cfda4fd0370fb8a9a78c6fa002260f5ed` |
| Drawing | None; drawing path and hash `null` |
| Quantity | One quote request for quantity `2` |
| Proposed process/material | CNC machining / aluminum 6082; review against the actual file and provider controls before use |
| Proposed origin | `https://www.weerg.com` only; login/upload route and any redirect origin remain unverified |
| Artifact scope | CAD upload and scrubbed local evidence only; no raw capture or customer-offer persistence |

The exact file path and hash above bind this checkout only. Recompute the hash
from the current execution checkout immediately before any approval or launch.
The operator must first confirm that the fixture is suitable and non-export-
controlled; review its process, geometry, tolerance, material, and drawing facts;
record the real portal route, controls, option IDs, price/lead anchors and allowed
origins; and supply nonsecret evidence of the existing account/session. An exact
provider/action/origin/path/hash/quantity approval is then required separately.
Until these facts are reviewed, this packet is a proposal, not a live-test grant.

After those prerequisites, allow at most **one** quote-only attempt for this
file and quantity. Stop without retry on login refresh, missing session,
CAPTCHA, unexpected origin, selector drift, ambiguous upload or mutation,
unsupported/unavailable/manual-review state, absent anchored price or lead,
or any mismatch in file bytes, approval tuple, quantity, or reviewed facts.
Retain only scrubbed local provenance and terminal evidence; report unknown
validity or geography as unknown. No provider interaction occurred while
preparing this packet.

## September 28 controller-observed routes and current test candidate

The controller observed Login from the official homepage leading through
`https://www.weerg.com/en/global/user-area/orders` to
`https://www.weerg.com/en/global/user-area/login`. After the user confirmed the
existing account, the controller observed an authenticated account header at
`https://www.weerg.com/en/global/quotation-tool/config`. The empty file library
redirected to `https://www.weerg.com/en/global/quotation-tool/upload`, displaying
`Select from your files (0)`, `New online quotation`, and `Choose your service
and upload CAD files for an instant quote`. The controller retained browser
ownership; no file was uploaded in this observation. These are route and page
observations from the September 28 controller handoff; no screenshot is retained
in this repository. They do not establish upload/configuration selectors or
offer anchors.

The adapter now records the observed login and upload routes. It keeps the
impossible upload selector and `weerg_reviewed_portal_binding_missing` prelaunch
terminal until the remaining controls and anchors are reviewed. The config route
is documented here but is not a kernel navigation target. Account access in the
controller's browser does not prove an isolated session for the local harness.

The earlier 2 mm geometry fixture is weak for a practical CNC trial. The
replacement is a synthetic, single-solid STEP block, 20 × 20 × 20 mm, derived
from a repository Open CASCADE fixture with only generic OverDrafter header
metadata. The repository geometry parser confirms millimeter units, one closed
solid, six faces, and the stated bounds; the independent OCCT importer
triangulates it. Provider acceptance and actual CNC suitability remain
unverified.

| Field | Proposed exact value or unresolved prerequisite |
| --- | --- |
| Provider and action | `weerg`, `quote_only`; no checkout or order |
| Account scope | `existing_authenticated_account`; authenticated controller browser observed, isolated harness session unverified |
| CAD file in this checkout | `/Users/blainewilson/.codex/worktrees/ovd432-provider-recovery/Overdrafter/provider-integrations/weerg/fixtures/weerg-cnc-block-20mm.step` |
| CAD SHA-256 | `d8245446d825677cb49f6bf52611536736213f87c3e481e233b3da424a1e4797` |
| Drawing | None; drawing path and hash `null` |
| Proposed process, material, quantity | CNC machining, aluminum 6082, quantity `2`; process/material are not encoded in STEP and require review |
| Observed portal origin | `https://www.weerg.com`; stop on any other origin |
| Artifact scope | CAD upload and scrubbed local evidence only; no raw capture or customer-offer persistence |

Recheck the exact bytes, geometry, provider process/material availability,
non-export-controlled classification, and authorization tuple before any live
attempt. The one-attempt and stop rules above continue to apply. No provider
upload or quote was performed during this source update.
