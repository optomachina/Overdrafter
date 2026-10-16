# Jarvis PWA, slice 1: thread, skippable decision cards, 3D result view

Issue: OVD-799 (split child of OVD-795). Owner: Designer, then Engineer (OVD-803 PWA shell and gate, OVD-804 thread and 3D; OVD-800 closed as a duplicate of OVD-803) after sign off.
Repo path: `docs/design/jarvis-pwa/` (this folder). Status: **v4.1 APPROVED by Blaine, 2026-10-16 (v3 plus the Critiquito fixes, plus the v4 recheck fixes).** v1, v2 and v3 are superseded. Their mocks, screenshots and tools were removed from the repo (recover them from git history at cb307e09 or earlier); the sections below keep only their reasoning. Chat as the primary surface is allowed only in the Jarvis phone app; the customer quote workspace ban in `docs/DESIGN.md` still stands. Jarvis shows inches by default with mm as the secondary unit.
Inputs read: OVD-799, OVD-795 (incl. architect comment 5b0ca055 and the 8:35/8:36 PM AR and job control comments), OVD-481, OVD-781, `docs/DESIGN.md`, `src/lib/engineering-workbench-access.ts`.
All values in the mock and screenshots are **sample data** (labeled on screen). Nothing here is a real Jarvis output.

## v4.1. Recheck fixes (APPROVED, current)

Applied in place to v4 after the Critiquito recheck (`recheck-v4.md`). Source `tools/index.v4.src.html`; same build, shoot and screenshot paths as v4. v4.1 supersedes the v4 table below where they differ.

| Id | Change in v4.1 | Where |
|---|---|---|
| W4 | `--control-border` now #6A6A72: 3.60:1 on bg, 3.30:1 on surface | CSS |
| N1 | Offline keeps the state line in one 44px row: "Offline · Working PLATE R1 · Committed none" with RETRY at the right; lanes muted "LAST SEEN WORKING · 1:42"; PAUSE and CANCEL disabled; the two line banner is gone | `offline` |
| N2 | Committed shows "Working none · Committed PLATE R1" and keeps the evidence row: "Check passed · committed with report" | `committed` |
| N3 | No Working model before one exists: Decide, Evidence and Failed show Working none; Parallel and Paused show "Working PLATE R1 (in progress)". On Decide the CAD lane reads WAITS FOR YOU | `decide`, `evidence`, `failed`, `parallel`, `paused` |
| N4 | Evidence sheet stacks label over formula; formulas never wrap and end with the result in words ("half the weight", "8× more deflection") | `evidence` |
| N5 | Committed link reads "Thickness 0.250 in was a recorded guess. Change starts a new working candidate" | `committed` |
| B2 | Direction explicit: "0.5× weight · 8× more deflection", "2× weight · 0.125× deflection (8× stiffer)", reference row "Reference weight · reference deflection". "recommended" renamed "default" (no on screen basis). Scaling law named on Decide: "Weight scales with thickness; bending deflection scales with 1 / thickness³ for the same material, load, span and supports." | `decide` |
| M1 | SEND is disabled while the message field is empty and turns text colored when it has content | composer |
| W9 | Sheets use CANCEL consistently (evidence sheet CLOSE renamed) | sheets |
| N6 | Options are a true radiogroup: `aria-checked` only (no `aria-pressed`), roving tabindex, arrow keys move selection, APPROVE label follows | `decide` |
| N7 | One "How these are calculated" link under the assumption replaces the three per option Evidence links; commit sheet title removed (the question is the label) | `decide`, `commit` |
| N8 | Checkfail adds "Change thickness (recorded guess)" | `checkfail` |
| Other | State line set in 13px sans so it fits one line at 375; a state line clipping check was added | all |

Not done (not verifiable in a static mock, stay build requirements): undo timeout and revert semantics, swipe and backdrop dismiss, focus trap and initial focus in sheets, cancel confirm from Parallel. Architect open items 1 to 3 below still stand.

### v4.1 checks (`node tools/shoot.v4.js`)
All 13 states at 430 and 375: rendered; control border contrast at least 3:1 against both bg and surface (new); state line not clipped (new); no horizontal overflow; nothing under 11px; every control at least 44 × 44; no hyphen, dash or ellipsis; at most one accent element; sample label; no script errors. Last run: **26/26 pass** (contrast 3.60 on bg, 3.30 on surface).

## v4. North Star command loop plus Critiquito fixes (approved 2026-10-16; refined by v4.1)

Approved by Blaine on 2026-10-16 as "v3 plus your fixes from the Critiquito pass". Critique: `critique-v3.md`; fix list: `/workspace/critiques/jarvis-pwa/fix-list.md` (not kept in the repo).
Files: `tools/index.v4.src.html` → `tools/build.v4.py` → `mock/v4.html` (`?state=`); `tools/shoot.v4.js` → `screenshots/v4/<state>-430.png` (full page), `screenshots/v4/375/<state>-375.png`, `screenshots/v4/combined-direct-parallel-decide-result-committed.png`, `screenshots/v4/checks-report.json`.

**States (13):** `empty`, `direct`, `parallel`, `decide`, `evidence` (calculation sheet), `result`, `commit` (confirm sheet), `committed` (with undo), `more` (sheet), `paused`, `failed` (CAD failed), `checkfail` (independent check failed, not committable), `offline`.

**Rules kept:** chat only in the Jarvis phone app; dark theme, `#FF7A1A` as the single accent, at most one accent element per screen; 44px targets; 11px minimum text; no hyphens, dashes or ellipsis in copy; one line sample data label; no invented data. **Units:** inches by default, mm secondary (muted line and the "Show mm" item in the MORE sheet). This supersedes the mm default from v1 Decision 5 for display only; STEP export stays in mm.

