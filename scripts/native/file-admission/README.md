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

Both qualification drivers load the copied, hashed `OwnedProcess.ps1` helper.
The file driver now records four source files, including this helper. Existing
three-source receipts remain historical evidence for the earlier implementation.
Argument validation, per-stream capture and log-write errors retain any known
PID and exit result. Available output from one stream survives failure of the
other stream. A logging error still fails the invocation.

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

## Qualify process failure reporting

Run the separate synthetic process lane before using this helper for further
native recovery experiments:

```powershell
powershell.exe -NoProfile -File scripts/native/file-admission/qualify-process.ps1 `
  -SourceCommit (git rev-parse HEAD) -OutputRoot "$env:TEMP\OverDrafter-qualification"
```

It compiles only `ProcessProbe.cs`, runs the actual shared helper, and preserves
each observation under a new attempt directory. Source labels remain caller
claims; copied source hashes, compiler identity and binary hashes are recorded.
The process result includes exit/PID observations, errors, elapsed time, output
lengths and hashes. Full captured output stays in private log files.

| Case | Required observation |
| --- | --- |
| Substantial stdout and stderr | Exact output from both streams and exit zero |
| Nonzero exit | Exit 23 and both output markers retained; invocation fails |
| Missing executable | Finite start error, no PID or exit fabricated |
| Invalid argument or timeout | Reject before launch, preserving a failed receipt |
| Sleeping child times out | Timeout and observed owned-child termination retained |
| Injected capture-start failure | Error retained and actual owned sleeper cleaned up |
| Injected pending capture task | Bounded capture failure with known exit and available stdout retained |
| Log destination is a directory | Logging fails without discarding the known PID, exit or captured output |

There are nine cases: invalid arguments and invalid timeouts are separate.
A passing adverse case means the expected failure was observed, not that the
underlying invocation succeeded. An independently owned instance of the same
probe must remain alive after every case and then exit through its release
marker. Sleepers and the control have their own 30-second maximum lifetimes.
The helper limits a requested process wait to 1–600,000 milliseconds, with
separate five-second cleanup and capture waits. These are bounded waits in a
trusted local fixture, not a universal deadline guarantee for arbitrary storage.

The two capture injections use real child processes but substitute capture
behavior through an internal test seam; they do not reproduce an OS pipe fault.
The helper uses [Kill()](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill?view=netframework-4.8.1)
on its retained process and separately observes exit. It does not contain a
process tree. Failed OS termination, lost host connectivity, actual CAD recovery,
license ownership and filesystem/network isolation still require separate proof.
After changing the shared helper, rerun both this lane and the five file cases.

Use short source and output locations such as the temporary-directory example
above. The demonstrated Windows run kept every artifact path at or below 138
characters. A 274-character copied-helper path produced a misleading unsigned
script error even though no download-zone stream was present; the same source
passed at short paths with `RemoteSigned` unchanged. This does not qualify
general long-path support. Preserve such failures and inspect the actual path
and policy before changing any trust setting. The
[feasibility record](../../../docs/solidworks-2022-feasibility.md#owned-process-adverse-case-tooling)
retains both attempts and the qualified scope.
