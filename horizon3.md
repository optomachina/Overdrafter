# Horizon 3 — Introduce Revision Control and PDM Foundations

Last updated: March 11, 2026

## Purpose

This horizon establishes the file lifecycle and revision-management foundation needed for OverDrafter to evolve toward a PDM-class system.

## Goal

Make OverDrafter capable of managing controlled file history, part and assembly relationships, official revisions, and traceable design-package changes.

## Themes

### 1. Immutable file history
- every upload creates a version
- preserve prior versions
- store provenance
- prevent silent destructive replacement

### 2. Official revision workflow
- draft version vs official revision
- revise part from uploaded file
- revision labels
- release status
- current revision pointer

### 3. Part and assembly relationships
- parent-child structure
- assembly membership
- cross-file linkage
- affected-items awareness

### 4. Comparison and auditability
- metadata diff
- file diff groundwork
- geometry-diff placeholders
- audit trail for revision transitions

### 5. Check-in / check-out style workflow
- file lock semantics where needed
- change ownership context
- review / approval gating later

## Candidate epics

### Epic: version graph foundation
- add file version entities
- add revision entities
- connect versions to parts and assemblies
- preserve immutability

### Epic: revision history UI
- revision timeline
- current revision badge
- version detail panel
- upload replacement action

### Epic: part / assembly relationship model
- assembly membership
- part dependency awareness
- revision impact display

### Epic: revision compare
- metadata comparison
- file-level change summary
- change history audit views

### Epic: release-state workflow
- draft
- in review
- released
- superseded

## Out of scope for this horizon

- full feature-tree diff inside proprietary CAD
- deep CAD plugin bidirectional sync
- enterprise approval matrices
