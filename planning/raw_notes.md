# RFQ / Quote / Comparison / Checkout Brain Dump

## Source

- User brainstorm captured in Codex chat on 2026-03-30
- Repo grounding from `PRD.md`, `PLAN.md`, `ARCHITECTURE.md`, `TEST_STRATEGY.md`, `ACCEPTANCE_CRITERIA.md`, `capabilitymap.md`
- Specialized grounding from `docs/service-request-taxonomy.md` and `docs/manufacturing-review-status-model.md`
- Existing Linear backlog scan for overlapping RFQ, quote, routing, and checkout work

## Working conclusion

The repo already has real backlog coverage for several parts of the brainstorm, but it does not yet have a repo-native planning pipeline or a clean import surface. The right move is:

1. preserve the brainstorm in-repo
2. normalize it into a machine-readable seed
3. reconcile that seed against existing Linear issues
4. create only the missing current-scope issues in `Symphony`
5. keep later or current-non-goal items out of default live import

## Current-scope themes that are active now

### Service request line items

- `PLAN.md` names service-request line items as an immediate next step
- `ARCHITECTURE.md` states line items should become the authoritative unit of requested work
- `docs/service-request-taxonomy.md` defines the model but the schema and runtime bridge are not yet represented as execution-ready implementation cards

### Vendor capability and routing

- Multi-vendor fan-out is active Phase 2 work
- Existing backlog already contains:
  - `OVD-134` vendor capability profile model
  - `OVD-135` seed vendor records and heuristics
  - `OVD-138` weighted routing scores
  - `OVD-139` ranked vendor tradeoff summary
- These issues are relevant and should be normalized into the active `Symphony` project instead of duplicated

### Quote package normalization

- Existing North Star backlog already contains:
  - `OVD-109` quote package model and deterministic adapter parent
  - `OVD-147` normalized quote package schema and internal contract
  - `OVD-148` first deterministic quote adapter
- These are valid overlaps, but they already live in `OverDrafter North Star Implementation` and should be reported instead of recreated in `Symphony`

### Quote comparison and procurement handoff

- Quote comparison UI already landed in current backlog (`OVD-76`)
- Structured procurement handoff already landed (`OVD-34`)
- These remain important overlaps from the brainstorm, but they are not new current-scope work

## Existing overlaps that should be reported, not recreated

- `OVD-23` Horizon 2 parent for manufacturing workspace expansion
- `OVD-37` service request taxonomy
- `OVD-38` richer RFQ metadata
- `OVD-40` manufacturing review status model
- `OVD-42` mixed-service request capture
- `OVD-43` richer RFQ metadata in client/internal surfaces
- `OVD-34` procurement handoff state
- `OVD-76` quote chart and list comparison UI
- `OVD-109` quote package parent
- `OVD-147` quote package schema
- `OVD-148` deterministic quote adapter

## Missing current-scope execution cards to create

### Introduce service_request_line_items schema foundation

Need a concrete implementation issue for the schema, types, and compatibility boundary that moves the repo from the documented line-item target to an actual runtime entity.

### Bridge quote request execution onto manufacturing_quote line items

Need a concrete implementation issue for how current `quote_requests`, `quote_runs`, and vendor result records coexist with or mirror the new line-item model during migration.

### Add service-aware project and part summary rollups

Need a concrete implementation issue for derived workspace summaries once line items exist, so project and part surfaces stay usable without flattening services back into quote-only summaries.

## Deferred or non-goal ideas from the brainstorm

These should stay in the seed as draft / roadmap items and must not be part of default live import:

- unified comms threading
- vendor escalation engine
- multi-vendor checkout and PO split
- financing integration v1
- full audit trail and compliance program beyond current documented review-state groundwork
- vendor graph expansion beyond current routing and ranking foundations
- DWG check v1 as a separate deliverable, unless future scope is clarified beyond current extraction reliability and review-status groundwork

## Label strategy

Reuse the current Linear workspace labels first:

- band: `now`, `next`, `later`, `sub-backlog`
- area: `quotes`, `workspace`, `product-foundation`, `review`, `testing`
- horizon: `horizon-1` through `horizon-6`
- type: `Feature`, `Bug`, `Improvement`, `spike`

Only add missing labels if the seed actually uses them:

- `draft`
- `free-tier`
- `paid-tier`
- `enterprise`

## Import policy

- Active current-scope items go to `Symphony`
- Deferred roadmap items default to skip during live import
- If explicitly requested later, deferred items can be routed into `Symphony Sub-Backlog`
- Existing completed issues are never mutated automatically
- Existing open issues can be updated only when the seed explicitly points at them
