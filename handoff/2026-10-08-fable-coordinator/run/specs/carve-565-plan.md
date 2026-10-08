# #565 carve plan (read-only planning, 2026-10-08)

Checkpoint `bae69fbf09a05b83bf60fd46c40985c86a83849b` (tree `7af8adcb…`) on old base `8d8d243`; 97 files, +7779/-69 (80 A, 17 M).
Main `7b50f0d` (16 commits since base); integration `codex/recovered-release-free-safety-20261003` `f9348a2` (47 commits).
Machine-readable: `carve-565-plan.json` (same dir). Roles: source, test, docs, staged-sql (forward/reverse, never applied), sql-proof, fixture, runner, workflow.

## 1. Files by carve/area (drift: main/int = file changed there since `8d8d243`)

**C1 drivers + artifact mapping/route** (20 files, +1949/-0)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `server/engineering/native-artifact-repository.ts` | +107/-0 | A | source |  |
| `server/engineering/native-result-executor.ts` | +90/-0 | A | source |  |
| `server/engineering/native-artifact-mapping.ts` | +89/-0 | A | source |  |
| `server/engineering/native-artifact-mapping.test.ts` | +72/-0 | A | test |  |
| `server/engineering/native-private-sql.ts` | +80/-0 | A | source |  |
| `server/engineering/native-private-sql.test.ts` | +86/-0 | A | test |  |
| `server/engineering/native-private-storage.ts` | +125/-0 | A | source |  |
| `server/engineering/native-private-storage.test.ts` | +68/-0 | A | test |  |
| `server/engineering/native-artifact-runtime.ts` | +197/-0 | A | source |  |
| `server/engineering/native-artifact-runtime.test.ts` | +301/-0 | A | test |  |
| `server/engineering/native-artifact-route.ts` | +78/-0 | A | source |  |
| `server/engineering/native-artifact-route.test.ts` | +100/-0 | A | test |  |
| `docs/release/private-artifact-contract.md` | +105/-0 | A | docs |  |
| `docs/release/private-artifact-forward.sql` | +43/-0 | A | staged-sql |  |
| `docs/release/private-artifact-reverse.sql` | +21/-0 | A | staged-sql |  |
| `docs/release/native-artifact-mapping.md` | +83/-0 | A | docs |  |
| `docs/release/native-artifact-mapping-forward.sql` | +174/-0 | A | staged-sql |  |
| `docs/release/native-artifact-mapping-proof.sql` | +36/-0 | A | sql-proof |  |
| `docs/release/native-private-runtime-drivers.md` | +46/-0 | A | docs |  |
| `scripts/test-native-artifact-mapping.mjs` | +48/-0 | A | runner |  |

**C2 result reader + durable finalization** (19 files, +1400/-8)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `server/engineering/native-result-bytes.ts` | +6/-2 | M | source |  |
| `server/engineering/native-result-receipt.ts` | +16/-6 | M | source |  |
| `server/engineering/native-result-finalization.ts` | +136/-0 | A | source |  |
| `server/engineering/native-result-finalization.test.ts` | +183/-0 | A | test |  |
| `server/engineering/native-result-persistence.ts` | +72/-0 | A | source |  |
| `server/engineering/native-result-persistence.test.ts` | +217/-0 | A | test |  |
| `server/engineering/native-result-repository.ts` | +19/-0 | A | source |  |
| `server/engineering/native-result-reader.ts` | +97/-0 | A | source |  |
| `server/engineering/native-result-reader.test.ts` | +47/-0 | A | test |  |
| `server/engineering/native-result-runtime.ts` | +47/-0 | A | source |  |
| `server/engineering/native-result-runtime.test.ts` | +32/-0 | A | test |  |
| `docs/release/ovd-561-finalization-contract.md` | +25/-0 | M | docs | main int |
| `docs/release/ovd561-pending-contract.md` | +133/-0 | A | docs |  |
| `docs/release/ovd561-pending-forward.sql` | +101/-0 | A | staged-sql |  |
| `docs/release/ovd561-pending-reverse.sql` | +16/-0 | A | staged-sql |  |
| `docs/release/native-result-reader-contract.md` | +25/-0 | A | docs |  |
| `docs/release/native-result-reader-forward.sql` | +92/-0 | A | staged-sql |  |
| `docs/release/native-result-reader-reverse.sql` | +5/-0 | A | staged-sql |  |
| `scripts/native-result-reader-proof.py` | +131/-0 | A | runner |  |

