import sys
src, dst = sys.argv[1], sys.argv[2]
b = open(src, encoding="utf-8").read()
R = []
def rep(old, new):
    n = b.count(old)
    assert n == 1, (n, old[:90])
    R.append((old, new))
def apply():
    global b
    for o, n in R:
        b = b.replace(o, n)

# Top warning
rep("expects the hosted database to already carry migrations 127-139.",
    "expects the hosted database to already carry every migration through 139.")
rep("**the coordinator's production-apply packet v1 (migrations 134-139, pre-apply checks, readback, rollback)**",
    "**the coordinator's production-apply packet v3 (the 27-migration suffix from the live ledger tip 20260924014552 through 139, pre-apply checks, readback, rollback)**")

# Acceptance criteria: hosted checks / Sonar
rep("**SonarCloud is red** (quality gate ERROR on new reliability and security ratings). That is recorded in the Sonar section and is not counted as passing.",
    "The two SonarCloud check runs at `f9348a2` failed at analysis time (quality gate ERROR on new reliability and security ratings) and are not counted as passing. After the owner's dispositions on 2026-10-08 the quality gate was re-evaluated to **Passed** on the same analysis; the check runs themselves are not re-run until a new push. See the Sonar section.")
rep("and dispositioned by group below. Group (c), new and real: none found.",
    "and dispositioned by group below. Group (c), new and real: none found. On 2026-10-08 the owner applied the 48 BUG and VULNERABILITY dispositions in the Sonar UI (26 False Positive, 22 Accepted); 0 open bugs or vulnerabilities remain and the quality gate is OK.")

# Acceptance criteria: CodeRabbit
old_cr_ac = b[b.index("- [ ] **CodeRabbit at the head: no review exists."):]
old_cr_ac = old_cr_ac[:old_cr_ac.index("\n")]
rep(old_cr_ac,
    "- [ ] **CodeRabbit coverage: in progress (owner decision 2026-10-08: split review, no waiver).** CodeRabbit cannot review this PR as one unit: the request at `0924c56` ([6022294046](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022294046)) was answered \"Review skipped: 418 files exceed the limit of 100\" ([6022301204](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022301204)), and the summary at `f9348a2` ([5965117751](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-5965117751)) again reads \"Too many files!\" (plan: Advanced). A read-only coverage audit on 2026-10-08 found every merged stack PR covered by CodeRabbit at its final head, and three bodies of code never reviewed on any PR: the recovered release source (360 files), the #572 delta `7fd1b9a..6df8b8b` (10 files) and the #568 delta `d7899b7..5d419e4` (`ARCHITECTURE.md`). Eight review-only PRs on frozen `review/564-*` refs now cover exactly that code: #606, #607 and #608-#613 (tracked in OVD-643; never merged). Their CodeRabbit reviews are pending. This item stays open until OVD-643 is closed with all eight reviewed and their findings dispositioned.")

# Migrations paragraph
old_mig = b[b.index("The apply packet v1 covers 134-139."):]
old_mig = old_mig[:old_mig.index("\n")]
rep(old_mig,
    "**Production ledger (owner's read-only reading, 2026-10-08): 112 rows, ending at `20260924014552`, not at 133.** Production holds `main`'s first 104 migrations plus `20260905030647`, `20260905233435`, `20260923035755`, `20260924001152`, `20260924001203`, `20260924004159`, `20260924004202` and `20260924014552`. It lacks 14 `main` migrations (`20260910045917`, `20260910055556`, `20260910064137`, `20260910104500`, `20260910134500`, `20260911031500`, `20260926225000`, `20260927060736`, `20260927065514`, `20260927130000`, `20260927140000`, `20260927225843`, `20260928081530`, `20260928081534`) and all 13 of 127-139. The apply input is therefore the coordinator's production-apply packet v3: 27 migrations (the 14 missing `main` migrations and 127-139; 28 once OVD-641's migration merges), with its pre-apply checks, readback and rollback notes. Its pre-apply ledger fingerprint `212b70060764426f5f83ee6c58fa2085` is recorded. Nothing has been applied.")

# Scope sentence
rep("They made no code change and no push.",
    "They made no code change and no push. The 2026-10-08 round again changed only this body and the readiness comment; no code change and no push.")

# Verification: note 2026-10-08 re-reads
rep("Results:\n\n- [x] all listed verification passed",
    "Re-read on 2026-10-08 through the same Sonar APIs, still on the analysis of `f9348a2`: `qualitygates/project_status` OK; open BUG and VULNERABILITY issues 0; open code smells 1,379. The CodeRabbit coverage audit of the same day read the stack PRs' reviews and summary comments read-only.\n\nResults:\n\n- [x] all listed verification passed")

