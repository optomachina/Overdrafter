# OverDrafter Product Requirements Document

Last updated: August 22, 2026

## Document purpose

This is the canonical product requirements document for OverDrafter. It captures stable product intent based on the current repository, reconstructed documentation, and the present direction of the application. It replaces the role of a purely reconstructive product document by becoming the active source of truth for product behavior and product boundaries.

## Product summary

OverDrafter helps a buyer turn a manufacturable part into a trustworthy quote
decision. Its first product wedge is deliberately small: sign in, upload a
supported part, confirm the manufacturing requirements, receive an honest
sourcing outcome, compare trustworthy offers, and continue with the selected
vendor.

At a high level, the current product does four things:

1. Accepts part files and organizes them in an authenticated workspace.
2. Extracts quote-facing requirements for customer review and correction.
3. Orchestrates automatic and manual sourcing paths while preserving the true
   state and provenance of every result.
4. Presents trustworthy offers for comparison, selection, and safe vendor
   handoff.

The primary responsive-web entry model is `Parts | Quotes | Search`. `Project`
remains the collaboration and procurement-workflow container in the domain; it
does not need to be the first navigation choice for every customer.
`Organization` remains the authorization and future commercial-account
boundary.

## Active 1.0 controlled-beta product contract

**Target customer:** a hands-on buyer—individual tinkerer, student, freelance
engineer, or very small company—who needs a price for a manufacturable part.

**Release channel:** 1.0 is an invitation-only, controlled design-partner beta,
not general availability. Public signup does not itself grant automatic quote
access.

**Promise:** a signed-in, enrolled customer can upload one part inside the exact
non-ITAR CNC-milled aluminum 6061-T6 package envelope in
`docs/1-0-beta-runbook.md`, review the requirements, request a quote, and reach
a truthful decision state with a safe vendor handoff.

**Launch sources:** at least three production-certified automatic quote
sources, with five functioning sources preferred. Xometry is the security and
certification baseline; every additional provider must pass the same common
controlled-dispatch contract plus a versioned provider-specific process and
file-format envelope. An optional PDF may contribute drawing requirements, but
PDF-only or out-of-bound packages must not be represented as supported merely
to enlarge the launch claim.

**Access posture:** 1.0 design-partner organizations receive the automatic-
quote capability through an explicit, audited rollout grant. 1.0 does not
activate self-service billing and does not settle the eventual Free-versus-paid
packaging decision. It also does not open vendor automation to every signed-in
organization without a reviewed authorization and spend boundary.

**Completion:** Xometry and at least two additional admitted providers are
production-certified, every purchasable variant returned for one provider
quote is preserved under the normalized comparison contract, and external
design partners complete the journey unaided under the evidence gates in
`ACCEPTANCE_CRITERIA.md`. Five functioning sources remain the preferred target.
Revenue is a 1.1 milestone, not a 1.0 gate.

**Not 1.0:** anonymous quote claim, subscription activation, manufacturing
checkout or ordering, unadmitted provider automation, native apps, CAD
plug-ins, supplier discovery, geometry/cost intelligence, DFM/DFA, design-file
automation, PDM, inspection, warehousing, and fulfillment.

`OVD-407` defines a development and evaluation exception to that product
boundary. An operator may invoke the standalone live-provider evaluation
harness with an authenticated provider session and operator-selected files
without production routing, customer disclosure, provider admission,
entitlement/rollout, dispatch-permit/preflight, anti-bot certification, or
order-prevention affirmations. It does not waive export-control classification:
the operator must explicitly confirm the selected files are non-export-controlled
before upload. This exception is not a customer capability or
1.0 provider certification: it does not enqueue production work, persist a
customer offer, or make an evaluated provider eligible for customer fan-out.

