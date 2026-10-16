# Jarvis PWA fix list (from critique v3, 2026-10-16; re-checked v4 2026-10-16, see 2026-10-16-recheck-v4.md)

| id | severity | screen | summary | status |
|---|---|---|---|---|
| B1 | blocker | Result / More | No commit action; add COMMIT PLATE R1 + confirm + undo | cleared in v4 (2026-10-16). Notes: committed state line ambiguous (N2); architect open item 1 on commit meaning |
| B2 | blocker | Decide | Alternatives prose-only; add shared numeric evidence + assumptions + evidence link | cleared in v4 (2026-10-16), ratios accepted. Still to do: direction words ("8× more deflection"), basis for "recommended" or rename to default, name scaling law on Decide |
| B3 | blocker | Direct | Working/Committed state line not rendered on Direct | cleared in v4 (2026-10-16). Offline regression tracked as N1 |
| W1 | worth fixing | Decide / Result | Skip reversibility copy; link recorded guess to Decisions | cleared in v4 (2026-10-16). Pending architect open item 2; see N5 |
| W2 | worth fixing | Decide | Selection color-only; APPROVE label must follow selection | cleared in v4 (2026-10-16). ARIA cleanup in N6 |
| W3 | worth fixing | All | all:unset kills focus ring | cleared in v4 (2026-10-16) |
| W4 | worth fixing | All | Control borders under 3:1 | open. v4 #5A5A62 = 2.82:1 on bg, 2.59:1 on surface; use #6A6A72 (3.60 / 3.30) |
| W5 | worth fixing | Result | Evidence buried in overflow | cleared in v4 (2026-10-16). Row removed on Committed, see N2 |
| W6 | worth fixing | Parallel | Duplicate Working status; MORE two meanings | cleared in v4 (2026-10-16) |
| W7 | worth fixing | Result | Headline in mm | cleared in v4 (2026-10-16) |
| W8 | worth fixing | All | Missing loading/error/empty/failed/offline/paused states | cleared in v4 (2026-10-16). Offline broken (N1); checkfail needs change decision path (N8) |
| W9 | worth fixing | Sheets | Grabber, title, Cancel, swipe dismiss | cleared in v4 (2026-10-16). Swipe/backdrop dismiss and focus trap not in mock, unverified |
| M1 | minor | Header / Composer | Icons instead of MENU/SEND | cleared in v4 (2026-10-16). Send should be disabled when empty |
| M2 | minor | All | 12px mono labels to 13px | cleared in v4 (2026-10-16) |
| M3 | minor | Parallel | Lanes static | cleared in v4 (2026-10-16) |
| M4 | minor | Direct / Decide / Result | Pin primary action above composer | cleared in v4 (2026-10-16) |
| M5 | minor | Result | Disclaimer heavy | cleared in v4 (2026-10-16); viewer banner unverified |
| N1 | blocker | Offline | Banner replaces state line (Working/Committed missing); lanes show stale live WORKING; PAUSE/CANCEL look active; banner wraps | open. Keep state line with "Offline ·" prefix, freeze lanes as LAST SEEN, disable job controls, shorten copy |
| N2 | worth fixing | Committed | "Working PLATE R1 · Committed PLATE R1" ambiguous; evidence row stripped after commit | open. Working none after commit; keep evidence row |
| N3 | worth fixing | Parallel / Decide / Failed / Paused | Working PLATE R1 shown before a model exists; CAD WORKING while decision "before CAD" pending | open. "(in progress)" or job name; CAD lane WAITS FOR YOU |
| N4 | worth fixing | Evidence sheet | Formula column wraps mid-expression at 430 and 375 | open. Stack label over nowrap formula; add result in words |
| N5 | worth fixing | Committed | "recorded guess. Change" on committed candidate without saying it starts a new working candidate | open |
| N6 | minor | Decide | role=radio with aria-pressed; no arrow keys / roving tabindex | open |
| N7 | minor | Decide / Commit sheet | Noise: three Evidence links; sheet title duplicates question | open. One evidence affordance per row line or single link; drop h2 |
| N8 | minor | Checkfail | Only RETRY CAD; no path to change the decision | open. Add "Change thickness" link |
