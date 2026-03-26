# Design Direction — OverDrafter UI Concepts

## Audience

Mechanical engineers and procurement teams at mid-market manufacturers. These users are technical, data-dense in their preferences, and have low tolerance for decorative UI. They work with part numbers, tolerances, lead times, and vendor certifications daily. Every click costs them time; the workspace should reward familiarity and density over discoverability.

The primary persona is a procurement engineer managing 5–30 parts across 2–6 active projects simultaneously. Secondary users are engineering managers who need a health-at-a-glance view without drilling into individual parts.

---

## Visual Language

**Dark workspace** — The app lives in `bg-ws-overlay` (#080b12 range). Panels use `bg-ws-shell`, `bg-ws-card`, and `bg-ws-raised` to establish depth hierarchy. No light-mode consideration in this exploration.

**Part numbers and codes** — All part numbers, revision identifiers, tolerances, and file names use `font-mono`. This creates immediate visual chunking: a user scanning a table can distinguish a part number (`font-mono text-[12px]`) from a description (`text-sm`) without reading both.

**Status color semantics (shared across all concepts)**:
- Emerald-400 — success / quoted / received
- Amber/yellow-400 — in-progress / requesting / pending
- Rose-400 — error / needs attention / action required
- Sky-400 — selected / confirmed / navigated-to
- Neutral-500 — archived / inactive

**Navigation tones** — Muted blues and slate tones for navigational chrome. Accent colors appear only in data, status, and active-state indicators — never in structural chrome.

---

## Layout Principles

Information density over whitespace. The workspace is a professional tool, not a marketing page.

**Left sidebar** (220–240px) provides persistent navigation: project tree, part list, or icon rail depending on concept. Header bar (44px) carries breadcrumb and contextual actions. Main content area is flex-1 and scrollable. Right panel (inspector, activity, stats) is optional per concept.

**Split-pane patterns** are used in detail views: part detail shows spec on the left and quote comparison on the right. This mirrors the physical workflow — the engineer has the drawing spec in one hand and the vendor quote in the other.

**Table-first for lists** — Part lists and quote comparisons are data tables, not card grids. Exception: Atlas (Set 3) and Signal (Set 5) use cards where spatial grouping aids status scanning.

---

## The Five Concept Directions

**Set 1 — Precision**: Strict data-table-forward layout. Every view is a table with sortable, monospace columns. Emerald accent appears only on active rows and quoted-state badges. This is the closest to what procurement engineers already know from Xometry's dense quote interfaces.

**Set 2 — Command**: Keyboard-first. The home screen centers a `cmdk`-style command palette. The sidebar is an icon rail with no labels. Part specs render in a terminal-style key:value monospace grid. Shortcut hints are visible throughout. For power users who consider mouse navigation a tax.

**Set 3 — Atlas**: File and drawing-centric. The part drawing is the primary navigation object — the home screen surfaces it prominently. Cyan accent. Quote options are vendor cards with large price typography rather than a table row.

**Set 4 — Chronicle**: Timeline-first. The home screen is a vertical activity feed across all parts. The part detail page renders lifecycle events (upload → extract → quote → select) as a visual pipeline with branch points for multiple vendor quotes. Orange accent. Built for aerospace/defense workflows requiring audit trails.

**Set 5 — Signal**: Status dashboard. A health bar across the top segment shows all parts by status color. Alert cards surface actionable items immediately. Per-quote health indicators (green/amber/red dots) show price and lead time vs workspace medians. Pink/rose accent. For procurement managers overseeing many parts who need a "what's broken" view in under five seconds.

---

## Shared Foundation

All five sets share: Tailwind `ws-*` color tokens, shadcn/ui primitives (Badge, Button, Card, Table, Command, Collapsible), Inter font, Lucide icons, and the `ConceptShell` layout wrapper providing the sidebar + header frame. Mock data lives in `src/concepts/mock-data.ts` — real CNC part numbers, 6061-T6 aluminum, Xometry/Protolabs/Fictiv vendors, AS9100 certs.