### Fixes
| Id | What changed | Where |
|---|---|---|
| B1 | COMMIT PLATE R1 is the primary filled action, pinned above the composer; confirm sheet "Commit PLATE R1 as baseline? Previous baseline: none. You can revert from History." with COMMIT and CANCEL (48px); after commit the state line reads Committed PLATE R1 and an UNDO snackbar shows (10 s in production). OPEN 3D demoted to outline | `result`, `commit`, `committed` |
| B2 | Each option shows the same two comparable values: Weight and Deflection as ratios to 0.250 in, computed only from the sample thicknesses (weight scales with t, plate deflection with 1/t³). Assumption stated once (same material, load and supports; material not specified; machining not estimated; sample data). Evidence link (44px) per option opens the calculation. Rows 72px. The critique's example numbers (6061, 10 lbf, lb, in of deflection) were not used because they would be invented | `decide`, `evidence` |
| B3 | State line always rendered, including `direct` and `empty` (Working none · Committed none); 44px row, no layout jump. Shortened to Working and Committed so it fits on one line at 375; Baseline is in the aria label and the history it opens | all screens; `offline` replaces it with the offline banner in the same slot |
| W1 | Hint: "Skip uses 0.250 in as a recorded guess. You can change it later from Decisions; Jarvis then runs CAD again." Result line "Thickness 0.250 in was a recorded guess. Change" is a 44px link | `decide`, `result` |
| W2 | Selection uses a 2px border plus a radio dot (not color alone), role radio; APPROVE label follows the selection in the mock script | `decide` |
| W3 | Focus ring rule added after the `all:unset` rules for options, state line, links, evidence row, model view | CSS |
| W4 | New `--control-border:#5A5A62` for buttons, inputs, options and chips; `--hairline` kept for dividers | CSS |
| W5 | Inline evidence row under the model: "Independent check passed · REPORT" (44px). No check count or check names are shown because none exist in the sample; removed from the MORE sheet | `result`, `checkfail` |
| W6 | Status row text removed; job controls are PAUSE and CANCEL; MORE now appears only on the result card | `parallel` |
| W7 | Headline in inches "4.000 × 4.000 × 0.250 in", mm muted underneath | `result`, `committed` |
| W8 | Added empty (one example chip, from OVD-795), paused (RESUME, CANCEL JOB), CAD failed (RETRY CAD, VIEW LOG), check failed (not committable, reason in report, RETRY CAD), offline (banner in the state line slot, RETRY) | new states |
| W9 | Sheets get a 36×5 grabber, a title row, a final Cancel row (52px); backdrop 0.5; swipe down to dismiss is a build requirement | `more`, `commit`, `evidence` |
| M1 | MENU and SEND are icon buttons (24px glyph, 44px target, aria labels) | header, composer |
| M2 | Mono labels raised to 13px with .04em tracking | CSS |
| M3 | Active lane shows elapsed time "WORKING · 1:42" (sample value reused from v1) | `parallel` |
| M4 | Pending primary action row pinned above the composer | `direct`, `decide`, `paused`, `failed`, `result`, `checkfail` |
| M5 | "STEP is authoritative" disclaimer removed from the result; it stays as the 3D viewer banner (v1 §5.9) | `result` |

### Open items for the Architect
1. **Commit action conflict.** The architect answered "No Commit action in slice 1; plate is review only" (§10 Decision 1). Blaine approved B1, so v4 draws COMMIT with confirm and undo. Architect to confirm what commit means in slice 1 (OVD-472 states: decision, execution, verification and authoritative adoption are distinct; the North Star says a candidate is not Committed until adoption is verified) and whether undo is a revert to the prior baseline.
2. **Change after checkpoint.** v4 copy says a recorded guess can be changed later and Jarvis runs CAD again; §10 Decision 2 says after the checkpoint a change is a steer (OVD-812). Architect to confirm the copy, or the locked state from v1 returns.
3. **Units default.** Inches default (Blaine, 2026-10-16) supersedes the mm display default in Decision 5; STEP export stays in mm.

### v4 checks (`node tools/shoot.v4.js`)
All 13 states at 430 and 375: rendered, no horizontal overflow, no text under 11px, every control at least 44 × 44, no hyphen, dash or ellipsis in copy or aria labels, at most one accent element, sample label present, no script errors. Last run: **26/26 pass**.

> **History.** v3 was approved on 2026-10-16 and then superseded by v4 (v3 plus Critiquito fixes). It follows the Linear North Star (document ee801d1f, "OverDraft North Star — General Engineering Intelligence & Execution", and project "North Star Prototype — General Engineering Command Loop"). v3 supersedes v2 where they conflict. v2 and v1 stay for reference. Notes with exact quotes: `notes/north-star-notes.md`.

## v3. North Star command loop (SUPERSEDED by v4, history only)

Files named in this section were removed from the repo; see git history at cb307e09.

Files: `tools/index.v3.src.html` → `tools/build.v3.py` → `mock/v3.html` (`?state=direct|parallel|decide|result|more`); `tools/shoot.v3.js` → `screenshots/v3/{direct,parallel,decide,result,more}-430.png`, `screenshots/v3/combined-direct-parallel-decide-result.png`, `screenshots/v3/checks-report.json`.

Same quiet frame as v2 (plain thread, no badges, one accent per screen, 11px sample line). Four key states:
| State | What the engineer does | North Star source |
|---|---|---|
| `direct` | States an outcome. Jarvis shows how it read the request (Outcome, Open, Plan) and nothing runs until START | Decision: "Engineers direct outcomes"; Principle 1 "Intent over application commands"; Jarvis step 2 "Interpret the intended outcome, constraints, tradeoffs, authority, and uncertainty"; OVD-494 "Sending text alone never creates an accepted decision or starts CAD." |
| `parallel` | Nothing; work lanes list in the reply (Concept picks Done, CAD model Working, Independent check Waits for CAD) with one status line `Working · nothing committed` and MORE for pause and cancel | Principle 3 "Parallel thought, controlled commits"; Principle 6 "Exception-driven human involvement"; OVD-520 "truthful execution versus verification states". Lanes are only the slice 1 stages (OVD-795 req 12); no other agents are drawn because none run in slice 1 |
| `decide` | Inspects alternatives, each with its consequence; APPROVE the recommended one, pick another, or SKIP (best guess stated and recorded) | Decision: "inspect evidence-backed alternatives, resolve exceptions, and approve decisions"; Principle 5 "Evidence before approval"; Jarvis step 6 "Present decisions with evidence, assumptions..." The stated assumption (material not specified) is the only evidence the sample has; no cost or lead time is invented |
| `result` | Sees a Working candidate, independently checked, explicitly not committed, baseline unchanged; OPEN 3D; evidence and check results behind MORE | "The interface must never represent Working state as Committed merely because a speculative visualization looks correct."; "The creating agent does not solely judge its own result."; Principle 7 "Native deliverables remain authoritative" |

