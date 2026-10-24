QA: PASS on b5f2340c0f787e006e474a7eac43e0b066ed5c2d
Each OVD-844 AC holds on a re-run at this head. b5f2340c is a clean merge of main 953666ce (#843, AGENTS.md lines outside the sensitive-paths markers) on bcb559cc. The PR diff origin/main...HEAD has the same patch-id as 5f36b3e4...47ad2fa4 (3364 lines; only the AGENTS.md blob index line differs). The Proof dry runs for #790/#792/#794 re-run byte-identical. All checks are green at this SHA, including the required ci and provider-go-live (CI run 39047123631), and the Sonar gate is OK.

Findings:
- low: [follow-up, tracking] PR body still names 47ad2fa4 as the current/final head (Verification 'at this head', 'Final PR head SHA'); the head is now b5f2340c (two clean main merges since). The PR diff is unchanged (same patch-id), so only the SHA labels are stale; QA re-ran the Proof dry runs (#790/#792/#794) at this head and the JSON is byte-identical to the pasted blocks (PR #813 body:240,1439)
- low: [follow-up, test-gap] No test pins the base checkout: changing checkout ref from pull_request.base.sha to head.sha leaves all 24 workflow tests green (local mutation M3). Base-checkout behaviour is confirmed by reading the YAML only (.github/workflows/sensitive-class.yml:71)
- low: [follow-up, real] scripts/verify-result-judge* has no {,/**} suffix (unlike scripts/symphony*{,/**}), so a future scripts/verify-result-judge/lib.mjs would be repo_scripts (safe). The drift test would catch it only once CI reaches that file. Today the glob covers the judge and its test, and removing it fails the drift test (mutation M1) (docs/sensitive-paths.json:152)
- info: [follow-up, info] The CI judge (scripts/verify-result-judge.mjs) imports this skill file. It has no class and no safe category, so detect() reports it as unclassified (sensitive, fails closed), not infra_ci. The drift walk checks only scripts/ files (.agents/skills/verify-overdrafter/scripts/feature-specs.mjs:1)

Local evidence (QA box): `/workspace/qa-batch/813-bcb.log`, `/workspace/qa-batch/813-new-check.out`, `/workspace/qa-batch/813-new-probes.out`, `/workspace/qa-batch/813-new-vitest.txt`, `/workspace/qa-batch/813-new-jev.jsonl`

Proof re-run: Proof dry runs #790/#792/#794 (JSON byte-identical to the pasted blocks) + #813 self (gate_loosening gate_changed x2, matcher_changed) + vitest 6 files 418/418 + test:agent-control-plane + validate-agent-contract + typecheck + lint + validate-pr-body + sensitive-paths:report (merge delta and full PR) + 37 focused probes (36 pass; the 1 miss is a hypothetical subdirectory, logged as a follow-up) + 3 mutations (drift test kills removal of the verify-result-judge* glob; workflow tests kill removal of the rc capture; base->head checkout survives, logged as a follow-up) + main's Jev screener (risky) + CI runs 39047123631, 39047123591 and 39047123616, at b5f2340c0f787e006e474a7eac43e0b066ed5c2d
families: builder=claude reviewers=none cross_family=false qa_catch_after_review=false

**OverDrafter verdict: PASS_NOTES** for `b5f2340c0f787e006e474a7eac43e0b066ed5c2d` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "PASS_NOTES",
  "sha": "b5f2340c0f787e006e474a7eac43e0b066ed5c2d",
  "patch_id": "24aceda9c105a69a6d5e8b7d479b3906fa6c7481",
  "diff_id": "ae3b8d45c6dcd2f81b850af19e4ee781e8d42db49dd81861679caa4d731dee5d",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39047123631"
    },
    {
      "kind": "verify-run",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39047123591"
    },
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39047123616"
    },
    {
      "kind": "log",
      "url": "https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=813"
    }
  ],
  "notes": [
    "low: [follow-up, tracking] PR body still names 47ad2fa4 as the current/final head (Verification 'at this head', 'Final PR head SHA'); the head is now b5f2340c (two clean main merges since). The PR diff is unchanged (same patch-id), so only the SHA labels are stale; QA re-ran the Proof dry runs (#790/#792/#794) at this head and the JSON is byte-identical to the pasted blocks (PR #813 body:240,1439)",
    "low: [follow-up, test-gap] No test pins the base checkout: changing checkout ref from pull_request.base.sha to head.sha leaves all 24 workflow tests green (local mutation M3). Base-checkout behaviour is confirmed by reading the YAML only (.github/workflows/sensitive-class.yml:71)",
    "low: [follow-up, real] scripts/verify-result-judge* has no {,/**} suffix (unlike scripts/symphony*{,/**}), so a future scripts/verify-result-judge/lib.mjs would be repo_scripts (safe). The drift test would catch it only once CI reaches that file. Today the glob covers the judge and its test, and removing it fails the drift test (mutation M1) (docs/sensitive-paths.json:152)",
    "info: [follow-up, info] The CI judge (scripts/verify-result-judge.mjs) imports this skill file. It has no class and no safe category, so detect() reports it as unclassified (sensitive, fails closed), not infra_ci. The drift walk checks only scripts/ files (.agents/skills/verify-overdrafter/scripts/feature-specs.mjs:1)"
  ],
  "readiness": {
    "conflicts": 0,
    "open_threads": 0,
    "checks": "green"
  },
  "timestamp": "2026-10-17T16:13:21Z"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
