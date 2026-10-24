#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/836-oct17-verdict-v1.md (never posts). Re-checks the head first.
set -e
H=e00c20f52fd7d84c59eb8ae2799144e8f3a0086e
B=d88d5df8aded2394fa10e2fafbefbaa65809ab42
cur=$(gh pr view 836 -R optomachina/Overdrafter --json headRefOid --jq .headRefOid)
[ "$cur" = "$H" ] || { echo "HEAD MOVED: $cur != $H; re-run QA" >&2; exit 3; }
cd /workspace/qa-batch && git -C repo-fresh fetch -q origin main pull/836/head && node verdict-v1.mjs --pr 836 --sha $H --base $B --verdict PASS \
 --findings /workspace/qa-batch/836-oct17-findings.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39013781835 \
 --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/39013781831 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=836' \
 --local-evidence /workspace/qa-batch/836-r-oct17.log --local-evidence /workspace/qa-batch/836-oct17-vitest.txt --local-evidence /workspace/qa-batch/836-oct17-types-probe.txt --local-evidence /workspace/qa-batch/836-probe/QA836.probes.test.ts --local-evidence /workspace/qa-batch/836-jev.jsonl \
 --summary 'The transport slice of OVD-804 (1/4) holds on re-run at e00c20f5. Realtime with a polling fallback: dedupe by runId:seq, 5 s polling while realtime is down or the tab is hidden, backoff 10/20/40/60 s capped then reset to 5 s, catch-up on recovery, clean disposal, never two polls at once. The ThreadClient contract requires idempotency keys. Both required checks (ci in run 39013781835, provider-go-live) are green, the Sonar gate is OK with 0 issues, and the PR is MERGEABLE with 0 commits behind main. UNSTABLE comes only from the rate-limited, non-required Vercel status.' \
 --proof "Proof re-run: npm run lint + typecheck (preflight stages) + vitest src/features/jarvis (7 files, 73 passed incl. 10 QA probes P1-P10) + full vitest + ThreadClient tsc probe with a negative control; CI 39013781835, Verify 39013781831; at $H" \
 --families 'families: builder=codex reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks green --conflicts 0 --open-threads 0 --out /workspace/qa-batch/836-oct17-verdict-v1.md --check "$@"
