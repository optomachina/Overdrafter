QA: PASS on 097d9c0a2d1d34b8fda85f4119149126a9b2c7f2
All three OVD-934 ACs hold on re-run: a same-SHA re-screen makes 1 Jev call and logs marker_hit=true, a new head re-screens, and jev-decisions.jsonl is untracked and gitignored. Every check is green at this SHA (CI run 39021252544) and the Sonar gate is OK with 0 issues. Two medium notes: no repo test for the new-SHA re-screen, and the field names differ from the issue (marker_hit/sha, no tokens).

Findings:
- medium: [follow-up, real] OVD-934 AC2 asks for a test that a new SHA triggers a re-screen; no repo test pushes a new head and asserts a Jev call (the closest, line 644, covers the inverse: a stale SHA skips the marker). QA probe P2 shows the behaviour works (new head: Jev called, marker written on the new SHA). Add the test. (scripts/jev-pr-screen.test.mjs:644)
- medium: [follow-up, real] OVD-934 AC1 and fix item 3 name the row fields cache_hit and head_sha and ask for tokens; rows log marker_hit and sha and carry no token count. Same meaning (second same-SHA screen logs marker_hit=true with 1 Jev call, probe P1), but the field names differ from the issue and tokens are not logged. (scripts/jev-pr-screen.mjs:197)
- low: [follow-up, tracking] The default CLI now writes a jev-screen success commit status to GitHub as optomachina on every accepted screen. It is not a required check (branch protection requires ci and provider-go-live only, and qa-handoff gate.mjs counts only required checks), but any all-green helper over commit statuses, including the OVD-845 gate, must exclude jev-screen. (scripts/jev-pr-screen.mjs:330)
- low: [follow-up, tracking] The new marker module is not on the sensitive-path list (docs/sensitive-paths.json covers scripts/jev-pr-screen* only); tracked as OVD-939 C2. (scripts/lib/jev-screen-marker.mjs:1)
- low: [follow-up, tracking] The #743 duplicate came from screen.py, which does not read or write the marker, so dedupe across both callers (issue fix item 1) holds only after screen.py is retired; tracked as OVD-940. (scripts/jev-pr-screen.mjs:22)
- low: [follow-up, real] When an injected marker writer throws or returns a free-text reason, the warning echoes it after sanitizeToken, which redacts only TYPESAFE_API_KEY (probe P5). The real GitHub writer returns fixed reason codes, so no token reaches logs today; keep reasons to fixed codes. (scripts/jev-pr-screen.mjs:309)

Local evidence (QA box): `/workspace/qa-batch/846.log`, `/workspace/qa-batch/846-probes.out`, `/workspace/qa-batch/846-jev.jsonl`

Proof re-run: vitest 4 files 130/130 + full vitest (same 50 env-only failing files as base main) + typecheck + lint on a fresh Mac mini clone, eslint on changed files, validate-pr-body, sensitive-paths:report, node 846-probes.mjs 31/31, CI runs 39021252544 and 39021252586, at 097d9c0a2d1d34b8fda85f4119149126a9b2c7f2
families: builder=jev reviewers=none cross_family=false qa_catch_after_review=false

**OverDrafter verdict: PASS_NOTES** for `097d9c0a2d1d34b8fda85f4119149126a9b2c7f2` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "PASS_NOTES",
  "sha": "097d9c0a2d1d34b8fda85f4119149126a9b2c7f2",
  "patch_id": "2ec3aa64249c9976873c0a55a363932b6a138d02",
  "diff_id": "b228680da75dfd5c724aa4ca5eda76e3484d653625c2e86962ecc4f94d5d3422",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39021252544"
    },
    {
      "kind": "verify-run",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39021252586"
    },
    {
      "kind": "log",
      "url": "https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=846"
    }
  ],
  "notes": [
    "medium: [follow-up, real] OVD-934 AC2 asks for a test that a new SHA triggers a re-screen; no repo test pushes a new head and asserts a Jev call (the closest, line 644, covers the inverse: a stale SHA skips the marker). QA probe P2 shows the behaviour works (new head: Jev called, marker written on the new SHA). Add the test. (scripts/jev-pr-screen.test.mjs:644)",
    "medium: [follow-up, real] OVD-934 AC1 and fix item 3 name the row fields cache_hit and head_sha and ask for tokens; rows log marker_hit and sha and carry no token count. Same meaning (second same-SHA screen logs marker_hit=true with 1 Jev call, probe P1), but the field names differ from the issue and tokens are not logged. (scripts/jev-pr-screen.mjs:197)",
    "low: [follow-up, tracking] The default CLI now writes a jev-screen success commit status to GitHub as optomachina on every accepted screen. It is not a required check (branch protection requires ci and provider-go-live only, and qa-handoff gate.mjs counts only required checks), but any all-green helper over commit statuses, including the OVD-845 gate, must exclude jev-screen. (scripts/jev-pr-screen.mjs:330)",
    "low: [follow-up, tracking] The new marker module is not on the sensitive-path list (docs/sensitive-paths.json covers scripts/jev-pr-screen* only); tracked as OVD-939 C2. (scripts/lib/jev-screen-marker.mjs:1)",
    "low: [follow-up, tracking] The #743 duplicate came from screen.py, which does not read or write the marker, so dedupe across both callers (issue fix item 1) holds only after screen.py is retired; tracked as OVD-940. (scripts/jev-pr-screen.mjs:22)",
    "low: [follow-up, real] When an injected marker writer throws or returns a free-text reason, the warning echoes it after sanitizeToken, which redacts only TYPESAFE_API_KEY (probe P5). The real GitHub writer returns fixed reason codes, so no token reaches logs today; keep reasons to fixed codes. (scripts/jev-pr-screen.mjs:309)"
  ],
  "readiness": {
    "conflicts": 0,
    "open_threads": 0,
    "checks": "green"
  },
  "timestamp": "2026-10-17T10:17:40Z"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
