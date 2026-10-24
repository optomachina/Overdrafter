#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/846-r3-verdict-v1.md (does not post). Re-checks the head first.
set -e
H=8bab4a7cc81233eb563efe36ae3de43d5ff73876
B=953666cee6e7019e1f79adc18c987d469e3f44dd
read cur base < <(gh pr view 846 -R optomachina/Overdrafter --json headRefOid,baseRefOid --jq '"\(.headRefOid) \(.baseRefOid)"')
[ "$cur" = "$H" ] || { echo "HEAD MOVED: $cur != $H; re-run QA" >&2; exit 3; }
[ "$base" = "$B" ] || { echo "BASE MOVED: $base != $B; re-check behind/conflicts" >&2; exit 4; }
cd /workspace/qa-batch && git -C repo-fresh fetch -q origin main pull/846/head && node verdict-v1.mjs --pr 846 --sha $H --base $B --verdict PASS \
 --findings 846-r3-findings.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39049150329 \
 --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/39049150291 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=846' \
 --local-evidence /workspace/qa-batch/846-r3.log --local-evidence /workspace/qa-batch/846-r3-probes.out --local-evidence /workspace/qa-batch/846-r3-mutation.txt --local-evidence /workspace/qa-batch/846-r3-real-rows.jsonl --local-evidence /workspace/qa-batch/846-r3-jev.jsonl \
 --summary "All three Architect fixes hold on re-run, and OVD-934 AC1-3 still hold. Paged read: a stronger marker on page 2 or 3 is found, and a failed, oversized or endless page list is a miss. Strict parsing: duplicate, extra, malformed and other-commit markers are rejected and cause a re-screen. The marker module now classifies infra_ci. The main merge 953666ce is clean (its tree equals git's automatic merge). Every check is green at this SHA (CI run 39049150329) and the Sonar gate is OK with 0 issues." \
 --proof "Proof re-run: vitest 4 Jev/sensitive-paths files 140/140, test:agent-control-plane, test:portable-node, gh-spy run of jev-pr-screen.test.mjs (47/47, 0 gh calls), 9 mutations (all caught), eslint on changed files, validate-pr-body, sensitive-paths:report on a local merge with main, node 846-probes.mjs 68/68, a real-row Jev screen on the box; full vitest (same 50 env-only failing files as main), typecheck and lint on the Mac mini; CI runs 39049150329 and 39049150291; all at $H" \
 --families 'families: builder=jev reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks green --conflicts 0 --open-threads 0 --out 846-r3-verdict-v1.md --check "$@"
