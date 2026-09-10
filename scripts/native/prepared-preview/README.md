# Prepared assembly STEP preview experiment

OVD-493 adds a default-off, local operator exporter for the three-file synthetic
assembly already admitted by the prepared-dimension workflow. It produces an
importable STEP preview, with both real assembly components and their verified
placements, for either the exact baseline context or an exact successful
candidate request/result. It does not adopt or release a design.

The executable scope is High and was explicitly approved as a decomposed slice.
This folder does not alter the existing native lifecycle or dimension helpers.
The shared Windows profile remains a limitation: lexical path checks, hashes,
and process observations do not establish a filesystem/network sandbox or
protection against a hostile concurrent writer.

## Cumulative snapshots (OVD-502)

The exporter also accepts an exact `overdrafter.prepared-assembly.v2` snapshot.
For the seed, use `-Role baseline`. For a realized cumulative snapshot, use
`-Role candidate`; its measured depth and native files come from that snapshot.
V2 invocations do not accept separate `RequestPath` or `ResultPath` arguments.
The producing request/result digests already belong to the exact context, and
the output binds the context's byte digest, organization/project and snapshot ID.

```powershell
.\run.ps1 -Execute -Role candidate -ContextPath C:\ovd\snapshot-9mm.json `
  -SourceRoot C:\ovd\candidate-9mm -OutputRoot C:\ovd\previews
```

An unknown, inconsistent or incomplete context is rejected before an attempt
directory or native process is created. The unchanged native exporter then
freshly checks the private package's files, actual depth, component placement and
read-only reference closure. A declared check set is still imported evidence;
this interface does not authenticate a worker or finalize engineering results.

V2 outputs use `overdrafter.prepared-step-preview.v2`, retaining the existing
bounded STEP/export fields and adding `scope` and `snapshotId`. Here
`contextSha256` identifies the exact displayed snapshot, whereas the v1 candidate
bundle identifies its original input context/request/result. The two schemas are
not interchangeable. `src/lib/engineering-cumulative-preview.ts` validates the
separately selected snapshot, producer, native files and exact STEP bytes before
providing a source for the existing renderer. It adds no UI or server transport.
The v1 operator invocation and bundle remain unchanged.

Run `test-contract.ps1` for inert v1/v2 PowerShell checks and
`src/lib/engineering-cumulative-preview.test.ts` for consumer rejection cases.
These synthetic exchange envelopes do not prove exported geometry. Qualification
must export the retained OVD-495 9 mm and 7 mm packages and independently parse
those actual STEP files.

On September 10, 2026, source `1b0360f2492ddc47a28339bfe820071732f2c255`
passed both read-only exports on Workstation, with Desktop x64 PowerShell
5.1.26100.9278 and pinned SolidWorks 2022 SP5. Each direct invocation and native
process exited 0, reported no recovery requirement, preserved source files and
STEP settings, and left the final SolidWorks process inventory empty. The inert
Windows contract lane passed all 30 assertions before native execution.

The evidence packet attached to OVD-502 is 878402 bytes, SHA-256
`ec6bbf1f5025fe1e42ffb3acf3b735e8e3ab625e59d83cc7eef31212d416293a`.
Independent Mac readback verified all 75 embedded file records and admitted each
preview through the v2 consumer. `occt-import-js` 0.0.23 parsed two meshes per
export: target depths 9 and 7 mm, companion depth 8 mm, cylinder diameters 20 mm
within 0.01 mm tessellation tolerance, and centers at x = 0 and 40 mm. Depth
tolerance was 0.001 mm; tessellated volumes were within 3% of analytical cylinder
volumes. The companion mesh and placement had identical hashes in both exports.
Retained Windows roots are `%USERPROFILE%/ovd502-98842e33` and
`%USERPROFILE%/ovd502-72a7b477`; the independent report is
`output/validation/windows-geometry-proof.json` in the qualification worktree.

This establishes the synthetic cumulative export path, not authenticated worker
transport, broader CAD equivalence or release authority. Consumer-only digest
compatibility changes after the qualified source leave all native files unchanged.

Native source checkout must preserve the scoped LF attributes; use the documented
child-only Desktop module-path preparation when launching PowerShell 5.1 from
Core. Do not change machine settings or weaken pinned hashes.

## Invocation

Use x64 Windows PowerShell 5.1 and the pinned SOLIDWORKS 2022 SP5 runtime.
`-Execute` is required; without it the script stops before loading helpers or
writing files. `SourceRoot` and the short `OutputRoot` must be trusted absolute
local Windows paths. No existing SLDWORKS process may be present. An operator
must reconcile any existing session separately; this runner never adopts it.

```powershell
# Baseline: SourceRoot holds the exact three context files.
.\run.ps1 -Execute -Role baseline -ContextPath C:\ovd\context.json `
  -SourceRoot C:\ovd\baseline -OutputRoot C:\ovd\previews

# Candidate: SourceRoot must equal the successful result's candidateRoot.
.\run.ps1 -Execute -Role candidate -ContextPath C:\ovd\context.json `
  -RequestPath C:\ovd\request.json -ResultPath C:\ovd\result.json `
  -SourceRoot C:\ovd\candidate -OutputRoot C:\ovd\previews
```

