# CodeRabbit coverage for #564 at f9348a2 (read-only audit, 2026-10-08)

CodeRabbit skipped #564 itself: 418 files exceeds the 100-file limit (comments 5965117751, 6022301204). In the table below, coverage counts only a non-empty review object or a completed summary range. Rate-limit comments and empty-body thread-reply reviews do not count.

| PR | final head | last reviewed | evidence | uncovered delta | verdict |
|---|---|---|---|---|---|
| #566 | 1b44a32 | 1b44a32 | review 5406944320 (084b48c..1b44a32) | 0 | covered |
| #572 | 6df8b8b | **7fd1b9a** | review 5408628508 (084b48c..7fd1b9a); 8a839a3 reviews are thread replies; rate-limited 5981905268, 5985443992 | **10 files +438/-65** | partial |
| #571 | 03773fc | 03773fc | summary 5971700997 (4b69683..03773fc, 11/11 files, no actionable comments); no review object | 0 | covered |
| #568 | 5d419e4 | **d7899b7** | review 5428482216; summary 5971557691 shows "Review limit reached" for d7899b7..5d419e4 | **1 file (ARCHITECTURE.md) +25/-15** | partial |
| #573 | 72c3fd7 | 72c3fd7 | summary 5972072399 (039bb7e = merge-base..72c3fd7, 11/11) | 0 | covered |
| #574 | 0729f37 | 0729f37 | summary 5972571436 (cc2d41e = merge-base..0729f37, 37/37) | 0 | covered |
| #580 | 12a584b | 12a584b | summary 5981413340 (ac5026f..12a584b, 17/17) | 0 | covered |
| #592 | ef4eb2d | **3077994** | summary 5985826476 (e1e949a..3077994); rate-limited for 3077994..ef4eb2d | 14 files +952/-103 (PR level) | partial; covered at release level by #574 |
| #596 | bb33bc4 | bb33bc4 | summary 6005320961 (d902545..bb33bc4, 12/12) | 0 | covered |
| #597 | e3fcfc4 | e3fcfc4 | review 5432247548 (d474317..e3fcfc4, 19/19) | 0 | covered |
| #603 | d5b31d6 | d5b31d6 | summary 6027994871 (0924c56..d5b31d6, 8/8) | 0 | covered |

- **#572 gap** (commits 8a839a3, cac279f, c448192, 6df8b8b): worker/src/chromiumLaunchOptions.test.ts, scripts/worker-runtime-user.test.mjs, worker/src/adapters/providerEvidenceRedaction{.ts,.test.ts}, worker/Dockerfile, worker/README.md, scripts/ovd420-recovery-egress-control{.sh,.test.mjs}, scripts/verify-xometry-recovery-host.test.mjs, docs/workflows/ovd410-stable-egress.md. No later PR touched these files.
- **#592**: the gap is the forward-merge of #580. 12 of the 14 files are byte-identical to #580's reviewed head. All landed content falls inside #574's full review at 0729f37, and squash d474317 has the same tree as 0729f37. CodeRabbit comment 6007627792 said "keep #592 unmerged"; it merged 21 seconds later.
- **#597 conflict resolution** was in scripts/ovd510-replay-body.mjs (+6/-2) and native-sql-proofs.yml (2 lines). scripts/ovd510-disposable-replay.mjs itself is unchanged. Both resolution files were reviewed in 5432247548. Its one Major PromptComposer finding was withdrawn on scope grounds and resolved.
- **Main syncs**: #597 and #603 carry main content that was already reviewed on main PRs, and both were fully reviewed again at their final heads.
- **Squash drift**: none. Every merge or squash tree equals its final head, and #572's patch-id matches its PR diff. All CodeRabbit threads are resolved.
- **Recovered source** (9d387c0 + 30192b7..084b48c, 22 commits, fork 8d8d243): **360 files +41215/-1542, uncovered.** 41,126 of these added lines survive in 354 of #564's 418 files. These commits appear only on #564 and on open PRs based on the release branch, so no review of them was found.
- **Totals (release level):** 370 uncovered files, 43,300 changed lines (recovered source plus the #572 and #568 gaps).
- **Recommendation:** get CodeRabbit (or a recorded equivalent) to review the #572 and #568 deltas and the recovered source, splitting the recovered source into review-only PRs of at most 100 files off 8d8d243 (at least 4 PRs). Do not waive. Also note: origin/main is now 7b50f0d (#604), which #564 does not include.
