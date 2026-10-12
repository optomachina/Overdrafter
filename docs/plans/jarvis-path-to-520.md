# Jarvis path to OVD-520: evidence map and remaining units

Audit date: October 12, 2026. Source revision: `origin/main` at
`e0ffe743dbb57c0363bc21eb757ffff93e87fd5d`. Open PR heads read: #619 at
`cf3a9738`, #620 at `a5dc0460`, #621 at `6a823de4`. #565 is closed and was read
at `bae69fbf` with its carve plan on branch `claude/serene-cori-4bfhx4`
(`handoff/2026-10-08-fable-coordinator/run/specs/carve-565-plan.md`).

This is a planning document. It writes no code, SQL or migration, changes no
Linear issue, and grants no protected action. Every unit below still needs its
own Linear issue, owner and gates under `AGENTS.md`.

## Goal and constraints

OVD-520 is one verified 7 mm request from a phone to a native SolidWorks result,
behind an admin flag, by November 13 (flag on may follow up to a week later).
Jarvis must never sit on the production critical path for quoting.

Planned order from `docs/plans/beta-launch-plan.md`: #619 (OVD-651) and #620
(OVD-649) apply in migration window 2 after OVD-206 (about November 9), then
OVD-511, OVD-505, OVD-563, then one Windows host session for #621 (OVD-650) and
the OVD-520 run.

## Status snapshot (Linear, read only)

