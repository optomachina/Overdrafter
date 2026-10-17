# North Star notes for OVD-799 v3 (read 2026-10-15, 9:40 PM PT)

Sources: Linear document ee801d1f-3190-430f-aea5-13f1bcbe2077 (full text below), project 'North Star Prototype — General Engineering Command Loop' (f43d1321, description below; it has no other documents), its 48 issues (titles and status below; full text read for OVD-494, OVD-472, OVD-520, OVD-765; the rest from list descriptions).

## Key quotes driving v3

- Decision: "Engineers direct outcomes, inspect evidence-backed alternatives, resolve exceptions, and approve decisions. Specialized agents work in parallel while a license-aware execution broker commits approved changes to native CAD in the background."
- Principle 1: "Intent over application commands. Users specify outcomes and constraints rather than sketches, dimensions, mates, and menus."
- Principle 3: "Parallel thought, controlled commits. Many agents work simultaneously; limited native-CAD lanes commit changes safely."
- Principle 5: "Evidence before approval. Recommendations expose calculations, assumptions, sources, geometry consequences, risks, and uncertainty."
- Principle 6: "Exception-driven human involvement. Humans are interrupted for judgment, missing authority, or unresolved tradeoffs."
- Jarvis step 2: "Interpret the intended outcome, constraints, tradeoffs, authority, and uncertainty."
- Jarvis step 6: "Present decisions with evidence, assumptions, risks, cost, schedule, and downstream consequences."
- Committed: "The interface must never represent Working state as Committed merely because a speculative visualization looks correct." and "A private candidate is not Committed to the authoritative design until that exact adoption is verified."
- Independent verification: "The creating agent does not solely judge its own result."
- Non-goal: "Recreating the SolidWorks desktop interface on mobile."
- Project constraint: "Baseline, Working, and Committed states remain explicit."
- OVD-494: "Sending text alone never creates an accepted decision or starts CAD." / "Do not animate fabricated thinking or CAD progress." / "concise progress, context questions and decision prompts, with CAD visible"
- OVD-472: "Native execution success or accepted intent alone never implies verified, adopted or committed CAD."
- OVD-520: "phone/desktop show truthful execution versus verification states."

## North Star document (full)

# Decision

OverDraft's North Star is a **general, Jarvis-like engineering intelligence and execution system for physical product development**.

It sits above SolidWorks, PDM, supplier data, simulation, standards, documentation, and other engineering tools. Engineers direct outcomes, inspect evidence-backed alternatives, resolve exceptions, and approve decisions. Specialized agents work in parallel while a license-aware execution broker commits approved changes to native CAD in the background.

**Status:** Accepted
**Decision date:** September 4, 2026
**Owners:** Blaine Wilson and Jaime Santa Cruz

**Implementation refinement — September 7, 2026:** Blaine approved the engineering-control-plane plan and its bounded offline foundation (<issue id="cdf325b5-4541-47ef-9016-9dc71196e375" href="https://linear.app/overdrafter/issue/OVD-476/define-the-general-engineering-ontology-and-cross-artifact-identity">OVD-476</issue>, <issue id="bc1ffc7b-eaca-4d27-8be3-9720ba7f10e7" href="https://linear.app/overdrafter/issue/OVD-472/define-the-baseline-working-and-committed-state-machine">OVD-472</issue>, <issue id="a5cd5e1a-42ac-4ebd-ae8c-9e9125ab8913" href="https://linear.app/overdrafter/issue/OVD-470/specify-cad-transaction-conflict-reconciliation-and-rollback-contracts">OVD-470</issue>). The first customer pilot is desktop-first and uses prepared assemblies for queued dimension changes, approved component addition/suppression/substitution, and DFM/DFA review. It delivers an evidence-bound native candidate export; official CAD/PDM adoption remains manual until separately qualified. This does not replace Part-to-Quote priority or satisfy customer/native promotion gates. The repository technical contract is `docs/engineering-control-plane.md`.

> The product is not SolidWorks on a phone. It is the engineering command system that makes direct interaction with SolidWorks increasingly unnecessary.

# Core assumption

AI CAD performance will continue improving until agents exceed the best human designers and engineers on bounded tasks and eventually on increasingly general engineering work.

The limiting problems then become:

* Understanding the product and the engineer's actual intent.
* Adapting to unfamiliar engineering requests.
* Coordinating many parallel specialists.
* Selecting and composing the correct tools.
* Preserving requirements, constraints, decisions, and organizational memory.
* Safely converting parallel decisions into native-CAD changes.
* Verifying results independently.
* Using expensive serial CAD capacity efficiently.
* Preserving human authority over consequential decisions and release.

