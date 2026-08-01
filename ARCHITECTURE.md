# OverDrafter Architecture

Last updated: July 30, 2026

## Purpose

This document defines the major architectural boundaries in OverDrafter. It exists to keep product, engineering, and workflow discussions grounded in the same system model.

## How to read this document

Sections marked **As-built** describe what is deployed and must be verifiable against the tree. Sections marked **Target** describe intended direction and are not implemented.

Keep the two labelled and separate. When the two were written in the same voice, the document stopped functioning as a check on the code: two separate drawing-extraction implementations coexisted for months, with the eval harness measuring the one production never ran, and nothing in these pages made that visible. If you cannot point at the code for a paragraph in an As-built section, it belongs under Target.

## System overview (As-built)

OverDrafter turns CAD and drawing uploads into comparable manufacturing quotes.

Clients upload STEP and PDF files into project-scoped workspaces. An asynchronous worker extracts structured part requirements from those files, preferring deterministic label-anchored parsing and calling a vision model only when critical fields are missing, weak, or contested. Extraction output carries per-field confidence, evidence, and provenance, and fails closed rather than guessing. Reviewed capability profiles produce an immediate client-safe sourcing result. For Pro organizations, approved requirements can also drive server-side vendor portal automation, whose successful results normalize into the canonical quote model.

## System overview (Target)

The intended end state is a multi-agent manufacturing co-pilot: CAD-native intake through plugins, natural language as the primary control surface, specialist agents (DFM, extraction, quoting swarm, modeling/drafting, assembly/fulfillment, PDM) negotiating on an internal blackboard and executing in parallel, and on-demand visualizations summoned only when needed. None of this is implemented; see the Target section below for the components involved.

## Subsystems

### 1. Web application layer
- authentication entry points
- client auth bootstrap performs one browser-local Supabase session restore before protected-route decisions run, and later session refreshes use live auth reads rather than the memoized startup snapshot
- route guards must wait for initial auth restoration before treating the user as signed out
- workspace-facing navigation and application shell
- client launch navigation presents `Parts | Quotes | Search`; `Project` remains the backing collaboration and
  procurement-workflow container rather than the first navigation decision
- client intake UI
- artifact-first client workspaces with contextual intelligence rails and chat as a secondary tool
- project browsing and creation flows remain reachable from part context and legacy routes
- assembly and part management inside a project
- internal estimator interfaces
- quote comparison and package publication surfaces
- route-local page composition for complex screens, with reusable quote-domain logic staying in `src/features/quotes/`

### 1a. iOS application layer

**As-built**

- the universal SwiftUI target lives under `ios/` and supports iPhone and iPad
- iPhone uses native Parts, Quotes, and Search tabs; iPad uses the same destinations in a native split view
- the first release hosts the corresponding access-controlled web workflow in a shared persistent `WKWebView`
  session so authentication, uploads, and quote mutations retain one implementation
- production and preview navigation is restricted to the configured HTTPS origin; unsupported or unsafe schemes are
  blocked and external main-frame HTTPS links leave the app; secure third-party subframes remain embedded for
  payment elements
- email/password authentication is the supported first-release path inside the app; social OAuth controls are hidden
  in `?app=ios` workspaces

**Approved target**

- signed-out launch is a native welcome surface that authenticates through the
  OverDrafter website in `ASWebAuthenticationSession`
- the production browser callback is a claimed, exact HTTPS route and contains
  only an opaque single-use handoff code and transaction state
- a dedicated bootstrap web view redeems the handoff through an HTTPS POST and
  establishes the Supabase session in the same persistent
  `WKWebsiteDataStore` used by workspace destinations
- workspace destinations are not created until bootstrap or cold-launch
  session restoration succeeds
- the native shell grows to `Inbox | Parts | Quotes | More` with a separate,
  capability-gated Ask action
- later fully native feature screens may replace individual web destinations
  without changing their domain routes or authorization boundaries

### 1b. Mobile browser-auth bridge (As-built server boundary)

The iOS browser and the app `WKWebView` are intentionally separate security and
storage contexts. The implemented website bridge connects them without placing Supabase
credentials in a callback URL or native persistence:

- `GET /auth/mobile/start` validates version, state, PKCE S256 challenge, and an
  allowlisted relative return route
- the website creates a ceremony-scoped, transfer-only Supabase session; social
  OAuth uses separate provider state/nonce/PKCE and a dedicated provider
  callback bound to the unpredictable browser transaction; only its PKCE
  verifier persists in namespaced `sessionStorage`
