# Friend-beta manufacturing intent and provider matching audit

Audit date: September 4, 2026 (America/Phoenix).
Source baseline: `fbef43a7c5442fd7f5cdc589e5c299daa4e31818`.
Worktree branch: `codex/friend-beta-intent-audit`.

## Decision and scope

The foundation exists, but the requested friend-beta experience is incomplete.
Do not create another provider manifest, envelope, or capability database.
Runtime implementation is paused under the requested PR #442–443 overlap
boundary. This document is the audit and scoped implementation plan, not a
claim that the workflow shipped or that providers are admitted.

Acceptance criteria for this audit:

- [x] Identify existing intent persistence, projections, matching, and UI.
- [x] Identify confirmed coverage and remaining gaps against the requested flow.
- [x] Inspect active provider-kit work and PR file ownership read-only.
- [x] Preserve shared provider code and production authorization boundaries.
- [x] Record implementation acceptance criteria and targeted verification.

No Linear issue was assigned or created. No provider research claims were
newly verified on the web: evidence inventory below describes checked-in
metadata, not a fresh certification of provider capabilities.

## Existing coverage

| Area | Existing implementation | Coverage and limitation |
| --- | --- | --- |
| Manual process choice | `src/components/quotes/ClientSourcingResultPanel.tsx`; `src/pages/ClientPart.tsx` | Buttons for CNC milling and CNC turning appear for unresolved/unsupported process states and save via `handleSaveRequestPatch`. There is no explicit “I'm not sure” choice. The earlier STEP/material checks can hide these buttons. |
| Request editing | `src/components/quotes/ClientPartRequestEditor.tsx` | Editable process text, material, finish, tolerance in inches, quantities, and RFQ metadata including certifications and sourcing. It is not a process-dependent constraint questionnaire. |
| Persistence | `src/features/quotes/api/jobs-api.ts`, `api_update_client_part_request` in `supabase/migrations/20260408120000_add_revision_process_to_property_overrides.sql` | `p_process` and other requirements persist through `approved_part_requirements`, `spec_snapshot.process`, and `projectPartProperties` defaults/overrides. An explicit uncertain choice must not silently fall back to an extracted default. |
| Domain ownership | `ARCHITECTURE.md`, service-line-item migrations | `service_request_line_items` owns manufacturing service detail; `quote_requests` owns request lifecycle and `quote_runs` owns execution. The current process editor uses the approved requirement/property bridge. Do not add general intent fields to execution records. |
| Legacy profile read | `src/features/quotes/api/capability-profiles-api.ts`; `supabase/migrations/20260405100000_vendor_capability_profiles.sql` | Authenticated database profile read, with internal write policy. Fields cover processes, materials, tolerance, size, quantities, geography, certifications, and scoring metrics. The table has no canonical envelope revision, evidence URL, or explicit per-field knowledge status. `updated_at` is a row-update timestamp. |
| Recommendation computation | `src/features/quotes/sourcing-result.ts`, `scoring.ts` | Requires STEP/STP, aluminum, and a milling/turning process; filters process, quantity, material family, and explicit tolerance minimum. Ranks up to three profiles. Profiles are fetched separately from the manifest system. |
| Result presentation | `ClientSourcingResultPanel.tsx` | Collapsed “Additional sourcing paths,” fit percentage, first fit reason, and official RFQ link. Live offers and guidance are distinct. Rejected profiles disappear; there is no per-provider reason list or dedicated unknown/review outcome. |
| Canonical provider metadata | `provider-integrations/*/manifest.v1.json`, `provider-manifest.v1.schema.json` | 17 manifests. Each includes an envelope version, supported/unsupported/unknown sections, first-party evidence URLs and review date, identity, and safety metadata. Presence is not admission. |
| Generated projections | `scripts/provider-manifest.mjs`, `src/features/quotes/generated/provider-catalog.ts`, `worker/src/generated/provider-catalog.ts` | Web catalog is presentation-only. Worker catalog additionally contains the envelope. `buildCatalog` does not carry the manifest evidence object. `provider:check` checks generated consistency. |
| Offline classification | `worker/src/adapters/evidenceBackedEnvelope.ts` and provider-specific `*Envelope.ts` files | Pure finite decisions: `eligible_for_evaluation`, `manual_review`, `unsupported`, `unknown`, with reason codes and envelope revision. Provider-local policy supplies conservative quantity, drawing, tolerance, geometry, and guidance-only interpretation. No client matching call to these evaluators exists in the inspected sourcing path. |
| Authority separation | `docs/provider-integration.md`, `ARCHITECTURE.md`, sourcing live-offer allowlist | Manifests, evaluation results, and recommendations cannot grant production permission. Existing enrollment, exact disclosure permits, admission, worker preflight, and production certification remain independent. |

