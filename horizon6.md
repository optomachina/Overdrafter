# Horizon 6 — Move Toward Autonomous Manufacturing Orchestration

Last updated: March 11, 2026

## Purpose

This horizon describes the long-range direction in which OverDrafter automates more of the manufacturing workflow while preserving operator control, reviewability, and auditability.

## Goal

Move from a tool that assists manufacturing workflows to a system that can proactively coordinate much of the workflow on the user’s behalf.

## Themes

### 1. Automated manufacturability screening
- detect common DFM issues
- detect missing information
- flag likely quoting blockers
- recommend corrective actions

### 2. Automated sourcing assistance
- identify viable vendors
- rank likely good-fit suppliers
- predict cost and lead-time ranges
- suggest best options by user intent

### 3. Assisted package curation
- recommend cheapest / fastest / domestic options
- explain tradeoffs
- surface anomalies and confidence

### 4. Assisted order execution
- carry forward approved selections
- prepare purchasing handoff
- coordinate status updates and delivery tracking

### 5. Human-in-the-loop control
- explicit review checkpoints
- clear failure visibility
- audit logs for automated actions
- override mechanisms

## Candidate epics

### Epic: automated DFM assistant
- rule-based issue detection
- confidence scoring
- review UI

### Epic: vendor recommendation engine
- vendor capability model
- ranking signals
- fit scoring

### Epic: cost and lead-time prediction
- estimate ranges before vendor response
- compare predicted vs actual outcomes

### Epic: orchestration assistant
- recommend next actions
- drive queued workflow steps
- summarize blockers and changes

## Out of scope for this horizon

- fully unsupervised procurement
- invisible autonomous decision-making without auditability
- replacing human approval for high-impact actions
