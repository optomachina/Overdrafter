## Linear issue ID

- Issue: [OVD-480](https://linear.app/overdrafter/issue/OVD-480/provision-isolated-solidworks-workers-and-license-aware-job-leasing)

## Summary

Record native part editing, saved assembly readback and file-admission evidence from SolidWorks 2022 SP5 on Workstation. The architecture now reflects these measured successes while keeping full worker qualification open.

## Problem

The repository described native execution as entirely untested. The Workstation has now created a synthetic 5 mm cylinder, changed a private copy to 8 mm, verified both, and saved and reopened a two-part assembly. Reviewers need the exact evidence and remaining limits before subsequent native-worker work.

## Acceptance criteria addressed

- [x] Record the tested runtime and the user's experimental Windows Home acceptance.
- [x] Preserve part measurements, native file identities, tolerances and failure history.
- [x] Record actual reopened assembly configurations, component positions and CAD references after rebuild, retaining load warning 32.
- [x] Record one valid file control and four rejected file cases with zero CAD calls.
- [x] Separate executor observations, coordinator consistency checks and unproven qualification.

This documentation checkpoint does not complete the full OVD-480 worker issue or OVD-473 context/cache contract.

## Files changed

- `docs/solidworks-2022-feasibility.md`: bounded native evidence, failures and qualification limits.
- `docs/engineering-control-plane.md`: current native status and link to the evidence.

## Scope

Two documentation files, stacked on #465. No application behavior, native executor deployment, migration, customer processing, OS/licensing/security change or external release.

## Verification

Commands run:

```bash
./scripts/symphony-preflight.sh
git diff --cached --check
python3 output/ovd-480-assembly-2026-09-08/validate-packet.py
codex review --commit HEAD --title 'OVD-480 assembly feasibility evidence'
npm run validate:pr-body -- output/ovd-480-assembly-2026-09-08/pr-body.md
```

Results:

- [x] all listed verification passed
- [x] unrelated baseline failures are described below

Baseline failures or exceptions:

- Repository identity and whitespace checks passed. Both changed Markdown files passed local fence and relative-link checks.
- Evidence-focused peer review found no actionable issues. Final local Codex review of `04037d17c3edee1da13efe35ef9a9dfdd5456188` exited zero with no actionable findings. It did not independently reproduce native execution; MCP authentication warnings during shutdown did not prevent the local review.
- The part receipt packet passed 50 local consistency checks. The assembly packet passed 41 checks, with zero failed or pending. These validators do not independently access Windows files or reproduce native execution.
- The native part helper exited zero after 12.964 seconds. The assembly readback helper exited zero after 9.609 seconds; warning 32 was retained, a full active-configuration rebuild passed, and final document count was zero.
- The file harness exited zero after 0.274 seconds. One exact valid package passed; missing, modified, outside-root and prefix-sibling files were rejected. All seven source/original hashes remained unchanged. The shared-predicate native caller was compiled but never executed.
- Hosted checks passed for final commit `04037d17c3edee1da13efe35ef9a9dfdd5456188`, including build, tests, browser tests, lint/typecheck, worker verification, extraction/recovery checks, aggregate CI and Sonar. The single hosted watcher exited zero. CodeRabbit explicitly skipped substantive review because the PR is a draft; its green context is not a code review.
- Lane 0 docs-only change: full repository build/tests/lint were not rerun locally. Historical native caller errors and unknown legacy exits remain documented; they are not replaced by later passes.

## Tests

No repository tests added or changed for the documentation patch. The private evidence validator checks reported geometry, transforms, reference sets, identities, failure-state preservation and file-case receipts. Native measurements and Windows byte hashes remain executor-reported.

## Migration notes

- [x] No migration impact
- [ ] Migration impact exists and is described below

## Rollback / risk notes

Revert the documentation commits to roll back this change; native artifacts and private evidence remain preserved. The main risk is treating a synthetic flat assembly as general qualification. Isolation, reparse-point/race resistance, deployed preflight integration, broader assemblies, licensing/capacity, interrupted CAD recovery and release eligibility remain unproven.

## Documentation

- [x] Docs updated
- [ ] No doc updates needed

## Screenshots or videos (if UI)

Not applicable — no material UI impact.

## Follow-up items

- [ ] Qualify broader prepared assembly dependencies, configurations and component operations.
- [ ] Implement and qualify the isolated serialized worker through subsequent bounded slices.
- [ ] Keep OVD-480 and OVD-473 open until their complete acceptance criteria are met.
