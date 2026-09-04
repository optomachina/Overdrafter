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

Every subagent must follow `intake.md`, use public first-party evidence only, keep the provider disabled, and return:

- goal;
- files inspected or changed;
- canonical domain and evidence URLs with review date;
- supported, unsupported, conflicting, and unknown claims;
- adapter/process classification;
- targeted validation result;
- requested shared touchpoints; and
- open questions.

Subagents must not edit generated catalogs, shared adapter indexes, shared manifest/tooling code, production allowlists, migrations outside their provider directory, or Linear. They must not authenticate, upload, contact a provider, or perform live evaluation.

## Single integration pass

The primary integrator owns all shared state. After provider writers finish:

1. Review each result once and reject unsupported claims or ownership leaks.
2. Apply shared adapter-index changes in one pass.
3. Run `npm run provider:sync` once for the completed wave; never have provider subagents race on generated catalogs.
4. Run `npm run provider:check`, provider-focused tests, and the repository verification lane required by `AGENTS.md`.
5. Create or update the provider parents and three gated children in Linear, preserving one rolling progress comment per issue.
6. Report each provider independently. A conflict, missing permission, or failed validation for one provider must not block unrelated providers.

Batch intake ends after offline validation and lifecycle drafting. Offer live continuation separately for each provider, and require a distinct exact-file approval for each provider/file/account tuple.
