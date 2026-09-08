# SolidWorks 2022 native feasibility

Status: experimental evidence only; full OVD-480 worker qualification is incomplete.
Target: Workstation, SolidWorks 2022 SP5. Recorded September 8, 2026.
Evidence owner: [OVD-480](https://linear.app/overdrafter/issue/OVD-480/provision-isolated-solidworks-workers-and-license-aware-job-leasing).

## What is established

The installed SolidWorks 2022 SP5 instance completed one synthetic part's native
create, dimension edit, rebuild, measurement, save and read-only reopen workflow.
A flat assembly containing the two resulting parts also passed creation, fixed
placement, save, read-only reopen, rebuild and observed CAD-reference inspection.
This establishes bounded native operations on this machine. It does not admit
customer assemblies, qualify an isolated worker, or satisfy the full pilot.

The user explicitly accepted Windows 11 Home for this experimental lane.
[SOLIDWORKS system requirements](https://www.solidworks.com/support/system-requirements)
exclude Home editions; that support classification is recorded separately from
observed behavior. It is not treated as a blocker to the accepted experiment.

| Environment item | Observed value |
| --- | --- |
| Application | SolidWorks 2022 SP5 |
| Product/file version | 30.5.0.0049 |
| Installed interop version | 30.5.0.49 |
| Windows | 11 Home 25H2, build 26200.9278 |
| Runtime | Existing interactive session; x64 C# STA helper |
| Separate worker isolation | Not qualified |
| Product edition and execution entitlement | Not independently verified |

The helper binds the existing version-specific application and verifies its
API process identity and revision against a fresh parent observation. Process
creation times from CIM and .NET have different precision on this machine:
each is compared exactly with another observation from the same provider.
A comparison between their timestamp strings caused a recorded caller failure.

## Synthetic part proof

Before testing, the user authorized saving and closing 15 existing documents.
The untitled part was preserved in a new recovery file. All 14 previously saved
files retained their hashes, and document count became zero. The recovery file
was copied privately and inspected before use; factory-template provenance was
not asserted.

The fixture is a cylinder of radius 10 mm. Its 5 mm extrusion was saved as the
baseline. An exact copy was reopened, verified at 5 mm, changed to 8 mm through
the same native extrusion definition, rebuilt and saved. A read-only reopen
then repeated the native and geometric checks.

| Phase | Depth (mm) | Volume (mm³) | Surface area (mm²) |
| --- | ---: | ---: | ---: |
| Saved baseline | 5 | 1570.796326795 | 942.477796077 |
| Copied candidate before editing | 5 | 1570.796326795 | 942.477796077 |
| Edited candidate | 8 | 2513.274122872 | 1130.973355292 |
| Saved candidate reopened read-only | 8 | 2513.274122872 | 1130.973355292 |

All four phases reported successful rebuild, feature error zero without a
warning, one solid and zero sheet bodies, and twelve finite mass-property values.
Both saves succeeded with zero errors and warnings, exact paths and clean state.
The helper exited with code zero after 12.964 seconds. The session returned to
zero documents, and the original application process remained running.

Analytic checks use volume πr²h and surface area 2πr² + 2πrh. Absolute tolerances
are 1e-10 m for depth, 1e-10 m³ for volume, 1e-9 m² for area and 1e-8 m per center
component. The coordinator independently recalculated the reported depth,
volume and area results. Center acceptance is executor-reported: the sanitized
receipt contains approximate centers, not exact components. Density 1 is a test
input, not evidence of a physical material. A fully constrained sketch is not
claimed.

| Preserved synthetic artifact | Bytes | SHA256 |
| --- | ---: | --- |
| baseline-5mm.SLDPRT | 56,144 | e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa |
| candidate-8mm.SLDPRT | 56,171 | b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898 |

These are executor-reported Windows file hashes. Native files were not downloaded
or independently hashed by the coordinating Mac. Source, output and log hashes
are retained in OVD-480's single rolling progress record and the private
qualification packet.

## Synthetic assembly proof

The fixture contains private copies of the two proven parts in one flat assembly.
All three native documents have the observed configuration `Default`. Initial
inspection and a subsequent fresh read-only reopen reported these same values:

| Occurrence | Referenced file | Translation (mm) | State |
| --- | --- | --- | --- |
| baseline-5mm-1 | parts/baseline-5mm.SLDPRT | (0, 0, 0) | Resolved, nonvirtual, fixed |
| candidate-8mm-1 | parts/candidate-8mm.SLDPRT | (40, 0, 0) | Resolved, nonvirtual, fixed |

Both transforms have identity rotation and scale 1. Rotation/scale tolerance is
1e-10 and translation tolerance is 1e-8 m. Top-level and recursive component
inventories agree, each reference resolves to the exact private part and
configuration, and both underlying parts are read-only. The assembly's observed
CAD dependency list contains exactly these two files; both part lists are empty.
These observations do not establish all auxiliary support-file dependencies or
filesystem/network isolation.

SaveAs3 succeeded with zero errors and warnings. The saved assembly is 59,987
bytes, SHA256 `90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a`.
Reopening returned a document with zero errors and warning 32, which the official
[load-warning contract](https://help.solidworks.com/2021/English/api/swconst/SolidWorks.Interop.swconst~SolidWorks.Interop.swconst.swFileLoadWarning_e.html)
identifies as requiring rebuild. The verified readback retained this warning,
admitted only warning bits 0 or 32, and successfully called ForceRebuild3(false)
before repeating the exact component, configuration, transform and reference
checks. It did not resave the assembly. The warning is not rewritten as a
warning-free open or generalized permission to ignore other load warnings.

The readback helper exited zero after 9.609 seconds. Assembly-first cleanup
returned the session to zero documents. All source/private files, the saved
assembly hash and the original application process were retained. The stable
readback manifest hash is
`997cb9b1b7a4afb08d934872a61eea2835a7f909e09f611c5874e8ce766855a0`;
its write-stage snapshot precedes completion, while the separate result record
reports the final pass. Neither is a production engineering snapshot or release
approval.

The coordinator checked the exact reported transform arrays and reference sets
against the declared fixture and initial observations. Actual native readback
and file hashes remain executor-reported evidence.

### Preserved assembly caller failures

The first helper failed while loading interops before Main/COM. Restoring the
working AssemblyResolve/NoInlining bootstrap and deferring typed static
allocations fixed that startup path. A later attempt stopped because its blank
template allowlist omitted documented `LiveSectionFolder`. The focused correction
retained child/content inspection and all physical/reference checks.

The first saved-assembly reopen rejected warning 32 before verification, then
its cleanup tried a referenced part before the assembly. That attempt's final
count remains unknown in its historical record. The subsequent readback run
found exactly the three known private documents and recovered them assembly-first
before fresh inspection. The final pass does not erase those earlier failures.
Temporary task-status outages were reconciled through saved executor receipts;
an unavailable status reader did not authorize duplicate native execution.

### File admission adverse cases

A separate file-only batch passed one positive control and four rejection cases
using path, length and digest predicates extracted from the successful native
reader. The harness made zero COM/CAD calls and exited zero in 0.274 seconds.

| Case | Observed result | Admission content reads |
| --- | --- | ---: |
| Verified assembly package, exact four files | Eligible for file checks only | 4 |
| Required part omitted from a disposable copy | Rejected: missing required file | 1 |
| One byte changed in a disposable part copy | Rejected: digest mismatch | 1 |
| Existing part outside the allowed root | Rejected: outside allowed root | 0 |
| Existing part in a similarly prefixed sibling directory | Rejected: outside allowed root | 0 |

The last two copies had valid digests checked during setup. Those setup reads
are separate from the admission reads shown above. All seven source/original
file hashes were unchanged. The native caller using the shared predicates was
compiled but not executed; the original successful reader was preserved.
This demonstrates these file checks, not deployed native preflight integration,
reparse-point or race resistance, complete dependency closure, or worker
isolation. The negative fixtures are file tests, not qualified CAD packages.

The coordinator's local assembly packet validator passed 41 receipt-consistency
checks with none failed or pending. It recalculates reported geometry and checks
identities, transforms, reference sets and preserved failure states. It does not
independently access Windows files or reproduce native execution.

## Failure history and limits

- A late-bound identity call failed; a typed C# identity call succeeded.
- Temporary cylinder creation and measurement passed. Temporary box creation
  still fails with 0x8002000D; its internal cause is unknown.
- Early part attempts stopped on overly narrow caller checks for standard
  container types, the literal feature type `Boss`, and `IsBossFeature()`.
  The actual first-solid feature reports `Extrusion` and a false boss diagnostic.
  The passing run verifies `IsBase2()`, the extrusion definition, rebuild,
  body count and measured geometry together.
- A wrong executable hash was rejected before helper launch. A parent stopped
  its own inert helper after a deadline while retaining SolidWorks. Those checks
  do not prove recovery from interrupted CAD effects.
- The working helper's exit status is known. Earlier attempts with unavailable
  numeric exit status retain that unknown value; structured success does not
  retroactively supply an exit code.

The part and flat-assembly successes are not a reliability rate. Nested assembly
dependency closure, component changes and mates, additional configuration
coverage, native reference stability, filesystem/network isolation, queue
ownership, lease loss, crash recovery, quarantine and teardown remain
qualification work. PDM publication and external transmission are outside this
experiment.

## Implementation boundary

The TypeScript domain, state and operation-preflight modules remain offline
contracts. This evidence does not connect them to a production native worker or
durable engineering service. No database migration, provider operation, license
change or OS/security change is part of this slice.

Follow [the engineering control-plane contract](engineering-control-plane.md)
for subsequent capabilities. OVD-473 owns the broader context/cache contract;
the small native inspection fixture does not complete that issue.