- browser completion atomically claims the transaction before refresh-token
  rotation, verifies that session, stores it in a short-lived encrypted server
  envelope, and redirects to the exact claimed HTTPS callback
- the callback fragment contains only opaque `code` and `state` values
- `POST /auth/mobile/bootstrap` verifies PKCE, atomically consumes the handoff,
  requires the fixed native request marker and host before session persistence,
  and runs `supabase.auth.setSession(...)` plus a server-backed
  `supabase.auth.getUser()` check in the shared app website data store
- handoff material is at least 256 bits, expires within two minutes, and is
  single-use under concurrent redemption
- logout, relaunch, revocation, and account switching clear subject-bound
  caches before a different session can be published

The public boundary is one same-origin Vercel Function at
`api/mobile-auth.ts`. Dedicated ceremony and bootstrap bundles are emitted at
stable first-party asset paths; neither ceremony imports the normal application
bundle. Credential-adjacent state is isolated in forced-RLS `private` tables and
is reachable only through fixed-search-path, service-role-only RPCs. The
database owns the atomic `authenticating -> verifying -> completed -> consumed`
transitions, source `auth.sessions` check, envelope clearing, persistent rate
counters, and bounded cleanup. Vercel Cron invokes cleanup daily with
`CRON_SECRET`; terminal rows are retained for seven days and safe audit metadata
for thirty days.

The versioned endpoint, storage, failure, lifecycle, and threat contracts are
canonical in
[`docs/mobile-authentication-contract.md`](docs/mobile-authentication-contract.md).
The server/browser half is implemented by `OVD-219`. The native welcome,
claimed-HTTPS callback capture, shared-store bootstrap host, local-scope logout,
and account switching remain the `OVD-221` target and must pass the physical
device release gate before this flow replaces the current embedded sign-in.

### 2. Backend data and domain layer
- persistence of workspaces, projects, parts, jobs, files, quotes, packages, and service request records
- role-aware data access
- workflow state transitions
- auditability for sensitive actions
- RFQ metadata boundaries that distinguish shared RFQ/project context from line-item requirements

### 3. Storage and file-reference layer
- storing uploaded CAD files and drawings
- associating files with jobs, parts, or projects
- preserving file metadata and provenance

### 4. Intake and reconciliation layer
- receiving uploaded files and prompt text
- creating draft/intake/job records
- reconciling uploaded files into candidate part groupings
- exposing newly uploaded parts in the client workspace immediately, before extraction finishes
- identifying or collecting the requested service type before service-specific parsing runs

### 5. Extraction and asynchronous worker layer
- extracting structured part requirements from files
- preserving raw drawing-derived values and evidence in `drawing_extractions`
- normalizing quote-facing requirement fields separately in `approved_part_requirements` / `spec_snapshot`
- generating previews and auto-approving extracted requirements for normal quote preparation
- supporting preview-only debug reruns in `debug_extraction_runs` without mutating canonical extraction or approved requirements
- failing closed into review when field confidence is low or candidates conflict
- running long-lived or queued work
- surfacing processing status and failures without blocking part navigation

### 6. Quote orchestration layer
- validating whether a client-facing part package is ready for quote collection
- recording quote request intent and collection mode separately from quote run execution
- returning ranked provider recommendations and official RFQ links for supported Free packages without creating worker or operator work
- resolving the organization-level `automatic_quote_collection` entitlement before automatic vendor work is queued
- initiating automated quote retrieval where supported
- retaining manual quote entry and imported quote paths as internal-only compatibility mechanisms
- normalizing quote outputs into a canonical internal model
- materializing spreadsheet or manual lane data into `vendor_quote_results` and canonical per-lane `vendor_quote_offers`
- exposing client-safe quote comparison data through `public.api_list_client_quote_workspace`, rather than direct client reads from internal-only quote tables

Free sourcing and Pro automatic collection are separate launch contracts:

- Free sourcing ranks only reviewed provider capability profiles and never represents a potential provider as a returned quote
- `automatic` retains vendor fan-out and requires a server-resolved Pro entitlement
- client UI may explain or upsell Pro, but UI state is never the enforcement boundary
- entitlement lookup and vendor automation failures fail closed for automatic execution while preserving recommendations and direct RFQ links
- only successful Xometry or Fictiv live-adapter offers no older than 14 days may produce the `live_offers_available` sourcing outcome
- operational rate limits and pending-cost ceilings continue to protect automatic execution but are not customer quotas

