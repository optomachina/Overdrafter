# OverDrafter Product Requirements Document

Last updated: July 28, 2026

## Document purpose

This is the canonical product requirements document for OverDrafter. It captures stable product intent based on the current repository, reconstructed documentation, and the present direction of the application. It replaces the role of a purely reconstructive product document by becoming the active source of truth for product behavior and product boundaries.

## Product summary

OverDrafter is a multi-role CNC quoting platform that turns uploaded CAD and drawing files into client-selectable quote packages. The product combines client intake, internal estimating and review, asynchronous extraction and quote orchestration, and curated quote publication in a single workflow-oriented system.

At a high level, the product does four things:

1. Lets clients submit parts and organize them into projects.
2. Lets client users explicitly request quotes for uploaded parts once the package is ready.
3. Lets internal estimators review extracted requirements and compare sourcing options.
4. Publishes curated quote packages for client review and selection.

The primary responsive-web entry model is `Parts | Quotes | Search`. The
approved iOS growth shell is `Inbox | Parts | Quotes | More` with a separate,
capability-gated `Ask OverDrafter` action. `Project` remains the collaboration
and commercial container in the domain; it does not need to be the first
navigation choice for every customer.

## Core terminology and container model

OverDrafter uses `Project` as the top-level persisted collaboration and commercial container. A project is the workflow wrapper for an RFQ, quote package, prototype run, or purchasing request, but it is revealed contextually rather than serving as the primary client navigation.

`Assembly` is a technical object that exists inside a project. It represents an engineering structure when a parent-child mechanical hierarchy is present, but it is not the umbrella object for the overall workflow.

This distinction is required because one customer request may include multiple assemblies, standalone parts, drawings, PDFs, spec sheets, notes, revisions, and supporting files in the same workflow. The product must not assume every request is a single assembly.

The intended hierarchy is:

- Project
- Assemblies inside a project, including subassemblies and nested parts where applicable
- Standalone parts inside a project that are not attached to an assembly
- Documents and supporting files inside a project
- Quote packages, quote rounds, and downstream order or review records scoped to a project

When collaboration or mixed-request context is needed, customer-facing actions should use project-oriented labels such as `Create Project`, `Add Parts`, `Add Assembly`, `Upload Files`, and `Request Quotes`. Responsive web keeps `Parts | Quotes | Search`; iOS reveals Projects contextually through `More` and artifact links.

## Quote Intelligence launch surface

The responsive web application uses three durable, user-facing destinations:

- `Parts` — the accessible artifact library, with All/Parts/Assemblies as one filter control
- `Quotes` — quote requests and their current supplier-response/selection state
- `Search` — live retrieval across accessible part, project, engineering, and quote metadata

This presentation model does not replace `Project` in the backend. Projects continue to own collaboration and mixed-request context. A part or quote may link back to its containing project without forcing the user to enter through a project dashboard.

Quote detail presents request facts and supplier offers directly. Buyer comparison uses independent points with ready-to-ship working days on X and quoted total price on Y. It must not draw a connecting, trend, or Pareto line through unrelated offers.

The approved iPhone/iPad shell adapts that same artifact-first product to a
smaller operational surface:

- `Inbox` — unresolved quote decisions and recoverable quote problems, not a
  general activity feed
- `Parts` — the same accessible artifact library
- `Quotes` — the same quote-request and offer-decision surface
- `More` — only destinations that work now, initially Search, Projects,
  Favorites, and Settings as each becomes available
- `Ask OverDrafter` — a separate contextual action, hidden until its read-only
  capability is available

New iOS users land in Quotes; later launches restore their last valid
destination. Unavailable services, PDM, supplier, and marketplace destinations
remain hidden rather than appearing as disabled placeholders.

In the approved iOS target, the app authenticates through the OverDrafter
website in `ASWebAuthenticationSession`. The callback carries only opaque
one-time material, and a server-mediated bootstrap establishes the existing
Supabase session in the app's persistent web store. Access and refresh tokens
never belong in callback URLs or native app storage. The security and lifecycle
contract is defined in
[`docs/mobile-authentication-contract.md`](docs/mobile-authentication-contract.md).

