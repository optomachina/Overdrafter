# Review Page

## Routes
- Part review: `/parts/:jobId/review`
- Project review: `/projects/:projectId/review`

## Purpose
- Inserts a distinct review step between quote selection and payment / PO / order placement.
- Keeps the rest of the client app untouched and avoids reusing the legacy published-package route.

## Part Review
- Loads the selected line item through `fetchClientQuoteWorkspaceByJobIds([jobId])`.
- Summarizes:
  - selected vendor label
  - qty
  - delivery timing
  - domestic/foreign indicator
  - total price
  - RFQ/request context
- Actions:
  - back to edit selections
  - continue to checkout placeholder

## Project Review
- Loads project jobs plus their client quote workspace items.
- Summarizes:
  - project total
  - selected line count
  - domestic/foreign counts
  - selected option per line item
- Actions:
  - back to edit selections
  - continue to checkout placeholder

## Current Placeholder Surface
- Shipping / payment / PO fields are intentionally represented as a placeholder state.
- This keeps the route and handoff in place without inventing unsupported checkout backend behavior.
