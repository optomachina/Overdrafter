# Quote-provider integration lifecycle

Last updated: September 3, 2026

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

Manifests are non-runtime source metadata. `provider:sync` projects display name, color, official RFQ URL, purchasing domains, and integration metadata into generated web and worker catalogs. Those catalogs deliberately contain no admission, permit, dispatch, certification, or production-authorization field. The manually reviewed production-certified allowlist remains separate.

### Identity and disabled admission

The PostgreSQL `vendor_name` enum remains the runtime identity contract. When `provider:add` derives a genuinely new key, it creates two review-only SQL stubs: one for the enum value and one for a disabled admission-policy row. The stubs are not migrations and must not be applied automatically. They require normal schema review and may never seed an enabled provider.

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

### Evaluation evidence

Standalone evaluation remains operator-invoked and local. Evidence may include provider key, manifest/envelope/adapter revisions, exact file hashes, account mode, timestamps, terminal state, normalized offers with non-sensitive stable offer/option identifiers, and scrubbed artifact references. It must not contain CAD/drawing bytes, cookies, tokens, credentials, provider-account or customer identifiers, raw unsanitized screenshots/HTML, or persisted customer offers.

A successful local evaluation means only evaluation-ready/evaluated. It neither updates admission policy nor enables routing.

### Kit implementation decomposition

Build the integration kit as separate reviewable slices for the manifest/scaffolder and generated catalogs, the shared adapter kernel/certification harness, and this skill/playbook. Keep each slice Medium complexity or lower and use one integrator for the final reconciliation. Do not fold provider-specific onboarding, production admission, or opportunistic rewrites of existing custom adapters into those infrastructure slices.

## Add a provider offline

Use the repo-local `add-quote-provider` skill for intake, live continuation, or repair.

For a list of providers, use the skill's batch-intake mode. It preflights duplicate identities, assigns one bounded writer to each provider-owned directory and evaluator/test set, and keeps shared indexes, generated catalogs, Linear changes, and final verification with one integrator. This permits parallel first-party research without concurrent edits to shared generated files. Batch intake remains offline; live evaluation still requires a separate exact-file approval per provider.

For intake:

1. Research only public first-party pages. Do not authenticate, upload, create accounts, accept terms, or contact the provider.
2. Classify the integration as `api`, `declarative_portal`, `custom_portal`, or `guidance_only`. Classification describes the implementation shape, not automation permission.
3. Preview the deterministic scaffold:

   ```bash
   npm run provider:add -- --url "<official-https-url>" --dry-run
   ```

4. If the preview is safe and a new scaffold is required, rerun without `--dry-run`. Never overwrite an existing provider directory.
5. Populate only evidence-backed manifest facts. Keep all unproved claims `unknown`; record the actual review date and every first-party evidence URL.
6. Regenerate and validate:

   ```bash
   npm run provider:sync
   npm run provider:check
   npm test -- scripts/provider-add.test.mjs scripts/provider-check.test.mjs
   ```

7. Create the provider parent and the three dependency-gated children below. No live provider interaction belongs in intake.

Quickparts is the first real consumer of the completed kit. Once its scaffold and contract suite demonstrate the workflow, the remaining seven provider envelope stages may proceed in parallel with one writer per provider. Do not opportunistically rewrite existing custom adapters or protected release/session work while onboarding metadata.

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

Repair starts from a finite drift result. Compare the smallest scrubbed current-state fixture with the last reviewed selector/reference state. Roles, stable labels, test IDs, route class, and terminal signals may be retained when they contain no account/customer data. Raw whole-page captures, provider-account or customer identifiers, quote data tied to a customer, secrets, cookies, tokens, and CAD/drawing bytes may not be committed. Non-sensitive stable offer/option identifiers may appear only in local evaluation evidence; they do not belong in committed repair fixtures.

Selector and terminal-signal changes are proposals until human-reviewed. Confidence never permits automatic application. After review, run the kernel tests, reusable adapter contract, affected provider tests, `provider:check`, and the required worker/full verification lane. Until revalidation passes, changed selectors and observed prices remain untrusted. A provider-interacting retest requires a fresh exact-file live approval.

## Three-stage provider lifecycle

### 1. Define `<provider>`’s evidence-backed quote envelope

Public first-party research produces the manifest, conservative eligibility evaluation, default-off identity/catalog wiring, evidence date, and offline envelope tests. Unknown remains unknown. Marketing evidence grants neither automation permission nor production certification.

### 2. Make `<provider>` live evaluation operational

A declarative or custom adapter provides isolated session setup, exact allowed origins, provider-specific anchors, finite failures, scrubbed fixtures, normalized local evidence, and the shared adapter-contract proof. Authenticated interaction requires exact-file authorization. Completion means evaluation-ready/evaluated, not customer-enabled.

Stage 2 depends on stage 1.

### 3. Admit and certify `<provider>` for production quotes

Production admission requires acceptable written automation-permission evidence, a reviewed admission-policy revision, provider-neutral permit/preflight enforcement, hosted certification, monitoring, rollback/disable procedure, and customer-visible normalization. Only this stage may update the production-certified allowlist or enable routing.

Stage 3 depends on successful stage 2, the provider-neutral production controls, and acceptable permission evidence. Missing permission or failed certification leaves this provider disabled without blocking unrelated providers.

## Validation and rollback

Provider-kit changes use targeted scaffold/catalog/kernel/contract/skill checks during development, followed by `npm run verify` for a completed implementation slice. Live-provider commands are outside the offline gate and require their own exact approval.

The offline rollback is to revert the provider's manifest/catalog projection and any unapplied migration stubs together, then rerun `provider:sync` and `provider:check`. Runtime rollback is a stage-3 concern and must disable only the affected provider through its reviewed policy/allowlist procedure. Never repair a metadata problem by broadening routing or weakening the kernel.