# What “Jarvis” means

OverDraft must maintain a general engineering world model and an adaptive reasoning loop. It must not become a catalog of brittle request-specific solvers.

For each request, it should:

1. **Perceive** the selected product context, files, geometry, requirements, history, external facts, and current state.
2. **Interpret** the intended outcome, constraints, tradeoffs, authority, and uncertainty.
3. **Plan** the required analyses, information gathering, alternatives, native actions, and verification.
4. **Discover and compose** appropriate calculations, standards, supplier searches, simulations, CAD operations, documentation actions, and specialist agents.
5. **Act speculatively** in Working state without waiting for native CAD.
6. **Present decisions** with evidence, assumptions, risks, cost, schedule, and downstream consequences.
7. **Execute** approved changes through controlled native-tool workers.
8. **Verify and reconcile** the result independently.
9. **Learn** from approval, rejection, correction, manufacturing, inspection, and field outcomes.

If the system receives a question it has never seen, it should construct a defensible method rather than require a new hard-coded workflow.

# Product principles

1. **Intent over application commands.** Users specify outcomes and constraints rather than sketches, dimensions, mates, and menus.
2. **General capabilities over dedicated solvers.** Analysis and execution tools are modular capabilities dynamically selected by the planner.
3. **Parallel thought, controlled commits.** Many agents work simultaneously; limited native-CAD lanes commit changes safely.
4. **Engineering state may lead CAD state.** Decisions and speculative representations can exist before SolidWorks finishes implementing them.
5. **Evidence before approval.** Recommendations expose calculations, assumptions, sources, geometry consequences, risks, and uncertainty.
6. **Exception-driven human involvement.** Humans are interrupted for judgment, missing authority, or unresolved tradeoffs.
7. **Native deliverables remain authoritative.** SolidWorks and PDM outputs rebuild, validate, and remain usable by customers and suppliers.
8. **Every outcome compounds.** Requests, operations, failures, reviews, decisions, and manufacturing outcomes become engineering memory.
9. **Licenses are scarce execution capacity.** OverDraft maximizes legitimate throughput per purchased CAD license without circumventing entitlements.

# Engineering states

## Baseline

The last authoritative SolidWorks/PDM revision and its associated released artifacts.

## Working

The current intent, constraints, calculations, decisions, proposed geometry, external facts, and pending native transactions. Working state may advance immediately while SolidWorks remains unchanged.

## Committed

Use explicit realized-candidate and authoritative-adoption states within this concept. Native execution success, verified candidate output, approved export, and observed CAD/PDM adoption are different milestones. A private candidate is not Committed to the authoritative design until that exact adoption is verified.

The interface must never represent Working state as Committed merely because a speculative visualization looks correct. Candidate identity includes its exact baseline, included decision revisions, requirements, dependencies, toolchain and outputs; decision numbers are not a PDM revision frontier.

# Illustrative interaction

An engineer views an optical alignment assembly from a phone and asks how much resolution and travel are needed on a decentering mechanism.

OverDraft identifies the relevant optics, tolerance, kinematic, mechanical, procurement, and CAD considerations. It calculates a defensible requirement, exposes assumptions and uncertainty, finds current candidates from suppliers and internal inventory, ranks them by technical fit, cost, availability, lead time, and required design changes, and immediately previews alternatives in Working state.

The engineer approves an option. SolidWorks later catches up through a controlled background transaction and returns a verified native assembly, drawings, BOM changes, and decision record.

This is an **evaluation case**, not a dedicated adjuster workflow. The same planner, world model, capability registry, transaction broker, and verifier must also handle structurally different requests such as geometry redesign, tolerance analysis, drawing-package generation, manufacturability review, component substitution, or release preparation.

# Architecture

## Command interface

Mobile, desktop, and web project threads; voice/text intent; visual selection and markup; alternatives; decisions; approvals; and exceptions.

## General engineering world model

A structured representation of:

* Product structure and geometry.
* Requirements and constraints.
* Assumptions and uncertainty.
* Calculations and simulation results.
* Drawings, BOMs, properties, and PDM state.
* Supplier, inventory, price, lead-time, and availability facts.
* Decisions, alternatives, rationale, and authority.
* Native and speculative artifact state.
* Provenance, freshness, and confidence.

## Adaptive engineering orchestrator

Interprets unfamiliar requests, identifies required disciplines and missing context, creates dependency graphs, discovers and composes capabilities, launches specialized agents, evaluates results, and replans from new evidence.

## Capability registry

Every tool declares:

* What it can do.
* Required inputs and produced outputs.
* Authority and permissions.
* Cost and latency.
* Evidence and provenance.
* Failure behavior.
* Verification requirements.

Supplier adapters, calculations, simulations, CAD operations, standards lookup, and document generation are capabilities within this registry—not separate controlling architectures.

## Speculative engineering layer

Creates immediate Working-state alternatives using native geometry, simplified models, envelope proxies, calculations, and decision branches before native CAD execution completes.

## CAD transaction broker

Queues semantic operations, resolves conflicts, batches compatible work, leases licensed CAD capacity, records deterministic operation logs, and reconciles intended with native outcomes.

## Native SolidWorks workers

Warm, isolated Windows workers perform only operations requiring authoritative SolidWorks execution: native modeling, rebuild, assembly changes, drawing regeneration, exports, and supported add-in operations.

## Independent verification

The creating agent does not solely judge its own result. Verification applies request-specific acceptance criteria plus applicable rebuild, reference, mate, interference, mass-property, configuration, drawing, BOM, revision, and company-rule checks.

## Engineering memory

Every request preserves scoped history: context, plan, tool selection, operations, failures, corrections, decisions, reviews, and downstream outcomes. Searchable history, reviewed lessons, organizational standards, trainable examples and executable rules have separate promotion requirements. Training and cross-customer reuse require explicit usage rights; raw customer history does not automatically become training data.

# License-aware execution model

Start with one controlled native execution lane in a qualified deployment. Exact license consumption and supported concurrent/unattended use must be verified for the selected SolidWorks edition, service pack and Windows environment; do not infer entitlement from a worker or process count.

Agents perform requirements analysis, calculations, sourcing, DFM, GD&T planning, alternative generation, documentation, and cached-model reasoning outside SolidWorks. Completed semantic transactions enter the licensed queue only when authoritative native execution is required.

The scheduler minimizes model opens, add-in changes, configuration switches, PDM conflicts, and redundant rebuilds. Compatible transactions may be batched without compromising traceability.

Primary efficiency metric:

**Accepted engineering changes per licensed SolidWorks minute.**

# Conflict model

Native SolidWorks binaries are not merge targets.

* Agents produce semantic operation logs.
* Operations carry source revision, entity identity, and geometry preconditions.
* The broker serially replays valid operations against the current model.
* Stale operations are replanned.
* Conflicting intent is resolved before native commit.
* Independent parts may execute concurrently when multiple licensed workers exist.
* Same-part and tightly coupled assembly changes remain serialized.

# Generality requirement

The first North Star prototype must complete at least three structurally different engineering requests using the same:

* World model.
* Intent interpreter.
* Planner.
* Capability registry.
* Agent orchestration.
* Evidence format.
* Transaction architecture.
* Verification and reconciliation system.

No evaluation case may introduce a privileged scenario-specific orchestration path.

# Strategic sequence

The current OverDrafter 1.0 Controlled Beta — Part to Quote remains the active execution priority.

The North Star does not justify abandoning the narrow commercial wedge or starting a multiyear platform build. Existing quoting, identity, authorization, provenance, artifact, and evidence foundations should become reusable capabilities within the eventual general system.

The North Star project remains Backlog until its entry gate is explicitly satisfied.

The explicitly approved offline contract slices may proceed in isolated development without claiming the customer-pilot gate has passed. Production persistence, native execution, customer disclosure and PDM publication remain separately gated. Native operations are bounded attempts with checkpoints and recovery; there is no assumed all-or-nothing transaction across CAD, PDM, BOM and ERP.

# North Star prototype milestones

1. **General Engineering World Model**
   * Product context, engineering state, semantic identity, provenance, and transaction contracts.
2. **Adaptive Reasoning & Tool Orchestration**
   * Dynamic decomposition, capability discovery, tool composition, uncertainty handling, and replanning.
3. **Controlled Native Execution**
   * Licensed worker scheduling, isolated native changes, independent verification, reconciliation, and rollback.
4. **Generality & Mobile Command Demonstrated**
   * At least three dissimilar engineering requests directed from a phone through the same architecture.

# Success measures

* Percentage of useful requests handled without a dedicated workflow.
* Accepted changes per licensed SolidWorks minute.
* Time from expressed intent to defensible decision.
* Time from approved decision to verified native commit.
* First-pass transaction success rate.
* Human interventions per accepted change.
* Working-to-Committed reconciliation accuracy.
* Percentage of work completed without direct SolidWorks interaction.
* Reuse rate of captured engineering knowledge.
* Manufacturing escapes attributable to automated work.

# Non-goals

