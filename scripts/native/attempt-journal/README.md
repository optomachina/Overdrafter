# Native attempt journal

OVD-503 implements the durable process-evidence layer for the private automatic
engineering loop. This directory is under active implementation. The contract
and Windows storage exist. The prepared runner has opt-in journal hooks under
qualification; no companion dispatch or production execution is enabled.
No source here grants execution, retry, stop admission, verification or release.

`JournalContract.ps1` defines `overdrafter.native-attempt-journal.v1`. The binding
pins organization/project, task/attempt/job, worker installation/originating boot,
fence, exact job bytes and runtime admission. Every event carries its sequence,
binding digest, previous digest, observation timestamp and own digest. Supported
events are launch intent, observed creation, observed exit, native phase,
structured failure and uncertainty. Histories contain at most 2,048 events and
2,000,000 canonical ASCII JSON bytes, with nesting limited to 12 levels.

Canonical JSON sorts object keys ordinally, preserves array order, uses decimal
integers, and escapes control/non-ASCII UTF-16 units. Exact reserialization rejects
duplicate keys, alternate encodings and extraneous bytes. Desktop 5.1 and Core
7.5+ preserve timestamp strings. Do not use a serializer's default formatting as
the journal digest representation.

The prepared PowerShell owner directly starts the compiler, SolidWorks and the
lifecycle/operation helpers. Their `parentLaunchId` is null because their owner
already exists outside the attempt's launch forest. A helper's COM target is not
its operating-system parent. Nested or unexpected child creation is outside this
qualified envelope and must produce uncertainty, not an invented parent record.
Native/helper instrumentation and actual process-tree qualification remain
required; the schema alone does not establish process coverage.

Creation observations bind PID, creation ticks, Windows session and executable
path/digest. Qualified Windows executable paths compare ordinally ignoring case;
the raw intent and observed spellings remain in the journal and executable
digests must match exactly. This does not change native document identity or
authorize paths outside the qualified runtime. An exit must match the previously
recorded creation. Unresolved
launches, unknown children and other uncertainty prevent a complete recorded
process set. Repeated native operations and launches after failure/uncertainty
are rejected. Failure codes follow `docs/engineering-task-coordinator.md`;
`native_startup_timeout` cannot occur after startup readiness. Its later trusted
admission still requires qualified instrumentation and actual stop evidence.

`Get-NativeJournalSummary` reports **recorded** process completion. It does not
prove that an unreported process does not exist. Its stop/retry authority fields
are always false. `Read-NativeJournalText` accepts an independently retained head
digest to detect an old valid prefix. Hashes alone cannot detect coherently
rewritten history or prove worker origin. The trusted transport/admission layer
must validate authenticated source, qualified runtime and current attempt state.

`JournalStore.ps1` uses the existing per-user Windows ACL and CurrentUser DPAPI
primitives in a separate `LocalApplicationData/OverDrafter/NativeAttempts` tree.
An exclusive handle lasts for the full owner session. Writes use protected
same-directory temporary ciphertext, flush-to-disk, atomic replacement and exact
readback before acknowledgement. Failed replacement retains the prior ciphertext
and pending file and poisons that handle. Restart can inspect history but cannot
rewrite the originating boot or infer a launch did not happen.

`JournalRunner.ps1` persists an initial empty journal, then one event per append.
Before any launch it must reserve enough remaining journal capacity for creation
and terminal observations and acknowledge its launch intent. No native effect is
permitted after an unresolved write. A launch-intent/creation gap requires the
separate recovery procedure, even if process-name inventory is empty.

## Verification

```powershell
powershell.exe -NoProfile -File scripts/native/attempt-journal/test-contract.ps1
powershell.exe -NoProfile -File scripts/native/attempt-journal/test-runner.ps1
powershell.exe -NoProfile -File scripts/native/attempt-journal/test-qualification.ps1
powershell.exe -NoProfile -File scripts/native/attempt-journal/test-checkpoint.ps1
powershell.exe -NoProfile -File scripts/native/attempt-journal/test-crash-controller.ps1
powershell.exe -NoProfile -File scripts/native/attempt-journal/test-native-call-cleanup.ps1
powershell.exe -NoProfile -File scripts/native/attempt-journal/qualify-store.ps1 -QualifyStorage
powershell.exe -NoProfile -File scripts/native/attempt-journal/qualify-runner.ps1 -QualifyProcesses
```

