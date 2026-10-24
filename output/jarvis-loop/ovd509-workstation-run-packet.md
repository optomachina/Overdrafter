# OVD-509 Workstation qualification packet

Source branch: `codex/ovd-509-trusted-admission` at
`9a4d2486b10f51b56811fc20c1fff3798f661002`. The branch is published.
Use a clean, isolated checkout at this exact commit on Workstation. Retain all
previous checkouts, attempts, candidate directories and receipts. Do not turn an
older native receipt into current-source evidence.

## 1. Current-source synthetic filesystem cases

From the isolated checkout in **x64 Windows PowerShell 5.1**, with a pre-existing
short output parent:

```powershell
git rev-parse HEAD
New-Item -ItemType Directory -Path C:\Temp\OD509 -Force | Out-Null
powershell.exe -NoProfile -File scripts/native/file-admission/test-prepared-filesystem-admission.ps1 `
  -OutputRoot C:\Temp\OD509
```

Require the printed fresh `result.json` path, `outcome=passed`, all 14 case
records passed, `nativeCalls=0`, and the receipt's `sourceSha256` matching the
current `PreparedFilesystemAdmission.cs`. An exception, missing receipt, skipped
symlink setup, or an unexpected mutation is a failure. Preserve the case root.

## 2. Fresh synthetic native 5 → 7 mm attempt

This is eligible only after step 1 passes and the exact prepared 5 mm package,
SolidWorks 2022 SP5 runtime/compiler identity, clean native process inventory,
and an exported v1/v2 `set depth to 7 mm` job are confirmed. Capture a **new**
context outside the original package, export a job bound to its exact bytes,
and run once with a new attempt ID and short, pre-existing output root:

```powershell
powershell.exe -NoProfile -File scripts/native/prepared-dimension/capture-context.ps1 `
  -PackageRoot <exact-prepared-package-root> -OutputPath C:\Temp\OD509\context-<new-id>.json
powershell.exe -NoProfile -File scripts/native/prepared-dimension/run.ps1 -Execute `
  -RequestPath <exported-7mm-job-path> -ContextPath <matching-context-path> `
  -PackageRoot <exact-prepared-package-root> -OutputRoot C:\Temp\OD509 `
  -SourceCommit 9a4d2486b10f51b56811fc20c1fff3798f661002
```

The context filename, job and attempt ID must be actual fresh values; placeholders
are not executable instructions. Do not retry an uncertain or partially started
native attempt. Inspect the new `result.json`, `supervisor-final.json`,
`source-preservation.json`, original hashes, candidate hashes, seven checks,
actual 7 mm target and unchanged companion measurements. Require
`filesystemAdmission.status=rechecked`, matching host and attempt, and
handle-derived input/candidate volume serial and file IDs. Confirm the native
process exited and no SolidWorks process remains before classifying failure or
starting another attempt. Preserve all receipts and logs.

## Current boundary

The prior `1dbce683` synthetic attempt exited 1 during receipt construction
with a PowerShell 5.1 `ArgumentException`; its fixture and stdout/stderr remain
at `C:/temp/ovd509-1dbce683-e41fed9c` on Workstation. The corrective
`9a4d2486` source changes only the case-list conversion. Its fresh receipt at
`C:/temp/ovd509-9a4d2486-0e0f1ffd/ovd509-3f79287aefe049459ff9ae0268c5f47c/result.json`
passed 14/14 named cases, with `nativeCalls=0` and unchanged source SHA-256.
The 14-case receipt qualifies only the synthetic filesystem cases on the exact
head. The native run below is separate; neither receipt qualifies the connected
server.

The historical seed was denied before an attempt was created because its root
contains `template/` and `assembly-manifest.partial.json` in addition to the
fixed package. Workstation retained that failed preflight. It then copied the
three pinned CAD files into a new minimal input at
`C:/temp/ovd509-clean-582c9de3/input`, captured a new exact context, and wrote
a new 7 mm job with attempt ID `11ebefda-f517-458f-aea7-bab8b4523a2e`.
That native run passed seven checks and measured 5 → 7 mm. The retained attempt
is `C:/temp/ovd509-run-582c9de3/11ebefda-f517-458f-aea7-bab8b4523a2e`;
`result.json` SHA-256 is
`177d7137b48240d419416f2faceac80d5dc2006c008a022ac6dd1ceacbf830ee`,
and `supervisor-final.json` SHA-256 is
`21a5f53bde545fe7b7382a36f9b1dfa448cd3b1e86d5a56eae1ab5cbb0207057`.
The candidate is unadopted and no connected server result was claimed.

This packet does not authorize customer files, PDM writes, a database change,
production activation, credential changes, candidate adoption or a retry after
ambiguous native exit. Workstation is connected through its existing Codex task;
available direct SSH accounts from this Mac were denied. Source-only Mac
verification passed; native compatibility remains unproved.
