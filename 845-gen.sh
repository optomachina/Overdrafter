#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/845-verdict-v1.md (does not post).
cd /workspace/qa-batch && node verdict-v1.mjs --pr 845 --sha dc145bfb09774bdb33e6993e1bd52e37f073d3d8 --base d88d5df8aded2394fa10e2fafbefbaa65809ab42 --verdict FAIL \
 --findings 845-findings.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39013914097 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=845' \
 --local-evidence /workspace/qa-batch/845.log --local-evidence /workspace/qa-batch/845-probes.out \
 --summary 'SonarCloud quality gate fails on this SHA (2x S4036), model-label pool mapping drops Claude spend to unknown, and the PR body must Refs OVD-923 with follow-up ACs moved. PR-claimed behaviour otherwise re-ran green: 33/33 vitest, typecheck, lint, probes a-g.' \
 --proof 'Proof re-run: `npx vitest run scripts/spend-ledger.test.mjs` (33/33) + `npm run typecheck` + `npm run lint` + `node 845-probes.mjs` + `npm run spend:ledger -- collect|weekly|export-evals` on fixtures, CI run 39013914097, at dc145bfb09774bdb33e6993e1bd52e37f073d3d8' \
 --families 'families: builder=unknown reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks red --conflicts 0 --open-threads 0 --out 845-verdict-v1.md --check "$@"
