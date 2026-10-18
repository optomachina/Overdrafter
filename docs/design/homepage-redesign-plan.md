# Homepage redesign: "Cursor for hardware" (plan, not yet built)

Status: draft for Blaine's review. No code changed.

## Decisions so far

- Headline: **OverDrafter is your manufacturing agent for building frontier hardware.**
- Structure and motion borrowed from cursor.com; OverDrafter identity kept (bone background, hairlines, mono type).
- Hero demo: the real UI, scripted (built from app components, not a video or a mock).
- Proof: none yet. No logos, quotes, stats or timelines.
- Only claims that ship today. Sections with no real feature are dropped.
- "Agent" is honest: quoting runs unattended across providers.

## Truthfulness constraint to resolve first

The current landing says automatic vendor collection is only available through the free, invitation-only
Founding Beta. An "agent" headline must not contradict that. Options: (a) keep a one-line Founding Beta
note under the hero CTA, (b) show the demo as "Founding Beta" in the frame. Recommended: (a).

## Section map

| # | Cursor | OverDrafter | Demo built from |
|---|---|---|---|
| Hero | Cursor is your coding agent for building ambitious software. | OverDrafter is your manufacturing agent for building frontier hardware. | Scripted workspace: STEP + PDF drop, specs extract, providers fill in, scatter populates |
| 1 | Agents turn ideas into code | Agents turn drawings into quotes | Upload pair, then extracted spec rows (reuses the example part in `anonymous-home-example.ts`) |
| 2 | Works autonomously, runs in parallel | Every provider quoted in parallel. Results stream in as they arrive. | Vendor table rows arriving, status per provider |
| 3 | Use the best model for every task | Compare the best supplier for every part | `ClientQuoteComparisonChart` with the deadline slider and Cheapest/Fastest toggle |
| 4 | Build with autonomous agents (fleet) | Quote a whole project, every part at once | Project ledger with several parts quoting in parallel |
| End | Try Cursor now. | Try OverDrafter now. | CTA |

Dropped (nothing real behind them yet): Slack / CLI / GitHub integrations, "AI teammates", enterprise,
changelog, research blog, customer logos, CEO quotes.

## Layout and motion

- Left-aligned hero (matches existing DESIGN.md; no centered hero needed).
- Each demo sits in a framed window on a soft backdrop. Needs a DESIGN.md exception (below).
- Scripted loop: typed command, rows appear, chart points land, selection highlights. Respects
  `prefers-reduced-motion` (static final frame). Starts when scrolled into view and pauses off-screen.
- Demo data stays labelled as an example part, as it is today.

## DESIGN.md exception to draft (marketing surfaces only)

- Allow one framed-window treatment per demo on a quiet tinted backdrop.
- Keep: bone background, hairlines, mono labels, no card shadows, no pills, no icon-circle feature grids.
- Still forbidden: decorative illustration layers, chat widgets as the primary surface.

## Implementation plan

1. Update `docs/DESIGN.md` marketing section and decision log.
2. Replace `AnonymousHomeLanding` hero and "How it works" cards with the section map above.
3. Add a small scripted-timeline hook (no new dependency; CSS plus a timer) that drives the demo components.
4. Reuse `AnonymousQuoteChartShowcase` / `ClientQuoteComparisonChart`; extend `anonymous-home-example.ts` with streaming order.
5. Update `AnonymousHomeLanding.test.tsx`, run docs contract tests (`release-contract` regexes), lint, then preview and screenshot.
6. No dependency additions. Nothing outside `src/components/quote-intelligence`, `docs/DESIGN.md`, and tests.

## Open questions

- Is the hero CTA "Create account" and "Log in" as today, or a single "Get started"?
- Does the quote scatter animation need the real timing of provider responses, or is a representative sequence fine? (Recommended: representative, labelled "example".)
