# X1 exact-source workstation qualification at activation-commit candidate 91bfa3c (2026-10-05)

Source: workstation session workstation-fizzy-candle (session_01Arrb2Hh45KQcEPJXM26MBy), result event 71afd6a9 (19:10:09Z).
Permission: Blaine 2026-10-05: X1 inert suites only, zero native calls, do not touch the retained OVD-578 SolidWorks session.
Commit: 91bfa3c4bdb46d9efd16adc1a36140ea092dcc68 = origin/main after D0 #575, C1 #586, A2 #590, A3 #593, A1 #594, A4 #576, A7 #582 merged. Tree: be4be284425fd15bfe45dca282247ad2f21a3e25. The #565 decision (open question) may still change the activation commit; if it does, repeat this run.

## Phase 0 deltas vs the aa2cbaf rehearsal
Unchanged: host WORKSTATION, workstation\blaine, x64 Windows PowerShell 5.1.26100.9549 Desktop, OS build 26300.9550, SLDWORKS.exe 30.5.0.0049, VS2022 Roslyn csc.exe 4.1200.24.57207, 2 SLDWORKS processes (untouched before/during/after).
`git diff --stat aa2cbaf..91bfa3c -- scripts/native` is empty (no native script changed). Clone HEAD still 0fc49af, clean. C: 46.97 GB free.

## Results ($root2 = C:\Users\blain\AppData\Local\Temp\ovd520-x1-91bfa3c-202610051206)
summary.json SHA-256 9b2c20c54a12c3e0ca353d8ed9c155564d47fd8ad8f91d3d354104c395a16bdb; manifest.sha256 (177 files) SHA-256 4e55e30be92f0f5d70fcd3087bb782e1afbb873c3fb5d5315736ee18c01d8912.
Started 2026-10-05T12:07:16-07:00, finished 12:09:37-07:00. nativeCalls 0; sldworksBefore/After 2/2. TEMP/TMP/RUNNER_TEMP under $root2\tmp.