`PLAN.md` defines the exact current queue. `ROADMAP.md` bridges to the release
ladder, incubator routes, and promotion rules. The detailed deferred-capability
inventory lives only in the Linear Product Portfolio & Future Capability
Index. Later sections of this PRD describe durable domain rules or product
direction; they do not expand the active release unless the promotion rule is
satisfied.

The exact package, vendor-disclosure confirmation, data-handling gate, browser
support statement, evidence record, and links to the executable rollout,
rollback, and vendor-session recovery procedures are defined in
[`docs/1-0-beta-runbook.md`](docs/1-0-beta-runbook.md).
The post-certification customer cohort, safeguards, operating caps, evidence,
and decision protocol are defined in
[`docs/founding-beta-program.md`](docs/founding-beta-program.md).

## Core terminology and container model

OverDrafter uses `Project` as the top-level persisted collaboration and procurement-workflow container. A project is the workflow wrapper for an RFQ, quote package, prototype run, or purchasing request, but it is revealed contextually rather than serving as the primary client navigation. It is not the subscription account.

`Assembly` is a technical object that exists inside a project. It represents an engineering structure when a parent-child mechanical hierarchy is present, but it is not the umbrella object for the overall workflow.

This distinction is required because one customer request may include multiple assemblies, standalone parts, drawings, PDFs, spec sheets, notes, revisions, and supporting files in the same workflow. The product must not assume every request is a single assembly.

The intended hierarchy is:

- Project
- Assemblies inside a project, including subassemblies and nested parts where applicable
- Standalone parts inside a project that are not attached to an assembly
- Documents and supporting files inside a project
- Quote packages, quote rounds, and downstream order or review records scoped to a project

When collaboration or mixed-request context is needed, customer-facing actions should use project-oriented labels such as `Create Project`, `Add Parts`, `Add Assembly`, `Upload Files`, and `Request Quotes`. Responsive web keeps `Parts | Quotes | Search`; the approved later iOS target reveals Projects contextually through `More` and artifact links.

## Current web quote surface

The responsive web application uses three durable, user-facing destinations:

- `Parts` — the accessible artifact library, with All/Parts/Assemblies as one filter control
- `Quotes` — quote requests and their current supplier-response/selection state
- `Search` — live retrieval across accessible part, project, engineering, and quote metadata

This presentation model does not replace `Project` in the backend. Projects continue to own collaboration and mixed-request context. A part or quote may link back to its containing project without forcing the user to enter through a project dashboard.

Quote detail presents request facts and supplier offers directly. One provider
quote may contain multiple independently purchasable variants, including
different manufacturing tiers, lead or arrival times, and sourcing regions.
Buyer comparison preserves every variant as an independent option, groups them
under the provider, and uses independent points with ready-to-ship working days
on X and quoted total price on Y. It must not draw a connecting, trend, or
Pareto line through unrelated offers. Sourcing controls distinguish explicitly
US/domestic options from an all-sourcing view; missing or ambiguous provenance
is shown as unknown and is never relabeled as domestic or foreign.

PR #256 shipped the preserved iPhone/iPad application foundation: a universal
SwiftUI target with native `Parts | Quotes | Search` navigation around
access-controlled route-specific web workspaces. The current shell starts in
Parts. This code foundation is outside 1.0 and is not evidence of completed
production authentication or TestFlight distribution. The broader `OVD-55`
mobile experience and the `OVD-283` production regression, policy, and
TestFlight gates remain deferred Linear work.

The approved later `OVD-55` target may grow the existing shell to
`Inbox | Parts | Quotes | More` plus a separate Ask action:

- `Inbox` — unresolved quote decisions and recoverable quote problems, not a
  general activity feed
- `More` — only destinations that work then, initially Search, Projects,
  Favorites, and Settings as each becomes available
- `Ask OverDrafter` — a separate contextual action, hidden until its read-only
  capability is available

