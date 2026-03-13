# OverDrafter Product Requirements Document

Last updated: March 13, 2026

## Document purpose

This is the canonical product requirements document for OverDrafter. It captures stable product intent based on the current repository, reconstructed documentation, and the present direction of the application. It replaces the role of a purely reconstructive product document by becoming the active source of truth for product behavior and product boundaries.

## Product summary

OverDrafter is a multi-role CNC quoting platform that turns uploaded CAD and drawing files into client-selectable quote packages. The product combines client intake, internal estimating and review, asynchronous extraction and quote orchestration, and curated quote publication in a single workflow-oriented system.

At a high level, the product does four things:

1. Lets clients submit parts and organize them into projects.
2. Lets internal estimators review extracted requirements and compare sourcing options.
3. Runs asynchronous extraction and quote orchestration through a worker and queue-backed process.
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
- Review published quote options.
- Select the best quote option for their needs.

### For internal estimators
- Turn uploaded files into structured part requirements.
- Review and correct extracted specifications.
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
- Preserve a strong internal review checkpoint before quotes are run or published.
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

## Product principles

### 1. Intake must feel fast
Submitting a part should feel lightweight and direct. Prompt text and file upload should live in one coherent intake path.

### 2. Internal review must be explicit
The system should not silently promote extracted or automated results directly to client-facing outputs without review checkpoints.

### 3. Client-facing options must be traceable
Published packages should be traceable to source quotes, internal review, and pricing policy decisions.

### 4. Important workflow state must be modeled
The database and backend should explicitly represent important operational states and transitions.

### 5. Automation must fail closed
If extraction or sourcing automation fails, the system must preserve visibility and prevent silent progression.

### 6. Internal-only data must stay internal
Internal sourcing context, operational notes, and sensitive quote context must not leak into client-facing views.

### 7. Workspace is the tenancy concept
The product should expose `workspace` as the user-facing tenancy boundary. Lower-level backend tenancy concepts should stay implementation details.

### 8. Version 1 should assume one workspace per company
Avoid premature multi-workspace UX unless a real operating need appears.
