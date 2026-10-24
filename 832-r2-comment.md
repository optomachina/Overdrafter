QA: PASS on 41412b0383a6a62cbc127de2273999f426ee6147 (rescoped, option B)
This replaces the earlier FAIL (#issuecomment-6230160005). The PR body now says `Refs OVD-811` with no closing keywords, and its Scope matches the 15-file diff. `scripts/validate-pr-body.mjs` passes (exit 0). AR-1/2/3/4/6/7 and the device/validator Proof now live in OVD-904.
Rescoped OVD-811 criteria are all met:
- AR-5 (desktop/no-AR hides the row and shows the AR-unavailable note): ar-support.test.ts and ViewInArAction.test.tsx.
- Detection and launch: Quick Look `<a rel="ar">` with an `<img>` child on iOS/iPadOS, and the exact encoded Scene Viewer intent on Android.
- Installed iOS app gets the OPEN IN SAFARI fallback, and the row has loading and failed+retry states.
- `ViewInArAction` sits in the MORE sheet on the DEV-only `/dev/jarvis-ar` page (JarvisArPreview.test.tsx).
- cad-agent emits `artifact{usdz}` only when a file is present (undefined/null/present cases), with MIME `model/vnd.usdz+zip` and 101.6 mm `dimensionsMm`; the validator accepts `usdz`.
CI: all 24 check runs are green at this SHA, including proof-check run 39006622980, which re-ran after the body edit (other runs: 39003604617, 39003604548, 39003604535, 39003604549, 39003604545). SonarCloud quality gate passed. The Vercel status fails on the Hobby rate limit and was ignored.
Proof re-run: `npx vitest run` on the 8 files from the PR's Verification section (8 files, 44 passed / 3 skipped because build123d isn't on the box), `npm run lint` (exit 0), `npm run typecheck` (exit 0), `node scripts/validate-pr-body.mjs` (exit 0), all in a fresh worktree at 41412b0383a6a62cbc127de2273999f426ee6147; CI run 39006622980.
