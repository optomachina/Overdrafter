# Independent Windows stop observer (OVD-574)

Default-off source component for one prepared attempt. `Observer.ps1` runs in a
separate trusted observer process and never calls CAD, a gateway, a registry, or
an admission API. It does not connect the companion runner automatically.
Parent OVD-562 and its draft PR #543 remain incomplete. This child is based on
main and reuses the main journal/store/runner/retained-identity contracts.

## Evidence contract for later children

`manifest.schema.json` describes `overdrafter.native-stop-observer.v1`.
`fixtures/{request,journal,observation,manifest}.json` are synthetic consumer
examples, not Windows/native qualification. Canonical bytes use the existing
`ConvertTo-JournalJson`: ordinal object keys, ASCII JSON, escaped UTF-16 code
units, integer numbers, no whitespace/BOM/newline. Hash exact UTF-8 bytes with
SHA-256. A manifest carries the exact journal byte digest and chained head.
Consumers must retain both immutable files and validate their exact bytes.

The certificate binds the complete journal binding (attempt, fence, boot,
installation, worker, task, job, scope and runtime admission), independently
supplied context digest and deadline, fresh observer run ID, observer version,
root and child creation identities, retained-handle terminal observations,
job lifetime process count, zero active/limit-terminated counts and outcome.
Creation times are decimal .NET UTC ticks, not PID-only or wall-clock strings.
All observations must fall within the same bounded run (maximum ten minutes).
No launch or terminal gap can be repaired using this observer's output.

`terminalProcesses` uses the existing `TrustedStopEvidence` terminal shape.
The current lane rejects journal `terminationRequested=true`: Windows exit
codes cannot establish that flag's provenance. No termination claim is copied
as independently measured fact. A compiler-only fixture is a complete stopped
set but reports `native_failed/unclassified`, never native result success.

This new schema is deliberately **not** the older
`overdrafter.native-stop-evidence.v1` admission manifest. A later registry /
validator attribution child must authenticate the pinned observer/runtime,
retain and revalidate the source certificate, and explicitly construct the
trusted interface. It must not accept caller-supplied `processBoundaryComplete`
or rename this schema to gain authority. `stopAdmission` and
`nativeQualification` are always false. Atomic SQL stop and transport are
separate children. Syntax/schema/hash validity alone never authenticates a
producer, grants a retry, releases occupancy, or verifies result artifacts.

## Independent observation basis

1. Before executing the root, create an unnamed, non-inheritable Windows job
   with neither breakaway mode. Create the exact root executable suspended,
   assign it to that job, verify membership and initial accounting, capture
   retained identity, then resume exactly once. On failed assignment, terminate
   only the directly created, still-suspended root and emit no certificate.
2. Poll the bounded job PID list and retain each newly observed process handle.
   Query job membership, creation identity, image, session, content digest, and
   its parent while the retained root is live. Only direct root children are
   admitted. PID reuse and late adoption fail. The job holds at most 129 observed
   identities (root plus 128 journal launches); truncation/API failures fail.
3. For each retained handle, observe signaled exit, exact identity and exit code
   before closing that handle. This lets job accounting reach zero without
   reopening terminal PIDs. Job lifetime count must equal all captured unique
   identities, so even an unobserved short-lived in-job child causes rejection.
4. Require terminal root, every captured exit, zero active processes and no
   limit termination. Acquire the existing journal store's exclusive lock and
   read one bounded DPAPI snapshot. Replay the existing journal and require a
   bijection between journal launches and independently observed children.
5. Check monotonic and UTC budgets throughout. Errors poison this invocation;
   no restart reuses its output directory. Create-new private files are flushed,
   and only a final non-overwriting rename publishes `manifest.json`. Missing,
   partial or pending files have no evidentiary value. Closing the observer job
   kills remaining in-job fixture processes, but never certifies their exits.

A fresh private output directory is mandatory. Claim files and failed partial
outputs remain for diagnosis. No existing file/directory is removed or reused.
The trusted caller supplies the exact request and pinned executable/arguments;
this library is not a worker-facing untrusted launch service.

## Threat model and limitations

This is independent observation in the inherited **trusted Windows user**
model. A hostile same-user process can tamper with scripts, files, requests,
executable hashes or the observer. CurrentUser DPAPI and a separate process do
not provide adversarial producer authentication. Later restricted attribution
is required before any trusted stop-store connection.