**C3 observer-to-stop** (7 files, +1030/-3)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `server/engineering/native-observer-repository.ts` | +91/-0 | A | source |  |
| `server/engineering/native-stop-client.ts` | +35/-0 | A | source |  |
| `server/engineering/native-stop-workflow-store.ts` | +55/-0 | A | source |  |
| `server/engineering/native-stop-workflow.ts` | +125/-0 | A | source |  |
| `server/engineering/native-stop-workflow.test.ts` | +214/-0 | A | test |  |
| `scripts/native/stop-observer/sql/store-native-observer-evidence-replay.staged.sql` | +479/-0 | A | staged-sql |  |
| `scripts/test-ovd575-observer-registry.mjs` | +31/-3 | M | runner |  |

**C4 Windows companion replay + CI** (14 files, +829/-17)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `scripts/native/worker-companion/CompanionOutputReplay.ps1` | +107/-0 | A | source(ps1) |  |
| `scripts/native/worker-companion/CompanionTask.ps1` | +24/-0 | M | source(ps1) |  |
| `scripts/native/worker-companion/README.md` | +28/-3 | M | docs |  |
| `scripts/native/worker-companion/replay-output.ps1` | +34/-0 | A | source(ps1) |  |
| `scripts/native/worker-companion/run-task.ps1` | +23/-10 | M | source(ps1) |  |
| `scripts/native/worker-companion/test-output-replay.ps1` | +141/-0 | A | test |  |
| `scripts/native/worker-companion/test-task.ps1` | +72/-4 | M | test |  |
| `.github/workflows/companion-task.yml` | +7/-0 | M | workflow |  |
| `.github/workflows/companion-inert-qualified.yml` | +43/-0 | A | workflow |  |
| `scripts/native-companion-inert-ci.mjs` | +150/-0 | A | runner |  |
| `scripts/native-companion-inert-ci.node-test.mjs` | +53/-0 | A | test |  |
| `docs/release/native-companion-inert-ci.md` | +52/-0 | A | docs |  |
| `docs/release/ovd-562-companion-lifecycle.md` | +11/-0 | M | docs |  |
| `docs/release/ovd-562-source-work-map.md` | +84/-0 | A | docs |  |

**C5 first-loop composition + Storage probe** (8 files, +281/-26)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `server/engineering/python-json.ts` | +26/-0 | A | source |  |
| `server/engineering/sample-plate-adapter.ts` | +2/-25 | M | source |  |
| `server/engineering/prepared-jev.ts` | +64/-0 | A | source |  |
| `server/engineering/prepared-jev.test.ts` | +111/-0 | A | test |  |
| `server/engineering/prepared-jev-python.ts` | +16/-0 | A | source |  |
| `server/engineering/prepared-jev-python.test.ts` | +34/-0 | A | test |  |
| `server/engineering/dispatch-prepared-request.ts` | +3/-1 | M | source | int |
| `server/engineering/dispatch-prepared-request.test.ts` | +25/-0 | M | test | int **CONFLICT-int** |

**C6 prepared Jev adapter** (8 files, +534/-0)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `server/engineering/native-first-loop-runtime.ts` | +42/-0 | A | source |  |
| `server/engineering/native-first-loop-runtime.test.ts` | +66/-0 | A | test |  |
| `docs/release/native-first-loop-runtime.md` | +56/-0 | A | docs |  |
| `scripts/native-storage-qualification.ts` | +199/-0 | A | runner |  |
| `scripts/native-storage-qualification.test.ts` | +98/-0 | A | test |  |
| `scripts/native-storage-qualification-vitest.config.mjs` | +1/-0 | A | test-config |  |
| `docs/release/native-storage-qualification.md` | +55/-0 | A | docs |  |
| `scripts/native-first-loop-vitest.config.mjs` | +17/-0 | A | test-config |  |

**C7 transport registration binding** (3 files, +277/-3)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `server/engineering/native-artifact-transport.ts` | +30/-3 | M | source | int **CONFLICT-int** |
| `server/engineering/native-artifact-transport.test.ts` | +40/-0 | M | test | int |
| `docs/release/ovd-562-transport-acceptance.md` | +207/-0 | A | docs |  |

**C8 first-loop SQL bridge** (18 files, +1479/-12)

