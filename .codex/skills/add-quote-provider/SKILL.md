---
name: add-quote-provider
description: Add or continue one or many OverDrafter quote-provider integrations through evidence-backed intake, exact-file live evaluation, or reviewed selector repair. Use for requests such as "Add RMFG", "Add shopname.com", or a list of providers; do not use it to enable production routing or place orders.
---

# Add Quote Provider

Build provider integrations without weakening OverDrafter's quote-only safety boundaries.

## Choose one mode

- **Intake:** the user names a provider or public HTTPS URL and wants research, a scaffold, or lifecycle issues. Read [references/intake.md](references/intake.md) and [references/lifecycle.md](references/lifecycle.md).
- **Batch intake:** the user supplies multiple providers and wants parallel onboarding. Read [references/batch-intake.md](references/batch-intake.md), [references/intake.md](references/intake.md), and [references/lifecycle.md](references/lifecycle.md).
- **Live continuation:** offline intake exists and the user wants to evaluate the provider with selected files. Read [references/live-continuation.md](references/live-continuation.md) and [references/lifecycle.md](references/lifecycle.md).
- **Repair:** a reviewed adapter reports selector drift or a changed portal state. Read [references/repair.md](references/repair.md) and [references/live-continuation.md](references/live-continuation.md).

For skill validation or a dry-run rehearsal, read [references/forward-tests.md](references/forward-tests.md).

## Drive the generator, not hand edits

Every stage runs through Fixture, the provider onboarding generator (contract in `docs/fixture.md`):

```bash
npm run fixture:onboard -- <key> --stage=envelope|live|admit [--url <https-url>] [--issue OVD-<n>] [--dry-run]
```

Run `--dry-run` first, then the real stage, then `npm run provider:check`. Fixture only writes disabled, non-authoritative files and runs `provider:sync`; it is deterministic, never overwrites (`unchanged`/`kept` on rerun), and refuses to run before its prerequisite stage. The envelope stage also adds a default-off entry to `provider-integrations/provider-registry.v1.json` and reports it as `registryEntry` (`added`/`unchanged`) with the regenerated outputs in `synced`. Do not hand-write what it generates, migration numbers, or CI pins. If the generator is missing or its output looks wrong, stop and report; do not fall back to hand edits.

Provider config (live-adapter listing, session-secret names, stable egress) goes through one reviewed edit to the provider's registry entry, followed by `npm run provider:sync` and `npm run provider:check`. Never hand-edit `runtimeSecrets.ts`, `deploy-cloud-run.sh`, or egress settings; they read the registry's projections. Never edit generated files (`worker/src/generated/providerRegistry.ts`, `worker/scripts/generated/provider-secrets.sh`, generated catalogs); `provider:check` fails on drift. See `references/live-continuation.md`. The go-live checklist (OVD-690, not yet built) will own the final production-readiness sequence; reference it, do not recreate it.

## Invariants

- Treat manifests, evidence, implementation stage, evaluation output, and adapter readiness as descriptive only. None grants production authority.
- Keep every new provider disabled. Generator output never changes that. Only lifecycle stage 3 may change the manually reviewed production-certified allowlist or enable routing.
- Preserve exact-file authorization, isolated sessions, allowed-origin enforcement, bounded waits, finite truthful outcomes, anchored offer extraction, provenance, and the checkout/order prohibition.
- Keep unknown capabilities unknown. A marketing page is not production certification.
- Do not create accounts, contact providers, bypass access controls or CAPTCHA, handle secrets, purchase, or reach checkout.
- Keep public research automatic and first-party only. Require a separate exact approval immediately before any authenticated upload or other provider interaction.
- Do not disturb an active protected release, credential, cloud, recovery, or provider-session effort. Provider-kit work is offline unless live continuation has its own exact authorization.

Use the repository's Linear workflow for tracker changes and keep its single rolling progress comment current. Use `docs/provider-integration.md` as the lifecycle source of truth.
