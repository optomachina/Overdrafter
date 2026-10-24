QA: <PASS|FAIL> on <40-char head sha>
<1-3 short lines: what decided the verdict; for FAIL name the failing criterion/check>

Findings:
- <high|medium|low|info>: [<blocking|follow-up>, <real|tracking|...>] <message> (<file>:<line>)

Local evidence (QA box): `/workspace/qa-batch/<PR>.log`, `/workspace/qa-batch/<PR>-probes.out`

Proof re-run: <command(s) and/or run id> at <40-char head sha>
families: builder=<codex|claude|grok|jev|unknown> reviewers=<none|family:model:VERDICT@sha,...> cross_family=<true|false> qa_catch_after_review=<true|false>

**OverDrafter verdict: <PASS|PASS_NOTES|FAIL>** for `<40-char head sha>` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "<PASS|PASS_NOTES|FAIL>",
  "sha": "<40-hex head sha>",
  "patch_id": "<40-hex: git patch-id --verbatim of pinned base...head diff (computePatchId)>",
  "diff_id": "<64-hex: sha256 of git diff --raw -z --no-abbrev --no-renames --full-index --no-relative --ignore-submodules=none -O/dev/null --no-color base...head (computeDiffId)>",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    { "kind": "<verify-run|test|log|artifact>", "url": "https://github.com/optomachina/Overdrafter/actions/runs/<run id>" }
  ],
  "notes": [
    "<high|medium|low|info>: [<blocking|follow-up>, <kind>] <message> (<file>:<line>)"
  ],
  "readiness": { "conflicts": <int>, "open_threads": <int>, "checks": "<green|pending|red>" },
  "timestamp": "<YYYY-MM-DDTHH:MM:SSZ, UTC, emit time>"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