## Client-triggered quote request capability

OverDrafter includes an explicit customer-facing `Request Quote` action for uploaded parts. Client users can request a quote for an individual part from the part workspace, or request quotes for the ready parts in a project from the project workspace.

Canonical feature statement:

`Client users can explicitly request quotes for uploaded parts, causing OverDrafter to validate the package, create an idempotent quote request, enqueue work, and dispatch vendor quote generation through the worker pipeline across the organization's enabled vendors that are applicable to the current package.`

Current scope:
- client-triggered quote requests for a single part
- project-scoped bulk request for ready parts
- multi-vendor dispatch across org-enabled, part-applicable vendor lanes
- durable quote request lifecycle visibility in the client UI

Current non-goals:
- client-side vendor choice or multi-vendor comparison at request time
- cancellation UI
- automatic reruns after a successful request
- quote comparison across multiple automated vendors triggered by the client request path
- richer DFM or release-gate workflows beyond the existing request metadata and package validation

## Vision

Enable a CNC buyer to go from “I have a part and a drawing” to “I selected a vetted quote option” in one workspace, while giving internal estimators full control over review, sourcing, pricing, and publication.

## Long-term product direction (North Star)

OverDrafter’s current implementation is a curated CNC quote platform. The intended destination is a **manufacturing co-pilot** that lives inside the designer’s native CAD environment and disappears until it adds value.

The ideal multi-agent UX is:

- A single, persistent, CAD-native workspace (SolidWorks, Fusion 360, Onshape, Creo, Inventor plugins + web fallback with live 3D STEP viewer).
- Natural-language direction as the only control surface (“DFM this assembly for CNC aluminum 6061, get firm quotes from the 5 fastest shops under $800…”).
- Invisible specialist agents (DFM, extraction, quoting swarm via OpenClaw browser harness, modeling/drafting updater, assembly/fulfillment coordinator, PDM agent) that decompose, negotiate on an internal blackboard, and execute in parallel.
- On-demand visualizations only (live DFM heatmap on geometry, dynamic quote scatter, revision diff, risk heatmap) that collapse back to the clean CAD view when not needed.
- A future costing heatmap that explains an estimated price range through ranked, approximate cost drivers for geometry, tolerance, material, finish, quantity, lead time, and origin. It should learn from immutable feature/condition/prediction/quote snapshots, preserve vendor/source provenance, compare every prediction with later firm quotes, and track accuracy internally. Customer-facing output must not show an abstract confidence score; internal uncertainty widens the displayed range instead.
- A post-event supplier outcome view that can show an invited supplier where its price, ready-to-ship lead time, and response latency landed inside an anonymized cohort. It remains gated on explicit data-purpose terms, a minimum cohort, event closure, privacy review, and competition counsel; buyer-visible vendor identity must never leak into the supplier view.
- Branching/merging that feels like breathing; human override is instant and contextual.
- OpenClaw browser automation stays completely invisible—tabs, form submissions, and quote scraping happen server-side.

The product evolves from “upload files and receive curated quote options” to “drop a CAD file, speak your intent, and receive an optimized, quoted, PDM-tracked, shippable result.” All quoting, DFM, modeling, redrafting, assembly, fulfillment, and PDM workflows become delegated to the agent swarm. The human’s job is direction, taste, and final responsibility—nothing else.

This direction does not change current implementation boundaries; it is the guiding star for every future phase.

## Fulfillment-aware downstream boundary

After quote selection, the intended long-term downstream lifecycle is:

- review / procurement handoff
- approved
- ordered
- in production
- inspecting
- shipped
- delivered

Those states exist to provide shared visibility and explicit workflow modeling after quote selection. They do not mean the current product owns PO issuance, payment collection, vendor communication, shipment booking, billing systems, or ERP synchronization.