The contract suite uses synthetic in-memory records and no native execution.
The cleanup suite compiles the actual `NativeCallSubscription` source with inert
surrounding dependencies. Its six simulated callback/cleanup combinations must
always reject qualification completion, invoke an installed detach action once,
and retain any detach exception as the original inner exception. It does not
invoke COM, observe a real callback, or qualify the Windows interop build.
Validation and startup helpers may be extracted for readability only while
preserving their check order, journal bytes, readiness deadlines and cleanup
order. The preview runner's explicit shared-helper list must include extracted
startup helpers; affected Windows qualification remains a separate gate.
`qualify-store.ps1` requires Windows Desktop 5.1 x64 and explicitly creates a
retained synthetic encrypted store. It tests exclusive ownership, restart,
append/rollback constraints, a locked-destination replacement failure and changed
boot rejection. It never pairs a worker, issues credentials or launches CAD.
Exact source `f86d3484f8da9c591158ea2f2f84dab48759a0b5` passed 75 contract
and 15 storage assertions on Workstation Desktop 5.1.26100.9278 x64. Evidence
attachment `f5374a5a-1d4e-45fd-9b3c-29bdd94e4b9d` on OVD-503 preserves the
source manifest and command receipts. This establishes storage behavior only.

The adapter's 35 in-memory checks mock process/storage boundaries. The separate
default-off `qualify-runner.ps1` starts three fixed PowerShell test children: a
normal exit, identity captured after exit, and a timeout of the retained child. It never starts
SolidWorks. Source `9967082f3e3b2366e38415e0f4477036c1b998c5` passed all nine
process assertions on Desktop 5.1, with three observed child exits and a canonical
nine-record journal independently replayed on Core. OVD-503 attachment
`1b73d25e-d58c-42bb-afba-8c42c4fbca9b` preserves the source/log/journal packet.
The earlier failed Win32-path attempt and diagnostic remain retained. Actual CAD
and unknown-process/fault qualification remain separate gates.

The first journal-enabled cumulative batch at `bbc85657` stopped during compiler
identity capture, before SolidWorks startup. Its original source files and
uncertain journal are retained in OVD-503 attachment
`1fd4f7f9-9071-4413-9c8c-e561c3c6c70e`; this is failed qualification evidence.
Incomplete child observations now carry the typed `process_uncertain` failure
and the underlying helper observation into the supervisor. The detailed error
cannot authorize retry, and a known child exit cannot fill a missing creation
record. The corrected compiler-only diagnostic in attachment
`e1a1173c-2dba-4e20-b88b-fd81a98df856` established that declared `C:\WINDOWS`
and observed `C:\Windows` paths resolve to the same pinned executable bytes.
Three new contract regressions cover case-equivalent spelling, exact digest
enforcement and a different-path denial. The subsequent full native qualification
is recorded below; interruption qualification remains open.

At `c6535394`, the first 5 to 8 mm native change passed all seven checks and
exited normally. The harness then rejected its 169,215-byte supervisor through
the job reader's 64 KiB limit. Attachment
`786a3285-bccf-41b7-8637-d32affd21b7c` retains this partial batch. The separate
`Read-PreparedJournalSupervisor` now bounds supervisor reports to 2 MiB with
strict UTF-8, no BOM and a single read-locked file handle. Job limits remain
unchanged. Independent replay accepted that exact native journal: 26 records,
seven launches, no unresolved recorded processes, no stop/retry authority.
This establishes the first native step, not the full cumulative or fault suite.

Exact source `1591c898b510dc6f34a4c54dd6c68f60c3e60850` then passed the full
journal-enabled 5 to 8 to 9 to 7 mm batch on Workstation Desktop 5.1. OVD-503
attachment `088cbe45-49ac-419d-84d6-3c5a4ac6541b` retains 109 exact-byte
evidence files and a 48-entry source manifest. Independent result verification
checked all 21 mandatory check records, measurements, predecessor bindings and
output manifests. Independent journal replay accepted 23, 26 and 26 records
covering six, seven and seven launches, with disjoint owned native intervals.
The original package and prior candidates were preserved. All native runs exited
normally; no stop/retry authority or adoption is implied. Native interruption,
unknown-child boundaries and finite recovery qualification still remain open.