`quote_requests` is intentional Phase 1 scaffolding, not the permanent home for service intent. It exists to cleanly separate client-safe request intent from quote-run execution records, which is a necessary boundary even in the final model. However, the authoritative unit of requested work in the next phase is the service request line item described in `docs/service-request-taxonomy.md`. Future schema and feature work should treat `quote_requests` as a `manufacturing_quote`-scoped specialization that will coexist with, not be replaced by, the broader line-item model once that model ships. Do not build general service-intent fields into `quote_requests`; those belong on the future service request line item entity.

### 7. Internal operations layer
- estimator review of exceptions and manual holds
- correction of structured data when auto-approved defaults need intervention
- quote comparison
- pricing-policy application
- package curation and publication

Internal review implementation boundary:

- the `/internal/jobs/:jobId` route is now a composition shell backed by route-local modules in `src/pages/internal-job-detail/`
- reusable quote-state shaping, normalization, and API calls remain in `src/features/quotes/` and `src/features/quotes/api/`
- `src/features/quotes/api.ts` is no longer a behavior-bearing service module; concrete implementations live under `src/features/quotes/api/*`

### 8. Collaboration and project-sharing layer
- project grouping
- collaborator invitation and access
- project-scoped visibility boundaries
- project-level navigation that does not treat assemblies as the umbrella container
- current project-ledger assignee bubbles derive from `project_jobs.created_by` joined to auth user profile metadata; this is the minimum safe source of truth until a dedicated part-assignee relation exists because each ledger row is still a project-job row owned by its creator

### 9. Commercial access and operations layer

**As-built**

- organization is the commercial account, Stripe Customer, subscription, and entitlement boundary
- membership roles remain authorization roles and do not encode Free or Pro
- local billing-account and subscription projections retain Stripe object identifiers and synchronized lifecycle state
- effective product access is resolved server-side from active manual grants, eligible synchronized subscription state, the seven-day delinquency grace period, and the Free fallback
- trial and complimentary grants are explicit, revocable, time-aware records rather than synthetic Stripe subscriptions or mutable `paid` flags
- automatic quote collection is enforced at the server boundary from the effective organization entitlement; manual quotes and uploads remain available to Free organizations
- commercial-account search, exact-organization detail, quote activity, entitlement history, and billing-lane audit are exposed through guarded RPCs rather than direct reads from private commercial tables or `auth.users`
- commercial-account reads require the stable `billing_admin` capability and accept AAL1 or AAL2 sessions; grant and revoke mutations additionally require AAL2, idempotency, and append-only audit
- the capability-first `/internal/commercial` directory and exact-account detail routes remain available to provisioned billing administrators without requiring customer membership; trial, complimentary, and revocation controls use TOTP step-up and never impersonate the customer or label a manual grant as paid
- platform viewers and organization administrators cannot read or mutate commercial-account administration state unless they separately hold the required commercial capability

**Target**

- Stripe owns economic subscription, invoice, coupon, and promotion-code facts
- the local projection plus audited manual grants is authoritative for application access decisions
- subscription webhooks are signature-verified, durably deduplicated by Stripe Event ID, replayable, and reconciled
- the signature-only `stripe-events` Edge Function verifies the raw body and uses service-role-only database functions; its private inbox records livemode, API version, receipts, attempts, terminal state, and bounded failure context
- subscription and invoice projection updates run while the event inbox row is locked; event creation time plus deterministic same-second status precedence prevents reordered delivery from overwriting newer state
- subscription projections grant Pro only when the verified Stripe Price ID and
  test/live mode match the server-managed launch Pro price allowlist
- the authenticated `billing-sessions` Edge Function accepts only an
  organization ID, `checkout` or `portal`, and the fixed `month` or `year`
  choice for Checkout; the server resolves the Stripe Customer, stable catalog
  lookup keys, exact Price IDs, mode, and return URLs
- each organization billing account stores an explicit, stable client
  membership as its billing owner; ordinary members, internal platform staff,
  former owners, and cross-organization callers are denied server-side
- a durable per-organization Checkout intent serializes monthly/annual races,
  supplies Stripe's idempotency identity, resumes same-plan retries, and keeps
  an open Session from being replaced by a different interval
- Checkout redirects are informational only; Pro access changes exclusively
  after the signed Stripe event is synchronized into the subscription
  projection
