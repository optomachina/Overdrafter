> **Protected production release. Do not merge without the owner.** Merging this PR into `main` is the production release: it auto-deploys the Vercel frontend from `main` and expects the hosted database to already carry every migration through 139. The merge input is **the coordinator's production-apply packet v3 (the 27-migration suffix from the live ledger tip 20260924014552 through 139, pre-apply checks, readback, rollback)**. Order: run the packet's read-only pre-apply checks, apply the database, read back, then merge. **No production change has been made**: nothing from this branch has been applied to the hosted or production database, deployed to Cloud Run, or merged into `main`.

## Linear issue ID

- Issue: none. This is the release integration PR. The release parent is named only in words here, because a bare identifier would auto-close it.
- Each bounded change on this branch was delivered under its own issue and PR (stack table below). This PR adds no new scope; it carries them to `main`.
- This PR is not the main PR of any issue, and it does not close the release parent.

## Summary

The release integration branch `codex/recovered-release-free-safety-20261003` at head **`f9348a2768088214be0febb5b08def3f40674e20`**. It contains:

- the recovered release source with the free-quote safety fixes (`9d387c0`) and its hosted-qualification checkpoints (through `084b48c`);
- eight merged PRs, listed below with their merge commits and the final review/summary comment of each: six stacked change PRs and two main syncs;
- the two main syncs: #597 (`main` at `506c9dd`) and #603 (`main` at `9d0c79b`, carrying #598, #599, #600, #601 and #602).

Branch facts at `f9348a2`, read with git on 2026-10-07:

| Fact | Value | How it was read |
|---|---|---|
| Ahead of `main` | 32 commits | `git rev-list --count origin/main..HEAD` |
| Behind `main` (`9d0c79b`) | 0 | `git rev-list --count HEAD..origin/main` |
| Merge into `main` | conflict-free (tree `a45aebc315880881d9646fb9df199ebd58fe4843`) | `git merge-tree --write-tree origin/main HEAD` exit 0 |
| Files / diff | 419 files, +58,416 / −1,784 | GitHub PR stats |
| Migrations | 139 on the branch, 126 on `main`; 13 beyond `main` (127-139) | `git diff --name-status origin/main HEAD -- supabase/migrations` |

### Merged into the branch (stack, oldest first)

| PR | Issue | Merge commit | What | Final review / summary comment |
|---|---|---|---|---|
| #566 | OVD-597 | `bdd8578` | Single `.sonarcloud.properties`, Playwright browser cache in CI | [final gate at 1b44a327](https://github.com/optomachina/Overdrafter/pull/566#issuecomment-5983091671) |
| #572 | OVD-593 | `4b69683` | Worker browser runtime: non-root image, 0600 session files, fail-closed retry after provider mutation, DOM redaction. The deploy sandbox default stays `true` until a Cloud Run smoke | [merge disposition at 6df8b8b2](https://github.com/optomachina/Overdrafter/pull/572#issuecomment-5987918381) ([review record correction](https://github.com/optomachina/Overdrafter/pull/572#issuecomment-5985442685)) |
| #571 | OVD-536 | `fce8ba3` | Migration 134: revoke client execution of `log_audit_event`, atomic guard | [adversarial verification summary](https://github.com/optomachina/Overdrafter/pull/571#issuecomment-6009393728) |
| #568 | OVD-457 | `039bb7e` | Provider-neutral dispatch envelope and admission contract (TypeScript only) | [final gate at 5d419e4](https://github.com/optomachina/Overdrafter/pull/568#issuecomment-6017597506) |
| #573 | OVD-458 | `cc2d41e` | Migration 135: atomic generic provider dispatch permit and request (off by default) | [final gate summary at 72c3fd7](https://github.com/optomachina/Overdrafter/pull/573#issuecomment-6018737853) |
| #574 | OVD-459 (+ carried OVD-598, OVD-601, OVD-628 from #580, #592, #596) | `d474317` | Migrations 136-139: service-role provider preflight and worker parser; legacy Xometry admission serialization; server-side empty-upload rejection; generic admission `NOWAIT` | [final gate summary at 0729f37](https://github.com/optomachina/Overdrafter/pull/574#issuecomment-6020330791) |
| #597 | none (main sync) | `0924c56` | Merge `main` `506c9dd` into the branch (resolves the `scripts/ovd510-disposable-replay.mjs` conflict) | [adversarial verification summary](https://github.com/optomachina/Overdrafter/pull/597#issuecomment-6021784300) |
| #603 | none (main sync) | `f9348a2` | Merge `main` `9d0c79b` into the branch: #598, #599, #600, #601, #602; 8 files, no conflicts, no migration change | [CodeRabbit summary](https://github.com/optomachina/Overdrafter/pull/603#issuecomment-6027994871) |

