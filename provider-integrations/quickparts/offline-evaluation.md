# Quickparts offline evaluation preparation (OVD-429)

The provider-specific definition in `worker/src/adapters/quickpartsPortal.ts`
is a disabled local-evaluation preparation slice. It is not a live operational
adapter. No browser was opened and no Quickparts observations were collected.

`buildQuickpartsOfflinePortalDefinition` uses the existing Quickparts routes,
exact hosts, manifest/envelope revisions and shared portal kernel contract.
After the kernel checks exact paths, hashes and approval tuple, eligibility
returns `unavailable` before session access or browser launch. There is no
runtime readiness override. Customer routing and manifests are unchanged.

`extractQuickpartsSyntheticOffers` exercises proposed per-card anchors using
invented fixtures. It is deliberately disconnected from the live definition.
It requires explicit USD currency, stable unique IDs, matching quantity and
consistent anchored prices. Missing lead time, validity and geographic origin
remain unknown. No whole-page fallback, purchase action or evidence persistence
is implemented. Passing these fixtures establishes only offline contract proof.

Before operational readiness, separately authorize exact sanitized files and
the approval descriptor under `docs/provider-integration.md`. Review actual
routes, session requirements, upload/configuration anchors, finite terminal
signals and option fields. Replace synthetic assumptions with minimal scrubbed
reviewed fixtures, connect the standalone evaluation registry through the sole
integrator, and verify local evidence revisions, hashes, account mode,
timestamps, terminal state and scrubbed artifact references. No flag or passing
synthetic test can substitute for that review. OVD-429 remains incomplete;
production certification/admission belongs to OVD-430.

Offline validation: Quickparts portal/envelope tests plus the shared portal
kernel and adapter-contract suites; run the required repository gate before
landing. Rollback is removal of this provider-only preparation slice; no schema,
lockfile or production state changes are involved.

## Remaining operational prerequisites

Account existence and current access are **unknown**. The definition declares
`existing_authenticated_account` as the required mode; this is not evidence that
an account or a usable isolated session exists. No account, stored session,
provider portal or customer file was accessed during this work.

The declared terminal signals are now passed to the classifier explicitly,
including maintenance, configuration and quote-request acknowledgement. They
remain proposed synthetic cases, not reviewed observations. A generic ready
snapshot still becomes `selector_drift`, and the eligibility gate still returns
`quickparts_reviewed_portal_evidence_missing` before session access. The synthetic
extractor also refuses amounts or quantity products beyond safe integer cents.

Before a live evaluation can be made operational:

1. The user confirms whether an existing Quickparts account is available and
   completes login, password entry, MFA or CAPTCHA personally when required.
   Account creation and vendor contact require their own explicit handoff.
2. Obtain separately authorized, minimally scrubbed observations for the actual
   login/upload routes, allowed origins and session isolation requirements;
   upload controls; material/process/quantity configuration; completion,
   unsupported and manual-review signals; stable option IDs; anchored price,
   currency, lead time, validity and geographic-origin fields. None of these
   bindings is established by the synthetic attributes in this implementation.
3. Review those fixtures and implement the real bindings in a separate patch.
   Preserve unavailable/drift outcomes, bounded waits, no ambiguous-mutation
   retries and no checkout/order path. Do not connect the synthetic extractor
   to a live session. The coordinator owns local harness registry wiring.
4. Prepare the exact local approval descriptor: provider/account mode, canonical
   CAD and optional drawing paths, SHA-256 values, ordered quantities, quote-only
   action, allowed origins and artifact scope. The user must approve both the
   descriptor path and its SHA-256, and confirm the selected sanitized files are
   non-export-controlled. Changed bytes or scope require renewed approval.
5. After those gates, separately execute the approved local evaluation and
   verify finite terminal state, revision provenance, file hashes, account mode,
   timestamps, normalized options and scrubbed artifact references. Preserve
   unknown validity/origin. Do not persist customer offers or enable routing.

Offline registry integration can expose the truthful unavailable result; it does
not satisfy these prerequisites. OVD-430 remains the separate production
admission/certification stage.
