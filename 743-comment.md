QA: FAIL on 9b2621fd
Criteria 1–5 met. Probes in a fresh worktree: click guard refuses case, whitespace, and substring variants; `-` is never parsed and bad prices yield []; cleanup is capped at 30 s; migration is draft-only (supabase/migrations and manifests unchanged vs main, pgTAP in tests/pending); no permit gives `dispatch_authorization_missing`; cleanup and material selectors are labelled a guess/unobserved. The ovd417 preflight failures need docker and the PR doesn't touch them.
Failed required checks:
1. `provider-go-live` (run 38848371995): PR body go-live checklist has 14 unchecked items. Repro: `gh run view 38848371995 --log-failed`.
2. `ci`/`test` (run 38848370047): `worker/src/adapters/providerPortalKernel.offhost.browser.test.ts` > "still stops when the page navigates the main frame off the provider host" fails intermittently. It gets `ambiguous_provider_mutation`/`selector_drift` when it expects `unexpected_origin`. Repro: run `npx vitest run worker/src/adapters/providerPortalKernel.offhost.browser.test.ts` 10× at 9b2621fd. It failed 1 of 10 runs locally plus once in CI; on main 97c02860 it passed 8 of 8.
3. SonarCloud quality gate ERROR: new_duplicated_lines_density 3.7% > 3%.
Proof re-run: `npm run preflight`, targeted vitest (kernel, oshcut, cleanup, migration) + QA probes at 9b2621fd; CI runs 38848370047, 38848371995.
