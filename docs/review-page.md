# Review Page

## Routes
- Part review: `/parts/:jobId/review`
- Project review: `/projects/:projectId/review`

## Purpose
- Inserts a distinct review step between quote selection and payment / PO / order placement.
- Keeps the rest of the client app untouched and avoids reusing the legacy published-package route.
- Captures structured procurement handoff state without pretending the product owns checkout or direct ordering.

## Part Review
- Loads the selected line item through `fetchClientQuoteWorkspaceByJobIds([jobId])`.
- Summarizes:
  - selected vendor label
  - qty
  - delivery timing
  - domestic/foreign indicator
  - total price
  - RFQ/request context
- Collects the same procurement handoff fields used on project review:
  - shipping plan
  - ship-to contact
  - ship-to location
  - billing path
  - billing contact name
  - billing contact email
  - PO reference
  - special instructions
- Actions:
  - back to edit selections
  - review the procurement handoff readiness summary

## Project Review
- Loads project jobs plus their client quote workspace items.
- Summarizes:
  - project total
  - selected line count
  - domestic/foreign counts
  - selected option per line item
- Uses the same procurement handoff model as part review so shipping, billing, and PO context are gathered consistently.
- Actions:
  - back to edit selections
  - review the procurement handoff readiness summary

## Procurement Handoff Surface
- The route now holds structured client-side state for shipping, billing, contact, PO, and special-instruction details.
- The handoff summary explicitly reports what details are still missing before manual release coordination.
- The route still stops short of payment collection, PO submission, or direct order placement.