* Recreating the SolidWorks desktop interface on mobile.
* Remote-desktop control as the primary interaction model.
* Building a separate solver for every class of engineering question.
* Encoding the optical-adjuster example as a privileged workflow.
* Binary merging of independently modified SolidWorks files.
* Circumventing customer licensing.
* Unverified autonomous production release.
* Delaying the existing narrow demo and paid-pilot work to build the entire platform.

# Immediate architectural decisions

* General engineering ontology.
* Context selection and retrieval strategy.
* Adaptive planner and replanning architecture.
* Capability and specialist-agent contracts.
* Cross-request evaluation suite.
* Semantic identity across CAD and non-CAD artifacts.
* Working-state representation and speculative geometry.
* Native transaction boundaries and rollback.
* SolidWorks worker hosting and license leasing.
* PDM checkout, revision, and reconciliation.
* Independent verification evidence.
* Customer deployment, security, audit, and IP isolation.

## Project description (full)

## Current finish line — approved September 26, 2026

Finish one complete phone → SolidWorks → independently checked result workflow (<issue id="30e36799-8929-4f50-9908-8acc91ae280f" href="https://linear.app/overdrafter/issue/OVD-520/prove-one-connected-7-mm-request-from-phone-to-native-result">OVD-520</issue>). Broad general-engineering, fleet, GLB/portable identity, and general mobile product work remain preserved for later; they must not block this milestone without specific causal evidence. Parent issues coordinate outcomes; only bounded leaf issues receive implementation chats. Maximum three concurrent workers across JARVIS and 1.0. Source completion and protected live activation remain distinct.

## Strategic role

This is the first bounded prototype of the OverDraft North Star: a general, Jarvis-like engineering intelligence and execution system above legacy CAD.

The optical-adjuster conversation is an **illustrative request**, not a dedicated feature or solver. The system must interpret unfamiliar engineering requests, construct the necessary analysis and execution plan, select or compose appropriate tools, produce alternatives, explain tradeoffs, and safely commit approved results.

This project does **not** replace or interrupt the active OverDrafter 1.0 Controlled Beta — Part to Quote. It remains Backlog until the entry gate is satisfied.

## Entry gate

* The 1.0 Founding Beta evidence is complete or an explicit promotion decision is recorded.
* Customer evidence supports expanding from the current bounded workflow.
* The prototype reuses existing identity, authorization, quote, provenance, and evidence foundations.
* Native CAD automation is bounded, reversible, and isolated from released customer data.

## Outcome

From a phone or web command surface, an engineer can ask a materially different range of mechanical, opto-mechanical, documentation, procurement, and design-change questions. OverDraft builds an adaptive plan, gathers required context, invokes general tools and specialized agents, presents evidence-backed alternatives in Working state, and commits approved native CAD changes in the background.

## Generality requirement

No scenario-specific orchestration path may be required for the demonstration. Optical-adjuster selection may be one evaluation case, but the same core planner, context model, tool registry, transaction broker, and verification system must complete at least two structurally different engineering requests.

## Architectural constraints

* Baseline, Working, and Committed states remain explicit.
* The system maintains a general engineering world model rather than a catalog of hard-coded workflows.
* Tools are modular capabilities selected and composed at runtime.
* Many agents may reason in parallel; licensed SolidWorks execution remains controlled and serialized per worker.
* External facts always carry provenance and observation time.
* Native CAD files are never binary-merged.
* Every native operation is a deterministic transaction with preconditions, acceptance tests, and rollback.
* Independent verification and human release authority are preserved.
* Every request, decision, execution result, correction, and downstream outcome becomes engineering memory.

## Related existing portfolio areas

* Incubator — CAD & Design Lifecycle
* Incubator — Supplier Network
* Incubator — Manufacturing Intelligence
* Incubator — Native & Cross-platform Apps
* Incubator — Compliance, Quality & Managed Services

## September 7, 2026 implementation sequencing

Blaine approved implementing the staged engineering-control-plane plan. Begin with bounded offline internal ontology, state and transaction contracts in <issue id="cdf325b5-4541-47ef-9016-9dc71196e375" href="https://linear.app/overdrafter/issue/OVD-476/define-the-general-engineering-ontology-and-cross-artifact-identity">OVD-476</issue>, <issue id="bc1ffc7b-eaca-4d27-8be3-9720ba7f10e7" href="https://linear.app/overdrafter/issue/OVD-472/define-the-baseline-working-and-committed-state-machine">OVD-472</issue> and <issue id="a5cd5e1a-42ac-4ebd-ae8c-9e9125ab8913" href="https://linear.app/overdrafter/issue/OVD-470/specify-cad-transaction-conflict-reconciliation-and-rollback-contracts">OVD-470</issue>, with synthetic tests and no production/native integration. The customer pilot remains gated behind Part-to-Quote and customer evidence. Its initial scope is prepared assemblies, queued dimension changes, approved component addition/suppression/substitution and DFM/DFA review, followed by verified candidate comparison/export and manual authoritative adoption. Desktop comes before the general mobile demonstration. Worker qualification, persistent services and cross-system publication remain separate gates. Native operations are recoverable attempts, not atomic cross-system transactions; no binary native merge or automatic training-data rights are implied.

