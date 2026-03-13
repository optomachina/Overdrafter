# Notification Taxonomy

Last updated: March 13, 2026

## Purpose

This document defines the first durable notification taxonomy for OverDrafter. It is the implementation contract for browser notifications now and the reuse contract for a later notification center, desktop clients, and mobile clients.

It is intentionally narrower than the full audit-event surface. Notifications should be a filtered, role-aware projection over durable workflow events rather than a second stream of ad hoc UI events.

## Source-of-truth alignment

This taxonomy follows the current product rules from `PRD.md`:

- important workflow state must be modeled explicitly
- internal review remains an explicit checkpoint
- internal-only data must stay internal
- client-facing outputs must remain traceable to durable workflow events

It also fulfills the notification groundwork called out in `horizon1.md` and `horizon4.md`.

## Model

### 1. Durable source events

The durable source for notification fan-out is `public.audit_events`, including curated `worker.*` milestones already written into that table. Notification delivery must not depend on transient component state or route-local heuristics.

### 2. Notification types

A notification type is a stable, cross-surface semantic key derived from one or more source events plus delivery rules. A notification type is not the same thing as a raw audit event.

Example:

- source audit event: `job.quote_package_published`
- notification type: `client.quote_package_ready`

This separation lets browser, notification-center, desktop, and mobile surfaces reuse one taxonomy even when wording or batching differs by surface.

### 3. Delivery records

When notification persistence is implemented, each stored notification record should capture at least:

- `notification_type`
- `source_audit_event_id`
- `recipient_user_id` or invite-target identity
- scope ids such as `organization_id`, `project_id`, `job_id`, `package_id`, `quote_run_id`
- `delivered_at`, `seen_at`, and `read_at`
- channel metadata such as `browser`, `in_app`, `desktop`, or `mobile`

The source audit event remains the durable business fact. The notification record is the delivery projection.

## Audience and visibility rules

### Internal-only recipients

The following notification types are internal-only even if a client-safe activity-log summary exists for the same source event:

- extraction failures
- quote follow-up required
- quote collection failed
- quote responses ready
- client selection received

These are operational workflow notifications. They must only route to users with internal workspace roles (`internal_estimator` or `internal_admin`) at delivery time.

### Client-safe recipients

The first client-facing notification type is:

- `client.quote_package_ready`

It may route to users with access to the affected job or project, including project collaborators. It must never include vendor names, raw worker payloads, internal pricing context, or internal follow-up detail.

### Actor suppression

By default, do not deliver a browser notification to the actor who caused the source event when the action was user initiated and immediately visible in their current session.

Examples:

- suppress for the internal user who published a package
- suppress for the client who selected the quote option
- do not suppress worker-driven completions and failures solely because the same user started the run earlier

### Access re-check at delivery time

Fan-out must evaluate current access at delivery time, not only at event-write time. If a user no longer has access to the job or project when delivery is attempted, skip delivery for that user.

## First notification event set

The first slice should use the following notification types.

| Notification type | Source audit event(s) | Trigger gate | Recipients | Browser delivery now | Dedupe key |
| --- | --- | --- | --- | --- | --- |
| `internal.extraction_attention_required` | `worker.extraction_failed` | Deliver only if no newer `worker.extraction_completed` exists for the same `job_id` and `partId` when present. | Internal users with workspace access. | Yes | `notification_type + job_id + coalesce(part_id, source_audit_event_id)` |
| `internal.quote_responses_ready` | `worker.quote_run_completed` | Deliver only if the job still resolves to `internal_review` or a later unpublished review state. | Internal users with workspace access. | Yes | `notification_type + quote_run_id` |
| `internal.quote_follow_up_required` | `worker.quote_run_attention_needed` | Deliver only if the job still resolves to `awaiting_vendor_manual_review`. | Internal users with workspace access. | Yes | `notification_type + quote_run_id` |
| `internal.quote_collection_failed` | `worker.quote_run_failed` | Deliver only if no newer successful or follow-up quote event exists for the same `quote_run_id`. | Internal users with workspace access. | Yes | `notification_type + quote_run_id` |
| `client.quote_package_ready` | `job.quote_package_published` | Deliver only if the package is still the active published package for the job. | Client users and project collaborators who can access the job or project. | Yes | `notification_type + package_id` |
| `internal.client_selection_received` | `client.quote_option_selected` | Deliver only if the selection is still the recorded selection for the package. | Internal users with workspace access. | Yes | `notification_type + package_id + selection_id` |

## Workspace-state delivery rules

Notifications should fire on transitions into meaningful workflow states, not on every intermediate event.

### Notify now

Use browser notifications now for transitions that either:

- require internal follow-up outside the current tab
- announce a client-visible package becoming ready
- announce a client decision that changes the downstream internal workflow

That maps to these current workflow states and milestones:

- extraction failure
- quote responses ready for internal review
- manual vendor follow-up required
- quote collection failed
- quote package published
- client quote option selected

### Do not browser-notify in the first slice

Do not emit browser notifications yet for these events even though they remain durable workflow facts:

- `job.created`
- `job.file_attached`
- `job.parts_reconciled`
- `job.extraction_requested`
- `worker.extraction_completed`
- `client.part_request_updated`
- `job.requirements_approved`
- `job.quote_run_started`
- project assignment, archive, unarchive, delete, and dissolve events

These are suppressed because they are one or more of:

- actor-initiated and already visible inline
- too frequent for high-signal browser delivery
- operational bookkeeping rather than a new action point
- management events better handled in a later notification center

### Client-facing quiet states

The current client workspace already surfaces client-safe `ready`, `warning`, and `blocked` states inline. Browser notifications should not mirror every visible warning state.

In particular:

- `worker.extraction_failed`
- `worker.quote_run_attention_needed`
- `worker.quote_run_failed`

may remain visible in the client activity log, but they do not notify client users in the first slice. They are internal operational action items first.

## High-signal thresholds

Apply these thresholds across all channels:

1. Notify on terminal or action-forcing transitions, not on routine progress updates.
2. Prefer one notification per durable object transition, not one per render or poll cycle.
3. Skip notifications that only restate the actor's own just-completed action.
4. If multiple source events describe the same unresolved state for the same object, keep one unread notification and update or supersede it instead of stacking duplicates.
5. Project-level batching is allowed later for center/mobile surfaces, but the durable underlying notification record should remain scoped to the original job, package, or quote run.

## Dedupe and supersession rules

Use these rules when implementing storage and fan-out:

- `internal.extraction_attention_required` is superseded by a later successful extraction completion for the same part or job.
- `internal.quote_follow_up_required` is superseded when the affected quote run reaches publication or a newer quote run starts for the same job.
- `internal.quote_collection_failed` is superseded by a later attention-needed or completed outcome for the same quote run, or by a newer quote run for the same job.
- `client.quote_package_ready` should fire once per published package, not once per page visit.
- `internal.client_selection_received` should fire once per durable selection write. Later edits to unrelated package fields must not re-emit it.

## Deferred notification types

These event families are intentionally deferred until after the first browser slice:

- project invite, join, and member-removal notifications
- archive and restore notifications
- organization membership notifications
- shipment, order, and fulfillment notifications from later horizons

They are deferred because the first slice is focused on active quote-workspace state transitions, not every collaboration or account-management event in the repo.

## Implementation guidance

When a new notification type is proposed, document all of the following before implementation:

1. the durable source event or events
2. the exact recipient rule
3. whether it is internal-only or client-safe
4. the dedupe key
5. the supersession rule
6. whether browser delivery is enabled immediately or only stored for later surfaces

If those fields are not clear, the event is not ready to join the shared taxonomy.
