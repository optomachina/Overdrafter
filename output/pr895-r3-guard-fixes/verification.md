# PR 895 confirmed review fixes

- Owner: Codex root task; independent read-only reviewer: review_cleanup_guards.
- Host: Blaines-MacBook-Pro.local
- Worktree: /Users/blainewilson/Documents/Codex/2026-10-20/overnight/cx/ovd1022
- Branch: fix/portal-cleanup-row-bound-confirm
- Base/source HEAD: 74cd2f5bf551d13351a31e8a4b19b15e64734efd; repairs are uncommitted.
- Recorded: 2026-10-21T12:06:22.129088+00:00
- Allowed work: local source/test edits and verification; no git writes or dependencies.
- Budget: one implementation pass, two verification rounds; infra failures did not consume a repair round.
- Completion condition: all three findings fail closed, safe locator compatibility retained, regression tests and requested checks pass.
- Current state: fixes implemented; browser acceptance and ten HTTP transport tests remain environment-blocked.

## Findings and evidence

1. Shadow DOM: instrument attachShadow before page navigation; reject selected rows and descendant hosts with open/closed roots. Inspect Chromium's DOM tree for declarative closed roots and fail closed on unavailable evidence. This deliberately refuses any closed author root in the document; native user-agent roots remain allowed. Five new unit cases cover open/closed descendant hosts plus closed/unavailable/user-agent browser evidence. Eight new browser cases cover host/descendant/empty and declarative roots.
2. Ancestor rows and dialogs: compare Playwright-resolved row handles in both ancestry directions; allow at most one native dialog per click; reject quoted spellings that equal another row's literal filename. Four new unit cases and six new browser cases cover ancestors, duplicate dialogs, and both quote characters. Existing accepted quoted-prompt tests remain unchanged.
3. Selector regression: page-side containment no longer uses cleanupRow as CSS; five new browser cases cover main >> .row (scope-only and uploadedRows), css=.row (both), and xpath. Expected behavior is one owned-row removal with the customer row untouched.

## Final commands

- npx vitest run worker/src/adapters --exclude '**/*.browser.test.ts': 1431 passed, 10 failed (1441 total), 42 files passed and one failed. All ten failures are rmfgHttpTransport.test.ts local-listener failures (listen EPERM 127.0.0.1), with ten related unhandled errors. Kernel suite: 180/180 passed, including nine new cases.
- npm run typecheck:worker: exit 0.
- npx eslint worker/src/adapters/providerPortalCleanupConfirmation.ts worker/src/adapters/providerPortalCleanup.browser.test.ts worker/src/adapters/providerPortalKernel.ts worker/src/adapters/providerPortalKernel.test.ts: exit 0.
- npx vitest run worker/src/adapters/providerPortalCleanup.browser.test.ts: suite setup failed at macOS Chromium sandbox initialization (sandbox_parameters_mac.mm:67, Input/output error); 23 tests unexecuted/skipped, including 19 new cases. This is not a browser pass.
- git diff --check: exit 0 (read-only).

Independent final source review found no additional actionable findings; browser execution remains unverified. No existing tests were deleted or weakened. Existing output was preserved.