Baseline / Working / Committed returns as **one quiet tappable line** under the header (cut in v2): project constraint "Baseline, Working, and Committed states remain explicit." It is hidden on `direct` because nothing exists yet.

### v2 conflicts with the North Star (fixed in v3)
1. v2 cut the Baseline / Working / Committed strip; the project requires the states to stay explicit.
2. v2 sent the request straight into work; the North Star asks for interpretation first and OVD-494 forbids text alone from starting CAD.
3. v2 said "The plate is ready" with no Working vs Committed or verification distinction; the North Star forbids implying Committed and requires independent verification to be visible.
4. v2 hid evidence and alternatives' consequences (chips only); Principle 5 requires recommendations to expose assumptions and consequences before approval.
5. v2 framed the job as one assistant reply streaming; the North Star frames specialized agents working in parallel, so v3 shows lanes (still quiet text, no pipeline card).

### v3 checks (`node tools/shoot.v3.js`)
Same as v2 (overflow, 11px, 44px, no dash or ellipsis, at most one accent element, sample label, no script errors). Last run: 5/5 pass.

> **History.** v2 (2026-10-15, 9:30 PM PT) superseded v1 and is itself superseded by v3. v1 (sections 1 to 11 below) is superseded by v3 for layout, chrome and states; its behavior notes remain reference only. Blaine: "It's too busy, needs to be less." v2 below is the current direction. Sections 4 to 9 describe v1 and stay for reference: they still apply for behavior (events, idempotency, AR detection, model-viewer, gate, units data, decisions in §10) but **not** for layout, chrome or the state list wherever v2 says otherwise.

## v2. Quiet chat (SUPERSEDED by v3, history only)

Files named in this section were removed from the repo; see git history at cb307e09.

Files: `tools/index.v2.src.html` → `tools/build.v2.py` → `mock/v2.html` (`?state=working|question|result|more`); `tools/shoot.v2.js` → `screenshots/v2/{working,question,result,more}-430.png`, `screenshots/v2/combined-working-question-result.png`, `screenshots/v2/checks-report.json`. v1 files are untouched.

### Model
It reads like a reply in the Claude app: a plain thread where your message is a quiet tinted block and Jarvis's reply is plain streaming text, with no labels, cards or timestamps.
- **Working:** the reply streams in as text (caret while streaming). Under it, one muted status line: `Working on CAD · 1:42` with a `MORE` button. Pause and Cancel live behind MORE (v1 §5.4 behavior, including `PAUSING` and the cancel confirm, unchanged, only moved).
- **Question:** the graph decision is asked in the reply text. Options are inline quick-reply chips. The recommended value is the only accented chip. Skip is a chip that states the best guess: `Skip · use 0.250 in`. One muted line explains the skip is recorded and can be changed until the next checkpoint uses it. After that, changing it is a steer through the composer (OVD-812).
- **Result:** one sentence notes the recorded guess; one sentence gives the size (mm, sample) and "STEP is the authoritative file; the 3D view is for review." An inline 3D card shows the picture (tap opens the model-viewer view) with one filled `OPEN 3D` and a `MORE` that opens a menu with View in AR, Download STEP, Show inches, and Details and recorded guesses.
- One accent per screen, at most (checked by `shoot.v2.js`). Sample data banner shrunk to one 11px line; the model is labeled `PLATE_R1 · sample`.

### Cut, and why
| Cut in v2 | Where it went | Rationale (citation) |
|---|---|---|
| Baseline / Working / Committed strip and its note | Removed. Committed is NONE in slice 1 anyway (§10 Decision 1); state can come back under MENU when commits exist | `docs/DESIGN.md` § Aesthetic direction: "Decoration level: Minimal" and "Mood: Quiet authority"; § Color, Accent rules: never "Multiple simultaneous emphases on one screen" |
| Stage pipeline card (INTAKE, CONCEPT PICKS, CAD, VERIFY, RESULT), progress bar, pinned strip | One status line that names the current stage | OVD-795 req 8 "Let it cook: Jarvis only interrupts for real questions or key choices"; `docs/DESIGN.md` § Motion "Forbidden: anything that delays the user from seeing data" |
| Permanent PAUSE / CANCEL / VIEW IN AR / DOWNLOAD STEP buttons, unit toggle | Behind MORE (one tap) | `docs/DESIGN.md` § Units toggle: the chrome level toggle "was deliberately removed. It cluttered the global command strip" |
| Tags and badges (SAMPLE on every card, RECOMMENDED, BEST GUESS, SKIPPED · RECORDED, AUTHORITATIVE, LOCKED) | Plain words in the reply sentence | `docs/DESIGN.md` § Forbidden layouts "Bubbly badges or pill UI"; § Anti slop checklist "Bubbly status badges with background fills" |
| Decision card panel with radio rows and two full width buttons | Quick reply chips (radius 4, not pills) | OVD-795 req 13: decision cards are the graph's decision points and every one can be skipped with a recorded best guess; chips keep that with less chrome |
| Facts list, file list, YOU / JARVIS labels, timestamps, control lines | Details and recorded guesses (MORE menu); reply text | `PRD.md` § Long term product direction: work must stay "structured, reviewable, and auditable", so the recorded guess is kept, one tap away, not deleted |

### Kept on purpose (required by the docs)
- The 3D result as an artifact card, not text only, and "STEP is the authoritative file": `PRD.md` § Client workspace surface ("Chat style interaction ... must not replace structured artifacts"); v1 §5.9 (OVD-484).
- Recorded best guess stated in the thread: OVD-795 req 8 ("proceeds with a best guess (and records it)").
- No avatar, no bubbles above radius 4, no shadows, no emoji, declarative voice: `docs/DESIGN.md` § Anti slop checklist, § Border, radius, and elevation, § Voice.

