# Horizon 4 — Add Cross-Platform Clients and Notifications

Last updated: July 28, 2026

> **Planning status:** Incubator source material. `ROADMAP.md` and `PLAN.md`
> supersede this file for commitment and sequencing.

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
- website-mediated system-browser authentication
- quote-action Inbox
- parts and quote review
- contextual project/search access
- status visibility and quote monitoring
- capability-gated read-only Ask OverDrafter

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
- first web target: the `Notifications` panel inside the existing workspace account menu
- first preference model: per-notification-type `in_app` and `browser` toggles
- temporary continuity rule: seen state may live in browser-local storage until durable notification records exist

The cross-surface notification taxonomy for browser, center, desktop, and mobile reuse now lives in `docs/notification-taxonomy.md`.

### Epic: desktop shell
- package the web experience for desktop
- support system notifications
- support better file handling

### Epic: quoting-first mobile app
- native welcome and secure website-mediated sign-in
- `Inbox | Parts | Quotes | More` shell with a separate Ask action
- unresolved quote decisions and recoverable quote-request failures
- parts, quote comparison, and contextual project/search access
- read-only contextual questions with structured results
- later revision, approval, order, and shipment visibility as their domain
  contracts become real

The browser-auth and shared-web-session boundary is defined in
[`docs/mobile-authentication-contract.md`](docs/mobile-authentication-contract.md).

### Epic: session and sync continuity
- notification routing
- device session continuity
- preference synchronization

## Out of scope for this horizon

- full native modeling capability
- deep local PDM vault sync
- CAD authoring inside mobile or desktop clients
- consequential agent actions without explicit authorization, confirmation,
  idempotency, and audit contracts
- standards-backed answers without content rights and edition-aware citations
