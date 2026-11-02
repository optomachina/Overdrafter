# Quote-provider integration lifecycle

Last updated: October 11, 2026

## Purpose

This document is the source of truth for adding a quote provider without weakening OverDrafter's existing authorization, session, provenance, and quote-only boundaries. It covers provider metadata, offline scaffolding, evaluation adapters, local live evidence, and the three independent gates between research and production admission.

The integration kit is not a dynamic plugin system or a production-authority registry. A provider manifest, generated catalog entry, implementation stage, passing adapter test, or successful local evaluation never enables customer traffic.

## Components and authority boundaries

### Canonical manifest

Each provider has one versioned manifest at `provider-integrations/<provider>/manifest.v1.json`, validated against `provider-integrations/provider-manifest.v1.schema.json`.

`ProviderManifestV1` records:

- stable key, display name, official HTTPS URLs/domains, and presentation metadata;
- adapter kind and process family;
- versioned process, material, file, quantity, tolerance, geometry, drawing, and account-mode knowledge;
- first-party evidence URLs and review date;
- quote-only, order-prohibited, and session-isolation requirements; and
- a descriptive implementation stage.

Capability values are tri-state: `supported`, `unsupported`, or `unknown`. Use the first two only when current public first-party evidence is direct. Missing or broad evidence remains `unknown`.

Manifests are non-runtime source metadata. `provider:sync` projects display name, color, official RFQ URL, purchasing domains, and integration metadata into generated web and worker catalogs. The worker projection additionally carries the canonical capability envelope for pure offline eligibility checks; the web projection remains presentation-only. Neither projection contains an admission, permit, dispatch, certification, or production-authorization field. The manually reviewed production-certified allowlist remains separate.

### Live-adapter registry

`provider-integrations/provider-registry.v1.json` is the single source of truth for live-adapter listing, session-secret **names**, and stable-NAT egress. It holds names only, never secret values or default secret names.

`provider:sync` generates `worker/src/generated/providerRegistry.ts` and `worker/scripts/generated/provider-secrets.sh`. `runtimeSecrets.ts`, `deploy-cloud-run.sh`, and the stable-egress contract read those projections or the registry itself. `provider:check` fails on drift or a hand edit of generated files.

Every checked-in manifest has exactly one registry entry; `provider:check` fails on a manifest without an entry or an entry without a manifest. Generators (Fixture, OVD-687) add an entry with `withDefaultRegistryEntry` from `scripts/provider-registry.mjs`, which never changes an existing entry, then run `provider:sync`. New entries default to `liveAdapter: false`, `sessionSecrets: []`, and `egress: "none"`. Turning on `liveAdapter`, adding session-secret names, or setting `egress: "stable_nat"` is a reviewed edit to the registry file only, never to the generated files. `secretNameEnv` must end in `_SECRET_NAME` and must not collide with deploy-script variables (`WORKER_MODE`, `SUPABASE_*`, `PATH`, and the names `deploy-cloud-run.sh` assigns). `liveAdapter: true` requires at least one `requiredWhenListed: true` secret or a `sessionlessJustification`, plus an explicit `egress` of `stable_nat` or `none`. Optional secrets still get a generated apply step when the env var is set and a stale-binding remove when the adapter is not listed. `manualDeploy: true` is allowlisted to xometry only so the deploy script can own that binding; it never skips another provider's remove step or required-secret check. Manifest string fields are scanned with the same secret-value detector before catalog sync. `liveAdapter: true` only allows a live deploy to list the adapter. Registry presence is not production admission; the reviewed policy, envelope, and permit still decide every dispatch. Do not put admit SQL in `supabase/migrations/`.

### Identity and disabled admission

The PostgreSQL `vendor_name` enum remains the runtime identity contract. When `provider:add` derives a genuinely new key, it creates two review-only SQL stubs: one for the enum value and one for a disabled admission-policy row. The stubs are not migrations and must not be applied automatically. They require normal schema review and may never seed an enabled provider.

`provider:add` does not contact OverDrafter or carry application credentials.
After review, the database insertion of a genuinely new disabled admission-policy
identity is the durable “provider added” boundary. That insertion creates one
idempotent platform-admin notification; dry-runs, duplicate scaffolds, validation
failures, and uncommitted provider files create none. The notification grants no
evaluation, routing, admission, or production authority.