Inbox, More, and Ask are not shipped by the current foundation. The later
target lands new users in Quotes and may restore the last valid destination on
subsequent launches. Unavailable services, PDM, supplier, and marketplace
destinations remain hidden rather than appearing as disabled placeholders.
`OVD-283` owns the physical-device regression, policy, signed archive and
upload, TestFlight installation, Beta App Review, and public-link evidence;
none of those release gates is declared complete here.

In the approved iOS target, the app authenticates through the OverDrafter
website in `ASWebAuthenticationSession`. The callback carries only opaque
one-time material, and a server-mediated bootstrap establishes the existing
Supabase session in the app's persistent web store. Access and refresh tokens
never belong in callback URLs or native app storage. The security and lifecycle
contract is defined in
[`docs/mobile-authentication-contract.md`](docs/mobile-authentication-contract.md).

## Client-triggered quote request capability

For 1.0, OverDrafter turns a reviewed package inside the exact controlled-beta
envelope into a sourcing result. Every result ends in one of three client-safe
outcomes: live offers, ranked potential-provider recommendations, or a bounded
unsupported-package explanation with a useful next action.

Canonical 1.0 feature statement:

`An explicitly enrolled design-partner organization can request automatic
quote collection for the production-certified launch lane and receive the
complete persisted live offer set when the vendor succeeds. Every customer
sees a truthful fallback when the lane fails or the package is unsupported;
provider guidance is never mislabeled as a quote.`

1.0 access and truth rules:
- Access belongs to the organization, not an individual membership.
- Design-partner organizations may upload parts without a customer-facing quota.
- Organizations outside the bounded automatic rollout receive safe provider guidance without starting vendor work.
- Automatic vendor collection requires an explicit, audited server-side capability grant before vendor work is queued.
- Potential providers must be labeled separately from returned quotes. Synthetic or stale prices must never be presented as live.
- Existing operational throttles and cost ceilings remain invisible safety controls. They are not customer quotas and must not create upload anxiety.

Current implementation foundation:
- client-triggered automatic quote requests for a single part
- project-scoped bulk automatic requests for ready parts
- multi-vendor dispatch across org-enabled, part-applicable vendor lanes
- durable quote request lifecycle visibility in the client UI
- provider recommendations ranked from authenticated, reviewed capability profiles
- official provider RFQ links that remain useful when automation is unavailable
- immutable request lanes keyed by vendor, exact disclosed package and requirements, and quantity
- vendor-stated commercial validity stored separately from the 14-day collection-freshness signal

The canonical database, live Xometry adapter, worker persistence, and client
option model support multiple offer rows for one provider result. `OVD-408`
enumerates the complete supported Xometry option set, reconciles one canonical
row per provider-derived offer key, groups variants for comparison, and applies
truthful US-only/all-sourcing visibility. Each offer has typed
`geographic_origin`; existing descriptive `sourcing` text is not authoritative
geographic provenance. A successful `OVD-394` standalone quote remains
connectivity proof only and does not replace the OVD-408 customer contract or
the hosted repeatability proof required by `OVD-206`.

Quote freshness rules:
- The 14-day trusted-adapter rule answers whether a collected offer is recent enough to present as live; it does not assert that the vendor price is still commercially valid.
- Commercial validity is vendor-stated or operator-entered. It may be an explicit expiration date or an explicit duration, and it is never inferred when missing.
- Quote scope fingerprints are versioned, internal-only, and derived from the exact outbound files and manufacturing fields disclosed to one vendor for one quantity.

Planned 1.1 commercial decisions:
- define Free and paid packaging from 1.0 evidence
- validate the existing replay-safe Stripe subscription synchronization
- approve one hosted monthly Checkout price and Billing Portal access
- use production funnel events from signup through live offer receipt

Current non-goals:
- client-controlled bypasses of vendor-lane validity or cooldown eligibility
- automatic reruns that ignore unchanged disclosure scope or a still-valid offer
- richer DFM or release-gate workflows beyond the existing request metadata and package validation
- self-service subscription activation, annual pricing, coupons, manufacturing
  payments, orders, and complex account administration

