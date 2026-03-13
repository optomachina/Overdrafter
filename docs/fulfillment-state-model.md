# Fulfillment State Model

Last updated: March 13, 2026

## Purpose

This document defines the downstream fulfillment-aware state taxonomy for OverDrafter after quote selection.

It exists because the product direction includes post-selection review, procurement handoff, and later shipment visibility, while the current implementation intentionally stops short of direct ordering or fulfillment execution.

Use this document when:

- planning downstream lifecycle work after quote selection
- deciding whether a future status is a visibility state or an execution surface
- scoping follow-on schema, UI, or audit work for procurement and shipment visibility
- preventing roadmap drift into unsupported ordering, billing, or shipping ownership

## Current transition model

The active product surface already establishes the entry point to this lifecycle:

- `src/pages/ClientPartReview.tsx` captures selected-quote review plus shipping, billing, and PO handoff details for a single line item
- `src/pages/ClientProjectReview.tsx` captures the same procurement handoff model at the project level
- both routes explicitly stop before payment collection, direct order placement, or fulfillment execution
- `docs/review-page.md` documents those routes as a review layer before manual release coordination

This means the current system already models a pre-procurement review stage, even though later downstream statuses are not yet first-class product states.

## Canonical downstream lifecycle

Entry condition: a client or internal operator has finalized quote selection for a part or project and is moving into release coordination.

| State | Meaning | Near-term treatment |
|---|---|---|
| review / procurement handoff | Final confirmation of the selected quote plus shipping, billing, and PO handoff details before external procurement follow-up | Active foundation now through the review routes and procurement handoff model |
| approved | The handoff package is complete and ready for manual procurement release or internal release coordination | First non-placeholder follow-on state once review-route and metadata maturity are sufficient; does not mean an order was placed |
| ordered | External procurement has placed or confirmed the order with the supplier | Placeholder-only visibility state at first; any update is manual or imported, not executed by OverDrafter |
| in production | The supplier has acknowledged or started production | Placeholder-only visibility state |
| inspecting | The ordered work is in inspection, QA, or release verification | Placeholder-only visibility state |
| shipped | Shipment has been released or is in transit | Placeholder-only visibility state |
| delivered | Delivery or receiving confirmation is complete | Placeholder-only visibility state |

## Modeling rules

### 1. States are for visibility first, not fulfillment ownership

Downstream states should tell clients and internal teams where work stands after selection. They should not by themselves create new product responsibility for external execution.

### 2. A state transition must not imply unsupported actions

Moving into `approved`, `ordered`, or `shipped` must not imply that OverDrafter:

- issued a purchase order
- collected payment
- booked freight
- updated an ERP
- contacted a supplier automatically

Those behaviors require separate product decisions and separate implementation work.

### 3. Placeholder states may start as manual or externally confirmed updates

If `ordered` or later states appear before direct integrations exist, treat them as:

- manual internal updates
- imported status confirmations
- audit-backed visibility markers

Do not frame them as native execution features.

### 4. The model must support both part-level and project-level rollups

The same state vocabulary should work for:

- a single selected part
- a project containing multiple selected line items
- future project summaries that need a downstream status strip or rollup

Project rollups may need derived summaries, but they should not invent a different lifecycle vocabulary.

### 5. Downstream fulfillment states are distinct from upstream quote and engineering states

These statuses begin after quote selection. They should not be overloaded to represent:

- extraction approval
- DFM / DFA review outcomes
- quote-run readiness
- vendor comparison status

Those remain separate workflow concerns.

## Near-term planning boundary

The near-term backlog should stay focused on:

- maturing the review and procurement handoff foundation
- clarifying what makes a handoff package `approved`
- defining auditability and visibility for downstream states without claiming execution ownership

The near-term backlog should not require:

- PO submission
- payment capture
- billing-service integration
- shipping-carrier integration
- supplier portal automation
- ERP or CRM synchronization

`ordered` and later states should remain placeholder-only until review handoff and metadata work are mature enough to support coherent status semantics.

This should remain an epic-level planning surface until the review handoff workflow and downstream metadata boundary are ready to support smaller implementation issues cleanly.

## Suggested sequencing for follow-on work

1. Mature the review-route handoff data model and release-readiness rules.
2. Define the persisted `approved` boundary and related audit events.
3. Add downstream status display and rollup affordances using manual or externally confirmed visibility updates.
4. Evaluate fulfillment-system integrations only as separate follow-on work, not as part of the state-model epic itself.