An existing exact provider URL is an idempotent no-op. A duplicate domain, key collision, symlinked provider tree, or pre-existing unrelated provider directory is a refusal; existing work is never overwritten.

### Shared portal kernel

The provider-neutral portal kernel owns the reusable browser boundary:

- isolated storage-state resolution;
- exact authorized-file byte access;
- exact allowed-origin enforcement;
- browser lifecycle, bounded waits, and intentional retries before mutation;
- upload and configuration sequencing;
- scrubbed minimal screenshot/HTML artifact metadata;
- finite login, CAPTCHA, manual-review, unsupported, unavailable, configuration, unexpected-origin, and selector-drift states;
- anchored price and lead-time trust; and
- an unreachable checkout/order path.

A `ProviderPortalDefinition` contributes reviewed routes, allowed hosts, selectors, and terminal signals. Provider hooks may assess eligibility, configure provider-specific choices, classify portal state, and extract anchored offers with stable provider identifiers. Complex providers may retain custom adapters, but they must satisfy the same adapter contract. Existing Xometry, Fictiv, and SendCutSend behavior remains its own compatibility baseline.

The generic portal workflow is reconnaissance/evaluation infrastructure. It may prove uploadability or a finite manual-review outcome. It may not publish a whole-page or otherwise unanchored number as an offer.

#### Off-host requests (OVD-773)

Real provider pages always load telemetry, so the kernel classifies every request outside the definition's allowed hosts instead of failing on the first one:

- **Hard violation** (`unexpected_origin`, request aborted): a top-level main-frame navigation off the provider host; any request carrying an `Authorization`, `Proxy-Authorization`, or `Cookie` header; and any request with a non-empty body, unless the body is a browser-generated report (`application/csp-report` or `application/reports+json`, at most 64 KiB). Multipart uploads, form posts, JSON, and `text/plain` beacons all count as our payload. A request the kernel cannot classify fails closed as a violation.
- **Quietly blocked** (everything else: CSP reports, analytics and RUM GETs, fonts, CDN scripts, images): aborted with `blockedbyclient`, so nothing leaves the browser, and recorded as a `boundary.blocked_offhost` event with host and resource type only (never a URL or query string). The kernel result, error payloads, scrubbed evidence, and the adapter `rawPayload` carry `portalBoundary.blockedOffhostCount` and a per-host count.
- WebSocket, popup/unexpected page, and main-frame navigation rules are unchanged.

A provider whose portal genuinely needs an off-host host (for example a JS CDN) lists it in the registry entry's optional `offHostAllowlist`: exact lowercase hostnames, sorted, no wildcards. Subresource requests to an allowlisted host are continued; navigations and payload-bearing requests to it are still violations. A definition may set `offHostAllowlist` directly; otherwise the registry's value applies. Every provider starts with no allowlist, and an allowlist entry never changes `liveAdapter` or `egress`.

### Evaluation evidence

Standalone evaluation remains operator-invoked and local. Evidence may include provider key, manifest/envelope/adapter revisions, exact file hashes, account mode, timestamps, terminal state, normalized offers with non-sensitive stable offer/option identifiers, and scrubbed artifact references. It must not contain CAD/drawing bytes, cookies, tokens, credentials, provider-account or customer identifiers, raw unsanitized screenshots/HTML, or persisted customer offers.

A successful local evaluation means only evaluation-ready/evaluated. It neither updates admission policy nor enables routing.

#### Native-currency local evidence (OVD-590)

The shared kernel accepts an explicitly typed native-money candidate alongside
its existing USD candidate contract. Both unit and total amounts and their
individual ISO currency codes must be selector-anchored. Only `EUR` and `USD` are
supported by the native evidence contract. Missing/unsupported/unanchored codes,
unit/total currency disagreement, mixed-currency option sets, duplicate option
identities and mixed native/USD-shaped candidates reject the entire native batch.
There is no locale inference, symbol inference, arithmetic reconstruction or FX
conversion. Existing explicitly USD-named adapter fields retain their contract.

