# SolidWorks 2022 native feasibility

Status: experimental evidence only; full OVD-480 worker qualification is incomplete.
Target: Workstation, SolidWorks 2022 SP5. Recorded September 8, 2026.
Evidence owner: [OVD-480](https://linear.app/overdrafter/issue/OVD-480/provision-isolated-solidworks-workers-and-license-aware-job-leasing).

## What is established

The installed SolidWorks 2022 SP5 instance completed one synthetic part's native
create, dimension edit, rebuild, measurement, save and read-only reopen workflow.
A flat assembly containing the two resulting parts also passed creation, fixed
placement, save, read-only reopen, rebuild and observed CAD-reference inspection.
This establishes bounded native operations on this machine. It does not admit
customer assemblies, qualify an isolated worker, or satisfy the full pilot.

The user explicitly accepted Windows 11 Home for this experimental lane.
[SOLIDWORKS system requirements](https://www.solidworks.com/support/system-requirements)
exclude Home editions; that support classification is recorded separately from
observed behavior. It is not treated as a blocker to the accepted experiment.

| Environment item | Observed value |
| --- | --- |
| Application | SolidWorks 2022 SP5 |
| Product/file version | 30.5.0.0049 |
| Installed interop version | 30.5.0.49 |
| Windows | 11 Home 25H2, build 26200.9278 |
| Runtime | Existing interactive session; x64 C# STA helper |
| Separate worker isolation | Not qualified |
| Product edition and execution entitlement | Not independently verified |

The helper binds the existing version-specific application and verifies its
API process identity and revision against a fresh parent observation. Process
creation times from CIM and .NET have different precision on this machine:
each is compared exactly with another observation from the same provider.
A comparison between their timestamp strings caused a recorded caller failure.

## Synthetic part proof

Before testing, the user authorized saving and closing 15 existing documents.
The untitled part was preserved in a new recovery file. All 14 previously saved
files retained their hashes, and document count became zero. The recovery file
was copied privately and inspected before use; factory-template provenance was
not asserted.

The fixture is a cylinder of radius 10 mm. Its 5 mm extrusion was saved as the
baseline. An exact copy was reopened, verified at 5 mm, changed to 8 mm through
the same native extrusion definition, rebuilt and saved. A read-only reopen
then repeated the native and geometric checks.

| Phase | Depth (mm) | Volume (mm³) | Surface area (mm²) |
| --- | ---: | ---: | ---: |
| Saved baseline | 5 | 1570.796326795 | 942.477796077 |
| Copied candidate before editing | 5 | 1570.796326795 | 942.477796077 |
| Edited candidate | 8 | 2513.274122872 | 1130.973355292 |
| Saved candidate reopened read-only | 8 | 2513.274122872 | 1130.973355292 |

All four phases reported successful rebuild, feature error zero without a
warning, one solid and zero sheet bodies, and twelve finite mass-property values.
Both saves succeeded with zero errors and warnings, exact paths and clean state.
The helper exited with code zero after 12.964 seconds. The session returned to
zero documents, and the original application process remained running.

Analytic checks use volume πr²h and surface area 2πr² + 2πrh. Absolute tolerances
are 1e-10 m for depth, 1e-10 m³ for volume, 1e-9 m² for area and 1e-8 m per center
component. The coordinator independently recalculated the reported depth,
volume and area results. Center acceptance is executor-reported: the sanitized
receipt contains approximate centers, not exact components. Density 1 is a test
input, not evidence of a physical material. A fully constrained sketch is not
claimed.

| Preserved synthetic artifact | Bytes | SHA256 |
| --- | ---: | --- |
| baseline-5mm.SLDPRT | 56,144 | e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa |
| candidate-8mm.SLDPRT | 56,171 | b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898 |

These are executor-reported Windows file hashes. Native files were not downloaded
or independently hashed by the coordinating Mac. Source, output and log hashes
are retained in OVD-480's single rolling progress record and the private
qualification packet.

## Synthetic assembly proof

The fixture contains private copies of the two proven parts in one flat assembly.
All three native documents have the observed configuration `Default`. Initial
inspection and a subsequent fresh read-only reopen reported these same values:

| Occurrence | Referenced file | Translation (mm) | State |
| --- | --- | --- | --- |
| baseline-5mm-1 | parts/baseline-5mm.SLDPRT | (0, 0, 0) | Resolved, nonvirtual, fixed |
| candidate-8mm-1 | parts/candidate-8mm.SLDPRT | (40, 0, 0) | Resolved, nonvirtual, fixed |

Both transforms have identity rotation and scale 1. Rotation/scale tolerance is
1e-10 and translation tolerance is 1e-8 m. Top-level and recursive component
inventories agree, each reference resolves to the exact private part and
configuration, and both underlying parts are read-only. The assembly's observed
CAD dependency list contains exactly these two files; both part lists are empty.
These observations do not establish all auxiliary support-file dependencies or
filesystem/network isolation.

SaveAs3 succeeded with zero errors and warnings. The saved assembly is 59,987
bytes, SHA256 `90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a`.
Reopening returned a document with zero errors and warning 32, which the official
[load-warning contract](https://help.solidworks.com/2021/English/api/swconst/SolidWorks.Interop.swconst~SolidWorks.Interop.swconst.swFileLoadWarning_e.html)
identifies as requiring rebuild. The verified readback retained this warning,
admitted only warning bits 0 or 32, and successfully called ForceRebuild3(false)
before repeating the exact component, configuration, transform and reference
checks. It did not resave the assembly. The warning is not rewritten as a
warning-free open or generalized permission to ignore other load warnings.

The readback helper exited zero after 9.609 seconds. Assembly-first cleanup
returned the session to zero documents. All source/private files, the saved
assembly hash and the original application process were retained. The stable
readback manifest hash is
`997cb9b1b7a4afb08d934872a61eea2835a7f909e09f611c5874e8ce766855a0`;
its write-stage snapshot precedes completion, while the separate result record
reports the final pass. Neither is a production engineering snapshot or release
approval.

The coordinator checked the exact reported transform arrays and reference sets
against the declared fixture and initial observations. Actual native readback
and file hashes remain executor-reported evidence.

### Preserved assembly caller failures

The first helper failed while loading interops before Main/COM. Restoring the
working AssemblyResolve/NoInlining bootstrap and deferring typed static
allocations fixed that startup path. A later attempt stopped because its blank
template allowlist omitted documented `LiveSectionFolder`. The focused correction
retained child/content inspection and all physical/reference checks.

The first saved-assembly reopen rejected warning 32 before verification, then
its cleanup tried a referenced part before the assembly. That attempt's final
count remains unknown in its historical record. The subsequent readback run
found exactly the three known private documents and recovered them assembly-first
before fresh inspection. The final pass does not erase those earlier failures.
Temporary task-status outages were reconciled through saved executor receipts;
an unavailable status reader did not authorize duplicate native execution.

### File admission adverse cases

A separate file-only batch passed one positive control and four rejection cases
using path, length and digest predicates extracted from the successful native
reader. The harness made zero COM/CAD calls and exited zero in 0.274 seconds.

| Case | Observed result | Admission content reads |
| --- | --- | ---: |
| Verified assembly package, exact four files | Eligible for file checks only | 4 |
| Required part omitted from a disposable copy | Rejected: missing required file | 1 |
| One byte changed in a disposable part copy | Rejected: digest mismatch | 1 |
| Existing part outside the allowed root | Rejected: outside allowed root | 0 |
| Existing part in a similarly prefixed sibling directory | Rejected: outside allowed root | 0 |

The last two copies had valid digests checked during setup. Those setup reads
are separate from the admission reads shown above. All seven source/original
file hashes were unchanged. The native caller using the shared predicates was
compiled but not executed; the original successful reader was preserved.
This demonstrates these file checks, not deployed native preflight integration,
reparse-point or race resistance, complete dependency closure, or worker
isolation. The negative fixtures are file tests, not qualified CAD packages.

The coordinator's local assembly packet validator passed 41 receipt-consistency
checks with none failed or pending. It recalculates reported geometry and checks
identities, transforms, reference sets and preserved failure states. It does not
independently access Windows files or reproduce native execution.

### Repeatable file-only qualification tooling

The demonstrated predicates are preserved in
[`scripts/native/file-admission`](../scripts/native/file-admission/README.md)
with a standalone synthetic regression harness and bounded Windows runner.
The runner compiles using the installed x64 .NET Framework compiler, records
the exact copied source and binary hashes, and retains each attempt's fixtures
and results. This adds repository-controlled test tooling; it does not connect
the predicates to a deployed native executor or expand their admission scope.
The repository version passed on Workstation using Windows PowerShell
5.1.26100.9278 and compiler 4.8.9221.0. Parsing returned no errors, compilation
exited zero in 0.206 seconds, and the five-case synthetic test exited zero in
0.163 seconds. Missing/outside-root/prefix-sibling cases made zero admission
content reads; four original synthetic controls retained their hashes.
The full runner exited zero, with no timeout, termination or policy bypass.

The three copied source hashes matched the coordinator's working-tree files.
The receipt records a null source commit because the files were tested before
commit; their exact hashes identify the executed input. Binary SHA-256 is
`0d935190936ba9bba768a6232f3407e94d9f937811b228d83a482d29371e8308`.
Actual Windows observations remain executor-reported. This single successful
run does not demonstrate timeout fault injection or isolated CAD execution.

### Owned-process adverse-case tooling

The next bounded OVD-480 slice extracts the existing launcher into one shared,
copied-and-hashed helper and adds `qualify-process.ps1` with nine inert-child
cases. It preserves exit/PID evidence through invalid input, capture and log
failures, tests observed timeout cleanup against an independent control process,
and keeps successful capture evidence separate from injected capture faults.
The existing five file-admission cases must pass again after this helper change.

Implementation and source review do not qualify these cases. Retain an actual
Workstation compilation/run receipt for the exact source before reporting the
new paths as demonstrated. This tooling performs no CAD calls and does not
resolve failed OS termination, process-tree containment, isolated license
ownership or native CAD interruption/recovery. See the
[process qualification instructions](../scripts/native/file-admission/README.md#qualify-process-failure-reporting).

The first exact-source attempt on September 8 used commit `8731089449d4f9c44c7958e9a5795a456ddf0ef8`.
All six downloaded source hashes matched; all three PowerShell files parsed
without errors on x64 Windows PowerShell 5.1.26100.9278. The driver exited 1
after 0.555 seconds because Windows rejected the copied, unsigned
`OwnedProcess.ps1` under its script-signature policy. Compilation, the control
process and all nine cases were not started; the dependent file lane was not
run. The failed receipt retains null compiler/binary fields and an empty case
set, with on-Workstation SHA-256
`75adb0de89ea3d763cfb41fb3d25dbc65db9d89c35d4d53e512244c1b35d8be6`.
The parent exit and failure receipt are preserved. No policy change, unblock,
alternate execution path or retry was used. This is a qualification blocker,
not a demonstrated process-helper failure case.

Read-only follow-up found effective `RemoteSigned` policy and no
`Zone.Identifier` stream on any inspected source or copied helper. The copied
helper's path was 274 characters; ordinary-path metadata inspection failed
while extended-path inspection succeeded. Path handling is a concrete
hypothesis, not an established cause of the signature error.

The second batch used identical source hashes under a fresh, short private
temporary root; all actual artifact paths were at most 138 characters. The
process driver exited 0 in 8.684 seconds: all nine cases passed, the independent
control survived every case and exited 0 after release. The owned timeout and
injected capture-start failure retained observed termination and exit -1. The
injected pending stderr task preserved known exit 0 and available stdout while
reporting capture failure. The failed log destination preserved exit 0 and both
captured streams while still failing that invocation.

The dependent file driver then exited 0 in 35.240 seconds with all five cases
passing and the shared helper included in its four-source manifest. Both
parents retained known exits without timeout; compiler identity, source hashes
and binary hashes are recorded. Policy readback remained `RemoteSigned` before
and after; no policy, trust or source changes were made. These observations
demonstrate the short-path execution envelope, not the cause of the earlier
signature error or general long-path support.

The executor-reported on-disk receipt SHA-256 values are:

- Process: `901566e5ab0d2238aec9555e557ca4fbc588d109a20a7c9aae30722871112af6`.
- File: `e15b829ead96094dd235ff92e6407482cfd18c855460ae8f0829ead833f74b49`.

Complete success/failure receipts, parent observations and source binding are
retained in the coordinator's `output/ovd-480-process-recovery-2026-09-08/`
packet and the original Workstation attempt directories. No CAD calls occurred;
the full OVD-480 worker qualification remains incomplete.

## Owned native lifecycle qualification

The next bounded qualification step establishes native-process ownership before
testing an interruption. The existing process helper owns its C# child; the
SolidWorks session that child connects to is a different process. Ending the
helper does not establish that SolidWorks exited or that native effects were
recovered.

The experimental lifecycle uses sequential sessions in the existing Windows
profile. It first verifies that the expected current session has no documents,
requests a normal application exit, and confirms that process exited. It then
starts SolidWorks directly with a retained process object, binds the API to that
exact new process, verifies an empty session, requests normal shutdown, and
records the native exit. No native files are opened or edited by this step.

The normal-exit operation requires a fresh identity and empty-document check.
The supervisor does not terminate a native process by name or assume that COM
activation created a new process. SOLIDWORKS documents that `CreateObject` can
attach to an existing session and that `ExitApp` would then end that session.
[SOLIDWORKS 2022 ExitApp reference](https://help.solidworks.com/2022/english/api/sldworksapi/solidworks.interop.sldworks~solidworks.interop.sldworks.isldworks~exitapp.html?format=P&value=)

This step does not qualify a separate Windows profile, filesystem or network
isolation, deployment entitlement, crash recovery, interrupted saves or worker
leases. Native interruption remains dependent on a successful owned lifecycle
and a separately reviewed synthetic-operation checkpoint.

The readiness-qualified source passed one Workstation lifecycle run on
September 8, 2026. That run used `lifecycle.ps1` SHA256
`57449bd7d477380131aa94966a143a84090a6f6e7ce161d323766473b1febbc2`,
correlated with Git commit `d99d777249fa9333ff4dad9d4cc3a2025d5c9102` after execution.
The outer supervisor exited zero after 16.2196468 seconds. The previously
observed empty process (PID 5968) exited normally with code zero. The supervisor
directly started and retained PID 5880 in session 1, with .NET UTC creation ticks
`639245082192450086`, and observed its normal exit with code zero. Final CIM and
.NET process inventories both contained no SolidWorks process.

Six read-only readiness probes returned COM-registration-unavailable before a
subsequent probe established the expected API identity, completed startup and
zero documents. Those intermediate observations remain `not_ready`, not failed
identity checks or claimed successes. The initial one-shot readiness design had
been rejected during local review; its live run was held before any shutdown.

Both denial cases in that source passed: default-off invocation stopped before
creating an attempt, and stale creation ticks stopped before compilation or
native API activity. The original native04 baseline/candidate hashes and
effective RemoteSigned policy remained unchanged. No CAD-file open or edit was
requested and no forced native termination occurred.

The full executor receipt is preserved at
`C:/Users/blain/AppData/Local/Temp/OVD480-Q-db84289d/complete-receipt.json`, SHA256
`c837074fcf02b747c320af8c638cd0d5738177134333b12ff78b840a4d976810`.
This is one successful empty-session lifecycle, not a reliability rate or
interrupted-CAD recovery result.

Hosted review subsequently identified an overbroad recovery flag on inert
preflight denials. The reporting-only correction records whether native start
or close dispatch was attempted and sets `recovery_required` on failures only
after such an attempt. It preserves the failed outcome and all errors. This
correction does not change the C# probe or the successful native operations;
the historical live receipt remains bound to the earlier source above.

## Controlled read-only interruption fixture

The internal fixture builds on the owned lifecycle with an explicit
`-InterruptReadonly` option. It requires an empty current native inventory and
the exact preserved native04 baseline/candidate identities. It prepares two
private baseline copies, verifies one in an owned process, flushes an immutable
checkpoint, and interrupts only the retained process. A separately identified
fresh process verifies the other copy and closes normally. The interrupted
attempt is never rewritten as a successful execution.

The reader preserves the native04/assembly-readback-03 predicates: one Default
configuration, no dependencies or active sketch, one named base extrusion,
one solid and zero sheets, 5 mm depth, and the 10 mm radius cylinder's expected
volume, area and center. It opens the private file read-only and may rebuild
in memory, but never saves it. Original source SHA256 values are
`313248ef9fcc6bb63dbb01e26901f478f3dde7de9655c1cbd0f821315c9d38f9`
for `Fixture.cs` and
`b155bc99d3c636546068eb729e5dbbd2237ba925f8181634456023b430045908`
for `PartVerification.cs`.

On September 8, 2026 (Phoenix; September 9 UTC), this single case passed on
Workstation with source commit `939a1b9d318ebedb3d10c3949ca03e139df6c3af`.
The six copied source hashes identify the executed input; the caller-supplied
commit label alone is not source verification. Both PowerShell files parsed
without errors. Before execution, an inert sentinel test confirmed that a
failed recovery launch guard clears the current process slots while preserving
the previous attempt's identity record. The actual driver compiled the C# probe
with the pinned Windows compiler and exited zero after 31.260 seconds, without
supervisor timeout or forced supervisor cleanup.

The first native process, PID 21532, opened its private baseline read-only and
passed the complete cylinder check set. The driver flushed the immutable
checkpoint before its single retained-object termination; native exit was -1.
That attempt remains `interrupted`. A new process, PID 10364 with a distinct
start time, independently verified the other private baseline, closed the
document to zero, and exited normally with code 0. Both final native
inventories were empty. Both original synthetic files and both private copies
retained their byte hashes; execution policy was unchanged.

The complete original JSON receipt is 193,397 bytes, SHA256
`a73d62181df3e9c85714efa16f28e6f83c41f93a21c37fb3d0ff16d64f771762`.
It contains 34 complete raw JSON/log records and a 43-artifact hash inventory.
The checkpoint SHA256 is
`0fab2e4ffe90cd92ace49f5124eba2d540fff1c8a1ad04a0b9198d7be06590be`;
interrupted and recovery result hashes are respectively
`d23ca18fb7cd8d69c63dfb9da56a4dab629329f2abdcd994ff1e99b293e97eb8`
and `ef608091b29e48ac30c4b7d15de2ff96dce392424fb2d6c58ce212a77a0f46b9`.
Original Windows records remain under `OVD480-LIVE-d0387b` in the user's
temporary directory; the coordinating worktree preserves the decoded packet
under `output/ovd-480-native-interruption-2026-09-08/`.

Before this run, the same C# sources compiled successfully and four actual
driver admission denials passed: default-off, attempted existing-process
adoption, stale start-time binding, and wrong baseline bytes. The subsequent
PowerShell identity-reset correction was covered by the sentinel and live case.
The 11,603-byte compilation/denial receipt has SHA256
`33f4d789c27b95a92263339f040810034845d3d97fa555f8647f5e582abcaa08`.

These are executor-reported Windows observations with preserved original bytes,
not independent re-execution. They demonstrate controlled interruption after
idle read-only verification and fresh-session verification of an immutable
input. Shared-profile interference, interrupted native saves, recovery dialogs,
broader prepared assemblies and worker scheduling remain outside this claim.

## Prepared assembly read-only recovery

On September 9, 2026 (Phoenix; September 10 UTC), one controlled recovery case
passed on Workstation with executable source
`7783ce2de30c8ffc5461e4996bc1c1bc3e399495`. The existing lifecycle driver accepts
an explicit `-AssemblyPath` alongside its read-only interruption opt-in and
both pinned part paths. It creates two complete private copies of the exact
synthetic assembly and its 5/8 mm cylinder parts, with distinct immutable input
manifests. The original single-part manifest baseline field remains compatible.

The assembly adapter reuses the prepared-dimension package/geometry readers
without dispatching their editing entry point. Both sessions verified all three
loaded private paths, native document identities, sole Default configurations,
read-only state, the two fixed resolved occurrences, exact reference closure,
both cylinder geometries and unchanged placements. Rebuilds occurred only in
memory. The first retained process, PID 6036, was interrupted after its helper
completed and its checkpoint was flushed; its observed exit was -1. A distinct
fresh process, PID 23440, verified the other private package, closed all three
documents and exited normally with code 0. The outer invocation completed in
44.817 seconds with exit 0 and no timeout or supervisor termination.

All three originals and all six private files retained their hashes. Both final
native inventories were empty and execution policy was unchanged. The complete
packet is 870,991 bytes, SHA256
`50eef159066de873dae9ede1db0f8799a7237572be0970cb274cea5a5aa76d62`,
with 51 raw records and 58 artifact inventory entries. Local reconstruction
passed 206 evidence assertions, including original bytes, all ten executed
source hashes against Git, manifests, checkpoint, attempt results, individual
measurements and supervisor observations. Original Windows evidence remains
under `AR-L-9cYayV`; decoded evidence and its validator are preserved under
`engineering-assembly-recovery/Overdrafter/output/assembly-recovery/` in the
coordinator's worktrees.

The corrected sources also compiled on the pinned Windows compiler. Thirteen
inert checks passed: explicit admission denials, wrong/missing assembly or
companion files, separate complete copies, changed manifests/private files,
and legacy single-part manifest compatibility. These use the actual default-off
driver and extracted source functions in an inert harness; they do not simulate
native CAD. Their complete six-record packet is 47,381 bytes, SHA256
`2c7f3c09c2f6dafbfb8bd90f6a89a532696e6226d7b4b1732219aad51616a1c7`.

This is one controlled idle read-only assembly interruption followed by fresh
verification. The evidence is executor-reported native observation with
independent byte/consistency checks, not an independent CAD re-execution.
Interrupted saves, arbitrary assemblies, mates, drawings, lease recovery,
Windows-profile isolation and legitimate worker deployment remain unqualified.
Full OVD-480 therefore remains in progress.

## Failure history and limits

- A late-bound identity call failed; a typed C# identity call succeeded.
- Temporary cylinder creation and measurement passed. Temporary box creation
  still fails with 0x8002000D; its internal cause is unknown.
- Early part attempts stopped on overly narrow caller checks for standard
  container types, the literal feature type `Boss`, and `IsBossFeature()`.
  The actual first-solid feature reports `Extrusion` and a false boss diagnostic.
  The passing run verifies `IsBase2()`, the extrusion definition, rebuild,
  body count and measured geometry together.
- A wrong executable hash was rejected before helper launch. A parent stopped
  its own inert helper after a deadline while retaining SolidWorks. Those checks
  do not prove recovery from interrupted CAD effects.
- The working helper's exit status is known. Earlier attempts with unavailable
  numeric exit status retain that unknown value; structured success does not
  retroactively supply an exit code.

The part and flat-assembly successes are not a reliability rate. Nested assembly
dependency closure, component changes and mates, additional configuration
coverage, native reference stability, filesystem/network isolation, queue
ownership, lease loss, crash recovery, quarantine and teardown remain
qualification work. PDM publication and external transmission are outside this
experiment.

## Implementation boundary

The TypeScript domain, state and operation-preflight modules remain offline
contracts. This evidence does not connect them to a production native worker or
durable engineering service. No database migration, provider operation, license
change or OS/security change is part of this slice.

Follow [the engineering control-plane contract](engineering-control-plane.md)
for subsequent capabilities. OVD-473 owns the broader context/cache contract;
the small native inspection fixture does not complete that issue.
