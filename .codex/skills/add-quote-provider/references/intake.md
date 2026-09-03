# Intake mode

Use this mode for a new public provider URL or when an existing scaffold needs its evidence-backed envelope completed.

## Research boundary

1. Confirm the OverDrafter workspace fingerprints in `AGENTS.md`, then read `docs/provider-integration.md`, the current manifest schema, and the provider CLI help/tests.
2. Normalize the user-supplied HTTPS URL and research only public pages controlled by the provider. Prefer official capability, file-format, account, quoting, API, legal, and help pages.
3. Do not log in, upload files, create an account, accept terms, contact the provider, or use search-result snippets or third-party summaries as evidence.
4. Record the canonical first-party URL for every material claim and the review date. If a first-party page does not prove a claim, leave the corresponding manifest field `unknown`.

## Classify the integration

Choose the narrowest evidence-supported `integration.adapterKind`:

- `api`: official API documentation describes a quote-capable interface. API existence does not prove automation permission or production readiness.
- `declarative_portal`: the quote flow fits the shared portal definition and needs only routes, exact allowed hosts, selectors, terminal signals, and bounded provider hooks.
- `custom_portal`: the flow needs provider-specific orchestration or state handling that cannot safely fit the declarative contract.
- `guidance_only`: a safe automated flow or permission basis is not established. Preserve official RFQ guidance without claiming evaluation or production capability.

Use a conservative `processFamily`. Classification describes implementation shape; it does not admit the provider.

## Scaffold and populate

Run the no-write preview first:

```bash
npm run provider:add -- --url "<official-https-url>" --dry-run
```

Review the derived key, canonical domain, collision result, and planned files. An exact existing provider is an idempotent no-op. A key/domain collision or existing unrelated directory is a stop condition; never overwrite provider work.

When a scaffold is needed, run the same command without `--dry-run`. For a genuinely new enum key, leave the generated migration files as review-only stubs. Do not apply them, edit an existing migration, or enable the admission row.

Populate `manifest.v1.json` with:

- stable key, display name, official URLs/domains, and presentation metadata;
- adapter kind, process family, and descriptive implementation stage;
- the versioned process, material, file, quantity, tolerance, geometry, drawing, and account-mode envelope;
- first-party evidence URLs and the actual review date; and
- `quoteOnly`, `orderingProhibited`, and `sessionIsolationRequired` all set to `true`.

For each envelope dimension, use `supported` or `unsupported` only when public first-party evidence is direct and unambiguous. Empty evidence is not negative evidence. Never translate broad marketing language into exact limits.

Regenerate and validate offline:

```bash
npm run provider:sync
npm run provider:check
npm test -- scripts/provider-add.test.mjs scripts/provider-check.test.mjs
```

Do not edit the production-certified allowlist. Report unknown, unsupported, conflicting, or stale claims explicitly.

## Create the lifecycle hierarchy

Create or update one provider parent, then create exactly the three children in [lifecycle.md](lifecycle.md). Make stage 2 depend on stage 1. Make stage 3 depend on successful stage 2, the provider-neutral production controls, and acceptable written automation-permission evidence. Keep future or dependency-sequenced stages in Backlog.

Maintain one rolling progress comment per issue using `AGENTS.md`. Do not mark evaluation-ready as customer-enabled, and do not let missing permission for one provider block unrelated providers.

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
