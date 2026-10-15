# Fictiv local evaluation evidence packet

Prepared September 26, 2026 for OVD-565. This packet describes local source and
synthetic-fixture evidence only. No Fictiv account was accessed, no file was
disclosed, no quote was requested, and no production admission was changed.

## Local contract evidence

- The reviewed public envelope remains `manifest.v1.json` and is classified by
  `fictivEnvelope.ts`. Its eligible state means only that a package matches the
  narrow offline facts in `offline-evaluation.md`.
- The standalone evaluation registry binds staged CAD and optional drawing
  bytes to the operator's SHA-256 confirmation before delegating to Fictiv.
  Fictiv itself rejects a direct unbound `live_evaluation` input before launch.
  A changed staged-file fixture produces zero browser launches.
- The adapter creates a fresh browser context with the configured session state
  for each run. A failed context setup closes the launched browser. Session
  configuration does not prove that a real account is available or permitted.
- Synthetic option fixtures prove that declared Fictiv option selectors can
  preserve option label, explicit USD total value, lead time, selector
  provenance, and the requested quantity in normalized local offers. A dollar
  sign without an explicit USD marker is currency-unknown. An amount marked
  per part, or without a proven total-price basis, cannot yield a total-price
  offer. Missing option facts remain null in local raw evidence; observed
  amounts with unknown basis remain evidence only. Geographic origin and
  validity remain unknown. Error and unanchored-price fixtures yield no offers.
- `fictiv.test.ts`, `fictivEnvelope.test.ts`, the shared adapter-contract tests,
  and `npm run provider:check` are the repeatable local checks. Their current
  revision and outcomes belong in the OVD-565 PR and rolling Linear record.

## Evidence still required for a live evaluation

1. Current, scrubbed portal observations for the upload control, process and
   configuration controls, selected-price/lead-time target, all six option
   targets, quote reference, and terminal failure signals. Existing selectors
   and synthetic text are candidate anchors, not current portal proof.
2. Explicit authorization for the exact provider action, approved account mode,
   permitted origins, non-export-controlled CAD and optional drawing bytes,
   requested quantities, and the closed descriptor required by
   `docs/provider-integration.md`. Authenticated session availability must be
   verified separately.
3. An actual local-only run showing each option value, currency and total/unit
   basis on the observed portal, stable provider identifiers, quantity, lead time, and
   scrubbed artifact references. Unknown validity, geographic origin, or
   missing options must remain unknown rather than inferred.

Production certification and customer quote routing remain a separate OVD-566
decision and require their own authority and live evidence.