| path | +/- | st | role | drift |
|---|---|---|---|---|
| `scripts/first-loop-authority-baseline.json` | +475/-0 | A | fixture |  |
| `scripts/first-loop-local-sql.mjs` | +211/-0 | A | runner |  |
| `scripts/first-loop-local-sql.node-test.mjs` | +103/-0 | A | test |  |
| `scripts/first-loop-sql-fixture-poststop.sql` | +2/-0 | A | fixture |  |
| `scripts/first-loop-sql-fixture-preclaim.sql` | +4/-0 | A | fixture |  |
| `scripts/first-loop-sql-fixture-registry.sql` | +13/-0 | A | fixture |  |
| `scripts/first-loop-sql-fixture-seed-manifest.sql` | +1/-0 | A | fixture |  |
| `scripts/first-loop-sql-fixture-seed-setup.sql` | +12/-0 | A | fixture |  |
| `scripts/first-loop-sql-fixture.py` | +50/-0 | A | runner |  |
| `scripts/first-loop-sql-fixture.sql` | +105/-0 | A | fixture |  |
| `scripts/first-loop-sql-fixture.test.py` | +43/-0 | A | test |  |
| `scripts/prepare-first-loop-sql-ci.py` | +153/-0 | A | runner |  |
| `scripts/prepare-first-loop-sql-ci.test.py` | +73/-0 | A | test |  |
| `scripts/ovd510-disposable-replay.mjs` | +16/-5 | M | runner | main int **CONFLICT-int** |
| `scripts/ovd561-race-proof.mjs` | +24/-7 | M | runner | main int |
| `.github/workflows/jarvis-sql-source.yml` | +35/-0 | A | workflow |  |
| `docs/release/first-loop-sql-ci.md` | +111/-0 | A | docs |  |
| `docs/release/first-loop-sql-fixture.md` | +48/-0 | A | docs |  |

## 2. Conflict analysis

- `git merge-tree --write-tree origin/main bae69fb` -> exit 0, tree `3aa3109…`: **no conflicts vs main**.
- vs integration `f9348a2` -> exit 1, **3 conflicts**: `scripts/ovd510-disposable-replay.mjs` (integration turned it into a launcher; body moved to `scripts/ovd510-replay-body.mjs`), `server/engineering/dispatch-prepared-request.test.ts` (both append tests at end of the describe), `server/engineering/native-artifact-transport.ts` (integration `TransferBudget` refactor vs checkpoint `transferRegistration` + `structuredClone(scope)` in `upload`).
- Changed on main since base (hand re-base; apply as 3-way patch, never `git checkout bae69fb --`): `docs/release/ovd-561-finalization-contract.md` (OVD-599 role-cleanup para), `scripts/ovd510-disposable-replay.mjs`, `scripts/ovd561-race-proof.mjs` (OVD-599 suffix-role drop). Checking these out from bae69fb would revert main.
- Also changed on integration: the 3 above + `dispatch-prepared-request.ts` (auto-merges), `native-artifact-transport.test.ts` (auto-merges).
- Simulation (temp index + `commit-tree`, no refs): cumulative carves applied 3-way to main all merge cleanly with main; merged with integration, C1–C5 stay clean; C6 adds the dispatch test conflict, C7 the transport conflict, C8 the ovd510 conflict.
- **Migrations: none.** No `supabase/migrations/**` or `supabase/tests/**` in the delta (ownership guards untouched). Latest main `20260928081534`, integration `20261004130000`. The 8 staged stages (`private-artifact`, `native-artifact-mapping`, `ovd561-pending`, `native-result-reader` forward/reverse, observer `*.staged.sql`) stay staged; any later promotion must sort after `20261004130000` and is a protected production apply (out of scope here). C8's `prepare-first-loop-sql-ci.py --canonical` only names CLI migrations inside its output dir.
- Pins found: `test-native-artifact-mapping.mjs` and `first-loop-sql-fixture.py` splice `supabase/tests/engineering_native_ownership.sql` by text marker; all markers still occur exactly once on main and integration. But `prepare-first-loop-sql-ci.py` `BASE=f4f0a087…` is **not on the remote** (bundle-only) and `FIXTURE_SHA`/`fixtureSha256 f2909462…` no longer reproduce (ownership fixture sha: base `cf875b75…`, main = int `977b644c…`). Staged-stage sha256 pins match the checkpoint blobs; OVD-558/560/561 forward-SQL pins (checked) match on main and integration.

