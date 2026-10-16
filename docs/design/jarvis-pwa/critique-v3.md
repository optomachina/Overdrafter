# Critique: Jarvis PWA v3 (OVD-799), 430 px

**User and goal:** A manufacturing or design engineer on a phone types a part they want ("Make a 4 inch square plate"). They want to point Jarvis at the outcome, make the few judgment calls that matter using real evidence, and approve a candidate. Agents do the work in parallel.

**Verdict:** It's quiet now, and that brief is met. v3 has one accent per screen, no cards inside cards, hairline lists, and a single composer. It reads close to the Claude app. It does **not yet meet the North Star**. Nothing on any screen lets you commit a candidate, so the loop never reaches "approve." The alternatives on Decide are described in words, with no evidence you can compare. The Working/Committed line is missing from the first screen. Fix the 3 blockers before more visual polish.

Sources: the 5 v3 screenshots (viewed), `mock/v3.html` (code read), and `checks-report.json`. v2 has a mock and screenshots but no critique, and `/workspace/critiques/` had no Jarvis fix list. **There are no earlier findings to mark cleared or open.** This is the baseline list.

---

## Ranked findings

### Blockers

**B1 · Result (and More sheet) · No way to commit the candidate.**
What the user trips on: The screen says "Working candidate. Nothing is committed." Then it offers only OPEN 3D and MORE. The More sheet has Evidence, Decisions, AR, Download STEP, and Show inches. Nothing promotes PLATE R1 to Committed, so the engineer can't finish the job, and "approve decisions" stops at intermediate choices.
Fix: Make the primary action on Result `COMMIT PLATE R1`, a filled accent button, full width, 48 px tall, below the model card. Demote OPEN 3D to a secondary outline button (or keep it as the tap on the model image, which already opens 3D). On tap, open a confirm sheet: "Commit PLATE R1 as baseline? Previous baseline: none. You can revert from History." It needs two buttons: `COMMIT` and `CANCEL`, each at least 48 px. After commit, change the state line to `Committed PLATE R1` and show an undo snackbar for 10 s. Keep one accent per screen by making OPEN 3D an outline button.

**B2 · Decide · The alternatives aren't backed by evidence or comparable.**
What the user trips on: The prompt says "each option is compared on stiffness, weight and machining." But each option has one line of prose ("Lighter. Flexes more under load."). There are no numbers, no shared axes, and no source. "Recommended" rests on "common stock thickness," which is a convention, not evidence. An engineer can't check the trade-off.
Fix: Give each `.alt` the same 3 values in a fixed order, in 13 px mono and tabular figures. Example: `Defl. 0.004 in @ 10 lbf · 0.57 lb (6061) · Mach. 1.0×`. Show the values as deltas from the recommended option on the other rows (`+8× defl.`, `−50% wt`). State the assumption once above the list ("Assumes 6061-T6, edge-supported, 10 lbf center load; tap to change"). Add an `Evidence` link on each row (44 px tall) that opens the calculation. Raise the row min-height from 56 to 72 px to fit this.

**B3 · Direct · The Working/Committed state isn't shown.**
What the user trips on: The code shows the state line only when the screen isn't Direct (`state==="direct"?"":stateLine(...)`). The first screen has no Baseline/Working/Committed indicator, so the "explicit on every screen" rule fails at the moment the user is deciding to start.
Fix: Always render the state line. On Direct, show `Baseline none · Working none · Committed none`, or a single line: `Nothing running · nothing committed`. Use the same 44 px row so the layout doesn't jump on START.

### Worth fixing

**W1 · Decide · It's unclear whether Skip can be undone, and the copy contradicts itself.**
What the user trips on: "You can change it until CAD starts." But this decision is the gate before CAD. Once Skip records the guess, CAD starts, so the change window is about zero. The Result screen then calls 0.250 "a recorded best guess" and gives no visible way to change it.
Fix: Rewrite the hint to "Skip uses 0.250 in as a recorded guess. You can change it later; CAD will re-run." On Result, make the "recorded best guess" sentence a link to Decisions (min 44 px), so changing it is one tap.

