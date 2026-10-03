# OVD-562 source transport acceptance

This is a source qualification checklist, not activation authority. It repairs
the original one-job lifecycle acceptance: task startup must let the owner
enable its new boot without racing an immediate exit. No worker, paired store,
hosted service, credential, existing SolidWorks instance or CAD file is changed
by this source work. The stalled quoting/release task is independent.

## Exact chain and missing boundaries

| Boundary | Implementation | Remaining requirement |
| --- | --- | --- |
| Authenticated request | `engineering-inbox-client.ts` → `api_submit_engineering_message`, checking user/project/revision/idempotency | Hosted auth/migration proof; intake receipt is not a native task |
| Request → task | `dispatch-prepared-request.ts`, ordered-change SQL; `prepared-jev.ts` and `prepared-jev-python.ts` reuse the existing typed helper protocol | Concrete trusted Node composition exists; external helper and persistence callbacks need qualification. Hosted Edge still selects unavailable adapter and remains disabled |
| Worker identity/session | `run.ps1` → `engineering-worker` → fixed pair/boot/session RPCs | Installed/paired/enabled/deployed state remains unknown; session loop never dispatches CAD |
| Exact one-job claim | `run-task.ps1` → `CompanionTask.ps1` → `engineering-worker-task` → native ownership RPCs | Exact qualified runtime/input admissions and explicitly enabled fresh boot |
| Three inputs/seven outputs | `CompanionArtifact.ps1` → fixed `engineering-worker-artifact` URL; `native-artifact-runtime.ts`/`native-artifact-repository.ts` supply exact SQL/mapping/conditional-storage operations | Concrete preclaim mapping writer, SQL/Storage drivers and Node route now exist through `native-first-loop-runtime.ts`. Mapping SQL is staged only; real provider/SQL/proxy configuration and qualification remain unrun |
| Runner/effect authority | Pinned `CompanionRuntime`/bootstrap, detached host, prepared-dimension runner, nonce/index authority pipe | Real Windows process/COM qualification; zero existing SolidWorks processes |
| Stop | `native-stop-workflow.ts` stages canonical bytes → `native-observer-repository.ts` invokes OVD-575 → `native-stop-client.ts` submits exact OVD-577 request | Source bridge and exact replay exist; independently attributed validator/profile, per-evidence qualification, staged replay SQL and connected endpoint require qualification. Companion does not mint stop authority |
| Result/head advance | `native-result-finalization.ts` → `native-result-repository.ts`/`native-result-persistence.ts`/`native-result-executor.ts` → existing OVD-561 transaction | Durable pending SQL is staged, unrun. Concrete registered-byte reader and internal runtime now exist. Actual owner pool, independent filesystem admission, signing-key provisioning and connected atomicity remain unqualified; upload/exit/stop is not verification |

`reconcile-task.ps1` only replays uncertain claim/heartbeat requests. The added
`replay-output.ps1` separately replays the exact retained output set. The runner
first freezes all seven spools and an immutable descriptor, without a network
roundtrip. It then awaits independent stop admission: OVD-560 registration
requires `awaiting_result`, `result_eligible` and `stop_admission_id`. Only after
that admission can output replay/register succeed. Never rerun CAD to recover a
lost upload response. An interrupted freeze before descriptor publication stays
recovery-required; no partial set has been sent. Adapter implementation gaps
remain separate from operator-only qualification of existing code.

## Source repair and acceptance

Previously, `run-task.ps1` created a new boot, clearing the previous session,
then checked eligibility once and ordinarily exited `owner_enablement_required`.
The repaired path preserves fresh boot registration and the existing-task guard,
publishes the new boot identity, and waits only for authenticated owner enablement.
The wait uses a monotonic 0..300-second budget and never sends boot, enable or
claim mutations. Only `owner_enablement_required` can be polled again. Timeout
returns no eligibility; late enabled responses are rejected. SQL still rechecks
current authority atomically at claim.

`test-task.ps1` covers pending→enabled, timeout/no extra read, immediate mode,
pause/expiry/boot mismatch, foreign boot, transport failure and a late enabled
response. It also composes real startup, wait and claim helpers using an inert
server that clears enablement on boot and simulates a separate owner action.
Its single success JSON now follows every assertion, including the pre-existing
deadline/replacement checks that previously ran after its success receipt.

## Repeatable source checks

Use the existing toolchain only. Do not install missing runtimes. Record Git
HEAD, dirty state, timestamp, tool versions, exact command, direct exit code,
stdout/stderr and SHA-256 of retained evidence. Missing tools, skipped checks,
timeouts, malformed receipts and stale evidence are not passes.