## Project issues

- OVD-740 [Done] Jarvis U7: Admin flagged /engineering in the hosted build, lazy loaded, off by default
- OVD-765 [Done] Jarvis demo: phone-triggered multi-part assembly via CAD-neutral worker (Workstation offline)
- OVD-743 [Done] Jarvis U3: Window 2 Jarvis packet and full chain rehearsal
- OVD-510 [Done] Constrain native verifier database authority before restoring delivery
- OVD-520 [Done] Prove one connected 7 mm request from phone to native result
- OVD-558 [Done] Commit reversible native verifier authority migration
- OVD-576 [Done] Atomically admit trusted stop evidence and release the exact native attempt
- OVD-575 [Done] Store immutable observer evidence with restricted validator attribution
- OVD-563 [Done] Bind exact STEP review bytes to a finalized native result
- OVD-561 [Done] Finalize verified native results atomically with replay and race safety
- OVD-560 [Done] Register immutable native results and deliver bounded verifier objects
- OVD-738 [Done] Jarvis U5: Carve 7 transport registration binding onto main's TransferBudget
- OVD-739 [Done] Jarvis U6: Deterministic interpretation adapter for one "set depth to N mm" request
- OVD-745 [Backlog] Jarvis U12: OVD-520 run evidence record
- OVD-744 [Backlog] Jarvis U10: OVD-520 activation packet
- OVD-742 [Backlog] Jarvis U8: Trusted host launcher for the artifact route and finalization
- OVD-741 [Backlog] Jarvis U4: Carve 5 first loop runtime composition and Storage version probe
- OVD-562 [Done] Connect paired companion task claim and heartbeat to the native runner
- OVD-505 [Blocked] Finalize verified native candidates from immutable stored evidence
- OVD-511 [Backlog] Restore one atomic native-result finalization behind qualified admission
- OVD-600 [Done] Pin that a native operation failure is never retried automatically
- OVD-599 [Done] Drop suffix validator roles leaked by the OVD-561 race proof
- OVD-578 [Done] Build the approved sample plate from the local app using Jev
- OVD-589 [Done] Test retained engineering requests across browser restart
- OVD-588 [Done] Propagate cancellation through artifact registration
- OVD-579 [Done] Enable private phone access to the verified sample plate app
- OVD-577 [Done] Wire default-off native stop repository and worker transport
- OVD-574 [Done] Produce independent Windows stop evidence for one prepared native attempt
- OVD-519 [Done] Deliver immutable prepared-job inputs and outputs through the companion
- OVD-518 [Done] Persist bounded interpretation of prepared depth requests
- OVD-559 [Done] Classify prepared depth requests deterministically
- OVD-502 [Done] Export exact cumulative candidate geometry for CAD previews
- OVD-557 [Done] Prove seven-signature verifier authority in a disposable database
- OVD-509 [Done] Qualify trusted Windows filesystem identity for native result admission
- OVD-497 [Done] Persist ordered prepared changes and explicit suffix cancellation
- OVD-503 [Done] Persist native attempt journals and qualified process recovery evidence
- OVD-501 [Done] Persist exclusive native task ownership and explicit recovery
- OVD-494 [Done] Review prepared changes in a conversational CAD workspace
- OVD-476 [Done] Define the general engineering ontology and cross-artifact identity
- OVD-495 [Done] Execute cumulative prepared dimension changes from verified predecessors
- OVD-500 [Done] Persist recoverable Windows companion pairing and startup
- OVD-493 [Done] Export exact prepared assembly geometry for local CAD review
- OVD-498 [Done] Persist scoped worker pairing and explicit execution sessions
- OVD-472 [Done] Define the Baseline, Working, and Committed state machine
- OVD-490 [Done] Execute a prepared assembly dimension request on Workstation
- OVD-491 [Done] Review queued prepared assembly changes in an internal workbench
- OVD-489 [Done] Import prepared assembly context and queue exact dimension requests
- OVD-470 [Done] Specify CAD transaction, conflict, reconciliation, and rollback contracts