## 3. Dependency graph (delta-internal imports; [x]=already on main; *=modified file)

```
leaves: native-artifact-repository, native-result-executor, python-json
mapping -> repository            private-storage -> repository      private-sql -> repository, executor
artifact-runtime -> mapping, repository, transport*, [result-bytes, result-registration]
artifact-route -> artifact-runtime, private-sql, private-storage, executor           (= C1 closure)
result-receipt* -> result-bytes*;  finalization -> receipt*;  persistence -> executor, finalization
result-repository -> executor, finalization, persistence, receipt*
result-reader -> repository, result-bytes*, receipt*, [native-reports]
result-runtime -> repository, executor, reader, result-repository, finalization      (= C2, needs C1)
first-loop-runtime -> route, private-sql, private-storage, mapping, result-runtime, finalization (C5)
scripts/native-storage-qualification.ts -> private-storage, repository               (C5)
observer-repository -> [stop-admission]; stop-client -> observer-repository, [stop-transport]
stop-workflow -> observer-repository, stop-client, stop-workflow-store               (C3, main only)
prepared-jev -> dispatch*;  prepared-jev-python -> dispatch*, prepared-jev, python-json;  sample-plate-adapter* -> python-json (C6)
transport* -> [result-registration, result-bytes] (C7; runtime works with main's transport)
ps1: replay-output/test-output-replay -> CompanionOutputReplay + [Companion*.ps1]; inert-ci runs 4 suites (C4)
ovd510*, ovd561-race-proof* -> first-loop-local-sql (pins 5 staged sha256 from C1/C2/C3)
prepare-first-loop-sql-ci.py -> 8 staged stages (C1,C2,C3 + main), fixture*.{py,sql}, native-result-reader-proof.py, native-result-reader.ts (C8)
```
Order: C1 ∥ C3 ∥ C4 -> C2 (after C1) -> C5 (after C1+C2) -> [integration merges to main] -> C6, C7 -> C8 (after C1–C3 + re-pin decision).

## 4. Carves (all draft PRs, base `main`; each cites #565 + `bae69fb`; #565 closes after C8)

