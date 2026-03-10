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

## Current Entry Themes
- parsing drawing notes
- extracting part details
- matching vendor options
- filtering late deliveries
- ranking eligible quotes
- selected/manual state

## Notes
- Entries are derived client-side from available extraction, quote, and selection state.
- No dependency on `audit_events` was introduced for MVP.