`prepared-dimension/run.ps1 -JournalBindingPath <binding.json>` requires a v2
job and the exact journal binding above, including its job digest/fence/scope.
The binding is an operator-supplied qualification input, not server authority.
Compiler/lifecycle/operation calls use the existing pinned `OwnedProcess.ps1`;
its capture callback observes the same retained process and actual readers.
`ProcessIdentity.ps1` queries the retained kernel handle rather than enumerating
live modules or reopening a PID. It declares fixed query functions in memory
without spawning a compiler. The image query uses Microsoft's
[QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew),
creation time uses [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes),
and session identity uses the retained process token's TokenSessionId. The
Workstation diagnostic proved the native-form image query survives exit while
the Win32-form query fails. `QueryDosDeviceW` maps that observed native path to
the declared physical drive; foreign volumes, substituted drives and unsafe
suffixes are rejected. The corrected process qualification passed as recorded above.
The native process remains directly retained by the prepared runner. Every
launch intent is acknowledged before start, with bounded spare capacity for
terminal and uncertain observations. Final `attempt-journal.json` contains the
canonical acknowledged history; the supervisor binds its bytes and head digest.
Legacy v1 and preview calls omit journal state and keep their existing path.

The existing `prepared-dimension/qualify-cumulative.ps1` accepts optional
`-Journal` alongside its explicit `-Execute` and normal package/output/scope
arguments. It generates synthetic bindings, checks each returned canonical
journal against the exact job and supervisor digest, and requires compiler,
native, operation and readiness/close observations before advancing the existing
5 to 8 to 9 to 7 mm native/evidence checks. It cannot qualify unobserved processes
or grant authenticated worker admission.

`QualificationEvidence.ps1` requires the supervisor's exact job, attempt,
request hash and nonempty journal checkpoint. Lifecycle coverage is bound to
the native creation identity, argument digest and phase: repeated readiness
probes cannot substitute for the separate post-save graceful-close operation.
`test-qualification.ps1` exercises these acceptance and bounded-reader boundaries with 19 inert
assertions in addition to the 78 journal contract assertions it reuses.

Startup deadline classification is emitted only at explicit pre-operation
GUI/API readiness deadline boundaries. It still needs native fault qualification
and separate trusted stop admission; it never authorizes retry locally.

The shared readiness coordinator checks monotonic elapsed time after each GUI
wait and API probe, before admitting an operation. A successful readiness return
at or after the phase's fixed 60-second deadline is a startup timeout. The API
probe timeout remains capped at 30 seconds and shrinks to the remaining budget.
Supervisor `startup` evidence records both phase limits and elapsed times, GUI
readiness, each probe's requested timeout and observed timing/outcome, and the
terminal outcome/failure code. Probe exceptions retain their original identity
and child observations; unknown errors never become timeouts merely because a
probe was involved. This metadata is included in the existing progress/final
supervisor receipts and does not replace the immutable attempt journal.

`test-startup.ps1` extracts the actual coordinator and substitutes only its
clock/native/probe boundaries. It reproduces the prior late-success defect and
covers exact-deadline rejection, just-in-time acceptance, shrinking budgets,
GUI errors/timeouts and preserved typed/unknown probe failures. These deterministic
tests are not native startup-timeout qualification or retry authorization.

For an explicit Windows fault case, `qualify-worker-crash.ps1 -QualifyWorkerCrash
-Boundary startup_deadline` uses the same original-job scope check. The runner
records a real valid readiness response from the empty native instance, then
injects a labeled 60-second delay before admitting that response. The ordinary
monotonic deadline check must emit `native_startup_timeout` before an operation
launch. The worker publishes its failed startup observation and journal checkpoint;
the existing controller then interrupts the worker and stops only its verified
retained native descendant. Validation requires exact job/source binding, a
timely genuine response, the recorded delay, deadline expiry and no operation
launch. This test does not simulate a hung SolidWorks subsystem or grant retry.
The four original crash boundaries and normal/preview calls do not enable this
delay. Windows execution of this new fault case remains unverified.

