# Design System — OverDrafter

Last updated: 2026-04-25

> Pretty good design follows pretty good rules. This is the canonical source of truth for OverDrafter's visual system. Read this before any UI or visual decision. If you change anything here, log a row in the Decisions section at the bottom and explain why.

---

## Product context

- **What this is:** OverDrafter is a multi-role CNC quoting platform that turns uploaded CAD files and engineering drawings into client-selectable quote packages. Long-term destination: a manufacturing co-pilot that lives inside the user's CAD environment and disappears until it adds value (see `PRD.md` §63–78).
- **Who it's for:** Manufacturing engineers (SolidWorks/Fusion/Onshape daily), purchasing professionals, hardware startups, and enthusiasts ordering custom parts.
- **Project type:** Workflow-dense web app — file upload, 3D STEP viewing, drawing review, dense quote comparison, project ledgers, internal estimator surfaces. Not marketing-led.
- **Reference class:** Modern defense-tech and engineering tooling (Hadrian, Anduril, Hermeus, professional CAD UIs) — NOT mainstream B2B SaaS (Xometry, Fictiv, Onshape marketing).

The memorable thing for a first-time user: *"the most elegant way to get great parts fast."*

---

## Visual thesis

**Drafting-paper precision meets workshop calm.** Warm bone backgrounds, hairline rules, monospaced filenames as the largest type on the page, a single oxidized-red accent used like an engineer's red pencil mark. *Daylight rigor* — the inside of a precision shop, not a war room and not a SaaS dashboard.

This rejects the two convergence traps in the category:
- **Cheerful SaaS blue** (Xometry, Fictiv) reads as untrustworthy with a CAD file.
- **Defense-tech black** (Anduril, SpaceX) is the obvious "go premium" move and would itself be a cliché.

The third path — bone background, hairline title-block grid, single oxidized-red accent — is unclaimed in the category and aligns with the artifact-first principle from `PRD.md` §175–179.

---

## Aesthetic direction

- **Direction:** Drafting-paper precision (industrial/utilitarian + editorial/technical hybrid).
- **Decoration level:** Minimal. Typography and hairline rules do all the work. No illustrations, no decorative blobs, no patterns.
- **Mood:** Quiet authority. The user opens the workspace and exhales: *"oh — these people have actually held a caliper."*
- **Reference signals:** Engineering title blocks, McMaster-Carr catalog typography, ASME drawing conventions, mid-century technical print.
- **Anti-references:** anything that reads as "AI assistant," "onboarding cheerfulness," "defense tech war room," or "Y Combinator demo day."

---

## Typography

Three faces, each with one role.

### Display

**Default — Suisse Int'l Condensed** (Swiss Typefaces). Used for filename heroes, section titles, key workflow state. Condensed sans creates mechanical pressure and reads with brand presence.

**Alternate — GT America Mono** (Grilli Type). Approved as an opt-in alternative for surfaces where the part number is the literal protagonist (e.g., the part workspace filename hero). Both fonts are sanctioned by this system; the choice is per-surface, with Suisse Int'l Condensed as the default.

Either font is set at 44–48px on the part workspace filename hero — the largest type on the page, bigger than headings, bigger than prices, bigger than the OverDrafter logo. *Your part is the subject of this product, not our brand.*

### Body

**Söhne Buch** (Klim Type Foundry). Humanist sans with technical-document warmth. Reads like a well-printed engineering manual, not friendly SaaS copy. Used for body copy, descriptions, notes, button labels, secondary UI text.

### Mono / Data

**Lab Mono** (Indian Type Foundry, free on Fontshare). A modern Letter Gothic homage. Used for **every** number, dimension, tolerance, price, lead time, file size, part number, status label, and table cell. Tabular-nums on by default (`font-feature-settings: "tnum" 1, "lnum" 1;`).

