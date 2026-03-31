# Linear Import Report

- Generated: 2026-03-30 22:09 UTC
- Mode: sync
- Live run: yes
- Included deferred sub-backlog items: no
- Team: OVD

## Summary

- Create: 0
- Update: 7
- Skip: 7

## Project Resolution

- Resolved project `Symphony`
- Resolved project `Symphony Sub-Backlog`

## Planned Label Creation

- None

## Item Actions

### Horizon 2 — Expand Manufacturing Workspace Capabilities

- Seed key: `horizon-2-parent`
- Action: `skip`
- Reason: report-only overlap
- Target project: `Symphony`
- Existing issue: `OVD-23` ([open](https://linear.app/blainew/issue/OVD-23/horizon-2-expand-manufacturing-workspace-capabilities))
- State: `Todo`
- Priority / estimate: `P3` / `8`
- Labels: `next`, `product-foundation`, `workspace`, `horizon-2`, `roadmap`, `Feature`, `free-tier`

### Introduce service_request_line_items schema foundation

- Seed key: `service-line-item-schema-foundation`
- Action: `update`
- Reason: existing issue OVD-159
- Target project: `Symphony`
- Existing issue: `OVD-159` ([open](https://linear.app/blainew/issue/OVD-159/introduce-service-request-line-items-schema-foundation))
- Parent: `OVD-23`
- State: `Backlog`
- Priority / estimate: `P2` / `5`
- Labels: `next`, `quotes`, `product-foundation`, `workspace`, `horizon-2`, `Feature`, `free-tier`

### Bridge quote_requests onto manufacturing_quote line items

- Seed key: `quote-request-line-item-bridge`
- Action: `update`
- Reason: existing issue OVD-160
- Target project: `Symphony`
- Existing issue: `OVD-160` ([open](https://linear.app/blainew/issue/OVD-160/bridge-quote-requests-onto-manufacturing-quote-line-items))
- Parent: `OVD-23`
- State: `Backlog`
- Priority / estimate: `P2` / `5`
- Labels: `next`, `quotes`, `product-foundation`, `horizon-2`, `Feature`, `free-tier`
- Dependencies: `blocked-by service-line-item-schema-foundation`

### Add service-aware project and part request rollups

- Seed key: `service-line-item-rollups`
- Action: `update`
- Reason: existing issue OVD-161
- Target project: `Symphony`
- Existing issue: `OVD-161` ([open](https://linear.app/blainew/issue/OVD-161/add-service-aware-project-and-part-request-rollups))
- Parent: `OVD-23`
- State: `Backlog`
- Priority / estimate: `P3` / `3`
- Labels: `next`, `quotes`, `workspace`, `horizon-2`, `Feature`, `free-tier`
- Dependencies: `blocked-by service-line-item-schema-foundation`

### Add vendor capability profile model

- Seed key: `vendor-capability-profile-model`
- Action: `update`
- Reason: existing issue OVD-134
- Target project: `Symphony`
- Existing issue: `OVD-134` ([open](https://linear.app/blainew/issue/OVD-134/add-vendor-capability-profile-model))
- Parent: `OVD-23`
- State: `Backlog`
- Priority / estimate: `P2` / `5`
- Labels: `next`, `quotes`, `product-foundation`, `horizon-2`, `Feature`, `free-tier`

### Seed lasercut vendor records and heuristics

- Seed key: `seed-vendor-records`
- Action: `update`
- Reason: existing issue OVD-135
- Target project: `Symphony`
- Existing issue: `OVD-135` ([open](https://linear.app/blainew/issue/OVD-135/seed-lasercut-vendor-records-and-heuristics))
- Parent: `OVD-23`
- State: `Backlog`
- Priority / estimate: `P3` / `3`
- Labels: `next`, `quotes`, `horizon-2`, `Feature`, `free-tier`
- Dependencies: `blocked-by vendor-capability-profile-model`

### Rank vendors with weighted routing scores

- Seed key: `vendor-routing-scores`
- Action: `update`
- Reason: existing issue OVD-138
- Target project: `Symphony`
- Existing issue: `OVD-138` ([open](https://linear.app/blainew/issue/OVD-138/rank-vendors-with-weighted-routing-scores))
- Parent: `OVD-23`
- State: `Backlog`
- Priority / estimate: `P2` / `5`
- Labels: `next`, `quotes`, `horizon-2`, `Feature`, `free-tier`
- Dependencies: `blocked-by vendor-capability-profile-model`

### Return ranked vendors with tradeoff summary

- Seed key: `vendor-tradeoff-summary`
- Action: `update`
- Reason: existing issue OVD-139
- Target project: `Symphony`
- Existing issue: `OVD-139` ([open](https://linear.app/blainew/issue/OVD-139/return-ranked-vendors-with-tradeoff-summary))
- Parent: `OVD-23`
- State: `Backlog`
- Priority / estimate: `P2` / `3`
- Labels: `next`, `quotes`, `workspace`, `horizon-2`, `Feature`, `free-tier`
- Dependencies: `blocked-by vendor-routing-scores`

### Define quote package model and deterministic adapter layer

- Seed key: `quote-package-parent-overlap`
- Action: `skip`
- Reason: report-only overlap
- Target project: `OverDrafter North Star Implementation`
- Existing issue: `OVD-109` ([open](https://linear.app/blainew/issue/OVD-109/define-quote-package-model-and-deterministic-adapter-layer))
- State: `Backlog`
- Priority / estimate: `P2` / `8`
- Labels: `quotes`, `Feature`, `free-tier`

### Define normalized quote package schema and internal contract

- Seed key: `normalized-quote-package-schema-overlap`
- Action: `skip`
- Reason: report-only overlap
- Target project: `OverDrafter North Star Implementation`
- Existing issue: `OVD-147` ([open](https://linear.app/blainew/issue/OVD-147/define-normalized-quote-package-schema-and-internal-contract))
- State: `Backlog`
- Priority / estimate: `P2` / `5`
- Labels: `quotes`, `Feature`, `free-tier`
- Dependencies: `blocked-by quote-package-parent-overlap`

### Implement first deterministic quote adapter against the normalized package model

- Seed key: `first-deterministic-quote-adapter-overlap`
- Action: `skip`
- Reason: report-only overlap
- Target project: `OverDrafter North Star Implementation`
- Existing issue: `OVD-148` ([open](https://linear.app/blainew/issue/OVD-148/implement-first-deterministic-quote-adapter-against-the-normalized))
- State: `Backlog`
- Priority / estimate: `P2` / `5`
- Labels: `quotes`, `Feature`, `free-tier`
- Dependencies: `blocked-by normalized-quote-package-schema-overlap`

### Define unified vendor and client communication threading

- Seed key: `unified-comms-threading`
- Action: `skip`
- Reason: deferred; excluded from default live import
- Target project: `Symphony Sub-Backlog`
- State: `Backlog`
- Priority / estimate: `P4` / `5`
- Labels: `sub-backlog`, `roadmap-only`, `draft`, `workspace`, `review`, `Feature`, `paid-tier`

### Define multi-vendor checkout and PO split model

- Seed key: `multi-vendor-checkout-po-split`
- Action: `skip`
- Reason: deferred; excluded from default live import
- Target project: `Symphony Sub-Backlog`
- State: `Backlog`
- Priority / estimate: `P4` / `5`
- Labels: `sub-backlog`, `roadmap-only`, `draft`, `quotes`, `review`, `Feature`, `enterprise`

### Define financing integration v1 boundary

- Seed key: `financing-integration-v1`
- Action: `skip`
- Reason: deferred; excluded from default live import
- Target project: `Symphony Sub-Backlog`
- State: `Backlog`
- Priority / estimate: `P4` / `3`
- Labels: `sub-backlog`, `roadmap-only`, `draft`, `Feature`, `paid-tier`
