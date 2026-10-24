# OVD-480 — Workstation qualification record

Recorded September 8, 2026. Selected target: **Workstation / SolidWorks 2022**.

User acceptance: "Yes, continue past that obstacle. If it works it works."
Windows Home is accepted for experimental development on this Workstation.
Its vendor-support status remains documented but does not block bounded
prototype tests. Protect existing documents and distinguish each demonstrated
native capability from full worker qualification.

## Result

The Workstation is accessible through its existing Codex task. The normal remote
task reader returns empty recent turns, but the executor can return sanitized
evidence through the existing OVD-480 Linear progress record. This path succeeded
for both a prior inventory and a fresh metadata preflight.

**The synthetic part passed creation, dimension editing, rebuild, measurement,
save and read-only reopen on Workstation / SolidWorks 2022 SP5. Native application
identity, temporary cylinder measurement and narrow parent-process safeguards
also passed. Full worker qualification remains incomplete.** Your acceptance of
Windows Home permits this experimental lane.
Box creation still fails, with no established cause. After the user's explicit
save-and-close authorization, the untitled part was preserved to a new recovery
file, all 15 documents were closed, and the 14 previously saved files retained
their exact hashes. SolidWorks remains running.

| Check | Result | What it establishes |
| --- | --- | --- |
| Expected SolidWorks process and API revision | Passed | C# can reach the selected SolidWorks 2022 SP5 instance. |
| Wrong executable identity | Passed | The parent refuses to launch its helper on a mismatched input identity. |
| Owned-helper deadline | Passed | The parent stops its own inert helper after 30 seconds and preserves SolidWorks. |
| Temporary cylinder creation and measurement | Passed | The native modeler produced a body whose volume, area and center met all declared tolerances. |
| Temporary box creation | Failed | This method still returns 0x8002000D; its internal cause remains unknown. |
| Authorized save and close | Passed | Untitled part preserved, 14 saved files unchanged, all 15 documents closed, final count zero. |
| Create/edit/rebuild/save/reopen | Passed for one synthetic part | A private 5 mm cylinder baseline was saved; its copy was changed to 8 mm, saved, reopened read-only and verified. |
| Worker isolation and CAD-effect recovery | Not run | The shared session and dummy-helper timeout do not qualify these properties. |

## Observed environment

The fresh executor observation was made at 2026-09-08T15:16:59.2689174Z.

| Item | Observation |
| --- | --- |
| Windows | Windows 11 Home 25H2; build 26200.9278 |
| SOLIDWORKS | Installed-product text: SOLIDWORKS 2022 SP05 |
| Executable version | ProductVersion and FileVersion: 30.5.0.0049 |
| Executable identity | SHA256 recorded in workstation-inventory.json |
| Version-specific COM registration | SldWorks.Application.30 |
| Interop assemblies | 30.5.0.49 |
| Development tools | .NET SDK 9.0.101; Roslyn csc 4.1200.24.57207 |
| Running application | One SLDWORKS process, PID 5968, session 1, responding |
| Execution context | Remote command helper shares the application identity/session |
| Separate worker account/VM | Unverified |
| Product edition, activation and entitlement | Unknown |

PID, session and responsiveness are observations at a particular time. Refresh
them before any later process-bound action. ProductVersion, interop version and
registered COM identity must all agree before attempting a native operation.

