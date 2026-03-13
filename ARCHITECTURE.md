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
- project-first browsing and creation flows
- assembly and part management inside a project
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
- project-level navigation that does not treat assemblies as the umbrella container

## Domain hierarchy

The top-level customer-facing container is `Project`, not `Assembly`.

A project is the commercial and workflow scope for mixed manufacturing requests. It can contain:

- multiple assemblies
- standalone parts that are not attached to any assembly
- drawings, PDFs, spec sheets, and other supporting documents
- quote rounds, curated quote packages, and downstream review or order records

An assembly remains a technical structure nested inside a project. It should model engineering hierarchy such as subassemblies and parts, but it must not define the top-level information architecture for intake, navigation, or collaboration.

## Key cross-cutting concerns
- authorization
- provenance
- auditability
- observability
- data separation
