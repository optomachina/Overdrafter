# OverDrafter Product Requirements Document

Last updated: March 11, 2026

## Document purpose

This is the canonical product requirements document for OverDrafter. It captures stable product intent based on the current repository, reconstructed documentation, and the present direction of the application. It replaces the role of a purely reconstructive product document by becoming the active source of truth for product behavior and product boundaries.

## Product summary

OverDrafter is a multi-role CNC quoting platform that turns uploaded CAD and drawing files into client-selectable quote packages. The product combines client intake, internal estimating and review, asynchronous extraction and quote orchestration, and curated quote publication in a single workflow-oriented system.

At a high level, the product does four things:

1. Lets clients submit parts and organize them into projects.
2. Lets internal estimators review extracted requirements and compare sourcing options.
3. Runs asynchronous extraction and quote orchestration through a worker and queue-backed process.
4. Publishes curated quote packages for client review and selection.

## Vision

Enable a CNC buyer to go from “I have a part and a drawing” to “I selected a vetted quote option” in one workspace, while giving internal estimators full control over review, sourcing, pricing, and publication.

## Core jobs to be done

### For clients
- Upload a part package quickly.
- Submit a prompt and files in one flow.
- Organize parts into projects.
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
