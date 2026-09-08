# Geomiq offline evaluation preparation (OVD-435)

The Geomiq definition is offline preparation, not an operational portal adapter.
Its unconditional `unavailable` eligibility result prevents session access and
browser launch even after exact-file authorization. No environment flag enables it.
The CAD selector deliberately matches nothing. The public application root is
known; authenticated login/upload routes and offer anchors remain unreviewed.

`runGeomiqLocalEvaluation` delegates to the shared portal kernel, retaining exact
file/hash/action/origin approval validation. It performs no customer persistence,
admission change or purchasing operation. The coordinator owns any shared harness
wiring; importing this module alone does not select it for production routing.

Synthetic local tests cover finite state classification, no-launch behavior,
anchored multi-option identity, quantity, explicit USD prices, integer business-day
lead times, provenance, duplicate/ambiguous option rejection and unknown validity
and geography. `extractGeomiqSyntheticOffers` uses invented reserved attributes;
it is intentionally disconnected from the runtime extraction hook. Its fixtures
contain no real portal captures, account identifiers, quotes or CAD bytes.
Neither the parser nor passing tests establish live Geomiq behavior.

Before operational evaluation, review Geomiq geometry bounds and exact portal
routes, session host scope, configuration fields and offer anchors. Obtain separate
exact-file approval for any provider interaction. Replace placeholder selectors
and hooks only with reviewed evidence and rerun the adapter/kernel contract tests.
Confirm currency, quantity, lead-time units, geography and validity from anchored
provider evidence; missing values remain unknown. Any non-USD currency needs an
explicit supported contract, never a relabeling as USD. Preserve local-only
revision/hash/account-mode/time/terminal-state evidence in the standalone harness.

OVD-435 remains incomplete until the live operational requirements are proven.
OVD-436 production admission and certification remain separate.

## Remaining operational prerequisites

Account existence and current access are **unknown**. The manifest's
`existing_authenticated_account` is the required account mode, not evidence that
an account, usable session or automation permission exists. No account lookup,
authenticated portal visit or session inspection was performed for this offline
continuation.

| Gate | Evidence still needed | Owner / next action |
| --- | --- | --- |
| Account access | User confirms an existing Geomiq account and can sign in. | User handles signup if needed, passwords, MFA, CAPTCHA and account recovery; these are not authorized by the offline task. |
| Session isolation | Reviewed storage-state host scope and a dedicated local session with current access. | Prepare an isolated session only within separately approved provider interaction; never reuse another provider's session or store cookies/tokens in evidence. |
| Envelope | Reviewed geometry constraints applicable to the exact part; drawing support remains unknown. | Review first-party/provider evidence before changing the envelope. Current public evidence supports STEP/STP, CNC aluminum 6082, quantities 1–50,000 and the manifest tolerance interval; none resolves geometry or drawing eligibility. |
| Portal bindings | Authenticated routes, redirects and upload hosts; input anchors; material/quantity configuration; completion/error signals; anchored stable offer IDs, currency, prices and lead-time units. | Obtain separately authorized, scrubbed observations. The application root and `:not(*)` placeholder are not upload-route or selector evidence. |
| Optional offer facts | Provider-visible validity and geography anchors, or evidence those facts are absent. | Preserve unknown/null when absent; do not infer geography from Geomiq's address or validity from customary terms. |
| Local evaluation | Closed exact approval descriptor and current tests for the reviewed bindings. | Present the complete tuple below, then execute only after explicit approval. |
| Production | OVD-436 admission, written automation permission and hosted certification. | Separate later gate; a successful local quote cannot enable customer routing. |

The approval packet must specify `geomiq`, the existing-account mode, canonical
absolute CAD and optional drawing paths with SHA-256 digests, exact ordered
quantities, quote-only action, reviewed allowed origins, scrubbed local artifact
scope/directory, and the approval descriptor's absolute path and SHA-256 digest.
The user must confirm the exact bytes are non-export-controlled. A drawing cannot
be included until its support and exact scope are reviewed. Changing any tuple
field or descriptor byte invalidates that approval. Do not invent a file, account,
origin or run window to fill this packet.

Before enabling operational hooks, replace only evidence-backed bindings and add
provider-specific fixture tests for missing/expired session, CAPTCHA, unexpected
origin, unsupported package, manual review, selector drift, configuration failure,
ambiguous mutation and successful anchored extraction. Unknown states must stop;
ambiguous upload/configuration must not retry. The offline classifier prioritizes
unexpected origin, then CAPTCHA, then expired-session text; mixed text must not
hide an access-control challenge behind a login-refresh label. Passing synthetic
classification tests is not observation of those states on Geomiq.

The shared local harness integration belongs to the coordinator. Its evidence
must include provider and manifest/envelope/adapter revisions, authorized hashes,
account mode, timestamps, finite terminal state, normalized offers and scrubbed
artifact references. It must not persist customer offers or expose customer/account
identifiers, raw captures, file bytes or session secrets. Until geometry and portal
bindings are reviewed, selecting Geomiq through that harness must retain the
unconditional pre-session `unavailable` result; no local flag or synthetic parser
may enable live execution.