The certificate covers the qualified direct-`CreateProcess` job envelope only.
[Windows job inheritance excludes broker-created processes such as
Win32_Process.Create](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
COM/service/WMI activation and arbitrary descendant containment are not proven;
they must not be admitted by a production caller under this certificate. A real
SolidWorks prepared attempt needs separate runtime qualification establishing
its actual launch envelope. A job's missing completion notification is also
not proof: this implementation uses lifetime accounting, retained handles and
an exact terminal set, never notification completeness or empty process names.
[Microsoft documents lifetime and active accounting here](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information).

## Verification

- `pwsh -NoProfile -File scripts/native/stop-observer/test-manifest.ps1`: synthetic
  valid four-role manifest, canonical fixture, identity/launch/unknown-child /
  PID-reuse/terminal/deadline/observer-loss denials and default-off behavior.
- Windows Desktop 5.1:
  `powershell.exe -NoProfile -File scripts/native/stop-observer/test-windows.ps1`
  starts fixed inert non-console children through the actual suspended-root job
  path, writes actual synthetic DPAPI journals, checks a complete stopped set,
  unknown child, ambiguous intent, missing terminal and killed observer.
- `.github/workflows/stop-observer.yml` runs both on `windows-latest`. The actual
  Windows job proof and source gates are required before source acceptance;
  local synthetic tests alone cannot prove Windows behavior.

The ordinary `powershell.exe` ConsoleHost path is **not qualified**. Detached
ConsoleHost exited before script entry; CREATE_NO_WINDOW entered but introduced
an unjournaled `conhost.exe`. Supported console APIs did not supply a durable
root-to-host association after console loss. No infrastructure exemption exists.

`PreparedPowerShellHost.cs`, compiled as WindowsApplication before observation,
hosts the actual installed Windows PowerShell5.1 engine in one STA runspace.
It executes the same script with global dot-source function lookup. The CLI is
an absolute script path, lowercase expected SHA256, then up to32 unique named
parameters: `-Name` followed by a literal string, or `+Name` for a true switch.
Parameter names are case-insensitively unique; values never become source code.
The hashed script stays open without write/delete sharing during execution.
The trusted caller must independently pin imported modules and assemblies.

The host verifies the runspace engine version, provides no interactive UI or
profiles, and drains success/error streams into inherited standard pipes.
The outer pipeline propagates the dot-sourced script's `LASTEXITCODE` through
`SetShouldExit`. Explicit nonzero `exit` codes survive normal unwind; any error plus `exit 0`,
host-policy failure or output failure denies success. The supported prepared script surface uses the owned ProcessFactory for all
compiler/native/lifecycle/operation launches and performs no broker/COM/WMI
activation. The trusted caller must review/admit the exact script and imports;
SHA binds admitted bytes and does not establish that code is safe.

This full-language host is not a sandbox and does not guarantee rejection of
all unsupported operations before execution. Native pipeline commands may run
without a host notification; application visibility is also insufficient inside
a dot-sourced script. An actual extra unjournaled native command in the otherwise
valid four-role fixture must instead trigger the independent unknown/parent/
count/journal guard and publish no certificate. The test requires a real extra
lifetime count or side-effect marker, not merely a generic script error.
[Microsoft documents the hosting API](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.host.pshost)
and [explicit exit handling](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.host.pshost.setshouldexit).

The Windows suite retains GUI denial fixtures, but acceptance additionally
requires this actual PowerShell engine root, actual `csc.exe`, and real inert
console native/lifecycle/operation roles: exactly five observed processes and
four journal launches, with authority/deadline and redirected-stream proof.
Host tests cover explicit failure exits, errors, literal arguments/output,
interactive rejection, script-content locking and actual unjournaled-launch denial. GUI success alone
cannot satisfy this source acceptance. The suite is restored as the normal
workflow entry; results must pass before the new envelope is qualified.

## Parent OVD-562 integration contract

The parent remains responsible for adoption; its existing launch path is not
silently qualified by this source addition. It must make these changes together:

1. Build and pin `PreparedPowerShellHost.cs` as WindowsApplication against the
   installed Windows PowerShell5.1 engine, plus `DetachedProcess.cs` and
   `JobBoundary.cs`, before starting observation. Launch this host with the
   pinned prepared entry script and named parameters, not `powershell.exe`.
   Precompile and load filesystem admission together with its existing
   `PreparedFilesystemAdmissionSourceBinding.SourceSha256` before dot-sourcing
   the parent runner, so its guarded Add-Type path does not launch an unrecorded
   compiler. A pinned prepared bootstrap can load these pinned assemblies;
   neither the bootstrap nor parent adoption is implemented by this child.
   Use a separate trusted observer with the exact prepared request and deadline.
2. Supply exactly the two anonymous authority server channels through
   `AuthorityChannels`, and their client-handle strings as root arguments. After
   successful suspended creation the observer closes local client copies before
   resume. The caller retains server ends; the root owns inherited client ends.
   Failure before transfer leaves client-copy cleanup with the caller. Do not
   duplicate or retain extra ends that mask disconnection.
3. Use the detached primitive for every direct compiler, native, lifecycle and
   operation launch. `ProcessFactory` must return exactly one unstarted wrapper
   implementing the existing StartInfo, retained Handle/Id, standard streams,
   Start/WaitForExit/HasExited/ExitCode/Kill/Dispose surface. Omission preserves
   the existing Diagnostics.Process behavior. This wrapper supports the explicit
   executable, restricted quoted arguments, working directory and redirected
   standard streams used here; it is not a general ProcessStartInfo adapter.
4. Preserve the parent's remaining-deadline checks, journal-before-launch order,
   post-Start capture callback and authority/effect exchange. Capture callbacks
   can wait for effect messages and therefore run only after root/child resume.
   Keep operation stdin and all output drains live under their existing owners.
5. Consume only completed canonical evidence after independent reconciliation.
   Unknown processes, missed lifetimes, launch gaps, lost observers and expired
   deadlines still deny. Neither job cleanup nor pipe EOF supplies a certificate.

The Windows tests require authority EOF while a launched console helper remains
alive, then exercise a root blocked on withheld authority bytes until its deadline,
plus actual detached timeout and capture-callback failure cleanup. These are inert
source compatibility tests. Actual SolidWorks/PDM envelope qualification, effect
relay adoption, trusted attribution, SQL stop and transport remain separate work.

No CAD installation, PDM, customer file, real account/credential, database
migration, production service installation or provider operation is involved.
Disabling the opt-in invocation is the rollback; retain evidence and fix forward.