## Canonical inventory implications

Eight manifests have supported process/material sections: eMachineShop,
Geomiq, Ponoko, Protolabs, Protolabs Network, Quickparts, RapidDirect, and Weerg.
The other nine have unknown process/material sections, including Xometry,
Fictiv, SendCutSend, and Oshcut. An evidence review date on those manifests
does not convert their unknown fields into supported claims.

The CNC envelopes are not interchangeable. For example, Geomiq/Weerg name
`aluminum_6082`, Protolabs names `aluminum_6061_t651`, and Quickparts names
`aluminum_6061`. Most name `cnc_machining`, while the UI uses milling/turning.
eMachineShop has broader vocabulary but remains guidance-only. Ponoko's
checked-in evidence describes laser cutting/engraving and acrylic.

These are partial evidence envelopes, not complete supplier catalogs. No
provider count above represents the number of confirmed matches, launch
providers, or automatically routable providers.

## Gaps and risks

1. **Evidence disconnect.** Recommendations consume database profiles, not
   canonical envelopes or evaluator decisions. They label `profile.updated_at`
   as `capabilityReviewedAt` and attach a reviewed-profile provenance label
   without checking a manifest evidence revision/date. Internal write access
   alone does not prove every relevant capability claim.
2. **Overbroad normalization.** `normalizeMaterial` collapses 2024, 5052, 6061,
   6082, 7075, and other aluminum descriptions into `aluminum`; it cannot prove
   exact alloy/temper fit. Process normalization uses substrings; mixed or
   ambiguous strings must not become a confirmed manufacturing choice.
3. **Incomplete constraint enforcement.** The sourcing requirement projection
   passes process, material family, quantity, and tolerance to scoring. It does
   not pass geometry, finish, drawing requirements, certifications, or sourcing
   constraints. It passes `toleranceMaxMm: null`, despite reading the database
   field. A null quantity maximum is treated as no upper limit by scoring,
   unlike the Quickparts evaluator's explicit unknown-maximum policy.
4. **No explicit uncertainty workflow.** Blank/unrecognized process becomes
   unsupported/unresolved; no persistent “I'm not sure” state or bounded
   capability-review handoff is wired into this result flow. Existing internal
   manual quote requests are a different workflow and must not be auto-created
   by a capability lookup.
5. **Exclusions are discarded.** Filtered profiles have no retained reason code.
   The generic no-match explanation mentions quantity/tolerance even when the
   cause is process or missing catalog data. The percentage mixes capability
   and quality/reliability/cost scores; it is not evidence confidence.
6. **Release scope is narrower than guidance.** PRD/PLAN constrain automatic
   beta dispatch to the exact CNC-milled 6061-T6 package envelope. Existing
   turning guidance does not expand that authority. Additional process choices
   may collect intent and yield review/out-of-scope guidance, but must not be
   advertised as automatic beta support.

## Active-work coordination and hold

Read-only inspection of the active **Build provider integration kit** task
confirmed ongoing fixes to hosted quality gates in its two-PR split.

- PR #442, `OVD-486: persist provider-added admin notifications`, was open. It
  touches provider admission migration/tests, `docs/provider-integration.md`,
  `ARCHITECTURE.md`, `TEST_STRATEGY.md`, and notification taxonomy.
- PR #443, `OVD-487: show provider-added admin notifications`, was open. Its
  file list includes `src/pages/ClientPart.tsx`,
  `src/features/quotes/use-client-part-controller.ts`, workspace API exports,
  and client home/project controllers, in addition to notification surfaces.

The requested connection needs shared generator/evaluator work and the part
page/controller owned by #443. No shared source files were changed. Resume by
checking both PRs' current state, fetching the settled baseline, and reviewing
only their changes to the mapped integration points. Do not merge, cherry-pick,
or alter those tasks from this worktree. No background watcher was created.

## Scoped implementation sequence after the hold

### Evidence projection and pure matching

Reuse the manifest schema and provider-specific evaluator policy. Make the
existing pure classifier and policy accessible through a shared dependency
that imports no worker runtime, credentials, browser adapter, or queue client.
Extend the existing generator with a client-safe capability/evidence projection
derived from the same manifest inputs; do not maintain a second handwritten
catalog or copy worker policies into the UI.

Keep evaluation eligibility distinct from manufacturing capability fit:
account/session readiness and `eligible_for_evaluation` are not customer
capability confirmations. Preserve current evaluator behavior for its worker
consumers. If sharing the current classifier cannot preserve that distinction,
first define a bounded pure capability result using its existing evidence
semantics; do not repurpose the evaluation verdict as an admission flag.

The matching projection must retain per-provider confirmed/excluded/review
dispositions and reason codes. Rank only confirmed matches. Missing values,
unmapped vocabulary, stale/unavailable evidence, and constraints that the
canonical schema cannot represent remain review-required. Never interpret an
unlisted value as proven unsupported; preserve unknown vs explicit rejection.

