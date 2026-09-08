# SolidWorks 2022 native feasibility

Status: experimental evidence only; full OVD-480 worker qualification is incomplete.
Target: Workstation, SolidWorks 2022 SP5. Recorded September 8, 2026.
Evidence owner: [OVD-480](https://linear.app/overdrafter/issue/OVD-480/provision-isolated-solidworks-workers-and-license-aware-job-leasing).

## What is established

The installed SolidWorks 2022 SP5 instance completed one synthetic part's native
create, dimension edit, rebuild, measurement, save and read-only reopen workflow.
This establishes a bounded native operation on this machine. It does not admit
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

## Assembly inspection increment

The next bounded fixture uses private copies of these two parts in one assembly
and one observed configuration. It must preserve exact referenced files and
configurations, inspect component states and transforms, save the package, close
it, and repeat inspection after reopening. File inventory and native reference
observations must agree. Missing or changed files and paths outside the private
package must produce explicit rejection, not a partial successful snapshot.

This increment is in progress. Read-only preflight confirmed the standard local
assembly template and unchanged part hashes. Its first helper failed while
loading the interop library before entering Main or contacting SolidWorks;
current document count and configured-template preference were therefore not
observed by that attempt. This is retained as a caller startup failure.

The subsequent assembly run was dispatched once. Its completion record is not
yet available because the Workstation task connection became unreadable. The
assembly outcome and post-run document/cleanup state remain unknown. Recover
that existing attempt and its evidence before dispatching another native run.

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

One synthetic success is not a reliability rate. Prepared assembly dependency
closure, component operations, supported configuration coverage, native reference
stability, filesystem/network isolation, queue ownership, lease loss, crash
recovery, quarantine and teardown remain qualification work. PDM publication
and external transmission are outside this experiment.

## Implementation boundary

The TypeScript domain, state and operation-preflight modules remain offline
contracts. This evidence does not connect them to a production native worker or
durable engineering service. No database migration, provider operation, license
change or OS/security change is part of this slice.

Follow [the engineering control-plane contract](engineering-control-plane.md)
for subsequent capabilities. OVD-473 owns the broader context/cache contract;
the small native inspection fixture does not complete that issue.
