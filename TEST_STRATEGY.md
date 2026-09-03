# OverDrafter Test Strategy

Last updated: July 28, 2026

## Purpose

This document defines how OverDrafter should be verified locally, in CI, and during agent-driven development.

## Verification layers

### Layer 1 — Static verification
- lint
- type checking
- format checks if used
- build-time sanity checks where cheap

### Layer 2 — Unit and component verification
- pure business logic tests
- utility tests
- reducer/state tests
- component tests where logic is isolated

### Layer 3 — Integration verification
- flows spanning multiple modules
- data-flow validation across boundaries
- workflow state transitions

### Layer 4 — UI smoke and end-to-end verification
- core navigation
- intake happy path
- project or part workspace smoke coverage
- critical internal review surfaces

## Verification lanes

### Lane A — Fast local verification
- `npm run lint`
- `npm run typecheck`
- relevant unit/component tests
- `npm run build` when needed
- `npm run verify:worker` when worker changes are in scope

### Lane B — Feature verification
- all fast local verification
- relevant integration tests
- targeted UI smoke checks

### Lane C — Release-confidence verification
- `npm run verify` from the repo root
- CI-equivalent checks
- broader smoke or E2E coverage
- worker verification is included in the root `verify` command
- migration validation if affected

## Debugging lane selection

Use `docs/debugging-workflows.md` for the exact commands and setup details. Pick the fastest lane that still exercises the behavior under test:

- production-realistic lane for auth, RLS, memberships, routing, and real Supabase-backed behavior
- fast E2E lane for repeatable browser regressions, smoke coverage, and saved-session flows
- UI tuning lane for deterministic client workspace states that do not need live Supabase data

## Change-type expectations

### Docs-only or repo-workflow documentation changes
- verify that referenced commands, paths, branch rules, issue states, and skill names still match the repo
- rerun `./scripts/symphony-preflight.sh`
- run broader app or worker verification only when the change also updates scripts, commands, or behavior

### Cosmetic or copy-only changes
- lint
- typecheck
- build if affected
- manual screen check

### UI behavior changes
- lint
- typecheck
- targeted automated tests where practical
- smoke verification of the affected flow
- when refactoring a large route into route-local modules, add focused tests for extracted view-model hooks or pure selectors so derived state stays covered outside JSX
- for Quote Intelligence navigation, verify Parts/Quotes/Search at phone, tablet, and desktop widths
- for buyer quote comparison, assert total-price Y values, working-day X values, fixed independent points, and synchronized table/chart selection
- keep noncomparable offers visible with explicit reasons, render missing-lead offers in the chart's unavailable zone, and prevent ineligible options from being selected
- for authenticated workspace caches, verify account and access-scope changes synchronously clear prior rendered lists and remove prior subject-bound queries before the next session is published

### iOS application changes

- generate the Xcode project from the committed project definition
- run Swift unit tests for route mapping and navigation policy
- build and test an iPhone simulator destination
- build and test an iPad simulator destination
- verify auth-session persistence, file upload, external-link handoff, offline/retry behavior, and deep-link routing
- validate a generic-device archive before TestFlight upload
- install and smoke-test the uploaded TestFlight build before release completion

### Mobile browser-authentication changes

- treat browser auth, callback validation, session handoff, logout, and account
  switching as high-risk auth work even when native UI changes are small
- use the production-realistic lane for the backend bridge, Supabase session
  verification, membership resolution, revocation, and subject-cache clearing
- assert PKCE S256, exact claimed-HTTPS callback matching, state validation,
  allowlisted return routes, two-minute expiry, and atomic single use
- verify Supabase owns upstream provider state/nonce validation and the website
  callback validates its browser transaction before exchanging the Supabase
  code with a ceremony-scoped PKCE verifier independent from the native handoff
- test serial and concurrent replay, wrong verifier, wrong state, provider
  failure, cancellation, network loss before/after consume, and partial
  bootstrap cleanup
- test that callback URLs, logs, analytics, crash reports, and proxy traces
  contain no access token, refresh token, verifier, or session envelope
- mock `ASWebAuthenticationSession` for native unit/UI tests, then verify every
  enabled provider, shared/ephemeral browser modes, relaunch, logout, and
  account switching on a physical iPhone
