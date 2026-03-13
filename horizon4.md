# Horizon 4 — Add Cross-Platform Clients and Notifications

Last updated: March 11, 2026

## Purpose

This horizon extends OverDrafter beyond the browser and makes the platform more usable in real operational environments across devices.

## Goal

Allow users to review, monitor, approve, and coordinate work across browser, desktop, and mobile surfaces.

## Themes

### 1. Browser notifications
- quote ready
- review needed
- vendor question
- order status change
- shipment update

### 2. Desktop clients
- Windows app
- macOS app
- stronger file upload flows
- local sync and caching groundwork

### 3. Mobile clients
- iPhone app
- Android app
- review and approval surfaces
- status visibility
- quote and order monitoring

### 4. Shared design language across surfaces
- common navigation primitives
- shared workflow states
- surface-specific density decisions

## Candidate epics

### Epic: web notification system
- notification triggers
- browser permission flow
- notification center UI
- seen/unseen state

The cross-surface notification taxonomy for browser, center, desktop, and mobile reuse now lives in `docs/notification-taxonomy.md`.

### Epic: desktop shell
- package the web experience for desktop
- support system notifications
- support better file handling

### Epic: mobile review app
- quote review
- project status
- revision awareness
- shipment visibility

### Epic: session and sync continuity
- notification routing
- device session continuity
- preference synchronization

## Out of scope for this horizon

- full native modeling capability
- deep local PDM vault sync
- CAD authoring inside mobile or desktop clients
