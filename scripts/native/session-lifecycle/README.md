# Experimental SolidWorks session lifecycle

OVD-480 qualification tooling for the observed Workstation installation of
SolidWorks 2022 SP5. This is an operator-run experiment, not a production worker
or a sandbox. It uses the installed Windows PowerShell 5.1, x64 .NET Framework
compiler and SolidWorks interop; it installs nothing.

`lifecycle.ps1` is default-off. An admitted run creates a fresh attempt directory,
copies and hashes its source inputs, compiles `NativeSessionProbe.cs`, and uses
the existing `../file-admission/OwnedProcess.ps1` to observe compiler/helper
children. The supervisor separately retains the native process it starts.

If an existing empty session is supplied, its exact PID and .NET creation ticks
must match fresh observations. Only then may the typed helper request normal
`ExitApp`. Native exit must be observed before a replacement starts. A start
without an existing session requires that no SolidWorks process is present.
The new session must match the retained process's path, executable hash,
version, creation identity, session, API process ID and revision. The helper
checks that no documents are open before requesting normal shutdown.

After a bounded input-idle wait, API readiness has its own 60-second budget.
Only an unavailable COM registration or an explicitly incomplete startup may be
retried by read-only inspection. Every probe rechecks native identity; document,
identity, capture and release failures stop the run. Each probe timeout is capped
by the remaining readiness budget, with the shared helper's bounded cleanup and
capture waits potentially adding up to 15 seconds. Every observation is retained.

For a machine freshly confirmed to have no SolidWorks process, an admitted run
uses the repository checkout's driver:

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/native/session-lifecycle/lifecycle.ps1 -Execute -OutputRoot "$env:TEMP\OVD480" -ExpectedOldPid 0
```

For the explicitly selected existing empty session, provide its freshly
observed PID and UTC .NET `StartTime.Ticks` using `-ExpectedOldPid` and
`-ExpectedOldTicks`. A stale identity rejects the run. Do not supply CIM-formatted
creation times as .NET ticks or choose a replacement PID after a failed run.

Use a short output path outside user CAD folders. Supply the freshly observed
session identity explicitly, and review the receipt after each run. The process
identity and empty-document check are sequential with shutdown; the experiment
requires an interval without concurrent operator interaction. The script has
no native force-termination path.

The attempt retains source/compiler/binary hashes, helper logs, native identity
and exit observations, and a lifecycle receipt. A supplied source commit is a
provenance label; the coordinator must independently compare its Git blobs with
the recorded source hashes. Failed attempts stay failed, and unconfirmed native
exit requires reconciliation before another attempt.

Admission failures before any native start or close dispatch retain
`recovery_required: false`. Once a native start or close has been attempted,
subsequent failures conservatively require reconciliation, including missing
helper evidence. This flag never authorizes automatic native cleanup.

The default C# probe modes do not create or open CAD documents or acquire a native
process through COM activation. It binds an existing registered application only
after checking the exact expected singleton process. `inspect` observes an empty
session; `graceful-close-empty` adds a fresh identity/document check and normal
application shutdown.

## Controlled read-only interruption

The optional `-InterruptReadonly` case requires `-ExpectedOldPid 0`, an empty
native inventory, and both `-BaselinePath` and `-CandidatePath`. These are the
preserved native04 synthetic files: the 56,144-byte 5 mm baseline and 56,171-byte
8 mm candidate with the exact hashes recorded in the feasibility document.
The default lifecycle does not open files; fixture paths require this opt-in.

The driver prepares separate private baseline copies and immutable input
manifests for an interrupted attempt and a recovery attempt. The compiled
`PreparedCylinder` reader opens only the pinned baseline read-only, verifies
its sole Default configuration, empty references, extrusion semantics, body
counts and measured geometry, and performs an in-memory rebuild. It never
saves the document. This reader is extracted from the preserved native04 and
assembly-readback-03 sources; it is not general CAD-file admission.

After an independent helper inspection finishes, the driver flushes a new
checkpoint and rechecks the retained native process identity. It requests
termination only on that directly started process object and requires its
observed nonzero exit plus an empty native inventory. The interrupted attempt
keeps its own result. A fresh native process then opens the other private copy,
repeats verification and closes its document and application normally.

Original and private file hashes, per-attempt results and uniquely named logs
remain available. Failed or unknown termination, a stale identity, missing
evidence, unexpected documents or persistence failure stops the case. There is
no fallback process-name termination, automatic second interruption or failed
session cleanup. As with normal shutdown, native inspection and termination
are sequential and require an interval without concurrent operator interaction.

This case demonstrates interruption followed by fresh read-only verification
only when its Windows evidence passes. It does not establish interrupted-save
repair, task-lease recovery, independent Windows-profile containment or a
generally qualified worker.

## Qualification limits

### Prepared assembly recovery option

Add `-AssemblyPath <exact synthetic-assembly.SLDASM>` to the explicit
`-InterruptReadonly` invocation to select the three-file assembly case. Both
existing part arguments remain required. The top-level file must match the
59,987-byte pinned synthetic baseline; all three input hashes are checked
before native launch. Each attempt receives a complete private package with
the two parts under `parts/`, a unique identity and an immutable input manifest.

The `AssemblyRecovery.cs` adapter reuses the unchanged prepared-dimension
reader methods. The build explicitly selects `/main:NativeSessionProbe`;
neither the dimension-editing entry point nor its edit/save methods is invoked
by an assembly recovery mode. Opening preloads both private parts read-only,
then opens the assembly read-only. Inspection checks the actual loaded paths
and native object identities, sole Default configurations, two fixed resolved
occurrences, exact dependency closure, 5/8 mm cylinder geometry and component
placements. Rebuilds are in memory; the reader never saves these files.

The interrupted and fresh recovery processes each undergo these same checks.
Every private dependency and input manifest is rehashed around the case;
original file identities are retained and rechecked. The interrupted result is
preserved separately. A passing case reports
`passed_readonly_assembly_closure`, while general qualification remains
`incomplete`. This adds no claim about interrupted saves, arbitrary assemblies,
mate solving, drawings, licensing or isolated worker deployment. Windows
compilation and thirteen inert checks passed for source `7783ce2d`, followed by
one passing native case with 206 independently checked evidence assertions. See
the feasibility document for exact packet/source identities and the limits of
that demonstration.

Only the specifically recorded empty-session and read-only fixture cases have
execution evidence. The
existing Windows profile and application startup configuration are shared.
Application startup may perform its normal profile/journal writes; the runner
does not change journal, add-in, security, licensing or registry settings. It
does not qualify filesystem/network isolation, customer-file admission,
deployment entitlement, worker leases, CAD mutation, general crash/hang recovery or
interruption during a native save. See
[`docs/solidworks-2022-feasibility.md`](../../../docs/solidworks-2022-feasibility.md)
for observed results and unresolved work.