`PortalQuoteWorkflowAdapter.evaluateLocally()` returns the dedicated
`local_native_currency_evaluation` result for these candidates. `quote()` refuses
that result; neither `VendorQuoteAdapterOffer` nor its production output type is
widened. The USD contract also rejects native evidence nested in a raw payload.
Only the standalone local registry exposes the optional evaluation method to the
CLI. The CLI validates the native contract independently, writes native options
to `evidence.nativeCurrencyOffers` with `nativeCurrencyContractRevision`, and keeps
legacy USD prices null, USD offer lists empty, and `rawPayload` null. Existing USD
result serialization stays unchanged. Currency/amount selectors, exact quantity,
stable option identity and per-option commercial facts remain in the scrubbed
native evidence; unknown lead time, geography and validity remain unknown.

The native result has a closed runtime schema, including all nested provenance,
commercial facts and artifact metadata. Values must match their declared sources;
nonfinite numbers, invalid ISO dates, unknown nested fields and known geography
without a provider-text source are rejected. Valid ISO dates, nonsecret stable
option IDs (including numeric IDs), and reviewed selector anchors are preserved
exactly instead of being passed through the free-text scrubber. An anchor or ID
containing a sensitive path, email or credential/customer assignment withholds
the result rather than corrupting it into apparently usable evidence. Display
labels and other free text remain scrubbed. The final sanitized native result is
validated again before it reaches the CLI evidence row.

The synthetic integration suite runs the real kernel, portal adapter, local
registry and CLI JSON writer with an in-memory browser double. It provides no
live portal evidence. Default Weerg still stops before session access or browser
launch, and reviewed provider bindings and exact live approval remain required.


### Kit implementation decomposition

Build the integration kit as separate reviewable slices for the manifest/scaffolder and generated catalogs, the shared adapter kernel/certification harness, and this skill/playbook. Keep each slice Medium complexity or lower and use one integrator for the final reconciliation. Do not fold provider-specific onboarding, production admission, or opportunistic rewrites of existing custom adapters into those infrastructure slices.

## Add a provider offline

[Fixture](fixture.md) (`npm run fixture:onboard -- [<key>] --stage=envelope|live|admit`; the key is optional only for `--stage=envelope --url`) generates the default-off, review-only artifacts for each of the three stages below. `provider:add` is its `--stage=envelope` alias.

Website vendor intake (design only, not implemented) feeds this offline path and never replaces it; see [vendor intake](vendor-intake.md).

Use the repo-local `add-quote-provider` skill for intake, live continuation, or repair. The skill drives Fixture at every stage instead of hand edits, and runs `npm run provider:check` after each stage.

Provider config goes through one reviewed edit to the provider's entry in [the live-adapter registry](#live-adapter-registry) (`liveAdapter`, session-secret names, `egress`), followed by `npm run provider:sync` and `npm run provider:check`. Do not hand-edit `runtimeSecrets.ts`, `deploy-cloud-run.sh`, or egress settings; they read the registry's projections. Never edit generated files (`worker/src/generated/providerRegistry.ts`, `worker/scripts/generated/provider-secrets.sh`, or the generated catalogs). The other reviewed edits (the adapter list in `worker/src/adapters/index.ts`, `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`, moving admit review files into migrations) also stay outside Fixture; the [provider go-live checklist](checklists/provider-go-live-checklist.md) (OVD-690) sequences them. A PR that makes one of those edits to enable a provider for customers (a registry provider going to `liveAdapter: true` or gaining `stable_nat` egress, compared per provider; a new `REVIEWED_PROVIDER_DISPATCH_ENVELOPES` provider; or a migration that assigns `generic_dispatch_enabled = true` in a SET clause or insert) must carry the filled **Provider go-live** PR section; the `PR body gate` workflow (check name `provider-go-live`) decides from file content, running the base copy of its scripts. Disable and kill switch changes never need it.

For a list of providers, use the skill's batch-intake mode. It preflights duplicate identities, assigns one bounded writer to each provider-owned directory and evaluator/test set, and keeps shared indexes, generated catalogs, Linear changes, and final verification with one integrator. Subagents only research and run the `--dry-run` envelope preview. The integrator runs each key's real `--stage=envelope` serially, because that stage reads, modifies, and writes the shared provider registry and runs `provider:sync`, and then runs one `provider:sync` for the wave. This permits parallel first-party research without concurrent edits to shared generated files or the registry. Batch intake remains offline; live evaluation still requires a separate exact-file approval per provider.