> **Roadmap note.** When budget allows, **license Letter Gothic Mono** (IBM, 1956 — the actual ASME/NASA drafting-room font) and replace Lab Mono. Lab Mono preserves the shape; Letter Gothic adds three decades of authentic mechanical-engineering heritage. This swap should be a coordinated cross-codebase change with a single PR. Track as a roadmap item.

### Loading

Production should self-host or load via a licensed foundry CDN. During preview/prototype phases, free analogs may stand in (Space Mono for the display monos, IBM Plex Sans for Söhne Buch, Lab Mono via Fontshare for Lab Mono). Free analogs preserve shape but should not ship.

### Scale

| Use | Size | Weight | Tracking |
|---|---|---|---|
| Filename hero | 44–48px | display 700 | -0.01em |
| Section title | 28px | display 700 | -0.005em |
| Subsection | 18px | display 700 | -0.005em |
| Body large | 16px | body 400 | normal |
| Body | 14px | body 400 | normal |
| Body small | 13px | body 400 | normal |
| Data large (prices) | 22px | mono 400 | normal |
| Data | 13px | mono 400 | normal |
| Data small (rows, labels) | 11–12px | mono 400 | normal |
| Mono micro label (uppercase) | 10–11px | mono 500 | 0.1em |

---

## Color

Single accent. No multi-color systems. Colors are tokens, not values.

```css
:root {
  --bg:          #F2EFE8;  /* bone / unbleached drafting paper — never white, never black */
  --surface:     #FBF9F4;  /* half-shade lighter, primary card / inset surface */
  --surface-2:   #E7E0D4;  /* deeper inset, selected row, secondary fill */
  --text:        #1C1B19;  /* warm black, NOT pure black */
  --muted:       #6B665C;  /* graphite pencil — secondary text, labels, micro nav */
  --hairline:    #D8D2C4;  /* 1px borders, dividers, used liberally */
  --accent:      #C2410C;  /* oxidized red — engineer's pencil mark */
  --ink-data:    #1F2E3A;  /* dark teal-black for the densest data tables (use sparingly) */
}
```

### Accent rules

The accent is reserved for:
- Selected state (the chosen quote column, the active row, the in-focus part)
- Decision moments (primary CTA on a confirmation surface)
- Urgency / exception indicators (a `REVIEW` flag, a DFM warning)
- Active filename / current artifact in lists

Never use the accent for:
- Decoration
- Brand display (the OverDrafter wordmark is `--text`, not `--accent`)
- Multiple simultaneous emphases on one screen
- Hover states (use `--surface-2` for hover)

### Semantic colors

Deferred. State is communicated through plain words (`REVIEW`, `READY`, `HOLD`, `SENT`, `QUEUE`, `DRAFT`, `OK`, `FAIL`) rendered in `--mono`, not through color-coded badges. The accent does the work for the *current* selection or exception only. If a true semantic palette becomes necessary later, propose it via a Decisions row and keep it muted (no bright greens, no Twitter blues).

### Dark mode

**Deferred.** Daylight is the hero. A future dark mode should:
- Redesign surfaces, not invert colors
- Reduce accent saturation 10–20%
- Keep the same hairline rule rhythm
- Be designed deliberately, not auto-derived

---

## Spacing

- **Base unit:** 4px (everything is a multiple).
- **Density:** compact (this is a workflow tool, not a marketing page).
- **Scale:** `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`.
- **Gutter rule:** 8px between siblings in a dense table or rail; 16px between sections in the workspace; 24px between top-level page regions.
- **Padding rule:** cells use 12–14px vertical, 16px horizontal. Hero regions use 28px+.

---

## Layout — "Quoting Cockpit"

Composition-first, not component-first. The application is laid out like an engineering title block, not a SaaS dashboard.

### Standard part-workspace layout

