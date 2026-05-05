# Changelog

All notable changes to OverDrafter are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses a 4-digit `MAJOR.MINOR.PATCH.MICRO` version scheme.

## [0.0.1.1] - 2026-05-05

### Changed
- **Design system locked for MVP.** Nine rounds of `/design-shotgun` exploration with three stakeholders converged on the production design language for the Part Workspace, Project Workspace (assemblies + flat-parts modes), Editable Specs interaction, and Order Confirmation page.

### Added (in `docs/DESIGN.md`)
- **Slider rails** — both left and right rails on every workspace surface are collapsible; drag handles on inner edges, 32px collapsed gutter.
- **Left rail composition** — OverDrafter logo + tagline at top, NEW + SEARCH button row, parts/projects list in body, ChatGPT-style user account footer at bottom.
- **Sortable quote tables** — caret indicators on PRICE / LEAD / QUALITY / TOTAL columns; active sort filled in oxidized-red.
- **Vendor multi-quote stacking** — vendors with multiple quote variants (e.g. Xometry's 5+ quotes) collapse to a parent row with `(N quotes)` annotation; selection happens at the sub-row level.
- **Editable specs interaction (3 states)** — default (no indicators) → editing (focus ring + keyboard hint) → has-pending-edits (deeper-surface tint + italic value text + REVERT TO DEFAULTS link). Explicitly rejects red dots, bold values, and per-row WAS: annotations as too loud.
- **Units policy** — imperial-only throughout MVP; metric swap deferred to roadmap (chip `METRIC SWAP`).
- **Bulk filter strip** (Project workspace) — `CHEAPEST / FASTEST / BY DUE DATE` chips + `[X] US ORIGIN ONLY` checkbox for one-click bulk vendor selection.
- **4-step status timeline** — RFQ Sent → Quotes Received → Quote Selection → Parts Ordered. Confirm Order is the action surface, not a discrete state.
- **Order Confirmation page** — full-page checkout (not modal): Order Summary, Line Items, Costs, Ship To, Payment Method, Terms. Single primary CTA `PLACE ORDER` is the only filled-color button on the page.
- **Project workspace modes** — assemblies (grouped headers, qty/assy multipliers) and flat-parts (independent parts with `NO ASSEMBLIES — N INDEPENDENT PARTS` indicator). Mode is data-driven.
- **Roadmap chips pattern** — visible-but-parked features render as muted mono uppercase chips in info-panel footers (`DFM FLAGS`, `ASK OVERDRAFTER`, `TARIFF AUTO-CALC`, etc.).

### Decisions logged
- Default to **imperial**, metric on roadmap.
- Theme toggle is a single sun/moon icon, not a labeled pill.
- Selection indicator is the vendor wordmark in oxidized-red text — never row-level vertical bars.
- Override indicator is `--surface-2` background tint + italic value, never colored dots or bold.
- Edit affordance is hover-only — no static pencil icons.
- Quote table columns are Vendor / Price / Lead / Quality / Origin only (Certs, Margin, Capabilities, Process dropped or routed to roadmap).
- Breadcrumbs live above the filename hero in the center column, not in the top command strip.
- `.STEP` extensions show only on the Part Workspace; Project / Assembly contexts drop them.
- Project totals use **EST. LEAD** (not Weighted Lead) and **TARIFFS\*** (not Cert Fees), with asterisk footnote about tariff auto-calc being roadmap.
