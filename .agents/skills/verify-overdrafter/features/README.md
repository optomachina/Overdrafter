# Overdrafter verification map

Maintained source for verifying user-facing behavior. Read this index, then the matching feature file. Drive with `../scripts/verify.sh --features <id>`.

## Baseline preconditions

- Fixture mode: repo deps installed (`npm ci`), no database, dev server on `127.0.0.1:4173` started by Playwright. Only `@fixture` specs run.
- Local mode: local Supabase up on `127.0.0.1:54321`, `npm run e2e:prepare` done (seeded `client.demo` and `estimator.demo`, saved auth in `playwright/.auth/`). Non-fixture specs run.
- Never drive a server this run did not start; doctor fails if any listener holds 4173 (or 4174 for the admin operations config). Run `verify.sh --doctor` first.
- Local only: doctor and `--prepare` refuse any non-localhost Supabase or app target in the environment.
- Drive as a non-root user: Chromium runs sandboxed and the sandbox will not start as root. Doctor launches the browser to check.
- Only verdict `PASS` is proof; `INCOMPLETE` (skips, zero passes, missing counts) is not.
- A fixture PASS does not cover `auth-dialog`, `auth-session` or `auth-scope` (local only), nor any real-database provider behavior.

## Driving conventions

- Prefer ARIA roles and accessible names; use `?debug=1` only where the specs do.
- Evidence is written to `artifacts/verify-overdrafter/<UTC stamp>/` (gitignored). Cleanup never removes it. For screenshots of a passing run, append `-- --trace on` and run `../scripts/trace-shots.sh <evidence dir>`.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report it verified through another path.
- No production, provider, customer file, checkout or order action is ever part of a run.

## Features

- [Auth and session](./auth.md): sign in, session persistence, client shell, access scope.
- [Quote](./quote.md): intake, quote comparison, quote destination.
- [Provider and supplier operations](./provider.md): supplier settings, internal admin routes, provider attribution.
