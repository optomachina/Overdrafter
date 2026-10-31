# PR #916 app-run proof (owner evidence, not a QA verdict)

Source SHA: b3dae877348fbd823e28bb2025e1278c7bf1227b

- `vitest.log`: the touched check. `npx vitest run worker/src/adapters/localProviderEvaluation.test.ts worker/src/tools/vendorAuth.test.ts worker/src/tools/vendorWorkflowSmoke.test.ts`, 3 files, 131/131 passed. The two Quickparts tests changed by the PR pass: the kill-switch stop, and the production definition reaching session lookup (`missing_session`).
- `app-home.png`, `trace.zip`: the app built with `vite build` in fixture mode (VITE_ENABLE_FIXTURE_MODE=1; Supabase URL set to the dead local address and the public local demo key, the same values `playwright.config.ts` uses) and served with `vite preview`, then driven with Playwright (`drive.cjs`). Results: HTTP 200, title "OverDrafter | Machined Aluminum Sourcing", 0 page errors.
- Open the trace with `npx playwright show-trace trace.zip`.
- No vendor contact and no network beyond localhost.