## Worker interruption qualification

`qualify-worker-crash.ps1` is default-off and requires `-QualifyWorkerCrash`,
one named `-Boundary`, the exact original synthetic package, a fresh short
output root, synthetic organization/project UUIDs and the reviewed source commit.
It creates one original 5 to 8 mm v2 job. It does not run a batch or retry.

The runner's qualification-only `-QualificationPauseAt` accepts
`native_launch_intent`, `native_identity`, `outputs_saved` or `native_exit`.
It requires that original job, its exact journal binding and source label.
Normal task inputs contain no pause option. `QualificationCheckpoint.ps1`
publishes a flushed immutable checkpoint by atomic rename, then pauses for at
most 45 seconds. There is no resume command: the test controller interrupts the
owner, or the worker fails with `deadline_exceeded`. This is never classified as
the retryable native startup timeout.

The controller keeps the worker Process it started. For the two live-native
boundaries, it opens and retains the specific recorded native process while the
worker is still alive, then verifies creation ticks, session, path, executable
digest and live-parent ancestry before accepting that handle for test cleanup.
It stops the worker first, confirms its exit and only then terminates the
verified retained native handle. Unknown or mismatched processes are never
terminated. A qualification-only invoker owns the output readers and shares the
controller's stop-request state; it never invokes the generic helper's separate
timeout or kill cleanup. Callback failures preserve the readers and attempt the same
bounded cleanup for already verified handles; an unconfirmed exit remains a
failure and prevents further cases. No kill is repeated or performed by name.

After owner exit, the controller reads the original DPAPI journal, compares it
to the acknowledged checkpoint and verifies that a new runner refuses the old
attempt. It never appends missing creation/exit records. No finalized result may
exist. Source hashes must remain unchanged. A journal complete through native
exit still does not produce a candidate result or server stop admission.

The 35 checkpoint assertions and 30 controller assertions use inert records and
mocked processes. Desktop 5.1 confirmed them at source
`a201d6546e9adf6a0b4f53aa1fd875036bb67ab0`, together with the 78 journal,
35 adapter and 30 preview assertions. The following exact-source cases passed
and their returned evidence was independently checked:

| Boundary | Retained OVD-503 attachment | Independent evidence |
| --- | --- | --- |
| `native_launch_intent` | `d0b6841b-1ec2-4ecb-87e3-a78533aa5341` | 57 evidence files, 53 source entries, 7 journal records, one unresolved native launch intent; no native creation. |
| `native_identity` | `4e26aeab-4303-4902-b149-94be67c5b5a5` | 52 evidence files, 53 source entries, 9 journal records; exact worker/native identities and parent receipt, both controlled exits observed, original native exit gap preserved. |
| `outputs_saved` | `280cadc3-dd4f-4d52-82de-0e241f9fc0be` | 56 evidence files, 53 source entries, 19 journal records; 5 to 8 mm measurements and five native checks passed, but the worker interruption produced no finalized result and left the native exit gap unresolved. |
| `native_exit` | `eeaedfbb-6454-48b6-8f4c-1cca73b1bd4c` | 58 evidence files, 53 source entries, 23 journal records; all six recorded processes exited, including normal native exit, but interruption before finalization still produced no result. |

The initial launch-intent dispatch mistakenly selected the cumulative script;
PowerShell rejected its unsupported qualifier flag during parameter binding.
That failed invocation remains alongside the subsequent correct one-case receipt.
All successful cases preserved the original package, refused reuse of the old
attempt, retained the acknowledged journal and produced no final result. Windows
observed no remaining SolidWorks process. External controller cleanup did not
append missing worker observations or grant stop/retry authority. Executed source
bytes matched Git; CRLF normalization was limited to seven metadata files.

At the native-exit boundary, the journal correctly reports no unresolved
recorded process. This does not establish a finalized candidate or server stop
admission. These four cases do not qualify interruption inside a package-open/save call, unknown child
discovery, startup-timeout retry, fresh-session artifact recovery or server
admission; those remain separate open acceptance criteria.