## OVD-494 Review prepared changes in a conversational CAD workspace (full)

## Summary

Replace the internal engineering form with a conversation-led workspace and visible real before/after CAD.

## Problem and outcome

The user expected ChatGPT-style requests, concise progress, context questions and decision prompts, with CAD visible. The current record-centric workbench proves execution but does not deliver that interaction.

## Scope

Keep the existing local opt-in development route. Conversation composer and messages, focused clarification, exact evaluation proposal/confirmation, factual waiting/result status, explicit operator handoff, and digest-bound real STEP baseline/candidate comparison using existing renderer. Preserve refresh/stale-tab/reset safeguards, failure visibility, five queued decisions and unadopted status. Keep operator JSON/provenance controls in a clearly labeled secondary panel. Responsive and keyboard accessible.

## Out of scope

Production quote navigation, general LLM inference, automatic Windows dispatch/monitoring, component picking/difference solver, customer files, release approval/PDM or multi-user backend.

## Implementation notes

Reuse existing prepared-workflow and CadModelThumbnail. Add a scoped conversation module and preview manifest validation through separately reviewed pieces. Render actual saved geometry only when exact bindings match; unexecuted proposals retain baseline and an explicit awaiting-result label. Do not animate fabricated thinking or CAD progress.

## Acceptance criteria

- [ ] Engineer can ask for a supported change, answer clarification and explicitly confirm evaluation.
- [ ] Sending text alone never creates an accepted decision or starts CAD.
- [ ] Actual baseline and exact completed candidate render visibly with orbit/zoom and clear before/after labels; missing/stale preview fails visibly.
- [ ] Concise progress and evidence match actual state; unexecuted requests are never shown as realized geometry.
- [ ] Five decisions, persistence failure, refresh, stale-tab/reset and imported-result safeguards remain verified.
- [ ] Recorded interaction visibly demonstrates the conversation and real CAD difference after required verification/reviews.

## Testing

Pure interpreter/preview binding tests; page interaction/error/accessibility tests; actual STEP parsing and desktop/mobile browser verification; full repository gate, production exclusion, local/hosted reviews and recorded shareable demo.

## Dependencies and source context

Merged <issue id="c0d35efd-ae3f-4cb3-b365-adb335c97216" href="https://linear.app/overdrafter/issue/OVD-491/review-queued-prepared-assembly-changes-in-an-internal-workbench">OVD-491</issue>; new bounded conversation and native-preview pieces. User's September 8 feedback and “Sounds good, proceed” expressly select this UI direction for the internal CAD lane. Part-to-Quote's artifact-first product and release priority remain intact. Combined milestone is High and explicitly decomposed with one integrator. No database migration.

## OVD-472 Define the Baseline, Working, and Committed state machine (full)

## Summary

Implement a pure Baseline, Working, and Committed state model.

## Problem

Accepted engineering decisions must advance independently of native CAD without losing exact identity, evidence or authority. This is one bounded slice of the user-approved September 7, 2026 engineering-control-plane plan.

## Outcome

Implement a pure Baseline, Working, and Committed state model with locally executable contract tests.

## Scope

An internal state-transition model over the <issue id="cdf325b5-4541-47ef-9016-9dc71196e375" href="https://linear.app/overdrafter/issue/OVD-476/define-the-general-engineering-ontology-and-cross-artifact-identity">OVD-476</issue> contracts, with no persistent database/API, queue dispatch, or native mutation. Durable production storage remains <issue id="9274cf8e-84d4-4f0b-9a8b-5486a45e9c23" href="https://linear.app/overdrafter/issue/OVD-473/build-the-canonical-engineering-context-snapshot-and-cache-contract">OVD-473</issue> and later admitted migrations.

## Acceptance criteria

- [ ] Keep decision, execution, verification and authoritative adoption states distinct.
- [ ] Represent five accepted decisions ahead of the immutable baseline with explicit dependency blocking.
- [ ] Reject invalid transitions, stale results and revision conflicts; supersession invalidates dependent results without altering source history.
- [ ] Native execution success or accepted intent alone never implies verified, adopted or committed CAD.

## Implementation notes

Reuse the existing canonical_parts/part_versions and artifact lineage concepts without changing their schema or claiming package completeness means engineering approval. Use existing TypeScript/Vitest infrastructure; no new package dependencies. Preserve the current Part-to-Quote release contract.

## Testing

Targeted synthetic behavioral tests, affected-file lint, root typecheck/build, then the required repository verification gate. Native qualification remains unverified until performed on a separately qualified Windows/SolidWorks environment.

