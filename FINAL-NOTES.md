# OVD-804 final notes

## Public asset fix pass

Moved the entire public/jarvis-preview directory to
src/features/jarvis/thread/preview-assets, leaving no public preview directory.
preview-source.ts imports both PNGs, GLB and STEP through Vite `?url` imports.
The existing vite/client declarations cover these imports; no declaration was
added. The /dev/jarvis-thread route retains its import.meta.env.DEV gate.
The public asset verifier and all allowlists are unchanged.

Requested verification for this updated uncommitted source passed (exit 0):

- node scripts/verify-public-assets.mjs public — containment check passed.
- npm run lint — /tmp/ovd804-fix-lint.log.
- npm run typecheck — /tmp/ovd804-fix-typecheck.log.
- npx vitest run src/features/jarvis/thread src/features/jarvis/import-boundary.test.ts src/App.test.tsx
  — 8 files, 50 tests passed; /tmp/ovd804-fix-tests.log.
- git diff --check passed.

No full suite, build or e2e ran. No commit was created. Existing browser and
production bundle verification gaps below remain open. Tests reported stale
Browserslist metadata; no dependency updates ran.

## Ownership and verified revision

Owner: Codex /root, OVD-804. Host: grok-bot-vm-55040405.
Worktree: /workspace/wt-804. Branch: bwilson/ovd-804-jarvis-thread-graph-events.
Base revision: 213b62a0cbc48eccebc414b6dc4b41bc3a27085c.
Verification completed 2026-10-17 UTC (2026-10-16 America/Phoenix).
Original handoff source identity (superseded by the asset relocation below):
SHA256 4b34b22c420cfad5c7b2b8b953a683c9112793173b8804054b1b63eff12b4b87,
computed over sorted path names plus NUL plus contents for App, preview page,
import boundary test, DESIGN.md, thread files, and preview assets.
Allowed actions: scoped local edits and targeted checks; no commit, push, merge,
rebase, native CAD, live project access, production/provider/customer actions.
Completion condition for this worktree handoff: reusable thread, dev preview,
T1 to T9 unit evidence, lint and typecheck; browser/device/bundle and live shell
integration remain explicitly unverified. No code failure repair rounds consumed.

## Files changed

- src/App.tsx: lazy route /dev/jarvis-thread gated solely by import.meta.env.DEV.
- src/pages/JarvisThreadPreview.tsx: synthetic sample preview.
- src/features/jarvis/thread/JarvisThread.tsx, thread.css: plain thread, quiet lanes,
  elapsed status, Working/Committed state line, radio decisions, recorded server
  resolutions, errors, pictures, files, dimensions, controls, AR extension slot.
- src/features/jarvis/thread/ModelView.tsx, model-loader.ts, ThreadDialog.tsx:
  dynamic model-viewer load, orbit/zoom buttons, full screen dialog, initial and
  restored focus, keyboard containment, Escape, loading and PNG fallback.
- src/features/jarvis/thread/client.ts: injectable resolution/control client.
- src/features/jarvis/thread/event-source.ts, supabase-source.ts: private
  conversation broadcast adapter, injectable polling, five second fallback with
  bounded exponential backoff, background polling, cleanup and event dedupe.
- src/features/jarvis/thread/preview-source.ts: status, decision, resolution,
  PNG/PNG/GLB/STEP and result replay, plus pause/cancel checkpoint variants.
- Seven colocated test files under thread/ (listed below).
- src/features/jarvis/import-boundary.test.ts: narrow React exception only within
  thread and model-viewer exception only within model-loader.ts. Server and
  worker imports remain prohibited, including type-only imports outside feature.
- docs/DESIGN.md: required dark Jarvis surface decision row.
- src/features/jarvis/thread/preview-assets/{iso.png,top.png,plate.glb,plate.step,README.md}: local,
  exclusively synthetic assets. STEP is a download stub with no solid geometry.
- FINAL-NOTES.md: this uncommitted handoff.

package.json and package-lock.json were already modified for the approved
model-viewer dependency on entry. They were left untouched. No install ran.

This exceeds the roughly 200 line guideline because the requested slice includes
transport fallback, decisions, controls, accessible viewer, preview and style in
one independently testable dev-only unit. All feature code stays within thread/;
only route, boundary-test allowance and required design log live outside it.

## Verification results

All requested commands passed with exit code 0:

- npm run lint (full repository ESLint), /tmp/ovd804-lint.log.
- npm run typecheck (app, node and server), /tmp/ovd804-typecheck.log.
- npx vitest run src/features/jarvis/thread src/features/jarvis/import-boundary.test.ts server/design-graph/import-boundary.test.ts
  — 8 files, 31 tests passed, /tmp/ovd804-tests.log.
- git diff --check passed.

