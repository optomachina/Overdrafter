# RFQ Metadata Model

Last updated: March 13, 2026

## Purpose

This document defines the next RFQ metadata envelope for OverDrafter. It separates RFQ-level context from line-item requirements so later schema and UI work can implement against a stable target instead of continuing to extend the MVP request editor ad hoc.

## Design rules

- Keep RFQ-level context distinct from per-part requirements.
- Preserve the existing client-safe request edit path as the MVP subset.
- Keep the envelope service-agnostic so the upcoming service taxonomy can plug in without remodeling the metadata shape again.
- Treat procurement handoff fields as post-selection data, not RFQ metadata.

## Current baseline

Current request editing covers:

- requested services
- primary service
- service notes
- part number
- description
- revision
- material
- finish
- tightest tolerance
- process
- notes
- quantity
- quote quantities
- due date
- shipping packaging / delivery notes
- certification requirements
- line-item sourcing preferences
- release status

Current persistence split:

- `jobs.requested_service_kinds`, `jobs.primary_service_kind`, and `jobs.service_notes` hold transitional draft-stage service intent
- `jobs.requested_quote_quantities` and `jobs.requested_by_date` hold request timing and quantity state
- `approved_part_requirements` holds canonical line-item requirement fields
- `approved_part_requirements.spec_snapshot` is the extension bucket used by the current client request editor
- `drawing_extractions.extraction` holds raw drawing-derived metadata, extraction confidence, and review-needed state for source-truth auditing
- `public.api_update_client_part_request` in [supabase/migrations/20260310110000_add_client_part_request_update.sql](../supabase/migrations/20260310110000_add_client_part_request_update.sql) only updates that MVP-safe subset

## Target envelope

The target contract is defined in [src/features/quotes/types.ts](../src/features/quotes/types.ts) through:

- `RfqProjectMetadata`
- `RfqLineItemMetadata`
- `ClientPartRequestEditableFields`
- `CLIENT_PART_REQUEST_MVP_FIELDS`

### RFQ / project level

`RfqProjectMetadata` carries shared context for the whole RFQ or project:

- `serviceScope`
  - `requestedServiceKinds`
  - `primaryServiceKind`
  - `serviceNotes`
- `shipping`
  - `requestedByDate`
  - `shippingPriority`
  - `shipToRegion`
  - `constraintsNotes`
- `certifications`
  - `requiredCertifications`
  - `traceabilityRequired`
  - `inspectionLevel`
  - `notes`
- `sourcing`
  - `regionPreference`
  - `supplierSelectionMode`
  - `allowSplitAward`
  - `notes`
- `release`
  - `releaseStatus`
  - `reviewDisposition`
  - `reviewOwner`
  - `notes`

This level is where shared shipping constraints, common certification expectations, sourcing direction, and overall release/review context belong.

### Line-item level

`RfqLineItemMetadata` carries part-specific requirements:

- `request`
  - current editable request fields, including `requestedQuoteQuantities` and `requestedByDate`
- `shipping`
  - `requestedByDateOverride`
  - `packagingNotes`
  - `shippingNotes`
- `certifications`
  - `requiredCertifications`
  - `materialCertificationRequired`
  - `certificateOfConformanceRequired`
  - `inspectionLevel`
  - `notes`
- `sourcing`
  - `regionPreferenceOverride`
  - `preferredSuppliers`
  - `materialProvisioning`
  - `notes`
- `release`
  - `releaseStatus`
  - `reviewDisposition`
  - `quoteBlockedUntilRelease`
  - `notes`

This level is where per-part certification requirements, sourcing exceptions, release blockers, and packaging or delivery overrides belong.

## MVP-safe edit boundary

The current client request editor and `updateClientPartRequest(...)` call in [src/features/quotes/api.ts](../src/features/quotes/api.ts) now extend beyond `ClientPartRequestEditableFields`, but only for the approved client-safe line-item sections.

The client-safe write path can edit:

- `requestedServiceKinds`
- `primaryServiceKind`
- `serviceNotes`
- `description`
- `partNumber`
- `revision`
- `material`
- `finish`
- `tightestToleranceInch`
- `process`
- `notes`
- `quantity`
- `requestedQuoteQuantities`
- `requestedByDate`
- `shipping.packagingNotes`
- `shipping.shippingNotes`
- `certifications.requiredCertifications`
- `certifications.materialCertificationRequired`
- `certifications.certificateOfConformanceRequired`
- `certifications.inspectionLevel`
- `certifications.notes`
- `sourcing.regionPreferenceOverride`
- `sourcing.preferredSuppliers`
- `sourcing.materialProvisioning`
- `sourcing.notes`
- `release.releaseStatus`
- `release.notes`

Normalized quote-facing fields also currently ride in `approved_part_requirements.spec_snapshot`:

- `quoteDescription`
- `quoteFinish`
- `fieldSources`
- `fieldOverrides`

Those fields exist to keep estimator- and vendor-facing normalization separate from raw extraction. They should remain traceable back to `drawing_extractions.extraction` and should not be overwritten on reparse when the provenance marks them as user-managed.

This service-intent trio is a transitional bridge so active intake and internal review surfaces can capture the taxonomy before dedicated service request line items land.

Internal review can consume the full line-item metadata model, including internal-only release review controls such as `release.reviewDisposition` and `release.quoteBlockedUntilRelease`. Those fields must not be writable through the client-safe request update path and should be stripped from client-facing fetches.

## Persistence guidance for follow-on work

- RFQ/project-level metadata should live on a shared RFQ or project container, not be duplicated across every line item.
- Line-item metadata should stay attached to the part requirement record or a dedicated line-item metadata structure.
- `spec_snapshot` can continue to bridge transitional fields, but it should not become the long-term canonical home for the full next metadata envelope.
- When schema promotion happens, promote shared RFQ-level fields separately from line-item overrides so project-wide defaults and per-line exceptions can coexist.

## Non-goals of this document

- define the final service taxonomy enum values
- introduce procurement handoff, billing, or PO fields into the RFQ model
- implement schema migrations or UI surfaces for every new field
