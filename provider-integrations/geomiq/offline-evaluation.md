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
