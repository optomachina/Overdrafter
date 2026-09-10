# Native attempt journal

OVD-503 implements the durable process-evidence layer for the private automatic
engineering loop. This directory is under active implementation. The contract
and Windows storage exist; the prepared runner does **not yet write this journal**.
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

The caller must persist an initial empty journal, then one event per append.
Before any launch it must reserve enough remaining journal capacity for creation
and terminal observations and acknowledge its launch intent. No native effect is
permitted after an unresolved write. A launch-intent/creation gap requires the
separate recovery procedure, even if process-name inventory is empty.

## Verification

```powershell
powershell.exe -NoProfile -File scripts/native/attempt-journal/test-contract.ps1
powershell.exe -NoProfile -File scripts/native/attempt-journal/qualify-store.ps1 -QualifyStorage
```

The contract suite uses synthetic in-memory records and no native execution.
`qualify-store.ps1` requires Windows Desktop 5.1 x64 and explicitly creates a
retained synthetic encrypted store. It tests exclusive ownership, restart,
append/rollback constraints, a locked-destination replacement failure and changed
boot rejection. It never pairs a worker, issues credentials or launches CAD.
Storage qualification is pending; Core parsing is not Windows persistence proof.

Remaining OVD-503 work: connect the journal to every actual runner launch/exit,
capture finite native failure evidence, qualify Windows fault boundaries, run
repository checks and reviews. HTTPS dispatch, privileged admissions and artifact
finalization remain separate integration work. Preserve all synthetic/native
evidence; rollback disables journal-enabled execution instead of deleting history.
