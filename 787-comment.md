QA: PASS on 019f8c94
OVD-802 ACs, re-run in a fresh worktree with real build123d 0.13.0: 35/35 tests pass and none are skipped, including P-1 to P-6 (P-1 measures 101.6 x 101.6 mm, and P-3's GLB is watertight).
Timeout fix: the outer timeout is the inner timeout + 30_000 ms (`cad-agent.ts:151-152`). In an independent probe, a fake Python with a grandchild ran under a 500 ms inner timeout. The CLI reported `worker timed out after 500 ms`, no process was left 2 s later, and the claim moved to failed/ (claimed/ was empty).
The /workspace/proof-802 artifacts match the PR body under `sha256sum -c`: plate.glb, plate-iso.png, plate-top.png and plate.step all report OK. The diff has no SQL or migration.
Review gate: Opus re-review APPROVED on the head (issuecomment-6209763565). CI run 38861911851 green (https://github.com/optomachina/Overdrafter/actions/runs/38861911851); SonarCloud gate passed.
Proof re-run: `JARVIS_DEMO_PYTHON=/workspace/.venv-cad/bin/python npx vitest run server/design-graph scripts/jarvis-demo --maxWorkers=2`, the orphan probe and `sha256sum -c` at 019f8c94; run 38861911851.