T1: JarvisThread.test.tsx status to decision to result and pictures/3D action.
T2: same file verifies skipped_best_guess and displays the server choice and
rationale only after decision_resolved, even when different from the hint.
T3: same file verifies single Skip/Choose call on repeated taps and radio arrows.
T4: same file verifies no WebGL and model error PNG fallback, retry, load and
button alternatives to gestures.
T5: same file verifies 403 displays error, retains selection and decision form,
and never records a client-side guess.
T6: lazy-viewer.test.ts scans all src sources for model-viewer references,
requires the sole package reference be a dynamic import in model-loader.ts.
T7: JarvisThread.test.tsx verifies single pause/cancel calls with idempotency
keys, confirmation, and pause awaiting a checkpoint; remote requested events
and offline disabling/RETRY are also covered.
T8: same file verifies cancelled kept files and excludes discarded GLB.
T9: event-source.test.ts verifies fallback at 5 seconds, socket/poll dedupe,
backoff, background polling, retry and in-flight disposal.
Additional: supabase-source.test.ts private conversation scope and cleanup;
ThreadDialog.test.tsx focus, trapping, Escape and restoration;
preview-source.test.ts scripted plate and both control variants.
Both existing import boundary suites passed. Their planted-violation test prints
expected FAIL examples; those are passing negative tests, not failures.

No build, full test suite, e2e or Playwright ran, per task resource constraints.
The sole advisory was stale Browserslist metadata; no dependency updates ran.

## Placeholders and integration boundaries

- OVD-803 shell, access gate, PWA and real domain are intentionally absent.
- The public component receives source, client, runId, optional workingName,
  and arActionSlot. No AR action is built; OVD-811 supplies that slot.
- Messages remain an explicitly labeled preview-only composer; Change focuses
  it. No pretend decision rewrite, steering or rerun is performed (OVD-812).
- Commit/Committed adoption, resume and CAD retry are out of this slice. The
  Committed value is always none; paused and CAD-failed states do render.
- All preview files are synthetic. PNGs are silhouettes, GLB is a generated box
  in meters corresponding to the displayed inch/mm dimensions. STEP is an
  explicitly labeled stub, not qualified CAD output. No native CAD claim made.
- Reuse core/types.ts mirrors of server/design-graph/events.ts; no new mirror
  and no server imports were introduced.
- The injectable client carries resolution=skipped_best_guess and stable keys.
  The eventual shell maps these requests onto its owner-checked endpoint and
  DesignGraph.control. A successful HTTP acknowledgement never invents a
  resolution or checkpoint event in the UI.
- createSupabaseEventSource accepts an existing SDK client, supplied owner
  conversation ID and owner-checked poll callback. It subscribes to a private
  jarvis:conversation:<id> broadcast topic, graph_event messages. This is an
  integration protocol, not a claim that an existing server publishes it.
  No new table, RLS, migration, endpoint or real project was introduced.
- No web ChannelAdapter registration: the existing interface requires verified
  inbound identity normalization and outbound RenderedMessage delivery, while
  this slice consumes GraphEvent and has neither the OVD-803 identity boundary
  nor durable delivery transport. Registering a fake production web adapter
  would incorrectly advertise delivery. Shell integration should supply it.

## Open verification and questions

- Collect real browser screenshots at 375 and 430, 44px target/overflow/state-line
  checks, fixed decision action placement and responsive keyboard behavior.
  The approved mock and 375 decision / 430 result screenshots were inspected;
  matching the running implementation visually remains unverified.
- iOS Safari orbit/pinch, real WebGL/model loading, device scale, mobile focus
  and installed-PWA behavior require device evidence. No AR device work here.
- Collect the production bundle diff and confirm renderer chunk exclusion in
  the built graph. Static dynamic-import evidence passes; build proof pending.
- OVD-803 must connect the owner-scoped poll/resolve endpoints and the private
  broadcast publisher/admission policy. No live Supabase verification claimed.
- server/jarvis/design-graph-port.ts currently returns unsupported for control.
  Its existing core port signature also predates OVD-810 server control actor
  handling. Shell/server integration must bridge the new control API; this PR
  deliberately supplies only the requested injectable client and fake replay.
- Later steering should replace the Change composer focus behavior; sheets
  currently support Escape and backdrop dismissal, not swipe dismissal.

All work is uncommitted. No forbidden paths were modified, no new environment
variables were added, and no other workspace was touched.

## Repair round

PR #834 / OVD-804, Codex /root, /workspace/wt-804; uncommitted repair
against b1f2f1bd076cc4202144a19ec425a8b47f7e6734 on 2026-10-16.
Fixed all seven review findings: stage/state-only hidden live region, primary
focused KEEP COOKING sheet action, subscription/recovery catch-up polling
(including an in-flight poll), completed/rejected control key retirement, lazy
crypto keys with getRandomValues fallback, safe artifact URL filtering across
standalone/result/kept artifacts, and plain accessible radio names.
Added targeted regression tests. The first typecheck caught an overly broad
artifact fixture return type; narrowed that test helper and reran checks.

Final requested verification passed (exit 0):

- npm run lint — /tmp/ovd804-repair-lint.log.
- npm run typecheck — /tmp/ovd804-repair-typecheck.log.
- npx vitest run src/features/jarvis/thread src/features/jarvis/import-boundary.test.ts src/App.test.tsx
  — 8 files, 71 tests passed; /tmp/ovd804-repair-tests.log.
- git diff --check passed.

The three protected files were untouched. No dependencies, environment
variables, build, full suite, e2e, or commit. Prior browser/device/integration
verification gaps remain open; this repair makes no browser acceptance claim.
