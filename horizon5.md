# Horizon 5 — Add CAD-Native Plugins and Direct Submission Flows

Last updated: March 11, 2026

## Purpose

This horizon reduces the gap between CAD authoring tools and OverDrafter by meeting users inside their design environment.

## Goal

Enable engineers to submit, revise, and synchronize design packages directly from CAD tools rather than relying only on manual browser upload.

## Themes

### 1. Direct upload from CAD
- part upload
- assembly upload
- linked drawing upload
- metadata push
- one-click RFQ

### 2. Revision-aware sync
- submit new version
- create revision from CAD
- map local files to OverDrafter entities
- detect changed references

### 3. CAD-context actions
- upload to OverDrafter
- create RFQ
- sync drawing
- compare revision
- open related workspace

### 4. Supported integrations
Initial targets may include:

- SOLIDWORKS
- Fusion 360
- Inventor
- Onshape
- Solid Edge
- NX
- Creo

## Candidate epics

### Epic: plugin contract
- define plugin API and auth flow
- define upload payloads
- define file and revision sync contract

### Epic: SOLIDWORKS plugin
- upload current part/assembly
- attach drawing
- open related workspace
- create RFQ

### Epic: revision sync flow
- plugin-side version detection
- create new version or revision
- show sync result

### Epic: assembly submission flow
- upload full tree
- preserve relationships
- handle missing references

## Out of scope for this horizon

- full CAD PDM replacement inside plugin on day one
- plugin support for every CAD platform immediately
- deep geometry diff for every native format
