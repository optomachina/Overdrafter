# Intake mode

Use this mode for a new public provider URL or when an existing scaffold needs its evidence-backed envelope completed.

## Which mode you are in

This file serves two modes. Decide which one applies before running any command, and say so in your first progress note.

- **Single intake:** the user named one provider, or you are the integrator handling one key. Run every step below, including the real envelope stage.
- **Batch subagent:** `batch-intake.md` spawned you for one provider. Research, classify, and run only the `--dry-run` envelope preview, then return the proposed manifest values. Never run the envelope stage without `--dry-run`, never run `npm run provider:sync`, and never edit `provider-integrations/provider-registry.v1.json`. The real stage reads, modifies, and writes that shared registry and regenerates the shared catalogs, so parallel runs would drop each other's entries. The integrator runs it serially for each key. Leave Linear to the integrator and draft the issues only.

## Research boundary

1. Confirm the OverDrafter workspace fingerprints in `AGENTS.md`, then read `docs/provider-integration.md`, the current manifest schema, and the provider CLI help/tests.
2. Normalize the user-supplied HTTPS URL and research only public pages controlled by the provider. Prefer official capability, file-format, account, quoting, API, legal, and help pages.
3. Do not log in, upload files, create an account, accept terms, contact the provider, or use search-result snippets or third-party summaries as evidence.
4. Record the canonical first-party URL for every material claim and the review date. If a first-party page does not prove a claim, leave the corresponding manifest field `unknown`.

## Classify the integration

Choose the narrowest evidence-supported `integration.adapterKind`:

- `api`: official API documentation describes a quote-capable interface. API existence does not prove production readiness.
- `declarative_portal`: the quote flow fits the shared portal definition and needs only routes, exact allowed hosts, selectors, terminal signals, and bounded provider hooks.
- `custom_portal`: the flow needs provider-specific orchestration or state handling that cannot safely fit the declarative contract.
- `guidance_only`: a safe automated flow is not established. Preserve official RFQ guidance without claiming evaluation or production capability.

Use a conservative `processFamily`. Classification describes implementation shape; it does not admit the provider.

## Scaffold and populate

Run the preview that writes nothing first (`provider:add` is an alias of this stage):

```bash
npm run fixture:onboard -- [<key>] --stage=envelope --url "<official-https-url>" --dry-run
```

With `--url` the key is optional. Omit it when it is unknown; the stage derives it from the URL and reports it. A key that disagrees with the derived one is refused before anything is written. Review the derived key, canonical domain, collision result, and planned files. An exact existing provider is an idempotent no-op. A key/domain collision or existing unrelated directory is a stop condition; never overwrite provider work.

A batch subagent stops here and reports the preview. In single intake, or as the integrator, when a scaffold is needed, run the same command without `--dry-run`. The stage also adds the key's default-off provider-registry entry (`liveAdapter: false`, `sessionSecrets: []`, `egress: "none"`) and runs `provider:sync`; the JSON result reports `registryEntry` (`added`/`unchanged`) and `synced`. An existing registry entry is never changed. With a key and no `--url` the stage requires the manifest and only adds a missing registry entry; a key that disagrees with `--url` is refused. For a genuinely new enum key, leave the generated migration files as review-only stubs. Do not apply them, edit an existing migration, or enable the admission row.

Populate `manifest.v1.json` (a batch subagent does this only after the integrator has scaffolded its key and handed it back) with:

- stable key, display name, official URLs/domains, and presentation metadata;
- adapter kind, process family, and descriptive implementation stage;
- the versioned process, material, file, quantity, tolerance, geometry, drawing, and account-mode envelope;
- first-party evidence URLs and the actual review date; and
- `quoteOnly`, `orderingProhibited`, and `sessionIsolationRequired` all set to `true`.

For each envelope dimension, use `supported` or `unsupported` only when public first-party evidence is direct and unambiguous. Empty evidence is not negative evidence. Never translate broad marketing language into exact limits.

Regenerate and validate offline (single intake or the integrator; a batch subagent leaves `provider:sync` to the integrator):

```bash
npm run provider:sync
npm run provider:check
npm test -- scripts/fixture-onboard.test.mjs scripts/provider-add.test.mjs scripts/provider-check.test.mjs
```

Do not edit the production-certified allowlist. Report unknown, unsupported, conflicting, or stale claims explicitly.

## Create the lifecycle hierarchy

In single intake, create or update one provider parent, then create exactly the three children in [lifecycle.md](lifecycle.md). A batch subagent drafts them instead and returns the drafts. Make stage 2 depend on stage 1. Make stage 3 depend on successful stage 2 and the provider-neutral production controls. Keep future or dependency-sequenced stages in Backlog.

Maintain one rolling progress comment per issue using `AGENTS.md`. Do not mark evaluation-ready as customer-enabled, and do not let one provider's gaps block unrelated providers.

## Intake report

Return:

- provider key and canonical first-party domains;
- first-party URLs reviewed and review date;
- adapter/process classification with its evidence;
- known, unsupported, and unknown envelope claims;
- scaffold/catalog/check results and any migration stubs;
- three-stage issue IDs or complete drafts and dependency state; and
- a separate offer to prepare the exact-file live-approval prompt.

Do not begin live continuation from the user's original onboarding request alone.