**W2 · Decide · The APPROVE label doesn't visibly follow the selection, and selection is shown by border color only.**
What the user trips on: The selected option differs only by border color (#F2F1EE vs #2A2A2F, same 1 px width). In the static mock, APPROVE is hard-coded to "0.250 IN". I couldn't verify that it updates when another option is tapped.
Fix: Bind the button label to `aria-pressed` (`APPROVE 0.500 IN`). Show selection with a 2 px border plus a leading check glyph (16 px) or radio dot, so it doesn't rely on color.

**W3 · All · No keyboard focus ring on the option cards and the state line.**
What the user trips on: `.alt` and `.state` use `all:unset`. That rule has the same specificity as the global `:focus-visible` rule and comes later in the file, so it resets `outline` and these controls show no focus ring (VoiceOver, external keyboard, Switch Control).
Fix: Add `.alt:focus-visible,.state:focus-visible{outline:2px solid var(--accent);outline-offset:2px}` after those rules.

**W4 · All · Secondary control borders are almost invisible (1.35:1).**
What the user trips on: The `--hairline` color #2A2A2F on #0E0E10 measures 1.35:1. EDIT, SKIP, SEND, the unselected alternatives, and the composer field are recognizable only by their text. WCAG 1.4.11 wants 3:1 for UI component boundaries.
Fix: Use a separate `--control-border:#5A5A62` (about 3:1 on #0E0E10) for buttons, inputs, and option cards. Keep #2A2A2F for list dividers only, so it stays quiet.

**W5 · Result · Evidence is buried in an overflow menu.**
What the user trips on: "Independently checked" is the core claim, but you only reach the check results through MORE, item 1. The North Star says to inspect evidence before approving.
Fix: Add a one-line evidence row under the model card: `Check passed · 3/3 · dims, flatness, STEP validity  ›` (44 px tall, 14 px). Make it tappable to open the report. Remove "Evidence and check results" from the sheet.

**W6 · Parallel · Working state is said twice; MORE has two meanings.**
What the user trips on: The state line ("Working PLATE R1 · Committed none") sits right above the status row ("Working · nothing committed"), which is redundant chrome on a screen meant to be calm. The status row's MORE means pause/cancel, while MORE on Result means candidate options.
Fix: Drop the text from the status row and keep its control as `PAUSE / CANCEL` (or a "⋯" icon with aria-label "Job options"). Alternatively, fold job controls into the state line's tap target. Use MORE in only one place.

**W7 · Result · Units mismatch.**
What the user trips on: The user asked in inches. The headline answers "101.6 × 101.6 × 6.35 mm" and hides "Show inches" in the overflow menu.
Fix: Default to the units of the request: "4.000 × 4.000 × 0.250 in", with mm secondary in muted 13 px. Leave the units toggle in the sheet.

**W8 · All v3 states · No loading, error, empty, or failed-check states.**
What the user trips on: The v3 mock defines only direct/parallel/decide/result/more. There's no state for CAD failing, the independent check failing, a lost connection, a first-run empty thread, or a paused or canceled job. The older root screenshots (thread-error, paused, canceled, viewer-error) have these, but they weren't carried into the v3 language.
Fix: Add v3 states for: lane `FAILED` with Retry and View log (44 px); check failed, with "Not committable" and the reason in place of the commit action; offline banner in the state-line slot; empty thread with 2 or 3 example prompts as chips; and paused/canceled in the lanes.

**W9 · More sheet · iOS sheet conventions are missing.**
What the user trips on: There's no grabber, no Cancel, and no title. Dismissing relies on tapping the dimmed area, if that works at all (I couldn't verify). The dim backdrop leaves the Working state line hard to read while it's open.
Fix: Add a 36×5 px grabber at the top, a title row "PLATE_R1", and a final `Cancel` row (52 px). Support swipe-down to dismiss. Reduce the backdrop to `rgba(0,0,0,.5)`.

### Minor

**M1 · Header · Text labels in place of iOS icons.** "MENU" and "SEND" in 12 px uppercase mono tracked at .08em read like a terminal, and MENU's job is unclear. Fix: Use a 24 px SF-style icon (line.3.horizontal or sidebar) with aria-label. Make SEND an arrow.up circle (32 px glyph, 44 px target), disabled while the field is empty.

**M2 · All · Small mono labels.** The 12 px muted mono is used for state, lanes, and the Direct key column (OUTCOME/OPEN/PLAN). Contrast passes at 7.69:1, but 12 px uppercase with tracking is the hardest text on the page to read. Fix: Use 13 px with letter-spacing .04em. Bold values in the state line are fine.

**M3 · Parallel · Lanes feel static.** "WORKING" is a plain word, with no sign it's live or how long it'll take. Fix: Add elapsed time (`WORKING · 0:42`) or a 1 px indeterminate bar under the active row, with `prefers-reduced-motion` respected.

**M4 · Direct/Decide/Result · Primary actions sit mid-screen.** START and APPROVE are at about y 450–570 of 932, which is reachable but not in the natural thumb zone. The bottom 40% of the screen is empty above the composer. Fix: Optionally pin the current primary action row above the composer (with a 12 px gap) while it's pending.

**M5 · Result · The disclaimer copy is heavy.** "STEP is the authoritative file; the 3D view is for review" adds a third muted paragraph. Fix: Move it into the 3D viewer, and keep "Working candidate · not committed" in the state line.

---

## What's working
- **Quietness is solved:** one accent per screen (checks-report accentElements ≤ 1), a near-monochrome palette, hairline lists in place of cards, and no tab bar or badges. It reads like the Claude app.
- **Direction is clear:** Direct restates the request as Outcome / Open / Plan, and "Nothing runs until you start it" makes the start safe.
- **Parallel lanes:** progress shown as text states (DONE / WORKING / WAITS FOR CAD), not color, with `aria-live="polite"`. It's informative without noise.
- **One decision, framed well:** "One judgment call before CAD." The recommended option is preselected, and the action names the value ("APPROVE 0.250 IN").
- **State line wording:** "Baseline / Working / Committed" is spelled out as text, not color, and the accessible label is good.
- **Basics in code:** `--tap:44px` is applied to buttons; sheet rows are 52 px; the composer is 16 px (no iOS zoom on focus); top and bottom safe-area insets are handled; there's no horizontal overflow at 430. Text contrast: text 17.07:1, muted 7.69:1, accent button text 7.39:1, all passing AA.

## What I couldn't verify
- Real interactions: whether tapping an option updates APPROVE, how the sheet dismisses, what EDIT does, what the state line opens, and the transitions.
- Behavior at 375 px for v3 (only 430 screenshots exist), Dynamic Type scaling, landscape, and PWA standalone status bar rendering.
- VoiceOver order and announcements on device. aria-live is present, but I didn't hear it.
- The real 3D/AR viewer and STEP download for v3.
- Earlier-critique status: no v1/v2 critique or Jarvis fix list existed, so nothing is marked cleared.
