# Refresh worker XML dependencies to enforce entity limits

The spreadsheet import tools used fast-xml-parser5.4.2, which allows numeric references to bypass configured entity expansion limits. The worker lock also carried a vulnerable standalone fast-xml-builder. Update the lock to parser5.7.0 and standalone builder1.1.7 within the existing manifest range. The required transitive changes are strnum2.2.3 and two MIT dependencies, @nodable/entities2.1.0 and path-expression-matcher1.5.0; no other package entries change.

Four synthetic tests preserve mixed inline/shared/numeric/UTF-8 workbook parsing through both existing importers, require finite rejection of excessive expansion, enforce numeric/hex/standard entity count limits, and verify standalone builder attribute quoting. Malicious parser checks use a child process with a timeout, V8 heap cap and output cap.

Validation: isolated npm ci accepted the unchanged worker manifest and candidate lock (install scripts skipped). Focused importer checks passed22/22. Final npm run verify passed:313 test files,3495 passed/1skipped, frontend build, worker typecheck/build. Subscription-backed local Codex CLI review found no actionable issues. Actual runtime tested was Node22.22.3; the only new explicit engine floor is Node>=14, compatible with repository CI's Node20 by metadata. Node20/image qualification remains CI/release work.

Fresh production audit removes both XML package findings;9 other affected packages (2moderate/7high) remain separate follow-up work. This is not an all-dependencies-clean claim. The parser package's separate XMLBuilder export still permits attribute injection with processEntities:false; the import tools only parse, and this patch does not claim to harden that unused surface. Synthetic tests do not prove arbitrary ZIP/XML resource safety.

Rollback: revert these two files and rebuild to restore the prior dependency graph and remove the tests; this reintroduces the known vulnerabilities. Prefer pausing affected import operations and forward-fixing. No schema/data changes or migration rollback is involved.

Local draft only: source base134389aba914fe641e22a4242869ebd0d807f0db, branch fix/worker-xml-parser-security. Nothing has been published, merged, built into a release image or deployed. The frozen build archive and separate GeoIP/security branches are unchanged.
