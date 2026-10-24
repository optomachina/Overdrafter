QA: FAIL on dc145bfb09774bdb33e6993e1bd52e37f073d3d8
SonarCloud quality gate fails on this SHA (2x S4036), model-label pool mapping drops Claude spend to unknown, and the PR body must Refs OVD-923 with follow-up ACs moved. PR-claimed behaviour otherwise re-ran green: 33/33 vitest, typecheck, lint, probes a-g.

Findings:
- high: [blocking, real] SonarCloud quality gate ERROR (new_security_rating=B, needs A): 2 open S4036 vulnerabilities, execFileSync("git") and execFileSync("gh") run with an unpinned PATH; pin PATH to fixed system dirs / absolute binaries. (scripts/spend-ledger.mjs:41,102)
- high: [blocking, real] opus, sonnet and model:opus labels map to pool unknown (attributePR -> unknown/no_signal) instead of the claude pool, so Claude-built PRs never get Claude spend attributed. (scripts/lib/spend-ledger.mjs:118)
- high: [blocking, tracking] PR body must say Refs OVD-923 (not close it) and move the out-of-scope follow-up ACs (Linear AC2 rest, AC3, AC4) to a tracked follow-up issue.
- low: [follow-up] export-evals silently drops unvalued records (only a stderr count 'Skipped N unvalued lines'); consider an explicit marker or flag. (scripts/lib/spend-ledger.mjs)
- low: [follow-up] #841 trust-snapshot.v1 is aggregate-only (botAttribution counts), so it cannot feed --attribution; needs a per-PR adapter (OVD-919).

Local evidence (QA box): `/workspace/qa-batch/845.log`, `/workspace/qa-batch/845-probes.out`

Proof re-run: `npx vitest run scripts/spend-ledger.test.mjs` (33/33) + `npm run typecheck` + `npm run lint` + `node 845-probes.mjs` + `npm run spend:ledger -- collect|weekly|export-evals` on fixtures, CI run 39013914097, at dc145bfb09774bdb33e6993e1bd52e37f073d3d8
families: builder=unknown reviewers=none cross_family=false qa_catch_after_review=false

**OverDrafter verdict: FAIL** for `dc145bfb09774bdb33e6993e1bd52e37f073d3d8` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "FAIL",
  "sha": "dc145bfb09774bdb33e6993e1bd52e37f073d3d8",
  "patch_id": "28440caa44818165141aff0fe46bf118238d915f",
  "diff_id": "8e75cab9d2a897c98b6019ea071c3f676c8dd2964bd389155907b1ad826d2390",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39013914097"
    },
    {
      "kind": "log",
      "url": "https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=845"
    }
  ],
  "notes": [
    "high: [blocking, real] SonarCloud quality gate ERROR (new_security_rating=B, needs A): 2 open S4036 vulnerabilities, execFileSync(\"git\") and execFileSync(\"gh\") run with an unpinned PATH; pin PATH to fixed system dirs / absolute binaries. (scripts/spend-ledger.mjs:41,102)",
    "high: [blocking, real] opus, sonnet and model:opus labels map to pool unknown (attributePR -> unknown/no_signal) instead of the claude pool, so Claude-built PRs never get Claude spend attributed. (scripts/lib/spend-ledger.mjs:118)",
    "high: [blocking, tracking] PR body must say Refs OVD-923 (not close it) and move the out-of-scope follow-up ACs (Linear AC2 rest, AC3, AC4) to a tracked follow-up issue.",
    "low: [follow-up] export-evals silently drops unvalued records (only a stderr count 'Skipped N unvalued lines'); consider an explicit marker or flag. (scripts/lib/spend-ledger.mjs)",
    "low: [follow-up] #841 trust-snapshot.v1 is aggregate-only (botAttribution counts), so it cannot feed --attribution; needs a per-PR adapter (OVD-919)."
  ],
  "readiness": {
    "conflicts": 0,
    "open_threads": 0,
    "checks": "red"
  },
  "timestamp": "2026-10-17T08:01:24Z"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
