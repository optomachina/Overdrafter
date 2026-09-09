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

The C# probe does not create or open CAD documents and does not acquire a native
process through COM activation. It binds an existing registered application only
after checking the exact expected singleton process. `inspect` observes an empty
session; `graceful-close-empty` adds a fresh identity/document check and normal
application shutdown.

## Qualification limits

This proves only the specifically recorded empty-session lifecycle. The
existing Windows profile and application startup configuration are shared.
Application startup may perform its normal profile/journal writes; the runner
does not change journal, add-in, security, licensing or registry settings. It
does not qualify filesystem/network isolation, customer-file admission,
deployment entitlement, worker leases, CAD mutation, crash/hang recovery or
interruption during a native save. See
[`docs/solidworks-2022-feasibility.md`](../../../docs/solidworks-2022-feasibility.md)
for observed results and unresolved work.
