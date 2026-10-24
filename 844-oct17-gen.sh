#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/844-oct17-verdict-v1.md (never posts). Re-checks the head first.
set -e
H=560cbf2b0c4c1557f774f471f7d1c3583a5ff28b
B=d88d5df8aded2394fa10e2fafbefbaa65809ab42
cur=$(gh pr view 844 -R optomachina/Overdrafter --json headRefOid --jq .headRefOid)
[ "$cur" = "$H" ] || { echo "HEAD MOVED: $cur != $H; re-run QA" >&2; exit 3; }
cd /workspace/qa-batch && git -C repo-fresh fetch -q origin main pull/844/head && node verdict-v1.mjs --pr 844 --sha $H --base $B --verdict PASS \
 --findings /workspace/qa-batch/844-oct17-findings.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39011843419 \
 --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/39011843388 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=844' \
 --local-evidence /workspace/qa-batch/844-r-oct17.log --local-evidence /workspace/qa-batch/844-oct17-vitest.txt --local-evidence /workspace/qa-batch/844-oct17-uri-probe.txt --local-evidence /workspace/qa-batch/844-oct17-o1-probe.txt --local-evidence /workspace/qa-batch/844-oct17-shots.txt --local-evidence /workspace/qa-batch/844-jev.jsonl \
 --summary 'All 10 OVD-903 items (D1-D4, O1-O6) hold on re-run in a fresh worktree at 560cbf2b. Both required checks (ci in run 39011843419, provider-go-live) and all other check runs are green, the Sonar gate is OK with 0 issues, and the PR is MERGEABLE/CLEAN with 0 commits behind main. A local re-render of all 12 committed proof screenshots is pixel-identical.' \
 --proof "Proof re-run: lint + typecheck + vitest src/features/jarvis src/components/jarvis src/pages/JarvisArPreview.test.tsx server/design-graph + verify-* (14 files, 168 passed, 3 skipped for build123d), full vitest, focus/uri()/https probes, Playwright re-render of /dev/jarvis-ar?embed=1 (12/12 pixel-identical) plus a real-keyboard Tab/Escape/backdrop probe; CI 39011843419, Verify 39011843388; at $H" \
 --families 'families: builder=codex reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks green --conflicts 0 --open-threads 0 --out /workspace/qa-batch/844-oct17-verdict-v1.md --check "$@"
