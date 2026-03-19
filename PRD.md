# OverDrafter Product Requirements Document

Last updated: March 14, 2026

## Document purpose

This is the canonical product requirements document for OverDrafter. It captures stable product intent based on the current repository, reconstructed documentation, and the present direction of the application. It replaces the role of a purely reconstructive product document by becoming the active source of truth for product behavior and product boundaries.

## Product summary

OverDrafter is a multi-role CNC quoting platform that turns uploaded CAD and drawing files into client-selectable quote packages. The product combines client intake, internal estimating and review, asynchronous extraction and quote orchestration, and curated quote publication in a single workflow-oriented system.

At a high level, the product does four things:

1. Lets clients submit parts and organize them into projects.
2. Lets client users explicitly request quotes for uploaded parts once the package is ready.
3. Lets internal estimators review extracted requirements and compare sourcing options.
4. Publishes curated quote packages for client review and selection.

## Core terminology and container model

OverDrafter uses `Project` as the customer-facing top-level container. A project is the commercial and workflow wrapper for an RFQ, quote package, prototype run, or purchasing request.

`Assembly` is a technical object that exists inside a project. It represents an engineering structure when a parent-child mechanical hierarchy is present, but it is not the umbrella object for the overall workflow.

This distinction is required because one customer request may include multiple assemblies, standalone parts, drawings, PDFs, spec sheets, notes, revisions, and supporting files in the same workflow. The product must not assume every request is a single assembly.

The intended hierarchy is:

- Project
- Assemblies inside a project, including subassemblies and nested parts where applicable
- Standalone parts inside a project that are not attached to an assembly
- Documents and supporting files inside a project
- Quote packages, quote rounds, and downstream order or review records scoped to a project

Customer-facing creation and navigation language should therefore use project-oriented labels such as `Create Project`, `Add Parts`, `Add Assembly`, `Upload Files`, and `Request Quotes`.

## Client-triggered quote request capability

Phase 1 adds an explicit customer-facing `Request Quote` action for uploaded parts. Client users can request a quote for an individual part from the part workspace, or request quotes for the ready parts in a project from the project workspace.

Canonical feature statement:

`Client users can explicitly request quotes for uploaded parts, causing OverDrafter to validate the package, create an idempotent quote request, enqueue work, and dispatch vendor quote generation through the worker pipeline, starting with Xometry as the only enabled vendor in phase 1.`

Phase 1 scope:
- client-triggered quote requests for a single part
- project-scoped bulk request for ready parts
- Xometry as the only automated vendor target for client-triggered requests
- durable quote request lifecycle visibility in the client UI

Phase 1 non-goals:
- client-side vendor choice or multi-vendor comparison at request time
- cancellation UI
- automatic reruns after a successful request
- quote comparison across multiple automated vendors triggered by the client request path
- richer DFM or release-gate workflows beyond the existing request metadata and package validation

## Vision

Enable a CNC buyer to go from “I have a part and a drawing” to “I selected a vetted quote option” in one workspace, while giving internal estimators full control over review, sourcing, pricing, and publication.

## Long-term product direction

OverDrafter’s current implementation is a curated CNC quote platform, but the intended long-term direction is broader: a manufacturing operating system that unifies project-scoped file intake, nested part and assembly organization, revision control, engineering-service workflows, sourcing, quote comparison, purchasing handoff, and fulfillment visibility in one system.

The product should evolve from “upload files and receive curated quote options” toward “manage the full lifecycle of manufactured parts and projects from design package to ordered result.” That direction includes:

- a stronger part- and project-centric workspace model
- support for mixed-content projects containing assemblies, standalone parts, and loose documents in one workflow
- revision-aware file management for CAD, drawings, and related artifacts
- explicit support for engineering-service requests such as modeling, redrafting, FEA, DFM, and DFA
- richer quote orchestration, vendor comparison, and selection workflows
- downstream review, purchasing, shipping, and fulfillment states
- cross-platform access across web, desktop, and mobile surfaces
- CAD-native integrations and plugins for direct submission and synchronization from authoring tools

This long-term direction does not change the current implementation boundaries or current execution phase. It exists to clarify the intended destination so future planning, architecture, and prioritization can align toward the same product shape over time.

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
- Support long-running asynchronous processing.
- Preserve auditability for sensitive workflow actions.
- Make the app usable for both one-off parts and grouped project workflows.
- Keep future BOM, revision, and where-used capabilities compatible with projects that contain multiple assemblies and standalone parts.

## Non-goals

The current product should not be treated as owning:
- direct ordering or purchase-order issuance
- subscription billing or payments
- ERP/CRM synchronization
- real-time chat or threaded messaging as a core workflow surface
- full manufacturing execution
- native mobile applications
- public marketing CMS functionality

## Client workspace surface

The client-facing workspace should be artifact-first. CAD, drawings, structured metadata, request state, and quote comparison should be the dominant surfaces in the part and project experience.

Chat-style interaction may exist as a contextual tool inside the workspace, but it must not be the primary page surface or the primary information architecture. The intended client mental model remains `Project > Part > Artifacts > Quotes`, with conversation supporting that flow rather than replacing it.

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

### 6. Internal-only data must stay internal
Internal operational notes, unpublished workflow/debug context, and other non-client-facing quote data must not leak into client-facing views. Client quote comparison may intentionally expose vendor identities and published raw lane context when that data is part of the workspace comparison experience.

### 7. Workspace is the tenancy concept
The product should expose `workspace` as the user-facing tenancy boundary. Lower-level backend tenancy concepts should stay implementation details.

### 8. Version 1 should assume one workspace per company
Avoid premature multi-workspace UX unless a real operating need appears.
