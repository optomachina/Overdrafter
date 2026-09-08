# File-admission qualification fixture

Internal Windows regression tooling for OVD-480. It generates synthetic `.bin`
files and exercises the file predicates used by the experimental SolidWorks
reader. It does not open CAD files, invoke COM, install software, access a queue
or publish anything. The result is test evidence, not execution permission.

## Run on Windows

Use 64-bit Windows PowerShell 5.1 with the installed x64 .NET Framework compiler.
No project file, SDK install or NuGet restore is required. From this checkout:

```powershell
powershell.exe -NoProfile -File scripts/native/file-admission/qualify.ps1 `
  -SourceCommit (git rev-parse HEAD) -OutputRoot "$env:TEMP\OverDrafter-qualification"
```

The script creates a fresh named attempt directory beneath `OutputRoot`, prints
its `result.json` path and exits zero only when compilation, all five test cases
and output validation succeed. It retains copied source, hashes, the executable,
stdout/stderr and synthetic fixtures for inspection. Nothing is deleted.
`SourceCommit` is an optional caller-supplied provenance label; omit it when
testing uncommitted files, which records null. Source hashes identify actual
copied inputs. The script does not independently prove Git membership.

Compilation has a 30-second deadline; the test executable has 60 seconds.
The parent retains the exact process object and may terminate only its own
compiler/test child. Timeout, output-capture failure and unknown exit remain
failures. A killed process is never reported as a passing test. This uses the
bounded [Process.WaitForExit(Int32) contract](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit?view=netframework-4.8.1).
These limits do not qualify interruption or recovery of CAD effects.

| Fixture | Expected outcome |
| --- | --- |
| Correct synthetic file | Eligible for file checks only |
| Missing required file | Reject before attempting to hash the missing file |
| Same-size copy with one byte changed | Reject on digest mismatch |
| Existing file outside the allowed package | Reject before admission content read |
| Existing file in a similarly prefixed sibling directory | Reject before admission content read |

All fixtures, including the outside-package controls, live beneath the fresh
test root. Setup hashes and admission reads are counted separately. Original
control hashes must remain unchanged. Native-call count is zero by construction:
the executable references only framework libraries and these two source files.

## Provenance and limits

`SharedFilePredicates.cs` preserves the demonstrated methods with expanded
formatting and comments. The retrieved original source had SHA-256
`af9ecd6829796914f8522cc706b0e87f3ae0479a3238b4f65ac9907d5882ccbc`;
the extraction record had SHA-256
`ed1c234d2f40740cdcbf0207f1d27b844a7257fc035d87bb528c4a554472f3de`.
Both were verified on Workstation from `file-admission-01` before transcription.
The original assembly reader remains preserved; this fixture is not deployed
native preflight integration. See the [native feasibility record](../../../docs/solidworks-2022-feasibility.md).

These are Windows lexical path comparisons plus separately observed length and
SHA-256. They assume trusted, absolute paths and lowercase expected digests.
They do not resolve junctions, symlinks, alternate streams or other aliases,
validate arbitrary untrusted manifests, eliminate check/use races, lock files
against writers, establish complete CAD dependency closure or provide sandbox
isolation. Hashing retains the original shared-read behavior. Do not use a
passing result to admit customer files or authorize native execution/release.

Linux/macOS repository checks do not verify these Windows semantics. Run this
separate test lane on Workstation and retain the exact source/compiler/binary
hashes and receipt before reporting the fixture as verified.
