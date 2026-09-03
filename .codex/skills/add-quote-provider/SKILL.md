---
name: add-quote-provider
description: Add or continue an OverDrafter quote-provider integration through evidence-backed intake, exact-file live evaluation, or reviewed selector repair. Use for requests such as "Add shopname.com"; do not use it to enable production routing or place orders.
---

# Add Quote Provider

Build provider integrations without weakening OverDrafter's quote-only safety boundaries.

## Choose one mode

- **Intake:** the user names a provider or public HTTPS URL and wants research, a scaffold, or lifecycle issues. Read [references/intake.md](references/intake.md) and [references/lifecycle.md](references/lifecycle.md).
- **Live continuation:** offline intake exists and the user wants to evaluate the provider with selected files. Read [references/live-continuation.md](references/live-continuation.md) and [references/lifecycle.md](references/lifecycle.md).
- **Repair:** a reviewed adapter reports selector drift or a changed portal state. Read [references/repair.md](references/repair.md) and [references/live-continuation.md](references/live-continuation.md).

For skill validation or a dry-run rehearsal, read [references/forward-tests.md](references/forward-tests.md).

## Invariants

- Treat manifests, evidence, implementation stage, evaluation output, and adapter readiness as descriptive only. None grants production authority.
- Keep every new provider disabled. Only lifecycle stage 3 may change the manually reviewed production-certified allowlist or enable routing.
- Preserve exact-file authorization, isolated sessions, allowed-origin enforcement, bounded waits, finite truthful outcomes, anchored offer extraction, provenance, and the checkout/order prohibition.
- Keep unknown capabilities unknown. A marketing page is neither automation permission nor production certification.
- Do not create accounts, contact providers, bypass access controls or CAPTCHA, handle secrets, purchase, or reach checkout.
- Keep public research automatic and first-party only. Require a separate exact approval immediately before any authenticated upload or other provider interaction.
- Do not disturb an active protected release, credential, cloud, recovery, or provider-session effort. Provider-kit work is offline unless live continuation has its own exact authorization.

Use the repository's Linear workflow for tracker changes and keep its single rolling progress comment current. Use `docs/provider-integration.md` as the lifecycle source of truth.
