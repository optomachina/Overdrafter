# OverDrafter Architecture

Last updated: March 13, 2026

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
- project and part browsing
- internal estimator interfaces
- quote comparison and package publication surfaces

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
- identifying or collecting the requested service type before service-specific parsing runs

### 5. Extraction and asynchronous worker layer
- extracting structured part requirements from files
- running long-lived or queued work
- surfacing processing status and failures

### 6. Quote orchestration layer
- initiating automated quote retrieval where supported
- supporting manual quote entry or imported quote paths
- normalizing quote outputs into a canonical internal model

### 7. Internal operations layer
- estimator review of extracted requirements
- correction and approval of structured data
- quote comparison
- pricing-policy application
- package curation and publication

### 8. Collaboration and project-sharing layer
- project grouping
- collaborator invitation and access
- project-scoped visibility boundaries

## Request-model boundary

- projects are the grouping and collaboration boundary, not the only place where service intent lives
- parts preserve technical identity, revision, and manufacturing context
- service request line items hold the requested work type, scheduling, status, and service-specific detail
- quote-specific fields such as requested quote quantities belong to `manufacturing_quote` line items rather than to a universal project request blob

See `docs/service-request-taxonomy.md` for the canonical service types and mixed-service modeling rules.

## Key cross-cutting concerns
- authorization
- provenance
- auditability
- observability
- data separation