| Issue | Status | Role on this path |
| --- | --- | --- |
| OVD-520 | In Progress | Connected run milestone |
| OVD-511 | Backlog | Outcome parent for 560 and 561 |
| OVD-505 | Blocked (by 503, 509, 510, 511) | Outcome parent for durable finalization |
| OVD-503, 509, 510, 518, 519, 560, 561, 562, 563 | Done | Predecessors |
| OVD-613, 626, 627 | Done | Staged SQL proof CI, failed attempt proof, identity proof |
| OVD-737 | Backlog | OVD-558 reverse lock and isolation guard, due before window 2 |
| OVD-651 (#619) | Blocked | Carve 2, waits for Blaine's yes with window 2 |
| OVD-649 (#620) | In Progress | Carve 3 |
| OVD-650 (#621) | Blocked, draft | Carve 4 |
| OVD-507 | Backlog | Not on this path (GLB and portable review are later work) |

Note: OVD-503 is Done, so of OVD-505's four blockers only OVD-511 remains open.

## How to read the evidence

"Staged proof" means a SQL assertion in a `docs/release/*-proof.sql` file that the
non required workflow `.github/workflows/native-sql-proofs.yml` runs on a
disposable database through
`node scripts/ovd510-disposable-replay.mjs --reviewed-authority-baseline --durable-migration --ovd563`.
It is synthetic SQL evidence, not hosted, Windows or native evidence. The staged
SQL (OVD-558, 560, 561, 563 and the #619 and #620 files) is not in
`supabase/migrations/`; it reaches a hosted database only through a migration
window.

## Evidence map: OVD-511

| # | Acceptance criterion | Evidence | Verdict |
| --- | --- | --- | --- |
| 1 | Registered bytes and all seven checks produce one immutable unadopted candidate with predecessor lineage | `docs/release/ovd-560-result-registry-proof.sql` ("registered exact successful attempt and private object", "registration cannot be rewritten"); `docs/release/ovd-561-finalization-proof.sql` ("valid signed result finalizes", "snapshot preserves exact verified context bytes"); `server/engineering/native-result-receipt.test.ts` (receipt only after all seven registered objects pass); `server/engineering/native-reports.test.ts` ("accepts all seven checks backed by complete bound synthetic observations") | Met in staged source |
| 2 | Public API and worker roles cannot issue receipts or mutate candidate or successor state | 561 proof: "verifier cannot finalize", "service role cannot finalize", "gateway cannot provision or read key", "verifier cannot read signing key", "forged signature denied"; 560 proof: "verifier cannot invoke registration helper" | Met in staged source |
| 3 | Snapshot, receipt, successor admission, task verification and event commit together or roll back | 561 proof: "injected final write failure", "late failure rolls back transaction", "no partial snapshot", "no partial successor admission", "no partial task completion" | Partial gap: `ovd-561-finalization-forward.sql` writes `native_finalizations`, `engineering_snapshots` and `native_input_admissions` but no `engineering_events` row, and no assertion names an event. See decision D3 |
| 4 | Wrong scope, stale fence, cancellation, revocation, changed admission and expiry after lock waits prevent advancement | `scripts/ovd561-race-proof.mjs` scenarios `lockwait_admission_revocation`, `lockwait_worker_revocation`, `lockwait_cancellation`, `lockwait_current_attempt_fence`, `lockwait_storage_substitution`, `lockwait_receipt_expiry`, `lockwait_deadline`, `repeatable_read_rejected`; 561 proof "foreign task denied", "stale fence denied" | Met in staged source |
| 5 | Exact replay and a lost completion response recover the original outcome without extra reads, CAD runs or snapshots; changed replay conflicts | 561 proof: "exact replay returns original receipt", "one completion after replay", "changed idempotency key conflicts", "changed candidate bytes denied"; race proof `concurrent_exact_replay`. Replay that reloads the stored envelope with no new object read is `server/engineering/native-result-finalization.ts` and `native-result-persistence.ts` in #619 | Met only after #619 merges |
| 6 | Completion never releases a newer attempt's native occupancy | race proof `newer_occupancy_preserved`; 561 proof "no early successor release", "only verified completion releases successor" | Met in staged source |
| 7 | Missing preview stays unavailable; failed evidence retained; successor blocked | `docs/release/ovd-520-staged-proof.sql` (OVD-626): "failed attempt cannot register result objects", "failed attempt cannot finalize", "failed predecessor keeps the third change blocked", "failed change exposes no geometry"; 563 proof "missing STEP is unavailable for the verified candidate"; `server/engineering/native-preview-bytes.test.ts` ("returns exact unavailable state without fetching or implying native failure") | Met in staged source |
| 8 | Current head disposable PostgreSQL, RLS and race tests and repo checks pass; migration and rollback documented | `native-sql-proofs.yml` green on #621 head (run 38086609037) and on #619 at `7d5e493` (run 38200452036); contracts `docs/release/ovd-560-result-registry-contract.md`, `ovd-561-finalization-contract.md`; #619 body gives the window 2 order and reverse order | Met, with two open items: the OVD-558 reverse lacks the lock first and READ COMMITTED guard (OVD-737), and #619 notes that the race proof uses stub tables, so a full canonical chain replay is still owed (unit U3) |

OVD-511 can close once #619 merges and D3 is decided. Production apply is not an
OVD-511 criterion ("Production activation remains separate").

## Evidence map: OVD-505

| # | Acceptance criterion | Evidence | Verdict |
| --- | --- | --- | --- |
| 1 | Valid evidence and stored bytes produce exactly one verified unadopted successor with exact lineage | Same as 511 row 1; `server/engineering/native-result-bytes.test.ts` ("measures the three actual retained native files and verifies all reports") | Met in staged source |
| 2 | All seven checks supported by validated stored reports; missing, failed, contradictory, duplicate or foreign evidence blocks | `native-reports.test.ts`: "rejects every omitted native predicate even when the worker recomputes its evidence digest", "rejects duplicate JSON fields instead of accepting the last value", "rejects matching but incorrect summary measurements", "requires the correct evidence role for each mandatory check", "rejects a missing preservation observation"; `native-result-bytes.test.ts` `requires the complete seven-object set` | Met |
| 3 | Truncated, oversized, changed, missing or path substituted objects fail before advancement | `native-result-bytes.test.ts`: "rejects truncated streams rather than trusting Content-Length", "rejects data beyond registered size while streaming"; `native-reports.test.ts` "rejects changed report bytes when the claimed digest is unchanged", "rejects traversal in an admitted path rather than resolving it"; race proof `lockwait_storage_substitution` | Met |
| 4 | Wrong tenant, worker, runtime, attempt, fence, input, snapshot, configuration or revoked admission rejected without leaking | 560 proof `cross-tenant registration rejects`, "foreign tenant verifier cannot read registered object"; `native-artifact-transport.test.ts` "rejects wrong tenant, session, fence, predecessor and worker without object reads"; race proof revocation scenarios; 563 proof and OVD-614 peer and revoked owner denials | Met |
| 5 | Failed, canceled, superseded, uncertain and late attempts cannot advance or free occupancy | OVD-626 segment of `ovd-520-staged-proof.sql`; race proof `lockwait_cancellation`, `newer_occupancy_preserved`; 561 proof "completed attempt cannot register more results"; `native-stop-admission.test.ts` ("preserves stopped but ineligible outcomes without granting result verification") | Met |
| 6 | Concurrent finalizations and cancellation or revocation races have one outcome; exact replay returns the original receipt | race proof `concurrent_exact_replay` and lock wait scenarios | Met |
| 7 | Queued successor stays blocked until receipt and input admission commit atomically | 561 proof "no early successor release", "no partial successor admission"; OVD-626 "third change cannot claim behind a failed predecessor" | Met |
| 8 | Crash before, during or after verification or commit is recoverable; retry repeats delivery without CAD rerun or duplicate snapshot | `native-artifact-transport.test.ts` "measures and registers one immutable output; lost reply replays the same bytes"; 561 replay assertions; durable pending envelope in #619 (`ovd561-pending-forward.sql`); companion output replay in #621 (`CompanionOutputReplay.ps1`, `test-output-replay.ps1`) | Met only after #619 and #621 merge |
| 9 | Preview identity exact when supplied; unavailable preview explicit; old geometry never attached to a newer result | `native-preview-bytes.test.ts` "does not use an earlier valid export for a later candidate"; `native-step-review.test.ts` "leaves an absent export unavailable without writing", "rejects stale or substituted evidence before writing"; 563 proof "stale candidate snapshot rejected", "unverified successor has no current geometry" | Met |
| 10 | Real local database, RLS and race tests, stored byte integration tests, regressions, full checks and review pass | `native-sql-proofs.yml`; `ci.yml` on main; reviews recorded on #614, #619, #620 | Met for merged source; #619 and #620 still need their merge gates |
| 11 | Additive migration, lock order, authorization, policy and rollback documented; no production activation added | 560, 561, 563 contracts; `docs/release/private-artifact-contract.md`; `docs/release/native-private-runtime-drivers.md`; #619 and #620 apply and rollback sections | Met, with OVD-737 open |

OVD-505 can move from Blocked once OVD-511 closes. Its own text keeps native
qualification separate, so it does not wait for the Windows run.

## Evidence map: OVD-520

| # | Acceptance criterion | Evidence | Verdict |
| --- | --- | --- | --- |
| 1 | One request identity links interpretation, predecessor, attempt, filesystem and process evidence, all seven checks, candidate and preview | OVD-627 segment of `ovd-520-staged-proof.sql`: "review task traces to its original intake message", "interpretation digest binds the message body", "review attempt is the finalized attempt", "review candidate is the attempt output snapshot", "finalized receipt binds the attempt job", "attempt job depth is the decision depth" | Gap. The SQL chain is synthetic, and its fixture resolves the 7 mm message as 8 mm (OVD-627 scope note). Filesystem and process identities exist only in the real run. Closed by U11 and U12 |
| 2 | Browser closure does not lose the request; phone and desktop show truthful execution versus verification states | Durable inbox `supabase/migrations/20260910045917_engineering_durable_inbox.sql`; `src/features/engineering/EngineeringTaskStatus.tsx` and its test (separate execution and verification labels); `src/features/engineering/EngineeringStepReview.tsx` | Gap. `/engineering` renders only when `import.meta.env.DEV` is true, `VITE_ENABLE_ENGINEERING_WORKBENCH` is `1` and the host is loopback (`src/App.tsx:49`, `src/lib/engineering-workbench-access.ts`). A phone cannot reach it, and there is no admin flag in a hosted build. Closed by U7 |
| 3 | Source unchanged; fixed companion unchanged; preview matches that run | `native-reports.test.ts` "rejects copying into the original package"; 563 proof "read digest binds exact bytes", `substituted finalized-result binding rejected at read`; `docs/jarvis-bounded-restart.md` forbids splicing the retained 5 to 8 mm run with the retained 7 mm export | Gap until the real run (U11) |
| 4 | Failure blocks successor advancement; no automatic CAD retry | OVD-626 segment of `ovd-520-staged-proof.sql`; OVD-600 pin; `docs/release/ovd-562-companion-lifecycle.md` rule 5 | Met in staged source; confirm in the real run |
| 5 | Short recording and exact source evidence distinguish simulation, replay and real native execution | None | Gap. Closed by U11 and U12 |

The OVD-520 testing section also asks for targeted stale result and tenant
denial regressions. These already exist as staged proofs (563 "stale candidate
snapshot rejected", OVD-614 peer and revoked owner denials) and only need to be
cited at the run's source revision.

## Gaps found beyond the acceptance tables

These surfaced while tracing what the run actually needs on main.

1. **No hosted entry for the artifact route or finalization.**
   `createNativeArtifactRoute` and the #619 runtime are not mounted anywhere; no
   file under `supabase/functions/` imports them. The design expects a trusted
   Node host with a dedicated owner pool, HTTPS termination, a private output
   bucket and the receipt signing key. Carve 5 of #565
   (`server/engineering/native-first-loop-runtime.ts`) composes these but opens
   no listener.
2. **Interpretation has no adapter.**
   `supabase/functions/engineering-interpretation/index.ts` sets
   `adapter: unavailableAdapter` and returns 503 even when enabled. Carve 6 of
   #565 (prepared Jev adapter) or another bounded adapter is needed.
3. **Carves 5 to 8 of #565 have no Linear issues.** Carve 5 (first loop runtime
   composition and Storage probe), carve 6 (prepared Jev adapter), carve 7
   (transport registration binding) and carve 8 (first loop SQL bridge) are
   only in the carve plan. None of their files are on main.
4. **The window 2 apply list in #619 omits carve 1 SQL.**
   `docs/release/private-artifact-forward.sql` and
   `docs/release/native-artifact-mapping-forward.sql` merged with #614 but are
   staged only, and the mapping writer and artifact route need them. They are
   not in #619's six step order.
5. **#621 hosted CI is red on its head** because the
   `free-quote-sql-qualification / free-quote-sql` job failed (run 38086609225).
   Its Windows inert jobs passed on GitHub runners at `6a823de4`
   (`windows-desktop-inert`, `inert-windows-observer`, the two
   `inert-protocol` jobs). The red job is outside the 14 carved paths, so it
   should be checked against main before any code change.
6. **No event row in finalization** (511 row 3, decision D3).

## Remaining units, in order

Sizes: S is under a day of agent work with one review, M is one to two days,
L is more than two days or a human session. "Window" means the unit's SQL can
only reach a hosted database in a migration window. "Prod path" flags anything
that could touch the quoting release.

| ID | Unit | Files likely touched | Migration and window | Windows host | Size | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Finish #619 (OVD-651) gates and merge on Blaine's yes | as in #619 | Staged SQL, applied in window 2 | No | existing | none |
| P2 | Finish #620 (OVD-649) gates and merge | as in #620 | Staged SQL, applied in window 2 | No | existing | none |
| U1 | OVD-737: OVD-558 reverse takes the table lock first and refuses anything but READ COMMITTED | `scripts/ovd510-generate-migration-sql.mjs`, `docs/release/ovd-558-verifier-authority-reverse.sql` and its pin | Staged SQL only; must land before window 2 | No | S | none |
| U2 | Close out #621 (OVD-650): check the free quote SQL failure against main, merge main if base is green, finish review gates | none in the carve; a main merge commit | No | No (GitHub runners) | S | none |
| U3 | Window 2 Jarvis packet and full chain rehearsal: one ordered forward and reverse list covering private artifact, artifact mapping, OVD-558, 560, 561, 561 pending, result reader, 563 and the #620 replay; replay it on a disposable stack over the complete `supabase/migrations/` chain and attach the OVD-602 inventory diff | new `docs/release/jarvis-window-2-packet.md`; reuse `scripts/ovd510-disposable-replay.mjs` | It is the window content; rehearsal is disposable only | No | M | U1, P1, P2 |
| U4 | Carve 5: first loop runtime composition and Storage version probe | `server/engineering/native-first-loop-runtime.ts` and test, `docs/release/native-first-loop-runtime.md`, `scripts/native-storage-qualification.ts` and test and vitest config, `docs/release/native-storage-qualification.md`, `scripts/native-first-loop-vitest.config.mjs` | No | No | M | P1 |
| U5 | Carve 7: transport registration binding, hand ported onto main's `TransferBudget` | `server/engineering/native-artifact-transport.ts` and test, `docs/release/ovd-562-transport-acceptance.md` | No | No | S | none |
| U6 | Interpretation adapter for the one depth request (carve 6 prepared Jev adapter, or a deterministic adapter if D2 says so) | `server/engineering/prepared-jev.ts`, `prepared-jev-python.ts`, `python-json.ts`, `sample-plate-adapter.ts`, `dispatch-prepared-request.ts` and tests; possibly `supabase/functions/engineering-interpretation/index.ts` | No | No | M | D2 |
| U7 | Admin flagged `/engineering` in the hosted build, lazy loaded, off by default, with a server side allowlist check | `src/App.tsx`, `src/lib/engineering-workbench-access.ts` and test, an e2e check that quote routes and the main bundle are unchanged with the flag off | No | No | M | none |
| U8 | Trusted host launcher: mount `artifactRoute` at `/functions/v1/engineering-worker-artifact` behind HTTPS and expose `prepareInputs`, `admitResult`, `finalize` and `replay` only to the operator | new launcher under `scripts/` or `server/engineering/`, operator doc | No | No | M | U4, U5, D1 |
| U9 | Carve 8: first loop SQL bridge, only if U3 does not already cover its fixture (owner decision on Option B re pin) | `scripts/first-loop-*`, `scripts/prepare-first-loop-sql-ci.py`, `.github/workflows/jarvis-sql-source.yml`, `scripts/ovd510-replay-body.mjs`, `scripts/ovd561-race-proof.mjs`, docs | No migration, but adds a workflow | No | M | U3, U4 |
| U10 | Activation packet for the run: window 2 apply order, edge function flags (`ENGINEERING_WORKER_GATEWAY_ENABLED`, `ENGINEERING_WORKER_TASK_ENABLED`, `ENGINEERING_WORKER_STOP_ENABLED` with executor URL and token, `ENGINEERING_INTERPRETATION_ENABLED`), private bucket, signing key and owner pool provisioning, companion pairing, rollback | new `docs/release/jarvis-ovd520-activation-packet.md` | Describes window 2; executes nothing | No | S to write | U3, U6, U7, U8 |
| W2 | Migration window 2 apply (Blaine) | none | Yes, window 2 | No | Blaine session | U3, U10, OVD-206 |
| U11 | Windows session: fresh exact source qualification (Desktop 5.1 x64, SolidWorks 2022 SP5, store, stop observer, companion), then the single 7 mm run from the phone with a short recording | none in repo; evidence retained | Needs W2 | Yes | L | W2, U2, U8 |
| U12 | Run evidence record: one identity table from message to STEP digest, the seven checks, filesystem and process identities, labels separating simulation, replay and real execution, and the stale result and tenant denial citations | new `docs/release/ovd-520-run-evidence.md` | No | No | S | U11 |

Parallel lanes: U1, U2, U5 and U7 can start now. U4 starts when #619 merges. U6
starts when D2 is answered. U3 starts after U1, P1 and P2.

## Production critical path flags

- **U7 touches the production app bundle.** It is the only unit that changes
  code every quoting user loads. Keep the page lazy loaded, keep the flag off by
  default, check access on the server, and prove with a browser test that quote
  routes behave the same with the flag off. It also touches auth and permission
  gating, so it gets Opus review under the sensitive path list.
- **W2 shares the window with quoting work.** If any Jarvis statement fails, the
  window must be able to stop or reverse the Jarvis set without touching quoting
  migrations. U3 should make the Jarvis set its own section with its own reverse
  order. U1 must land first.
- **U10 sets edge function flags in the hosted project.** Those functions are
  engineering only, but flag changes in the hosted project are a protected
  action and need Blaine's yes.
- **U6 path names match "dispatch"** in the sensitive list
  (`dispatch-prepared-request.ts`), so it gets Opus review even though it is not
  provider dispatch.
- **U8 handles real credentials** (owner pool, signing key, Storage
  authorization). The launcher must take them from operator supplied
  configuration and never commit or log them.
- Nothing in this plan changes `supabase/migrations/` or quoting code paths other
  than U7.

## Decisions that need Blaine

- **D1. Where the trusted host runs** for U8 (the owner Mac or the Windows
  workstation), and approval to provision its owner database pool, signing key
  and Storage authorization for the hosted project.
- **D2. Interpretation for the run.** Either carve 6 with the prepared Jev
  helper, or a deterministic adapter limited to "set depth to N mm" for this one
  run. The second is smaller and avoids a model credential.
- **D3. Event row on finalization.** Either accept the `native_finalizations`
  row and task state as the event record for OVD-511, or add a staged SQL change
  that writes `engineering_events` (new window 2 content, so it must land before
  U3).
- **D4. Carve 8 Option B** (re pin and fresh SQL phase adapter review) or drop
  carve 8 if U3's rehearsal covers the first loop fixture.
- **D5. Window 2 timing.** It follows OVD-206 (Blocked, due November 6). If
  window 2 lands on November 9, U11 has four days before November 13. A slip in
  OVD-206 moves OVD-520 one for one. The fallback is the stated week of grace
  for flag on, not a separate Jarvis only window, unless Blaine chooses one.

## Open risks

- The race proofs for #619 use stub tables; only U3 proves the set on the real
  migration chain.
- The OVD-627 fixture resolves the 7 mm message as 8 mm. The real run must show
  7 mm end to end, or it will look like the identity chain is wrong.
- The retained native fixtures prove a 5 to 8 mm run and separate 9 mm and 7 mm
  exports. They cannot stand in for the run (see `docs/jarvis-bounded-restart.md`).
- Storage version id qualification against the hosted provider has never run
  (`docs/release/native-private-runtime-drivers.md`). U8 cannot set
  `storageVersionIdQualified` until it does.
- #621's earlier Windows startup failure (run 37844185261) was diagnosed under
  OVD-657, and the latest head passed on GitHub runners. The owner workstation
  has not been qualified at any current head.