The explicit `startup_deadline` case passed on Workstation Desktop 5.1 at
`b7c5f9a99700dd35bf4b1a504954f982f3954568`. OVD-503 attachment
`3be3671d-6c7e-4621-aabe-35e78e12b5e8` retains the packet with SHA256
`b24c5c51db13f1cf58a69be1b196c109c6ce27321b321be9e8c0820617869df8`.
Independent validation checked all 66 embedded evidence files and 54 source
entries; CRLF differences were confined to the same seven metadata files.
The real empty-document API probe returned ready at 4,350 ms, followed by the
explicit 60,000 ms qualification delay. Admission at 64,352 ms was rejected as
`native_startup_timeout`; no operation helper or finalized result was produced.
GUI readiness took 83 ms, and the final API elapsed observation was 64,365 ms.

Independent journal replay preserved 13 records, four launches and one unresolved
native exit in `startup_wait`. The controller observed the exact retained worker
and native process exits; its cleanup did not fill the worker's journal gap or
grant stop/retry authority. Original inputs were unchanged and Windows reported
no remaining native process. This qualifies deliberately delayed readiness
admission, not arbitrary SolidWorks startup hangs or automatic retry. Normal
cumulative execution after this deadline change requires its own evidence.

Remaining OVD-503 work: qualify unknown-child boundaries, finite native
failure/retry classification and fresh-session artifact recovery,
then complete hosted reviews and dependency reconciliation. Repository checks
passed after the deadline fix, and hosted CI run `34494395375` passed at
`b7c5f9a9`, including browser tests and Sonar. CodeRabbit skipped the draft, so its
review remains open.
HTTPS dispatch, privileged admissions and artifact
finalization remain separate integration work. Preserve all synthetic/native
evidence; rollback disables journal-enabled execution instead of deleting history.

## Native call fault qualification

`NativeCallQualification.cs` is excluded from ordinary builds. The original
synthetic job qualifier may explicitly select `open_call`, `part_save_call` or
`assembly_save_call`; only its operation helper receives the
`OVD_QUALIFY_NATIVE_CALL` compiler symbol and source. Lifecycle and preview helpers
retain their ordinary build. This does not expose a conversational operation or
enable a native execution service.

These hooks subscribe to the real `FileOpenPreNotify` or part/assembly
`FileSaveNotify` event around the selected synchronous native call. The callback
writes a flushed, atomically published `native-call-entered.json` with exact
job/context hashes, source, nonce, file and helper/native identities, then pauses
for at most sixty seconds. If it returns, it writes a separate released receipt,
returns a nonzero event result and makes the qualification operation fail. A
missing callback also fails; the test build cannot become a valid candidate.

`NativeCallEvidence.ps1` validates the entered receipt against independently
supplied job, settings, supervisor and worker identity. It grants no process
ownership or stop authority. `qualify-native-call.ps1 -QualifyNativeCall` supplies
the explicit one-case controller for these three boundaries. It creates only an
original synthetic 5 to 8 mm job, requires the same fresh short root and exact
source/runtime restrictions as the earlier worker qualifier, and never retries.

`NativeCallController.ps1` independently retains and verifies the live worker's
operation helper and native child, including executable hashes and live-parent
observations. It admits interruption only within ten seconds of the entered
receipt, with a monotonic capture limit and no release receipt. Before intentional
interruption it also requires `native-call-acknowledged.json`, atomically published
by the owner only after durable operation-helper creation acknowledgment. The
checkpoint binds the owner, source, nonce, boundary, full journal and ciphertext
digest. Waiting or reading consumes the same ten-second window; a missing, late,
foreign or changed acknowledgment fails the case. It rechecks
identity and freshness immediately before stopping the worker, confirms worker
exit, then stops and confirms the helper before native cleanup. Cleanup reuses
retained handles, never repeats a kill request and never bypasses an unconfirmed
predecessor exit. Partial capture or observation failure preserves uncertainty.

The controller records the journal ciphertext digest before interruption. After
owner exit it uses the normal exclusive store reader, requires unchanged bytes,
and validates the exact unresolved operation/native identities in the original
history. It refuses old-attempt reuse and requires unchanged original files and
no final result. Its external cleanup never synthesizes worker journal exits or
grants stop/retry authority. An unconfirmed cleanup prevents another case.

