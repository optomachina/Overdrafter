# Prepared synthetic dimension adapter

Internal OVD-490 operator handoff for one existing synthetic assembly. The runner
accepts an exact context and job, creates one independent private candidate, edits
the baseline cylinder depth from 5 mm to a requested 6–10 mm, and writes a result
bound to the exact request bytes. Results always retain `adoption: "unadopted"`.
There is no worker service, authenticated result origin, automatic transport, PDM
publication, production API or customer-file admission.

## Capture context without native actions

On Workstation, from the repository root in x64 Windows PowerShell 5.1:

```powershell
$package = 'C:\Users\blain\Documents\Codex\2026-09-06\create-a-new-assembly-in-solidworks\outputs\ovd-480-native-fixtures\assembly-inspection-02-7bb43d1c3d0644d0bdcf5da32c1b2dc7'
.\scripts\native\prepared-dimension\capture-context.ps1 -PackageRoot $package -OutputPath C:\Temp\prepared-context.json
```

The capture script reads and hashes exactly the three declared native files. It
does not open SOLIDWORKS or inspect geometry. It accepts only the preserved
assembly, 5 mm baseline and 8 mm companion identities. The assembly template is
neither read nor copied. Context output uses strict UTF-8 without BOM, includes a
UTC timestamp, must be outside the original package, and cannot overwrite an
existing output. Its digest identifies
the exact JSON bytes, including whitespace. Import those exact bytes into the
internal UI before exporting a job.

## Explicit native evaluation

```powershell
.\scripts\native\prepared-dimension\run.ps1 -Execute `
  -RequestPath C:\Temp\prepared-job.json -ContextPath C:\Temp\prepared-context.json `
  -PackageRoot $package -OutputRoot C:\Temp\prepared-runs
```

Without `-Execute`, the driver stops before admission or native activity. The
request must match the frozen `overdrafter.prepared-dimension-job.v1` contract,
including its scope, context digest, input identities and all seven required
checks. Numbers must be finite JSON numbers; timestamps use millisecond UTC ISO
format. A malformed job or unsafe output location is denied without an
importable result. Once a job is
validated, later failures produce a job/request/context-bound failed result when
the output filesystem permits it. Input identities in failures contain only
actual observations; missing/unread files do not receive invented hashes.

The output root must be short: the attempt directory is limited to 100 characters.
Each request's `attemptId` names its directory. An existing attempt directory
prevents replay under that output root. A session-local mutex also excludes
another cooperating runner during native activity; this is not a durable queue
lease or protection against arbitrary processes or a second output root's
retained history being removed.

The driver:

1. Saves the exact request/context bytes, measures the original files, copies only
   the three native documents, and verifies each private copy's original hash.
2. Copies/hashes its sources and the existing lifecycle/process helpers, then
   compiles them with the pinned installed x64 .NET Framework compiler.
3. Requires no existing SOLIDWORKS process, directly starts and retains one, and
   checks its executable hash/version, PID, start time, session and API identity.
4. Preloads both private parts read-only, opens the private assembly read-only,
   and verifies the actual loaded document identities, private reference paths,
   `Default` configurations and fixed component transforms **before editing**.
   Resolution to an original source path stops the attempt.
5. Closes the package, edits only the private baseline's declared extrusion with
   the assembly closed, saves, then reopens and measures the part read-only.
6. Preloads the parts read-only again, rebuilds/verifies/saves the private assembly,
   then closes and reopens the entire private package read-only for verification.
7. Closes known private documents assembly-first, requests normal native ExitApp
   through the existing lifecycle probe, observes exit 0 and empty inventory,
   and rechecks original and candidate file hashes.

Only complete success emits all seven passing checks, actual measurements and
the three output identities. The target part must change; the companion part's
exact original hash and length must remain unchanged. Each check refers to a
retained raw report hash. `result.json` is created once and can be imported into
the UI; `supervisor-final.json`, compiler/helper logs, copied sources, settings
and the candidate remain alongside it. A supplied `-SourceCommit` is only a
provenance label; copied source hashes identify the actual executable inputs.

## Failure and qualification boundaries

The normal read-only/native-close helper is reused without modification. The
owned-child launcher imposes a 30-second compile/lifecycle-helper deadline and
180 seconds for the operation probe, plus its separate bounded capture/cleanup
waits. GUI readiness has 60 seconds, followed by a separate 60-second API
readiness budget. Only the existing explicitly classified startup-not-ready
observations are retried. Edits, saves and uncertain close requests are not.

Helper timeout cleanup can terminate the retained **helper**. The driver never
forces native termination or automatically closes native documents after a
failure. The native process, partial files and failure records remain for explicit
reconciliation. A failed native start/operation/close sets `recoveryRequired` in
the supervisor record; that flag grants no additional action authority.

This uses the already accepted experimental Windows/SOLIDWORKS environment and
shared profile. Run in an operator-free interval. It does not establish filesystem
or network isolation, licensing ownership, race/reparse resistance, complete
auxiliary dependency closure, interruption recovery, reliability, or portable
reference relocation beyond the actual private-path observations. No settings,
security policy, add-ins, registry values or licensing configuration are changed.
Application startup and saves can perform their ordinary profile/journal writes.

The native checks derive from native04 `Fixture.cs` / `PartVerification.cs` and
the corrected `Assembly.cs` (`52aed1c98aa36e181ff368a465a7057c885687263999949f6a9c3c10492e0439`).
Assembly load warning 32 is retained and admitted only with successful rebuild;
other warning bits stop the attempt. Part loads require zero errors/warnings.
Geometry checks preserve extrusion semantics, body counts, finite mass values,
analytic cylinder volume/area/center tolerances and test density 1. The three
unused transform-array slots remain finite diagnostics.

The new adapter requires its own exact-source Windows compile, inert admission
checks and live request-bound run. Historical native qualification does not by
itself qualify this new edit/save workflow. Do not treat source review as a live
success or import a fabricated successful result for the UI demonstration.
