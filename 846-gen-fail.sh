#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/846-verdict-v1-fail.md (does not post).
cd /workspace/qa-batch && git -C repo-fresh fetch -q origin main pull/846/head && node verdict-v1.mjs --pr 846 --sha 097d9c0a2d1d34b8fda85f4119149126a9b2c7f2 --base d88d5df8aded2394fa10e2fafbefbaa65809ab42 --verdict FAIL \
 --findings 846-findings-fail.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39021252544 \
 --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/39021252586 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=846' \
 --local-evidence /workspace/qa-batch/846.log --local-evidence /workspace/qa-batch/846-probes.out --local-evidence /workspace/qa-batch/846-jev.jsonl \
 --summary 'FAIL on two OVD-934 acceptance gaps, both triaged by Jev as real: AC2 needs a repo test showing a new head SHA triggers a re-screen (none exists; behaviour works in QA probe P2), and AC1/fix item 3 name the row fields cache_hit and head_sha plus tokens, while rows log marker_hit and sha with no tokens. Everything else holds: the log is untracked and gitignored, every check is green at this SHA (CI run 39021252544), Sonar gate OK with 0 issues, 130/130 targeted tests and 31/31 probes pass.' \
 --proof 'Proof re-run: vitest 4 files 130/130 + full vitest (same 50 env-only failing files as base main) + typecheck + lint on a fresh Mac mini clone, eslint on changed files, validate-pr-body, sensitive-paths:report, node 846-probes.mjs 31/31, CI runs 39021252544 and 39021252586, at 097d9c0a2d1d34b8fda85f4119149126a9b2c7f2' \
 --families 'families: builder=jev reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks green --conflicts 0 --open-threads 0 --out 846-verdict-v1-fail.md --check "$@"