The sanitized executor receipt is preserved in the existing
[OVD-480 progress record](https://linear.app/overdrafter/issue/OVD-480/provision-isolated-solidworks-workers-and-license-aware-job-leasing).
The coordinator did not receive raw Windows command output. The local JSON
records that evidence limitation explicitly.

## Initial API probe result

Read-only API identity probe: UTC preflight 2026-09-08T15:21:31.3889602Z; one existing SLDWORKS PID 5968/session 1 matching parent session 1, ProductVersion/FileVersion 30.5.0.0049, executable SHA256 6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc. Bound once using .NET Framework Marshal.GetActiveObject for SldWorks.Application.30 (registered CLSID {2f315be3-b0e2-4c87-b9f3-efa160fd4b66}), without creation/activation. Owned helper PID 14644, observed STA at 2026-09-08T15:21:31.9425269Z, parent-enforced 30-second maximum; elapsed 0.737 seconds, helper exited normally (exit 0 with structured failure). GetActiveObject returned; GetProcessID attempt failed with System.Runtime.InteropServices.COMException HRESULT 0x8002802B. API PID and revision unavailable; RevisionNumber was not attempted because PID verification did not succeed. No automatic retry. After helper exit, original PID 5968/session 1/start UTC 2026-09-06T02:17:35.6279620Z and matching executable version/hash remained present; total SLDWORKS count 1, no extra process. No document/UI/license operations, no SolidWorks launch/stop/ExitApp. Sources/logs confined to fresh outputs/ovd-480-readonly-identity. Windows Home is outside vendor support; feasibility evidence only; qualification: incomplete.

The application-method binding failure is retained as a failed observation.
It is not a passing identity check, despite the helper's normal process exit.
The helper used PowerShell late-bound COM adaptation. Read-only metadata
inspection confirmed both methods in the installed ISldWorks interface. A
reviewed C# correction using that interface then succeeded; the precise original
late-binding/type-information failure remains unproven.

## Typed C# identity check

Typed C# API identity probe: exactly one reviewed correction run, preserving the previous late-bound failure. UTC preflight 2026-09-08T15:26:34.7401615Z; singleton SLDWORKS PID 5968/session 1 matching parent session 1, start UTC 2026-09-06T02:17:35.6279620Z, ProductVersion/FileVersion 30.5.0.0049, executable SHA256 6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc. Installed .NET Framework compiler built x64 helper against installed interop 30.5.0.49: compile exit 0, no diagnostics. Source SHA256 1c0ec34c3cf786ac3e87ee1101315c5870cb8df3327c44d5250332c2613fa796; helper EXE SHA256 525b4a1656210f9932c3bc36f01528079d4ed0e37377a39a0223d43b80f36fd9. Relative artifact directory outputs/ovd-480-readonly-identity/typed-csharp-01/: IdentityProbe.cs, IdentityProbe.exe, parent.ps1, compile.log, compile-result.json, typed.stdout.json, typed.stderr.txt, result.json. Helper PID 9072, observed STA at UTC 2026-09-08T15:26:34.9500644Z; parent-enforced 30-second limit; elapsed 0.228 seconds, exit 0. Marshal.GetActiveObject('SldWorks.Application.30') followed by explicit ISldWorks cast/IID guard {83A33D22-27C5-11CE-BFD4-00400513BB57}; typed GetProcessID returned 5968, matching preflight, then typed RevisionNumber returned '30.5.0'. Status success for these two read-only identity methods only. After exit: same sole SLDWORKS PID/start/session/product+file version/hash, original present, no extra process. Owned COM reference released; no SolidWorks creation/launch/stop/ExitApp, document access, UI/license/settings changes, or additional native attempt. Windows Home vendor-support exclusion remains; licensing, isolation and full native qualification remain unverified; qualification: incomplete.

This establishes access to the expected running application for two read-only
identity calls. It does not establish native file operations, isolation,
licensing or model verification. The first failed probe remains part of history.

## Platform support

The official [SOLIDWORKS system requirements](https://www.solidworks.com/support/system-requirements)
exclude Windows Home Editions. The [2022 SP5 release notes](https://files.solidworks.com/Supportfiles/Release_Notes/2022/English/relnotes.htm)
state that Windows 11 x64 support began at 2022 SP02; that threshold does not
override the Home exclusion.

The [SOLIDWORKS product lifecycle](https://www.solidworks.com/sw/support/solidworks-support.htm?tabshow=2)
also records the end of 2022 hotfix support on December 31, 2023. No inspected
source establishes support for the exact 2022 SP5 / Windows 11 25H2 combination.
Do not infer that changing only the Windows edition qualifies this stack.

## Repeatable read-only preflight

1. Resolve the existing Workstation task by its returned host ID. Never assume
   that a remote caller's local host means the coordinating Mac.
2. Observe UTC time, Windows edition/build, executable file/product version,
   executable SHA256, version-specific COM registration and interop versions.
   Query only the needed metadata; omit license identifiers, keys and model paths.
3. Record current command and SLDWORKS PIDs/session IDs. Multiple or unexpected
   instances stop the probe. A shared session must be reported as shared.
4. Record installed compiler/runtime versions without installation or downloads.
5. Preserve each finite failure as an unknown or failed observation. Missing
   evidence must never become a passing qualification check.
6. Return sanitized evidence through the same rolling comment. Preserve the
   original observation time and all unchecked qualification criteria.

An optional bounded API identity probe may obtain an already-running object with
[GetActiveObject](https://learn.microsoft.com/en-us/windows/win32/api/oleauto/nf-oleauto-getactiveobject),
then call only GetProcessID and
[RevisionNumber](https://help.solidworks.com/2022/English/api/sldworksapi/solidworks.interop.sldworks~solidworks.interop.sldworks.isldworks~revisionnumber.html).
Require a fresh matching executable hash/version/session, an owned STA helper,
a 30-second parent-enforced deadline and matching API PID before reading revision.
Never activate a new CAD instance, access documents or mutate application state.
Timeout cleanup terminates only the owned helper. No automatic retry.

This identity probe is feasibility evidence; it cannot qualify native changes.

## Remaining qualification gates

The initial continuation found 15 existing documents. The user then authorized
saving and closing them. Read-only traversal identified 14 clean saved optical
table artifacts and one pathless part. The first save-close attempt stopped
before launching its helper because an optional checksum read conflicted with
an open-file lock. Shared reads corrected this evidence-collection issue.

The successful batch at 2026-09-08T17:35:59.8462966Z saved the pathless part to a
unique private recovery file with zero errors and warnings, then closed all 15
clean documents and verified count zero. All 14 original file hashes were
available and unchanged. SolidWorks' exact original process identity remained
present. Source, failure, corrected batch and receipt are preserved in
save-close-preflight.json, save-close-01.json and save-close-02.json.

The recovery file is 25,332 bytes, SHA256
6e7b80222f6c8f3f632f1a7c49d3482b705cf0f6b99a4f7d73ab32eb66731e7d.
It has observed recovery provenance, not asserted factory-template provenance.
Inspection of its private copy established one configuration, no active sketch,
zero solid/sheet bodies, no external or auxiliary references, and no equations.
Feature and child traversal admitted the exact observed blank fixture, including
six reviewed container/light types. Some container classifications remain
fixture-specific observations; this does not admit arbitrary native packages.

## Passing native part workflow

The fourth reviewed attempt at 2026-09-08T18:08:01.8521118Z passed in 12.964 seconds
with helper exit code zero. It created a circle of radius 10 mm on an observed
origin/+Z plane, extruded it to 5 mm and saved the private baseline. An exact copy
was reopened and verified at 5 mm, edited to 8 mm through the same extrusion
definition, rebuilt and saved. A read-only reopen then repeated the checks.

| Verification phase | Depth (mm) | Volume (mm³) | Area (mm²) | Native checks |
| --- | ---: | ---: | ---: | --- |
| Baseline | 5 | 1570.796326795 | 942.477796077 | Passed |
| Copied candidate before edit | 5 | 1570.796326795 | 942.477796077 | Passed |
| Edited candidate | 8 | 2513.274122872 | 1130.973355292 | Passed |
| Saved candidate reopened read-only | 8 | 2513.274122872 | 1130.973355292 | Passed |

Each phase reported one solid and zero sheet bodies, successful rebuild, feature
error zero without a warning, and twelve finite mass-property values. The exact
returned feature was rebound by unique name/type and configuration. Its native
definition was a base extrusion, non-thin, forward blind and single-direction.
Both saves returned success with zero errors and warnings, exact paths and clean
document state. Final document count was zero; the original application remained
running, and recovery, baseline and candidate hashes were unchanged after checks.

Reported centers were approximately (0, 0, 2.5 mm) and (0, 0, 4 mm). Their pass
against a 1e-8 m tolerance is executor-reported because the receipt does not
contain exact center components. The coordinator independently recomputed the
reported depth, volume and area predicates against the declared analytic values.
Density 1 was only a calculation input; no physical material or fully constrained
sketch is claimed. Native execution and file hashes are remote executor evidence,
not an independent second CAD execution or local inspection of the native files.

The native package remains on Workstation under the qualification output folder:

`native-dimension-04-e8d2937cf8104a5385ed184c02e92009/`

| File | Bytes | SHA256 |
| --- | ---: | --- |
| baseline-5mm.SLDPRT | 56,144 | e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa |
| candidate-8mm.SLDPRT | 56,171 | b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898 |

The full remote path, source/log identities and four phase records are preserved
in [native-dimension-04.json](/Users/blainewilson/.codex/worktrees/engineering-control-plane/Overdrafter/output/ovd-480-2026-09-08/native-dimension-04.json). Earlier attempts remain
in native-dimension-01/02/03.json. They stopped on caller checks: unclassified
fixture container types, a literal `Boss` type requirement when the actual type
was `Extrusion`, and requiring `IsBossFeature()` to be true for first-solid
creation. Reviewed corrections retained physical/native checks. The passing run
requires `IsBase2()`, extrusion semantics, body count and measured geometry;
`IsBossFeature()` remains a recorded diagnostic and was false. Failed attempts
never became successful saved fixtures and were discarded only on private copies.

## Other diagnostic history and remaining gates

The temporary geometry probe failed at CreateBodyFromBox3 with 0x8002000D
(DISP_E_ARRAYISLOCKED). Per-call instrumentation preserved that failure.
Matching IModeler/IBody2 registrations were observed; this is not evidence of
registration corruption. No box measurement passed.

A diagnostic using an explicitly owned native double array reproduced the
failure at IDispatch.Invoke. Name resolution succeeded with DISPID 114. Input
array locks were zero before and after the call; both caller-side VariantClear
operations succeeded. This distinguishes the observed invocation failure from
explicit caller cleanup. It does not establish the internal server/proxy cause.
The first diagnostic stopped at an overly strict type-information prerequisite;
that caller error was corrected and retained in history. The corrected helper
exited after 0.361 seconds; its numeric process exit code was unavailable, while
its structured result reported native_failure. See geometry-diagnostics.json.

A bounded read-only review of the actual remote caller source found no identified
ABI defect. Its source excerpts, ownership details and limitations are preserved
in caller-source-review.md. That review is not a substitute for passing execution.

The [Microsoft GetTypeInfoCount contract](https://learn.microsoft.com/en-us/windows/win32/api/oaidl/nf-oaidl-idispatch-gettypeinfocount)
explicitly allows an object to remain programmable through IDispatch even when
its type-information count is zero. That observation is not itself a defect.

The supplemental-error run reproduced the same box failure and immediately
called GetErrorInfo on the same STA thread. It returned S_FALSE, meaning no
supplemental error object was available. Its planned cylinder comparison did
not execute: a new guard compared CIM and .NET creation-time strings, which
differed by three 100-nanosecond ticks for the same process. Independent parent
identity observations remained unchanged. This caller guard error is preserved
in primitive-diagnostic-05.json; it is not evidence of a SolidWorks restart or a
cylinder failure. The correction compares exact timestamps from the same API
while retaining the separate CIM observation and all other identity checks.

A cylinder-only run after that correction passed all seven recorded predicates.
Native invocation succeeded, returned a temporary body and yielded twelve finite
mass-property values. The measured volume was 1.5707963267948967e-6 m³, surface
area 0.000942477796076938 m², and center approximately (0, 0, 0.0025) m. Explicit
native cleanup and owned-reference release succeeded. Both exact .NET identity
checks matched, as did the independent CIM observations; document count remained
15. Non-CAD guard tests rejected a changed creation tick, PID, session and hash.
See cylinder-diagnostic-06.json for exact values, tolerances, hashes and receipt.

This demonstrates one temporary native primitive through this Automation path;
it narrows the earlier failure without proving its cause. The helper completed
in 0.461 seconds, but its numeric exit code remains unknown. A legacy exit-code
selector also needs correction before the diagnostic becomes reusable worker
code. The structured operation result and measured checks are recorded
separately; no zero-exit claim is made.

Two parent-control checks passed: wrong executable hash rejected before helper
launch, and an owned non-CAD dummy helper terminated after its 30-second deadline.
The original SolidWorks process remained present. These checks do not prove
recovery from interrupted CAD effects.

- [x] Decide and document a supported isolated execution environment, or explicitly
      limit this legacy configuration to an experimental lane.
- [ ] Establish legitimate product edition, activation and execution entitlement.
- [ ] Prove evaluation cannot write authoritative CAD/PDM or resolve dependencies
      outside its private package; a copied directory alone is insufficient.
- [ ] Establish a dedicated serialized STA execution context with qualified
      session/process ownership and a message loop.
- [x] Run one synthetic part's inspection, dimension change, rebuild, measurement,
      save and read-only reopen checks.
- [ ] Extend native proof to prepared assembly dependency closure, supported
      configurations, component operations and required assembly checks.
- [ ] Demonstrate wrong-instance rejection, crash, hang, lease loss, late output,
      quarantine, cleanup and recovery from immutable input.
- [ ] Capture logs, exact environment/artifact identities and pass/fail evidence.

The save-and-close batch preserved the user's documents. The separate native04
run established the narrow part lifecycle proof. It did not write PDM, install
software or change licensing, OS configuration or security. Full worker isolation
and release eligibility remain unverified. Existing offline engineering-state
foundations are separate from this feasibility packet.

## Validation of this packet

The packet contains inventory, typed identity, temporary geometry diagnostics,
parent guard checks, authorized save/close receipts and the native part lifecycle
proof. Temporary cylinder and native04 measurements passed; box checks failed or
remain unevaluated. Earlier caller failures and unknown numeric exit codes remain
explicitly recorded.

No application source, dependency or migration changes are part of this packet.
Validation parses every JSON file, recomputes the temporary cylinder predicates,
and independently checks native04 depth, volume and area across all four phases.
Native04 center acceptance remains executor-reported. Consistency checks confirm
failed or unattempted phases are not reported as passes, preserve unknown process
exit codes, verify the save/close receipt and retain incomplete full qualification.
SHA256SUMS.txt identifies the local evidence files; it does not independently hash
the native files on Workstation. No deletion or source rollback is required:
private candidates and immutable baseline are retained as qualification evidence.
