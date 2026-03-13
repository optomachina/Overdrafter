# Service Request Taxonomy

Last updated: March 13, 2026

## Purpose

This document defines the next-phase service request taxonomy for OverDrafter and how those service types should relate to projects, parts, and request line items.

It exists because the current implementation is still centered on a quote-shaped request model, while the intended product direction already includes broader engineering and sourcing workflows.

Use this document when:

- planning follow-on schema or UI work for service expansion
- deciding whether a field belongs to a project, a part, or a request line item
- preserving current quote workflows while introducing mixed-service projects

## Current transition model

The active intake and review surfaces now capture a transitional service-intent bridge:

- `src/features/quotes/request-intake.ts` parses canonical service kinds in addition to quote quantities and requested date
- `src/features/quotes/types.ts` carries `requestedServiceKinds`, `primaryServiceKind`, and `serviceNotes` through the current client-safe request edit path
- `src/components/quotes/ClientPartRequestEditor.tsx` and `src/pages/InternalJobDetail.tsx` expose the same service-aware fields while keeping quote-specific inputs conditional
- `jobs.requested_service_kinds`, `jobs.primary_service_kind`, and `jobs.service_notes` preserve draft-stage intent until an approved requirement snapshot exists
- `approved_part_requirements.spec_snapshot` mirrors the same service intent for internal review and downstream summaries

This is intentionally a bridge rather than the final line-item model.

## Canonical service types

The next phase should support these canonical service types:

| Service type | Code | Default scope | Primary outcome |
|---|---|---|---|
| Manufacturing quote | `manufacturing_quote` | part | A manufacturable part request that should produce vendor quotes or curated quote options |
| CAD modeling | `cad_modeling` | part | Create or remodel a usable 3D part model from incomplete design inputs |
| Drawing redraft | `drawing_redraft` | part | Create, clean up, or reissue a manufacturing drawing or release package |
| FEA analysis | `fea_analysis` | part or assembly | Produce an engineering analysis result tied to a design package |
| DFM review | `dfm_review` | part or assembly | Produce manufacturability findings, risks, and recommended design changes |
| DFA review | `dfa_review` | assembly or project | Produce assembly-focused findings and recommended design or process changes |
| Assembly support | `assembly_support` | assembly or project | Coordinate work across multiple parts, BOM context, fit/sequence review, or assembly package support |
| Sourcing only | `sourcing_only` | part or project | Obtain supplier options or procurement support without implying an engineering deliverable |

### Intentional consolidations

The taxonomy intentionally collapses a few wording variants that should not become separate product concepts:

- modeling and remodeling are both represented as `cad_modeling`
- drafting and redrafting are both represented as `drawing_redraft`

Those distinctions may matter in service detail fields or operational notes, but not in the top-level taxonomy.

## Modeling rules

### 1. The request line item is the authoritative unit of work

Projects and parts should not be the only place where requested services live. The authoritative record should be a service request line item with:

- `serviceType`
- `scope`
- `projectId`
- optional `jobId` or `partId`
- future optional `assemblyId` when assembly entities exist
- scheduling fields
- status fields
- service-specific detail payload

This prevents the project or part record from becoming an overloaded bucket of unrelated request fields.

### 2. Projects are containers and rollups, not the sole source of truth

Projects should:

- group related request line items
- provide collaboration and visibility boundaries
- carry derived service summaries for filtering and workspace display
- optionally store project-level defaults that new line items can inherit

Projects should not be the only place where service intent is stored, because mixed-service projects need multiple independently trackable requests.

### 3. Parts keep technical identity; services describe requested work on those parts

Part-scoped data should continue to hold the technical identity of a manufacturable item:

- files
- part number
- revision
- description
- approved manufacturing requirements

Service line items may target a part, but service type should not be treated as an intrinsic property of the part itself. A single part can reasonably need:

- `dfm_review`
- `drawing_redraft`
- `manufacturing_quote`

