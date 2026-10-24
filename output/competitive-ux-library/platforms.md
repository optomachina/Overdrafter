# Platform evidence cards

The cards focus on interaction evidence. Missing categories are marked **UNKNOWN** rather than inferred.

## Direct manufacturing-quote platforms

### Xometry — **ADAPT**

- **OBSERVED:** Quotes are saved, editable, and shareable through web access, email/PDF, or a purchasing path; order tracking uses a visual status tracker. The public upload affordance lists many neutral and native formats and uses “secure and confidential” trust copy. [Quote sharing and tracking](https://www.xometry.com/resources/blog/share-online-manufacturing-quotes/)
- **OBSERVED:** A process recommender analyzes uploaded geometry and configures a suggested process. [Process recommender](https://investors.xometry.com/node/9476/pdf)
- **OverDrafter mapping:** quote history, stable procurement packet, multi-offer decision detail.
- **Avoid:** marketplace identity or “best option” logic becoming opaque; provider role and origin must remain explicit.
- **UNKNOWN:** current logged-in CAD/drawing pairing, revision compare, mobile recovery, and exact supplier disclosure timing.

### Fictiv — **STEAL / ADAPT**

- **OBSERVED:** Upload creates a quote; Configure captures process, material, color, post-processing, and quantity; a Manufacturing feedback tab presents DFM. [Getting started](https://help.fictiv.com/en/articles/2366096-how-to-get-started-with-fictiv)
- **OBSERVED:** Similar filenames can auto-pair CAD and PDF drawings, with a manual attach path. [Drawing attachment](https://www.fictiv.com/help/getting-a-quote/how-to-get-parts-quoted-with-attached-drawings)
- **OBSERVED:** Drawing Reconciliation extracts requirements, applies them to configuration, flags incomplete/incompatible inputs, and records intentional deviations. [Drawing reconciliation](https://www.fictiv.com/help/placing-an-order/how-do-i-use-drawings-reconciliation)
- **OverDrafter mapping:** intake pairing, extraction evidence, conflict review, requirements-of-record.
- **Avoid:** silently making platform configuration authoritative over contradictory source drawings.

### SendCutSend — **STEAL / AVOID**

- **OBSERVED:** Drag/drop files, confirm 2D units, select material/thickness/services, preview, add to cart; saved carts can be shared. [Ordering guide](https://sendcutsend.com/faq/how-do-i-order-parts-on-your-website/) · [Getting started](https://sendcutsend.com/guidelines/getting-started/)
- **OBSERVED:** Troubleshooting is rule-specific: format, units, scale, duplicate/open paths, nesting, and service geometry. [Pricing recovery](https://sendcutsend.com/faq/why-cant-i-get-a-quote/)
- **OBSERVED:** 3D preview is used to confirm bend direction and orientation. [Education workflow](https://sendcutsend.com/blog/take-your-cad-files-from-design-to-production/)
- **OverDrafter mapping:** guided recovery and simple first-run configuration.
- **Avoid:** its “structured cart is the whole spec” approach; SendCutSend says it does not use technical drawings for production, which conflicts with OverDrafter's drawing-evidence thesis. [PDF/drawing policy](https://sendcutsend.com/faq/can-i-send-you-a-pdf/)

### Protolabs / ProDesk — **STEAL / ADAPT**

- **OBSERVED:** Sign in → name project → choose service → multi-file upload → Configure → Analysis → Review & Order. [ProDesk](https://www.protolabs.com/help-center/prodesk/)
- **OBSERVED:** Green/yellow/red advisories distinguish no issue, recommendation, and required geometry change; price updates with quantity/shipping. [ProDesk](https://www.protolabs.com/help-center/prodesk/)
- **OBSERVED:** Sheet-metal quoting allows models, multiple parts, or assemblies; adding drawings introduces manual review; a compare-pricing link exposes quantity alternatives. [Sheet-metal quoting](https://www.protolabs.com/help-center/sheet-metal-quoting-and-dfm/)
- **OverDrafter mapping:** named request container, severity language, provider-response detail, explicit manual-review status.
- **Avoid:** provider-specific manufacturing limitations presented as universal DFM truth.

### Protolabs Network / Hubs — **ADAPT**

- **OBSERVED:** Protolabs describes Network as a separate partner-network quoting route; users may quote both systems, and some machining quotes transfer into the network option. [Digital manufacturing FAQ](https://www.protolabs.com/resources/faqs/) · [Digital factories and partner network](https://www.protolabs.com/about-us/digital-factories-x-partner-network/)
- **OverDrafter mapping:** explicit distinction between a direct factory response and a network response.
- **UNKNOWN:** current network quote detail, actual supplier identity timing, drawing pairing, revision history, mobile, and recovery UI.

### Geomiq — **ADAPT / AVOID**

- **OBSERVED:** Upload accepted CAD/drawing formats, choose requirements, then receive instant or up-to-24-hour results; complex inputs may require more information. Buyers can track manufacturing on a dashboard. [FAQ](https://geomiq.com/frequently-asked-questions/)
- **CLAIMED:** The service benchmarks multiple partner quotes and exposes the best price; quotes can be revised, requoted, or archived, and can be shared with purchasing. [Platform](https://geomiq.com/online-manufacturing-services/) · [Homepage](https://geomiq.com/)
- **OverDrafter mapping:** instant/manual state, lifecycle tracking, engineering-to-purchasing handoff.
- **Avoid:** hiding the alternatives and underlying provider evidence behind one “best” result.

### Weerg — **ADAPT**

- **OBSERVED:** Anonymous 3D upload produces a quantity-sensitive price and current lead times; registration expands site functionality. [Quotation tool](https://www.weerg.com/faq/how-does-the-online-quote-work)
- **OBSERVED:** Large/complex work moves to a form-and-technician flow with drawings/specifications and stated response timing. [Large-batch quote](https://www.weerg.com/quotation-for-large-batches-and-industrial-orders)
- **OverDrafter mapping:** low-friction what-if quote exploration and honest escalation to expert review.
- **UNKNOWN:** drawing pairing, revision history, collaboration, mobile, and logged-in recovery.

### Fractory — **ADAPT / AVOID**

- **OBSERVED:** Upload 3D model or 2D cut contours, optionally add a PDF drawing, receive manufacturability checks and lead time; quantity/material comparisons are supported. [FAQ](https://fractory.com/frequently-asked-questions/)
- **CLAIMED:** Its network allocates work based on partner suitability and capacity. [Platform](https://fractory.com/)
- **OverDrafter mapping:** input-specific guidance and network-role labeling.
- **Avoid:** opaque automatic allocation without exposing provider role, facility/origin evidence, and decision alternatives.

### OSH Cut — **STEAL**

- **OBSERVED:** Drag/drop into cart → assign units → select material/thickness/finish → nesting → lead-time choice. [Online quoting tutorial](https://www.oshcut.com/tutorials/osh-cut-online-quoting-app)
- **OBSERVED:** 3D uploads expose the generated flat pattern, formed model, design-rule result, and quantity price changes. [3D part tutorial](https://www.oshcut.com/tutorials/designing-a-3d-part-file-to-order)
- **OBSERVED:** Batch upload, job-level costing, and automatic recognition/splitting of pre-nested files. [Job-level quoting](https://www.oshcut.com/articles/on-demand-sheet-metal/)
- **OverDrafter mapping:** batch intake, derived-artifact evidence, manufacturability visualization, multi-part cost context.

### Quickparts / QuickQuote — **ADAPT**

- **OBSERVED:** Sign in/create account → secure portal upload → process/material/finish → special requirements → QuickQuote; full analysis and project pricing can follow. [QuickQuote](https://quickparts.com/gb/quickquote/)
- **OverDrafter mapping:** preserve explicit special requirements and distinguish instant result from expert-reviewed response.
- **UNKNOWN:** current logged-in viewer, drawing pairing, revision compare, handoff, mobile, and error recovery.

## Shop-side quoting tools

### Paperless Parts — **STEAL / ADAPT**

- **OBSERVED:** The 3D viewer extracts geometry, highlights manufacturability concerns, and keeps 2D, 3D, email, and Office documents together; Paperless Chat brings internal and external stakeholders into context. [Viewer enhancements](https://www.paperlessparts.com/press/new-enhancements-to-paperless-parts-3d-part-viewer-drive-greater-collaboration-operational-efficiencies-for-custom-part-manufacturers/)
- **CLAIMED:** Dashboards expose line-item states such as waiting for an outside vendor or ready for review. [ERP integration brief](https://www.paperlessparts.com/wp-content/uploads/supercharge-your-erp-with-paperless-parts-05.pdf)
- **OverDrafter mapping:** multi-document review, internal exception status, contextual supplier collaboration.
- **Adapt:** this is shop-side software; customer-facing quote evidence and supplier-neutral comparison need a different information hierarchy.

### DigiFabster — **STEAL / ADAPT**

- **OBSERVED:** Customer widget supports upload, material/process/post-process/quantity, 3D view, and configurable instant, threshold-review, manual, or TBD modes. [Review modes](https://help.digifabster.com/en/articles/3927240-all-about-order-reviews-instant-manual-semi-manual-and-tbd-mode)
- **CLAIMED:** Back office uses table/Kanban views for quote, order, payment, and file status; model library is searchable and versioned. [Operations overview](https://digifabster.com/product/from-cluttered-inbox-to-clear-trackable-manufacturing-operations/)
- **OverDrafter mapping:** explicit response modes and recoverable quote lifecycle.
- **Adapt:** keep provider-specific white-label funnels distinct from OverDrafter's neutral comparison workspace.

## CAD, PDM, and review workspaces

### SOLIDWORKS PDM — **ADAPT**

- **OBSERVED:** Windows/File Explorer-centered menus expose check-out/in, get version/revision, change state, data cards, preview, history, BOM, and where-used. [PDM menus](https://help.solidworks.com/2025/English/EnterprisePDM/FileExplorer/r_Enterprise_PDM_Main_Menu.htm)
- **OBSERVED:** Where Used is version/configuration-aware and shows hierarchy, workflow state, warnings, and checkout owner. [Where Used](https://help.solidworks.com/2025/English/EnterprisePDM/ItemExplorer/r_Item_Where_used.htm)
- **OverDrafter mapping:** impact analysis, revision evidence, typed metadata cards.
- **Avoid:** Windows-centric density and permission-dependent commands as the default buyer experience.

### GrabCAD Workbench — **HISTORICAL / STEAL**

- **HISTORICAL:** Browser CAD viewing, markup, measurement, communication, and file management made review accessible to non-CAD users. Service ended June 1, 2023 and stored data was scheduled for deletion. [Retirement notice](https://blog.grabcad.com/blog/2022/08/09/a-fond-farewell-to-grabcad-workbench/)
- **OverDrafter mapping:** low-friction browser review remains a useful mental model; product dependence on a free hosted repository without durable export/retention guarantees does not.

### Onshape — **STEAL / ADAPT**

- **OBSERVED:** Versions and History uses a graph of immutable versions, mutable workspaces, branches, merges, compare, restore, and release markers. [Versions and history](https://cad.onshape.com/help/Content/Document/versions_and_history.htm)
- **OBSERVED:** Where Used is accessible from search or a selected part/assembly and can filter by revision; release candidates preserve approvers, comments, status, and history. [Where Used](https://cad.onshape.com/help/Content/Document/where_used.htm) · [Release review](https://cad.onshape.com/help/Content/Release/reviewing_approving_rejecting_candidates.htm)
- **OBSERVED:** Revision history and comments are available on mobile. [Revision history](https://cad.onshape.com/help/Content/Release/viewing_revision_history_and_obsoleting_parts.htm)
- **OverDrafter mapping:** revision graph, impact checkpoint, mobile review/status.
- **Adapt:** quote users need a much smaller model than full CAD branching.

### OpenBOM — **ADAPT**

- **OBSERVED:** A spreadsheet-like live collaborative workspace is separated from immutable item/BOM revision snapshots; multi-level structures retain independent revisions. [Collaborative workspace](https://www.openbom.com/blog/explaining-openbom-collaborative-workspace-technology-and-revision-control-part-1)
- **CLAIMED:** Design Projects connect CAD versions to items, BOMs, suppliers, orders, and change processes. [Design Projects](https://www.openbom.com/blog/cad-integration/design-projects-explained-how-openbom-connects-design-files-data-and-collaboration-day-10)
- **OverDrafter mapping:** mixed project structures, revision snapshots, engineering-to-procurement continuity.
- **Avoid:** open-ended spreadsheet configuration where typed requirements and evidence are required.

### Autodesk Vault + Fusion Manage — **ADAPT**

- **OBSERVED:** Selecting a synced item opens a panel with properties, BOM, related changes, where-used, and files; explicit panel states cover unsynced, no access, loading, and no selection. [Fusion Manage panel](https://help.autodesk.com/cloudhelp/2026/ENU/Vault-General/files/VAULT-FM-PANEL-VIEW.htm)
- **OBSERVED:** Vault can sync current item/BOM and attachments to Fusion Manage, but does not sync item revision history. [Sync behavior](https://help.autodesk.com/cloudhelp/2026/ENU/Vault-General/files/VAULT-CONNECTOR-ITEM-ACTIONS.htm)
- **OverDrafter mapping:** contextual related-data drawer and explicit integration/recovery states.
- **Avoid:** presenting a sync as complete lineage when revision history did not cross the boundary.

### CoLab — **STEAL / ADAPT**

- **OBSERVED:** A review can include related 3D, drawings, and documents; links preserve exact view states; checklist items can pass/fail; feedback becomes filterable issues with owner/status/priority and exportable review history. [Request Reviews](https://www.colabsoftware.com/product/request-reviews)
- **OBSERVED:** Version comparison uses drawing overlays or geometric comparison beside the feedback that prompted the change. [CAD review](https://www.colabsoftware.com/use-case/design-review-cad)
- **CLAIMED:** AutoReview adds cited markups based on internal standards. [AutoReview](https://www.colabsoftware.com/product/autoreview)
- **OverDrafter mapping:** contextual issues, revision validation, auditable review packet.
- **Adapt:** keep AI findings visibly separate from human/provider findings and cite the rule/evidence.

### Bild — **ADAPT**

- **OBSERVED:** Check-ins create version blocks; revision is a separate intentional action; approvals and feedback explain why a version advanced. [Version control](https://www.getbild.com/blog/version-control-for-hardware-development)
- **OBSERVED:** CAD, drawings, quotes, and DFM documents can share a version context; feedback items attach to file locations and flow through a Kanban-style resolution view. [Supplier sharing](https://www.getbild.com/blog/sharing-files-with-vendors-suppliers-and-manufacturers)
- **OverDrafter mapping:** micro-version versus released revision, contextual decision history, supplier packet.
- **Avoid:** making check-out/in a prerequisite for read-only quote review.

## Procurement and supplier discovery

### Thomasnet — **STEAL**

- **OBSERVED:** Search by product/capability/location/certification, refine results, inspect supplier profiles, select up to five, compare side by side, and save shortlists. [Supplier discovery](https://sourcing.thomasnet.com/) · [Compare suppliers](https://help.thomasnet.com/compare-suppliers)
- **OBSERVED:** Supplier cards expose trust cues such as certifications, ownership diversity, and Thomas Verified status; shortlists export to CSV. [Smart Search](https://help.thomasnet.com/search-for-suppliers)
- **OverDrafter mapping:** neutral provider recommendations and evidence-backed shortlists.
- **Boundary:** sending RFI/RFQ is an external communication and remains outside this research task.

### MFG.com — **STEAL / ADAPT**

- **OBSERVED:** Quote review compares supplier price, lead time, reviews, and message history; the product itself cautions against choosing on price alone. [Quote comparison](https://knowledge.mfg.com/how-do-i-view-quotes-on-my-rfq)
- **OverDrafter mapping:** provider comparison dimensions and visible communication history.
- **Adapt:** reviews and responsiveness are evidence, not deterministic quality scores.

## Emerging peers to watch

| Product / pattern | Status | Why it matters | Evidence |
|---|---|---|---|
| Toolroom AI — drawing/material-list to supplier match and quote comparison | **CLAIMED / UNKNOWN** | Directly targets drawing-first procurement and transparent line totals; requires deeper legal, supplier-quality, and UI validation. | [Public product page](https://toolroomai.com/) |
| CoLab AutoReview — standards-grounded agentic review | **CLAIMED / ADAPT** | Useful precedent for an agent producing geometry-linked findings with cited organizational rules. | [AutoReview](https://www.colabsoftware.com/product/autoreview) |
| Bild Meru Delta/Echo — geometry diff and shape/function search | **CLAIMED / ADAPT** | Geometry-level comparison and cross-library reuse are strong future search patterns if results remain explainable. | [Bild engineering](https://www.getbild.com/functions/engineering-teams) |

## Coverage matrix

Legend: **O** observed public interaction evidence, **C** capability claim only, **H** historical, **?** unknown.

| Platform | Upload | Pair 3D/2D | Review | Requirements | DFM | Quote/status | Price/lead compare | Revision | Where-used | Collaboration/handoff | Supplier identity | Trust | Mobile/recovery |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Xometry | O | ? | C | O | O | O | O | O | ? | O | ? | O | ? |
| Fictiv | O | O | O | O | O | O | O | O | ? | C | C | O | O |
| SendCutSend | O | n/a | O | O | O | O | O | C | ? | O | direct | O | O |
| Protolabs/ProDesk | O | O | O | O | O | O | O | O | ? | O | direct | O | O |
| Protolabs Network | O | ? | ? | ? | C | C | ? | ? | ? | C | ? | C | ? |
| Geomiq | O | ? | ? | O | C | O | C | O | ? | O | network partly opaque | O | O |
| Weerg | O | ? | ? | C | C | O | O | ? | ? | C | direct | C | ? |
| Fractory | O | O | C | O | O | O | O | ? | ? | C | network opaque | C | O |
| OSH Cut | O | n/a | O | O | O | O | O | C | ? | O | direct | O | O |
| Quickparts | O | ? | C | O | C | O | C | ? | ? | C | direct/network unclear | O | ? |
| Paperless Parts | O | O | O | C | O | O | C | C | ? | O | shop-defined | O | ? |
| DigiFabster | O | C | O | O | O | O | O | C | ? | C | shop-defined | O | O |
| SOLIDWORKS PDM | O | O | O | O | C | workflow | n/a | O | O | O | n/a | permissions | desktop-heavy |
| GrabCAD Workbench | H | H | H | ? | ? | H | n/a | H | ? | H | n/a | H | H |
| Onshape | O | O | O | O | C | release status | n/a | O | O | O | n/a | O | O |
| OpenBOM | O | O | C | O | ? | procurement status C | C | O | C | O | O | C | ? |
| Autodesk Vault/Fusion Manage | O | O | O | O | ? | change status | n/a | O | O | O | n/a | permissions | O |
| CoLab | O | O | O | O | C | issue status | n/a | O | C | O | n/a | O | C |
| Bild | O | O | O | O | C | approval status | n/a | O | C | O | supplier users C | C | ? |
| Thomasnet | file at outreach | n/a | profiles | O | n/a | request status C | supplier compare O | lists O | n/a | shortlist/RFI O | O | O | O/? |
| MFG.com | RFQ upload C | n/a | quote table O | O | n/a | O | O | RFQ history C | n/a | messages O | O | reviews | ? |

“n/a” means the product's documented mental model does not rely on that category; it is not a quality judgment.