For intake:

1. Research only public first-party pages. Do not authenticate, upload, create accounts, accept terms, or contact the provider.
2. Classify the integration as `api`, `declarative_portal`, `custom_portal`, or `guidance_only`. Classification describes the implementation shape only.
3. Preview the deterministic scaffold (`provider:add` is an alias of this stage):

   ```bash
   npm run fixture:onboard -- [<key>] --stage=envelope --url "<official-https-url>" --dry-run
   ```

   With `--url` the key is optional: the stage derives it, and refuses a key that disagrees with the URL.

4. If the preview is safe and a new scaffold is required, rerun without `--dry-run`. Never overwrite an existing provider directory.
5. Populate only evidence-backed manifest facts. Keep all unproved claims `unknown`; record the actual review date and every first-party evidence URL.
6. Regenerate and validate:

   ```bash
   npm run provider:sync
   npm run provider:check
   npm test -- scripts/provider-add.test.mjs scripts/fixture-onboard.test.mjs scripts/provider-check.test.mjs
   ```

7. Create the provider parent and the three dependency-gated children below. No live provider interaction belongs in intake.

Quickparts is the first real consumer of the completed kit. Once its scaffold and contract suite demonstrate the workflow, the remaining seven provider envelope stages may proceed in parallel with one writer per provider. Do not opportunistically rewrite existing custom adapters or protected release/session work while onboarding metadata.

Quickparts' evidence-backed instant-file envelope includes `STL`, `OBJ`, `WRL`, `STEP`/`STP`, `IGES`/`IGS`, and `3MF`. Its public FAQ routes `SLDPRT` to a manual quote, so the offline evaluator returns `manual_review` for that extension rather than treating it as instant-compatible.

## Exact-file live continuation

Authenticated provider interaction requires a separate approval immediately before execution. Show the user:

- exact provider key and account mode;
- absolute CAD and optional drawing paths plus SHA-256 for the exact bytes;
- exact quantities and intended quote-only action;
- exact allowed origins from the reviewed adapter definition; and
- scrubbed artifact types and local output locations.

Serialize that tuple, including canonical absolute CAD/drawing paths and exact ordered quantities, as a closed `provider-portal-approval.v1` descriptor in a local regular non-symlink file. Show and obtain approval for both the descriptor's absolute path and SHA-256. Approval is valid only for that complete tuple and descriptor bytes. Any changed path, byte/hash, provider, account mode, quantity, action, origin, artifact scope, descriptor byte, or descriptor path requires a new prompt. The files must be sanitized and explicitly confirmed non-export-controlled. A broad instruction to add a provider, continue, or finish does not authorize upload.

After exact approval, pass both `--approval-file <absolute-path>` and `--approval-file-sha256 <approved-digest>` to the standalone evaluation entry point documented by the worker. Immediately before any eligibility hook, session read, browser launch, or upload, it must safely reopen and hash the descriptor, parse its strict closed shape, re-resolve the CLI paths, recompute the selected-file hashes, and compare canonical paths, exact ordered quantities, and the full tuple with the current reviewed provider definition. Production queue paths, customer records, admission policies, and dispatch permits are not evaluation shortcuts.

Stop without further mutation on login refresh, CAPTCHA, missing session, manual review, unsupported input, unexpected origin, ambiguous navigation or mutation, selector drift, or any reachable cart/order/payment/checkout action. Never create an account, contact a provider, bypass a control, or retry an ambiguous upload automatically.

## Selector repair

The auth-probe reason `anonymous_quote_home` also covers the current instant-pricing upload-prompt page when authenticated dashboard signals are absent, even if a generic error banner is present. Re-authenticate the expired session through the governed hosted session-recovery procedure; this reason calls for session recovery, not selector repair.

