# OVD-1024 verification

Base: f7b322d7 on fix/internal-session-restore-gate. No git writes.
Final changed-source fingerprints: source-sha256.txt.

Confirmed cause: local restore state was mutated inside one observer's query function even though all observers share the app-session query. Joining observers never ran that function; a cancelled function could release its gate while the cache still contained only the auth seed. Dashboard consumed jobs only for metrics and exposed no job links.

Regression evidence before source changes (red.log): all three new tests failed on f7b322d7:
- resolves restoration for every observer of the shared session query
- does not resolve restoration from a cancelled fetch before memberships arrive
- links estimators to their jobs from the dashboard

Final checks:
- vitest.log: 9 files, 217 tests passed, including changed tests, session fixture tests, JobCreate, ClientPart, single-quantity flag and helpers, request intake and beta denial codes.
- job-detail.log: existing InternalJobDetail suite, 5 tests passed.
- session-final.log: 24 session tests passed again after adding restoreComplete:true to the stale-cache test fixture.
- npm run typecheck: exit 0 (typecheck.log).
- Changed-file ESLint: exit 0 (eslint.log), rerun after final test edit.
- git diff --check: exit 0.
- Independent read-only review: no blocking findings. Stale completed projection coverage strengthened in response.

Browser verification remains unperformed: local Vite startup failed with listen EPERM on 127.0.0.1:4184 (browser-server.log). No browser pass claimed.

No migrations, dependencies, legacy changes, or feature-flag behavior changes. Coordinator owns commits and any integration/hosted checks. Both requested defects were addressed; broader auth lifecycle refactoring is outside this bounded fix.