# Hosted checks rows
rep("| SonarCloud Code Analysis | 112585096640 | **failure**: quality gate ERROR (see Sonar below) |",
    "| SonarCloud Code Analysis | 112585096640 | **failure** at analysis time: quality gate ERROR. The gate was re-evaluated to Passed on 2026-10-08 after the owner's dispositions; this check run is not re-run until a new push (see Sonar below) |")
rep("| SonarCloud | 112585103750 | **failure**: same gate |",
    "| SonarCloud | 112585103750 | **failure** at analysis time: same gate, re-evaluated to Passed on 2026-10-08; not re-run until a new push |")

# Review findings bullets
old_sonar_b = b[b.index("- Sonar: 1,427 open issues at the head"):]
old_sonar_b = old_sonar_b[:old_sonar_b.index("\n")]
rep(old_sonar_b,
    "- Sonar: quality gate **OK (Passed)** since 2026-10-08, on the analysis of `f9348a2`. The owner dispositioned all 48 BUG and VULNERABILITY issues in the Sonar UI with source-bound rationales (26 False Positive, 22 Accepted); 0 open bugs or vulnerabilities remain. The 1,379 open code smells are unchanged, dispositioned by group below, and not gate-relevant.")
old_cr_b = b[b.index("- CodeRabbit: **no review at this head; owner-blocked"):]
old_cr_b = old_cr_b[:old_cr_b.index("\n")]
rep(old_cr_b,
    """- CodeRabbit: **coverage in progress through a split review (owner decision 2026-10-08, no waiver).** CodeRabbit skips this PR on its plan file limit: \"Review skipped: 418 files exceed the limit of 100\" ([6022301204](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022301204)) after the request at `0924c56` ([6022294046](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022294046)), and \"Too many files!\" in the summary for `9d0c79b..f9348a2` ([5965117751](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-5965117751)). There is no review object or review thread on this PR.
  - Coverage audit (2026-10-08, read-only; only non-empty review objects and completed summaries with a commit range count). Covered at their final heads: #566 (review 5406944320, `084b48c..1b44a32`; 2 threads, both resolved), #571 (completed summary 5971700997, `4b69683..03773fc`, 11/11 files; no review object), #573 (summary 5972072399 spanning the whole PR, `039bb7e..72c3fd7`), #574 (summary 5972571436, `cc2d41e..0729f37`, 37/37), #580 (5981413340), #596 (6005320961), #597 (review 5432247548, `d474317..e3fcfc4`, 19/19; the conflict resolution in `scripts/ovd510-replay-body.mjs` and `.github/workflows/native-sql-proofs.yml` was reviewed, and `scripts/ovd510-disposable-replay.mjs` was unchanged by the merge) and #603 (summary 6027994871). #592's post-review gap (the forward-merge of #580) is covered by #574's full-range review. Every merge or squash commit's tree equals its PR's final head.
  - Never reviewed on any PR: the recovered release source (`9d387c0` with checkpoints `30192b7..084b48c`, 22 commits forked from `8d8d243`; 360 files, +41,215/−1,542); the #572 delta `7fd1b9a..6df8b8b` (10 files, +438/−65: `worker/src/chromiumLaunchOptions.test.ts`, `scripts/worker-runtime-user.test.mjs`, `worker/src/adapters/providerEvidenceRedaction.ts` and its test, `worker/Dockerfile`, `worker/README.md`, `scripts/ovd420-recovery-egress-control.sh` and its test, `scripts/verify-xometry-recovery-host.test.mjs`, `docs/workflows/ovd410-stable-egress.md`); and the #568 delta `d7899b7..5d419e4` (`ARCHITECTURE.md`, +25/−15).
  - Split (tracked in OVD-643): review-only PRs on frozen `review/564-*` refs, never merged. The slices copy files verbatim from `084b48c` onto `8d8d243`; their union is the 360 recovered-source files with 0 duplicates.

    | PR | Covers | Files |
    |---|---|---|
    | #606 | #572 delta `7fd1b9a..6df8b8b` | 10 |
    | #607 | #568 delta `d7899b7..5d419e4` | 1 |
    | #608 | slice 1/6: supabase migrations, tests, fixtures | 58 |
    | #609 | slice 2/6: scripts, workflows, build config | 84 |
    | #610 | slice 3/6: worker provider-capability services | 49 |
    | #611 | slice 4/6: worker adapters, jev, quote intelligence, recovery, tools | 61 |
    | #612 | slice 5/6: client `src`, `server`, `api` | 64 |
    | #613 | slice 6/6: e2e specs, docs | 44 |

  - CodeRabbit is requested on one PR per hour in that order, behind PR #605. The reviews were pending at the time of this edit. The remaining condition is the closure of OVD-643: all eight reviewed and their findings dispositioned. A real defect found there is fixed through a separate small PR into the integration branch, never directly on this branch.""")
