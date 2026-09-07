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
Homepage route placeholders and an impossible upload selector are inert. No
account, login/upload route, selector, currency or live offer anchor is inferred.

Synthetic unit tests exercise package binding, denial before launch, finite
classification and shared normalization. They establish no live portal facts.
Missing geography and validity remain unknown in normalized synthetic offers.
There is no purchasing capability, persistence or remote evidence destination.

## Remaining operational work

Obtain separately authorized reviewed portal observations for exact login/upload
origins, material/configuration controls, stable option IDs, quote containers,
currency, quantity, lead time and validity anchors. Review the resulting bindings
and minimal scrubbed fixtures before making the entry point interaction-capable.
The shared-file integrator then wires the provider-specific adapter into the local
harness, retaining exact-file approval, isolated sessions and local-only evidence.
Actual evaluation requires separate exact provider/action/origin/file approval.
OVD-432 remains incomplete; synthetic checks cannot satisfy operational criteria.
