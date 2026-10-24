#!/usr/bin/env bash
cd /workspace/qa-batch/wt813-bcb; P=/workspace/qa-batch
npx vitest run scripts/sensitive-class-detect.test.mjs scripts/sensitive-class-sweep.test.mjs scripts/sensitive-paths.test.mjs scripts/verify-result-judge.test.mjs scripts/verify-overdrafter-skill.test.mjs scripts/jev-pr-screen.test.mjs > $P/813-bcb-vitest.txt 2>&1; echo "exit=$?" >> $P/813-bcb-vitest.txt
npm run -s typecheck > $P/813-bcb-typecheck.txt 2>&1; echo "exit=$?" >> $P/813-bcb-typecheck.txt
npm run -s lint > $P/813-bcb-lint.txt 2>&1; echo "exit=$?" >> $P/813-bcb-lint.txt
npm run -s sensitive-paths:report > $P/813-bcb-sensitive.txt 2>&1; echo "exit=$?" >> $P/813-bcb-sensitive.txt
node --test scripts/validate-agent-contract.node-test.mjs > $P/813-bcb-agent-contract.txt 2>&1; node scripts/validate-agent-contract.mjs >> $P/813-bcb-agent-contract.txt 2>&1; echo "exit=$?" >> $P/813-bcb-agent-contract.txt
echo DONE > $P/813-bcb-tests.done