- Checkout remains feature-flagged until active Product/Price entries with
  lookup keys `overdrafter_pro_monthly_v1` and
  `overdrafter_pro_annual_v1` are test/live-mode matched and validate as exactly
  USD 49.00 monthly and USD 490.00 annual
- failed or pending events are replayed through `api_replay_stripe_event` or bounded `api_reconcile_stripe_events` calls rather than by editing commercial projection tables directly
- platform viewers remain read-only; billing and order mutations require separately granted stable-ID capabilities, AAL2, server-side authorization, idempotency, and append-only audit
- subscription promotion codes never adjust manufacturing quote or order totals
- explicit orders are distinct from projects and retain immutable selected-offer, quantity, vendor, price, currency, and procurement-handoff snapshots
- the first order-administration slice records manual or externally confirmed state and does not authorize cards, issue POs, or place supplier orders

### 10. Multi-agent orchestration & CAD-native layer (Target — not implemented)

None of the following exists in the codebase today. Vendor automation is implemented as per-vendor Playwright adapters under `worker/src/adapters/`, not as an agent harness.

- CAD plugins (thin clients that inject into SolidWorks/Fusion/Onshape/etc.)
- Live 3D STEP viewer as web fallback
- Natural-language intent parser → agent decomposition
- Internal blackboard for agent negotiation (never surfaced to user)
- On-demand visualization engine (DFM heatmap, quote scatter, revision diff, risk heatmap)
- Instant human override protocol
- OpenClaw harness (invisible browser automation)
- PDM graph and revision sandboxing

### 10. Supplier directory and assisted-RFQ layer

- canonical supplier companies remain separate from physical supplier facilities
- facility records carry location and service-area data used for geographic search
- normalized capabilities and certifications are many-to-many claims with source provenance and verification history
- source records preserve imported or contributed evidence without overwriting canonical reviewed values
- customer-suggested suppliers enter a candidate workflow and are deduplicated before publication
- instant-quote vendor adapters remain separate from directory suppliers; a supplier may later link to an adapter without becoming one by default
- assisted RFQ workflows may use a directory supplier without claiming automated price or lead-time availability
- sponsored placement is stored and rendered separately from organic eligibility and match scoring
- technical eligibility, capability matching, proximity, and verification confidence are computed without paid-placement influence

## Domain hierarchy

The top-level persisted collaboration and procurement-workflow container is `Project`, not `Assembly`. The organization is the separate commercial account, subscription, and entitlement boundary.

The client launch information architecture is collection-first. Responsive web
uses `Parts | Quotes | Search`; the approved iOS target uses
`Inbox | Parts | Quotes | More` and maps Search/Projects contextually. Neither
presentation removes or flattens Project. Project remains the scope that groups
collaborators, mixed manufacturing requests, files, quote rounds, and later
order records; it is revealed from the work that needs that context.

A project is the commercial and workflow scope for mixed manufacturing requests. It can contain:

- multiple assemblies
- standalone parts that are not attached to any assembly
- drawings, PDFs, spec sheets, and other supporting documents
- quote rounds, curated quote packages, and downstream review or order records

An assembly remains a technical structure nested inside a project. It should model engineering hierarchy such as
subassemblies and parts, but it must not define the top-level information architecture for intake, navigation, or
collaboration. Until immutable assembly/BOM identity ships, `All | Parts | Assemblies` is a truthful collection filter
and must not fabricate assembly membership.

## Quote launch identity bridge (As-built)

- quote collection/detail routes use a stable six-character display code derived from the already access-controlled
  job identity
- the display code is a locator, never an authorization secret; route resolution occurs only across jobs already
  available to the signed-in workspace
- collisions fail closed rather than opening an arbitrary quote
- quote links are currently login-gated; password grants and anyone-with-link grants remain target capabilities
- the editable customer reference in the first release is browser-local and explicitly labeled as such; a future
  persisted Quote/Round/Grant schema must replace that bridge without changing the immutable code or access boundary


## North Star canonical workspace/artifact primitives

To unblock sequenced North Star issues (OVD-104 onward), the canonical first-slice domain contract is:

- `workspace` as the tenancy and collaboration boundary
- `artifact` as deterministic file identity (`sha256`, filename, source path, media metadata)
- `review` as explicit approval/rejection state linked to an artifact
- `override` as immutable, provenance-tagged human/system adjustments keyed to an artifact field

Implementation reference: `src/lib/north-star-domain.ts`. This module is intentionally schema-adjacent and pure so backend, worker, and UI layers can converge on the same baseline contract before pipeline and reveal-state work is layered on top.