Repair starts from a finite drift result. Compare the smallest scrubbed current-state fixture with the last reviewed selector/reference state. Roles, stable labels, test IDs, route class, and terminal signals may be retained when they contain no account/customer data. Raw whole-page captures, provider-account or customer identifiers, quote data tied to a customer, secrets, cookies, tokens, and CAD/drawing bytes may not be committed. Non-sensitive stable offer/option identifiers may appear only in local evaluation evidence; they do not belong in committed repair fixtures.

Selector and terminal-signal changes are proposals until human-reviewed. Confidence never permits automatic application. After review, run the kernel tests, reusable adapter contract, affected provider tests, `provider:check`, and the required worker/full verification lane. Until revalidation passes, changed selectors and observed prices remain untrusted. A provider-interacting retest requires a fresh exact-file live approval.

### Auth probe result `authenticated_dashboard_not_confirmed`

When the hosted Xometry authentication probe (the OVD-419 in-job guard reports `stage=probe_result`, `probeReason=authenticated_dashboard_not_confirmed`) ends this way, treat it as possible site drift and start selector repair. The probe saw none of its login, CAPTCHA, anonymous-page or provider-error signals, and it also missed its dashboard markers. Its signals no longer describe the page, so this is not an expired session. Do not route it to OVD-763 session refresh. The session results the probe does classify (`login_required`, `captcha`, `anonymous_quote_home`) stay on the session path.

On this result only, the probe writes one extra JSON line to stderr in the same job log. The line is keyed `fixtureHealFingerprint` and holds a scrubbed page fingerprint (`worker/src/fixtureHeal/fingerprint.ts`, OVD-796 slice 5). It contains:

- the classified URL as a route class, never the URL;
- landmark counts and heading, button, link and test ID counts;
- the heading, button and link labels that are, in full, reviewed UI phrases (generic chrome plus the literal text in `XOMETRY_LOCATORS`);
- the exact test IDs that `XOMETRY_LOCATORS` relies on;
- per text-signal group, how many patterns matched, and per selector, its element count (capped at 20) and whether the first match is visible;
- a hash of the listed labels and test IDs;
- `vocabularyDigest`, the first 16 hex characters of SHA-256 over the canonical reviewed vocabulary (signal patterns and flags, ordered selectors, labels and test IDs), computed at module load with no page-derived data. The log envelope also carries this digest when capture is unavailable.

A label or test ID that is not, in full, on the reviewed list is only counted. Filtering word by word would not be safe, because ordinary words such as "An", "Go" or "More" can also be names. The line never contains other page text, input values, URLs, emails, names, quote numbers or other identifiers. The stdout evidence line, its `domCaptured: false` attestation (no raw DOM, HTML or page text) and the guard's pass/fail rule are unchanged. If capture failed or exceeded its 3-second bound, the line carries `"fingerprint": null`.

To turn that line into the finite drift result, run these read-only steps. The first reads the job log and keeps the file outside the repository. Run the second, offline step from a checkout of the deployed worker image's commit, as pinned by the OVD-419 digest record. Merging a PR does not redeploy that image; the operator's current branch may have a different vocabulary.

```bash
gcloud logging read 'resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="<execution>"' --project <project> --limit=100 --format=json > "${TMPDIR:-/tmp}/xometry-probe-log.json"
cd worker && npx tsx src/tools/xometryDriftResult.ts "${TMPDIR:-/tmp}/xometry-probe-log.json" [--baseline <reviewed-fingerprint.json>]
```

The tool first checks the vocabulary digest on the log line, then on any baseline. `drift_fingerprint_vocabulary_mismatch` names the fingerprint and checkout digests and means the log line's reviewed vocabulary differs from this checkout: run the drift tool from the deployed image's commit. `drift_baseline_vocabulary_mismatch` names the baseline and checkout digests. It is reported only after the log line matched this checkout, so the baseline is stale: use a reviewed baseline captured with the deployed vocabulary, or drop `--baseline`. Switching commits would only make the log line mismatch instead. Missing or malformed digests are invalid, including older artifacts with no digest. Only matching digests proceed to strict validation. Any other label, test ID or group name, a malformed tally, or a stale hash rejects the line as `drift_fingerprint_invalid` (or `drift_baseline_invalid` for a baseline), so an edited line cannot carry text into the result. A tally is malformed unless its `total` is the vocabulary group's size and `matched` is an integer from 0 to `total`; each selector count must be an integer from 0 to 20, and a selector group's `matched` must equal the number of its selectors with a match. Malformed tallies are rejected, never clamped; landmark, heading, button, link and test-ID counts are still clamped to their bounds and carry only numbers. The digest identifies the vocabulary; it does not authenticate the log. The tool prints `fixture-drift-result.v1`, which contains:

