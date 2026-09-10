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
powershell.exe -NoProfile -File scripts/native/attempt-journal/qualify-store.ps1 -QualifyStorage
powershell.exe -NoProfile -File scripts/native/attempt-journal/qualify-runner.ps1 -QualifyProcesses
```

The contract suite uses synthetic in-memory records and no native execution.
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

Remaining OVD-503 work: qualify actual runner launch/exit coverage and complete
owned-process boundaries, qualify finite native failures and Windows faults, run
repository checks and reviews. HTTPS dispatch, privileged admissions and artifact
finalization remain separate integration work. Preserve all synthetic/native
evidence; rollback disables journal-enabled execution instead of deleting history.