## STEP normalization contract

For the STEP-only normalization slice (`OVD-142`), the worker canonical contract is:

- `worker/src/extraction/stepGeometryMetadata.ts` emits `canonical-part-geometry.v1`
- downstream pipeline stages consume canonical typed geometry metadata rather than raw STEP entity parsing
- normalized topology identifiers are deterministic within the artifact (`body-*`, `shell-*`, `face-*`, `edge-*`, `vertex-*`)
- the normalized surface carries source header metadata, normalized length units, topology structure, and bounding boxes needed by later extraction consumers

This slice is intentionally pure and independently testable before PDF extraction or artifact persistence is layered on top.

## Request-model boundary

- projects are the grouping and collaboration boundary, not the only place where service intent lives
- parts preserve technical identity, revision, and manufacturing context
- service request line items hold the requested work type, scheduling, status, and service-specific detail
- quote-specific fields such as requested quote quantities belong to `manufacturing_quote` line items rather than to a universal project request blob
- quote requests record user intent and lifecycle for starting quote collection
- quote runs record execution instances launched from a quote request or an internal-only kickoff
- vendor quote records remain vendor-specific execution output attached to a quote run
- supplier directory matches are sourcing candidates and do not become vendor quote results until an actual quote is received or entered
- instant quote execution and assisted supplier discovery may coexist for the same manufacturing request without sharing lifecycle state

See `docs/service-request-taxonomy.md` for the canonical service types and mixed-service modeling rules.

## Client-triggered quote request lifecycle

The current client-triggered request flow keeps the existing queue and worker path, but adds a separate client-safe request-intent record:

- client part or project workspace validates the package and calls a quote request RPC
- the backend creates an idempotent quote request record when no active request already exists
- the backend creates a linked quote run execution record
- the backend resolves org-enabled client-request vendors, intersects them with part-level applicable vendors, and seeds one vendor lane per part, quantity, and enabled vendor
- the backend enforces per-user throttling plus an org-level pending-cost circuit breaker before new client-triggered vendor work is enqueued
- the backend enqueues `run_vendor_quote` work items in `work_queue`
- the worker claims the task, stages the files, and calls the adapter named in the queue payload vendor lane
- vendor result transitions roll up into both request lifecycle state and existing job lifecycle state
- client UI reads the latest quote request, with quote-run fallback for pre-existing data, to show request status
- client-visible failed request reasons are allowlisted and sanitized; raw worker exception text stays in internal logs or internal-only records

The launch commercial contract extends that lifecycle without replacing internal compatibility paths:

- Free organizations receive client-safe provider recommendations without submitting a customer-facing manual request
- internal manual requests may still create request/run records and follow-up visibility, but they are hidden and non-critical to launch fulfillment
- only organizations with the effective `automatic_quote_collection` entitlement may submit `automatic` requests
- the database/RPC boundary enforces automatic access even when a client bypasses the UI
- Free clients attempting the automatic RPC receive a stable `pro_required` result that the UI renders as an upgrade path
- failed, disabled, timed-out, or login-blocked vendor lanes degrade to reviewed recommendations rather than an indefinite customer state

Request lifecycle meanings:

- `not_requested`
- `queued`
- `requesting`
- `received`
- `failed`
- `canceled`

Phase 1 vendor boundary:

- client-triggered requests dispatch across the requestable enabled vendor set for the organization
- orgs with no explicit vendor config fall back to `xometry`, `fictiv`, and `protolabs`
- hidden live-adapter candidates (`oshcut`, `fabworks`, `ponoko`, `quickparts`, `rapiddirect`, `geomiq`, `weerg`, `protolabsnetwork`) are enum-registered for internal workflow validation, but are not part of default client quote fan-out
- existing internal and manual quote ingestion paths remain intact
- request intent remains on `quote_requests`; execution remains on `quote_runs` and `vendor_quote_results`

Bridge ownership during the service-line-item migration:

- `service_request_line_items` owns manufacturing service intent, scope, and service-specific request detail for the authoritative `manufacturing_quote` line item
- `quote_requests` remains the client-safe lifecycle record and current workspace-facing request status surface
- `quote_runs` remains the execution record launched from a request or internal kickoff and must not absorb user-intent fields
- `vendor_quote_results` remains vendor-lane execution output, traceable through `quote_runs.quote_request_id` and `quote_requests.service_request_line_item_id`

## Key cross-cutting concerns
- authorization
- provenance
- auditability
- observability
- data separation