From the repository root, Node regression command (installed dependencies;
synthetic injected adapters, exclusively owned disposable local fixtures and
existing loopback HTTP coverage; no real endpoint, credentials or provider):

```sh
./node_modules/.bin/vitest run --config scripts/native-first-loop-vitest.config.mjs \
  server/engineering/dispatch-prepared-request.test.ts \
  server/engineering/prepared-jev.test.ts \
  server/engineering/prepared-jev-python.test.ts \
  server/engineering/sample-plate.test.ts \
  server/engineering/native-artifact-runtime.test.ts \
  server/engineering/native-artifact-mapping.test.ts \
  server/engineering/native-artifact-route.test.ts \
  server/engineering/native-private-sql.test.ts \
  server/engineering/native-private-storage.test.ts \
  server/engineering/native-artifact-transport.test.ts \
  server/engineering/native-stop-transport.test.ts \
  server/engineering/native-stop-admission.test.ts \
  server/engineering/native-stop-workflow.test.ts \
  server/engineering/native-result-registration.test.ts \
  server/engineering/native-result-bytes.test.ts \
  server/engineering/native-result-receipt.test.ts \
  server/engineering/native-result-finalization.test.ts \
  server/engineering/native-result-persistence.test.ts \
  server/engineering/native-result-reader.test.ts \
  server/engineering/native-result-runtime.test.ts \
  server/engineering/native-first-loop-runtime.test.ts
```

On an existing x64 Desktop PowerShell 5.1 host (or Core 7.5+ for portable
state/boundary/task checks), run each allowlisted script in a fresh process.
Do not glob-execute neighboring scripts. Capture the child exit immediately;
a shell wrapper's successful exit or an early `passed` string is insufficient.
For the repaired task suite, this small acceptance runner requires one JSON
receipt and the direct child exit together:

```powershell
$raw = & powershell.exe -NoProfile -NonInteractive -File scripts/native/worker-companion/test-task.ps1
$childExit = $LASTEXITCODE
if ($childExit -ne 0) { throw 'Task source suite failed; retain stdout/stderr.' }
$receipt = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
if ($receipt.schema -cne 'overdrafter.companion-task-test.v1' -or
    $receipt.passed -ne $true -or $receipt.assertions -le 0 -or
    $receipt.nativeActions -ne 0 -or $receipt.network -ne $false) {
    throw 'Task source receipt failed acceptance.'
}
$receipt
```

For each remaining script, use
`powershell.exe -NoProfile -NonInteractive -File <path>` and retain the direct
exit plus complete output. Every row requires exit zero and `passed=true`:

| Path under `scripts/native/worker-companion/` | Expected schema | Coverage limit |
| --- | --- | --- |
| `test-state.ps1` | `overdrafter.companion-state-test.v1` | In-memory protocol; no DPAPI proof |
| `test-boundaries.ps1` | `overdrafter.companion-boundary-test.v1` | Byte/deadline/default-off refusal boundaries |
| `test-artifact.ps1` | `overdrafter.companion-artifact-test.v1` | Desktop must report `disk=true`; Core `disk=false` omits Windows spool/ACL checks |
| `test-task-deadline.ps1` | `overdrafter.companion-task-deadline-test.v1` | Consumed budget denied before native setup |
| `test-output-replay.ps1` | `overdrafter.companion-output-replay-test.v1` | Exact retained-set replay and default-off refusal; Desktop includes disposable local disk fixture, no actual paired state |
| `test-anonymous-pipe.ps1` | `overdrafter.anonymous-pipe-proof.v1` | Inert inherited-handle roundtrip |
| `test-effect-authority.ps1` | `overdrafter.native-effect-authority-test.v1` | Inert one-use authority checks |
| `test-runner-effect-gate.ps1` | `overdrafter.runner-effect-gate-test.v1` | Three inert gate cases |
| `test-runtime.ps1` | `overdrafter.companion-runtime-test.v1` | Requires existing vswhere/standalone Roslyn; `nativeQualification=false` remains mandatory |

The Desktop suites create only disposable synthetic local resources. They do
not qualify SolidWorks execution. Existing OVD-500 DPAPI/ACL evidence is already
retained; do not repeat that foundation merely to fill a checklist. CI paths
are `.github/workflows/companion-task.yml` and `companion-artifact.yml`.

## Later authorized operator inputs and outcomes

Do not execute the connected path under this source task. Before any future
native run, require separate exact-operation authorization, completed adapter
wiring, admitted disposable runtime/package, pinned source/profile/compiler,
and **zero existing SolidWorks processes**. The two reported preserved instances
fail that precondition. Do not close/adopt them or bypass the guard. AccessDenied
on installation/pairing inspection is unknown state, not absence.

