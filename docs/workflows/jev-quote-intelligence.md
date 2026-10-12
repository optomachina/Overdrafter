# Local Jev quote intelligence review

This opt-in **synthetic local review** service implements four bounded decisions:
quote evidence selection/triage, catalog matching, clarification template selection,
and optional evidence relevance. It is callable through `reviewQuoteRequest` and the
local CLI; it is not wired into production worker dispatch or customer offer publication.
No database migration, new dependency, vendor submission, UI change, or credential
configuration is included. Disable inference by using `off` (the default).

## Run the connected service

From the repository root after installing the committed root and worker dependencies:

```sh
node --import ./worker/node_modules/tsx/dist/loader.mjs worker/src/tools/reviewQuoteIntelligence.ts worker/src/quoteIntelligence/fixtures/review-synthetic.json off
node --import ./worker/node_modules/tsx/dist/loader.mjs worker/src/tools/reviewQuoteIntelligence.ts worker/src/quoteIntelligence/fixtures/review-synthetic.json shadow --jev
npm test -- worker/src/quoteIntelligence worker/src/jev/choice.test.ts
```

`--jev` uses only an already configured server-side `TYPESAFE_API_KEY`. Missing keys
produce `unconfigured` audit reasons and deterministic results. No dotenv file, key
store, remote credential, or credential creation is accessed by this CLI. Never
place credentials in packets or CLI arguments. `apply` changes local review
recommendations only. `shadow` records proposed selections but returns the same
recommendations as `off`. All packets must declare `dataClass: synthetic`; this is a
caller assertion, not a detector of sensitive data. Only use authored synthetic cases.

## Contracts and vetoes

The service validates the entire packet before inference, binds quote and catalog
scope to nonempty structured manufacturing requirements, and retains caller-reported
validation blockers. Required validation is independent of semantic clarification.
It returns `localOnly: true`, `dispatchAllowed: false`, and
`publicationAllowed: false`; a review report is never an offer or an approval.

- Quote selection copies an exact document span and its parsed value. It reuses
  `gateVendorPrice`, requires selector provenance, an explicit currency, complete
  money token, firm total basis, matching quantity/revision, and rejects observed
  scope contradictions, malformed prices, estimates, unit prices, duplicate IDs,
  and unsupported amounts. Flags remain visible. No model calculation or generated
  price is accepted. Text checks are deliberately conservative and do not prove
  arbitrary semantic truth or vendor eligibility.
- Catalog matching considers only observed IDs. All requested engineering fields
  must match exactly; material differences need an explicitly approved observed
  equivalent ID, with every other field still exact. Approval metadata is caller
  supplied for review, never inferred by Jev. Results distinguish `exact`,
  `approved_equivalent`, `no_match`, and `clarify`.
- Clarification uses fixed code-approved templates. Known structured conflicts
  cannot be dismissed, and validation blockers prevent inference. Semantic
  contradictions may select a template; nothing sends it to a customer.
- Relevance returns the **complete source evidence** as well as a presentation
  subset. Mandatory specifications, authorization, unknown evidence, and suspicious
  constraints always remain. Only explicitly classified optional marketing,
  navigation, or social context can be removed from that subset. Classification
  and keyword heuristics are not an authorization boundary. Downstream consumers
  must preserve source evidence and must never authorize from the filtered view.

## Budget and audit

The common transport is owned by the browser-recovery track:
`worker/src/jev/choice.ts`, originally commit `7b18ecf6d7c34fc1b594460c84e7e75ae41d5aa5`.
This branch includes the same change as `fe95a263`; coordinate integration to avoid
landing it twice. The feature session uses the shared pinned-distribution validator.

Transport is fixed to TypeSafe `POST /v1/systemone`, `jev-1.13.0`, no redirects or
retries. Local policy caps Choice at 64 options (stricter than the documented 255),
request JSON at 8192 bytes, 32 calls per review, 65,536 conservatively reserved
input tokens including framing, and 1500ms per call. Whole-token reservations are
not refunded on errors. Usage exceeding the reservation disables later calls.
Confidence and winning probability both require 0.9; this is an uncalibrated local
policy threshold, not measured accuracy. Budgets bound each review, not all processes.
The caller owns aggregate deployment spend limits before any production integration.

Audit includes request hash, baseline, proposal, applied selection, reason, resolved model, latency,
and token usage. It excludes raw source text, credentials, and provider errors.
Timeout, invalid response, uncertainty, unconfigured provider, service error, and
budget exhaustion return deterministic baselines. The complete provider distribution
must match supplied options, sum to one, and agree with the selected winner/model.

## Evaluation and remaining gates

`heldout.test.ts` contains independently authored synthetic domain scenarios plus
adversarial and error cases. The four intentional semantic scenarios yield **0/4
rule-baseline desired recommendations versus 4/4 scripted oracle recommendations**.
Baseline abstentions are safe. These are simulated selections testing composition,
not measured Jev accuracy, usefulness, latency, cost, or production effectiveness.
The fixture is an evaluation packet, not prompt tuning or real customer data.

No real inference was run in this worktree: its environment has no TypeSafe key.
An existing Windows Credential Manager helper is documented in
`docs/local-sample-plate.md`, but this local CLI does not retrieve or copy that key.
A supported credential-preserving invocation in the authorized environment remains
necessary for live synthetic measurement. Production integration, calibrated thresholds,
representative held-out evaluation, and independent admission remain separate gates.

Independent local review found and verified fixes for partial money tokens,
cross-currency matches, negated firmness, contradictory quantity/revision text, and
misclassified authorization/spec evidence. No unresolved finding remained for the
local synthetic review scope. No material UI impact: a recorded demo is not applicable.

Official references reviewed for this implementation:
[API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models),
[Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook),
and [citation checking](https://docs.typesafe.ai/cookbooks/citation_check).

Local verification on 2026-10-01 with Node 22.22.3 / npm 10.9.8: `npm run verify`
passed (407 Vitest files, 5,914 passed tests, one skipped; migration/provider/control-plane
checks, lint, root typechecks, frontend build, and worker build/typechecks included).
The focused command passed 49 tests including shared transport. The initial sandboxed
aggregate attempt failed on loopback permissions and stale reused worker modules;
the successful run used lockfile-identical dependency installations and permitted
local fixture servers. External Codex/Astra review was rejected by automatic approval
review and was not substituted with another transmission route. Hosted review/checks
and issue/PR linkage are not established by these local results.