Local controller tests mock processes and Windows queries; they do not establish
actual callback delivery, Windows parentage or termination. The separate
exact-source Windows qualifications are recorded below. Unknown-child discovery and fresh-session artifact
recovery remain open acceptance criteria.

The first real `open_call` at source
`f39d7db75c2137ac030a510c4d100f65726bbf5c` failed before ownership capture.
The native `FileOpenPreNotify` receipt was produced, but the controller supplied
its in-memory construction dictionary to the strict JSON-object validator.
OVD-503 attachment `63139ec4-946c-4c91-ba41-ce29a140e122` retains 68 independently
verified evidence files and 61 source entries (packet SHA256
`0ced1eac62a13bf8ba5c90be0623a84d80c349f2116728e5265f6f006a72f053`).
The worker was stopped; neither child was adopted or terminated by the controller.
The returned inventory reported native PID 19120 and helper PID 25748 still
present. Original source hashes were unchanged. No retry or successful cleanup
is claimed, and read-only reconciliation must precede further native work.

Both explicit qualifiers now use `QualificationInputs.ps1` to create their
synthetic context, job and binding. It reads the exact serialized job into a wire
object before validation, preserving timestamp strings across Desktop and Core.
`test-qualification-inputs.ps1` exercises the actual shared producer with real
file bytes, including the rejected construction dictionary, exact digests,
scope refusal and non-overwriting reuse. Passing these regressions does
not qualify a replacement native run or clear the failed attempt's processes.

Separate empty-instance cleanup is retained in attachment
`d7c80c94-d7fd-4508-8f06-36fce6aa289f` (packet SHA256
`77bb58afcf1667c9cae57175e6f82cc3a7605805d256f59acdf89d599eb230d0`).
All 11 evidence records were independently hashed and inspected. The pinned
lifecycle helper inspected native 19120 with exact creation/session identity and
zero documents, then requested `graceful-close-empty`; both helper exits were 0.
Native exit was observed and the recorded final inventory was empty, but its
numeric exit code was not captured. Original file and journal ciphertext hashes
were unchanged. No journal exit records or retry authority were created.

Read-only replay of the failed journal preserved 15 records, five launches and
two unresolved entries. The operation helper had launched, but its creation was
not yet acknowledged when the controller stopped the worker. The qualification-only
creation acknowledgment now closes that race before intentional interruption;
its writer, delayed/missing/foreign receipt paths and runner wiring have local
regressions. The later verified opening case below supplies new exact-source
evidence. It does not turn this incomplete history into successful interruption
evidence merely because separate cleanup succeeded.

The next dispatch at `35d8fa45a0d966b0fe0763f5150e29610f2b69c3` stopped
at a Desktop 5.1 prerequisite before native preflight or execution. Adapter,
acknowledgment, controller and environment tests passed (40/33/143/27 assertions,
plus their contract prerequisites); the shared input test then rejected its
serialized file collection. Attachment `083b3821-6bac-48e6-bd18-15ae1e6279f3`
preserves 33 independently hashed evidence records and 66 verified native source
entries. The post-failure read-only observation matched original/runtime pins and
found no relevant processes. No native attempt, interruption or recovery result
exists for that dispatch. It requires a compatibility correction and passing
Desktop prerequisites before another native case is admitted. The retained direct
serialization diagnostic (`42fd6f4b-c2c6-4676-8aac-23c88c5e076e`, 15 verified
records) shows Desktop 5.1 serializing the root-array roundtrip as an object with
`value` and `Count` fields inside both job and context. Converting individual
records to `PSCustomObject`, as the existing cumulative comparison does, preserves
three array elements through serialization. The producer now uses that conversion
and still rejects unexpected fields and wrapped collections. Passing local checks
does not replace the required corrected-source Desktop gate.

### Verified native call interruptions