### Resolved tension (approved 2026-10-16)
`docs/DESIGN.md` § Forbidden layouts lists "AI assistant chat widgets as the primary information surface", and `PRD.md` § Non goals excludes "real time chat ... as a core workflow surface". Both target the customer quote workspace. Jarvis is a separate phone surface whose brief (OVD-795 req 1) is "users type to Jarvis", so v2 keeps chat as the frame but makes the result an artifact card, consistent with the PRD exception for the engineering lane (`PRD.md` § Client workspace surface, `/dev/engineering` paragraph). Resolved by Blaine on 2026-10-16: chat is allowed as the primary surface only in the Jarvis phone app; Decisions row added to `docs/DESIGN.md`.

### v2 checks (`node tools/shoot.v2.js`, 430 wide, full page)
No horizontal overflow; no text under 11px; every control at least 44 x 44; no hyphen, dash or ellipsis characters in copy or aria labels; at most one accent element per screen; sample label present; no script errors. Last run: 4/4 pass (working, question, result, more).

### v1 superseded items
§4 state list (layout), §5.2 strip, §5.3 status card and pinned strip, §5.4 permanent control buttons (behavior kept), §5.5 to §5.7 card layouts and tags, §2 "filled accent buttons" rule (now one accent per screen), §8 criteria 1 and 11 (strip on every screen).

## 1. Folder contents

Files named in this section were removed from the repo; see git history at cb307e09.

| Path | What |
|---|---|
| `SPEC.md` | This spec |
| `mock/index.html` | Self contained static mock (fonts inlined, no network). State switcher at the top; `?state=<id>` deep links; `?shot=1` hides the switcher for captures |
| `tools/index.src.html`, `tools/build.py` | Mock source and the builder that inlines subset fonts into `mock/index.html` |
| `tools/shoot.js` | Regenerates every screenshot and runs the D-1..D-4 checks |
| `screenshots/<state>-<375or430>.png` | 38 captures, 19 states x 2 widths |
| `screenshots/checks-report.json` | Machine readable check results |
| `council/` | Round 1 draft, round 1 critique, round 2 critique, round 1 screenshots |

## 2. Visual direction and DESIGN.md alignment

