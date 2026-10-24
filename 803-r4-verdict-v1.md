QA: PASS on 9732ee32c67de2e3d537570e2e10280237a17491
Gate-repair head re-run. All checks are green at the head (CI run 39015907881, Verify run 39015907839), and the SonarCloud gate passed. merge-readback suite 47/47. The Architect findings F1-F5 and F7 are each repaired: box probes stop or fail at 4833c3dd and behave correctly at 9732ee32. The original OVD-857 ACs still hold. Only low/info follow-ups remain, one of them the open CodeRabbit Minor thread.

Findings:
- low: [follow-up, real] Open CodeRabbit thread at 9732ee32 (Minor): planContiguousVerified accepts a short head_sha (box probe: 'abcd1234' lands in plan.land). Downstream compares fail closed, so the result is a false STOP that needs a stop-ack, not a false pass. Follow-up: assert isFullSha(entry.head_sha) when the plan is built. (scripts/merge-readback.mjs:114,136)
- low: [follow-up, real] F5 continuity holds only when --prior is passed. --prior is optional on plan/readback/readback-run/stop-ack, and verify-log against the stale plan-time digest still reports ok/appended after a false->true flip (box probe). The single-merge readback example at :267 omits --prior/--digest-out, while land skill step 12 and step 3 include them. Follow-up: make the doc example consistent, or require --prior once a digest exists. (docs/recurring-workflows.md:267,285)
- low: [follow-up, tracking] Architect follow-ups F6 (cached passing row not re-checked against main), F8 (formula-escape compare on verdict_ref) and F9 (free-text stop-ack --by) are still open, as the PR scope states. All three fail closed or are info-level. (scripts/merge-readback.mjs:329,436)
- info: [follow-up, real] Expected effect of the F2 amendment: with patch-id removed as a gate, an empty squash whose PR change already landed on main identically now passes rebased-tree-matches (4833c3dd stopped it as tree-mismatch-patch-id-differs). The content on main still equals the verified intent, so this is not loosening under the amended design. Flagged for the Architect delta gate. (scripts/merge-readback.mjs:187,196)

Local evidence (QA box): `/workspace/qa-batch/803-r4.log`

Proof re-run: npx vitest run scripts/merge-readback.test.mjs (47/47), npx eslint on the PR scripts (clean), bash scripts/preflight.sh lint/typecheck PASS, npm run preflight (lint/typecheck PASS; tests fail only in box-env files, CI test green), F1-F7 probes vs 4833c3dd, at 9732ee32c67de2e3d537570e2e10280237a17491
families: builder=codex reviewers=claude:sonnet:CHANGES_REQUIRED@92f6af5d,claude:sonnet:CHANGES_REQUIRED@c2539f14,claude:opus:CHANGES_REQUIRED@b70fdf2e,claude:opus:CHANGES_REQUIRED@67b8a160,claude:opus:APPROVED@4fd2fc18,codex:codex:APPROVED@74b6d4cd,codex:codex:APPROVED@c1fc562b cross_family=true qa_catch_after_review=false

**OverDrafter verdict: PASS_NOTES** for `9732ee32c67de2e3d537570e2e10280237a17491` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "PASS_NOTES",
  "sha": "9732ee32c67de2e3d537570e2e10280237a17491",
  "patch_id": "87bd7d12f9c45b7af2223d3172ffc2e0f77cbd38",
  "diff_id": "ef67dcf2973190a8df9bf2d6291208e40b8f9e89cef372066ca5b508c7cea758",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39015907881"
    },
    {
      "kind": "verify-run",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39015907839"
    },
    {
      "kind": "log",
      "url": "https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=803"
    }
  ],
  "notes": [
    "low: [follow-up, real] Open CodeRabbit thread at 9732ee32 (Minor): planContiguousVerified accepts a short head_sha (box probe: 'abcd1234' lands in plan.land). Downstream compares fail closed, so the result is a false STOP that needs a stop-ack, not a false pass. Follow-up: assert isFullSha(entry.head_sha) when the plan is built. (scripts/merge-readback.mjs:114,136)",
    "low: [follow-up, real] F5 continuity holds only when --prior is passed. --prior is optional on plan/readback/readback-run/stop-ack, and verify-log against the stale plan-time digest still reports ok/appended after a false->true flip (box probe). The single-merge readback example at :267 omits --prior/--digest-out, while land skill step 12 and step 3 include them. Follow-up: make the doc example consistent, or require --prior once a digest exists. (docs/recurring-workflows.md:267,285)",
    "low: [follow-up, tracking] Architect follow-ups F6 (cached passing row not re-checked against main), F8 (formula-escape compare on verdict_ref) and F9 (free-text stop-ack --by) are still open, as the PR scope states. All three fail closed or are info-level. (scripts/merge-readback.mjs:329,436)",
    "info: [follow-up, real] Expected effect of the F2 amendment: with patch-id removed as a gate, an empty squash whose PR change already landed on main identically now passes rebased-tree-matches (4833c3dd stopped it as tree-mismatch-patch-id-differs). The content on main still equals the verified intent, so this is not loosening under the amended design. Flagged for the Architect delta gate. (scripts/merge-readback.mjs:187,196)"
  ],
  "readiness": {
    "conflicts": 0,
    "open_threads": 1,
    "checks": "green"
  },
  "timestamp": "2026-10-17T08:28:02Z"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
