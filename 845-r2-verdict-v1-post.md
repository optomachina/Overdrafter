QA: PASS on 4a70d533404a9f7e92484c4c92937ae86fa9de38
All three round-1 must-fixes hold at this SHA: SonarCloud gate OK (0 vulnerabilities, S4036 fixed in code), opus/sonnet/model:opus/model:sonnet map to the claude pool, and the body says Refs OVD-923 with AC2-AC4 moved to OVD-926/927/928. Required checks ci and provider-go-live are green; 44/44 vitest, typecheck, lint and probes a-k re-ran green.

Findings:
- low: [follow-up, real] export-evals --out on an all-unvalued ledger still writes an empty output file before exiting 3; a later reader that ignores the exit code could take that file as $0. Skip the write when exiting 3. (scripts/spend-ledger.mjs:111)
- low: [follow-up, tracking] #835 loadLedger (head 76c5c038) accepts the new export lines but drops exportUnvaluedRecords/exportComplete, so the #835 report does not yet show incompleteness; consumer side needs a follow-up. (scripts/evals-weekly-report.mjs:256)
- low: [follow-up, tracking] Two github-advanced-security S4036 review threads from dc145bfb are still unresolved although the code is fixed and Sonar shows 0 vulnerabilities at this head; resolve them. (scripts/spend-ledger.mjs:41,102)
- low: [follow-up, tracking] 10 open Sonar code smells (S3776 cognitive complexity in main and usageToLedger, S3358 nested ternaries); gate is OK. (scripts/spend-ledger.mjs:40)
- low: [follow-up, tracking] #841 trust snapshot has no per-PR attribution and is not accepted as --attribution (exit 2); tracked in OVD-930. (docs/spend-ledger.md:1)

Local evidence (QA box): `/workspace/qa-batch/845-r2.log`, `/workspace/qa-batch/845-r2-probes.out`, `/workspace/qa-batch/845-r2-jev.jsonl`

Proof re-run: npx vitest run scripts/spend-ledger.test.mjs (44/44) + npm run typecheck + npm run lint + node 845-r2-probes.mjs (a-k, 55/55) + npm run spend:ledger collect|weekly|export-evals on fixtures, CI run 39018012578, at 4a70d533404a9f7e92484c4c92937ae86fa9de38
families: builder=codex reviewers=none cross_family=false qa_catch_after_review=false

**OverDrafter verdict: PASS_NOTES** for `4a70d533404a9f7e92484c4c92937ae86fa9de38` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "PASS_NOTES",
  "sha": "4a70d533404a9f7e92484c4c92937ae86fa9de38",
  "patch_id": "987f8da30d08c768c5b39da2eea3a5477115b510",
  "diff_id": "319809a8033402eddbd6d367b0757f121db9d3bf8022336d762e6bf4ddf42a0d",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39018012578"
    },
    {
      "kind": "verify-run",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39018012574"
    },
    {
      "kind": "log",
      "url": "https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=845"
    }
  ],
  "notes": [
    "low: [follow-up, real] export-evals --out on an all-unvalued ledger still writes an empty output file before exiting 3; a later reader that ignores the exit code could take that file as $0. Skip the write when exiting 3. (scripts/spend-ledger.mjs:111)",
    "low: [follow-up, tracking] #835 loadLedger (head 76c5c038) accepts the new export lines but drops exportUnvaluedRecords/exportComplete, so the #835 report does not yet show incompleteness; consumer side needs a follow-up. (scripts/evals-weekly-report.mjs:256)",
    "low: [follow-up, tracking] Two github-advanced-security S4036 review threads from dc145bfb are still unresolved although the code is fixed and Sonar shows 0 vulnerabilities at this head; resolve them. (scripts/spend-ledger.mjs:41,102)",
    "low: [follow-up, tracking] 10 open Sonar code smells (S3776 cognitive complexity in main and usageToLedger, S3358 nested ternaries); gate is OK. (scripts/spend-ledger.mjs:40)",
    "low: [follow-up, tracking] #841 trust snapshot has no per-PR attribution and is not accepted as --attribution (exit 2); tracked in OVD-930. (docs/spend-ledger.md:1)"
  ],
  "readiness": {
    "conflicts": 0,
    "open_threads": 2,
    "checks": "green"
  },
  "timestamp": "2026-10-17T08:58:16Z"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
