QA: PASS on 7b5da3078ac64b12287a97ed1cdf6dd61bcf13fd
Both causes of the QA FAIL at 097d9c0a are fixed and all three OVD-934 ACs hold on re-run: the new test (new head re-screens, one marker written on the new SHA, old marker untouched, next screen is a hit) passes and fails under 4 local mutations, and rows carry cache_hit, head_sha and tokens (real Jev row: 632/56; null on a hit). The delta is these 3 files only. Every check is green at this SHA (CI run 39024588330) and the Sonar gate is OK with 0 issues.

Findings:
- low: [follow-up, tracking] The default CLI now writes a jev-screen success commit status to GitHub as optomachina on every accepted screen. It is not a required check (branch protection requires ci and provider-go-live only, and qa-handoff gate.mjs counts only required checks), but any all-green helper over commit statuses, including the OVD-845 gate, must exclude jev-screen. (scripts/jev-pr-screen.mjs:353)
- low: [follow-up, tracking] The new marker module is not on the sensitive-path list (docs/sensitive-paths.json covers scripts/jev-pr-screen* only); tracked as OVD-939 C2. (scripts/lib/jev-screen-marker.mjs:1)
- low: [follow-up, tracking] The #743 duplicate came from screen.py, which does not read or write the marker, so dedupe across both callers (issue fix item 1) holds only after screen.py is retired; tracked as OVD-940. (scripts/jev-pr-screen.mjs:22)
- low: [follow-up, real] When an injected marker writer throws or returns a free-text reason, the warning echoes it after sanitizeToken, which redacts only TYPESAFE_API_KEY (probe P5). The real GitHub writer returns fixed reason codes, so no token reaches logs today; keep reasons to fixed codes. (scripts/jev-pr-screen.mjs:332)

Local evidence (QA box): `/workspace/qa-batch/846-r2.log`, `/workspace/qa-batch/846-r2-probes.out`, `/workspace/qa-batch/846-r2-real-rows.jsonl`, `/workspace/qa-batch/846-r2-jev.jsonl`

Proof re-run: vitest 4 files 133/133 + gh-spy run of jev-pr-screen.test.mjs (40/40, 0 gh calls) + 4 mutations of the new test + full vitest (same 50 env-only failing files as base main) + typecheck + lint on the Mac mini clone, eslint on changed files, validate-pr-body, sensitive-paths:report, node 846-probes.mjs 40/40, one real-row Jev screen, CI runs 39024588330 and 39024588300, at 7b5da3078ac64b12287a97ed1cdf6dd61bcf13fd
families: builder=jev reviewers=none cross_family=false qa_catch_after_review=false

**OverDrafter verdict: PASS_NOTES** for `7b5da3078ac64b12287a97ed1cdf6dd61bcf13fd` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "PASS_NOTES",
  "sha": "7b5da3078ac64b12287a97ed1cdf6dd61bcf13fd",
  "patch_id": "bfe283cec546e8c7b579ed18a8eeebc2644070ba",
  "diff_id": "4c36e2bf1799c304cb0c97c43d8c969997492a53ccfb44e67a32ed3dbcddf4f1",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39024588330"
    },
    {
      "kind": "verify-run",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39024588300"
    },
    {
      "kind": "log",
      "url": "https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=846"
    }
  ],
  "notes": [
    "low: [follow-up, tracking] The default CLI now writes a jev-screen success commit status to GitHub as optomachina on every accepted screen. It is not a required check (branch protection requires ci and provider-go-live only, and qa-handoff gate.mjs counts only required checks), but any all-green helper over commit statuses, including the OVD-845 gate, must exclude jev-screen. (scripts/jev-pr-screen.mjs:353)",
    "low: [follow-up, tracking] The new marker module is not on the sensitive-path list (docs/sensitive-paths.json covers scripts/jev-pr-screen* only); tracked as OVD-939 C2. (scripts/lib/jev-screen-marker.mjs:1)",
    "low: [follow-up, tracking] The #743 duplicate came from screen.py, which does not read or write the marker, so dedupe across both callers (issue fix item 1) holds only after screen.py is retired; tracked as OVD-940. (scripts/jev-pr-screen.mjs:22)",
    "low: [follow-up, real] When an injected marker writer throws or returns a free-text reason, the warning echoes it after sanitizeToken, which redacts only TYPESAFE_API_KEY (probe P5). The real GitHub writer returns fixed reason codes, so no token reaches logs today; keep reasons to fixed codes. (scripts/jev-pr-screen.mjs:332)"
  ],
  "readiness": {
    "conflicts": 0,
    "open_threads": 0,
    "checks": "green"
  },
  "timestamp": "2026-10-17T10:44:20Z"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
