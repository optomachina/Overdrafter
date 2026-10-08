# X1 inert workstation qualification (preliminary, pinned commit aa2cbaf, 2026-10-05)

Source: workstation session workstation-fizzy-candle (session_01Arrb2Hh45KQcEPJXM26MBy), report in its transcript (result event 5b09026e, 15:59:38Z).
Permission: Blaine, 2026-10-05 ~08:24Z: X1 inert suites only, zero native calls, do not touch the retained OVD-578 SolidWorks session.

## Phase 0
- Host WORKSTATION, user workstation\blaine; Windows NT 10.0.26300 build 26300.9550; 47.11 GB free on C:.
- Windows PowerShell 5.1.26100.9549 Desktop, 64-bit; no pwsh 7.x on PATH.
- SolidWorks 2022 at C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe, FileVersion = ProductVersion = 30.5.0.0049. 2 SLDWORKS processes running (retained OVD-578 session), untouched before/during/after.
- Repository: 11 checkouts on the machine; used the standalone clone C:\Users\blain\Documents\Codex\ovd520-0fc49af0 (HEAD 0fc49af detached, clean, remote optomachina/Overdrafter); avoided the OVD-578 worktree. git fetch created origin/main (now 1d3f2d4); aa2cbaf present.
- Other agents active (Claude desktop/CLI, Codex, node, powershell); none referenced the checkout path; none stopped.
- Standalone Roslyn csc.exe: C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe (4.1200.24.57207). Earlier ovd509 receipts used only the .NET Framework csc (not Roslyn).

## Phase 1 (detached worktree at aa2cbaf under $root\src)
$root = C:\Users\blain\AppData\Local\Temp\ovd520-x1-202610050830; runner $root\run-x1.ps1; started 08:35:31-07:00, finished 08:37:54-07:00.
summary.json SHA-256 3e4300e1ffacd327801972c88763f08d3a39d4c4af3d8f7b2d660eeadd39280d; manifest.sha256 (177 files) SHA-256 7abe5cc380aca6e7fc9e27ff542c5a1b53393d1743613137589ca374f8c43e69.
nativeCalls 0; sldworksProcessesObserved 2.

| Suite | Exit | s | Outcome | Wrapper receipt SHA-256 (prefix) |
|---|---|---|---|---|
| file-admission qualify.ps1 | 0 | 1.05 | passed | 857ad8c8 (suite result.json 39a8f4b7) |
| file-admission test-prepared-filesystem-admission.ps1 | 0 | 6.10 | passed | 37907c98 (suite result.json ddd9a223) |
| worker-companion test-state | 0 | 1.93 | passed | 920e2c16 |
| worker-companion test-boundaries | 0 | 0.97 | passed | ea8c4b11 |
| worker-companion test-task | 0 | 1.29 | passed (runner JSON parse corrected by hand from the unchanged log: passed true, 20 assertions, nativeActions 0, trailing line "Review regressions passed; total task checks: 27") | 8356aa06 |
| worker-companion test-artifact | 0 | 1.03 | passed | 3466b5d4 |
| worker-companion test-runtime | - | - | SKIPPED (dot-sources prepared-dimension/run.ps1 -Execute with an expired deadline; rejected at run.ps1:56 before any SolidWorks/COM code; left for the coordinator because the hard limit forbade run.ps1) | - |
| worker-companion test-runner-effect-gate | 0 | 9.68 | passed | 8c3fee78 |
| stop-observer test-manifest | 0 | 22.31 | passed | 29a11f51 |
| stop-observer test-windows | 0 | 96.41 | passed | 7bfd1d5a |
| prepare-runtime.ps1 -Prepare (VS2022 Roslyn) | 0 | 2.54 | passed; runtime-profile.json SHA-256 83027b60a4fe4180ddeba2340a5f1c1fde8e634959b54a726424d31e0f69ef5a | 4b5b0c79 |

Only qualify.ps1's own receipt records the commit (-SourceCommit); every suite also has a wrapper receipt at $root\receipts\<suite>.json with commit, command, exit code, log SHA-256 and the suite JSON.

## Deviations / side effects
- Writes outside $root: origin/main ref created in the clone by the fetch; worktree registered under the clone's .git/worktrees. Clone unchanged (HEAD 0fc49af, clean).
- TEMP/TMP/RUNNER_TEMP pointed at $root\tmp; test-prepared-filesystem-admission briefly created and removed a subst drive letter.
- qualify-process.ps1 not run (README: launches real child processes).
- Runner started with -ExecutionPolicy Bypass; suites started without it.

## Status
Preliminary platform qualification at aa2cbaf: PASSED for 10 suites, test-runtime pending the coordinator decision (follow-up sent 16:2xZ to run it under the same limits). X1 must be repeated at the activation commit (main after A4 #576 and A7 #582 merge, plus any #565 decision).

## Follow-up (16:27Z): test-runtime.ps1 not run
The workstation's auto-mode permission check blocked the one-suite runner (it treats a script that reaches prepared-dimension/run.ps1 as interfering with running workloads). Nothing changed: summary.json and manifest.sha256 hashes unchanged; test-runtime stays "skipped"; SLDWORKS 2 untouched. To include it, Blaine must approve that single run in the workstation session (or run it himself). The X1 packet otherwise stands at 10 passed, 1 skipped, 0 native calls.
