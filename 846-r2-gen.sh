#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/846-r2-verdict-v1.md (does not post). Re-check the head first.
set -e
H=7b5da3078ac64b12287a97ed1cdf6dd61bcf13fd
cur=$(gh pr view 846 -R optomachina/Overdrafter --json headRefOid --jq .headRefOid)
[ "$cur" = "$H" ] || { echo "HEAD MOVED: $cur != $H; re-run QA" >&2; exit 3; }
cd /workspace/qa-batch && git -C repo-fresh fetch -q origin main pull/846/head && node verdict-v1.mjs --pr 846 --sha $H --base d88d5df8aded2394fa10e2fafbefbaa65809ab42 --verdict PASS \
 --findings 846-r2-findings.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39024588330 \
 --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/39024588300 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=846' \
 --local-evidence /workspace/qa-batch/846-r2.log --local-evidence /workspace/qa-batch/846-r2-probes.out --local-evidence /workspace/qa-batch/846-r2-real-rows.jsonl --local-evidence /workspace/qa-batch/846-r2-jev.jsonl \
 --summary 'Both causes of the QA FAIL at 097d9c0a are fixed and all three OVD-934 ACs hold on re-run: the new test (new head re-screens, one marker written on the new SHA, old marker untouched, next screen is a hit) passes and fails under 4 local mutations, and rows carry cache_hit, head_sha and tokens (real Jev row: 632/56; null on a hit). The delta is these 3 files only. Every check is green at this SHA (CI run 39024588330) and the Sonar gate is OK with 0 issues.' \
 --proof "Proof re-run: vitest 4 files 133/133 + gh-spy run of jev-pr-screen.test.mjs (40/40, 0 gh calls) + 4 mutations of the new test + full vitest (same 50 env-only failing files as base main) + typecheck + lint on the Mac mini clone, eslint on changed files, validate-pr-body, sensitive-paths:report, node 846-probes.mjs 40/40, one real-row Jev screen, CI runs 39024588330 and 39024588300, at $H" \
 --families 'families: builder=jev reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks green --conflicts 0 --open-threads 0 --out 846-r2-verdict-v1.md --check "$@"
