# Worker XML dependency security repair

Local preparation only. No commit, push, PR publication, merge, deployment, database apply, provider operation, or customer workbook access.

Base: `134389aba914fe641e22a4242869ebd0d807f0db` (main verified before branching). Worktree: `/Users/blainewilson/.codex/worktrees/xml-import-security/Overdrafter`; branch: `fix/worker-xml-parser-security`.

## Patch and scope

The worker lockfile previously installed parser5.4.2, whose entity expansion limit can be bypassed by numeric references, and standalone builder1.0.0 with an attribute-quote advisory. Advance only `worker/package-lock.json` to parser5.7.0 and standalone builder1.1.7 within the unchanged declared parser range `^5.2.5`. Required transitive resolution also changes strnum2.2.0→2.2.3 and adds @nodable/entities2.1.0/path-expression-matcher1.5.0. Exactly five package entries change; root manifest metadata and worker/package.json remain byte-identical. No overrides remain in the application manifest.

`worker/src/tools/xml-import-security.test.ts` adds four synthetic tests: both actual importers return the same expected mixed inline/shared/numeric/UTF-8 workbook row; default importer parser options reject excessive entity expansion; numeric/hex/standard entity references obey an explicit small count limit; standalone builder quote escaping survives disabled entity processing. Adversarial dependency probes run in a child process capped at3seconds/64MiB V8 heap/64KiB output. The fixtures contain no customer content and exercise no importer execution/upload/DB function.

Risk class: bounded dependency maintenance, with two disclosed transitive additions. All new resolved packages are MIT. path-expression-matcher declares Node>=14; other changed entries have no engine requirement. Repository CI uses Node20 (`.github/workflows/ci.yml`); actual local verification uses Node22.22.3. This is metadata compatibility, not a Node20 or production image execution claim.

## Verification

- Exact lock accepted by isolated `npm ci --ignore-scripts --audit=false --fund=false` (162packages). Installation scripts were deliberately skipped; browser/native-provider startup is outside this check.
- Focused existing importer suites plus new tests:22/22 passed. Existing sparse-column test remains green. Root tool dependencies use the unchanged primary checkout node_modules through a local symlink; worker dependencies are a separate installation from this candidate lock.
- Small old-parser regression probe: installed5.4.2 accepted11 numeric references with maxTotalExpansions10; candidate test rejects them. The optional old standalone-builder comparison could not load its missing installed CJS entry and is not a baseline behavior claim; raw receipt preserves that limitation.
- Fresh `npm audit --omit=dev` reports9 affected package entries (2moderate/7high), down from11 (2moderate/9high); neither fast-xml-parser nor fast-xml-builder remains reported. The other findings are not fixed or waived. Audit metadata is time-dependent and is not an exploitability assessment.
- Initial root gate stopped on two unnecessary escape characters in the new test. Those were removed without changing child code semantics. Final-source `npm run verify` PASS (exit0): migration lineage, provider catalog, lint, application typecheck,313 test files/3495 tests passed/1skipped, frontend build, worker typecheck/build. The unchanged OVD420 recovery-egress tests passed on this run; no inherited timeout limitation applies to this patch. See `root-verify-final.log` lines495–522.
- Required subscription-backed native local Codex CLI review PASS (exit0,81.59seconds): no actionable findings. Captured staged diff includes the final corrected test. `--ignore-user-config`, read-only sandbox, API-key variables removed, forced ChatGPT login and disabled web search; no reviewer tests/edits/publication. See `local-codex-review.md` and `local-codex-review-result.json`. Review is advisory and does not replace later CI/human approval.
- `git diff --cached --check` passed; exactly two staged source files,125 insertions/12deletions. No dependency or source changes after the final gate/review.

## Limits and release boundary

The parser package's separate `XMLBuilder` export still emits extra attributes when `processEntities:false`; updating standalone fast-xml-builder does not repair that distinct implementation. No worker runtime builder call was found in the source triage; the spreadsheet tools instantiate XMLParser. Do not describe this patch as fixing all XMLBuilder surfaces. The malicious-input tests exercise bounded parser payloads and do not prove arbitrary ZIP/XML resource safety or change the importers' optional sharedStrings exception behavior. No new provider/auth behavior is introduced.

A later publication/merge/image rebuild/deployment remains separate work requiring the applicable exact authorization. This local patch neither updates the frozen release archive nor hardens an already-running image. Other production audit entries remain follow-up scope.

## Rollback

Reverting these two source files and rebuilding restores the old dependency graph and removes the regression tests; that reintroduces the known parser/standalone-builder exposure. Prefer pausing affected import operations and forward-fixing rather than deploying that vulnerable rollback. There are no schema/data/config migrations to reverse.

## Evidence

`lock-scope.json`, `worker-install.log`, `focused-tests.log`, `baseline-regression-probe.json`, `audit-after.json`, `root-verify.log`, `root-verify-final.log`, and local Codex review artifacts are retained in this directory. `resolution/` is disposable local lock-resolution scaffolding only, not proposed source.

Primary advisories: https://github.com/advisories/GHSA-8gc5-j5rx-235r and https://github.com/advisories/GHSA-5wm8-gmm8-39j9. The prior triage additionally records parser zero-limit and comment/CDATA advisory coverage for the chosen5.7.0 floor.
