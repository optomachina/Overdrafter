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
path/digest. An exit must match the previously recorded creation. Unresolved
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

The adapter's 32 in-memory checks mock process/storage boundaries. The separate
default-off `qualify-runner.ps1` starts three fixed PowerShell test children: a
normal exit, identity captured after exit, and a timeout of the retained child. It never starts
SolidWorks. That process qualification and real CAD qualification are pending.

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
suffixes are rejected. The corrected full process qualification remains pending.
The native process remains directly retained by the prepared runner. Every
launch intent is acknowledged before start, with bounded spare capacity for
terminal and uncertain observations. Final `attempt-journal.json` contains the
canonical acknowledged history; the supervisor binds its bytes and head digest.
Legacy v1 and preview calls omit journal state and keep their existing path.

Startup deadline classification is emitted only at explicit pre-operation
GUI/API readiness deadline boundaries. It still needs native fault qualification
and separate trusted stop admission; it never authorizes retry locally.

Remaining OVD-503 work: qualify actual runner launch/exit coverage and complete
owned-process boundaries, qualify finite native failures and Windows faults, run
repository checks and reviews. HTTPS dispatch, privileged admissions and artifact
finalization remain separate integration work. Preserve all synthetic/native
evidence; rollback disables journal-enabled execution instead of deleting history.
