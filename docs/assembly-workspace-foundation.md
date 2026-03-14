# Assembly-Aware Workspace Foundation

Last updated: March 13, 2026

## Purpose

This document is the single planning home for assembly-aware workspace work in OverDrafter.

Use it when:

- defining future assembly uploads, tree views, or dependency displays
- checking whether an assembly-related issue belongs in Horizon 2 workspace planning or Horizon 3 PDM foundations
- creating follow-on Linear issues so they preserve the project-first product model

## Core rule

`Project` remains the top-level commercial, customer-facing, and collaboration container.

`Assembly` is a technical structure that exists inside a project. It can represent a parent-child mechanical hierarchy, but it must not replace project-first intake, navigation, sharing, or quote workflow boundaries.

## Why this planning theme exists

The repo already documents all of the following:

- projects can contain multiple assemblies, standalone parts, and supporting documents
- assembly-aware workflows are part of the long-range direction
- revision-heavy relationship modeling belongs to a later PDM-focused horizon

What this theme adds is a clear backlog boundary: assembly-aware workspace work should have one parent narrative that preserves the project container rule before deeper relationship or revision work begins.

## Product-model constraints

Future assembly-aware workspace issues must preserve these constraints:

1. A project may contain zero, one, or many assemblies.
2. A project may also contain standalone parts that do not belong to any assembly.
3. Supporting documents remain project-scoped assets and must not require assembly membership.
4. Assembly views are project-scoped context, not a replacement for the project workspace.
5. Future assembly entities may hold parent-child structure, but project membership remains the primary workflow boundary.
6. Service requests may later target an assembly, but projects still act as grouping and rollup containers.
7. Dependency display in this theme is limited to project-scoped structure and workflow context, not full revision impact or cross-project where-used analysis.

## Workspace implications

Assembly-aware workspace planning should assume:

- project creation still happens before the system knows whether uploaded content contains assemblies, standalone parts, or both
- assembly uploads attach to an existing or newly created project rather than creating a separate top-level container
- project workspace remains the umbrella surface for mixed-content requests
- assembly tree views should appear as project-scoped panels, sections, tabs, or detail views
- standalone parts must remain visible in the same project workspace even when assembly trees exist
- part workspace can inherit assembly context, but it should still represent an individual part-focused surface

## Explicitly out of scope

This theme should not absorb:

- immutable version graph work
- official revision lifecycle design
- cross-project relationship graphs
- CAD plugin sync semantics
- release-state or PDM compare workflows

Those belong in Horizon 3 or later horizons after the workspace-level assembly model is clear.

## Backlog sequencing

Use this sequence for future issue work:

1. Preserve the container rule established by `OVD-20`.
2. Keep assembly-aware workspace planning under `OVD-39`.
3. Hang project-scoped assembly exploration issues such as uploads, tree views, and dependency context under `OVD-39`.
4. Move deeper relationship, version, and revision modeling to Horizon 3 issues such as `OVD-45` and `OVD-47`.
5. Let CAD-native assembly submission work depend on the workspace foundation instead of redefining it.

## Issue placement guide

Create or attach issues under this theme when the work is about:

- assembly uploads inside projects
- project-scoped tree views
- mixed project views that include assemblies and standalone parts
- project-scoped dependency visibility
- assembly-aware request summaries for workspace surfaces

Do not place an issue under this theme when the primary problem is:

- version history
- revision semantics
- released versus draft control
- cross-project where-used analysis
- plugin transport contracts

## Repo grounding

This theme is grounded by:

- `PRD.md`
- `ARCHITECTURE.md`
- `horizon2.md`
- `horizon3.md`
- `capabilitymap.md`
- `docs/project-workspace.md`
- `docs/part-workspace.md`
- `docs/service-request-taxonomy.md`
