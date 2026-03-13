# Activity Log

## Component
- `src/components/quotes/ActivityLog.tsx`

## Purpose
- Show restrained, high-signal system activity inside quote selection workspaces.
- Avoid turning the MVP into a collaboration feed, chat log, or full reasoning transcript.

## Current Usage
- Single-part workspace
- Project detail drawer

## Entry Style
- Short status labels with optional expandable detail text.
- Tone values:
  - `default`
  - `active`
  - `attention`

## Event-backed Source
- Client activity now comes from curated rows returned by `api_list_client_activity_events`.
- The RPC reads only approved `audit_events` for accessible jobs and excludes internal-only sourcing context.
- Worker-driven milestones are recorded into `audit_events` with `worker.*` event types so the same event stream can support later notifications.

## Client-safe Event Taxonomy
- `job.created`
- `job.extraction_requested`
- `worker.extraction_completed`
- `worker.extraction_failed`
- `client.part_request_updated`
- `job.requirements_approved`
- `job.quote_run_started`
- `worker.quote_run_completed`
- `worker.quote_run_attention_needed`
- `worker.quote_run_failed`
- `job.quote_package_published`
- `client.quote_option_selected`

## Notes
- The log is intentionally restrained and high-signal; it is not a chat feed.
- Vendor names, raw worker errors, and internal sourcing notes remain out of the client event surface.
- Activity entries should answer what changed and when, with timestamps shown in the UI.
- Browser and later cross-surface notifications should derive from the same durable event stream, using the delivery rules defined in [docs/notification-taxonomy.md](./notification-taxonomy.md).
