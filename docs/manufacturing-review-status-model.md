# Manufacturing Review Status Model

Last updated: March 13, 2026

## Purpose

This document defines the future internal-only status model for deeper manufacturing review in OverDrafter.

It covers:

- DFM review state
- DFA review state
- manufacturability blockers
- compliance placeholders
- engineering checkpoints

It exists so future implementation work has a stable product target before schema, metadata, and revision-control work make the feature buildable.

This is an epic/design document, not a statement that the current product already supports these review states.

## Why this model exists

The current product has an explicit quote review path, but it does not yet have a structured way to represent deeper engineering review.

Today:

- `manufacturing_quote` remains the default workflow
- `src/pages/InternalJobDetail.tsx` shows quote review and readiness surfaces
- vendor findings such as DFM notes may appear as quote detail, but they are not a canonical review-state model

Future manufacturing review should therefore be modeled alongside quote work, not improvised inside freeform notes or overloaded onto current quote readiness.

## Design rules

### 1. Review state is not the same thing as quote state

Manufacturing review must not reuse current quote workflow states such as extraction readiness, approved requirements, quote-run readiness, or package publication status.

Those workflows answer:

- can we run quotes
- can we publish a package

Manufacturing review answers different questions:

- has DFM been reviewed
- has DFA been reviewed
- are there open blockers
- are the required engineering checkpoints complete

### 2. Review state attaches to future service line items

The canonical attachment point is the future service request line item described in `docs/service-request-taxonomy.md`, not:

- the project as a single overloaded blob
- the part record as an intrinsic property
- the current approved manufacturing requirement snapshot

This lets one part or project carry multiple independently trackable requests such as:

- `manufacturing_quote`
- `dfm_review`
- `drawing_redraft`
- `dfa_review`

### 3. Status needs three layers

The product should model:

1. the workflow state of the review request
2. the outcome state of each review dimension
3. the resolution state of each blocker or checkpoint

Trying to collapse those into one field would make the system ambiguous.

### 4. Current quote behavior stays valid during the transition

The existing quoting path should continue to work even if no manufacturing review model has been implemented yet.

`manufacturing_quote` requests do not implicitly require DFM or DFA approval in the current product. Future gating must be explicit and service-aware.

## Canonical future model

### Review request workflow state

Every future engineering-review service line item should carry one workflow state:

| State | Meaning |
|---|---|
| `needs_input` | Required files, metadata, scope, or release context are missing. Review cannot start. |
| `ready_for_review` | Required inputs are present and the request can enter the engineering queue. |
| `in_review` | An internal reviewer is actively assessing the request. |
| `changes_requested` | Review produced findings that require design, package, or metadata changes before approval. |
| `blocked` | Review cannot advance because of an external dependency or unresolved blocker. |
| `approved` | Review is complete for the current request snapshot and has no open blocking findings. |
| `waived` | Review was intentionally skipped or closed with an explicit rationale and approver. |

Notes:

- `not_requested` should remain a derived state when no review line item exists.
- `approved` means approved for the current snapshot, not approved for all future revisions.

### Review dimensions

One review request may expose several dimension states. The minimum future dimensions are:

- `dfm`
- `dfa`
- `compliance`
- `engineering_release`

Each dimension should use the same outcome vocabulary:

| State | Meaning |
|---|---|
| `not_reviewed` | No explicit assessment has been completed yet. |
| `pass` | Acceptable for the current service scope and release target. |
| `attention_needed` | Concerns exist and require follow-up, but they are not currently blocking completion. |
| `blocked` | A blocking issue prevents approval or downstream progression. |
| `not_applicable` | This dimension does not apply to the request scope. |

Interpretation notes:

- DFM is usually meaningful for part- or assembly-scoped manufacturability work.
- DFA is usually meaningful for assembly- or project-scoped work and should not be forced onto single-part quote-only flows.
- `compliance` is a placeholder dimension until richer certification and release metadata exists.
- `engineering_release` represents internal package readiness checkpoints, not full revision control.

### Manufacturability blocker records

Blockers should be first-class records, not only a summary string on the review request.

Each blocker should eventually support:

- title
- description
- severity
- owner
- due target
- related dimension such as `dfm` or `compliance`
- status

Canonical blocker statuses:

| State | Meaning |
|---|---|
| `open` | Active blocker with no accepted resolution yet. |
| `mitigated` | Mitigation exists and the blocker is no longer active for the current snapshot. |
| `accepted_risk` | The issue remains known but was intentionally accepted with approval. |
| `closed` | The underlying issue is resolved and no longer relevant. |

### Engineering checkpoints

Checkpoints are lightweight review gates that explain why a review request is or is not ready to progress.

Each checkpoint should use:

| State | Meaning |
|---|---|
| `pending` | Required but not yet completed. |
| `complete` | Completed for the current snapshot. |
| `blocked` | Cannot complete because a dependency is unresolved. |
| `waived` | Explicitly skipped with rationale. |
| `not_required` | Not needed for this request scope. |

Default future checkpoint families:

- package completeness
- manufacturing context captured
- DFM assessed
- DFA assessed when applicable
- compliance scoped
- quote-ready handoff

## Relation to current request and quote workflows

The intended relationship is:

- current requests continue to map to an implicit `manufacturing_quote` line item
- quote quantities, due dates, vendor comparison, and publication remain quote-specific workflows
- manufacturing review states become additional internal-only service state, not a replacement for quote status

The system should not:

- infer `dfm` or `dfa` approval from a successful quote run
- treat `approved_part_requirements` as the same thing as engineering review approval
- expose future internal review blockers directly in current client-safe request summaries by default

The system may later:

- show internal badges that quote work is `ready_for_review`, `blocked`, or `approved`
- require selected checkpoints before specific service types can move downstream
- summarize open review blockers next to quote readiness without merging the two concepts

## Horizon 2 scope versus later revision-control scope

### Horizon 2 product target

Horizon 2 should define and eventually implement:

- the canonical vocabulary in this document
- service-line-item attachment for review states
- internal-only review summary cards, badges, and checkpoint strips
- blocker capture and disposition for the current request snapshot
- explicit separation between quote workflow state and manufacturing review state

### Not part of Horizon 2

Horizon 2 should not take on full revision-control behaviors such as:

- immutable revision history for review findings
- formal release baselines across multiple revisions
- automatic carry-forward or supersession of approvals between revisions
- diff-aware reopening of review when CAD or drawing revisions change
- cross-revision traceability and comparison

Those capabilities belong with later PDM and revision-control work.

## Suggested epic decomposition

When the metadata and service-taxonomy prerequisites are ready, split implementation into epics like:

1. service-line-item status foundation
2. blocker and checkpoint data model
3. internal workspace review summary surfaces
4. quote-review interoperability rules
5. revision-aware review history integration

The first four belong to Horizon 2. The fifth belongs to later revision-control work.

## Immediate dependency rule

Do not treat this document as authorization to implement manufacturing review states immediately.

Implementation should wait until these foundations are stronger:

- richer RFQ metadata
- service request line items
- clearer scope handling for part, assembly, and project services

Until then, this document is the canonical design target for future DFM, DFA, and engineering-review backlog work.
