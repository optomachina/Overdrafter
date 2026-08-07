# Bidirectional CAD and Drawing Roadmap

Last updated: August 7, 2026

## Status and purpose

This document captures a deferred long-term product direction for OverDrafter. It is not an active implementation plan, a committed delivery sequence, or permission to displace the current web-first customer-interest and pricing-validation work.

The long-term opportunity is broader than adding drafting tools to a quoting product. OverDrafter should eventually help customers complete a missing side of a manufacturable design package, preserve the result as editable engineering data, and carry the reviewed package into quoting and purchasing workflows.

The target transformation is bidirectional:

```text
CAD or part geometry -> editable manufacturing drawing
Manufacturing drawing -> editable CAD or part geometry
Prompt plus references -> editable CAD and drawing package
Reviewed design package -> quotes -> procurement or purchase workflow
```

The generated artifact must be editable and verifiable. A visually similar image, flattened drawing, or unstructured mesh is not a sufficient result.

## Customer segments and jobs to be done

### Customers with drawings but no CAD geometry

The product owner has identified this as an existing customer segment, not merely a speculative future use case. These customers may have legacy drawings, supplier drawings, scanned or digital prints, or replacement-part documentation but no usable 3D model. Before implementation is prioritized, customer discovery should attach durable evidence and quantify segment size, request frequency, current alternatives, and willingness to pay.

They need to:

- upload one or more drawings without an accompanying part model
- reconstruct editable CAD geometry, with STEP as the likely first neutral output
- review and correct inferred dimensions, features, holes, datums, fits, tolerances, and material or finish intent
- obtain quotes against a reviewed and version-pinned design package
- purchase newly manufactured parts through the appropriate future procurement workflow

This path supports legacy-part digitization, replacement-part procurement, supplier transition, and recovery from missing native CAD data.

Before reconstruction, quoting, vendor sharing, or purchasing, the customer must attest that they are authorized to reproduce the part and provide the source material for the intended use. The workflow must retain that attestation and the applicable sharing scope as audit evidence, screen for export-controlled, proprietary, regulated, or safety-critical content, and route uncertain or prohibited cases to an explicit escalation or denial path. Possession of a drawing is not by itself evidence of reproduction rights.

### Customers with CAD geometry but no drawing

These customers have a STEP or native CAD model but lack a manufacturing-ready drawing.

They need to:

- upload geometry without a drawing
- generate editable orthographic, section, detail, and auxiliary views
- select exact faces, edges, holes, axes, and other topology while authoring dimensions and callouts
- assign datums, fits, tolerances, GD&T, surface finish, material, process, and manufacturing notes
- review the resulting drawing and use it with the same quoting and purchasing workflow as an uploaded drawing

### Customers with incomplete or conflicting packages

Some customers will have both CAD and drawings, but the two will be incomplete, stale, or inconsistent. OverDrafter should eventually compare the artifacts, identify discrepancies, and let the user decide which source governs each field or feature before quoting or release.

### Customers beginning from intent or reference material

Further long term, a customer may begin with a natural-language prompt, reference images, partial dimensions, or an existing related design. The system may propose editable geometry and drawings, but it must surface missing constraints and request clarification instead of inventing manufacturing-critical intent.

## Product requirements for an editable result

"Editable" means the resulting design package supports, at minimum where applicable:

- constrained sketches and explicit dimensions
- a rebuildable parametric feature history rather than only a mesh
- selectable bodies, faces, edges, vertices, axes, planes, holes, and feature references
- editable hole sizes, depths, thread intent, patterns, radii, chamfers, and other modeled features
- datum definition and datum-reference selection
- authored fits, tolerances, GD&T, surface finish, material, process, and manufacturing notes
- associative drawing views and annotations tied to persistent topology references
- explicit units and conversion behavior
- immutable source artifacts, version identity, provenance, and human overrides
- deterministic regeneration and geometry checks after every accepted edit

Natural language is the primary orchestration surface, not the only precision surface. Direct geometry selection, structured engineering fields, tables, and exact numeric entry remain necessary wherever language alone would be ambiguous or unsafe.

## Target workflows

### CAD or part geometry to editable drawing

1. Ingest a STEP or supported native CAD artifact and preserve the original unchanged.
2. Normalize exact geometry and persistent topology references.
3. Propose drawing views, dimensions, detected holes or features, and manufacturing callouts.
4. Let the user select geometry and add, remove, or edit dimensions, datums, fits, tolerances, and notes.
5. Validate that every associative annotation still resolves after changes.
6. Submit the package to the engineering release gate; unresolved or unsupported manufacturing-critical intent blocks release.
7. Publish an immutable released drawing revision and pin quotes or later orders to that exact design package.