rep("- [ ] Inspected findings and threads on the final head: Sonar is done; CodeRabbit produced no review (owner-blocked, see above).",
    "- [ ] Inspected findings and threads on the final head: Sonar is done; CodeRabbit coverage is in progress through the split review (OVD-643, see above).")

# Sonar section
rep("Quality gate (`qualitygates/project_status`): **ERROR**.\n\n| Metric | Value | Threshold | Status |\n|---|---|---|---|\n| `new_reliability_rating` | 4 (D) | 1 | ERROR |\n| `new_security_rating` | 4 (D) | 1 | ERROR |\n| `new_maintainability_rating` | 1 | 1 | OK |\n| `new_duplicated_lines_density` | 1.4% | 3% | OK |\n| `new_security_hotspots_reviewed` | 100% | 100 | OK |",
    "Quality gate (`qualitygates/project_status`): **OK** on 2026-10-08, on the same analysis of `f9348a2`. It read ERROR on 2026-10-07 and was re-evaluated after the owner's dispositions described below. Open BUG and VULNERABILITY issues: 0. Open code smells: 1,379 (unchanged; not gate-relevant).\n\n| Metric | 2026-10-07 | 2026-10-08 | Threshold | Status now |\n|---|---|---|---|---|\n| `new_reliability_rating` | 4 (D) | 1 | 1 | OK |\n| `new_security_rating` | 4 (D) | 1 | 1 | OK |\n| `new_maintainability_rating` | 1 | 1 | 1 | OK |\n| `new_duplicated_lines_density` | 1.4% | 1.4% | 3% | OK |\n| `new_security_hotspots_reviewed` | 100% | 100% | 100 | OK |")
rep("`src/components/admin/OperationsStatusCard.tsx:65-66` | False positive. These are default sorts of string arrays (identifiers, categories, subsystems). Code-unit order is deterministic and locale-independent, which is what canonical hashing and comparison need; `localeCompare` would make it locale-dependent. |",
    "`src/components/admin/OperationsStatusCard.tsx:65-66` | False Positive (marked 2026-10-08). These are default sorts of string arrays (identifiers, categories, subsystems). Code-unit order is deterministic and locale-independent, which is what canonical hashing and comparison need; `localeCompare` would make it locale-dependent. The two display sorts in `OperationsStatusCard.tsx:65-66` sort fixed, validated category/provider/subsystem identifiers. |")
rep("| False positive. `if (this.pendingGate)` checks",
    "| False Positive (marked 2026-10-08). `if (this.pendingGate)` checks")
rep("| False positive. The `try` guards a synchronous `cancel()` throw on a locked or errored stream; `.catch` covers only the async rejection. |",
    "| Accepted (2026-10-08). The analyzer is correct: a standards-compliant `cancel()` rejects its Promise rather than throwing. The defensive `try` is retained on purpose. |")
rep("| False positive. Each file is a bare",
    "| False Positive (marked 2026-10-08). Each file is a bare")
rep("| False positive. `container` must match",
    "| False Positive (marked 2026-10-08). `container` must match")
rep("| False positive. Line 13 only passes",
    "| False Positive (marked 2026-10-08). Line 13 only passes")
rep("| Accepted. These are CI and local qualification runners",
    "| Accepted (2026-10-08). These are CI and local qualification runners")
rep("and the S8705 guard lines were re-read at `f9348a2`. No fix PR",
    "and the S8705 guard lines were re-read at `f9348a2`. Before the Sonar UI step on 2026-10-08, every one of the 48 BUG and VULNERABILITY sites was independently re-verified against source at `f9348a2` (coordinator audit: 0 real defects; 4 rationale corrections, for the two `OperationsStatusCard.tsx` display sorts and the two S4822 sites, applied as above). No fix PR")
rep("If the CodeRabbit review finds a real defect,", "If the split CodeRabbit review finds a real defect,")
rep("The gate stays red until the owner marks the false positives in the Sonar UI. That is protected, so the gate is listed as owner-blocked below and is not waived.",
    "The owner applied these dispositions in the Sonar UI on 2026-10-08: all 48 BUG and VULNERABILITY issues, 26 False Positive (17 S2871, 2 S6544, 3 S905, 2 S8705, 2 S5443) and 22 Accepted (20 S4036, 2 S4822), each with a source-bound rationale. The quality gate then re-evaluated to **Passed** on the existing analysis of `f9348a2`. The two SonarCloud check runs still show their analysis-time failure until a new push re-runs them.")

