## Linear issue ID

- Issue: Not assigned; bounded OverDrafter 1.0 worker security maintenance.

## Summary

Update the worker lockfile to fast-xml-parser 5.7.0 and standalone fast-xml-builder 1.1.7 within the existing parser manifest range. Add four synthetic regression tests for both spreadsheet importers and the affected dependency behavior.

## Problem

The installed parser 5.4.2 allows numeric references to bypass configured entity expansion limits (GHSA-8gc5-j5rx-235r). Standalone builder 1.0.0 also has an attribute-quote advisory (GHSA-5wm8-gmm8-39j9).

## Acceptance criteria addressed

- [x] Refresh only the affected XML dependency graph while preserving the worker manifest and all unrelated lock entries.
- [x] Preserve mixed inline/shared/numeric/UTF-8 workbook rows in both existing importers.
- [x] Exercise finite entity-limit rejection and standalone builder attribute quoting with synthetic fixtures.

## Files changed

- `worker/package-lock.json`: parser 5.7.0, standalone builder 1.1.7, strnum 2.2.3, and required MIT transitive additions @nodable/entities 2.1.0 and path-expression-matcher 1.5.0. Exactly five package entries change.
- `worker/src/tools/xml-import-security.test.ts`: four regression tests, including child-process timeout, heap, and output bounds for adversarial probes.

## Scope

Bounded XML dependency maintenance and synthetic tests. The worker manifest, root lock metadata, runtime importers, schema, provider controls, and customer files are unchanged. No release image build or production deployment is part of this PR.

## Verification

Commands run:

```bash
npm ci --ignore-scripts --audit=false --fund=false  # isolated worker install
node node_modules/vitest/vitest.mjs run worker/src/tools/importSpreadsheetQuotes.test.ts worker/src/tools/importDmriflesQuotes.test.ts worker/src/tools/xml-import-security.test.ts
npm run verify
npm audit --omit=dev  # worker; findings remain, as disclosed below
```

Results:

- [x] Install and focused checks passed: 22/22 tests, including a fresh run on PR head `716b82f14d2c5e39df4deb43fb6defe4872ed3f7` based on main `7f0c310e68a1f15fa17b1a7eb33a5cb1417d3335`.
- [x] Full `npm run verify` passed on the identical patch against earlier base `134389aba914fe641e22a4242869ebd0d807f0db`: migration lineage, provider catalog, lint, app typecheck, 313 test files / 3495 passed / 1 skipped, frontend build, and worker typecheck/build.
- [x] Subscription-backed local Codex CLI review of that final patch found no actionable issues.
- [x] Rebase preserved the exact patch SHA-256 `a5b054c3756e5395c582186f86ea5b2fc13e1d713b398a79a07f6e0c4fcfab7d`; fresh scope checks confirm exactly five changed lock entries and an unchanged worker manifest.

Baseline failures or exceptions: initial lint found unnecessary escapes in the new test, corrected before the passing full gate and local review. The full local gate was not repeated solely for the unrelated Dockerfile, GeoIP-input test, and release-documentation base changes; hosted CI qualifies the new head. Local Node was 22.22.3; CI uses Node 20. Install scripts were skipped only for the isolated local dependency check. Audit remains nonzero: nine affected package entries (two moderate / seven high), with both XML-package findings absent at audit time. Native GitHub Codex review is currently unavailable because of the account connection; the local Codex review receipt remains applicable to the identical patch. CodeRabbit reported its free OSS review limit and did not perform a review despite its success status; no review threads are currently present. Repository policy requires CodeRabbit threads to be resolved or confirmed absent, not a completed CodeRabbit review.

## Tests

Four synthetic tests cover mixed workbook rows through both actual importers, excessive expansion with their parser options, numeric/hex/standard entity count limits, and standalone builder attribute quoting with entity processing disabled. Adversarial probes are capped at three seconds, 64 MiB V8 heap, and 64 KiB output. Existing importer suites, including sparse-column behavior, remain green.

## Migration notes

- [x] No migration impact.

## Rollback / risk notes

The parser package's separate `XMLBuilder` export still permits extra attributes with `processEntities:false`; the importers only parse, and this PR does not claim to fix that unused builder surface. Synthetic tests do not prove arbitrary ZIP/XML resource safety. Reverting these two files and rebuilding restores the old graph and known vulnerabilities; prefer pausing affected imports and forward-fixing. No data or configuration rollback is required. Dependency upgrades add two required MIT transitives; the new explicit engine floor is Node >=14, which is metadata compatibility rather than image-execution evidence.

## Documentation

- [x] No product doc updates needed: no workflow, API, architecture, or runtime importer contract changes. This description records the security limits, validation qualification, and remaining follow-ups.

## Screenshots or videos (if UI)

Not applicable — no material UI impact. Original local logs and review receipts are preserved under `output/xml-parser-security/` and are intentionally excluded from source changes.

## Follow-up items

- [x] Hosted CI passed on head `716b82f14d2c5e39df4deb43fb6defe4872ed3f7`, including aggregate `ci`, full test/browser-test jobs, and worker verification. Sonar analyzed this exact head with quality gate OK, zero unresolved issues, and zero hotspots. GitHub reports no review threads. CodeRabbit review remains unavailable as disclosed above.
- [ ] Track the remaining nine production-audit entries separately; this PR is not an all-dependencies-clean claim.
- [ ] Rebuild and qualify the worker release image through the separately coordinated release workflow before claiming running-image hardening.
