#!/usr/bin/env bash
# Regenerates /workspace/qa-batch/813-bcb-verdict-v1.md for PR #813 at the NEW head b5f2340c (bcb559cc was superseded). Does not post.
set -e
H=b5f2340c0f787e006e474a7eac43e0b066ed5c2d
B=953666cee6e7019e1f79adc18c987d469e3f44dd
cur=$(gh pr view 813 -R optomachina/Overdrafter --json headRefOid --jq .headRefOid)
[ "$cur" = "$H" ] || { echo "HEAD MOVED: $cur != $H; re-run QA" >&2; exit 3; }
base=$(gh pr view 813 -R optomachina/Overdrafter --json baseRefOid --jq .baseRefOid)
[ "$base" = "$B" ] || { echo "BASE MOVED: $base != $B; re-check" >&2; exit 4; }
cd /workspace/qa-batch && git -C repo-fresh fetch -q origin main pull/813/head && node verdict-v1.mjs --pr 813 --sha $H --base $B --verdict PASS \
 --findings 813-new-findings.json \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39047123631 \
 --evidence verify-run=https://github.com/optomachina/Overdrafter/actions/runs/39047123591 \
 --evidence test=https://github.com/optomachina/Overdrafter/actions/runs/39047123616 \
 --evidence 'log=https://sonarcloud.io/dashboard?id=optomachina_Overdrafter&pullRequest=813' \
 --local-evidence /workspace/qa-batch/813-bcb.log --local-evidence /workspace/qa-batch/813-new-check.out --local-evidence /workspace/qa-batch/813-new-probes.out --local-evidence /workspace/qa-batch/813-new-vitest.txt --local-evidence /workspace/qa-batch/813-new-jev.jsonl \
 --summary 'Each OVD-844 AC holds on a re-run at this head. b5f2340c is a clean merge of main 953666ce (#843, AGENTS.md lines outside the sensitive-paths markers) on bcb559cc. The PR diff origin/main...HEAD has the same patch-id as 5f36b3e4...47ad2fa4 (3364 lines; only the AGENTS.md blob index line differs). The Proof dry runs for #790/#792/#794 re-run byte-identical. All checks are green at this SHA, including the required ci and provider-go-live (CI run 39047123631), and the Sonar gate is OK.' \
 --proof "Proof re-run: Proof dry runs #790/#792/#794 (JSON byte-identical to the pasted blocks) + #813 self (gate_loosening gate_changed x2, matcher_changed) + vitest 6 files 418/418 + test:agent-control-plane + validate-agent-contract + typecheck + lint + validate-pr-body + sensitive-paths:report (merge delta and full PR) + 37 focused probes (36 pass; the 1 miss is a hypothetical subdirectory, logged as a follow-up) + 3 mutations (drift test kills removal of the verify-result-judge* glob; workflow tests kill removal of the rc capture; base->head checkout survives, logged as a follow-up) + main's Jev screener (risky) + CI runs 39047123631, 39047123591 and 39047123616, at $H" \
 --families 'families: builder=claude reviewers=none cross_family=false qa_catch_after_review=false' \
 --checks green --conflicts 0 --open-threads 0 --out 813-bcb-verdict-v1.md --check "$@"
