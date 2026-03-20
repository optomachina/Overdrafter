# OverDrafter Architecture

Last updated: March 19, 2026

## Purpose

This document defines the major architectural boundaries in OverDrafter. It exists to keep product, engineering, and workflow discussions grounded in the same system model.

## System overview

OverDrafter is a workflow system for manufactured-part quoting. It connects client intake, internal estimation, asynchronous file processing, sourcing workflows, and curated quote publication within a single workspace-oriented product model.

The next-phase domain model should expand that quote-centric shape into an explicit service-request model. Projects remain collaboration containers, parts remain technical entities, and service request line items become the authoritative unit of requested work.

## Subsystems

### 1. Web application layer
- authentication entry points
- workspace-facing navigation and application shell
- client intake UI
- artifact-first client workspaces with contextual intelligence rails and chat as a secondary tool
- project-first browsing and creation flows
- assembly and part management inside a project
- internal estimator interfaces
- quote comparison and package publication surfaces
- route-local page composition for complex screens, with reusable quote-domain logic staying in `src/features/quotes/`

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
- recording quote request intent separately from quote run execution
- initiating automated quote retrieval where supported
- supporting manual quote entry or imported quote paths
- normalizing quote outputs into a canonical internal model
- materializing spreadsheet or manual lane data into `vendor_quote_results` and canonical per-lane `vendor_quote_offers`
- exposing client-safe quote comparison data through `public.api_list_client_quote_workspace`, rather than direct client reads from internal-only quote tables

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

## Domain hierarchy

The top-level customer-facing container is `Project`, not `Assembly`.

A project is the commercial and workflow scope for mixed manufacturing requests. It can contain:

- multiple assemblies
- standalone parts that are not attached to any assembly
- drawings, PDFs, spec sheets, and other supporting documents
- quote rounds, curated quote packages, and downstream review or order records

An assembly remains a technical structure nested inside a project. It should model engineering hierarchy such as subassemblies and parts, but it must not define the top-level information architecture for intake, navigation, or collaboration.

## Request-model boundary

- projects are the grouping and collaboration boundary, not the only place where service intent lives
- parts preserve technical identity, revision, and manufacturing context
- service request line items hold the requested work type, scheduling, status, and service-specific detail
- quote-specific fields such as requested quote quantities belong to `manufacturing_quote` line items rather than to a universal project request blob
- quote requests record user intent and lifecycle for starting quote collection
- quote runs record execution instances launched from a quote request or an internal-only kickoff
- vendor quote records remain vendor-specific execution output attached to a quote run

See `docs/service-request-taxonomy.md` for the canonical service types and mixed-service modeling rules.

## Client-triggered quote request lifecycle

Phase 1 keeps the existing queue and worker path, but adds a separate client-safe request-intent record:

- client part or project workspace validates the package and calls a quote request RPC
- the backend creates an idempotent quote request record when no active request already exists
- the backend creates a linked quote run execution record
- the backend seeds Xometry-only vendor lanes for that request in phase 1
- the backend enqueues `run_vendor_quote` work items in `work_queue`
- the worker claims the task, stages the files, and calls the Xometry adapter
- vendor result transitions roll up into both request lifecycle state and existing job lifecycle state
- client UI reads the latest quote request, with quote-run fallback for pre-existing data, to show request status

Phase 1 request lifecycle meanings:

- `not_requested`
- `queued`
- `requesting`
- `received`
- `failed`
- `canceled`

Phase 1 vendor boundary:

- client-triggered requests dispatch only to `xometry`
- existing internal and manual quote ingestion paths remain intact
- future multi-vendor expansion should add more requested vendors to the request record without collapsing intent and execution into one table

## Key cross-cutting concerns
- authorization
- provenance
- auditability
- observability
- data separation

## Extraction boundary

Drawing extraction is advisory evidence, not the canonical quote contract.

- `drawing_extractions.extraction` stores source-truth raw fields, field confidence, review-needed state, evidence, and debug candidate metadata.
- the worker should prefer deterministic label-anchored parsing first and call `gpt-5.4` fallback only when critical fields are missing, weak, or conflicting.
- preview-only debug reruns should flow through Supabase and the worker queue using `debug_extract_part`, not direct browser-to-worker calls.
- `debug_extraction_runs` is the internal observability record for preview-only reruns and should persist worker build, extractor version, selected model, and raw result payload.
- `approved_part_requirements` stores the normalized requirement record used by quoting and estimator workflows.
- `approved_part_requirements.spec_snapshot` is the transitional home for normalized quote-facing variants such as `quoteDescription`, `quoteFinish`, and field provenance or override state.
- Auto-approval may refresh auto-managed normalized fields from extraction output, but it must preserve reviewed user-managed values and must not silently promote low-confidence raw extraction into approved requirements.
