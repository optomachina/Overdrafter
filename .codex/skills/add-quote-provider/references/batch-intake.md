# Batch intake mode

Use this mode when the user supplies two or more providers for evidence-backed offline onboarding. Batch intake parallelizes provider-owned research and files; it does not broaden authority or combine lifecycle gates.

## Preflight the batch

1. Normalize every supplied name or public HTTPS URL. When the user gives only a company name, identify its official first-party site before scaffolding; do not guess among ambiguous companies.
2. Resolve duplicate domains, derived keys, aliases, and existing provider manifests before spawning writers. Stop only the conflicting entry; unrelated providers may continue.
3. Reserve one unique provider key and provider-owned file set per subagent. Use bounded waves when the provider count exceeds available agent capacity.

## Parallel ownership

Assign one subagent per provider. Each subagent may own only:

- `provider-integrations/<provider>/`;
- provider-specific evaluator, portal-definition, fixture, and test files whose filenames contain that provider key; and
- a structured research result and three-stage issue draft for that provider.

Every subagent must follow `intake.md` in its batch subagent mode, use public first-party evidence only, keep the provider disabled, and return:

- goal;
- files inspected or changed;
- the `--dry-run` envelope preview (derived key, canonical domain, collision result, planned files) and the proposed `manifest.v1.json` values;
- canonical domain and evidence URLs with review date;
- supported, unsupported, conflicting, and unknown claims;
- adapter/process classification;
- targeted validation result;
- requested shared touchpoints; and
- open questions.

Subagents only research and run `npm run fixture:onboard -- [<key>] --stage=envelope --url "<official-https-url>" --dry-run`, which writes nothing. They must not run the envelope stage without `--dry-run`, because that stage reads, modifies, and writes the shared `provider-integrations/provider-registry.v1.json` and runs `npm run provider:sync`. They must not run `provider:sync` themselves.

Subagents must not edit the provider registry, generated catalogs, shared adapter indexes, shared manifest/tooling code, production allowlists, migrations outside their provider directory, or Linear. They must not authenticate, upload, contact a provider, or perform live evaluation.

## Single integration pass

The primary integrator owns all shared state. After provider writers finish:

1. Review each result once and reject unsupported claims or ownership leaks.
2. Run the real envelope stage serially, one key at a time, never in parallel: `npm run fixture:onboard -- <key> --stage=envelope --url "<official-https-url>"`. Each run adds that key's default off registry entry and runs `provider:sync`, and reports `registryEntry` and `synced`. Wait for each run to finish before starting the next, so no registry write is lost. A refusal stops only that key.
3. Hand each scaffolded key back to its provider's writer, or populate it yourself, to fill `manifest.v1.json` and the provider's own evaluator and test files from the reviewed result. This touches only files owned by that provider, so it may run in parallel.
4. Apply shared adapter-index changes in one pass.
5. Run `npm run provider:sync` once for the completed wave; never have provider subagents race on the registry or generated catalogs.
6. Run `npm run provider:check`, provider-focused tests, and the repository verification lane required by `AGENTS.md`.
7. Create or update the provider parents and three gated children in Linear, preserving one rolling progress comment per issue.
8. Report each provider independently. A conflict or failed validation for one provider must not block unrelated providers.

Batch intake ends after offline validation and lifecycle drafting. Offer live continuation separately for each provider, and require a distinct exact-file approval for each provider/file/account tuple.