- `nextStep: "selector_repair"`;
- a `driftClass` (`route`, `selector`, `label`, `cosmetic`, `none`, or `unknown` when capture failed);
- `findings` from a closed list: `route_unexpected`, `confirming_group_unmatched`, `confirming_group_partial`, `terminal_group_partial`, `entry_selectors_unmatched`, `dialog_present`, `page_sparse` and `fingerprint_unavailable`;
- the `repairTargets`, which are the locator groups to review first.

With a reviewed baseline fingerprint, `driftClass` comes from `diff()`. Without one, it comes from what `classifyXometryAuthProbe` needs to see (`XOMETRY_AUTH_PROBE_DRIFT_REFERENCE`). The repair proposal then follows the rules above. A `terminal_group_partial` finding on the anonymous-page groups suggests the session is logged out and the anonymous page's wording drifted. The fix is still a signal update. Once the probe classifies that page as `anonymous_quote_home`, the normal session path applies. The drift result may go on the repair issue. The log file may not. A scrubbed fingerprint becomes a committed baseline only through OVD-796 slice 5.

### Quote-page price collection

A Xometry quote page publishes only the complete tier set at the price the customer pays. A hidden card, a loading or disabled state, a badge-polluted header, a stale tier, or a conditional notice ("not available for quantities over 50" while the request is quantity 1) is a refusal (`selector_drift`, `availability_ambiguous`, or `pending`). It is not an `instant_quote` of the tiers that remained. Do not add a filename or `originalName` exemption to make the settle wait pass; [#920](https://github.com/optomachina/Overdrafter/pull/920) added one and then reverted it. Update the synthetic fixture in the same change: `worker/src/adapters/fixtures/xometry-quote-page-price-panel-2026-10.html`. An expired session is `anonymous_quote_home` / `login_required`, pinned by `worker/src/adapters/fixtures/xometry-anonymous-quote-home.json`, not dashboard drift. Keep the auth probe's `goto`, inspection, and fingerprint failures as separate sub-stages with a closed cause. One open PR may touch a given vendor-adapter file. `vendor-pr-serialization` fails the newer PR.

## Three-stage provider lifecycle

### 1. Define `<provider>`’s evidence-backed quote envelope

Public first-party research produces the manifest, conservative eligibility evaluation, default-off identity/catalog wiring, evidence date, and offline envelope tests. Unknown remains unknown. Marketing evidence is not production certification.

Human attestations for this stage belong on the [provider go-live checklist](checklists/provider-go-live-checklist.md). Repo-verifiable envelope artifacts stay with `provider:check`.

### 2. Make `<provider>` live evaluation operational

Generate the offline scaffold with `fixture:onboard --stage=live` (requires the manifest's supported CAD envelope and the reviewed enum change), then run `provider:check`.

A declarative or custom adapter provides isolated session setup, exact allowed origins, provider-specific anchors, finite failures, scrubbed fixtures, normalized local evidence, and the shared adapter-contract proof. Authenticated interaction requires exact-file authorization. Completion means evaluation-ready/evaluated, not customer-enabled.

Stage 2 depends on stage 1.

Use the [provider go-live checklist](checklists/provider-go-live-checklist.md) for worker-adapter, secret-name, and egress attestations. A checked box does not deploy or enable anything.

### 3. Admit and certify `<provider>` for production quotes

Production admission requires a reviewed admission-policy revision, provider-neutral permit/preflight enforcement, hosted certification, monitoring, rollback/disable procedure, and customer-visible normalization. Only this stage may update the production-certified allowlist or enable routing.

Generate review-only admission artifacts with `fixture:onboard --stage=admit` under the stage 3 issue, then run `provider:check`; applying them is a protected, reviewed action.

Stage 3 depends on successful stage 2 and the provider-neutral production controls. Failed certification leaves this provider disabled without blocking unrelated providers.

Admission still requires a human-applied reviewed SQL revision. Record that work on the [provider go-live checklist](checklists/provider-go-live-checklist.md). Admit SQL never belongs in `supabase/migrations/` from a generator.

### Generated-stage runbook (OVD-687)

`fixture:onboard` (OVD-687) emits a rollout runbook block for admit-stage work.
That block must link the [provider go-live checklist](checklists/provider-go-live-checklist.md).
Generated catalog and adapter output stays disabled by default, admit SQL stays
in review-only stubs outside `supabase/migrations/`, and worker wiring records
secret names only.

## Permissions matrix and paid-automation clearance

Paid automated quoting is cleared only by
[`docs/providers/permissions-matrix.md`](providers/permissions-matrix.md). A
manifest, catalog entry, local evaluation, or admission seed does not clear a
provider. The lint is `npm run provider:permissions`. Partner outreach lives as
drafts in [`docs/providers/outreach/`](providers/outreach/README.md) and is never
sent by an agent. A cease-and-desist uses the OVD-722 kill switch as step one
([playbook](runbooks/provider-cease-and-desist.md)).

## Validation and rollback

Provider-kit changes use targeted scaffold/catalog/kernel/contract/skill checks during development, followed by `npm run verify` for a completed implementation slice. Live-provider commands are outside the offline gate and require their own exact approval.

The offline rollback is to revert the provider's manifest/catalog projection and any unapplied migration stubs together, then rerun `provider:sync` and `provider:check`. Runtime rollback is a stage-3 concern and must disable only the affected provider through its reviewed policy/allowlist procedure. Never repair a metadata problem by broadening routing or weakening the kernel.

### Local evaluation wiring for Quickparts, Weerg and Geomiq

The standalone evaluation registry uses the provider-specific offline definitions for Quickparts, Weerg and Geomiq. The production registry remains on its existing admission path; for Quickparts and Weerg that path is a default-off production definition, which launches only behind a generic provider-dispatch authorization (OVD-674, `docs/workflows/ovd674-quickparts-live-readiness.md`; OVD-675, `docs/workflows/ovd675-weerg-live-readiness.md`). OSH Cut keeps its own adapter, whose production branch is the same kind of default-off definition behind the same authorization, with a proposed envelope excluded from the reviewed allow-list and a disabled live-adapter registry entry (OVD-677, `docs/workflows/oshcut-live-readiness.md`). Blaine deferred OSH Cut from 1.0 on 2026-10-20. Weerg's production path records native EUR quotes as non-comparable evidence and never converts them to USD. Exact file and provider approval checks precede eligibility; missing reviewed portal evidence terminates before session access or browser launch. Weerg derives only supplied package facts and keeps process, account access, tolerance and geometry unknown unless separately reviewed. Local result evidence reports the selected definition revisions and approved account mode; an account mode describes the requested scope, not proof of account access. These definitions do not establish operational readiness or authorize customer-offer persistence. See each provider’s `offline-evaluation.md` for remaining account, geometry, drawing and portal-binding prerequisites.

### Candidate envelope preflight in local evaluation

RapidDirect, Protolabs Network and Protolabs now pass through their existing
evidence-backed envelope evaluators after exact-file authorization and before
the local registry delegates to an adapter. The projection uses only the staged
filename, requested quantity, material field and drawing presence. It leaves
process, account access, tolerance completeness and geometry review unknown;
CLI defaults and arbitrary snapshot metadata cannot establish those facts.

These candidate preflights always stop before provider interaction. A finite
local error records the envelope revision, preflight revision and reason codes,
with no live offer or customer persistence. RapidDirect and Protolabs Network
can report that evidence through the existing CLI. Protolabs remains excluded
from the CLI's supported vendor list; its registry preflight does not add a new
live entry point. Production adapters and the production allowlist are unchanged.

This is preparation for independently reviewed portal bindings and package
evidence, not completion of a candidate's operational evaluation or admission.

### Opt-in bounded selector recovery

See [bounded Jev browser recovery](jev-browser-recovery.md) for the source-only
configuration-selector fallback, observed-candidate controls, advisory exception
routing, and synthetic comparison command. These injected capabilities remain off
by default and do not change provider admission or exact-file approval.
