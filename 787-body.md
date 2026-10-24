Implements OVD-802 (Jarvis slice 1): `CadAgent` behind the design-graph `DomainAgent` interface, plus a build123d `plate` recipe on the OVD-765 worker queue.

## Proof

**Round-1 review repairs at `019f8c94`**: real P-1..P-6 run (build123d + matplotlib in `/workspace/.venv-cad`)

```
JARVIS_DEMO_PYTHON=/workspace/.venv-cad/bin/python npx vitest run server/design-graph/cad-agent.test.ts scripts/jarvis-demo/jarvis-demo.test.mjs --maxWorkers=2 --reporter=verbose
```
Result: **23/23 passed, 0 skipped** (2 files)
```
✓ P-1 '4 inch square plate' produces a 101.6 x 101.6 mm solid within 0.01 mm, measured from the STEP  4556ms   (measured x=101.6 y=101.6 z=6.35, solids=1)
✓ P-2 both decisions skipped -> best guesses recorded with rationale and artifacts produced              2477ms   (picks: 0.25 in (6.35 mm), No holes)
✓ P-3 exactly one valid solid and a watertight GLB (every edge shared by exactly two triangles)          4674ms   (2044 tris, edgesNotShared2=0, V-E+F=-6 i.e. genus 4)
✓ P-4 out-of-range thickness is refused with an error event before any job is filed                      8ms
✓ P-4 (worker) the queue refuses an out-of-range plate thickness and files nothing                       2ms
✓ P-5 a plate job is claimed exactly once under concurrent workers                                       1043ms
✓ P-6 flag off -> the CAD agent refuses with an error event and never reaches the worker                 3ms
✓ a Python run past the worker timeout is killed with its process group and the claim moves to failed    2411ms
✓ SIGTERM to the CLI kills the running Python group and still moves the claim to failed                  2117ms
✓ the default runner's Python timeout fires inside its outer timeout: no claim and no process outlives a timed-out job  2417ms
✓ the default runner runs nothing with the CAD flag off, even when called directly                       1ms
✓ a job with an unknown recipe fails with a structured result instead of crashing                        99ms
✓ plate jobs need the CAD agent flag: the plate command files nothing and work hands the job back        197ms
✓ the plate command files its job already claimed, so a concurrent work never takes it                   624ms
✓ refusal reasons echo only numbers, never caller-supplied text                                          1ms
✓ glb_check.py with no argument prints usage and exits 64 without a traceback                            117ms
```

**Preflight** (`npm run preflight -- --maxWorkers=2` rejects the flag, so the stages were run separately):
- `bash scripts/preflight.sh lint`: PASS
- `bash scripts/preflight.sh typecheck`: PASS
- `env -u JARVIS_DEMO_PYTHON npx vitest run --maxWorkers=2`: 11295 passed, 19 skipped, 3 failed. All 3 failures are the Docker-only `qualify-ovd417-four-migration-suffix` tests, a known local failure.

### Earlier runs
**What changed**
- `scripts/jarvis-demo/plate.py`: 4.000 x 4.000 in plate recipe. Thickness and hole pattern are decision points; the best guesses are 0.25 in 6061 and no holes. Emits STEP (authoritative), PNG iso/top renders and a GLB (derived).
- `scripts/jarvis-demo/glb_check.py`: checks that the GLB is watertight.
- `scripts/jarvis-demo/jarvis-demo.mjs`: plate jobs in the atomic-rename single-claim queue.
- `server/design-graph/cad-agent.ts`: CadAgent, gated by `JARVIS_CAD_AGENT_ENABLED`. Invalid plates are refused before any questions are asked. Routing is plate-only when the flag is on.
- Tests and READMEs.

**Tests**
- `vitest server/design-graph`: 14 passed, 3 skipped. The real-worker P-1/P-2/P-3 cases skip when no Python with build123d is installed (CI and this box have none). P-4 and P-6 pass.
- `vitest scripts/jarvis-demo`: 9 passed. This covers P-5 (concurrent single claim) and the worker-side P-4 thickness refusal.

**Preflight**: lint PASS, typecheck PASS. Tests: 11287 passed, 18 skipped, 3 failed. All 3 failures are in `scripts/qualify-ovd417-four-migration-suffix.test.mjs`, which needs Docker and is a known local failure unrelated to this change.

**Real P-1..P-6 run at head `61551894` (also passed at `1da74e16`)** (build123d 0.13.0 + matplotlib in `/workspace/.venv-cad`, `JARVIS_DEMO_PYTHON` set, `vitest --maxWorkers=2`): **26/26 passed, 0 skipped** (server/design-graph + scripts/jarvis-demo)
```
✓ P-1 '4 inch square plate' produces a 101.6 x 101.6 mm solid within 0.01 mm, measured from the STEP  5612ms
✓ P-2 both decisions skipped -> best guesses recorded with rationale and artifacts produced  3125ms
✓ P-3 exactly one valid solid and a watertight GLB (every edge shared by exactly two triangles)  5765ms
✓ P-4 out-of-range thickness is refused with an error event before any job is filed  17ms
✓ P-5 a plate job is claimed exactly once under concurrent workers  1217ms
✓ P-6 flag off -> the CAD agent refuses with an error event and never reaches the worker  2ms
```
Before matplotlib was installed in the venv, P-1 to P-3 failed with "worker failed" because the PNG render step imports matplotlib. That is an environment issue, and `scripts/jarvis-demo/README.md` already lists matplotlib as a dependency.

**Artifacts** (best-guess plate: 101.6 x 101.6 x 6.35 mm, no holes, `allChecksPass: true`). They are kept on the build box at `/workspace/proof-802/`: `plate.step`, `plate.glb`, `plate-iso.png`, `plate-top.png`, `result.json`, `vitest-p1-p6.log`. The GitHub API cannot upload binary attachments, so they still need to be attached by hand.
```
    2816b84c306dca340d23dfa068c2be3445b55f776674e1d7254d6e590fbd3760  plate.glb
    1d1802684bc2833cc80207996823c50e8ae84581ff74b0cb324111836197baef  plate-iso.png
    a60d53e9d0c8d9716a19570c48285fddf852b0de8e370ae4f7002a0255d4bfeb  plate-top.png
    b5bb8449e55659f4533f6cc88fde625cfa35c96575dca8e01b538da313e21188  plate.step
```

**Follow-up commit `61551894`** fixes the SonarCloud findings:
- Log output from the jarvis-demo CLI is now allowlisted (S8689).
- `glb_check.py` paths are confined to `$JARVIS_DEMO_ROOT/runs`, with a new refusal test (S8707).
- The edge check uses a float tolerance (S1244).
- `main` is split up to reduce cognitive complexity (S3776).
- Small code-smell fixes in `cad-agent.ts`.

Preflight at `61551894`: lint PASS, typecheck PASS. Tests: 11287 passed, 3 failed. All 3 failures are the Docker-only `qualify-ovd417-four-migration-suffix` tests, a known local failure.