across the same project or across multiple revisions.

### 4. Service details belong to the service that needs them

Quote-specific fields are not universal request metadata. The model should treat them as service-specific details:

- `quantity`
- `requestedQuoteQuantities`
- vendor selection intent
- pricing and lead-time comparison context

Likewise, engineering-review outputs such as findings, recommendations, or analysis artifacts belong to the relevant service line item rather than to a generic project request blob.

### 5. Mixed-service projects are represented as multiple line items, not one overloaded request

Mixed-service projects should be modeled as a set of line items under one project, for example:

- Part A: `dfm_review`
- Part A: `manufacturing_quote`
- Part B: `drawing_redraft`
- Project-level: `assembly_support`
- Project-level: `sourcing_only`

If sequencing matters, represent that through status and dependency metadata between line items rather than by inventing hybrid service types.

## Mixed-service representation rules

Use these rules for next-phase implementation work:

1. A project can have many service line items.
2. A part can have many service line items.
3. One line item has exactly one canonical `serviceType`.
4. Project-level or assembly-level services are allowed when the deliverable spans multiple parts.
5. The project workspace shows a derived summary of present service types, but editing still occurs on individual line items.
6. Current quote flows remain valid by treating the existing request as a default `manufacturing_quote` line item.

## Reuse versus replace from the current request shape

| Current shape or field | Decision | Reason |
|---|---|---|
| project -> jobs -> part grouping | Reuse | It already provides a practical container hierarchy for project and part workflows |
| uploaded files and revision-aware part identity | Reuse | Those concepts apply to both quote and engineering-service work |
| `description`, `partNumber`, `revision`, `notes` | Reuse | These remain useful across nearly every request type |
| `material`, `finish`, `tightestToleranceInch`, `process` | Reuse as part/manufacturing context | They are useful for manufacturing-oriented services but should not become required universal service fields |
| `requestedByDate` | Reuse the concept, move to line-item scheduling | Scheduling is general, but it should attach to the specific requested service rather than only to the job summary |
| `quantity` and `requestedQuoteQuantities` | Keep only for quote-compatible services | These are meaningful for `manufacturing_quote` and some `sourcing_only` cases, not for every service type |
| approved requirement records | Reuse for manufacturing-approved specs only | They should not be overloaded to represent engineering review deliverables or analysis outputs |
| quote-oriented shared project summary helpers | Replace with service-aware summaries | Mixed-service projects need derived badges and filters beyond shared quote quantities/date |
| `request-intake.ts` quantity/date parsing as the only request intelligence | Replace with service-aware intake parsing | Intake should first identify requested service types, then parse service-specific details |

## Compatibility rule for current quote workflows

The existing curated quote workflow should continue to function during the transition:

- every current request maps to one implicit `manufacturing_quote` line item
- current quote summary badges remain valid when the selected work is quote-compatible
- project-level shared request summaries should only show quote quantities and requested date when every selected line item is compatible with that summary

This allows service expansion without breaking the current client project and client part workflows.

## Transitional implementation note

Until dedicated service request line items exist, the existing part request edit flow may carry multiple requested service kinds on one request envelope:

- treat `requestedServiceKinds` plus `primaryServiceKind` as a capture bridge, not the final source-of-truth model
- preserve `manufacturing_quote` as the default when no explicit service signal exists
- hide quote-only inputs when the selected services are not quote-compatible
- keep `serviceNotes` scoped to intent clarification, not as a substitute for future status or dependency modeling

## Follow-on implementation targets

This taxonomy should drive follow-on implementation issues in this order:

1. Introduce a service-aware request line item model in schema and TypeScript types.
2. Add project and workspace summary affordances that roll up service types without flattening them into one request blob.
3. Expand intake to capture or infer service type before quote-specific parsing runs.
4. Split quote-specific editors from broader service request editors while preserving the current manufacturing quote path as the default.