# Owner checklist
rep("## Owner checklist (protected; none done)", "## Owner checklist (protected; no production step done)")
old_prod = b[b.index("- [ ] **Production database apply and readback**"):]
old_prod = old_prod[:old_prod.index("\n")]
rep(old_prod,
    "- [ ] **Production database apply and readback**: run the coordinator's production-apply packet v3: the read-only pre-apply checks (pre-apply ledger fingerprint `212b70060764426f5f83ee6c58fa2085` recorded), a forward-only apply of the 27-migration suffix from the live ledger tip `20260924014552` through 139 (the 14 missing `main` migrations and 127-139; 28 once OVD-641's migration merges), the post-apply readback, and its per-migration rollback notes. The owner's read-only reading on 2026-10-08 found 112 ledger rows ending at `20260924014552`, not 133 (see Migrations beyond `main`). Runbooks: `docs/workflows/ovd418-qualified-database-release.md`, `ovd361-production-deployment.md`. Not done.")
rep("- [ ] **Sonar false-positive marking** in the SonarCloud UI for the group (b) BUG and VULNERABILITY issues above. This is what turns the quality gate green.",
    "- [x] **Sonar false-positive marking**: done by the owner in the SonarCloud UI on 2026-10-08. All 48 group (b) BUG and VULNERABILITY issues dispositioned with source-bound rationales: 26 False Positive, 22 Accepted. 0 open bugs or vulnerabilities; the quality gate re-evaluated to Passed.")
rep("- [ ] **X1 test runtime**: the inert workstation test-runtime qualification is owner-run (Workstation access).",
    "- [x] **X1 test runtime**: done. All 11 X1 inert suites passed at the activation-commit candidate `91bfa3c` (test-runtime added 2026-10-08: exit 0, 39.02 s, nativeCalls 0, SLDWORKS 2/2 untouched; receipt SHA-256 `de5880d83c571a9a55dc9d85b85bf727c688db7b2e4d616ec5c693eaa4f00060`, summary.json `ad84002cd55e4234baeed60ef37847ecd54ea704b9977d60daef38c3206243a6`, manifest `1845cd03ca1309cc79d4806308a79be3ccd20d46748b15c7909eb7a3ddc579ab` with 212/212 entries verified OK). This is not native qualification.")
old_crd = b[b.index("- [ ] **CodeRabbit coverage decision**"):]
old_crd = old_crd[:old_crd.index("\n")]
rep(old_crd,
    "- [x] **CodeRabbit coverage decision**: decided: split (2026-10-08). No waiver. Review-only PRs #606-#613 on frozen `review/564-*` refs (see Review findings).\n- [ ] **CodeRabbit split review closure**: the remaining condition is the closure of OVD-643, with all eight review-only PRs reviewed by CodeRabbit and their findings dispositioned.")

# Rollback
rep("- Database rollback is forward-only, per migration. For 134-139 it is written in the apply packet's rollback section (for example, 134 re-grants `EXECUTE` to the failing role; 135 and 136 revoke the new entrypoints; 137-139 re-apply the previous definitions). For 127-133 it belongs to the qualified database release path: rolling back 127 or 128 would mean",
    "- Database rollback is forward-only, per migration, and is written in the apply packet v3's rollback notes (for example, 134 re-grants `EXECUTE` to the failing role; 135 and 136 revoke the new entrypoints; 137-139 re-apply the previous definitions). Rolling back 127 or 128 would mean")

# Documentation
rep("This round updated only the PR body.", "This round updated only the PR body and the readiness comment.")

# Follow-up
old_fu = b[b.index("- [ ] CodeRabbit coverage of the integration head (owner-blocked)"):]
old_fu = old_fu[:old_fu.index("\n")]
rep(old_fu,
    "- [ ] CodeRabbit coverage of the integration head: decided 2026-10-08 as a split review (no waiver) on review-only PRs #606-#613 (tracked in OVD-643; never merged). The remaining condition is the closure of OVD-643: all eight reviewed and their findings dispositioned. An actionable thread that shows a real defect is fixed through a separate small PR into the integration branch; anything else is dispositioned on its review PR.")

apply()
open(dst, "w", encoding="utf-8").write(b)
print("replacements:", len(R))
