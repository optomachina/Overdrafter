QA: PASS on c62066d3
OVD-827 AC (Connection: close on deadline): the regression test fails on the pre-fix code (c62066d3^ with the new test, 3/3 runs: `expected 'keep-alive' to be 'close'`). The test file passes 25/25 (11/11 tests each run) at c62066d3. Review gate: Sonnet APPROVED on the head (issuecomment-6209139533).
CI run 38857052578 green; SonarCloud gate passed.
Proof re-run: `npx vitest run server/engineering/native-artifact-route.test.ts --maxWorkers=2` x25 at c62066d3, plus x3 at pre-fix; run 38857052578.