## Dependencies

<issue id="cdf325b5-4541-47ef-9016-9dc71196e375" href="https://linear.app/overdrafter/issue/OVD-476/define-the-general-engineering-ontology-and-cross-artifact-identity">OVD-476</issue> internal identity contracts.

## Source context

User-approved “OverDrafter: an engineering control plane above CAD” plan, September 7, 2026, especially sections 4, 6–9, 11 and 17. Parent: <issue id="a5a44841-0ded-4c2e-bbc4-84bbf9f137be" href="https://linear.app/overdrafter/issue/OVD-466/define-the-general-engineering-world-model-and-transaction-contracts">OVD-466</issue>. This explicitly admitted offline foundation does not promote the customer pilot, alter 1.0 release order, qualify native CAD, or authorize production/PDM/provider operations.

## Original intent preserved

Model allowed transitions, ownership, failure states, supersession, and reconciliation.

## Acceptance criteria

* Every state and transition has an explicit authority and invariant.
* Working changes can lead native CAD without being represented as committed.
* Failed and superseded transactions cannot silently change the authoritative baseline.

## OVD-520 Prove one connected 7 mm request from phone to native result (full)

## September 26 approved finish line

This issue is the current JARVIS finish milestone: one complete phone → SolidWorks → independently checked result. Exact STEP association (<issue id="05cb3bf9-231b-4fd4-ab57-7e5ff44f2585" href="https://linear.app/overdrafter/issue/OVD-563/bind-exact-step-review-bytes-to-a-finalized-native-result">OVD-563</issue>) is required; GLB/general portable identity (<issue id="dd892ded-6503-4f00-b002-bd36b1c61269" href="https://linear.app/overdrafter/issue/OVD-507/publish-paired-step-and-glb-review-artifacts-from-verified-candidates">OVD-507</issue>/506) is later work. <issue id="50f95499-34a0-4093-81cc-9cd4b757be89" href="https://linear.app/overdrafter/issue/OVD-562/connect-paired-companion-task-claim-and-heartbeat-to-the-native-runner">OVD-562</issue> supplies the previously missing companion claim/heartbeat-to-runner connection. Retain finalization, interpretation and artifact-transfer prerequisites. Require fresh exact-source Windows qualification and a reviewed activation packet; historical isolated native runs do not certify the integrated workflow. No production/native protected action is authorized by this issue text.

## Summary / problem

Retained STEP replay is not a connected new request-to-result demonstration.

## Outcome / scope

One signed-in cross-device request sets the existing synthetic baseline part to 7 mm, runs once on an admitted Windows source, independently verifies it and displays the exact corresponding geometry without manual JSON transport.

## Acceptance criteria

- [ ] One request identity links interpretation, predecessor, attempt, filesystem/process evidence, all seven checks, candidate and preview.
- [ ] Browser closure does not lose the request; phone/desktop show truthful execution versus verification states.
- [ ] Source remains unchanged; fixed companion remains unchanged; preview matches that run, not an unrelated retained export.
- [ ] Failure blocks successor advancement; no automatic CAD retry.
- [ ] Short recording and exact-source evidence distinguish simulation, replay and real native execution.

## Testing

One exact synthetic connected run after dependencies pass, plus targeted stale-result and tenant-denial regressions. Broader five-change/adverse-case certification stays under <issue id="3d3f541c-76ac-4eb7-a59f-0ef52498d280" href="https://linear.app/overdrafter/issue/OVD-484/certify-the-general-mobile-engineering-command-loop">OVD-484</issue>.

## Out of scope

No customer files, general CAD, engineering release, new paid infrastructure or automatic production activation.

## Dependencies / source

<issue id="0f1919ba-8903-4e73-9d06-c89a59ffa3d0" href="https://linear.app/overdrafter/issue/OVD-509/qualify-trusted-windows-filesystem-identity-for-native-result">OVD-509</issue>/510/511/507, bounded interpretation and artifact transport; explicit companion/hosted activation authorization if needed. docs/jarvis-bounded-restart.md and docs/engineering-automatic-loop.md.

## Execution contract

One owner, one slice, targeted checks first. Record exact source, changed files, passing/failing checks and next issue. No automatic follow-on work, no Fast, no reset. Check allowance before/after; background work requires the fresh exact budget. Three similar failures or two checkpoints without durable progress require a bounded replan. Done means this issue's evidence, not its parent's completion.

## Supplemental planning — October 8, 2026

**Classification:** Connected-result acceptance milestone.