## Vision

Enable a CNC buyer to go from “I have a part and a drawing” to “I selected a vetted quote option” in one workspace, while giving internal estimators full control over review, sourcing, pricing, and publication.

Long term, that starting state may also include customers who possess only one
side of the design package. Any promoted design-package workflow must preserve
exact geometry, editable source artifacts, provenance, version identity, and
explicit human review. Segment size, frequency, and willingness to pay require
customer evidence before prioritization.

## Long-term product direction

OverDrafter may grow from a curated CNC quote platform into a manufacturing
co-pilot that works across the buyer's existing design and procurement tools.
Natural language may orchestrate work, but precision edits, external actions,
cost claims, and compliance decisions must remain structured, reviewable, and
auditable. Automation must stay subordinate to explicit human authorization.

This direction does not determine the next release. The detailed capability
inventory—including CAD integrations, native apps, design automation,
manufacturing intelligence, supplier workflows, and managed services—lives in
the Linear Product Portfolio & Future Capability Index and must earn promotion
through `ROADMAP.md`.

## Fulfillment-aware downstream boundary

After quote selection, the intended long-term downstream lifecycle is:

- review / procurement handoff
- approved
- ordered
- in production
- inspecting
- shipped
- delivered

Those states exist to provide shared visibility and explicit workflow modeling after quote selection. They do not mean the current product owns manufacturing PO issuance, manufacturing payment collection, vendor communication, shipment booking, order-billing operations, or ERP synchronization. Organization subscription billing is a separate commercial-access subsystem.

This is a future domain contract, not near-term 1.0 or 1.1 work. Its current
foundation is the existing review and procurement handoff route; a manual
order ledger may be promoted only through `ROADMAP.md`. `approved` is the first
meaningful follow-on state once that handoff model and related metadata mature.
`ordered` means an authorized operator recorded an externally placed order and
its external reference; it does not mean OverDrafter submitted or paid for the
order. Later fulfillment states remain visibility-oriented and manually or
externally confirmed.

## Future service taxonomy contract

If service work is promoted from its incubator, it should use an explicit taxonomy rather than freeform notes attached to quote fields.

The canonical next-phase service types are:

- `manufacturing_quote`
- `cad_modeling`
- `drawing_redraft`
- `fea_analysis`
- `dfm_review`
- `dfa_review`
- `assembly_support`
- `sourcing_only`

Projects should act as containers and rollups for these requests, while the authoritative unit of requested work becomes a service request line item that can attach to a part, a project, and later an assembly. This keeps mixed-service projects coherent without breaking the current quote workflow, which should continue to map to a default `manufacturing_quote` request.

See `docs/service-request-taxonomy.md` for the detailed modeling rules, mixed-service representation, and reuse-versus-replace guidance against the current quote-shaped request model.

## Core jobs to be done

### For clients
- Upload a part package quickly.
- Submit a prompt and files in one flow.
- Organize parts into projects.
- Create a project before deciding whether the submitted content includes assemblies, standalone parts, or both.
- Share projects with collaborators.
- Receive an actionable sourcing result without waiting for an operator.
- In a future commercial release, choose paid automatic quote collection when it is valuable.
- See whether quote collection has not started, is queued, is requesting, has received a response, or failed.
- Review published quote options.
- Select the best quote option for their needs.

### For internal estimators
- Turn uploaded files into structured part requirements.
- Correct extracted specifications when an exception or manual hold requires it.
- Compare automated and manual vendor quotes.
- Apply internal pricing policy.
- Publish curated quote packages to clients.
- Maintain operational visibility over the quoting pipeline.

### For internal admins
- Perform all estimator actions.
- Manage workspace access and role assignments.
- Maintain the integrity of internal operational workflows.
- Allowlisted platform admins can inspect organizations, memberships, jobs, and projects across the full platform in a read-only oversight mode.

