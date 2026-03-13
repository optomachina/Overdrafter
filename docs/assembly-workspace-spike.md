# Assembly Workspace Spike

Last updated: March 13, 2026

## Purpose

This note defines a repo-grounded shape for assembly-aware uploads and tree display inside the existing OverDrafter project model.

It is intentionally a spike artifact, not an implementation spec. The goal is to clarify how later assembly work should fit the current project-first product and schema direction without prematurely designing full PDM, revision graphs, or CAD-native sync.

## Current repo anchors

The current repository already establishes several important constraints:

- `Project` is the commercial, collaboration, and navigation container. `Assembly` is a technical structure inside a project, not the top-level workflow object.
- client upload intake currently creates one or more `jobs`, optionally auto-creating a project when a multi-part upload produces more than one grouped draft
- uploaded files are stored as `job_files` through `api_attach_job_file(...)`
- part reconciliation is handled by `api_reconcile_job_parts(...)`, which groups CAD and drawing files by normalized basename and materializes `parts`
- shared visibility is already modeled at project scope through `projects`, `project_jobs`, `project_memberships`, and `project_invites`
- transitional request intent already includes `assembly_support` and `dfa_review`, but that intent still rides on the current job/request envelope rather than a dedicated assembly model

Those anchors mean assembly-aware work should layer on top of the existing `project -> job -> part -> file` shape rather than replacing it.

## What the current implementation already gives us

### 1. Project remains the right outer container

The repo docs already resolve the core container decision:

- one project may contain multiple assemblies
- one project may also contain standalone parts
- one project may contain supporting documents that do not belong to any single part

That aligns with the current project workspace, collaboration rules, and project membership model. Assembly work should not introduce a second top-level access boundary.

### 2. File provenance is already good enough to build from

Current upload flow preserves:

- who uploaded the file
- which job owns the file
- original filename
- normalized filename
- file kind
- storage path

This is enough to support a first assembly spike as long as new tree metadata references existing file records instead of inventing a separate storage system.

### 3. Part reconciliation is reusable, but only for part pairing

Current reconciliation groups CAD and drawing files by normalized basename. That is a useful primitive for:

- pairing `widget.step` with `widget.pdf`
- preserving one technical part record
- continuing the current extraction and quote path

It is not enough for:

- representing `assembly_a.sldasm` as a parent of `part_01.sldprt`
- distinguishing root assembly files from child part files
- carrying BOM order, child quantities, or nested subassemblies

### 4. Project workspace display already has the right shell

The current project route already provides:

- project-scoped navigation
- bulk actions and request summaries
- a dense line-item table
- a focused detail rail / mobile drawer

That means the first assembly-aware workspace should extend the existing project page rather than creating a separate assembly-first surface.

## Gaps the spike must acknowledge

The current repo shape does not yet model:

- an assembly entity inside a project
- parent-child edges between assemblies, subassemblies, and parts
- project-scoped loose documents outside a job
- confidence or review state for inferred hierarchy
- a tree-aware summary that can coexist with the current line-item table

These are real gaps. The spike should name them directly instead of pretending that current part reconciliation already solves assembly behavior.

## Recommended minimum assembly-aware model

### Product rules

Use these rules for later implementation work:

1. `Project` stays the only customer-facing outer container.
2. `Assembly` is a technical grouping nested inside a project.
3. Existing part jobs remain the operational line items during the transition.
4. Assembly hierarchy references existing jobs, parts, and files instead of replacing them.
5. Assembly access control inherits from the project. There is no separate assembly membership model.

### Minimum persisted concepts

The minimum durable model for an assembly-aware tree is:

- a project-scoped assembly node record
- a parent-child relationship record
- a project-scoped loose document record or equivalent

One practical shape is:

| Concept | Purpose | Reuses current records? |
|---|---|---|
| `assembly_nodes` | Represents root assemblies, subassemblies, part nodes, and document nodes inside one project tree | Yes. Part/document nodes should reference existing `jobs`, `parts`, and `job_files` where possible |
| `assembly_edges` | Stores parent-child relationships, child quantity, ordering, and provenance | No direct current equivalent |
| `project_files` or `project_documents` | Holds BOMs, spec sheets, notes, and other project files that do not belong to a single job | No. Current `job_files` are job-scoped only |

The important point is not the exact table names. The important point is that the first assembly implementation needs an explicit hierarchy layer plus a place for project-level documents.

### Minimum node fields

Regardless of exact schema names, the first hierarchy-capable node shape should support:

- `project_id`
- `node_kind`: `assembly`, `part`, or `document`
- `display_name`
- optional `job_id`
- optional `part_id`
- optional `source_file_id`
- `relation_source`: `upload_name`, `parsed_cad`, `manual`, or similar
- `relation_confidence`
- `review_status`: inferred, confirmed, needs_attention

### Minimum edge fields

Parent-child edges should support:

- `parent_node_id`
- `child_node_id`
- `quantity`
- `sort_order`
- provenance / confidence fields

That is enough to render a basic tree, preserve ambiguity, and allow later review tooling without forcing full revision or where-used modeling.

## Recommended upload and reconciliation flow

The spike should assume this later flow:

1. The user still uploads into a project.
2. Raw files still enter the current file storage path with provenance intact.
3. Existing part reconciliation still creates or updates part records for recognizable part CAD and drawing pairs.
4. An assembly classification pass then adds hierarchy metadata on top of the reconciled parts and raw files.
5. Loose BOMs, PDFs, and notes that are not part-specific remain project-level documents rather than fake part records.
6. Extraction, quoting, and service-intent workflows continue to operate on part jobs unless a later feature explicitly needs assembly-scoped review.

This sequencing keeps the current quoting path stable. Assembly grouping becomes an overlay on existing part/job records instead of a rewrite of intake.

## How uploads should relate to the current project-first model

### Keep

- project creation and project membership
- project job assignment through `project_jobs`
- current part-level jobs and part reconciliation
- current request/service-intent bridge on jobs
- current project workspace route as the main browsing surface

### Add

- explicit hierarchy metadata inside the project
- project-level document handling
- assembly-aware summaries and filters
- review states for inferred parent-child structure

### Do not add yet

- assembly as a replacement for project
- assembly-specific permissions
- revision graph modeling
- official BOM release management
- where-used across projects
- full CAD-native synchronization contracts

## Workspace display recommendation

The minimum useful assembly-aware workspace display inside the current project page is:

- a collapsible tree panel or tree column that groups line items by root assembly
- the existing procurement table preserved as the operational line-item surface
- the existing detail rail reused for whichever node is focused
- clear badges for `assembly`, `subassembly`, `part`, and `document`
- visible handling for standalone parts that do not belong to any assembly
- visible handling for project documents that do not belong to any assembly node

This is deliberately not a separate assembly page. The project page stays primary, and tree context becomes another way to organize the same project content.

## Carry-forward versus new concepts

| Area | Carry forward | New concept required |
|---|---|---|
| container and access | `projects`, `project_jobs`, `project_memberships`, `project_invites` | none for v1 assembly scope |
| file provenance | `job_files`, storage buckets, audit trail | project-level file/document records for loose docs |
| part identity | `parts`, approved requirements, extraction flow | explicit parent-child hierarchy metadata |
| request intent | `requested_service_kinds`, `primary_service_kind`, `assembly_support` bridge | later assembly-scoped service line items |
| workspace shell | current project route, table, detail rail, bulk actions | tree outline, tree filters, hierarchy badges |
| review workflow | current part review and quote flow | hierarchy confidence / confirmation review |

## Decisions this spike makes

- Project remains the commercial container.
- Assembly-aware behavior should be implemented as a hierarchy layer inside a project.
- Current part reconciliation should remain the part-pairing primitive, not the assembly model.
- Assembly tree display should live inside the current project workspace, not in a separate top-level information architecture.
- Loose project documents require an explicit concept beyond today's job-scoped file table.

## Decisions this spike does not make

- final SQL schema names
- final parser or CAD adapter behavior
- full assembly BOM import rules
- revision and release workflows
- whether assembly hierarchy is inferred only, imported only, or hybrid in the long term

## Suggested follow-on issue sequence

1. Add a project-scoped document concept for loose BOMs and supporting files that should not become parts.
2. Define the minimum persisted hierarchy metadata for assembly nodes and edges.
3. Add a read-only tree view to the project workspace that groups existing parts under inferred or manually confirmed assembly nodes.
4. Add review affordances for confirming or correcting parent-child relationships.
5. Only after the above, consider assembly-scoped service line items or review states.

## Non-goals for the first assembly implementation

The first implementation should explicitly avoid:

- PDM replacement behavior
- full revision lineage
- official release packages
- cross-project relationship graphs
- assembly-native quote orchestration that bypasses part-level review

The first useful milestone is simpler: show how an uploaded assembly package fits inside a project and how its child parts can be grouped without breaking the current quote workflow.
