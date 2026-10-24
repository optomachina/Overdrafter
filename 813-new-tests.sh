#!/usr/bin/env bash
cd /workspace/qa-batch/wt813-new; P=/workspace/qa-batch
npx vitest run scripts/sensitive-class-detect.test.mjs scripts/sensitive-class-sweep.test.mjs scripts/lib/sensitive-paths.test.mjs scripts/verify-result-judge.test.mjs scripts/verify-overdrafter-skill.test.mjs scripts/jev-pr-screen.test.mjs > $P/813-new-vitest.txt 2>&1; echo "exit=$?" >> $P/813-new-vitest.txt
node --test scripts/validate-agent-contract.node-test.mjs > $P/813-new-agent-contract.txt 2>&1; node scripts/validate-agent-contract.mjs >> $P/813-new-agent-contract.txt 2>&1; echo "exit=$?" >> $P/813-new-agent-contract.txt
npm run -s test:agent-control-plane > $P/813-new-agent-control-plane.txt 2>&1; echo "exit=$?" >> $P/813-new-agent-control-plane.txt
npm run -s sensitive-paths:report > $P/813-new-sensitive.txt 2>&1; echo "exit=$?" >> $P/813-new-sensitive.txt
node $P/sp-report-oct17.mjs /workspace/qa-batch/wt813-new 953666cee6e7019e1f79adc18c987d469e3f44dd b5f2340c0f787e006e474a7eac43e0b066ed5c2d > $P/813-new-sensitive-full.txt 2>&1
npm run -s typecheck > $P/813-new-typecheck.txt 2>&1; echo "exit=$?" >> $P/813-new-typecheck.txt
npm run -s lint > $P/813-new-lint.txt 2>&1; echo "exit=$?" >> $P/813-new-lint.txt
npm run -s validate:pr-body -- --help > /dev/null 2>&1
echo DONE > $P/813-new-tests.done