## Untrusted-input contract (As-built)

Anything the system does not compute deterministically — model output, and equally the DOM of a vendor portal we do not control — carries its provenance, and one policy decides what that provenance is permitted to do.

- `worker/src/extractedValue.ts` defines `ValueSource` (`selector` | `body_text` | `none`) and the gate applied to scraped vendor values.
- A vendor price is publishable only when anchored to a locator the adapter declares for that vendor. An unanchored price means every declared locator missed, so the adapter's contract with the vendor UI is broken; the lane routes to `manual_review_pending`, the observed number is retained under `unanchoredPriceObservedUsd` as evidence, and `locatorDriftDetected` is set for alerting. Lead time inherits the price's trust decision.
- Drawing extraction expresses the same idea through per-field confidence, evidence, and `reviewNeeded` in `drawing_extractions`, and fails closed on parser/model disagreement.

Do not add a new reader of untrusted input that returns a bare value. Return the provenance with it and route the decision through the shared policy.

## Extraction model contract (As-built)

One implementation serves production, the eval harness, and the debug lab. When they were separate, the harness ran with deterministic sampling and full usage accounting while production ran with neither, so eval numbers described a configuration no customer received.

- `worker/src/extraction/schema.ts` — prompt and response schema.
- `worker/src/extraction/policy.ts` — confidence thresholds, sufficiency rules, and prompt versioning. Prompt version is a content hash of the prompt and schema in the build, not a hand-maintained string.
- `worker/src/extraction/modelRegistry.ts` — provider inference, capability flags, and the cost table. Single source of truth for model identity; the web extraction lab mirrors it in `src/features/quotes/extraction-models.ts` for the degraded path only.
- `worker/src/extraction/modelProvider.ts` — the OpenAI, Anthropic, and OpenRouter implementations. All three are production-reachable.
- `worker/src/extraction/callModel.ts` — the only entry point for a model request. Owns the deadline, retry with full jitter, and token/latency/cost accounting. SDK-level retries are disabled so provider behavior is uniform.

Extraction completion events carry provider, prompt version, tokens, latency, cost, and attempt count, so `extraction_quality_summary` can attribute cost and speed changes rather than only accuracy drift.

## Extraction quality gate (As-built)

`worker/src/tools/extractEvalGate.ts` runs the production extraction path over a checked-in corpus and fails below per-field accuracy floors. The CI job reports skipped when no corpus or provider key is present, so an empty corpus never reads as a passing quality signal. Corpus layout and the intended coverage are documented in `worker/eval-corpus/README.md`.

## Extraction boundary

Drawing extraction is advisory evidence, not the canonical quote contract.

- `drawing_extractions.extraction` stores source-truth raw fields, field confidence, review-needed state, evidence, and debug candidate metadata.
- the worker should prefer deterministic label-anchored parsing first and call `gpt-5.4` fallback only when critical fields are missing, weak, or conflicting.
- preview-only debug reruns should flow through Supabase and the worker queue using `debug_extract_part`, not direct browser-to-worker calls.
- `debug_extraction_runs` is the internal observability record for preview-only reruns and should persist worker build, extractor version, selected model, and raw result payload.
- extraction quality rollups should derive from immutable `audit_events` entries such as `worker.extraction_completed`, not from mutable per-part `drawing_extractions` rows that are updated in place.
- `public.extraction_quality_summary` is the daily UTC summary surface for completed extraction-run observability and calibration; alert evaluation stays downstream from that view so thresholding can be revised without changing the worker ledger.
- `approved_part_requirements` stores the normalized requirement record used by quoting and estimator workflows.
- `approved_part_requirements.spec_snapshot` is the transitional home for normalized quote-facing variants such as `quoteDescription`, `quoteFinish`, and field provenance or override state.
- Auto-approval may refresh auto-managed normalized fields from extraction output, but it must preserve reviewed user-managed values and must not silently promote low-confidence raw extraction into approved requirements.


## North Star sequencing slices

The current North Star execution track includes these baseline slices for deterministic-first delivery:

- OVD-104 baseline: establish canonical workspace/artifact/review/override primitives before downstream orchestration or UX wiring.
- OVD-105 baseline: deterministic upload ingestion pairing should first normalize STEP/PDF candidates by stable stem matching and explicit unmatched-upload tracking before broader folder/zip expansion and inference stages.

These slices are intentionally minimal so later OVD-106+ work can compose over stable contracts instead of ad hoc conditional behavior.
