#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/846-verdict-v1.md (does not post).
cd /workspace/qa-batch && git -C repo-fresh fetch -q origin main pull/846/head && node verdict-v1.mjs --pr 846 --sha 097d9c0a2d1d34b8fda85f4119149126a9b2c7f2 --base d88d5df8aded2394fa10e2fafbefbaa65809ab42 --verdict PASS \
 --findings 846-findings.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39021252544 \
 --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/39021252586 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=846' \
 --local-evidence /workspace/qa-batch/846.log --local-evidence /workspace/qa-batch/846-probes.out --local-evidence /workspace/qa-batch/846-jev.jsonl \
 --summary 'All three OVD-934 ACs hold on re-run: a same-SHA re-screen makes 1 Jev call and logs marker_hit=true, a new head re-screens, and jev-decisions.jsonl is untracked and gitignored. Every check is green at this SHA (CI run 39021252544) and the Sonar gate is OK with 0 issues. Two medium notes: no repo test for the new-SHA re-screen, and the field names differ from the issue (marker_hit/sha, no tokens).' \
 --proof 'Proof re-run: vitest 4 files 130/130 + full vitest (same 50 env-only failing files as base main) + typecheck + lint on a fresh Mac mini clone, eslint on changed files, validate-pr-body, sensitive-paths:report, node 846-probes.mjs 31/31, CI runs 39021252544 and 39021252586, at 097d9c0a2d1d34b8fda85f4119149126a9b2c7f2' \
 --families 'families: builder=jev reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks green --conflicts 0 --open-threads 0 --out 846-verdict-v1.md --check "$@"
