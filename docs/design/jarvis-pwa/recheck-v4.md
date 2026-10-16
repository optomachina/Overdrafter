# Re-check: Jarvis PWA v4 (OVD-799), 2026-10-16

Inputs reviewed: `critique-v3.md`, the fix list, fix-list (a markdown file removed in this PR; in cb307e09dd2e0ac9dcabea479b4471707b17d7f5), all 13 v4 screenshots at 430, the 375 set (I viewed decide, evidence, offline and result), the combined strip, `mock/v4.html` (CSS and script read), the v4 section of SPEC.md, and the checks report (screenshots/v4/checks-report.json). I computed contrast from the CSS hex values. I verified behavior by reading the code; I didn't run any interactions.

## Per item

| Id | Verdict | Reason (what I saw) / fix |
|---|---|---|
| B1 | **pass with notes** | Result shows a full-width filled `COMMIT PLATE R1` in the dock. OPEN 3D is now an outline button. The confirm sheet has the specified copy and 48 px COMMIT/CANCEL buttons. Committed shows the UNDO snackbar. Notes: (a) Committed reads `Working PLATE R1 · Committed PLATE R1`, which is ambiguous (see N2). (b) I can't verify the 10 s undo timeout or the revert semantics from a static mock. (c) Architect open item 1 (slice 1 is "review only") is unresolved, so the commit meaning isn't settled. |
| B2 | **pass with notes** | Every option shows the same two values, in the same order, in mono: `Weight 0.5× · Deflection 8×`. The assumption is stated once above the list. Each option has a 44 px Evidence link that opens a calculation sheet. Rows are 72 px. Using ratios meets the intent. They're comparable, they're traceable to physics (weight ∝ t, bending deflection ∝ 1/t³ under the same load, span and supports, which is correct), and they're honest that material and load are unknown. Inventing 6061 / 10 lbf would have been worse. Three things are still needed for a clean pass: **(1)** Make the direction explicit, because "Deflection 8×" can read as 8× stiffer. Use `8× more deflection` and `0.125× deflection (8× stiffer)`. **(2)** "recommended" still has no stated basis on screen. Either add the reason ("common stock size"), labeled as a convention and not evidence, or rename it to `default`. **(3)** Name the scaling law on the Decide screen itself, not only in the sheet, e.g. "bending, same span". |
| B3 | **pass with notes** | Direct and Empty now render `Working none · Committed none` in the same 44 px slot. Note: the SPEC says "always rendered", but Offline replaces the line with a banner. That's a new blocker (N1). |
| W1 | **pass with notes** | The hint now reads "Skip uses 0.250 in as a recorded guess. You can change it later from Decisions; Jarvis then runs CAD again." Result has a 44 px link: "Thickness 0.250 in was a recorded guess. Change". Notes: architect open item 2 (change after checkpoint is a steer) may reverse this copy. The link also appears on Committed (see N5). And the link is hard-coded, so I can't verify it only appears when the user actually skipped. |
| W2 | **pass with notes** | Selection is shown by a 2 px border plus a filled radio dot, so it isn't color-only. The script rewrites `#approve` to `APPROVE <value>` on tap (verified in the code, not run). Note: the buttons carry both `role="radio"` and `aria-pressed`, and there's no arrow-key or roving tabindex. See N6. |
| W3 | **pass** | The `.alt/.state/.link/.evrow/.view:focus-visible` outline rule now comes after the `all:unset` rules (2 px accent, offset 2). |
| W4 | **fail** | `--control-border:#5A5A62` is **2.82:1** on #0E0E10 and **2.59:1** on surface #18181B (snackbar, sheets). Both are under 3:1. My v3 estimate ("about 3:1") was wrong. Fix: use `#6A6A72` (3.60:1 on bg, 3.30:1 on surface). It's still quiet. |
| W5 | **pass with notes** | Result has an inline 44 px row: "Independent check passed · REPORT". It's been removed from MORE. Not inventing check counts is correct. Note: the row **disappears on Committed** (N2). |
| W6 | **pass** | The status text is gone. Parallel has ghost PAUSE / CANCEL. MORE appears only on the result card. I can't verify whether CANCEL asks for confirmation. |
| W7 | **pass** | The headline is `4.000 × 4.000 × 0.250 in`, with mm muted underneath. "Show mm" is in the sheet. |
| W8 | **pass with notes** | Empty, Paused, Failed, Checkfail and Offline exist in the v3 visual language with correct targets. Notes: Offline is broken (N1). Failed and Paused still say `Working PLATE R1` when no model exists (N3). Checkfail offers only RETRY CAD, with no route to change the decision that may have caused the failure. Add a "Change thickness" link. |
| W9 | **pass with notes** | All three sheets have a 36×5 grabber and a title. MORE has a 52 px Cancel row after a separator, and the backdrop is 0.5. Not verifiable: there are no swipe or backdrop-tap handlers in the mock ("build requirement"), and no focus trap or initial focus for the `aria-modal` sheets. Evidence uses CLOSE and Commit uses CANCEL. That's acceptable, but pick one word. |
| M1 | **pass with notes** | The hamburger and the up-arrow circle are 24 px glyphs with 44 px targets and aria labels. SEND is always muted with no `disabled` while the field is empty. Add `disabled` and use text color when there's content. |
| M2 | **pass** | Mono labels are 13 px at .04em. The `SAMPLE DATA` mock label stays 11 px at .08em, which is fine since it isn't product UI. |
| M3 | **pass** | `WORKING · 1:42` is shown in text color on the active lane. There's no motion, which is quiet. |
| M4 | **pass** | The primary action row sits in the dock above the composer on Direct, Decide, Paused, Failed, Result and Checkfail (visible at 430 and 375). |
| M5 | **pass** | The disclaimer is gone from Result. I can't verify the viewer banner because no viewer screenshot exists. |