This is the smallest strategically coherent future slice because it extends an uploaded model toward RFQ readiness without first solving general drawing-to-CAD reconstruction.

### Drawing to editable CAD geometry

1. Preserve the uploaded drawing as source evidence.
2. Parse sheets, projection views, dimensions, centerlines, sections, detail views, title-block fields, and manufacturing callouts.
3. Infer candidate sketches, features, constraints, topology, and view relationships with per-decision provenance and confidence.
4. Identify under-specified or conflicting geometry and ask targeted clarification questions.
5. Generate exact geometry and a rebuildable feature representation.
6. Reproject the generated model into the drawing views and compare dimensions, silhouettes, sections, hole locations, and other available evidence.
7. Require explicit review for unresolved ambiguity or manufacturing-critical inferred intent; unresolved or unsupported critical intent blocks release.
8. Record an immutable engineering release with the required signoff evidence.
9. Export a released neutral model, initially likely STEP, and attach it to the same versioned design package used for quoting and procurement.

A two-dimensional drawing does not always determine one unique three-dimensional model. The system must present a proposed construction and its evidence rather than silently claiming certainty.

### Associative co-editing

The mature experience should keep geometry, drawings, and manufacturing intent synchronized:

- changing an accepted drawing dimension rebuilds the affected geometry
- changing a modeled feature updates its associated drawing views and callouts
- selecting geometry can assign datums, tolerances, surface requirements, or manufacturing notes
- a natural-language request produces a bounded preview showing the geometry, drawing, and downstream artifacts that would change
- a commit is accepted only against the reviewed source revision and produces a new immutable version

## Canonical design representation

OverDrafter should not make any vendor-native CAD file the sole source of truth. The long-term architecture needs a vendor-neutral canonical design representation that can preserve or reference:

- immutable source artifacts and content hashes
- exact B-rep geometry and deterministic artifact-local topology identifiers
- sketches, constraints, parameters, features, bodies, and assemblies
- drawing sheets, views, dimensions, annotations, and persistent geometry associations
- manufacturing intent including material, process, holes, threads, datums, fits, tolerances, GD&T, and finish
- inferred-value evidence, confidence, review state, and human overrides
- version lineage, current pointers, released snapshots, and downstream quote or order pins

This is a target contract, not a final schema decision. It should extend the existing `canonical-part-geometry.v1`, artifact, review, override, project, part, assembly, service-request-line-item, and future version concepts instead of creating a second top-level workflow model. Every modeling or redraft artifact must remain linked to the authoritative `cad_modeling` or `drawing_redraft` service request line item that owns its scope, status, scheduling, dependencies, and downstream quote lineage.

Artifact-local identity and cross-version correspondence are different contracts. A new version may map an old topology reference to a new one only with recorded provenance and confidence. Split, merged, deleted, or ambiguously rematched topology must invalidate the association and require explicit repair; ordinal or regenerated identifiers must never silently reattach manufacturing intent to a different entity.

## Inference and verification rules

- Preserve the original CAD and drawing artifacts; generated outputs never overwrite source evidence.
- Treat model inference as advisory until deterministic checks and required human review pass.
- Carry provenance at feature, dimension, callout, and manufacturing-intent boundaries rather than returning bare inferred values.
- Fail closed when views conflict, critical dimensions are missing, topology references break, or generated geometry cannot be rebuilt exactly.
- Compare generated geometry against every usable drawing view and dimension, not only a rendered isometric image.
- Never infer a manufacturing-critical tolerance, datum scheme, fit, material, or process silently.
- Pin each quote, released package, and future order to the exact reviewed design version that produced it.

Review and release are separate states. Only a capability-gated engineering release authority may release a package for vendor transmission, quoting, or purchasing, with separation of editing and release duties where policy or regulated use requires it. Release requires recorded signer identity, time, reviewed version, validation results, resolved critical findings, and customer authorization evidence. The release transition creates an immutable snapshot; ordinary project membership or an editable "reviewed" status is not sufficient authority.

## CAD format and execution strategy

### Stage 1: neutral and OverDrafter-native outputs

Start with formats that can be generated and verified without automating a proprietary desktop application:

- STEP, preferably AP242 where the chosen toolchain preserves the required product and manufacturing information
- PDF, SVG, and DXF drawing outputs as appropriate
- an editable OverDrafter design-package representation

