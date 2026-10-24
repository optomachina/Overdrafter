# OverDrafter competitive UX library

Updated: 2026-09-12

## Product thesis

OverDrafter is the persistent, supplier-neutral and CAD-neutral decision workspace connecting CAD, drawings, manufacturing requirements, provider options, quotes, revisions, and final sourcing decisions. The library borrows proven mental models, never proprietary code, brand skins, assets, or claims.

## How to read this library

- **OBSERVED** means a public help page, tutorial, transcript, or product documentation describes the interaction or shows the control.
- **CLAIMED** means the vendor describes a capability but the public evidence does not expose enough interaction detail to treat it as observed UI.
- **HISTORICAL** means the pattern comes from a retired product and is retained only as a reference.
- **UNKNOWN** means public evidence was insufficient; it is a research gap, not a negative finding.
- **STEAL** means reuse the mental model.
- **ADAPT** means reuse only after preserving OverDrafter's supplier/CAD neutrality and evidence model.
- **AVOID** means the pattern conflicts with product intent or hides material decision context.

No accounts were created, terms accepted, files uploaded, quote requests sent, or purchases attempted. Sources are public and linked at the point of use.

## Index

1. [Cross-product pattern decisions](patterns.md)
2. [Platform evidence cards](platforms.md)
3. [Lawful CAD-capacity marketplace opportunity map](cad-capacity-marketplace.md)

## OverDrafter surfaces used in mappings

- **Parts intake:** upload, parse state, CAD/drawing pairing, requirements review.
- **Part workspace:** 3D/2D evidence, requirements, DFM, revision lineage, recovery.
- **Quotes:** request lifecycle, provider responses, price/lead comparison, origin and confidence.
- **Project context:** mixed assemblies, standalone parts, supporting documents, collaborators.
- **Search:** retrieval across parts, projects, quote metadata, requirements, and revisions.
- **Procurement handoff:** selected option, decision rationale, export/share packet, explicit downstream status.
- **Internal review:** exception handling, source evidence, provider admission, and publication controls.

## Current synthesis

The strongest category-wide opportunity is not another instant-quote funnel. It is a durable decision record that keeps the model, drawing, extracted requirements, provider-specific interpretations, quote variants, revisions, and handoff status linked after the first quote. Direct platforms are strongest at fast configuration; PDM products are strongest at lineage and impact; design-review products are strongest at contextual issues; sourcing directories are strongest at supplier qualification. OverDrafter should connect those mental models while remaining neutral about both supplier and CAD system.