### For commercial operations admins
- Inspect organization-level Free/Pro status, entitlement source, subscription state, and grant history.
- Grant or revoke reasoned trial and complimentary Pro access when authorized.
- Review manual procurement handoffs and externally confirmed order status.
- Perform privileged mutations only through separately granted capabilities, step-up authentication, and append-only audit records.

### For project collaborators
- Access only the projects they are invited to.
- View and participate in project-scoped work without seeing unrelated workspace data.

## Product goals

### Primary goals
- Reduce friction in part intake.
- Make supported uploads immediately useful through live offers or reviewed provider guidance.
- Centralize vendor comparison in one canonical record of quoting work.
- Provide a clean client experience for collaboration and quote selection.
- Maintain secure access boundaries between workspaces, projects, collaborators, and internal-only data.
- Let users receive useful sourcing guidance without quota anxiety and use beta evidence to decide how cost-bearing automatic quote collection should later be packaged.
- Give trusted operators safe, auditable controls for commercial access and order visibility.

### Secondary goals
- Support mixed sourcing models including browser automation, imported spreadsheets, and manual quote intake.
- Let customers discover qualified manufacturing suppliers by capability and geographic proximity when an instant-quote provider is not the best or only path.
- Let customers contribute supplier information for shops that are not yet represented, subject to verification and deduplication.
- Support long-running asynchronous processing.
- Preserve auditability for sensitive workflow actions.
- Make the app usable for both one-off parts and grouped project workflows.
- Keep future BOM, revision, and where-used capabilities compatible with projects that contain multiple assemblies and standalone parts.

## Supplier and quote-integration terminology

These stable distinctions apply if supplier-network work is promoted:

- a **provider** is the company or facility offering manufacturing work;
- **provider role** records whether it is a direct fabricator,
  marketplace/aggregator, broker/agent, or unknown, with provenance; and
- a **quote adapter** is only the transport/integration used to request or
  collect a quote—API, portal automation, email, or an assisted workflow.

A **brick-and-mortar quote adapter** therefore means a quote integration to an
identified physical fabricator. It is not evidence by itself that the provider
is direct, qualified, certified, or a good fit.

Supplier companies, physical facilities, capabilities, certifications, source
evidence, and verification history must remain separable and auditable.
Historical lists and public directories are discovery evidence, not current
qualification. Sponsored placement must remain visibly labeled and must never
alter technical eligibility or organic matching. Detailed supplier-network
capabilities live in the Linear portfolio index.

## Non-goals

The current product should not be treated as owning:
- manufacturing payment authorization, capture, refunds, or disputes
- automated supplier order placement or purchase-order issuance
- manufacturing-order discounts
- per-seat, usage-based, upload-quota, or quote-quota billing
- tax calculation, multi-currency, or accounting-system ownership
- ERP/CRM synchronization
- real-time chat or threaded messaging as a core workflow surface
- full manufacturing execution
- public marketing CMS functionality

The native iPhone and iPad application foundation is implemented and preserved;
production readiness and distribution remain deferred. Mobile scope does not
replace full desktop authoring and does not authorize consequential agent
writes, messages, quote submissions, approvals, purchases, or shares;
manufacturing payment or automated supplier order placement; or use or
reproduction of standards content without the required license. Any later beta
should reuse hardened route-specific web workspaces and move provider
authentication through the system web-authentication session. Privileged
credentials must never be embedded in the application.

## Commercial account and billing boundary

The implementation contains organization-level `Free` and `Pro` plan machinery,
but neither label is approved customer-facing packaging for 1.0. Packaging and
activation are a 1.1 decision; the controlled beta uses explicit, audited
design-partner access.