Optional `-SourceCommit` is a lowercase 40-hex source label, otherwise the bundle
records null. It is attribution, not authenticated execution authority.

Each invocation gets a fresh `preview-<GUID>` directory, capped at 100 characters.
Source/output overlap is rejected before any writes. The runner retains exact
context/request/result bytes, source and binary hashes, private native copies,
helper stdout/stderr, progress, final supervisor evidence, and the STEP file.
It emits `preview.json` only after a verified native export, normal native exit,
unchanged private/source native files, unchanged binding files, and successful
supervisor finalization. Success exits 0; an admitted failed attempt exits 2.
Invalid arguments/admission stop before an attempt receipt exists. A failure
never produces a success bundle or triggers native forced cleanup or retry.
An interrupted final file write may leave partial bytes; the browser's strict
bundle parser will reject them.

## Composition and verification

`StepPreviewProbe.cs` is compiled with the three unchanged prepared-dimension
C# files using **`/main:StepPreviewBootstrap`**. Its separate entry point calls
only the read-only package loading, geometry/reference/placement verification,
and normal document-close helpers. It never calls the dimension entry point,
`ExecutePackage`, or `EditPart`. Both private parts are preloaded read-only before
the private assembly; actual loaded component identities and reference paths
must match those private parts. This prevents an original-path resolution from
being accepted as a private export. The existing assembly-open warning 32 is
retained as evidence and remains the sole allowed assembly-open warning.

The PowerShell driver extracts eight explicitly named function definitions from
the unchanged prepared-dimension driver through its parser AST. It never
executes that driver's top-level code or editing operation. The copied driver
hash must match the source used for extraction. Lifecycle readiness and normal
exit use the unchanged `NativeSessionProbe`, and finite child supervision uses
the exact pinned `OwnedProcess.ps1`. Each compiler has a 30-second deadline;
GUI readiness and API readiness each have a 60-second budget; export has a
180-second helper deadline; normal native exit has a 30-second budget. A deadline
may stop only the retained helper. An uncertain native session remains for
operator reconciliation, with its observed identity preserved.

Candidate admission requires the exact context/request/result digests, matching
job/attempt IDs, requested depth, all seven distinct passing checks, original
input identities, complete output identities, changed target, unchanged
companion, and analytic depth/volume measurements. These are imported claims;
the export then freshly verifies the actual private native geometry and assembly.

