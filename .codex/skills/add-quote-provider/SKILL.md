---
name: add-quote-provider
description: Add or continue one or many OverDrafter quote-provider integrations through evidence-backed intake, exact-file live evaluation, or reviewed selector repair. Use for requests such as "Add RMFG", "Add shopname.com", or a list of providers; do not use it to enable production routing or place orders.
---

# Add Quote Provider

Build provider integrations without weakening OverDrafter's quote-only safety boundaries.

## Choose one mode

- **Intake:** the user names a provider or public HTTPS URL and wants research, a scaffold, or lifecycle issues. Read [references/intake.md](references/intake.md) and [references/lifecycle.md](references/lifecycle.md).
- **Batch intake:** the user supplies multiple providers and wants parallel onboarding. Read [references/batch-intake.md](references/batch-intake.md), [references/intake.md](references/intake.md), and [references/lifecycle.md](references/lifecycle.md). Subagents only research and run `--dry-run`; the integrator runs the real envelope stage serially.
- **Live continuation:** offline intake exists and the user wants to evaluate the provider with selected files. Read [references/live-continuation.md](references/live-continuation.md) and [references/lifecycle.md](references/lifecycle.md).
- **Repair:** a reviewed adapter reports selector drift or a changed portal state. Read [references/repair.md](references/repair.md) and [references/live-continuation.md](references/live-continuation.md).

For skill validation or a dry-run rehearsal, read [references/forward-tests.md](references/forward-tests.md).

## Drive the generator, not hand edits

Every stage runs through Fixture, the provider onboarding generator (contract in `docs/fixture.md`):

```bash
npm run fixture:onboard -- [<key>] --stage=envelope|live|admit [--url <https-url>] [--issue OVD-<n>] [--dry-run]
```

`<key>` is required for `live` and `admit`. For `envelope` with `--url` it is optional: the stage derives the key from the URL, so omit it when the key is unknown. A key that disagrees with the derived one is refused before anything is written.

Run `--dry-run` first, then the real stage, then `npm run provider:check`. Fixture only writes disabled, non-authoritative files and runs `provider:sync`; it is deterministic, never overwrites (`unchanged`/`kept` on rerun), and refuses to run before its prerequisite stage. The envelope stage also adds a default-off entry to `provider-integrations/provider-registry.v1.json` and reports it as `registryEntry` (`added`/`unchanged`) with the regenerated outputs in `synced`. Do not hand write a file Fixture generates, or the values it derives (migration numbers, CI pins); run the stage instead. Hand editing is correct only for the evidence dependent content inside generated files that a reference names: the manifest fields (`references/intake.md`) and the placeholder routes, selectors, and locators in the live scaffold (`references/live-continuation.md`, `references/repair.md`). Fixture never overwrites an edited file, so those edits are reported `kept`.

The real envelope stage reads, modifies, and writes the shared `provider-integrations/provider-registry.v1.json` and runs `provider:sync`, which regenerates the shared catalogs and `worker/src/generated/providerRegistry.ts`. Never run it concurrently. For several providers, only the integrator runs it, one key at a time (`references/batch-intake.md`). If the generator is missing or its output looks wrong, stop and report; do not fall back to hand edits.

Provider config (live-adapter listing, session-secret names, stable egress) goes through one reviewed edit to the provider's registry entry, followed by `npm run provider:sync` and `npm run provider:check`. Never hand-edit `runtimeSecrets.ts`, `deploy-cloud-run.sh`, or egress settings; they read the registry's projections. Never edit generated files (`worker/src/generated/providerRegistry.ts`, `worker/scripts/generated/provider-secrets.sh`, generated catalogs); `provider:check` fails on drift. See `references/live-continuation.md`. The provider go-live checklist (`docs/checklists/provider-go-live-checklist.md`, OVD-690) owns the final production-readiness sequence; reference it, do not recreate it. At the enablement stage (the PR that flips `liveAdapter` or egress, adds to `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`, or applies an admission revision), emit the **Provider go-live** PR section from `.github/pull_request_template.md`, or pass `providerGoLive` to `npm run render:pr-body`. Every item except the automatic envelope review (pre-checked, signed "Grok Bot under Blaine Wilson standing authority"; `render:pr-body` fills it) needs a real evidence link (a GitHub PR, run, or commit URL in this repo, or a Linear OVD issue); never fabricate evidence or tick a box for work not done. The per-supplier on/off switch and configurable daily cap item cannot be N/A; it is satisfied by dependency on OVD-829 (https://linear.app/overdrafter/issue/OVD-829), which builds both for every supplier, so its evidence is the OVD-829 Linear issue or its merged PR. The no stored customer passwords item (encrypted session tokens only) is a separate legal stance item and needs its own evidence. Disable and kill switch PRs, and stage 1 and 2 output, do not carry the section.

## Invariants

- Treat manifests, evidence, implementation stage, evaluation output, and adapter readiness as descriptive only. None grants production authority.
- Keep every new provider disabled. Generator output never changes that. Only lifecycle stage 3 may change the manually reviewed production-certified allowlist or enable routing.
- Preserve exact-file authorization, isolated sessions, allowed-origin enforcement, bounded waits, finite truthful outcomes, anchored offer extraction, provenance, and the checkout/order prohibition.
- Keep unknown capabilities unknown. A marketing page is not production certification.
- Do not create accounts, contact providers, bypass access controls or CAPTCHA, handle secrets, purchase, or reach checkout.
- Keep public research automatic and first-party only. Require a separate exact approval immediately before any authenticated upload or other provider interaction.
- Kill switch row: a vendor added later with `alter type public.vendor_name add value` has no `private.provider_kill_switches` row until a seed row is added in the same reviewed migration. Without a row the provider reads as engaged, so it stays switched off. Add the seed row (`engaged = false` only when the provider is cleared to go live) and run `npm run provider:check`.
- Do not disturb an active protected release, credential, cloud, recovery, or provider-session effort. Provider-kit work is offline unless live continuation has its own exact authorization.
- One open PR may touch a given vendor-adapter file (`worker/src/adapters/**`, `worker/src/tools/vendor*`), drafts included. `vendor-pr-serialization` fails the newer PR. Xometry quote-page and auth-probe repair follows [references/repair.md](references/repair.md).

Use the repository's Linear workflow for tracker changes and keep its single rolling progress comment current. Use `docs/provider-integration.md` as the lifecycle source of truth.