- verify process death invalidates the in-memory ceremony, external email
  confirmation/recovery restarts sign-in, and iOS logout uses local session
  scope without revoking other devices
- verify the signed Associated Domains entitlement and production AASA file
  together; simulator-only callback tests are insufficient
- use the response, lifecycle, and threat matrix in
  [`docs/mobile-authentication-contract.md`](docs/mobile-authentication-contract.md)
  as the minimum verification set for `OVD-219` and `OVD-221`

### Client-triggered quote request changes
- validate request gating and lifecycle rendering in client part and project workspace tests
- validate RPC behavior for single-part and bulk quote requests
- validate `requestedVendors` semantics for multi-vendor fan-out and `no_enabled_vendors` blockers
- validate authorization and idempotency outcomes
- validate disclosure fingerprints include worker-trusted CAD/drawing hashes, reviewed manufacturing fields, vendor, quantity, and requested delivery date
- validate date validity, duration validity, derived counterpart values, missing validity, malformed/conflicting terms, trusted provenance, and the independent 14-day collection-freshness rule
- validate covered/cooling vendor presentation, all-covered comparison routing, and the absence of client force-retry bypasses
- validate quote invalidation denies AAL1, requires billing-admin capability and a reason, appends an immutable audit event, and releases only the matching lane for one replacement request
- validate per-user rate-limit blockers and org-level pending-cost ceiling blockers
- validate worker- or queue-adjacent state transitions where the request lifecycle depends on asynchronous vendor updates
- run `npm run verify:worker` when worker payload or queue integration changes

### Commercial plans, entitlements, and quote-mode changes
- treat Founding Beta enrollment, automatic-quote access, grants, billing-admin authorization, Stripe synchronization, and order administration as release-confidence, high-risk work
- verify signup and membership remain unenrolled by default; grant/revoke requires platform-admin MFA and immutable evidence; each member accepts the current notice independently
- cover all four authoritative beta states, cross-organization denial, idempotent grant/accept replay, immediate revocation, direct `jobs` insert denial, every executable draft-creation RPC, and continued reads after revocation
- cover file prepare/reuse/finalize, direct `job_files` insertion, modern and legacy Storage paths, the retired legacy attach RPC, canonical bucket/path/object binding, cross-organization substitution, revocation between steps, absence of partial metadata on denied operations, and continued file/object reads after revocation
- cover all client write-readiness states at the shared upload picker, text/file composer, project and part target-organization wiring, and standalone job form; loading, malformed responses, query failures, and revocation between picker open and file handoff must make zero client write calls
- verify unenrolled organizations receive truthful provider recommendations and official RFQ links without creating worker or operator work
- verify automatic quote enforcement at both UI and server/RPC boundaries, including a bypassed client and truthful beta-access result
- cover missing, stale, identity-mismatched, or scope-mismatched disclosure permits, non-Xometry lanes, and worker-configuration drift with zero adapter calls; immediately before adapter invocation, production-realistic database tests must recheck current enrollment/notice, automatic access, rollout, exact provider configuration, active request/task/result state, immutable task/lane/permit binding, and staged plus current scope fingerprints
- cover the atomic Xometry permit transaction with production-realistic database tests for enrollment/notice state, explicit effective provider configuration, every 1.0 envelope field (including declared inch/millimeter units), each of the three affirmations independently, stale fingerprints, replay/conflict, immutable evidence, exact lane/task binding, and zero-write legacy client request wrappers; internal/service-created provider tasks must also fail at the worker boundary without a matching permit
- cover the client Xometry confirmation contract with strict malformed-scope rejection, blank-by-default units and affirmations, exact atomic-RPC argument mapping, duplicate-submit prevention, and approval reset/refetch after any bound-scope change or server denial; the legacy automatic-request RPC must receive zero calls from this flow
- verify the Xometry browser adapter refuses live launch without the bounded authorization object and, when Xometry presents an export-control dialog, selects only an explicit dialog-scoped non-export-controlled option; missing or ambiguous state makes zero disclosure progress and stores no browser-state evidence for that denial
- verify hosted Xometry credential durability across profile bytes, pinned
  Camoufox launch identity, display/runtime mode, and the approved outbound
  network path; partial VPC configuration, service/Job egress mismatch, dynamic
  egress where stable egress is required, retry drift, or failed fresh-instance
  authentication must stop before any file selection or provider mutation
