QA: PASS on e00c20f52fd7d84c59eb8ae2799144e8f3a0086e
The transport slice of OVD-804 (1/4) holds on re-run at e00c20f5. Realtime with a polling fallback: dedupe by runId:seq, 5 s polling while realtime is down or the tab is hidden, backoff 10/20/40/60 s capped then reset to 5 s, catch-up on recovery, clean disposal, never two polls at once. The ThreadClient contract requires idempotency keys. Both required checks (ci in run 39013781835, provider-go-live) are green, the Sonar gate is OK with 0 issues, and the PR is MERGEABLE with 0 commits behind main. UNSTABLE comes only from the rate-limited, non-required Vercel status.

Findings:
- low: [follow-up, tracking] This is split child 1/4 and covers only the transport (realtime plus polling fallback, and the ThreadClient contract with idempotency keys). OVD-804 T-1 to T-8 and its Proof (WebKit Playwright run, iPhone recording, bundle-size diff) are not exercised here and must be verified on #838 and #839. (src/features/jarvis/thread/event-source.ts:1)
- low: [follow-up, real] emit() marks a batch as seen before deliver() runs. If deliver throws during a poll, the error is handled as a poll failure and the same events are filtered out on the next poll, so they are never delivered (probe P10). (src/features/jarvis/thread/event-source.ts:24,38)
- low: [follow-up, real] Broadcast payloads are passed through without validation: an undefined payload throws a TypeError inside the realtime callback, and a partial object is delivered as a GraphEvent (probe P9). The code says server-side validation is intended; the shell should still guard before render. (src/features/jarvis/thread/supabase-source.ts:21)
- info: [follow-up, tracking] The dedupe set grows for the life of a listen() with no bound. That is fine for one conversation but worth capping if a thread stays mounted for long runs. (src/features/jarvis/thread/event-source.ts:19)

Local evidence (QA box): `/workspace/qa-batch/836-r-oct17.log`, `/workspace/qa-batch/836-oct17-vitest.txt`, `/workspace/qa-batch/836-oct17-types-probe.txt`, `/workspace/qa-batch/836-probe/QA836.probes.test.ts`, `/workspace/qa-batch/836-jev.jsonl`

Proof re-run: npm run lint + typecheck (preflight stages) + vitest src/features/jarvis (7 files, 73 passed incl. 10 QA probes P1-P10) + full vitest + ThreadClient tsc probe with a negative control; CI 39013781835, Verify 39013781831; at e00c20f52fd7d84c59eb8ae2799144e8f3a0086e
families: builder=codex reviewers=none cross_family=false qa_catch_after_review=false

**OverDrafter verdict: PASS_NOTES** for `e00c20f52fd7d84c59eb8ae2799144e8f3a0086e` by 68639ff6-bbc0-436d-86d5-f6de3ddb9054 (grok).

```overdrafter-verdict
{
  "schema": "overdrafter.verdict/v1",
  "role": "verifier",
  "verdict": "PASS_NOTES",
  "sha": "e00c20f52fd7d84c59eb8ae2799144e8f3a0086e",
  "patch_id": "ee2eea874d7089cb0e56e7991889beb984b5edaf",
  "diff_id": "491d1c339e3496249924487b5d3322b8c8c90c6bcd100ae1bf7e808d3ae88587",
  "verifier": {
    "id": "68639ff6-bbc0-436d-86d5-f6de3ddb9054",
    "model_family": "grok",
    "github_login": "optomachina"
  },
  "evidence": [
    {
      "kind": "test",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39013781835"
    },
    {
      "kind": "verify-run",
      "url": "https://github.com/optomachina/Overdrafter/actions/runs/39013781831"
    },
    {
      "kind": "log",
      "url": "https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=836"
    }
  ],
  "notes": [
    "low: [follow-up, tracking] This is split child 1/4 and covers only the transport (realtime plus polling fallback, and the ThreadClient contract with idempotency keys). OVD-804 T-1 to T-8 and its Proof (WebKit Playwright run, iPhone recording, bundle-size diff) are not exercised here and must be verified on #838 and #839. (src/features/jarvis/thread/event-source.ts:1)",
    "low: [follow-up, real] emit() marks a batch as seen before deliver() runs. If deliver throws during a poll, the error is handled as a poll failure and the same events are filtered out on the next poll, so they are never delivered (probe P10). (src/features/jarvis/thread/event-source.ts:24,38)",
    "low: [follow-up, real] Broadcast payloads are passed through without validation: an undefined payload throws a TypeError inside the realtime callback, and a partial object is delivered as a GraphEvent (probe P9). The code says server-side validation is intended; the shell should still guard before render. (src/features/jarvis/thread/supabase-source.ts:21)",
    "info: [follow-up, tracking] The dedupe set grows for the life of a listen() with no bound. That is fine for one conversation but worth capping if a thread stays mounted for long runs. (src/features/jarvis/thread/event-source.ts:19)"
  ],
  "readiness": {
    "conflicts": 0,
    "open_threads": 0,
    "checks": "green"
  },
  "timestamp": "2026-10-17T15:29:09Z"
}
```

_Do not edit this comment. Edited verdict comments are invalid; post a new comment instead._