In the near term, the active foundation for this lifecycle is the existing review and procurement handoff route. `approved` is the first meaningful follow-on state once that handoff model and related metadata mature. `ordered` and later fulfillment states should remain visibility-oriented placeholders until the product deliberately expands beyond manual procurement follow-up.

See `docs/fulfillment-state-model.md` for the canonical downstream state meanings and planning boundary.

## Next-phase service taxonomy

Near-term domain work should treat service requests as an explicit taxonomy rather than as freeform notes attached to quote fields.

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
- Explicitly request quote collection when an uploaded part package is ready.
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

### For project collaborators
- Access only the projects they are invited to.
- View and participate in project-scoped work without seeing unrelated workspace data.

## Product goals

### Primary goals
- Reduce friction in part intake.
- Make uploaded parts immediately accessible while letting client users explicitly start quote collection when prerequisites are met.
- Centralize vendor comparison in one canonical record of quoting work.
- Provide a clean client experience for collaboration and quote selection.
- Maintain secure access boundaries between workspaces, projects, collaborators, and internal-only data.

### Secondary goals
- Support mixed sourcing models including browser automation, imported spreadsheets, and manual quote intake.
- Let customers discover qualified manufacturing suppliers by capability and geographic proximity when an instant-quote provider is not the best or only path.
- Let customers contribute supplier information for shops that are not yet represented, subject to verification and deduplication.
- Support long-running asynchronous processing.
- Preserve auditability for sensitive workflow actions.
- Make the app usable for both one-off parts and grouped project workflows.
- Keep future BOM, revision, and where-used capabilities compatible with projects that contain multiple assemblies and standalone parts.

## Supplier discovery and assisted-RFQ direction

OverDrafter should support two complementary sourcing lanes after a customer uploads a part:

1. `instant_quote`: free automated quote collection from supported high-volume vendor platforms.
2. `supplier_discovery`: search and assisted RFQ preparation for independent shops selected by capability, geography, certification, customer preference, or other reviewed fit criteria.

The supplier directory is a continuously maintained coverage system rather than a claim that every possible shop is permanently known. Supplier companies, individual facilities, capabilities, certifications, service areas, source evidence, and verification history must be represented separately so results can be deduplicated and audited.

Customers may:

- search for shops near a part destination or another chosen location
- filter shops by relevant manufacturing capabilities and qualifications
- suggest or provide information about an unlisted shop
- use directory information to prepare or support an RFQ without implying that the shop offers an instant API quote

Historical approved-supplier lists and public directories are discovery evidence only. A historical approval, certification, capability, address, or availability claim must retain its source and effective date and must not be presented as currently verified without a later verification event.

Commercial placement may eventually let suppliers pay for additional visibility. Paid placement must:

- be visibly labeled as sponsored
- remain separate from organic capability and proximity matching
- never make an otherwise ineligible supplier appear technically qualified
- never change quote price, lead-time, quality, or capability scoring
- preserve an organic-results path that customers can inspect independently

## Non-goals

The current product should not be treated as owning:
- direct ordering or purchase-order issuance
- subscription billing or payments
- ERP/CRM synchronization
- real-time chat or threaded messaging as a core workflow surface
- full manufacturing execution
- public marketing CMS functionality

Native iPhone and iPad applications are now in scope. The first beta reuses
hardened route-specific web workspaces and supports embedded email/password
sign-in. The approved follow-on preserves those workspaces for upload and quote
mutation parity but moves provider authentication into the system
web-authentication session. Privileged credentials must never be embedded in
the application.

## Client workspace surface

The client-facing workspace should be artifact-first. CAD, drawings, structured metadata, request state, and quote comparison should be the dominant surfaces in the part and project experience.

Chat-style interaction may exist as a contextual tool inside the workspace, but
it must not replace structured artifacts, quote comparisons, or explicit
confirmation surfaces. Responsive web and the first iOS beta launch through
`Parts | Quotes | Search`. The approved iOS target grows to
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