The dormant implementation currently models Free as uploads, project
organization, request preparation, provider guidance, and official RFQ links,
with Pro adding the `automatic_quote_collection` entitlement. This is retained
technical behavior, not permission to publish those offers or prices before the
1.1 decision.
- Membership roles such as client, estimator, and internal admin remain authorization roles; they are not commercial plans.
- Trial grants are explicit entitlement grants with actor, reason, effective dates, required expiration, revocation history, and immutable audit.
- Complimentary grants are explicit entitlement grants with actor, required reason, effective dates, required review date, optional expiration, revocation history, and immutable audit.
- The implemented $49/month Stripe price is a disabled pricing hypothesis, not
  an approved 1.0 offer. Activating or changing it requires a 1.1 pricing
  decision and synchronized product copy, validation, and Stripe configuration.
- Eligible past-due Pro subscriptions retain access for a seven-day delinquency grace period before resolving to Free.
- Stripe is the economic source of truth for customers, products, prices, subscriptions, and invoices.
- A webhook-synchronized local projection plus active manual grants is the server-side source used for product access decisions.
- Client redirects, UI state, and client-supplied Stripe identifiers must never grant Pro access.
- Annual pricing, coupons, promotion codes, procurement payments, and order administration are deferred until the web product records revenue.

## Client workspace surface

The client-facing workspace should be artifact-first. CAD, drawings, structured metadata, request state, and quote comparison should be the dominant surfaces in the part and project experience.

Chat-style interaction may exist as a contextual tool inside the workspace, but
it must not replace structured artifacts, quote comparisons, or explicit
confirmation surfaces. Responsive web launches through `Parts | Quotes |
Search`. A later approved iOS target may grow to
`Inbox | Parts | Quotes | More` plus a separate Ask action. Project remains
contextual collaboration scope, and artifact/quote detail remains the decision
surface.

## Product principles

### 1. Intake must feel fast
Submitting a part should feel lightweight and direct. Prompt text and file upload should live in one coherent intake path.

### 2. Internal review must stay focused
The system may auto-approve extracted part requirements to keep intake moving. Client users may explicitly trigger quote collection when the package is ready, while internal users still control exception handling, pricing policy, and any client-facing publication step.

### 3. Client-facing options must be traceable
Published packages should be traceable to source quotes, internal review, and pricing policy decisions.

### 4. Important workflow state must be modeled
The database and backend should explicitly represent important operational states and transitions.

### 9. Quote request intent and quote execution are different records
The system should distinguish client quote-request intent from quote-run execution. Parts and jobs remain the customer-facing request containers, quote requests record customer intent and lifecycle, quote runs record execution, and vendor quote records hold provider-specific outcomes.

### 5. Automation must fail closed
If extraction or sourcing automation fails, the system must preserve visibility and prevent silent progression.

### 10. Extraction must preserve source truth and quote-ready normalization separately
Drawing extraction must keep source-truth values from the drawing title block distinct from downstream quote-facing normalization. Raw extracted fields are evidence and must remain traceable. Quote-facing fields may be normalized for estimator and vendor workflows, but that normalization must not silently destroy source text or overwrite reviewed user edits.
For drawings with missing, low-confidence, or conflicting parser output, the system may use a bounded model fallback to recover raw title-block values, but it must still validate the returned fields and fail closed into review when uncertainty remains.

Manufacturing process follows the same boundary. The system should preserve raw drawing process text, derive a canonical process classification with confidence and provenance when possible, and let the user confirm or override that classification before quote dispatch. Vendor eligibility should be derived from the reviewed canonical process rather than a generic default vendor list.

### 6. Internal-only data must stay internal
Internal operational notes, unpublished workflow/debug context, and other non-client-facing quote data must not leak into client-facing views. Client quote comparison may intentionally expose vendor identities and published raw lane context when that data is part of the workspace comparison experience.

### 7. Workspace is the tenancy concept
The product should expose `workspace` as the user-facing tenancy boundary. Lower-level backend tenancy concepts should stay implementation details.

### 8. Version 1 should assume one workspace per company
Avoid premature multi-workspace UX unless a real operating need appears.