```
┌─────────────────────────────────────────────────────────────┐
│ COMMAND STRIP (mono 11px uppercase) — 44px tall              │
├──────────┬─────────────────────────────────────┬────────────┤
│          │ FILE HERO (44–48px display mono)     │            │
│  LEDGER  │ ─── meta row ───                     │  DECISION  │
│  LEFT    ├──────────┬──────────┬────────────────┤   LEDGER   │
│          │ MATERIAL │ TOLERANCE│ FINISH         │   RIGHT    │
│  Parts   ├──────────┴──────────┴────────────────┤            │
│  list    │ QTY      │ LEAD     │ CERTS          │  Margin Δ  │
│  (mono)  ├──────────┴──────────┴────────────────┤  Lead Δ    │
│          │ 3D STEP VIEWER     │ DRAWING PDF    │  Confidence│
│          │ (inset, hairline)  │ (inset, hairline)│  DFM flags │
│          ├────────────────────────────────────── │  Exceptions│
│          │ QUOTE PACKAGES — 4 spec-sheet columns│            │
└──────────┴─────────────────────────────────────┴────────────┘
```

### Layout rules

- **Persistent left ledger** (220px). Mono filenames as a parts list, not as nav links. State pills are plain words in mono uppercase.
- **Top command strip** (44px). Project breadcrumb, customer, due date, current state. Mono uppercase 11px. This is a status bar, not a navbar.
- **Center workspace** divided into hairline-bordered cells. Each cell has a mono uppercase corner label (`MATERIAL`, `TOLERANCE`, `FINISH`, `LEAD TIME`, `QUANTITY`, `CERTIFICATIONS`).
- **3D viewer and drawing preview** live inset within the grid, hairline border, never full-bleed. Per `PRD.md` §72: visualizations collapse back to the clean view when not needed.
- **Quote packages** render as horizontally-arranged spec-sheet columns at the bottom (NOT vertical pricing cards). One column gets a 2px left border in `--accent` to mark the selected option.
- **Right decision ledger** (240px) shows margin delta, lead time delta, supplier confidence, DFM flags, exceptions. Lives only on quote-construction surfaces.

### Other layouts

- **Project ledger:** dense parts table, full-width, hairline rows, mono numeric columns right-aligned, plain-word status, hover = `--surface-2`, selected row = inset accent border. No card grids. No zebra striping.
- **Marketing surfaces:** if any exist, follow the same system. The bone background, hairline rules, and mono filenames hold up at landing-page scale.
- **Settings / admin:** form fields use hairline borders, mono labels, no rounded inputs above 2px radius.
- **Empty states:** plain mono text with one labelled action. No illustrations.

### Forbidden layouts

- 3-column SaaS feature grids with icons in colored circles
- Centered-everything hero pages
- Card stacks with drop shadows
- Bubbly badges or pill UI
- Floating action buttons
- Decorative illustration layers
- AI assistant chat widgets as primary chrome (per `PRD.md` §175–179, chat is contextual only)

---

## Border, radius, and elevation

- **Borders:** 1px hairlines (`--hairline`) used liberally.
- **Border radius:** scale = `0 / 2 / 4`. **Never above 4px** anywhere in the system. No rounded buttons. No bubble badges.
- **Shadows:** none. No drop shadows. No box-shadow elevations. Depth comes from hairlines and surface tint, not blur.
- **Gradients:** none. Anywhere. Ever.

---

## Motion

- **Approach:** minimal-functional. Motion exists only when it aids comprehension.
- **Easing:** `enter: ease-out`, `exit: ease-in`, `move: ease-in-out`.
- **Duration:** `micro: 50–100ms`, `short: 150–250ms`, `medium: 250–400ms`. Avoid `long` durations.
- **Forbidden:** entrance animations, scroll choreography, parallax, "wow moment" transitions, anything that delays the user from seeing data.
- **Permitted:** state transitions (selected ⇄ unselected), drawer open/close, accordion toggle, focus ring fade.

---

## Iconography

- **Default:** plain mono words instead of icons (`ORBIT`, `PAN`, `SECTION`, `X-RAY`, `FIT` rather than icon glyphs).
- **When icons are unavoidable:** use a single thin-stroke outline set (1.5px stroke, 16/20/24 sizes). Never filled, never colored. Inherit `currentColor`.
- **Forbidden:** colored icon circles, gradient icons, illustration-style icons, emoji as UI.