## New findings

### Blocker
**N1 · Offline · The Working/Committed line disappears, and the screen shows stale live work.**
The code is `state==="offline" ? banner : stateLine(...)`. The banner *replaces* the state line, so Offline breaks the "explicit on every screen" rule. The lanes still say `WORKING · 1:42` in live text color, and PAUSE/CANCEL look active, although nothing can be confirmed. The banner also wraps to two lines at both 430 and 375.
Fix: Keep the state line and prefix it: `Offline · Working PLATE R1 · Committed none`. Put RETRY as a ghost button at the right of the same 44 px row, or add a second 44 px row under it. Freeze the lanes to `LAST SEEN WORKING · 1:42` in muted color, and either disable PAUSE/CANCEL (`aria-disabled`) or label them "queued". Shorten the copy to `Offline · sends on reconnect`.

### Worth fixing
**N2 · Committed · The state is ambiguous and the evidence vanishes.**
The line reads `Working PLATE R1 · Committed PLATE R1`, so it's unclear whether work is still running. The code also strips the `.evrow` on Committed. The evidence row is gone at exactly the moment the decision is on record.
Fix: After commit, show `Working none · Committed PLATE R1`. Keep the evidence row, changing it to "Independent check passed · committed with report".

**N3 · Parallel / Decide / Failed / Paused · "Working PLATE R1" appears before a candidate exists, and the sequence contradicts itself.**
Decide says "One judgment call before CAD", but Parallel already shows `CAD model WORKING · 1:42`. Failed says "returned no model" while the state line names PLATE R1 as Working.
Fix: Until a model exists, show `Working PLATE R1 (in progress)`, or name the job and not the candidate. When a decision is pending, the CAD lane should read `WAITS FOR YOU`, not WORKING.

**N4 · Evidence sheet · The formula column wraps mid-expression.**
At 430 and at 375, `0.125 / 0.250 = 0.5×` and `(0.250 / 0.125)³ = 8×` break across lines, so the core evidence is hard to read.
Fix: Stack each row with the label on top (13 px muted) and the formula below (13 px text, `white-space:nowrap`). Add the result in words: `8× more deflection`.

**N5 · Committed · The "recorded guess. Change" link stays on a committed candidate.**
Changing it would re-run CAD against something already committed, and the screen doesn't say what that does to the baseline.
Fix: On Committed, change it to "Thickness 0.250 in was a recorded guess. Change starts a new working candidate", or move it into MORE › Decisions.

### Minor
**N6 · Decide · ARIA radios are inconsistent.** The buttons have `role="radio"` plus `aria-pressed`, and there's no arrow-key or roving tabindex. Fix: drop `aria-pressed`, keep `aria-checked`, set `tabindex=0` only on the checked option, and move selection with the arrow keys.

**N7 · Noise · Three "Evidence" links and a redundant sheet title.** The three right-aligned 44 px Evidence links add about 130 px and three repeated words to the quietest decision in the flow. The Commit sheet title "COMMIT PLATE R1" repeats the body question and the button. Fix: make each option's metrics line the evidence target (an info glyph at the end of the row with a 44 px hit area), or use one "How these are calculated" link under the assumption. Drop the Commit sheet h2.

**N8 · Checkfail · No way to change the decision from failure.** Only RETRY CAD is offered. Fix: add a link, "Change thickness (recorded guess)".

## Noise check (founder: quiet like Claude)
Most fixes stayed quiet. There's still one accent per screen (checks: max 1), no new color, and the evidence row and ratios are mono and muted. Three fixes added noise: the triple Evidence links (N7), the two-line offline banner (N1), and the duplicate commit sheet title (N7). The pinned dock buttons and the snackbar are fine.

## Overall verdict
**Not yet ready to ship. Close.** v4 clears all 3 v3 blockers in substance. The loop now reaches commit, Decide offers comparable evidence-backed alternatives, and Direct shows state. B2's ratios-only approach meets the intent once the direction and the basis for "recommended" are explicit. Two things block sign-off: **W4 still fails contrast (2.82:1)**, and **Offline drops the Working/Committed line (N1)**. Committed state clarity (N2) and Working-before-candidate (N3) should be fixed alongside them because they weaken the same North Star rule. Architect open items 1 and 2 (commit meaning, change after checkpoint) can still overturn B1 and W1 copy.

## Couldn't verify
Live interactions (selection binding was only read in code; sheet dismissal, swipe, focus trap, undo timeout, CANCEL confirm), the 3D viewer banner, Dynamic Type, landscape, VoiceOver order, and real standalone PWA chrome. I viewed 4 of the 13 375 shots plus the combined strip. The remaining 375 shots weren't individually inspected, so I relied on checks-report for them (no overflow, targets ≥44).
