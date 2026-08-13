# OverDrafter Capability Map

Last updated: August 12, 2026

## Purpose

This map gives every substantial product idea a home without turning every idea
into active work. `ROADMAP.md` owns promotion rules and release outcomes;
`PLAN.md` owns the single execution queue.

Classification describes product commitment, not code existence. A capability
may be substantially implemented and still be deferred until customer evidence
justifies operating, hardening, or exposing it.

## Classification legend

- **1.0 committed:** required for Part to Quote
- **1.1 candidate:** monetization and the first paid pilot after 1.0
- **1.2 candidate:** quote reliability or coverage after paid-pilot evidence
- **2.0 candidate:** team procurement after repeat-use evidence
- **Incubator:** captured but not committed to a numbered release

## 1.0 — Part to Quote controlled beta

| Capability | Disposition |
|---|---|
| responsive `Parts \| Quotes \| Search` web shell | certify current behavior |
| authentication before upload | certify current behavior |
| STEP/STP part upload and durable retrieval | certify the supported launch package |
| optional PDF requirement evidence | preserve truth; no PDF-only launch claim |
| extraction, unknown/conflict handling, and customer correction | certify current review path |
| durable quote request and run lifecycle | certify idempotency and terminal states |
| hosted worker | certify health, recovery, and rollback |
| Xometry automatic quote lane | sole production-certified 1.0 lane |
| provider guidance and unsupported outcome | certify as honest fallback, not a live quote |
| quote comparison and selection | certify with trustworthy offers |
| existing quote preset selection | preserve current behavior; no separate redesign or expansion gate |
| official vendor purchasing link | safe external handoff only; no order claim |
| Founding Beta design-partner validation | certify under the cohort, cap, safeguard, and evidence protocol in `docs/founding-beta-program.md` |

## 1.1 — Monetization and First Paid Pilot

| Capability | Promotion evidence needed |
|---|---|
| Free/paid packaging | 1.0 usage and interview evidence |
| monthly Stripe Checkout and Billing Portal activation | approved price and completed 1.0 |
| grants, grace period, and subscription synchronization | packaging decision and security review |
| first external paid organization | production certification and buyer commitment |
| signup-to-quote and handoff conversion | stable event definitions |
| anonymous upload/quote claim | evidence that pre-auth friction blocks valuable users |

## 1.2 — Quote Reliability and Coverage

| Capability | Promotion evidence needed |
|---|---|
| Fictiv production certification | unmet demand or resilience need after 1.1 |
| additional Xometry/Fictiv session and portal hardening | measured production failures |
| Protolabs, SendCutSend, OSH Cut, RapidDirect, or other provider | observed eligible volume and expected coverage gain |
| additional materials, processes, quantities, or package types | repeated unsupported customer packages |
| deterministic-first drawing extraction evaluation | labeled corpus, field-level accuracy baseline, bounded model-fallback policy, and observed quote-path errors |
| internal manual-request inbox and completion handoff | manual demand that preserves a trustworthy outcome |
| quote-status notifications | measured customer waiting or return-friction problem |
| email/voice status follow-up for known quote requests | repeated manual status cost with consent and audit plan |

## 2.0 — Team Procurement

| Capability | Promotion evidence needed |
|---|---|
| organization/team administration | larger-buyer validation |
| durable procurement handoffs and approvals | repeated decision-to-purchase coordination problem |
| comments and notifications | demonstrated multi-person workflow |
| quote validity, revision identity, and repeat sourcing | repeat-order behavior |
| recurring demand and blanket-PO intent | repeated buyer need for quantity/cadence planning; no supplier commitment without a separately authorized issuance path |
| projects and assembly context | coordination need beyond one-part quoting |
| audit history and role-specific controls | procurement/security requirement |
| manual order ledger and external order references | demand for post-handoff visibility |
| responsive mobile access | observed field or approval use case |

## Incubators

### Supplier network

- supplier-company and facility directory
- capability, process, material, certification, and service-area data
- geographic search and Tucson-first discovery
- provenance, aliases, deduplication, verification, and historical evidence
- customer-suggested shops
- supplier qualification and assisted RFQ preparation/intake
- verified provider role: direct fabricator, marketplace/aggregator,
  broker/agent, or unknown