Still open and **not** in this head (draft PRs based on an older tip `084b48c` of this branch): #567 (OVD-595 bundle trim), #569 (OVD-596 phone nav Escape), #570 (OVD-594 `strictNullChecks`). #565 (Jarvis checkpoint, based on `main`) is also open and separate; see the owner checklist.

## Problem

The 2026-10-03 body of this PR was a handoff written before any stacked PR merged. It described an open draft stack at old heads, migrations "through 136", and an old Sonar triage. An owner following it would have applied too few migrations. This body replaces it with the state at `f9348a2` (after the second main sync, #603). The old checkpoints, including the `0924c56` state of 2026-10-06, are summarized under **History** at the end.

## Acceptance criteria addressed

- [x] Body describes head `f9348a2`: merged stack with merge commits (including the #603 main sync), migrations 127-139 with pins, evidence links, owner checklist, and no production change. It passes `node scripts/validate-pr-body.mjs`, and it contains no release-parent identifiers.
- [x] Hosted GitHub Actions checks at `f9348a2` are green (13 Actions jobs: 12 in CI run 37556681418, including the aggregate `ci`, plus the staged SQL proof in run 37556681278; plus Vercel. Run ids and check ids below). The two SonarCloud check runs at `f9348a2` failed at analysis time (quality gate ERROR on new reliability and security ratings) and are not counted as passing. After the owner's dispositions on 2026-10-08 the quality gate was re-evaluated to **Passed** on the same analysis; the check runs themselves are not re-run until a new push. See the Sonar section.
- [x] Sonar issues read through the API at `f9348a2` (1,427 open, ps=500, pages 1-3; unchanged from `0924c56`) and dispositioned by group below. Group (c), new and real: none found. On 2026-10-08 the owner applied the 48 BUG and VULNERABILITY dispositions in the Sonar UI (26 False Positive, 22 Accepted); 0 open bugs or vulnerabilities remain and the quality gate is OK.
- [ ] **CodeRabbit coverage: in progress (owner decision 2026-10-08: split review, no waiver).** CodeRabbit cannot review this PR as one unit: the request at `0924c56` ([6022294046](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022294046)) was answered "Review skipped: 418 files exceed the limit of 100" ([6022301204](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022301204)), and the summary at `f9348a2` ([5965117751](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-5965117751)) again reads "Too many files!" (plan: Advanced). A read-only coverage audit on 2026-10-08 found every merged stack PR covered by CodeRabbit at its final head, and three bodies of code never reviewed on any PR: the recovered release source (360 files), the #572 delta `7fd1b9a..6df8b8b` (10 files) and the #568 delta `d7899b7..5d419e4` (`ARCHITECTURE.md`). Eight review-only PRs on frozen `review/564-*` refs now cover exactly that code: #606, #607 and #608-#613 (tracked in OVD-643; never merged). Their CodeRabbit reviews are pending. This item stays open until OVD-643 is closed with all eight reviewed and their findings dispositioned.
- [x] The PR is not merged. The merge is the protected production release, and its input is the apply packet named at the top.

## Migrations beyond `main` (127-139)

All 13 are forward-only and drop no table, column or data at apply time. They are not purely additive: four create private tables, 127 drops an RLS policy, and 127, 128 and 134 revoke privileges (see Migration notes). For 134-139, `sha256sum` of the branch bytes matches the pins in `scripts/free-quote-ci-profile.mjs` (`REVIEWED_APPENDED_MIGRATIONS`). For 127-133, the bytes match `supabase/fixtures/worker-compatibility/source-contract.json` and `scripts/fixtures/free-quote-ci-source.json`, which the `free-quote-sql` job replays.

| # | File (`supabase/migrations/`) | Issue / PR | What it does | SHA-256 |
|---|---|---|---|---|
| 127 | `20261002041305_enforce_quote_selection_expiry.sql` | recovered source | Quote selection respects a known validity deadline (inclusive, server time); revokes direct `INSERT` on `public.client_selections` and drops the `client_selections_insert_members` policy in favour of the guarded selection RPC | `30b0e6c41d1c727df269177bb90292d0117674d7b05bc92cdc4dc2fc84ef3da6` |
| 128 | `20261002053133_align_selection_and_publication_sources.sql` | recovered source | Selections are append-only through the guarded RPC; table and column `UPDATE` grants on `public.client_selections` revoked (including from `service_role`) so it cannot bypass them | `70359183621feca322414cd4a2968c3611578ac7b571cbbf455603cd272aa3bf` |
| 129 | `20261002090339_add_atomic_capability_window_attention_persistence.sql` | recovered source (OVD-591) | Private forced-RLS capability window/attention persistence (5 new `private` tables) | `6ca3a955b01fa7781c616f850778c7e76b1dd7a34cb57fa9f0677dfc1fd27297` |
| 130 | `20261002133713_add_capability_preparation_retention.sql` | recovered source (OVD-591) | Immutable pre-dispatch capability retention (3 new `private` tables) | `9ccc23d277d901a5808a65d7b622536fe761a29e490c6d74200b35e311196214` |
| 131 | `20261002182714_free_quote_job_meter.sql` | recovered source | Free-quote job meter, separate from commercial entitlements (3 new `private` tables); seeds no policy or allowance | `32ea33b168021233cd5e3ed8414ec0c94f97d5fc3cc6ee7c35f6423a81c98db2` |
| 132 | `20261002182910_free_confirmed_quote_access.sql` | recovered source | Confirmed quote access: commercial entitlement or a configured free policy | `d0c25c26d8fa2275bc554d6089665d350ef9cc5a5323ae27a4e7e3671b7a2676` |
| 133 | `20261003011148_reconcile_free_quote_job_reservations.sql` | recovered source | Bounded service-only reconciliation of terminal free reservations | `e2e940492e2c9bb3220cd31471a43fb8711db532311f225c794c245aced671ea` |
| 134 | `20261003150000_ovd536_restrict_audit_event_writer.sql` | OVD-536 / #571 | Revoke PUBLIC/anon/authenticated `EXECUTE` on `log_audit_event` | `a625b16028242489c5e86e723815f1ee2d7e49f9c8d885d4cf6de12c1308bfa5` |
| 135 | `20261003160000_ovd458_generic_provider_dispatch_permits.sql` | OVD-458 / #573 | Generic provider dispatch permit and request RPC, off by default (3 new `private` tables) | `a991e6560d784c9f27516e1cba554ffcf1df440891d4ab22e523827752f472fc` |
| 136 | `20261003170000_ovd459_provider_dispatch_preflight.sql` | OVD-459 / #574 | Service-role-only provider dispatch preflight | `7e6d7ce55d2badd3bedc745ab5fe6adb51413160965d49db15ddf3e6fe1bcb10` |
| 137 | `20261004100000_ovd598_serialize_legacy_xometry_admission.sql` | OVD-598 / #580 via #574 | Serialize legacy Xometry admission with job, requirement and file edits | `666863ee3aada933945fcb14caa6821e711c5d16651d1781f66f6d0415dcbebd` |
| 138 | `20261004110000_reject_empty_job_file_uploads.sql` | OVD-601 / #592 via #574 | Reject empty job-file uploads in `api_prepare/finalize_job_file_upload` | `4029cba9743f4b80cba4f058345636e1d8f41264a26cad9efc49f89b38384277` |
| 139 | `20261004130000_ovd628_generic_admission_nowait.sql` | OVD-628 / #596 via #574 | Generic admission takes its scope row locks `FOR SHARE NOWAIT` | `441494e77b7e09d9e931ed2f458dfff719ece8fc45fb2cc3a886466b93374da5` |

**Production ledger (owner's read-only reading, 2026-10-08): 112 rows, ending at `20260924014552`, not at 133.** Production holds `main`'s first 104 migrations plus `20260905030647`, `20260905233435`, `20260923035755`, `20260924001152`, `20260924001203`, `20260924004159`, `20260924004202` and `20260924014552`. It lacks 14 `main` migrations (`20260910045917`, `20260910055556`, `20260910064137`, `20260910104500`, `20260910134500`, `20260911031500`, `20260926225000`, `20260927060736`, `20260927065514`, `20260927130000`, `20260927140000`, `20260927225843`, `20260928081530`, `20260928081534`) and all 13 of 127-139. The apply input is therefore the coordinator's production-apply packet v3: 27 migrations (the 14 missing `main` migrations and 127-139; 28 once OVD-641's migration merges), with its pre-apply checks, readback and rollback notes. Its pre-apply ledger fingerprint `212b70060764426f5f83ee6c58fa2085` is recorded. Nothing has been applied.

## Files changed

419 files. The main areas:

- `supabase/migrations` (13 new), `supabase/tests` (pgTAP), `supabase/fixtures` (worker-compatibility and free-quote qualification fixtures)
- `scripts/` (SQL qualification runners, free-quote CI profile, ovd510 replay runner split, Sonar/CI helpers), `.github/workflows`
- `worker/src` (browser runtime hardening, provider dispatch preflight parser, capability attention/retention, free reservation reconciliation)
- `src/` (quote confirmation and free-quote access UI, admin operations status), `server/admin-operations` with the `/api/admin-operations` rewrite in `vercel.json`, `e2e/`, `docs/`

## Scope

Included: the recovered release source, its qualification checkpoints, the eight merged PRs above, including both `main` syncs (#597 and #603).

Not included: #567, #569, #570 and #565 (open, not merged here); the phone-loop activation SQL under `docs/release/` (a separate, later packet); any production database, Cloud Run or credential change.

The 2026-10-07 rounds changed only this PR body and readiness comment [6029907690](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6029907690), which was posted once and later corrected in place (Actions job count). They made no code change and no push. The 2026-10-08 round again changed only this body and the readiness comment; no code change and no push.

## Verification

Commands run in this round, read-only, at `f9348a2` (2026-10-07):

```bash
git rev-list --count origin/main..HEAD     # 32
git rev-list --count HEAD..origin/main     # 0 (origin/main = 9d0c79ba04b4b600cc054b323fbf9649569105b4)
git merge-tree --write-tree origin/main HEAD   # a45aebc315880881d9646fb9df199ebd58fe4843, exit 0, no conflicts
git diff --name-status origin/main HEAD -- supabase/migrations   # 13 added (127-139)
git diff --name-only 0924c56 HEAD   # 8 files, none under supabase/ (the #603 sync)
sha256sum supabase/migrations/2026100*.sql   # 134-139 equal the scripts/free-quote-ci-profile.mjs pins
grep -niE 'create table|drop policy|revoke|force row level' supabase/migrations/2026100*.sql   # 14 private forced-RLS tables (129: 5, 130: 3, 131: 3, 135: 3); 127 drops one policy; 127, 128, 134 revoke
node scripts/validate-pr-body.mjs <this body>   # passed
curl '``https://sonarcloud.io/api/issues/search?componentKeys=optomachina_Overdrafter&pullRequest=564&issueStatuses=OPEN,CONFIRMED&sinceLeakPeriod=true&ps=500&p={1,2,3}'``   # pages 1, 2 and 3
curl 'https://sonarcloud.io/api/qualitygates/project_status?projectKey=optomachina_Overdrafter&pullRequest=564'
curl 'https://sonarcloud.io/api/project_pull_requests/list?project=optomachina_Overdrafter'   # PR 564 analysed at f9348a2, 2026-10-07T01:21:35Z
```

Re-read on 2026-10-08 through the same Sonar APIs, still on the analysis of `f9348a2`: `qualitygates/project_status` OK; open BUG and VULNERABILITY issues 0; open code smells 1,379. The CodeRabbit coverage audit of the same day read the stack PRs' reviews and summary comments read-only.

Results:

- [x] all listed verification passed
- [ ] unrelated baseline failures are described below

Hosted checks at `f9348a2`, CI run [37556681418](https://github.com/optomachina/Overdrafter/actions/runs/37556681418), attempt 1, no re-runs:

| Check | Check run id | Result |
|---|---|---|
| ci (aggregate) | 112586915438 | success |
| test | 112584733372 | success |
| browser-test | 112584439849 | success |
| lint | 112584439824 | success |
| typecheck | 112584439879 | success |
| build | 112584440054 | success |
| verify-worker | 112584440008 | success |
| extraction-gate | 112584439848 | success |
| ovd591-qualification / capability-sql | 112584439918 | success |
| ovd591-retention-qualification / retention-sql | 112584440223 | success |
| free-quote-sql-qualification / free-quote-sql (139-migration replay + 18 races) | 112584440161 | success |
| ovd420-recovery-egress-network | 112584439571 | success |
| Disposable staged SQL proof (run [37556681278](https://github.com/optomachina/Overdrafter/actions/runs/37556681278)) | 112584438962 | success |
| Vercel Preview Comments | 112584602206 | success |
| SonarCloud Code Analysis | 112585096640 | **failure** at analysis time: quality gate ERROR. The gate was re-evaluated to Passed on 2026-10-08 after the owner's dispositions; this check run is not re-run until a new push (see Sonar below) |
| SonarCloud | 112585103750 | **failure** at analysis time: same gate, re-evaluated to Passed on 2026-10-08; not re-run until a new push |

Deno is not available in this container, so Edge Function tests ran only in the hosted `test` job ("Test Edge Functions" step, success).

## Review findings and coverage

- Final PR head SHA: `f9348a2768088214be0febb5b08def3f40674e20`
- Sonar: quality gate **OK (Passed)** since 2026-10-08, on the analysis of `f9348a2`. The owner dispositioned all 48 BUG and VULNERABILITY issues in the Sonar UI with source-bound rationales (26 False Positive, 22 Accepted); 0 open bugs or vulnerabilities remain. The 1,379 open code smells are unchanged, dispositioned by group below, and not gate-relevant.
- CodeRabbit: **coverage in progress through a split review (owner decision 2026-10-08, no waiver).** CodeRabbit skips this PR on its plan file limit: "Review skipped: 418 files exceed the limit of 100" ([6022301204](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022301204)) after the request at `0924c56` ([6022294046](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-6022294046)), and "Too many files!" in the summary for `9d0c79b..f9348a2` ([5965117751](https://github.com/optomachina/Overdrafter/pull/564#issuecomment-5965117751)). There is no review object or review thread on this PR.
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

  - CodeRabbit is requested on one PR per hour in that order, behind PR #605. The reviews were pending at the time of this edit. The remaining condition is the closure of OVD-643: all eight reviewed and their findings dispositioned. A real defect found there is fixed through a separate small PR into the integration branch, never directly on this branch.
- Independent review: each merged PR passed its own independent review and gate rounds (linked in the stack table). This round re-checked the release-level facts above with git, GitHub and the Sonar API.
- [ ] Inspected findings and threads on the final head: Sonar is done; CodeRabbit coverage is in progress through the split review (OVD-643, see above).

### Sonar at `f9348a2`

Analysis of `f9348a2` (`project_pull_requests/list`: analysed 2026-10-07T01:21:35Z, commit `f9348a2768088214be0febb5b08def3f40674e20`), read through `api/issues/search` with `pullRequest=564`, `issueStatuses=OPEN,CONFIRMED`, `sinceLeakPeriod=true`, `ps=500`, pages 1-3. Total **1,427**: 1,379 code smells, 24 bugs, 24 vulnerabilities. Security hotspots: 0 (100% reviewed). The totals and the per-rule counts are the same as at `0924c56`. The 8 files that the #603 sync changed carry **0** issues: after the sync they equal `main`, so they are outside the PR's diff.

Quality gate (`qualitygates/project_status`): **OK** on 2026-10-08, on the same analysis of `f9348a2`. It read ERROR on 2026-10-07 and was re-evaluated after the owner's dispositions described below. Open BUG and VULNERABILITY issues: 0. Open code smells: 1,379 (unchanged; not gate-relevant).

| Metric | 2026-10-07 | 2026-10-08 | Threshold | Status now |
|---|---|---|---|---|
| `new_reliability_rating` | 4 (D) | 1 | 1 | OK |
| `new_security_rating` | 4 (D) | 1 | 1 | OK |
| `new_maintainability_rating` | 1 | 1 | 1 | OK |
| `new_duplicated_lines_density` | 1.4% | 1.4% | 3% | OK |
| `new_security_hotspots_reviewed` | 100% | 100% | 100 | OK |

Grouping method: each issue's line was attributed with `git blame HEAD` to the commit that last wrote it. Lines from a merged PR's squash commit are group (a). Lines from the recovered source `9d387c0` or its pre-stack checkpoints `30192b7..084b48c` are group (b). Three function-level S3776 issues whose header line predates the branch are counted in (b), because their bodies changed in the recovered source. The blame pass ran at `0924c56`. It still holds at `f9348a2`, because #603 changed only 8 files and none of them carries an issue, so no issue-bearing line has a different blame commit.

**(a) Already dispositioned in the merged PRs' bodies: 327 at this head.**

| PR | Issues at this head (blame) | Rules | Body disposition |
|---|---|---|---|
| #574 | 214 | plsql:S1192 186, OrderByExplicitAscCheck 22, S1138 3, javascript:S9382 2, SelectStarCheck 1 | "dispositions for all 222 Sonar issues" in #574's body (pullRequest=574 at `0729f37`) |
| #573 | 104 | plsql:S1192 104 | 108-issue disposition table in #573's body (pullRequest=573 at `72c3fd7`) |
| #571 | 9 | plsql:S1192 7, CrossJoinUsageCheck 2 | 11-issue disposition list in #571's body (at `03773fc`) |
| #568 | 0 | none | body: 0 open at `5d419e4` |
| #572 | 0 | none | body: 1 inherited S3776 (`worker/src/index.ts:1618`) |
| #597 | 0 | none | body: 1 pre-existing S3776 (`scripts/ovd510-replay-body.mjs:18`, counted here in (b)) |
| #603 (carrying #598, #599, #600, #601, #602) | 0 | none | no PR-scope issue on the 8 synced files (they equal `main` after the sync), so nothing to disposition here; those changes were reviewed in their own PRs on `main` |

These counts are lower than the per-PR totals (222/108/11) because later commits rewrote some of the lines, so blame attributes them elsewhere.

**(b) Pre-existing in the recovered release source and its checkpoints: 1,100.** All are false positives or accepted style smells. None is a defect.

| Rule (count) | File family | Disposition |
|---|---|---|
| plsql:S1192 (653) | `supabase/tests` pgTAP, `supabase/migrations`, `supabase/fixtures`, SQL in `scripts` | Won't fix. These are closed-vocabulary literals (error codes, SQLSTATEs, role names, fixture UUIDs). PostgreSQL has no package constants, and indirection would make the DDL and assertions harder to audit. Same disposition as #573 and #574. |
| javascript/typescript:S9382 (89), S7723 (30), S7722 (24), S7780 (13), S6353 (13), S8786 (12), S7503 (31), S3358 (39), S3776 (40) and other minor style rules | `scripts/` qualification runners, `worker/src`, `e2e`, `server`, `src` | Accepted style or complexity smells in reviewed, test-covered code. Refactoring them on the release branch would invalidate the pinned qualification evidence. |
| php:S103 (15), plsql:OrderByExplicitAscCheck (3), UseAsForColumnAliasesCheck (4), S1138 (1) | `supabase/tests`, `supabase/fixtures` | Style only. S103 is misdetected as PHP on long pgTAP lines. |
| **BUG** javascript/typescript:S2871 (17) | `scripts/ovd591-*.mjs`, `worker/src/jev/choice.ts:24,30`, `worker/src/providerCapability*.ts`, `worker/src/quoteIntelligence/quoteEvidence.ts:70`, `src/components/admin/OperationsStatusCard.tsx:65-66` | False Positive (marked 2026-10-08). These are default sorts of string arrays (identifiers, categories, subsystems). Code-unit order is deterministic and locale-independent, which is what canonical hashing and comparison need; `localeCompare` would make it locale-dependent. The two display sorts in `OperationsStatusCard.tsx:65-66` sort fixed, validated category/provider/subsystem identifiers. |
| **BUG** typescript:S6544 (2) | `e2e/quote-confirmation/network.ts:26,99` | False Positive (marked 2026-10-08). `if (this.pendingGate)` checks whether a held Promise is present; it does not test the Promise's value. |
| **BUG** typescript:S4822 (2) | `src/features/operations/operations-status-client.ts:21,84` | Accepted (2026-10-08). The analyzer is correct: a standards-compliant `cancel()` rejects its Promise rather than throwing. The defensive `try` is retained on purpose. |
| **BUG** javascript:S905 (3) | `docs/qa/*.js` | False Positive (marked 2026-10-08). Each file is a bare `async (page) => {…}` expression for Playwright CLI `run-code`. These are docs, not shipped code. |
| **VULNERABILITY** jssecurity:S8705 (2, MAJOR) | `scripts/ovd591-sql-qualification.mjs:56`, `scripts/ovd591-retention-qualification.mjs:16` | False Positive (marked 2026-10-08). `container` must match `/^ovd591-[a-z0-9-]+$/` (lines 51 and 13) before it reaches `execFileSync`, which runs with no shell. These are CI-only runners. |
| **VULNERABILITY** javascript:S5443 (2, CRITICAL) | `scripts/check-compiled-worker-scope.mjs:13`, `scripts/test-support/source-only-network.node-test.cjs:95` | False Positive (marked 2026-10-08). Line 13 only passes the caller's `TMPDIR` through to a child env. Line 95 is a literal `/tmp/synthetic-only.sock` in a negative test that asserts the offline tripwire throws `ERR_OFFLINE_TRIPWIRE`. |
| **VULNERABILITY** javascript:S4036 (20, MINOR) | `scripts/ovd591-*`, `scripts/ovd510-immutable-source*`, `scripts/free-quote-psql-races.mjs:268`, `scripts/check-compiled-worker-scope.mjs:49-50`, `scripts/run-supabase-policy-tests.mjs:73` | Accepted (2026-10-08). These are CI and local qualification runners that use the runner's `PATH`; no production code path runs them. |
| code smell javascript:S1313 (2, MINOR; listed here because it is a security-flavoured rule, not counted among the 24 vulnerabilities) | `scripts/test-support/source-only-network.node-test.cjs:53,56` | False positive. These are loopback literals in the offline-network test. |

**(c) New and real: none found.** Every BUG and VULNERABILITY site above was opened and read in the `0924c56` round; none of those files changed in #603, and the S8705 guard lines were re-read at `f9348a2`. Before the Sonar UI step on 2026-10-08, every one of the 48 BUG and VULNERABILITY sites was independently re-verified against source at `f9348a2` (coordinator audit: 0 real defects; 4 rationale corrections, for the two `OperationsStatusCard.tsx` display sorts and the two S4822 sites, applied as above). No fix PR into the integration branch is needed. If the split CodeRabbit review finds a real defect, the fix goes in a separate small PR into the integration branch, never directly on this branch.

The owner applied these dispositions in the Sonar UI on 2026-10-08: all 48 BUG and VULNERABILITY issues, 26 False Positive (17 S2871, 2 S6544, 3 S905, 2 S8705, 2 S5443) and 22 Accepted (20 S4036, 2 S4822), each with a source-bound rationale. The quality gate then re-evaluated to **Passed** on the existing analysis of `f9348a2`. The two SonarCloud check runs still show their analysis-time failure until a new push re-runs them.

## Owner checklist (protected; no production step done)

- [ ] **Production database apply and readback**: run the coordinator's production-apply packet v3: the read-only pre-apply checks (pre-apply ledger fingerprint `212b70060764426f5f83ee6c58fa2085` recorded), a forward-only apply of the 27-migration suffix from the live ledger tip `20260924014552` through 139 (the 14 missing `main` migrations and 127-139; 28 once OVD-641's migration merges), the post-apply readback, and its per-migration rollback notes. The owner's read-only reading on 2026-10-08 found 112 ledger rows ending at `20260924014552`, not 133 (see Migrations beyond `main`). Runbooks: `docs/workflows/ovd418-qualified-database-release.md`, `ovd361-production-deployment.md`. Not done.
- [ ] **Merge #564 into `main`** after the database readback passes, so the Vercel production deploy lands on a migrated database. This is the production release; only the owner merges it.
- [x] **Sonar false-positive marking**: done by the owner in the SonarCloud UI on 2026-10-08. All 48 group (b) BUG and VULNERABILITY issues dispositioned with source-bound rationales: 26 False Positive, 22 Accepted. 0 open bugs or vulnerabilities; the quality gate re-evaluated to Passed.
- [ ] **Cloud Run smoke of the OVD-593 worker image**: run sandboxed Chromium and Camoufox as non-root before flipping the deploy sandbox default. The default stays `true` in `worker/scripts/deploy-cloud-run.sh:36`; `worker/src/config.ts` already defaults to `false`. Update the pinned release-tuple contracts together with the flip.
- [ ] **OVD-541**: enable the leaked-password protection setting, record the billing-disabled proof, and build a fresh worker image for the release parent.
- [ ] **Shared-password rotation**: rotate the shared password that was pasted into a coding-agent prompt on 2026-09-27 (noted in the original handoff). Its local copy should be purged as part of the rotation.
- [ ] **#565 decision**: decide whether the Jarvis checkpoint draft (based on `main`; it conflicted with this branch in 3 files at the time of the handoff) is unparked, rebased after this release or closed.
- [x] **X1 test runtime**: done. All 11 X1 inert suites passed at the activation-commit candidate `91bfa3c` (test-runtime added 2026-10-08: exit 0, 39.02 s, nativeCalls 0, SLDWORKS 2/2 untouched; receipt SHA-256 `de5880d83c571a9a55dc9d85b85bf727c688db7b2e4d616ec5c693eaa4f00060`, summary.json `ad84002cd55e4234baeed60ef37847ecd54ea704b9977d60daef38c3206243a6`, manifest `1845cd03ca1309cc79d4806308a79be3ccd20d46748b15c7909eb7a3ddc579ab` with 212/212 entries verified OK). This is not native qualification.
- [x] **CodeRabbit coverage decision**: decided: split (2026-10-08). No waiver. Review-only PRs #606-#613 on frozen `review/564-*` refs (see Review findings).
- [ ] **CodeRabbit split review closure**: the remaining condition is the closure of OVD-643, with all eight review-only PRs reviewed by CodeRabbit and their findings dispositioned.
- [ ] Post-merge smoke: check that Vercel production has the server-side env vars for the new `/api/admin-operations` endpoint (`SUPABASE_SERVICE_ROLE_KEY`, `WORKER_BASE_URL`). Without them it fails closed with a 503.

## Tests

This round added no tests (text-only round). The tests that cover this branch are in the hosted jobs above: the full pgTAP suite, the 139-migration free-quote replay with 18 independent-session races, the capability and retention SQL qualification, unit and browser suites, and the disposable staged SQL proof. Each merged PR's own test additions are described in its body.

## Migration notes

- [x] Migration impact exists and is described below

13 migrations (127-139) are beyond `main`, listed with their pins in the table above. All are forward-only: none drops a table or column, and none deletes or migrates data at apply time. (131 defines a service-role-only function, `reconcile_vendor_quote_offers`, that deletes stale offer rows when it is called at runtime; the migration itself deletes nothing.) Four migrations create 14 new tables, all in schema `private`, each with row level security enabled and forced and all client and service grants revoked: 129 (5), 130 (3), 131 (3) and 135 (3). 127 revokes direct `INSERT` on `public.client_selections` and drops the `client_selections_insert_members` policy, so selections go through the guarded selection RPC. 128 revokes table and column `UPDATE` on `public.client_selections`, including from `service_role`. 134 revokes client `EXECUTE` on `log_audit_event`. The rest are new functions, private helpers, grants and revokes on the new objects, and guarded `create or replace` restatements. The production apply is the owner's (see the checklist). Nothing has been applied to a hosted database.

## Rollback / risk notes

- Risk: merging before the database apply would deploy code that calls RPCs that do not exist yet. The order is always: apply the database, read back, then merge.
- Database rollback is forward-only, per migration, and is written in the apply packet v3's rollback notes (for example, 134 re-grants `EXECUTE` to the failing role; 135 and 136 revoke the new entrypoints; 137-139 re-apply the previous definitions). Rolling back 127 or 128 would mean re-granting the revoked `client_selections` privileges or recreating the `client_selections_insert_members` policy, which reopens the bypass those migrations close. The 14 new private tables can stay in place as unused objects; dropping them is not part of any rollback here.
- Frontend rollback: Vercel instant rollback to the previous production deployment, or a revert of the merge commit on `main`.
- Principal risks are lock ordering and admission concurrency (137, 139), authorization (134, 136) and quota or reservation accounting (131-133). Each is covered by the hosted SQL suites and races listed above.

## Documentation

- [x] Docs updated

The branch carries the qualification, provenance and runbook docs from the recovered source and the merged PRs. This round updated only the PR body and the readiness comment.

## Follow-up items

- [ ] CodeRabbit coverage of the integration head: decided 2026-10-08 as a split review (no waiver) on review-only PRs #606-#613 (tracked in OVD-643; never merged). The remaining condition is the closure of OVD-643: all eight reviewed and their findings dispositioned. An actionable thread that shows a real defect is fixed through a separate small PR into the integration branch; anything else is dispositioned on its review PR.
- [ ] Optional hardening issue (not on this branch): pin `search_path = pg_catalog` and revoke PUBLIC/anon on `api_cancel_quote_request`, `api_prepare_job_file_upload` and `api_finalize_job_file_upload`. These keep `search_path = public`, the same as their definitions on `main`.
- [ ] Decide #567, #569 and #570, which are based on an old tip of this branch.

## History

The checkpoints below are summarized from the earlier bodies of this PR. They describe past heads, not `f9348a2`.

### 2026-10-06 checkpoint (head `0924c565`, after the main sync #597)

The branch was then 30 commits ahead of and 0 behind `main` `506c9dd`, and the merge into `main` was conflict-free (tree `c5a7edb52cee`). Hosted checks at `0924c56` (CI run 37504198902 and staged SQL proof run 37504198370, attempt 1, no re-runs) were green for every Actions job and Vercel; both SonarCloud checks (112409582042, 112409585716) failed on the same quality gate. Sonar showed 1,427 open issues with the same grouping as above. The PR was marked ready for review that day, and `@coderabbitai review` was answered with the 100-file limit skip. On 2026-10-07 the second main sync (#603) moved the head to `f9348a2`.

### 2026-10-03 handoff (head `084b48c5`)

The stacked PRs #566-#574 were then open drafts on this branch. Migrations 134-136 had not merged yet, and 137-139 did not exist. The old owner actions then were: Sonar marking, the production window, the Cloud Run smoke, OVD-541, password rotation. They are carried forward, corrected, in the owner checklist above. The next-work list then covered the provider chain (OVD-461 to 464, 567, 568), the legacy Xometry race (now fixed as OVD-598, migration 137), unparking #565, the phone-loop proof work on the workstation, vendor live evaluations and codebase follow-ups.

### Checkpoint `6df4d1bb` (hosted CI green, run 37111664756)

SQL qualification fixes: `PGAPPNAME` for race actors, and the supabase_admin fixture password passed by name only. Also: the free-quote preflight admits the pinned gotrue baseline; `seed:dev` selects offers through the guarded RPC; client-shell and recovery-fixture e2e timing; CPD exclusion for generated fixtures. The Sonar gate then failed with a triage of no real defects. That triage is superseded by the grouped disposition above.

### Checkpoint `25ffc227` and earlier

These were the source-only publication of the recovered release (tree `f43848967f3c…` integrated as `9d387c0`), with 13 quote-confirmation browser cases, recovery-only reopening of uncertain requests, and bounded ECR-throttle retries. The SQL and browser hosted lanes were repaired across `30192b7`, `70770e1` and `0ae26c0`. The original release combined 133 migrations: 126 from `main` plus 7 free-quote and capability files (127-133).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GqaoSqia9BNetUBaGnMQSM
