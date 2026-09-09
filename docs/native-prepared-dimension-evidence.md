# Browser-requested prepared dimension evidence

On September 9, 2026 UTC, the internal workbench imported context captured from
the synthetic two-part Workstation assembly, queued an 8 mm depth, and exported
the exact request consumed by the native adapter. One private candidate completed
successfully in SolidWorks 2022. This is one observed case, not customer or
production qualification.

## Observed result

| Observation | Result |
| --- | --- |
| Baseline / requested / measured depth | 5 / 8 / 8 mm |
| Part volume before / after | 1570.796326794897 / 2513.274122871835 mm³ |
| Required checks | All seven passed: input identity, native integrity, dimension, assembly references, component placements, save/reopen, source preservation |
| Owned driver | PID 6256, exit 0, 40.5183301 seconds, 600-second outer bound |
| Owned native process | PID 19136, session 1, normal exit 0; recovery not required |
| Original package | All three original hashes unchanged |
| Final process inventory | CIM and .NET inventories both empty |
| Adoption | Unadopted; no PDM operation |

The browser imported the actual returned result and displayed 5→8 mm, both
volumes, all seven passes and `Not adopted`. The companion part retained its
original bytes and 40 mm placement. The native package was saved and reopened.

## Exact identity

- Job: `4338de6d-ef39-4e9e-90a8-ab63b156d9d8`.
- Attempt: `8a5a7d22-1cd5-4ffa-95f3-e049e0656b49`.
- Captured context: 1803 bytes, SHA-256 `e3a7aaa8b6249224c0bbac7e4bad78e46c28c3f59eba58e0ad9f33ffdfd5ec8d`.
- Browser request: 1167 bytes, SHA-256 `5405cfefa341757355200b8df30e9b60d47401bf7eb4e270562554bdb74483b1`.
- Native result: 4423 bytes, SHA-256 `bdcba207d801d3bce9f55803d735349493aae9ab8ba5a1c608b0ee4bed592439`.
- Complete raw receipt: 630697 bytes, SHA-256 `af66d9ce321abc12da8d19ed483f6c8c12c386af1a477b0e07f68a27e3204db3`.
- Native source commit label: `0cd464e1a74ff3f2cc431af6eac08deb5d1ed610`. The ten individual source hashes in the receipt identify executable inputs; this label is informational.

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `synthetic-assembly.SLDASM` | 60579 | `d64c6cb9831821c073169be2806fc33ff95d86addfc12dcf312b117f3133a3a5` |
| `parts/baseline-5mm.SLDPRT` | 57212 | `f93ec5db4fb7f586a1b579a06d38c0131b14dbfd4a207ebc68947d67c514e5e4` |
| `parts/candidate-8mm.SLDPRT` | 56171 | `b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898` |

Candidate directory on Workstation:
`C:\Users\blain\AppData\Local\Temp\OD490-R\8a5a7d22-1cd5-4ffa-95f3-e049e0656b49\candidate`.
The result and native evidence remain in its parent directory. Complete receipt:
`C:\Users\blain\AppData\Local\Temp\OVD490-L-241fe6\complete-receipt.json`.
The [OVD-490 rolling record](https://linear.app/overdrafter/issue/OVD-490)
retains receipt identity, operation history and artifact links. Local copies are
under the implementation worktree's `output/first-workflow/` directory.

## Checks before execution and preserved failures

The selected x64 Windows PowerShell 5.1 environment parsed all four scripts and
compiled both native programs with the pinned compiler and SolidWorks interop.
Inert cases rejected default-off invocation, malformed objects, incorrect units,
out-of-range depth, incomplete mandatory checks and overlapping source/output
paths before native activity. Both overlap tests used disposable paths.

Two development failures remain in the record: an ambiguous C# `Environment`
name and an unclear StrictMode error for an empty JSON object. Both were repaired
and verified before the native run. No failed edit was retried. Source capture,
inert validation and native execution retain separate receipts.

## Limits

This proves the explicit browser-file/native-file handoff and one prepared
dimension case. It does not prove automatic transport, reliable arbitrary CAD
edits, interruption recovery during saves, general assembly dependency closure,
worker filesystem/network isolation, license entitlement, engineering suitability
or release authority. The accepted experimental Windows environment and ordinary
profile/journal writes remain as described in the native README. No customer,
authoritative CAD or PDM file was modified.
