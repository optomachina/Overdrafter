# 1.0 source consolidation — September 11, 2026

## Evidence and scope

Snapshot: September 11, 2026, 02:50 UTC. GitHub main:
`5030afc162afded656e783639ae5f24763eb6309`.
This is a dated integration decision, subordinate to PRD, PLAN, ROADMAP and the
specialized security and release contracts. Refresh the snapshot before later
landing or deployment decisions.

The integration assignment excludes OVD-419, all JARVIS work, PR #492 and
PR #495, provider activity, deployment and production mutation. Existing owners
retain those lanes. This document neither admits dependency-blocked work nor
renews operational authority.

Sources inspected:
- Current GitHub open and merged PR metadata, fetched main and source ancestry.
- [1.0 Linear project](https://linear.app/overdrafter/project/overdrafter-10-controlled-beta-part-to-quote-1b4d94414424):
  all 78 non-archived issues, the 29 unfinished non-OVD-419 descriptions/dependencies,
  and the three provider lanes' rolling closeout comments.
- PRD, PLAN, ROADMAP and the controlled-beta runbook from the selected source.
- Existing local worktrees were inventoried and preserved.

Linear currently reports **48 Done, 9 Blocked and 21 Backlog**. The 30 unfinished
issues include parents and children; they are not 30 independent implementation
units. The historical “21 backlog items” number is not the total remaining work.

## Source consolidation decisions

| Work | Current evidence | Integration decision |
| --- | --- | --- |
| OVD-504 audit UUID correction | [PR #493](https://github.com/optomachina/Overdrafter/pull/493) merged at 02:46:38 UTC as `5030afc1`; exact reviewed head `f5427c09` has successful required checks | Already landed independently; do not recreate or cherry-pick. Production migration application is not established by merge metadata. |
| Quickparts / Weerg / Geomiq offline integration | Provider PRs #453/#457, #452/#458, #454/#459 and shared #461 are recorded merged; each rolling comment says currently feasible authorized offline work is complete | Preserve provider-local separation. No new code leaf is admitted merely because operational acceptance remains unchecked. Current portal/package/session evidence is still required by each owner. |
| Provider kit, upload-capability contract, GeoIP removal, notification work | OVD-424/425/426/427, OVD-411, OVD-488 and OVD-485/486/487 are Done | Treat as existing source, not open integration inventory. Done does not certify provider runtime behavior. |
| OVD-419 diagnostic/release source | Separate release owner and retained isolated source artifacts | Excluded from this assignment; do not publish or merge its local successors through this plan. |
| PR #492 / #495 and JARVIS | The only two currently open GitHub PRs are #492 and #495 | Excluded and separately owned. Existing JARVIS commits in main do not authorize deploying their migrations. |
| This consolidation | Two documentation files, no behavior or deployment configuration change | Independently reviewable source-only change. No push, PR or deployment is required to preserve the local decision. |

At this snapshot there is **no open, in-scope PR waiting to be merged**.
Old worktree branches are historical evidence, not a landing queue. Do not clean
them up or reconstruct already merged changes.

## Remaining dependency groups

| Group | Issues | Missing prerequisite / decision |
| --- | --- | --- |
| Release and Xometry baseline | OVD-419 → OVD-416 / OVD-206 | Protected release qualification and hosted certification; separate owner, excluded here. |
| Capability ledger and enforcement | OVD-412 → OVD-413 → OVD-414 (OVD-411 is Done) | OVD-412 has completed source prerequisites but is explicitly High complexity, with implementation forbidden absent a scoped override or accepted decomposition. PLAN also keeps this chain unadmitted. OVD-413 is High and depends on the ledger. |
| Generic authorization | OVD-380; OVD-457 → OVD-458 → OVD-459 / OVD-460 | OVD-457 explicitly waits for OVD-206 to freeze Xometry compatibility. Parent OVD-380 is High; no baseline freeze may be fabricated from offline tests. |
| Generic worker flow | OVD-381; OVD-461 / OVD-462 / OVD-463 → OVD-464 | Requires OVD-380 plus capability-ledger/dispatch/file-selection chain. Pure or standalone code labels do not remove these dependencies. |
| Provider operational work | OVD-429 / OVD-432 / OVD-435 | Offline source is landed; reviewed real portal bindings and authorized operational evidence remain. This assignment excludes provider actions. |
| Provider certification | OVD-395; parents OVD-396 / OVD-397 / OVD-398; children OVD-430 / OVD-433 / OVD-436 | Fictiv and provider parents are High coordination scopes. Shared controls, permission/session/package evidence and independent hosted certification are missing. Empty graph edges on a parent do not make it an executable leaf. |
| Combined journey and beta | OVD-385, OVD-199 → OVD-319 → OVD-358 | Shared controls, five certified sources, end-to-end enablement and participant evidence remain. Billing is not a prerequisite. |

The three provider closeout comments are dated September 8. Their account
statements are historical; this assessment did not recheck accounts or infer
that an account is absent. Their operational acceptance remains unverified.

## Selection and next source action

**No eligible non-OVD-419/non-JARVIS implementation leaf was found under the
current admission rules.** The highest-impact prerequisite-complete candidate
is OVD-412, but “prerequisite-complete” is not “admitted”: its issue explicitly
requires a High-complexity override or decomposition. Starting the entire
ledger would violate the requested unblocked-only selection.

Ranked next actions:
1. Preserve this current source/dependency decision as a focused local commit.
2. Have the prioritizing owner select a bounded OVD-412 decomposition or obtain
   its explicit scoped High override before implementation. Do not silently
   split it across agents or create new issues from this assessment.
3. Let the separate OVD-419 owner establish the missing release/authentication
   evidence; this integration lane does not repeat that investigation.
4. After OVD-206 closes, admit OVD-457 and follow the authorization/worker
   dependency order above, with one writer per isolated branch.
5. Certify providers independently, then satisfy OVD-319 and OVD-358 before
   claiming a beta link is ready.

The immediate executable source task in this assignment is documentation
consolidation. It does not substitute for completion of a product feature.
The requested follow-on implementation is blocked by work admission, not by
lack of filesystem access, a pending PR merge, or an unexamined coding task.

## Validation, risks and rollback

Complexity: **Low**. Scope: this decision and one PLAN cross-reference. No new
dependencies, runtime code, schema, API, infrastructure or migration changes.
Lane 0 verification: repository identity/preflight, source references and
dependency/count reconciliation, local Markdown link checks, and diff hygiene.
Application tests are not applicable to documentation-only changes.

The snapshot will age. Re-fetch GitHub and relevant issue relations before
acting; do not treat this document as a standing production preflight.
Rollback is a normal revert of the documentation commit. All existing
worktrees, source evidence, runtime settings and issue states are preserved.
