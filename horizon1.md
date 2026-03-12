# Horizon 1 — Strengthen the Current Web Platform

Last updated: March 11, 2026

## Purpose

This horizon focuses on making the current web application more coherent, useful, and execution-ready without yet expanding into native apps, CAD plugins, or a full PDM system.

## Goal

Turn the existing quote workflow into a more complete, user-legible, and high-signal manufacturing workspace inside the browser.

## Themes

### 1. Better part workspace
- stronger single-part workspace layout
- adjacent CAD and drawing preview surfaces
- denser quote comparison
- clearer review state
- richer metadata editing

### 2. Better project workspace
- dense multi-line-item table
- right-side detail drawer
- better project-level selection and review
- better assembly/project grouping behavior

### 3. Stronger quote decision UX
- scatter chart plus ranked list
- presets such as cheapest, fastest, domestic
- due-date-aware filtering
- vendor exclusion controls
- clearer selection persistence

### 4. Better review-to-order handoff
- dedicated review routes
- selected quote summaries
- pre-checkout review state
- placeholder handoff for payment, PO, shipping, and billing information

### 5. Notifications groundwork
- browser notifications
- quote-ready events
- review-needed events
- vendor-response events
- shipment-status groundwork

### 6. Better operational visibility
- activity log improvements
- workflow-state clarity
- extraction warnings surfaced clearly
- failure states made explicit

## Candidate epics

### Epic: part workspace v2
- rebuild the part content region around CAD, drawing, quote, and review surfaces
- improve empty states
- improve request-edit flow
- improve revision-upload continuity on a line item

### Epic: project workspace v2
- dense project table
- detail rail
- batch quote workspace fetching
- project-level totals and summary strip
- bulk preset actions

### Epic: review route and order handoff
- stable part review route
- stable project review route
- selected summary and procurement context
- placeholder shipping / billing / PO fields

### Epic: quote decision improvements
- better option normalization
- clearer ranking rules
- better domestic/foreign handling
- richer due-date-aware selection logic

### Epic: browser notification foundation
- event taxonomy
- opt-in notification settings
- initial notification triggers
- notification state persistence

## Out of scope for this horizon

- native Windows app
- native macOS app
- mobile apps
- CAD plugins
- full revision graph / PDM
- direct order placement backend
- full fulfillment automation
