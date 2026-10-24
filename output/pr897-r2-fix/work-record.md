Owner: /root, current host/worktree fix-1024. Branch fix/internal-session-restore-gate, source bbcfb07b, PR 897 / OVD-1024.
Scope: local auth restore repairs and regression tests only. No git writes, dependencies, real credentials, or provider operations.
Completion: all five requested rules and earlier regressions pass the requested Vitest, typecheck, changed-file ESLint checks.
Budget: one implementation pass; two repair rounds. Failures: background session loss, stale subject races, unsupported abort API, incomplete seed promotion.
Verification: deferred fetch and bootstrap races, multi-observer state, exhausted retry/recovery, old AbortSignal shape, real AuthPanel retry affordance, existing guard and fixture suites.

Final verification: 2026-10-21T11:50:17.909083+00:00 on Blaines-MacBook-Pro.local
- Requested Vitest command: PASS, 180 tests across 6 files (requested-vitest.log).
- AuthPanel supplemental suite: PASS, 8 tests (auth-panel.log).
- npm run typecheck: PASS, exit 0 (typecheck.log).
- Changed-file npx eslint: PASS, exit 0 (eslint.log).
- git diff --check: PASS. HEAD remains bbcfb07b; no git writes or new dependencies.
- Independent read-only auth review: no remaining actionable findings after final patch.
- Vite 5 build.target absent; installed default includes Chrome 87, Firefox 78 and Safari 14. No runtime throwIfAborted calls remain in hook.
- Tests use synthetic mocked auth/session transport and jsdom. No live-account or real-browser qualification claimed.
- Repair round 1 corrected pending transition ordering. Round 2 corrected TypeScript fixtures/inference and review-identified incomplete background projection and late bootstrap paths.

Final source SHA-256:
- 23b3c1dca6532a333b86ce4984f65bd1a1a1702824877cd6adcfe65104e3d801  src/hooks/use-app-session.ts
- 390289ab8c56cfbbbb83b67be332d42daac31a3954a27881cd081341d37b8fc3  src/hooks/use-app-session.test.tsx
- 33539d0b193237e5ba89a7a6e12da235995e7fce007643a6810d851114fcfa27  src/components/auth/AuthPanel.tsx
- ed381bf3c75a380dc498f3c14cc7839d1544764d2912b2131ef26250868e6afb  src/components/auth/AuthPanel.password-strength.test.tsx