Close the bounded companion, exact STEP association, interpretation, transport, admission and durable-finalization gates before one authorized synthetic 7 mm run. The controlling finish line uses <issue id="05cb3bf9-231b-4fd4-ab57-7e5ff44f2585" href="https://linear.app/overdrafter/issue/OVD-563/bind-exact-step-review-bytes-to-a-finalized-native-result">OVD-563</issue>, not later GLB/portable-review <issue id="dd892ded-6503-4f00-b002-bd36b1c61269" href="https://linear.app/overdrafter/issue/OVD-507/publish-paired-step-and-glb-review-artifacts-from-verified-candidates">OVD-507</issue>/506; distinguish a fresh connected result from retained replay and obtain fresh exact-source Windows qualification.

**Recorded predecessor links:** <issue id="05cb3bf9-231b-4fd4-ab57-7e5ff44f2585" href="https://linear.app/overdrafter/issue/OVD-563/bind-exact-step-review-bytes-to-a-finalized-native-result">OVD-563</issue>, <issue id="50f95499-34a0-4093-81cc-9cd4b757be89" href="https://linear.app/overdrafter/issue/OVD-562/connect-paired-companion-task-claim-and-heartbeat-to-the-native-runner">OVD-562</issue>, <issue id="ba2cfa75-58d6-4cf1-9210-5ec30841235d" href="https://linear.app/overdrafter/issue/OVD-519/deliver-immutable-prepared-job-inputs-and-outputs-through-the">OVD-519</issue>, <issue id="94c8f4bc-3d54-42c8-ae66-015ff7e94561" href="https://linear.app/overdrafter/issue/OVD-518/persist-bounded-interpretation-of-prepared-depth-requests">OVD-518</issue>, <issue id="e82e514c-2ea1-4fa8-b036-8f7c936db9e1" href="https://linear.app/overdrafter/issue/OVD-510/constrain-native-verifier-database-authority-before-restoring-delivery">OVD-510</issue>, <issue id="e9f82855-82b0-4821-9baf-3793f562eb04" href="https://linear.app/overdrafter/issue/OVD-511/restore-one-atomic-native-result-finalization-behind-qualified">OVD-511</issue>, <issue id="0f1919ba-8903-4e73-9d06-c89a59ffa3d0" href="https://linear.app/overdrafter/issue/OVD-509/qualify-trusted-windows-filesystem-identity-for-native-result">OVD-509</issue>. Treat these as completion/contract gates; verify their current evidence rather than assuming every linked issue still needs implementation.

**Evidence to refresh:** Latest PR head, checks, review and merge status for <pull-request id="53550793-1a07-4d1e-b4f3-2baa9b722623" href="https://linear.app/overdrafter/review/ovd-589-test-engineering-recovery-across-browser-restarts-2f1fe6dbd54a">optomachina/Overdrafter#561</pull-request>. This planning pass does not certify their current completion.

Existing priority and acceptance criteria are preserved. This plan does not authorize repository, deployment, production, credential or external-provider actions.

## OVD-765 Jarvis demo: phone-triggered multi-part assembly via CAD-neutral worker (Workstation offline) (full)

Rehearse "Blaine tells his Workstation to design a complex assembly from his iPhone" while the Windows SolidWorks Workstation is offline.

Scope (demo only, never on the quoting path):

* `scripts/jarvis-demo/jarvis-demo.mjs`: local file queue (`request`, `work`, `status`) behind `JARVIS_DEMO_ENABLED=1`. Claiming is an atomic rename, so a request runs at most once. A deterministic parser accepts only bracket + plate + pin with a 4 to 20 mm pin.
* `scripts/jarvis-demo/assembly.py`: build123d (OpenCascade) stand-in. It writes one STEP per part, an assembly STEP and a PNG render. Checks: one valid solid per part, no pairwise interference, a pin clearance fit, the pin passes through the upright, and the bracket is seated.
* Phone trigger: the Hermes gateway on the Mac mini (Telegram/Slack) with the local skill `jarvis-workstation-design`, which calls `~/overnight/jarvis/bin/jarvis-design`.

Acceptance:

* vitest `scripts/jarvis-demo/jarvis-demo.test.mjs` passes (parsing, refusal, single claim, flag off refuses).
* A local run produces STEP files and a PNG with all checks passing. Evidence is in `~/overnight/jarvis/demo.md`.

Not in scope: SolidWorks, the hosted engineering inbox, Supabase, provider accounts. A synthetic result does not satisfy <issue id="30e36799-8929-4f50-9908-8acc91ae280f" href="https://linear.app/overdrafter/issue/OVD-520/prove-one-connected-7-mm-request-from-phone-to-native-result">OVD-520</issue>'s native criteria.