# Horizon 2 — Expand Manufacturing Workspace Capabilities

Last updated: March 13, 2026

## Purpose

This horizon expands OverDrafter from a quoting portal into a broader manufacturing workspace that can represent more types of work and more operational states.

## Goal

Support not just “quote this part,” but “help move this design package through the work needed to become manufacturable and purchasable.”

## Themes

### 1. Service selection model
Support the canonical service taxonomy defined in `docs/service-request-taxonomy.md`, including:

- modeling / remodeling
- drafting / redrafting
- FEA
- DFM
- DFA
- assembly support
- sourcing-only workflows

For next-phase implementation work, use the canonical service codes from that doc rather than creating new top-level request types ad hoc.

### 2. Richer RFQ metadata
- quantity sets
- due dates
- shipping constraints
- certification requirements
- domestic / foreign preferences
- finish, tolerance, and inspection expectations
- revision and release status

### 3. Assembly-aware workflows
- recognize assemblies as first-class upload entities
- parse part relationships
- surface assembly tree context
- identify child-part dependencies

### 4. Deeper manufacturing review
- DFM status
- DFA status
- manufacturability blockers
- compliance/certification placeholders
- engineering-review checkpoints

### 5. Fulfillment-aware states
- treat the post-selection lifecycle as `review / procurement handoff -> approved -> ordered -> in production -> inspecting -> shipped -> delivered`
- use those states for visibility and workflow modeling rather than as proof that OverDrafter executed the order or fulfillment step
- keep `ordered` and later states placeholder-only until review handoff and supporting metadata are mature enough to support coherent status transitions

## Candidate epics

### Epic: service request taxonomy
- formalize service types
- update schema and UI surfaces
- support mixed-service projects

### Epic: richer project metadata
- add RFQ-level fields
- add line-item-level fields
- persist review-relevant metadata safely

### Epic: assembly workspace foundation
- assembly uploads
- assembly tree display
- parent-child file grouping
- assembly-scoped request summaries

### Epic: review status model
- explicit DFM / DFA fields
- review pass / fail / needs attention states
- review summary components

### Epic: fulfillment state model
- downstream state taxonomy
- visible status strip and project/part rollups
- audit events for transitions
- manual or externally confirmed downstream updates before direct integrations exist
- explicit separation between state visibility and unsupported ordering, payment, shipping, or billing ownership

This epic should remain planning-level until the review-route and metadata foundation are mature enough to support a coherent `approved` boundary.

## Out of scope for this horizon

- full CAD-aware revision control
- native apps
- deep CAD plugin sync
- autonomous ordering