### Manual intent and relevant constraints

Reuse the current request editor/save path. Provide explicit milling, turning,
and “I'm not sure” choices for the current beta guidance scope, with any other
process treated as out of the automatic launch scope. Preserve user-entered
requirements verbatim alongside exact normalized values. Do not infer process
from filename or geometry, or infer alloy/temper equivalence from family names.

Represent “I'm not sure” distinctly from “no override”; otherwise extraction
fallback can erase the user's uncertainty. Determine the smallest extension
of the existing requirement/service-detail bridge and preserve authorization,
revision tracking, and reload behavior. A schema/API change requires its own
scoped review before implementation, not an arbitrary sentinel in process text.

Collect applicable material/temper, quantity, tolerance, drawing and geometry
facts, and relevant existing RFQ constraints. Allow unknown answers. Do not
ask a friend to certify geometry is within a provider envelope without evidence.

### Explanations and internal review

Show confirmed matches separately from providers needing review and explicit
exclusions. Show plain-language reasons plus the evidence date/source/revision
used. Replace the implication that a fit percentage measures proof. Provide a
bounded internal review action tied to the existing part/service context;
capability matching itself stays read-only. Define persistence, ownership, and
resolution semantics before claiming a request has been sent to review. If no
appropriate internal review record exists, scope that separately instead of
reusing automatic quote queues or contacting a provider.

## Implementation acceptance criteria (not yet satisfied)

- [ ] Process choice and explicit uncertainty survive save/reload; extraction
  refresh does not overwrite manual uncertainty or confirmed user intent.
- [ ] Applicable constraints are editable with units and unknown states;
  missing/ambiguous constraints do not default to a confirmed match.
- [ ] Every confirmed provider match references the canonical evidence and
  envelope revision and satisfies all supplied relevant constraints.
- [ ] Exact alloy/temper and process mappings are explicit and evidence-backed;
  mixed process strings and unmapped values require review.
- [ ] Unknown maximum quantity, geometry, drawing, finish, certification, or
  sourcing capability cannot be promoted to supported by score or omission.
- [ ] Excluded and review-required providers retain accurate per-provider
  explanations; no-match guidance does not ask users to weaken real requirements.
- [ ] The internal review action is durable, access-controlled, idempotent, and
  visible to its owner; it creates no vendor work or external message.
- [ ] Selecting a process, changing constraints, matching, and review submission
  create zero uploads, quotes, orders, admission grants, permits, or routing changes.
- [ ] Existing live offers retain their separate certification/provenance gates;
  profile data cannot authorize or relabel them.
- [ ] Failed saves, loading/errors, stale evidence, keyboard/mobile interaction,
  and subsequent edits are covered; a recorded demo proves the changed flow.

## Verification performed

Installed existing locked root dependencies with `npm ci --ignore-scripts`;
no dependency or lockfile changes.

- `npm run provider:check`: passed, all 17 manifests and both projections.
- `npm test -- src/features/quotes/sourcing-result.test.ts src/features/quotes/scoring.test.ts src/components/quotes/ClientSourcingResultPanel.test.tsx src/components/quotes/ClientPartRequestEditor.test.tsx worker/src/adapters/evidenceBackedEnvelope.test.ts worker/src/adapters/quickpartsEnvelope.test.ts`:
  6 files, 132 tests passed.
- `npm test -- scripts/provider-manifest.test.mjs`: 13 tests passed.
- An initial test attempt lacked installed dependencies. An initial manifest
  test invocation with Node's runner was incorrect; the Vitest rerun above passed.

These are baseline coverage checks, not proof of the missing workflow. No
hosted database, browser journey, production provider, or live review handoff
was exercised. Full build/lint/repo verification is unnecessary for this
single documentation artifact; no runtime change is being handed off.

After implementation, add regression cases for each acceptance criterion,
generator drift and authority-field exclusion, evaluator-policy parity, exact
alloy/process matching, explicit unknown persistence, and zero queue/provider
side effects. Run affected request RPC/RLS tests if persistence changes, then
the required full repo gate and UI demo before review.

## Complexity and handoff

Audit artifact: **Low — Proceed**. One documentation file; no dependency,
schema, API, migration, or runtime changes. Rollback is removal of this file.
Demo: Not applicable — no material UI impact.

Complete target implementation: **High — split into scoped work before
implementation**. It crosses generated evidence projection, shared classifier
policy, persisted uncertainty/review semantics, and client UI. The sequence
above describes boundaries, not an authorization to implement the whole scope
as one change. Runtime status: paused for the active PRs and scoped review of
any required persistence contract. No deployment or provider action occurred.
