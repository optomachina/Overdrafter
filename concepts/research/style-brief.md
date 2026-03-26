# Style Brief — OverDrafter UI

## Audience

Procurement engineers and mechanical engineers at small-to-mid aerospace, defense, and industrial
manufacturers. These users:

- Spend 4–8 hours daily in CAD/EDA tools (SolidWorks, Onshape, Altium, CATIA)
- Are accustomed to monospace part numbers, tolerance callouts, and status-coded tables
- Expect information density — they distrust UIs that hide data behind progressive disclosure
- Are not marketers; they will not read copy, they will scan tables
- Care about: lead time, price, vendor reliability, revision tracking, and drawing version

## Tone

Precise, unambiguous, professional but not sterile. No marketing copy. No "Wow, great upload!"
confirmations. Status messages use engineering vocabulary: "extraction partial — 2 fields missing"
not "We're still processing your file." Numbers over words. Tables over cards where density matters.
Error messages cite what failed and what to do next.

## Visual Language

- **Dark background** by default. Engineers stare at black CAD canvases; a dark UI reduces context
  switch friction and eye strain during long quoting sessions.
- **Monospace** for part numbers, revision codes, tolerance callouts, material specs, and pricing.
  Use `font-mono` for any value a human might copy-paste into a drawing or BOM.
- **Clean tabular data** — borders, even column widths, sortable headers. Dense tables with enough
  row height for scan reading (~40px) not touch targets (~48px).
- **Meaningful status indicators** — color-coded chips (green/amber/red) that never rely on color
  alone (always paired with text label). Status is the first thing a procurement engineer asks.
- **Minimal animation** — subtle fade-ins only. No bouncing, no sliding panels unless purpose-built
  (like a CAD viewer). Motion should never compete with data.
- **Consistent spacing rhythm** — 4px base grid. Tight sections (spec panels): 8px gaps.
  Medium sections (table rows): 12–16px. Card containers: 24–32px padding.

## Comparable Tools

| Tool | What to learn from |
|------|--------------------|
| Xometry portal | Dense data tables, green CTA color, quote comparison rows, lead time prominently sized |
| Protolabs dashboard | Status progress bars, clean card layouts, minimal sidebar |
| Fictiv (Protolabs Network) | Activity timeline, workflow step visualization, modern but not frivolous |
| Onshape | Split-pane CAD viewer, spatial nav, file tree on the left |
| GrabCAD | Community+catalog patterns, file attachment UX |
| Hubs (now Protolabs) | Workflow step clarity, prominent "get quote" CTAs, clean |
| SolidWorks PDM | Revision tree, checked-out state indicators, vault metaphor |
| Arena PLM | Part lifecycle status, BOM table patterns, audit trail |

## Key Borrowed Patterns

- **Xometry quote comparison table** — Vendor rows with price, lead time, tier, cert badge side by
  side. Selected row highlighted. "Best price" and "fastest" sub-labels.
- **Protolabs status progress bar** — Linear step indicator showing: Uploaded → Extracted →
  Quoted → Selected. Compact, always visible in part header.
- **Fictiv activity feed** — Vertical timeline with actor avatar, action label, timestamp. Each
  node type (upload, quote, selection) has a distinct icon/color.
- **Onshape split-pane** — Left tree for navigation, right pane for CAD/drawing preview with
  floating controls. The tree collapses to icons.

## Typography

- **Body text:** Inter, 13–14px, regular weight for data fields
- **Labels/headers:** Inter semi-bold or medium, 11–12px uppercase tracking for category headers
- **Part numbers / specs:** `font-mono`, same size as body (~13px)
- **Large values (price, lead time):** 18–24px semi-bold, tabular numerals
- **Muted text:** `text-white/55` or `text-white/40` — never pure `text-gray-500` (too green-tinted)