At source `43b2db778750196304c1b92811ca08bb48ba2be6`, all seven prerequisites
passed on Desktop 5.1.26100.9278 x64: input producer 23, adapter 40,
acknowledgment 33, controller 143, environment 27, earlier crash controller 30
and build arguments 14, including their journal/receipt/checkpoint prerequisites.
Attachment `cd26c3dc-d697-48a0-83e2-42a21b0751dc` preserves 39 independently
verified records and 66 native source entries. This prerequisite pass launched no CAD.

One subsequent `open_call` at that exact source passed with a fresh original,
runtime and process preflight. Attachment `8e88a6f0-916d-4a1e-b489-adc6e7f10d57`
(packet SHA256 `c87a86c6de3d848ece8624cdfbdc19324a2d53049a7037d4a888ce314b1ace18`)
contains 65 verified evidence records, 66 checked native source entries, 22 copied
source files and 46 locally available output-manifest files. Native binaries remain
on Windows; their reported digests bind the process and output observations.

Independent replay verifies the real opening receipt, exact owner acknowledgment,
and matching before/after journal. The controller recorded the callback within
2187.8519 ms and confirmed worker, operation-helper and native exits of -1.
Original files and pinned runtime matched before/after, and the final relevant
process inventory was empty. The unchanged journal retains 19 records, six launches
and two unresolved exit gaps. External cleanup did not fill those gaps or grant
retry authority. No final result, supervisor-final or released callback receipt
appeared. This proves the synthetic opening interruption, with the saving case
qualified separately below.

One subsequent `part_save_call` at the same source also passed. Attachment
`80c60559-28fb-46f7-9360-35dbd9077d09` (packet SHA256
`0d2e4d0536f2d153e63089e11bdfc4205fbef9e0ef99c0ae3c5dce5d1c41112b`)
preserves 63 verified records, 66 source entries, 22 copied sources and 44 available
output files. Independent replay binds `Part.FileSaveNotify`, the owner
acknowledgment and unchanged 16-record/five-launch journal with two unresolved
exit gaps. The controller recorded the callback within 994.9297 ms; all three
controlled exits were -1. Fresh original/runtime observations match, final process
inventory is empty, and no final result or released callback appeared. The private
candidate retains a `~$baseline-5mm.SLDPRT` lock file. It remains incomplete
history, not a verified candidate or a demonstrated fresh-session recovery.

The separately admitted `assembly_save_call` also passed at that source.
Attachment `ff007a01-3fc8-4261-bbdf-303e0bc8275e` (packet SHA256
`e9951e27911cff3768e5fed4a983ed52d31c48922793a77260b20462cd2f9d72`)
preserves 63 verified records, 66 source entries, 22 copied sources and 44 available
output files. Replay binds `Assembly.FileSaveNotify`, exact acknowledged identities
and the unchanged 16-record/five-launch journal with two exit gaps. The controller
recorded the callback within 977.6869 ms, confirmed all three controlled exits of
-1, and observed unchanged originals/runtime and an empty final process inventory.
No final result or released callback appeared. The private package contains a
changed part (57106 bytes) and a seven-byte `~$synthetic-assembly.SLDASM` lock file;
the assembly and fixed companion hashes still match their originals. These are
unverified private residues, not proof of valid saved geometry or recovery.

All three cases were sequential, independently admitted against fresh preflight
observations, and performed without automatic retry. Unknown-child denial,
fresh-session recovery, retry admission and hosted execution remain separate gates.

### Fresh-session recomputation after interrupted saving

At `b6434ea9f48000505e55abae5bd275aee012c3c3` (README-only changes from the
qualified runtime), one new original-input 5 → 8 → 9 → 7 mm batch passed after
the assembly-save interruption. Attachment `ee81d9e3-f1b0-4094-949c-4194fcfc83ac`,
packet SHA256 `fc6a9edcc6c8e5fb838affcda3aea6eefb2882dacba2606175ed43e300dc7893`,
retains 156 verified records and 66 checked source entries. Independent checks
cover all 21 native checks, predecessor bindings, 54 copied source files and
134 available output files. Each new journal has 23 records and six launches;
all native exits were zero and their intervals were disjoint. Originals and
runtime pins match before/after, and the final relevant inventory is empty.

