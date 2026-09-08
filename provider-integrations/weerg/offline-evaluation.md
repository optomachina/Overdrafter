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

Account existence, current access, isolated-session validity and automation
permission are **unknown**. No account or session was inspected for this work.
Do not create an account, refresh login, read cookies or infer access from the
manifest. The operator must supply nonsecret confirmation of account availability
and perform any required authentication separately before approved live work.

Before a live test, record reviewed process/material/quantity/drawing/tolerance/
geometry facts; reviewed exact portal origins and real upload/configuration/offer
anchors; an existing isolated session; and an exact provider/action/origin/path/
SHA-256/quantity approval tuple with the file-bound non-export-controlled
confirmation. Recheck the current bytes and approval immediately before launch.
Account maintenance, provider interaction and file disclosure need their own
exact authorization. Stop for authentication expiry, CAPTCHA, drift or ambiguity;
keep artifacts scrubbed and local. No live test, certification or production
admission follows from these synthetic offline tests.