- customer filters for geography, capability, material, quality, certification,
  provider role, and evidence freshness
- quote adapters as transport-specific integrations (API, portal, email, or
  assisted workflow), including brick-and-mortar/direct-fabricator adapters
- email and voice agents for vendor qualification or quote follow-up
- supplier performance, organic ranking, and clearly labeled sponsored placement

### Manufacturing intelligence

- canonical process, material, finish, tolerance, and feature models
- deterministic geometry and feature characterization
- labeled estimator/costing reference parts of increasing complexity: plate,
  drilled plate, irregular plate, and special-feature/tolerance cases such as
  surface grinding or EDM
- manufacturability evidence and DFM/DFA review services
- internal price estimation and observed quantity-price curves, improved only
  from reviewed corrections, immutable predictions, and later firm outcomes
- common-language plating input normalized to controlled requirements while
  preserving raw text and user confirmation
- feature-level price ranges, cost-driver heatmaps, and risk visualizations
- quote benchmarking and supplier outcome cohorts
- vendor recommendation and prediction-accuracy systems
- standards-aware engineering assistance with rights, edition, and citations

### Design lifecycle and PDM

- CAD-to-drawing generation and editable drafting
- revision-linked automatic 3D PDF generation with derivative provenance
- drawing-to-CAD reconstruction for legacy/replacement parts
- text-to-CAD and controlled model/drawing edits
- bidirectional associative package editing
- immutable versions, official revisions, branches/merges, provenance, and where-used
- part/assembly relationship graph and revision comparison
- a shared plug-in contract spanning customer-validated major platforms,
  including SolidWorks, Fusion, Inventor, Onshape, Creo, Solid Edge, NX, and
  CATIA/3DEXPERIENCE candidates
- live 3D workspace plus a conversational read layer that can display any
  authorized structured artifact or result
- natural-language actions that remain capability-scoped, confirmed,
  authorized, idempotent, and audited rather than an unbounded chatbot

### Compliance and quality

- ITAR, EAR jurisdiction/classification (including owner-asserted EAR99), CUI,
  and other regulated-package designation without presenting legal advice
- sticky classification with organization-admin designation and elevated,
  reasoned, immutable review before declassification
- regulated storage, access, transmission, geography, provider-eligibility,
  retention/deletion, and incident controls
- exact ISO/quality-system requirements and evidence with facility, scope,
  issuer, validity, and provenance
- material, plating/finish, conformance, and inspection certificate lifecycle
- compliance-aware supplier and quote filtering that fails closed when current
  evidence is absent

### Services and fulfillment

- CAD modeling, drawing redraft, FEA, DFM, DFA, assembly, and sourcing service lines
- authorized purchase-order or supplier-order workflows
- manufacturing payment, tax, refunds, and disputes
- inspection and quality records
- in-production, shipment, delivery, warehouse, and fulfillment coordination
- ERP, accounting, CRM, and logistics integrations

### Cross-platform experiences

- iPhone/iPad production release and actionable Inbox
- Android application
- native macOS and Windows applications
- contextual read-only assistant
- consequential agent actions after confirmation, idempotency, and audit contracts

## Implemented does not mean committed

The repository contains meaningful work in several deferred areas, including
Stripe, iOS, supplier-directory schema, geometry overlays, internal estimates,
additional vendor adapters, and multiple design explorations. Preserve and
reuse that work when its capability is promoted. Do not promote it merely to
justify past effort.

## Issue-creation rule

- Create implementation issues only for the active release and the next bounded
  proof in `PLAN.md`.
- A later release may hold a small candidate backlog, but its issues should have
  no urgency until the release becomes active.
- An incubator gets a research note or issue only when it is needed to answer a
  specific promotion question.
- Every promoted capability must cite the evidence that moved it and identify
  what active work it displaces.
- Protect Linear free-plan capacity: the roadmap and project descriptions hold
  unpromoted ideas; do not create an issue for each brainstorming bullet.