Evidence to preserve (#565 body): 392 inert tests passed at `e5e3db04…` (+ server/Storage tsc, scoped ESLint); independent reviews of the Windows runner, Storage probe, SQL phase adapter. Re-establish per carve by hosted CI on the carve head (count will differ from 392: main/integration grew existing suites). PR body states carve k/8, exact paths, checkpoint commit/tree, “no SQL/Storage/TLS/Windows/native qualification claimed”.

| # | issue title suggestion | files | when | migration |
|---|---|---|---|---|
| 1 | Carve #565 (1/8): private artifact SQL/Storage drivers, mapping writer and artifact route (default-off) | 20 | now | no (staged SQL only) |
| 2 | Carve #565 (2/8): registered result reader, signed-envelope durable finalization and pending persistence | 19 | after C1 | no (staged) |
| 3 | Carve #565 (3/8): observer-to-stop workflow and staged exact observer-evidence replay | 7 | now | no (staged) |
| 4 | Carve #565 (4/8): Windows companion immutable output replay and four-suite inert Windows CI | 14 | now | no |
| 5 | Carve #565 (5/8): first-loop runtime composition, Storage qualification probe and inert suite config | 8 | after C1,C2 | no |
| 6 | Carve #565 (6/8): prepared Jev adapter with deterministic-proposal binding | 8 | after integration on main | no |
| 7 | Carve #565 (7/8): bind artifact registration to the admitted transfer scope | 3 | after integration + C1 | no |
| 8 | Carve #565 (8/8): owned-fixture first-loop SQL bridge and manual source-packet workflow | 18 | after integration + C1–C3 + owner re-pin | no |

- **C1** tests: mapping/private-sql/private-storage/runtime/route `.test.ts` (in default `vitest` include `server/**/*.test.ts`). Main tests at risk: `native-artifact-transport.test.ts`, `native-result-registration.test.ts` (unchanged, composed). Risks: 4 new tests lack `// @vitest-environment node` (main convention for native suites; checkpoint ran them via a node-env config) -> route loopback test may fail under default jsdom; fix = add the pragma only. Sonar CPD may flag the repeated `bounded` helpers (disposition, do not refactor reviewed code). Transport scope-binding hunk deferred to C7 (runtime still re-binds registration to the current subject under locks; route default-off). Evidence: subset of the 392 via hosted `ci` (`npm run test`, lint, typecheck); Storage driver contract is what the Storage-probe review covered.
- **C2** tests: finalization/persistence/reader/runtime. At risk: `native-result-bytes.test.ts`, `native-result-receipt.test.ts` (`produceNativeVerificationReceipt` kept as wrapper over new `produceNativeVerificationEnvelope`). Hand re-base `ovd-561-finalization-contract.md` (3-way). Triggers non-required `native-sql-proofs.yml` (`docs/release/ovd-5*`).
- **C3** tests: `native-stop-workflow.test.ts`; `test-ovd575-observer-registry.mjs --staged-replay` (Docker, manual, not in CI). At risk: `native-stop-transport/admission` tests; integration refactors `native-stop-transport.ts` (merge clean; re-run C3 suite after integration lands). Path `scripts/native/stop-observer/**` triggers Windows `stop-observer.yml` + `companion-task.yml` on the PR head.
- **C4** tests: `test-output-replay.ps1`, `test-task.ps1`, `native-companion-inert-ci.node-test.mjs`. New `companion-inert-qualified.yml` (windows-2022, `pull_request` on `scripts/native/**`, uploads receipt) re-establishes the **Windows-runner** evidence on the carve head; it will run on every later `scripts/native/**` PR (cost; non-required). Also triggers `companion-task`, `companion-artifact` (README), `stop-observer`.
- **C5** tests: `native-first-loop-runtime.test.ts`; `scripts/native-storage-qualification.test.ts` is outside default vitest include and `tsconfig.server` -> hosted CI does not run it; record the two commands from `native-storage-qualification.md` (Storage-probe evidence). `scripts/native-first-loop-vitest.config.mjs` re-runs the full inert suite set (392 analogue) with one command.
- **C6** conflict in `dispatch-prepared-request.test.ts`; `dispatch-prepared-request.ts` auto-merges beside integration `checkDeadline()`. Adds required `deterministicProposal` to `PreparedAdapter` input (only caller is dispatch). `pythonJson` moves to `python-json.ts` with re-export (`scripts/vite-sample-plate-plugin.ts`, sample-plate tests). Land after integration; fallback: place the 2 new tests outside the integration-touched end of the describe and prove `merge-tree` clean.
- **C7** hand-port onto integration's budget version: keep `TransferBudget`, add `transferRegistration()` and `structuredClone(scope)`; wrap order = budget-bounded wrapper around `transferRegistration(runtime.registration, scope, transfer)`. Test file auto-merges. Carries `ovd-562-transport-acceptance.md` (umbrella command listing C1–C7 suites).
- **C8** blockers (owner decision): `BASE f4f0a087…` exists only in the retained bundle; `FIXTURE_SHA` must be regenerated against current `engineering_native_ownership.sql`; ovd510 hunks must move into `scripts/ovd510-replay-body.mjs`, and the packet builder's `scripts/ovd510-*` / `BASE` special-casing updated. Either push the bundle history to a preservation ref or re-pin + fresh independent **SQL-phase-adapter** review. Triggers `native-sql-proofs.yml`; `jarvis-sql-source.yml` is `workflow_dispatch` default-off.

## 5. Carve 1 unit spec (ready to run; full text also in JSON `units[0]`)

```json
{"units":[{"key":"CARVE565-1-DRIVERS","issue":"<to be created>","branch":"claude/carve565-1-drivers-artifact-route","base":"main","lockfile_family":"main","spec_file":"/tmp/claude-0/-home-user-Overdrafter/b20cace5-8784-51f8-a7b4-1ed188995a77/scratchpad/run/specs/carve-565-plan.json","model":"opus","effort":"high","review_model":"opus","review_effort":"xhigh","context":"see carve-565-plan.json units[0].context (20 paths = C1 table above; git checkout bae69fbf09a05b83bf60fd46c40985c86a83849b -- <paths>; all status A, untouched by main/integration; exclude transport; keep default-off; lint/typecheck/vitest(+node pragma only if jsdom-only failure)/mapping generator/npm run verify; merge-tree vs integration exit 0; DRAFT PR 'OVD-<n>: Carve private artifact SQL/Storage drivers, mapping writer and artifact route from #565' per template, carve 1 of 8, checkpoint commit+tree, no release-parent IDs)"}]}
```