The editable OverDrafter design package remains the parametric authority in this stage. Neutral outputs such as STEP may preserve exact geometry and some product-manufacturing information without preserving native feature history. Every export is a derivative bound to its authority version and content hash, must declare its editability level, and must include a machine-readable translation-loss manifest covering unsupported features, parameters, associations, annotations, and manufacturing intent. A neutral export is not evidence that a target CAD system can recover the full authored history.

### Stage 2: supported native integrations

Add native CAD formats through documented vendor APIs, cloud platforms, add-ins, or plugins where they provide stable access to feature, drawing, and metadata operations. Each backend should advertise capabilities rather than implying uniform support across CAD systems.

### Stage 3: agent-operated licensed CAD environments

For formats or operations unavailable through stable APIs, OverDrafter may run a properly licensed, isolated virtual machine or remote workstation and operate the selected CAD application agentically.

Virtual-machine automation is a compatibility backend, not the canonical design authority. The agent should apply a typed, bounded edit plan, export a neutral verification artifact, and compare the result with the canonical design representation. UI automation must fail closed on unexpected dialogs, rebuild warnings, version drift, missing fonts or templates, licensing failures, or unverifiable output.

Stage 3 requires hardened untrusted-file execution controls before customer use: per-tenant ephemeral environments; macro, script, unapproved add-in, and external-link suppression; malware scanning; restricted network egress; isolated short-lived credentials; allowlisted import and export paths; output quarantine and validation; complete action and artifact audit logs; bounded retention; and verified teardown. A failure in any control prevents artifact release or vendor transmission.

## Quoting and purchasing connection

Generated geometry and drawings are valuable because they complete a manufacturable package, not because generation is an isolated novelty.

The intended downstream connection is:

1. The user reviews the generated or reconciled design package and resolves all blocking engineering findings.
2. An authorized engineering releaser records an immutable released version, its provenance, validation evidence, and required customer authorization evidence.
3. DFM, extraction, and quote preparation operate on that exact version.
4. Vendor quotes and selected offers remain pinned to it.
5. A future authorized procurement or purchasing workflow uses the same pinned package so a later edit cannot silently change what was quoted or ordered.

This direction does not authorize current manufacturing payment collection, purchase-order issuance, or automated supplier ordering. Those remain separate controlled capabilities.

## PartMode and similar systems

PartMode is relevant as a technology reference and possible experimental substrate because it demonstrates exact browser-side B-rep geometry, editable features and assemblies, drawing generation, and typed agent operations with inspect, preview, revision, and commit boundaries.

It should not currently become OverDrafter's canonical project, PDM, authorization, or production geometry system. Before any dependency or integration decision, validate at least:

- unattended import of existing customer STEP and assembly artifacts
- geometry and drawing fidelity against a representative corpus
- persistent-topology behavior across edits
- data retention, tenancy, security, and deletion controls
- operational maturity and versioned compatibility
- the public repository's AGPL v3 obligations, third-party dependency licenses, and any separate hosted, agent, support, or commercial terms for the intended deployment boundary

The reusable lesson is the capability-driven, typed transaction model. Direct source reuse or production dependency is a separate decision.

## Deferred sequencing hypothesis

When this track is explicitly authorized, prefer the following dependency order:

1. Define the canonical design-package and persistent-reference contracts.
2. Establish representative CAD, drawing, and paired-artifact benchmark corpora.
3. Deliver CAD-to-editable-drawing for a narrow STEP and drawing-standard scope.
4. Deliver drawing-to-proposed-geometry for constrained part families with explicit ambiguity review.
5. Add associative bidirectional edits and deterministic regeneration checks.
6. Expand assemblies, richer PMI/GD&T, and revision-aware review.
7. Add supported native CAD adapters.
8. Use isolated agent-operated CAD environments only for remaining compatibility gaps.

Each stage should prove accuracy, editability, provenance, and downstream quote-package integrity before expanding formats or feature families.

## Explicit non-goals for the first future slice

- claiming arbitrary drawings can be reconstructed without ambiguity
- replacing established CAD systems across their entire feature surface
- treating meshes or screenshots as editable engineering authority
- promising every native CAD format through one uniform capability set
- making a generated model quote-ready without review and deterministic verification
- coupling experimental CAD generation to current billing, ordering, or unattended production enablement

## Relationship to current execution

The active plan remains web-first validation of the existing upload, sourcing, quote, and manual handoff experience. This roadmap is retained so future CAD-native, drafting, modeling, PDM, and procurement work composes toward one coherent product instead of becoming disconnected features.
