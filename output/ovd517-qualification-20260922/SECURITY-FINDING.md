# OVD-419 release-readiness security finding

Captured 2026-09-23 03:45–03:48 UTC through read-only catalog/advisor queries against production. **Release-blocking finding; no function invocation, quote mutation or privilege change was performed.**

## Finding

`public.insert_published_quote_option(uuid, public.client_option_kind, uuid, integer, numeric, numeric, text, uuid)` is a `SECURITY DEFINER` function owned by `postgres`. Production grants `EXECUTE` to `PUBLIC`, `anon`, `authenticated` and `service_role`. Its body does not call `require_verified_auth`, `is_internal_user`, or another caller-authorization guard. Given valid package and vendor-result identities, it inserts or updates `public.published_quote_options` using caller-supplied markup inputs. That table has RLS enabled but not forced, is owned by `postgres`, and has no non-internal trigger that adds a caller check. The function body and grants were read directly from the production catalog; the current Supabase security advisor also reports it as anonymously executable.

The guarded parent `public.api_publish_quote_package` checks verified authentication and internal-user status before calling this helper. Those parent checks do **not** protect a direct API call to the separately granted helper. Supabase documents that functions can be called through its API, `SECURITY DEFINER` runs with creator privileges, and function execution must be explicitly revoked when it should not be public: https://supabase.com/docs/guides/database/functions.

This is a credible unauthenticated quote-publication/pricing integrity path **if a caller has valid record IDs**. No live exploit, ID discovery, customer-row read or write was attempted, so successful end-to-end abuse has not been demonstrated. The grant/body/ownership combination is sufficient to block production release pending remediation or an evidence-backed disposition.

## Bounded remediation proposal — not authorized or executed

1. Treat the exact function as an internal helper. Prepare a forward-only, narrowly scoped grant correction revoking `EXECUTE` from `PUBLIC`, `anon` and `authenticated`; inspect whether `service_role` needs direct execution before deciding its grant. Do not change unrelated database functions or weaken parent authorization.
2. Test in an explicitly disposable database: catalog/role assertions show anonymous and authenticated direct calls are denied; the guarded parent publication path still succeeds for an authorized internal user; existing negative authorization and pricing tests still pass. Use synthetic IDs/rows only.
3. Plan production application separately from the five deferred September 10 migrations. A normal broad migration push would include those unrelated files. Reconcile exact migration-history behavior, rollback, advisor result and current production ledger before requesting one specific protected database operation.
4. After a separately authorized production correction, re-read the exact grants and advisor finding, and recapture OVD-419's other release predicates. No prior build-only approval covers this change.

Under the repository complexity policy this is High because it changes a production database privilege/API contract. A scoped human override and exact database-change authority are required before implementation/application. OVD-419 and downstream OVD-206 remain Blocked.
