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
