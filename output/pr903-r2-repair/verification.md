# PR #903 confirmed-review repairs

- P2 Home selection: fetch published jobs' workspace state using the existing scoped query cache, then use resolveWorkspaceSelectionIds. A legacy offer pointer cannot satisfy a published package's selection. ClientHome.test.tsx adds two cases (unselected/selected package), and use-client-home-controller.test.tsx adds one data-loading case.
- P3 Review order alignment: group the button and visible accessible reason in one vertical flex item, right aligned on desktop. ClientPart.test.tsx verifies shared grouping and visible accessible text. quote-comparison.spec.ts adds desktop bounding-box assertions against the header and reason.
- P3 wording: shared package detection and prompt helper on ClientPart, ClientPartReview, ClientProject, and ClientProjectReview. ClientReviews.test.tsx adds four no-package cases (both pages, absent/stale pointer); ClientProject.test.tsx adds two cases (with/without quotes). Existing published-package and ClientPart wording coverage passes. The existing project assertion now waits for its asynchronous package query.

Verification at recorded source-manifest hashes:
- Vitest: 285 passed, 0 failed, 8 files: ClientPart 143; ClientProject 64; sourcing-result 32; ClientReviews 14; use-client-home-controller 12; ClientHome.auth 9; ClientProjectReview.payment 6; ClientHome 5.
- npm run typecheck: exit 0.
- npx eslint on all 13 changed tracked files: exit 0.
- git diff --check: exit 0.
- Playwright targeted desktop journey: blocked before tests. Default cache was outside writable roots; disposable cache resolved that issue, then sandbox denied listening on 127.0.0.1:4173 (EPERM). No browser pass claimed.

PR #900's requested STEP-only repairs were observed already uncommitted in the separate fix-1029 worktree: lifecycle succeeded with no drawing, stale-notice assertions, and preserved material prompt assertions. This task did not modify or reverify that other owner's work.

No git writes or dependency changes performed.