All 50 files in the old assembly-save root, including its changed private part
and lock, match the preceding interruption manifest and remain byte-identical.
The old DPAPI ciphertext is unchanged. The batch uses the original seed and its
own verified successors, never the incomplete candidate. This qualifies fresh
recomputation from pinned inputs, not partial-file repair, clearance of the old
attempt's exit gaps, stop admission or automatic retry. Native binaries remain
on Windows; local verification binds their reported hashes and measurements.

### Observed extra-process denial fixture

`qualify-unknown-child.ps1 -QualifyUnknownChild -OutputRoot <fresh-local-root>`
is an explicit, no-CAD Desktop 5.1 fixture. It records one harmless child normally,
then starts a second retained fixture child deliberately outside the attempt's
journal. After observing that child's identity and parent, it durably records
`unknown_child` and checks that another launch is refused before a process effect.
It reopens the store, checks the original boot and acknowledged bytes, waits for
its own fixture child to exit, and confirms uncertainty still prevents reuse.
All evidence is retained; the fixture never adopts an existing process.

At `ef7bebce24e326b2b6eb8f6032c369bb2015920c`, the fixture passed ten assertions
on Desktop 5.1 after 45 adapter and 78 contract checks. Attachment
`b69ef22d-e6d8-4621-a8c3-9669cba5742c` (packet SHA256
`21a090ea38df55711db086881fd0afaab3f21dad9076f40175b6ca3ccc5eaafd`) retains
37 verified records and 67 checked source entries. Independent replay confirms
the four-record journal preserves its three prior records, has zero unresolved
recorded launches, and still requires recovery after fixture process 27064 exits
normally. All ten output files were checked. Reopening and reuse refusal preserve
the acknowledged ciphertext; no extra-child exit is invented. This proves denial
after an observed extra process, not general descendant discovery or containment.
Neither known exits nor this fixture grants server stop/retry authority.

The subsequent full-source review found that a failed creation/exit journal
write could discard the retained helper's cleanup observation. The adapter now
preserves that observation in a typed `process_uncertain` exception even when
the poisoned store rejects an uncertainty append. It does not repair the journal.
Regressions cover failed creation, exit and uncertainty persistence, retained
PID/exit/termination fields, unchanged acknowledged history and relaunch denial.
At `ae5d92926b1aa892f028117f0381b33ed0efd7f0`, the correction passed Desktop
5.1 x64 validation: 60 adapter, 143 controller, 46 startup and 30 preview
assertions, with the 78/46/81 contract prerequisites. Attachment
`f779dc57-d2b3-4629-bb1e-5967d9d3bd07` (packet SHA256
`a0170e90be57b524a0fef290cc9fdab823691598e45f2c442c9edcba069844a3`)
retains 44 byte-verified records and 67 checked source entries. The separate
three-child inert process fixture passed nine assertions. Independent journal
replay accounts for all three launches and exits: two normal exits and one
confirmed owned timeout termination. It grants neither stop admission nor retry
authority. Pre/post runtime and original-file hashes match; native inventories
are empty. No CAD operation ran during this affected-runtime validation.
The retained DPAPI ciphertext is 6,678 bytes, SHA256
`bb6129c1ca10ee6cf3de596297046ed04d0840def5dbe2ddbd13e91372ecaa70`.
Earlier native evidence remains bound to the exact sources stated above.

The installed 30.5.0.49 interop's event sources and delegate signatures were
confirmed by read-only Windows reflection (OVD-503 attachment
`8d486a0a-22df-4387-8339-dcab479a5485`, pinned interop SHA256
`9284fcfb569b3e7e906e7c8d1f551e6d073f79500ba78e32c6464a53571813f0`).
The vendor documents
[FileOpenPreNotify](https://help.solidworks.com/2023/english/api/sldworksapi/SOLIDWORKS.Interop.sldworks~SOLIDWORKS.Interop.sldworks.DSldworksEvents_FileOpenPreNotifyEventHandler.html)
before loading and
[FileSaveNotify](https://help.solidworks.com/2024/English/api/sldworksapi/SOLIDWORKS.Interop.sldworks~SOLIDWORKS.Interop.sldworks.DPartDocEvents_FileSaveNotifyEventHandler.html)
before saving. These pre-notification boundaries do not establish behavior during
partial disk writes, general application hangs or fresh-session recovery.
