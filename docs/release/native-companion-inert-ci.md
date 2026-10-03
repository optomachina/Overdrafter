# Four-suite Windows source qualification

This isolated workflow qualifies the reviewed companion source with Windows
Desktop PowerShell 5.1 on a disposable `windows-2022` GitHub runner. It does not
qualify installation, pairing, DPAPI, native execution, remote connectivity,
Storage, or CAD. The four scripts are `test-state.ps1`, `test-boundaries.ps1`,
`test-task.ps1`, and `test-output-replay.ps1`. The last suite must exercise its
synthetic, temporary Windows disk replay branch (`disk: true`).

## Delivery and execution

The release owner must first integrate and publish this reviewed patch with the
required `f4f0a087f041078244bbb28e081fe96d6418d036` source (or its reviewed
descendant). This patch does not publish, dispatch CI, or alter PR 564. A matching
pull request runs the workflow on **the exact PR head**, not GitHub's temporary
merge commit. Manual dispatch uses the selected ref's resolved `github.sha`;
GitHub may require the workflow on the default branch before offering dispatch.
Record the reviewed SHA and compare it with the Actions run and uploaded summary.
No Library download, repository secrets, dependency installation, private
credentials, or workstation access is required. Existing hosted runner allowance
and Actions availability are prerequisites; no new paid runner is provisioned.

`scripts/native-companion-inert-ci.mjs` checks `OVD_EXPECTED_SHA`, a clean tracked
checkout, then hashes every tracked `scripts/native` file plus the harness and
workflow. The existing `scripts/native/.gitattributes` retains LF source bytes for
native admission hash pins on Windows. It probes the fixed Windows Desktop executable and rejects
any runtime except x64 5.1. Each of the four scripts runs as a separate direct child with no
profile, no shell, no execution-policy override, a 60-second deadline and a
1-MiB limit per output stream. Only a small ordinary Windows environment allowlist
is inherited. No native worker or live transport entry point is enabled.

Every suite requires direct exit code zero, one complete JSON document, exact
schema, positive integral check count, `passed: true`, `network: false`, and
`nativeActions: 0`. Suite-specific inert flags and probe/version agreement are
checked. Failed suites do not prevent collection of the other three. Source hashes
are rechecked afterward. A timeout kills only the owned direct test child; the
8-minute job bound and disposal of the hosted VM bound any descendant cleanup.
The harness must not be used to manage a persistent workstation or its processes.

Evidence includes `summary.json` with checkout SHA/tree, source hashes, runtime,
per-suite command, timestamps, exit/result and log byte hashes, the runtime probe,
and bounded raw stdout/stderr logs. Invalid UTF-8 or duplicate JSON keys fail. Actions
uploads these on success or failure for 14 days. Missing evidence fails upload.
Only a passing exact-head run with all four results is PowerShell inert evidence;
a source review or Linux harness test is not a Windows pass.

## Local source verification

`node --test scripts/native-companion-inert-ci.node-test.mjs` exercises acceptance
refusals and actual disposable Node subprocesses: nonzero exit, timeout, bounded
output, missing executable. It does not execute PowerShell. The harness itself
refuses non-Windows hosts with a failed summary and zero suites.
