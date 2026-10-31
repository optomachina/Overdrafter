# PR #981 run-the-app proof (owner evidence, not a QA verdict)

Source: PR head `257e93d8b985a4560f99127cd4a8ec8cd448df1b`, checked out detached, `npm ci`.

- `vitest-head.txt`: `npx vitest run scripts/sensitive-class-detect.test.mjs` -> 862/862 passed.
- `marker.txt`: `node --test scripts/test-support/source-only-network-marker.node-test.cjs` -> 3/3 passed.
- `vitest-glob-removed.txt`: the `scripts/test-support/source-only-network.cjs` entry was removed from `docs/sensitive-paths.json` -> 1 failed / 861 passed, and the failure names `source-only-network.cjs (from ...marker.node-test.cjs)`. The file was then restored with `git checkout` (clean tree).
- App: `npm run build` passes. The app was then built with the repo's fixture-lane synthetic placeholders (`VITE_SUPABASE_URL=http://127.0.0.1:9`, `VITE_SUPABASE_PUBLISHABLE_KEY=synthetic-unused`), served with `vite preview` on 127.0.0.1, and driven with Playwright (Chromium): `/` returned 200, `/signin` rendered, and there were 0 page errors. Screenshots: `app-root.png`, `app-signin.png`. Trace: `trace.zip` (`npx playwright show-trace trace.zip`).

The Vercel preview is behind Vercel SSO and could not be driven.