- run the service and authentication-Job shell contract tests plus
  `scripts/verify-xometry-stable-egress.test.mjs`; the live verifier must check
  the exact private service, bounded Job, custom subnet, regional router, manual
  single-address NAT, and errors-only logging without emitting the raw address.
  Preserve the zero-mapping provider-ready gate. The OVD-419 controller may
  passively observe a sole NAT-only failure for one or multiple syntactically
  valid mappings on a fixed finite schedule, but every observation must recheck
  all release invariants and the final observation must contain zero mappings.
  No wait may run for malformed mapping evidence or any accompanying control
  failure, and the wait itself may perform no mutation, provider request, or
  traffic generation. Direct VPC inventory may contain an empty instance-name
  string; missing or non-string fields and other malformed metadata remain
  blocking
- before hosted credential rotation, run
  `scripts/verify-xometry-recovery-host.test.mjs` and the live recovery-host
  verifier; require the exact immutable worker image, supported Ubuntu host,
  no external address, IAP-only SSH rule, repository-scoped image-read identity,
  the exact OVD-420 control and policy metadata, healthy sanitized runtime
  evidence, container-to-metadata denial, unchanged stable-egress controls, and
  exactly one named NAT mapping. Reject a competing mapping, broad
  firewall/role, startup/control/policy drift, or mutable image
- run `scripts/ovd420-recovery-egress-contract.test.mjs`,
  `scripts/ovd420-recovery-egress-control.test.mjs`, and the privileged Linux
  `scripts/verify-ovd420-recovery-egress-network.sh` proof for recovery-egress
  changes. The privileged proof must first exercise the exact production Docker
  network create/inspect/remove lifecycle, all three bridge IPv6 writes and
  readbacks, and require the exact network and bridge targets to be absent
  before it starts. Inspect fixtures must cover both compact and expanded
  Docker IPAM serialization: optional range and auxiliary-address fields are
  accepted only when semantically empty, while custom IPAM drivers/options,
  non-empty optional fields, and unknown configuration keys fail closed.
  Synthetic approved SNI must resolve through a bounded CNAME chain and
  reach only its install-time pinned public address, including after a
  controlled DNS answer is rebound to a private address. Readiness must keep
  accepting the unchanged canonical pinned map after upstream answers rotate,
  disappear, or rebind, while map, hostname scope, public-address, rendered
  configuration, and bypass drift still fail closed. Disconnected answers,
  loops, invalid or excessive aliases, wrong or missing SNI, unknown DNS,
  raw/private/metadata destinations,
  alternate DNS, UDP, and IPv6 bypasses must fail without provider traffic,
  credentials, or cloud mutation
- treat that provider-free proof as infrastructure evidence only. OVD-410
  separately reviewed the production exact-hostname policy and proved the live
  credential, cold-relaunch, teardown, reseed, and fresh-instance sequence; the
  next rule requires the same proof again after any credential or network change
- after any credential rotation or hosted network change, require separately
  authorized independent one-task, parallelism-one, zero-retry no-upload probes;
  a guarded local cold relaunch, a fixed-network verifier without interactive
  recovery through that path, or one historical successful probe is not
  repeatability evidence for `OVD-206`