The exporter activates and verifies the top-level assembly, checks both
components are visible, clears and verifies the selection, and invokes
`IModelDocExtension.SaveAs3` with the fresh `.step` path, current version and
silent option. SOLIDWORKS documents that STEP conversion requires an active
document, and that clearing selection exports the entire model.
[SOLIDWORKS 2022 SaveAs3 documentation](https://help.solidworks.com/2022/english/api/sldworksapi/SolidWorks.Interop.sldworks~SolidWorks.Interop.sldworks.IModelDocExtension~SaveAs3.html)

It reads existing STEP preferences and requires solid/surface output, AP203 or
AP214, no configuration-selection prompt, no coordinate-system override, and no
separate-component atomic export option when that option exists in the pinned
enum. No preference setters are called. The constants assembly is independently
pinned to 454,808 bytes, version `30.5.0.49`, SHA-256
`b6f1aff6729712027d8c96b0da67ae3e949c133893c13c9a6add0ea5d27e35f1`.
[SOLIDWORKS STEP API options](https://help.solidworks.com/2022/english/api/swconst/FileSaveAsSTEPOptions.htm),
[STEP export options](https://help.solidworks.com/2022/english/SolidWorks/sldworks/HIDD_EXPORT_OPTIONS_STEP.htm)

Export must return true with zero errors and warnings, preserve the native
assembly identity/read-only mode and preferences, and create exactly one file
in the fresh STEP directory. The runner checks the STEP exchange envelope,
length and hash; it does not independently reimport STEP to prove geometric
equivalence. The browser performs its own STEP parsing for display.

## Bundle and validation boundary

`overdrafter.prepared-step-preview.v1` binds the context, baseline/candidate role,
nullable request/result digests, Default configuration, and exact three native
file identities to `assembly.step` bytes, length, SHA-256 and canonical base64.
STEP is capped at **2,000,000 bytes** and the complete UTF-8 JSON at **3,000,000
bytes**. `export.nativeVersion` is exactly `30.5.0`; `export.reportSha256` hashes
the retained `native-step.stdout.txt`, not a fabricated or reconstructed report.
Native close/source-preservation evidence remains in the retained supervisor.
The bundle carries explicit imported-evidence and qualification limitations.

Local macOS inspection cannot compile the installed Windows COM interop or run
PowerShell 5.1. Before any native execution, the exact source packet must pass
Windows compile-only checks and inert contract checks: default-off denial,
baseline/candidate binding, changed context/result denial, incomplete/duplicate
checks, changed native identities, invalid measurements, and both decimal size
limits. Actual baseline/candidate STEP parsing and display require separately
recorded live evidence; source inspection alone is not a passed native export.

## Recorded qualification status

The exact exporter sources passed x64 Windows PowerShell 5.1 parsing, both C#
compilations and eight inert rejection cases on the Workstation on September 8,
2026 (local date). The complete 13,942-byte compile/inert receipt has SHA-256
`c8728951bb8b428716ddf4a408be3dbf658bc713a88c7ec202fa5db5661be025`.
A first live workflow stopped at admission while another task had documents
open; its blocked receipt remains preserved. After the user authorized saving
and closing that session, the September 9, 2026 (local date) run passed the exact
5-to-8 mm change and both baseline/candidate exports. All three native sessions
exited normally with code 0; source hashes and export-source candidate hashes
were preserved. The final process inventories were empty.

The complete 1,388,890-byte evidence packet attached to
[OVD-493](https://linear.app/overdrafter/issue/OVD-493) has SHA-256
`ddd7d048f67b50a2f14f82802ffb57e74a1d4f1db632f038eea846477f89ee96`.
All 93 contained file records were decoded and checked against their byte counts
and hashes locally. The 33,352-byte baseline STEP has SHA-256
`fdee03b9416466c122fc66ec21c048dc3f2bd209d87471d536e53ea153e3059c`;
the 33,370-byte candidate STEP has SHA-256
`75a00be171ebe15346f0382061e88c4916592d62b027344eb4c31278f17a8003`.

Independent parsing with the existing `occt-import-js` 0.0.23 renderer confirmed
two component meshes, 40 mm center spacing, unchanged companion geometry and a
target depth change from 5 to 8 mm (0.001 mm depth tolerance). Tessellated volumes
were checked within 3% of the analytic cylinder volumes; native measurements
remain the precise engineering evidence. Both real exports were imported and
visually inspected in the conversational workbench. This qualifies this prepared
fixture and pinned runtime only; it is not broader assembly or sandbox
qualification. The integrated interaction recording belongs to OVD-494.
