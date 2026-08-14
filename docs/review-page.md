# Review Page

## Routes
- Part review: `/parts/:jobId/review`
- Project review: `/projects/:projectId/review`

## Purpose
- Inserts a distinct review step between quote selection and manual procurement coordination.
- Keeps the rest of the client app untouched and avoids reusing the legacy published-package route.
- Captures structured procurement handoff state without pretending the product collects manufacturing payment or places supplier orders.

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
- This review layer is the intended entry point to a future downstream
  lifecycle, but it must not imply that OverDrafter placed an order or committed
  spend.
- The planned order foundation will persist this handoff and an immutable selected-offer snapshot before manual review.
- The route still stops short of manufacturing payment collection, PO submission, or supplier order placement.
- Organization subscription billing is a separate account-access flow and must not appear as order payment on this route.

## Legacy project-payment containment
- Project review does not render the historical Stripe card-payment component.
- `create-payment-intent` and the legacy `stripe-webhook` are disabled unless the server-only `LEGACY_PROJECT_PAYMENTS_ENABLED` value normalizes exactly to `true`.
- Keep that flag unset or false in normal environments. It exists only to preserve a controlled rollback/test path for historical code and data; it is not a supported customer checkout.
- While disabled, PaymentIntent creation returns `legacy_project_payments_disabled` without loading Stripe or writing payment data, and legacy webhook POSTs are acknowledged without signature processing or payment mutation.
