# Fictiv public evidence envelope

Reviewed September 26, 2026. The canonical envelope is
[`manifest.v1.json`](manifest.v1.json). This is an offline source classification,
not permission to use the portal, upload a file, run a quote, or admit Fictiv to
production.

| Claim recorded | First-party evidence | Conservative limit |
| --- | --- | --- |
| CNC machining is offered for online quotes | [CNC machining services](https://www.fictiv.com/capabilities/cnc-machining-services) | Does not establish that every part receives instant pricing. |
| Aluminum 6061 is an on-platform CNC material | [CNC aluminum](https://www.fictiv.com/materials/cnc-aluminum) | Only `aluminum_6061` is represented here. |
| CNC accepts STEP/STP parametric, single-solid-body models | [Supported file formats](https://www.fictiv.com/help/uploading-and-organizing-parts/what-file-formats-does-fictiv-support) | A caller must affirmatively establish single-solid-body fit; file extension alone does not prove it. |
| IGES, F3D, mesh files, and assemblies cannot be used as CNC part models | [Supported file formats](https://www.fictiv.com/help/uploading-and-organizing-parts/what-file-formats-does-fictiv-support) | The offline evaluator rejects documented `.iges`, `.f3d`, `.stl`, and `.sldasm` examples. Other unlisted extensions remain unknown. |
| CNC has no minimum order quantity | [CNC machining services](https://www.fictiv.com/capabilities/cnc-machining-services) | One part is the only quantity classified for evaluation. [Multi-quantity guidance](https://www.fictiv.com/help/getting-a-quote/how-to-use-the-multi-quantity-quote-feature) distinguishes instant pricing from estimator RFQs but gives no universal instant-pricing maximum. Higher quantities remain unknown. |
| An existing signed-in account is a documented quoting path | [Finishing quote help](https://www.fictiv.com/help/getting-a-quote/how-do-i-add-finishing-to-my-parts) | Account access, automation permission, and session readiness are unverified. |

Tolerance, drawing handling, other materials and processes, and geometry beyond
a single solid body remain unknown. `eligible_for_evaluation` is an offline
classification only. The existing Fictiv adapter and production-certified
allowlist are unchanged; live evaluation and production certification are
separate stages under `docs/provider-integration.md`.