Future `run-task.ps1` inputs are both explicit `-Connect -ExecuteOne` switches;
exact WorkerId/GatewayUrl/TaskId/RuntimeAdmissionId/InputAdmissionId/TaskRevision;
three distinct opaque InputArtifactIds in admitted `inputFiles` order;
nonexistent local PackageRoot and existing private, disjoint OutputRoot;
RuntimeProfilePath and SHA-256; optional reviewed 40-character lowercase
SourceCommit; EnablementWaitSeconds 0..300 (default 300). Never put tokens,
pairing codes, customer paths or credentials in a command/evidence packet.

After separately admitted stop, the future output-replay command requires both
`-Connect -ReplayOutput` and the same WorkerId, TaskId, AttemptId, Fence and
GatewayUrl. It accepts no candidate path, replacement bytes, new boot or new
attempt. `outputs_delivered` with `deliveredRoles=7` still reports
`nativeExecutionAttempted=false` and `resultEligible=false`: delivery is not
verification or a local assertion of qualified stop. Missing/altered descriptor,
missing/changed spool, foreign attempt/fence/session or a refused transfer must
fail closed and preserve the retained set.

| Observable result | Meaning/action |
| --- | --- |
| Missing switches: `Default-off: explicit -Connect and -ExecuteOne are required.` | Expected refusal; no native qualification |
| `awaiting_owner_enablement`, worker/task/boot IDs, `nativeExecutionAttempted=false` | Owner must explicitly enable exactly this new boot; no parallel session companion/store access |
| `ineligible / owner_enablement_timeout` | No task claim or native launch; process cannot reuse the boot on restart |
| `ineligible`, paused/expired/boot_mismatch | No claim; no automatic enablement or fallback |
| Existing task: `recoveryRequired=true`, `nativeExecutionAttempted=false` | Reconciliation only; never automatic native restart |
| `recovery_required`, exit 1 | Preserve encrypted state, request keys, journal and occupancy; generic filtered detail intentionally omits backend exceptions |
| `awaiting_stop_admission`, `stopAdmissionPending=true`, `resultEligible=false` | Runner completion is not stop admission/finalization, even with exit zero |
| HTTP 503 `gateway_disabled` / `task_disabled` / `transfer_disabled` / `stop_disabled` | Default-off source handler behavior, not deployed availability proof |
| `An existing native process prevents this job.` | Native precondition failed; preserve every existing instance |

Qualification must retain exact job/context/input hashes, claim/fence/lease and
original ten-minute deadline, owned PID/start/session/API identity, fresh effect
releases, seven immutable output roles, canonical observer manifest and journal,
independently authenticated validator evidence, exact stop receipt, then separate
trusted result finalization. Unknown mutations replay identical keys/bytes;
they do not authorize another native attempt or free occupancy.

Fresh 5→7 mm, cumulative 5→8→9→7, STEP/recovery and the eight-hour demo remain
unqualified for this connected chain. OVD-578's existing-instance sample proof
and OVD-579 retained phone results do not qualify this independent transport;
OVD-478 general multioperation execution stays outside this repair.

## Source adapter qualification packets

The concrete source adapters preserve separate authority domains. Their inert
fixtures establish source behavior, not deployment availability or real database
semantics. Follow these maintained contracts for exact inputs, failure outcomes
and the outstanding disposable/connected checks:

- [Private artifact mapping and registration](private-artifact-contract.md):
  immutable three-input/seven-output mappings, conditional Storage identity,
  current authority through committed registration, and SQL/Storage driver gates.
- [Pending result persistence](ovd561-pending-contract.md): owner-only fixed SQL,
  exact envelope bytes, acknowledged COMMIT, explicit unknown-outcome replay and
  concurrent persistence/rollback qualification.
- Stop bridge source and staged OVD-575 replacement live under
  `server/engineering/native-stop-*` and `scripts/native/stop-observer/sql/`.
  Its private POSIX spool is a server resource, not the companion's paired store.
  Evidence ingestion and stop submission remain separate; neither creates the
  independent qualification needed to make a stopped result eligible.

Do not apply staged SQL or provision a runtime from this packet. PostgreSQL,
Storage precondition support, real caller identities and Windows remain separate
authorization and evidence gates. Jev remains advisory: model confirmation cannot
change the deterministic depth grammar or grant stop/finalization authority.

The [concrete first-loop runtime](native-first-loop-runtime.md) now gives the
complete source call order: owner preclaim input mapping, existing authorized
worker/independent-stop flow, authenticated output mapping/upload/registration,
independent filesystem binding, and private verification/finalization or exact
replay. It starts no listener or worker. The generated full SQL fixture uses real
maintained claim/observer/stop/registry functions with synthetic records; its
source review and generation checks are not PostgreSQL execution evidence.