| Suite | Exit | s | Outcome | Wrapper receipt SHA-256 |
|---|---|---|---|---|
| file-admission qualify.ps1 -SourceCommit 91bfa3c4 | 0 | 0.91 | passed | 4e93d390df63381b8d35656bf750f61303412ca8a583dd7a340522cf9f0175a5 (suite result.json f81d5ecea96711e2c52df9a11ceccf42f7a3bb0c75d776f13ed84ec2429b45a3) |
| file-admission test-prepared-filesystem-admission.ps1 | 0 | 6.20 | passed | 0edd35f63d5d13c6cfce1dc5255a1395f19af501ecf1b981dbb12dbdaa857f29 (suite result.json 82d414ec3e918d5e91a7dd5a61709794cd0f5c80362d9c82fc4365efdd56af15) |
| worker-companion test-state | 0 | 1.32 | passed | 4607503cbcbae407d3257b5d8a95ef330b9640ec76e68427b993a70f0dda6456 |
| worker-companion test-boundaries | 0 | 0.92 | passed | f4345535f5d927dbd3a34dcd1808aabf4d2ac8e0c1f8dd0ca8ed420faf011a67 |
| worker-companion test-task | 0 | 1.20 | passed (auto-classified; 20 JSON assertions, 27 total checks) | 4331ba02675b3941f409101a53455f1580c63a1d8f5c3baf02f3dc480370d0cb |
| worker-companion test-artifact | 0 | 0.89 | passed | 803d19617555ef43bdb5f351273e268ea31f7e328abea2ed5644665839a3a557 |
| worker-companion test-runtime | - | - | SKIPPED (workstation auto-mode permission check denied it twice; needs Blaine's approval in that session) | - |
| worker-companion test-runner-effect-gate | 0 | 9.60 | passed | 902f87ce084b490c5cb8dafb3b0156ba252cab1c5f1836c8288d451c6d4e1b4e |
| stop-observer test-manifest | 0 | 21.80 | passed | c6c9a1035563ba9287f1e4f2417e569533023e26a9c62fccda59d4672ef72bee |
| stop-observer test-windows | 0 | 95.71 | passed | 07d029065a1344c80a2969af694bc0341d76bc4d4aa44206db03e37a9b106342 |
| prepare-runtime.ps1 -Prepare (VS2022 Roslyn) | 0 | 1.93 | passed; runtime-profile.json SHA-256 0955b4466bcb5d14cf625f48ff09169bdeb1589bae6aa1d474b2bdeaa85da06a (differs from the aa2cbaf profile: freshly compiled binaries) | 9247f8cc6f40ccb6f721e548811e4febae8e042724453610e3ee5dd13c130fee |

Every wrapper receipt at $root2\receipts\<suite>.json records the commit, command, exit code, SLDWORKS before/after, log SHA-256 and the suite JSON.

## Side effects
Temporary subst drive created and removed by test-prepared-filesystem-admission; two suites delete their own temp dirs under $root2\tmp; runner started with -ExecutionPolicy Bypass; the earlier aa2cbaf $root and worktree untouched; new worktree left in place.

## Status for the protected readiness packet (section B, X1)
PASSED for 10 inert suites at the exact source 91bfa3c with native calls 0 and the retained SolidWorks session untouched. test-runtime remains the one open item (blocked by the workstation permission policy, not by the suite). Runtime profile path and SHA-256 recorded above for `run-task.ps1 -RuntimeProfilePath/-RuntimeProfileSha256`.

## Update 2026-10-08T07:26Z: test-runtime at 91bfa3c4 (session-reported; receipts not yet read from this session)

Source: workstation session workstation-fizzy-candle, result event at 2026-10-08T07:26:33Z (read by the coordinator from the session transcript; origin human = the owner's prompt). Permission: owner's prompt of 2026-10-08 approved the suite's permission check.

| Suite | Exit | s | Outcome | Wrapper receipt SHA-256 |
|---|---|---|---|---|
| worker-companion test-runtime (via companion runner `$root2\run-x1-test-runtime.ps1`, added because run-x1.ps1 skips this suite) | 0 | 39.02 | passed; nativeActions 0; network false; SLDWORKS 2/2 untouched | de5880d83c571a9a55dc9d85b85bf727c688db7b2e4d616ec5c693eaa4f00060 |

summary.json SHA-256 now ad84002cd55e4234baeed60ef37847ecd54ea704b9977d60daef38c3206243a6 (was 9b2c20c5…); manifest.sha256 SHA-256 1845cd03ca1309cc79d4806308a79be3ccd20d46748b15c7909eb7a3ddc579ab (212 files, was 177). Retained runtime-profile.json unchanged (0955b446…); the suite built its own profile 6d59767eb3bdffd8438b75ea011e8e374594cb1b0cb951337bf2520b72299941 with the same VS2022 Roslyn csc. Evidence under `$root2\tmp\ovd562-runtime-a969decb-…`.

Status for the readiness packet section B: all 11 X1 inert suites PASSED at 91bfa3c4 with native calls 0. Acceptance remains provisional until the receipt bytes (`$root2\receipts\worker-companion-test-runtime.json`) and the updated summary.json are read and their SHA-256 values confirmed by the owner or copied into the packet; this session cannot reach the workstation filesystem. The companion runner script is a workstation-local addition, not repository content.

## Acceptance 2026-10-08T07:36Z: test-runtime accepted against receipt evidence

Source: workstation session result event d515a863 (2026-10-08T07:36:27Z), read by the coordinator from the session transcript. Read-only verification run on the workstation: `manifest entries=212 ok=212 mismatch=0 missing=0`; receipt file 1766 bytes, SHA-256 de5880d83c571a9a55dc9d85b85bf727c688db7b2e4d616ec5c693eaa4f00060; summary.json SHA-256 ad84002cd55e4234baeed60ef37847ecd54ea704b9977d60daef38c3206243a6; manifest.sha256 SHA-256 1845cd03ca1309cc79d4806308a79be3ccd20d46748b15c7909eb7a3ddc579ab; summary entry receiptSha256 and logSha256 both match the files on disk (log SHA-256 3dd1952128d3c39590992c65467c206f72ab075e6392af3f0308b102fb540c49).

Receipt bytes (schema ovd520-x1-suite-receipt.v1): commit 91bfa3c4bdb46d9efd16adc1a36140ea092dcc68; suite worker-companion-test-runtime; command `powershell.exe -NoProfile -NonInteractive -File scripts/native/worker-companion/test-runtime.ps1`; startedAt 2026-10-08T00:25:37-07:00; exitCode 0; durationSec 39.02; outcome passed; timedOut false; nativeCalls 0; sldworksBefore 2; sldworksAfter 2; retained profile 0955b446… before and after; suiteResult {passed true, nativeActions 0, network false, runtimeProfileSha256 6d59767e…, nativeQualification false, evidenceRoot $root2\tmp\ovd562-runtime-a969decb-9cba-493d-ab6b-980df9dcd9d4}; note "Owner-approved single run on 2026-10-08; previously recorded as skipped".

Status for the readiness packet section B: ACCEPTED. All 11 X1 inert suites passed at the exact source 91bfa3c4 with native calls 0 and the retained SolidWorks session untouched; receipt, summary and manifest hashes verified on the workstation. Not native qualification (nativeQualification false). Repeat only if the activation commit changes.