- preserve the complete Xometry suite as the provider-neutral regression baseline; provider-neutral work must add default-off admission-policy, versioned provider-envelope, exact outbound derivative, cross-provider permit, session-isolation, and zero-adapter-call denial tests rather than replacing Xometry assertions with weaker generic checks
- verify the private provider-admission registry seeds every current provider, keeps Xometry controlled-beta-only and every other provider disabled, fails closed for missing/incomplete/expired policies, requires a new revision for each change, preserves append-only history, exposes only its bounded service-role resolver, and has no routing/permit/preflight integration until a later reviewed migration adds one
- for every additional 1.0 provider, verify current written automation permission, admitted process/material/file limits, isolated session ownership, exact action-time confirmation, immediate service-side recheck, finite failure/manual-follow-up behavior, normalized price/quantity/lead-time/provider-reference provenance, rollback, and no-order behavior before production certification
- prove that a permit, policy revision, envelope, file or derivative hash, scope, lane/task, session, or organization for one provider cannot authorize another provider
- verify that only successful offers from the current admitted and production-certified provider policy, no older than 14 days, are labeled live; the `OVD-206` baseline must accept only Xometry, and simulated, stale, failed, unadmitted, and unproven offers must fall back to recommendations
- verify buyer-visible provider destinations are HTTPS and match the admitted provider's reviewed domain allowlist; provider admission never permits an arbitrary redirect, and the `OVD-206` baseline remains Xometry-only
- verify the standalone `OVD-407` live-provider harness accepts Xometry,
  Fictiv, and the existing evaluation adapters; passes operator-selected CAD
  and adapter-supported optional drawings with
  `executionContext = "live_evaluation"`; rejects unsupported generic-portal
  drawings before browser launch; and does not require Supabase queue,
  disclosure, admission, entitlement, rollout, dispatch-permit/preflight,
  anti-bot-certification, or order-prevention state
- verify Xometry accepts missing dispatch authorization only through the
  dedicated live-evaluation entry point; the normal adapter entry point must
  still make zero browser-launch calls for omitted, production, or forged
  live-evaluation contexts without exact production authorization
- verify evaluation refuses upload without explicit non-export-controlled
  confirmation, binds it to private staged CAD/drawing copies, and makes zero
  browser-launch calls when the staged bytes no longer match their SHA-256
  authorization; after capture, mutate the staged path during browser work and
  prove the adapter still uploads only the previously verified in-memory bytes
- verify a multi-provider or multi-quantity evaluation stages and authorizes its
  selected files once, reuses the same captured bytes for every row, and cleans
  up the shared private staging directory once after the batch
- verify production `quoteWithDispatchPreflight` tests remain unchanged and
  evaluation results remain local harness output rather than trusted persisted
  customer offers
- verify provider recommendation eligibility rejects mismatched material, process, quantity, and tolerance capability data
- verify vendor login expiry, timeouts, disabled adapters, and portal failures reach a customer-useful recommendation state rather than remaining indefinitely in progress
- cover effective-entitlement precedence, trial expiration, complimentary-grant revocation/review dates, subscription cancellation, and the seven-day delinquency grace period
- cover platform viewer, organization admin, billing admin, and order admin access at AAL1 and AAL2
- verify privileged mutations are idempotent and produce append-only audit records
- validate signed Stripe events for duplicate, concurrent, delayed, reordered, failed, and replayed delivery
- verify manual order snapshot immutability, legal transition rules, external-reference requirements, and cross-organization isolation
- use the production-realistic auth/RLS lane, targeted integration/E2E coverage, migration validation, and the full repository gate

### Public asset and build publication changes
- run the source and built-output containment guard whenever `public/`, demo data, fixture paths, or Vite publication behavior changes
- reject prohibited validation-package filenames, exact hashes, and embedded identity markers even when bytes are renamed or bundled
- treat a missing required scan root, unreadable entry, or symlink as a failed guard rather than silently skipping it
- after deployment, fetch the former paths from every production host and compare response content type and SHA-256 with a missing-route control; an SPA HTML `200` by itself is not proof of removal

### Bug fixes
- reproduce the bug or define the failure clearly
- add or update a failing automated test where practical
- implement the fix
- prove the new or updated test passes

### Drawing extraction changes
- add or update regression coverage for the failing layout or title-block pattern
- cover field-specific rejection rules when a nearby bad candidate could contaminate another field
- verify raw extracted fields separately from normalized quote-facing fields when both layers are affected
- validate review-needed behavior when confidence is low or candidate ranking is ambiguous
- when model fallback is in scope, verify both parser-only and parser-plus-model branches, including disagreement fail-closed behavior
- verify customer drawing fallback and Extraction Lab previews accept only direct OpenAI or Anthropic credentials and make no request for provider-qualified models, OpenRouter-only configuration, or an injected OpenRouter provider
- when stale approved metadata is part of the failure, verify both the extraction payload and the approved-requirement precedence layer
- when fixture coverage is insufficient, run the worker smoke harness against the real drawing file and capture the printed raw extraction payload as verification evidence
- when preview-only debug reruns are in scope, verify that `debug_extract_part` persists to `debug_extraction_runs`, respects the model allowlist, and does not mutate canonical `drawing_extractions` or `approved_part_requirements`
- for internal Extraction Lab UI changes, verify model selection, status polling, and side-by-side rendering of canonical extraction versus preview-only debug output

