# OVD-1024 confirmed-review repair

Owner: Codex /root, Blaines-MacBook-Pro.local
Worktree: /Users/blainewilson/Documents/Codex/2026-10-20/overnight/wt/fix-1024
Branch/source: fix/internal-session-restore-gate, 47109705 (uncommitted repair)
Scope: use-app-session hook and focused tests. No git writes, dependencies, production, provider, customer files, or credentials.
Completion: five requested findings fixed, each covered by regression; earlier three regressions and fixture tests preserved; requested hooks/pages Vitest, typecheck, changed-file ESLint.
Budget: one primary analysis and implementation pass, requested verification pass, up to two repair rounds; stop and diagnose repeated failures.
Failure families: cross-account stale bootstrap; cancelled fetch side effects; terminal query error masked by seeding; observer-local pending transition.
E2E: inspected existing untracked journey and auth setup; unchanged (only one existing internal-account storage state). Account switching and route remount covered in hook/router test.

## Final verification (2026-10-21 UTC)

Scope extended to the session API startup reuse check: independent review reproduced returning A immediately after switching to B. The reuse branch now checks the current stored token before using the cached snapshot. No real credentials were read.

- Vitest requested hooks/InternalHome/InternalJobDetail set: 67 passed across 6 files.
- Additional actual session API suite: 106 passed; total 173 across 7 files.
- Session hook: 31 tests (previous 22 retained, 9 added parameterized cases); API: 3 added cases.
- Fixture sessions: 2 tests passed; three earlier restoration regressions passed.
- npm run typecheck: exit 0.
- Changed-file ESLint: exit 0.
- git diff --check: exit 0.
- Isolated mutation validation: changing the different-user seed to inherit restoreComplete caused all 3 targeted cases to fail; removing the bootstrap restoreComplete guard caused its targeted test to fail. Original code passes. Temporary mutant copies/config removed; failure logs retained as expected evidence.
- Independent Astra xhigh auth review: no remaining concrete findings. Read-only synthetic harness using actual startup-auth/session-api confirmed unchanged account A, switched account B, signout anonymous.
- Existing untracked e2e journey untouched; not executed. No git writes, new dependencies, production operations, or existing evidence cleanup.