- Dark surface with `#FF7A1A` accent, per Blaine's direction for Jarvis. `docs/DESIGN.md` defaults to bone daylight with `#C2410C`; this is a deliberate per surface exception. **Engineer: add a Decisions row** in DESIGN.md with the PR ("2026-10-15 · Jarvis PWA uses a dark surface and #FF7A1A accent · Blaine's direction for the phone front door; rest of the system unchanged").
- Kept from DESIGN.md: radius 0/2/4 only, no shadows, no gradients, hairline structure, plain word status in mono uppercase (`DONE`, `RUNNING`, `QUEUED`, `NEEDS INPUT`, `PAUSED`, `CANCELED`, `FAIL`, `NOT RUN`), no avatar, no chat bubbles, no emoji, no exclamation marks, iconography as words.
- Fonts: production uses the DESIGN.md faces (Suisse Int'l Condensed display, Söhne body, Lab Mono data). The mock uses IBM Plex Sans Condensed / Plex Sans / Plex Mono as stand ins.
- Accent use: current stage, the open decision (left rule, selected option, primary action), `AUTHORITATIVE`, focus rings. Filled accent buttons appear only for the single primary action on a card (decision confirm, OPEN 3D VIEW, )

Tokens (CSS custom properties):

```css
--bg:#0E0E10; --surface:#161619; --surface-2:#1F1F23; --hairline:#2C2C31; --hairline-strong:#3A3A40;
--text:#F2F1EE; --muted:#A3A3AA; --accent:#FF7A1A; --on-accent:#0E0E10; --tap:44px; --pad:16px;
```
Contrast on `--bg`: text 17.5:1, muted 7.9:1, accent 7.4:1; `--on-accent` on accent 7.4:1.

## 3. Copy rules
- No hyphens or dashes of any kind in UI copy or aria labels (enforced by `tools/shoot.js`). Use "·", commas, or a new sentence.
- Declarative, technical, short. Errors as exceptions: `CAD: FAIL · The CAD agent returned no model.`
- Units: STEP is exported in mm (Decision 5). UI shows mm by default with an MM / IN toggle on the result card. Sample plate: 4 in = 101.6 mm, thickness 0.250 in = 6.35 mm. Decision options stay in the unit the question was asked in. This is a deliberate exception to the DESIGN.md imperial first default.
- No ellipsis character anywhere in UI copy (enforced with the dash check). In progress states use a word: `PAUSING`, `SAVING`.
- Never show invented values. Unknowns render as `NOT SPECIFIED`.

## 4. Screens and states (19)

| # | State id | Screen | Purpose |
|---|---|---|---|
| 1 | `denied` | Gate | OVD-740 allowlist gate, no access state, shown after the existing Supabase sign in. D-3 |
| 2 | `thread-loading` | Thread | Skeleton rows, composer disabled |
| 3 | `thread-empty` | Thread | First run, one example prompt (labeled Example) |
| 4 | `thread-error` | Thread | Thread fetch failed, RETRY |
| 5 | `cooking` | Thread | Live job status card plus pinned status strip; PAUSE, CANCEL |
| 6 | `pausing` | Thread | PAUSE tapped, waiting for the next safe checkpoint; button reads PAUSING (disabled) |
| 7 | `paused` | Thread | Paused at a checkpoint; RESUME, CANCEL; control event in thread |
| 8 | `cancel-confirm` | Sheet | Confirm before cancel |
| 9 | `canceled` | Thread | Stopped; partial work kept |
| 10 | `decision` | Thread | Open decision card with recommended default and Skip |
| 11 | `decision-skipped` | Thread | Resolved by skip; best guess recorded; CHANGE ANSWER available until the next checkpoint consumes it |
| 12 | `decision-locked` | Thread | Checkpoint consumed the answer; CHANGE ANSWER gone; STEER INSTEAD (OVD-812) |
| 13 | `result` | Thread | Result card: pictures, OPEN 3D VIEW, VIEW IN AR, MM / IN toggle, facts, files |
| 14 | `result-no-ar` | Thread | Same card where AR is not supported: AR fallback note |
| 15 | `ar-safari` | Thread | Installed iOS PWA where AR Quick Look may not open: OPEN IN SAFARI fallback |
| 16 | `viewer-loading` | Viewer | GLB loading |
| 17 | `viewer` | Viewer | Interactive 3D view (static mock of the model-viewer state) |
| 18 | `viewer-error` | Viewer | WebGL or GLB failure fallback to pictures |
| 19 | `job-error` | Thread | CAD failed; RETRY CAD |

Removed: `signin` and `signin-checking` (Decision 7: no new auth screen; the existing Supabase sign in is reused unchanged).

## 5. Components

### 5.1 App frame (thread)
Top to bottom: header (56px + safe area; `JARVIS` wordmark, `MENU`), design state strip, pinned status strip (only while a job exists), thread (one scroll container), composer (anchored, safe area aware). PWA `display: standalone`, `theme-color #0E0E10`, `viewport-fit=cover`.

### 5.2 Design state strip (OVD-481 Baseline / Working / Committed)
Three equal cells, always visible on thread screens. Each: micro label plus mono value (`NONE` or the design name, sample `PLATE R1`). The current cell gets an accent label and 2px accent underline, `aria-current="true"`. Not interactive in slice 1. A new part starts with Baseline `NONE`; a running or finished job is Working; Committed always reads `NONE` in slice 1: there is no Commit action and the result plate is review only (Decision 1). A one line note under the strip says so: "Committed stays NONE in this release. Results are for review only; there is no commit action yet."

### 5.3 Live job status ("Jarvis is cooking")
- Card: header `JARVIS IS COOKING` with PAUSE and CANCEL; request line; indeterminate bar (no fake percent); ordered stage list mirroring the graph: `1 INTAKE`, `2 CONCEPT PICKS`, `3 CAD`, `4 VERIFY`, `5 RESULT`. Each stage shows one word state; the active stage is accent and `aria-current="step"`. Footer: "Keep working. Jarvis interrupts only for a real question or a key choice."
- Slice 1 enables only the CAD agent; other domain agents (Optics, Electronics, Analysis) render in the same stage slot by name, so no UI rework.
- Does not interrupt: no modal, no auto scroll, composer stays enabled. When the card is off screen the **pinned strip** shows `COOKING · CAD RUNNING · 1:42` (elapsed time from server timestamps); tapping it scrolls to the card.
- While a decision is open the card collapses to one line (`REQUEST R1 · CONCEPT PICKS · NEEDS INPUT`, DETAILS expands) so the decision stays above the fold.
- Screen reader: stage changes announced through one `aria-live="polite"` region, stage transitions only (not the timer).

### 5.4 Job control: Pause, Resume, Cancel
- PAUSE (44px, header of the running card). Sends a pause control event; the graph pauses at the next safe checkpoint. Between tap and checkpoint the job is in state `pausing` (Decision 6): button reads `PAUSING` (disabled), card title `PAUSING`, pinned strip `PAUSING · WAITING FOR CAD CHECKPOINT`, thread line "You asked to pause · Jarvis stops at the next safe checkpoint." It stays there until the checkpoint lands; no timer, no ellipsis. When paused: card title `PAUSED` (accent), active stage `PAUSED`, bar removed, footer "Work so far is kept. Resume continues from this checkpoint.", actions RESUME (primary) and CANCEL. Pinned strip `PAUSED · AT CAD CHECKPOINT`. Thread gets a control line: `8:44 PM  You paused the job · It stopped at the next safe checkpoint.`
- CANCEL opens a bottom sheet (`role="alertdialog"`, focus on KEEP COOKING, Escape and backdrop tap close it as KEEP COOKING): title "Cancel request R1?", body "Jarvis stops at the next safe checkpoint. Work done so far stays in the thread. A canceled request cannot be resumed; you can ask again.", buttons KEEP COOKING (primary, first) and CANCEL REQUEST.
- Canceled: card `CANCELED`, stages after the stop `NOT RUN`, note that intake, concept picks and recorded guesses are kept, pinned strip `CANCELED · NOTHING RUNNING`, thread control line.
- Control actions from any channel (Slack, Telegram, iMessage) render the same control line with the channel name, e.g. "You paused the job from Telegram".
- Idempotent: repeat taps send the same control id; the button disables until the server acknowledges.
- Steering mid run (OVD-795 8:36 PM comment) uses the normal composer; out of scope for this design beyond keeping the composer enabled during a run.

### 5.5 Decision card (graph decision point)
Maps 1:1 to `decision_requested{nodeId, question, options, recommended, bestGuess}`.
- Header: `DECISION · <NODE NAME>` (accent) and `SAMPLE` tag in the mock. Left 3px accent rule while open.
- Question as display heading (20px). One line of context: "Jarvis keeps cooking on the parts that do not depend on this."
- Options: radio group, each row 56px or more with value (mono) and one line consequence. The recommended option is preselected and tagged `RECOMMENDED`.
- Primary: `USE <selected value>` (label follows the selection).
- Skip: full width secondary `SKIP · LET JARVIS GUESS`, always visible next to the primary, never behind a menu. Directly beneath, before the tap: "If you skip, Jarvis uses its best guess, 0.250 in, records it in the design history, and keeps going. You can change it later." (`aria-describedby` on the Skip button). The best guess shown is `bestGuess`, which can differ from `recommended`.
- Submitting: both buttons disable, tapped one reads `SAVING`; resolution is idempotent per `decision_id` (T-1 double tap).
- Timeout: if the graph times out the decision it resolves as `skipped_best_guess`; the resolved card reads "No answer in time. Jarvis used its best guess and recorded it in the design history at <time>."

### 5.6 Resolved decision (skipped, best guess recorded)
Maps to `decision_resolved{skipped_best_guess, rationale}`.
- Card loses the accent rule; header tag `SKIPPED · RECORDED`.
- Shows the question, the value in 18px mono with `BEST GUESS` tag, and "You skipped this. Jarvis used its best guess and recorded it in the design history at 8:43 PM."
- Thread control line right after the card: `8:43 PM  Best guess recorded · Thickness 0.250 in. You skipped the question.`
- The value keeps its `BEST GUESS` tag wherever it reappears (result facts), and the result shows "Decisions: 1 skipped, recorded".
- **CHANGE ANSWER** (accent link, 44px target) reopens the options with the guess preselected, with the note "You can change this until the next checkpoint uses it." Available only while the decision has not been consumed by a checkpoint (Decision 2); a change sends a new resolution for that node.
- **Locked** (state `decision-locked`): once the next checkpoint consumes the answer, the tag reads `LOCKED · USED`, CHANGE ANSWER is removed, the note reads "The CAD checkpoint used this answer at 8:45 PM. Change answer is no longer available. To change it now, steer Jarvis with a new instruction." and the card offers STEER INSTEAD, which focuses the composer (placeholder "Steer Jarvis"). Steering is OVD-812. A thread line marks the checkpoint. Result screens show the decision in this locked form, since CAD has consumed it.
- Answered (not skipped) variant: tag `ANSWERED`, value without the `BEST GUESS` tag, same CHANGE ANSWER.

### 5.7 Result card
- Header `RESULT · READY`; design name in 20px mono.
- Two pictures (Iso, Top) from the CAD agent PNGs. The **iso picture is itself a button** labeled "Iso · tap for 3D" that opens the viewer.
- Actions row: `OPEN 3D VIEW` (filled) and `VIEW IN AR` (outline), equal width. Hint under them: "Opens your phone's AR viewer." (meters scale hint removed, Decision 5).
- Units: MM / IN segmented toggle (two 44px buttons, `aria-pressed`), mm selected by default; sample values 101.6 × 101.6 mm, 6.35 mm. The STEP row reads `PLATE_R1.STEP · mm`.
- Facts list (mono, right aligned values): size, thickness (with `BEST GUESS` if applicable), material (`NOT SPECIFIED` if unset), decisions summary.
- Files: `.STEP` marked `AUTHORITATIVE` (accent), `.GLB` `REVIEW VIEW`, `.USDZ` `AR VIEW` when present. `DOWNLOAD STEP` secondary button.

### 5.8 View in AR (device detection and fallback)
The pipeline exports GLB and USDZ per model (OVD-795 8:35 PM comment).
Detection, client side, in this order:
1. **iOS / iPadOS AR Quick Look**: `document.createElement('a').relList.supports('ar')` is true. Render VIEW IN AR as `<a rel="ar" href="<model>.usdz">` with a child `<img>` (Quick Look requires it). If the USDZ URL is missing, treat as unsupported.
2. **Android Scene Viewer**: Android user agent and not iOS. VIEW IN AR navigates to `intent://arvr.google.com/scene-viewer/1.0?file=<encoded https GLB URL>&mode=ar_preferred&title=<name>#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;S.browser_fallback_url=<encoded 3D view URL>;end;` (`ar_preferred` falls back to Scene Viewer's 3D mode when ARCore is missing). The GLB URL must be HTTPS and reachable by Google's app (short lived signed URL is fine).
3. Implementation: `@google/model-viewer` (approved, Decision 4) drives both. Use `<model-viewer src="<glb>" ios-src="<usdz>" ar ar-modes="scene-viewer quick-look" camera-controls>` and its `canActivateAR` for detection; the rules above describe what model-viewer does and are the expected behavior to verify.
3a. **Installed iOS PWA** (`navigator.standalone` true on iOS): AR Quick Look may not open in standalone mode (Decision 3). VIEW IN AR then shows the `ar-safari` state: `AR · OPEN IN SAFARI` / "AR may not open inside the installed app on iPhone. Open this model in Safari to view it in AR." with OPEN IN SAFARI, which opens the model's share URL in Safari. OVD-804 verifies on device whether Quick Look works in standalone; if it does, this state is shown only on launch failure.
4. Otherwise **unsupported** (desktop, in app browsers without AR, missing USDZ): hide VIEW IN AR, OPEN 3D VIEW becomes full width, and show the note (state `result-no-ar`): `AR · NOT AVAILABLE HERE` / "AR needs Safari on iPhone or iPad, or Chrome on an Android phone with Google Play Services for AR. The 3D view works on this device."
- Launch failure (intent fallback fires, or Quick Look does not open): land on the 3D viewer with no extra error.
- The 3D viewer header also carries VIEW IN AR under the same rules.
- Scale: no scale claim in UI copy. The STEP is in mm; GLB and USDZ scale is model-viewer's to honor and OVD-804 checks it on device.

### 5.9 3D viewer (static mock of the viewer state)
- Built on `@google/model-viewer` (approved): `camera-controls` for orbit and pinch, toolbar buttons call its camera API (`cameraOrbit`, `fieldOfView`, `jumpCameraToGoal`), `error` event drives `viewer-error`, `progress` / `load` drive `viewer-loading`. Same element provides VIEW IN AR.
- Full screen dialog (`role="dialog"`, `aria-modal`), opened from the iso picture or OPEN 3D VIEW; focus starts on CLOSE and returns to the opener on close; Escape closes.
- Header: `PLATE_R1 · 3D review`, VIEW IN AR (when supported), CLOSE.
- Banner directly under the header, always visible: "**Derived review view;** STEP is authoritative." (OVD-484).
- Canvas: GLB, orbit (one finger drag), zoom (pinch), double tap to fit; `touch-action: none` on the canvas only. Hint line: "Drag to orbit. Pinch to zoom. Double tap to fit."
- Toolbar (button alternatives to gestures, WCAG 2.5.1): ROTATE (45 degree step), ZOOM IN, ZOOM OUT, FIT. 4 equal buttons, 44px.
- Loading: status "Loading 3D model", indeterminate bar, controls disabled.
- Error (no WebGL, GLB fetch or parse failure, T-6): "3D view · Unavailable. This device could not open the 3D view. The pictures and the STEP file are still available." Pictures shown, TRY AGAIN.

### 5.10 Sign in and access (no new auth screen)
- Sign in reuses the existing OverDrafter Supabase sign in unchanged (Decision 7). No Jarvis sign in screen.
- Access is the OVD-740 allowlist gate, server side, before any thread payload or chunk loads.
- `denied` is the OVD-740 gate's no access state: heading "No access", micro label "Access check · OVD 740", body "This account does not have Jarvis access. Access is by invitation. Ask the OverDrafter team to add you."; USE ANOTHER ACCOUNT (primary) and SIGN OUT. If OVD-740 already renders its own no access screen, use that and drop this one. See D-3.

### 5.11 Thread entries
- User and Jarvis messages are hairline separated log entries with a micro label (`YOU` / `JARVIS`) and time, no bubbles or avatars.
- Control lines (skip recorded, paused, canceled, resumed, channel origin) are muted mono single lines with a time column.

### 5.12 Empty, loading, error
- Empty thread: "No requests yet" + one sentence + "Example: Make a 4 inch square plate." (the OVD-795 first job, labeled Example). Composer placeholder "Describe the part you need".
- Loading: skeleton blocks, `aria-busy`, composer disabled.
- Thread error: `THREAD · FAIL`, "The conversation did not load. Your messages are saved on the server." RETRY. Composer disabled.
- Job error: stage list with `FAIL` and `NOT RUN`, "CAD: FAIL · The CAD agent returned no model.", "Your request and recorded decisions are kept. Retry runs CAD again from the same inputs." RETRY CAD.

## 6. Accessibility
- Targets 44 x 44 CSS px minimum on every control (radio rows 56px; the row is the label).
- Text 11px minimum (micro labels), body 15px, composer 16px (prevents iOS zoom). Supports text zoom to 200% without horizontal scroll.
- Contrast: all text pairs 4.5:1 or better (§2).
- Focus: 2px accent outline, offset 2px; dialogs trap focus and restore it.
- Live regions: job stages (polite), control acknowledgements (polite), errors (`role="alert"`).
- Motion: blinking tick and sliding bar stop under `prefers-reduced-motion`.
- Semantics: decision card `role="group"` labelled by the question; options a `fieldset` radio group; stage list an `ol` with `aria-current="step"`.

## 7. Review cases D-1 to D-4

| Case | How the design meets it | How it is checked |
|---|---|---|
| D-1 every card readable at 375px | Single column, 16px gutters, no fixed widths; long labels wrap or ellipsize only in the state strip; 11px floor; decision card stays above the fold by collapsing the status card | `shoot.js`: no horizontal overflow, no text under 11px, no clipped text, on all 19 states at 375 and 430; visual review of all 38 shots |
| D-2 skip path visible and reversible looking | Skip is a full width button beside the primary on every decision card, with the best guess stated before tapping and "You can change it later"; after skipping, the card shows the guess with `BEST GUESS`, `SKIPPED · RECORDED`, a "Best guess recorded" thread line, and CHANGE ANSWER | Screenshots `decision-*`, `decision-skipped-*`, `result-*` |
| D-3 no allowlist state leaks no data | The denied screen renders only static copy and two account actions: no thread, job, design name, file, email, tier, allowlist size, or menu. The access check is server side before any conversation payload is sent or the thread chunk is loaded (OVD-803 W-1, W-2). Copy is identical for not listed, revoked, and flag off, so it cannot be used to probe state | `shoot.js` leak regex on `denied` (no design, file, state strip, request, decision, email or tier strings); engineer test W-1 asserts a 403 with no body data |
| D-4 tap targets 44px or more | `--tap: 44px` on every button, link, input; option rows 56px; viewer toolbar 4 equal 44px buttons | `shoot.js` measures every visible control at both widths |

## 8. Acceptance criteria for the builder (OVD-803 / OVD-804)
1. All 19 states exist in the app and match the screenshots in layout, copy and order of actions (pixel exact not required).
2. All UI copy and aria labels contain no hyphen or dash characters.
3. Every control is at least 44 x 44 CSS px at 375 and 430 widths; no horizontal scroll at 375.
4. The status card never opens a modal or steals focus; the composer stays usable while a job runs.
5. Decision cards render from `decision_requested` only; Skip sends `skipped_best_guess`; the UI shows the recorded guess (card, thread line, result tag) from `decision_resolved`, not from client state; double tap does not double submit.
6. Timeout skip shows the timeout copy.
7. Pause, Resume, Cancel work from the web app with idempotent control ids; Cancel requires the confirm sheet; paused and canceled states and thread control lines render.
8. The viewer shows the "Derived review view; STEP is authoritative." banner at all times; gestures plus button alternatives; WebGL failure falls back to pictures.
9. VIEW IN AR follows §5.8 detection through model-viewer; unsupported devices get the fallback note; installed iOS PWA gets the OPEN IN SAFARI fallback; tested on one iPhone (Safari and installed PWA) and one ARCore Android phone.
10. Non allowlisted users see only the denied screen; network panel shows no conversation data; the thread chunk is not fetched.
11. Baseline / Working / Committed strip is visible on every thread screen.
12. DESIGN.md Decisions row added for the dark Jarvis surface.
13. No custom sign in screen; existing Supabase sign in plus OVD-740 gate.
14. Pausing state shows until the checkpoint lands; a consumed decision shows the locked state with STEER INSTEAD.
15. Result shows mm by default with an IN toggle; no meters or scale hint.

## 9. Proof (OVD-781)

**Screenshots** (`screenshots/`, 2x device scale, iPhone height 844, reduced motion, sample data banner at top). Thread and gate states are full page; viewer and confirm sheet states are viewport captures.

| State | 375 | 430 |
|---|---|---|
| OVD-740 gate, no access | `denied-375.png` | `denied-430.png` |
| Thread loading | `thread-loading-375.png` | `thread-loading-430.png` |
| Thread empty | `thread-empty-375.png` | `thread-empty-430.png` |
| Thread load error | `thread-error-375.png` | `thread-error-430.png` |
| Jarvis is cooking | `cooking-375.png` | `cooking-430.png` |
| Pausing | `pausing-375.png` | `pausing-430.png` |
| Paused | `paused-375.png` | `paused-430.png` |
| Cancel confirm | `cancel-confirm-375.png` | `cancel-confirm-430.png` |
| Canceled | `canceled-375.png` | `canceled-430.png` |
| Decision open | `decision-375.png` | `decision-430.png` |
| Decision skipped, best guess recorded | `decision-skipped-375.png` | `decision-skipped-430.png` |
| Decision locked after checkpoint | `decision-locked-375.png` | `decision-locked-430.png` |
| Result, AR available | `result-375.png` | `result-430.png` |
| Result, AR unavailable | `result-no-ar-375.png` | `result-no-ar-430.png` |
| AR, open in Safari fallback | `ar-safari-375.png` | `ar-safari-430.png` |
| 3D viewer loading | `viewer-loading-375.png` | `viewer-loading-430.png` |
| 3D viewer open | `viewer-375.png` | `viewer-430.png` |
| 3D viewer unavailable | `viewer-error-375.png` | `viewer-error-430.png` |
| CAD failed | `job-error-375.png` | `job-error-430.png` |

**Regenerate** (from `docs/design/jarvis-pwa/`; needs Python with fontTools for the build, Node with `playwright-core` and Chrome for the shots):

```sh
python3 tools/build.py          # rebuilds mock/index.html from tools/index.src.html with inlined fonts
node tools/shoot.js             # writes screenshots/*.png and screenshots/checks-report.json; exits 1 on any failure
CHROME=/path/to/chrome node tools/shoot.js   # if Chrome is not at /usr/bin/google-chrome
```

**Checks run by `tools/shoot.js`** on every state at both widths:
1. No horizontal overflow (D-1).
2. No visible product text under 11px; no clipped text (D-1).
3. Every visible button, link, input, textarea and option row at least 44 x 44 (D-4).
4. No hyphen, dash or ellipsis characters in visible copy or aria labels (copy rule).
5. Denied state contains none of: design names, file types, state strip labels, request or decision text, `@`, tier names (D-3).
6. No page script errors.
7. Result states show the mm sample value (101.6) and no meters hint.

**Result of the last run:** 38/38 pass (see `screenshots/checks-report.json`).

**Designer sign off comment** (to post on OVD-799 after Blaine approves): states, link to this folder, the 38/38 result, and the open questions below.

## 10. Decisions (resolved, architect answers 2026-10-15)
1. **Commit action**: none in slice 1. The plate is review only; Committed reads `NONE` with a one line note explaining why (§5.2).
2. **Change answer**: a skipped decision can be re-resolved until the next checkpoint consumes it (`decision-skipped`, CHANGE ANSWER). After that it is locked and changing it is a steer, OVD-812 (`decision-locked`, STEER INSTEAD) (§5.6).
3. **AR in installed iOS PWA**: Quick Look may not open in standalone. Fallback state `ar-safari` with OPEN IN SAFARI. OVD-804 verifies on device (§5.8).
4. **3D viewer**: `@google/model-viewer` is approved for both the 3D view and AR (§5.8, §5.9).
5. **Units**: STEP exported in mm. UI shows mm with an IN toggle; sample plate 4 in = 101.6 mm. Meters scale hint removed (§3, §5.7).
6. **Pause**: `pausing` state shows until the next safe checkpoint lands; copy uses the word Pausing, no dashes or ellipsis (§5.4).
7. **Auth**: no new auth screen. Reuse the existing Supabase sign in and the OVD-740 allowlist gate. Custom sign in and checking screens removed; `denied` kept only as the OVD-740 gate state (§5.10).

Tracking: PWA shell issue is OVD-803; OVD-800 was closed as a duplicate.

## 10a. Open questions
None open. Remaining verification: OVD-804 device test for AR in the installed iOS PWA and AR scale.

## 11. Council log
- **Round 1 draft** (8:40 PM PT): 14 states. Files: `council/r1-mock.html`, `council/r1-index.src.html`, `council/r1/*.png`. Automated checks 6/28 pass (10px tags, sr only text flagged as clipped).
- **Round 1 adversarial critique** (`council/r1-critique.md`): 20 findings. Main failures: 10px tags and composer covering cards (D-1), decision actions below the fold at 375 (D-1), record of the skip only implied (D-2), duplicate wordmark and account actions on denied (D-3 polish), tap to open missing, AR / Pause / Cancel / Proof missing (release manager steering at 8:43 PM), timeout and submitting states unspecified, DESIGN.md divergence unlogged.
- **Revision**: all findings fixed in mock or spec; states grew to 18 (paused, cancel confirm, canceled, result without AR).
- **Architect answers (2026-10-15)**: 7 open questions resolved (§10). States now 19: removed signin and signin-checking; added pausing, decision-locked, ar-safari. Unit toggle added, meters hint removed, OVD-800 references moved to OVD-803.
- **Round 2 critique** (`council/r2-critique.md`): all round 1 items closed or accepted as spec only; 5 residual items accepted or moved to open questions. 38/38 checks pass. Round limit reached.

## v4.1 Architect rulings (Release, 2026-10-16), resolving open items 1 to 3

1. Commit ships in slice 1. Commit accepts the current design revision as the job's result: it freezes that revision's decisions and artifacts (STEP, GLB, USDZ) and emits a `committed` graph event. It does not quote, order or contact any supplier. Undo is available until the next run starts; it returns the job to uncommitted on the same revision (artifacts unchanged, nothing regenerated) and logs an `uncommitted` event. A committed job cannot be steered until undo.
2. W1 copy stays. Before the next checkpoint, changing a skipped guess re-resolves it in place. After the checkpoint, the change is a steer: in slice 1, a rerun of CAD from that decision on a new revision (OVD-812 adds live mid-run steering later). The user always sees "change it, CAD reruns".
3. Inches is the default display unit. Internals and STEP stay in mm, the mm toggle remains, and display rounds to 3 decimals (4.000 in).