### STEP normalization changes
- add or update representative valid STEP fixture coverage for the normalized geometry contract
- verify repeated normalization of identical STEP input returns stable output
- verify deterministic canonical identifiers and typed topology fields instead of asserting against raw provider-specific STEP entities
- verify normalized unit and bounding-box fields when geometry coordinates are part of the change

### Persistent CAD preview changes
- verify coplanar triangulation seams are omitted while boundary and crease edges remain
- run the renderer against a representative STEP fixture and record triangle, feature-edge, and output-size evidence
- verify current source-file and renderer versions skip redundant work while stale assets are replaced through an atomic upsert
- verify client workspace hydration ignores assets tied to an obsolete `cad_file_id`
- verify authenticated users can read only preview rows and storage objects for jobs they can access
- verify the collection keeps the browser-rendered fallback while a persistent asset is missing or unavailable
- verify existing STEP-backed parts receive one `generate_cad_preview` backfill task without duplicate queued work
- verify `sketch` is additive to `hidden_lines_removed`, is the collection default, and backfills parts that have only the earlier style

### Schema or migration changes
- validate the migration path
- run the relevant pgTAP database tests for RLS or other database-enforced behavior
- run static verification
- run tests touching the affected data flow
- include migration notes in the PR
- for a production-first pending batch, freeze the exact source commit and migration hashes, classify any history-repair candidate by catalog evidence, replay the qualified plan against a production schema-only clone and a clean-head database, and require normalized `public`/`private` schema equality
- rehearse an interrupted batch with the same candidate reconciliation and exact reviewed fix-forward; require both the recovered and clean-head databases to pass the full pgTAP suite
- before any production history repair, run a reviewed read-only precondition that verifies the exact migration head plus function/table ownership, security properties, RLS, policies, triggers, constraints, and grants supporting every reconciliation candidate
- inject a failure immediately after the earliest executable migration and prove legacy quote endpoint fingerprints remain unchanged and authenticated synthetic calls create no quote or queue rows
- keep production rows out of qualification by default; use only repository-seeded synthetic configuration unless a separate data-handling approval explicitly authorizes more
- concurrency tests that use `dblink` must honor `ovd.test_conninfo` before the canonical local-port fallback so parallel disposable stacks cannot silently test another database

### Extraction observability changes
- verify worker-emitted `worker.extraction_completed` payload shape when new extraction metrics or provenance fields are added
- verify summary or alerting SQL reads from immutable `audit_events`, not mutable `drawing_extractions`
- add a migration-definition or snapshot-style test for new observability views or functions
- add a seeded semantic test for per-day grouping, counter formulas, and zero-safe rate math when summary views or evaluators are introduced
- prefer Lane B unless the change also alters broader extraction behavior, RLS, or shared RPCs

## Verification evidence

Before handoff, PR creation, or a Linear workpad update, record:

- the exact commands run
- the outcome of each command
- any unrelated baseline failures separately from issue-scoped failures
- why a narrower verification lane was sufficient when `npm run verify` was not used

## CI policy
Minimum CI target:
- lint
- typecheck
- automated tests
- pgTAP database tests when `supabase/tests/` contains database-policy coverage
- build
- worker verification when the worker package remains part of the repo gate
- install dependencies for both the repo root and `worker/`
- use canonical package scripts so CI remains aligned with local verification
- keep the root `verify` command covering the full repo gate for local release-confidence checks

Preferred CI shape:
- run lint, typecheck, tests, build, and worker verification in separate parallel jobs
- keep one final aggregate gate job for branch protection
- cancel superseded runs for the same branch or PR to avoid stale feedback
- run PR validation from `pull_request`, and reserve `push` runs for `main` or merge-queue events so feature branches do not double-report the same checks
