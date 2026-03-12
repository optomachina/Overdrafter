# OverDrafter Capability Map

Last updated: March 11, 2026

## Purpose

This document classifies OverDrafter capabilities by planning horizon so future work can be turned into coherent epics and issue cards without mixing present-state product behavior with later-stage platform ambitions.

## Classification legend

- **Now**: already present, partially present, or directly adjacent to the current product
- **Next**: logical near-term expansion after current hardening and current workspace improvements
- **Later**: meaningful future work that depends on stronger foundations
- **Eventually**: long-range capability, not appropriate for immediate execution planning

## Capability map

| Capability | Classification | Notes |
|---|---|---|
| client part upload | Now | core product capability |
| project grouping | Now | already present in current product shape |
| client/internal role separation | Now | foundational and already modeled |
| quote comparison | Now | core current workflow |
| published package review | Now | current product capability |
| worker-based async processing | Now | core implementation foundation |
| part workspace redesign | Next | direct continuation of current work |
| project workspace redesign | Next | direct continuation of current work |
| quote preset selection | Next | directly adjacent to existing compare flow |
| review routes before checkout | Next | already conceptually defined |
| browser notifications | Next | useful extension of current web product |
| richer RFQ metadata | Next | directly supports better quoting and review |
| service request taxonomy | Next | adjacent product expansion |
| assembly-aware project workflow | Later | depends on stronger data model and UI |
| DFM / DFA status model | Later | depends on richer review workflow |
| fulfillment state tracking | Later | downstream expansion after selection/review path matures |
| immutable version history | Later | start of PDM foundation |
| official revisions | Later | part of PDM foundation |
| part/assembly relationship graph | Later | depends on stronger revision model |
| revision comparison | Later | depends on version graph |
| Windows app | Later | after web flows are stable |
| macOS app | Later | after web flows are stable |
| iPhone app | Later | after mobile review use cases are defined |
| Android app | Later | after mobile review use cases are defined |
| SOLIDWORKS plugin | Later | high-value integration, but depends on stronger domain model |
| Fusion / Inventor / Onshape plugins | Eventually | after first plugin contract proves out |
| full PDM replacement of SOLIDWORKS PDM | Eventually | strategic ambition, not near-term scope |
| GrabCAD Workbench-style collaboration replacement | Eventually | strategic direction, not immediate execution |
| automated DFM assistant | Eventually | requires capability and data maturity |
| vendor recommendation engine | Eventually | requires historical data and ranking logic |
| autonomous orchestration | Eventually | requires strong auditability and control surfaces |

## Suggested theme groups

### Current web product
- intake
- workspace navigation
- part/project workspaces
- quote comparison
- review handoff

### Manufacturing workspace expansion
- service requests
- richer metadata
- assembly context
- review states
- fulfillment states

### PDM and revision control
- versions
- revisions
- file provenance
- relationships
- compare and audit

### Cross-platform access
- browser notifications
- desktop clients
- mobile clients

### CAD-native integrations
- plugin contract
- direct upload
- revision-aware sync
- CAD-context actions

### Autonomous orchestration
- DFM automation
- vendor recommendation
- cost prediction
- assisted workflow progression

## How to use this map

Use this map when:

- deciding whether an idea belongs in current execution or future roadmap
- grouping future roadmap work into epics
- deciding whether a capability should generate Linear cards yet
- checking whether a proposed implementation is premature

## Rule for issue creation

Create active implementation cards only for capabilities classified as:

- Now
- Next

Create research, spike, or architecture notes for selected Later items only when they unblock a Now or Next capability.

Do not create normal implementation backlog for Eventually-classified capabilities unless product direction changes materially.