---

## Voice (for UI copy)

- Plain, technical, direct. Match the spec-sheet register, not the onboarding register.
- Status as plain words: `REVIEW`, `READY`, `HOLD`, `SENT`. Never `🟢 Looking good!` or similar.
- Errors as engineering exceptions: `MIN RAD: REVIEW · 0.3mm < spec 0.5mm`. Specific, actionable, not apologetic.
- No emoji in product UI. No exclamation marks in default copy. No "let's" or "we'll" — speak in the imperative or declarative.

---

## Anti-slop checklist

Reject any UI work that includes:

- [ ] Purple or violet anywhere
- [ ] Blue accent (the category convergence trap)
- [ ] Gradient backgrounds, gradient buttons, gradient text
- [ ] Drop shadows, soft shadows, glass blur
- [ ] Border radius > 4px (no pills, no bubbles, no rounded everything)
- [ ] 3-column feature grid with icons in colored circles
- [ ] Centered-everything hero
- [ ] System UI font as the primary display or body face
- [ ] Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins, Space Grotesk anywhere in the production stack
- [ ] Decorative illustration layer
- [ ] AI assistant character / personified chatbot avatar
- [ ] Bubbly status badges with background fills
- [ ] More than one accent color simultaneously on a single surface
- [ ] Color used to encode status (use plain mono words instead)

---

## Implementation notes

- All colors live as CSS custom properties on `:root` per the snippet above.
- All numbers use `font-variant-numeric: tabular-nums lining-nums` (set globally on `<body>`).
- Tailwind users: extend the theme tokens to map exactly to the CSS variables above. Do not introduce parallel color values.
- Component library (shadcn/Radix in this repo) should be re-themed against these tokens. Do not accept defaults.
- Loading screens, error pages, and 404s follow the same system (bone background, hairline rules, plain mono text). No friendly cartoons.

---

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-25 | Initial design system created | `/design-consultation` ran with Codex + Claude subagent + competitive research (Xometry, Fictiv, Anduril, SpaceX, Hermeus, Onshape, Linear). All three voices independently converged on warm-bone-on-paper with single oxidized-red accent and mono filename hero. Memorable thing: "the most elegant way to get great parts fast." Reference class: Hadrian / Anduril / SpaceX, NOT Xometry / Fictiv. |
| 2026-04-25 | Mono = Lab Mono (free) with Letter Gothic Mono on the future-license roadmap | Berkeley Mono rejected (no real ASME heritage). Courier Prime considered (real heritage, free, but slightly looser feel). Lab Mono picked as the modern Letter Gothic homage — same shape, free, ships now. Letter Gothic Mono is the eventual upgrade for authentic mechanical-drafting heritage. |
| 2026-04-25 | Display = Suisse Int'l Condensed (default) + GT America Mono (alternate) | Both sanctioned. Codex argued for Suisse Condensed (mechanical pressure, brand presence); subagent argued for GT America Mono (part number as protagonist). Default is Suisse; mono allowed where artifact-as-protagonist needs to dominate. |
| 2026-04-25 | Bone background `#F2EFE8`, oxidized-red accent `#C2410C` | Rejects both category convergence traps (cheerful SaaS blue and defense-tech black). Daylight rigor reads as an actual precision shop. |
| 2026-04-25 | Filename is the largest type on the workspace | Aligns with `PRD.md` §175–179 artifact-first principle. The user's part number is the subject of the product, not the brand. |

---

## See also

- `PRD.md` §63–78 (north star — manufacturing co-pilot, hide complexity)
- `PRD.md` §175–179 (artifact-first principle)
- `horizon1.md` (near-term UX direction — dense quote comparison, project ledger, right-side detail drawer)
- `.context/design-preview/overdrafter-preview.html` (live HTML preview of the system on three real screens)
- `.context/design-preview/overdrafter-mono-comparison.html` (mono A/B/C comparison from the consultation session)
