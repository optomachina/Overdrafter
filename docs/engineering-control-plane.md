# Engineering control plane

Status: staged future capability; internal contract foundation only.
Source: Blaine's approved September 7, 2026 architecture and implementation plan.
Owning project: [North Star Prototype — General Engineering Command Loop](https://linear.app/overdrafter/project/north-star-prototype-general-engineering-command-loop-ce148ce2fdd8).

## Purpose and admission

An engineer can make decisions faster than CAD executes them, while knowing
which decisions are proposed, accepted, implemented, verified and incorporated
into the authoritative design. OverDrafter owns that relationship; SolidWorks
owns native model evaluation and PDM owns its official version/revision and
lifecycle records. Human engineering judgment and release authority remain
explicit.

The approved implementation begins with isolated, offline contracts and tests.
It does not change the Part-to-Quote release or promote the customer CAD pilot.
The pilot still requires the entry and customer-evidence gates in `ROADMAP.md`
and the existing Linear project. No native environment, customer assembly,
database migration, PDM release or supplier disclosure is qualified by this
document or by synthetic tests.

## Architecture decision

Use a versioned engineering decision graph above native adapters. Do not make
the engineer's active CAD session the shared execution state, binary-merge
native files, or build a universal replacement for native feature trees.

Start with the existing TypeScript application, Postgres, private immutable
artifact storage and task-claim patterns. Add an independently isolated C#
Windows executor only after its qualification gate. Keep dependency and state
rules in ordinary relational records with append-only transition history; no
new graph database or workflow platform is required for the MVP.

The planner proposes work. Deterministic software validates scope, units,
capabilities, dependencies, budgets, current authority and check requirements.
Workers produce quarantined artifacts and evidence. A separate coordinator
reconciles those results. Candidate approval/export and external publication
are different actions with different authority.

## Minimal ontology (OVD-476)

| Object | Contract |
| --- | --- |
| Request | Generic engineering question/outcome bound to selected project context. |
| Statement | Requirement, constraint, objective, assumption, observation or derived claim. Unknown, conflicting and stale information stays explicit. |
| Decision | Versioned choice with scope, rationale, dependencies and acceptance/supersession history. |
| Snapshot | Immutable manifest of exact source, requirements, included decisions, toolchain and artifacts. |
| Branch | Alternative based on a snapshot, with an explicit included-decision set. |
| Plan/task | Versioned dependency graph and bounded executable work. |
| Artifact | Native CAD, drawing, calculation, report, preview or other immutable evidence. |
| Verification | A check and measured result against an exact subject and requirements revision. |
| Approval | Permission for one defined action against an immutable subject. |
| Knowledge item | Reusable lesson with evidence, scope, applicability and promotion owner. |

Dependencies are typed edges. Capabilities are versioned executable contracts;
workers are runtime resources. Neither a separate ontology for each request
type nor an untyped chat transcript is the engineering model.

### Existing identities and PDM ownership

Reuse `canonical_parts` and `part_versions` as organization-scoped technical
identity and exact package references. Existing `parts`/`jobs` placements are
not new engineering revisions. A package in `complete` state is not an
engineering-approved package. Existing artifact review status does not grant
engineering release authority.

[OVD-323](https://linear.app/overdrafter/issue/OVD-323/design-canonical-pdm-metadata-model-and-synchronization-architecture)
owns PDM metadata and synchronization. Extend it through document references,
not a second PDM schema. Distinguish logical document identity, native version,
official revision, configuration, checkout/lifecycle observations and the
system that owns each field. Observation time is separate from version.
OverDrafter may propose values but does not overwrite externally owned fields.

Bind a candidate to organization/project, baseline snapshot and manifest,
included decision IDs and revisions, requirements digest, artifact-manifest
digest, toolchain digest and verification-policy digest. Hashes are lowercase
SHA-256, not arbitrary labels. Sort set-like decision references canonically;
do not sort ordered native operations. Equal geometry does not prove equal
parametric history. Different file bytes do not prove a geometric change.

The first implementation is an internal pure TypeScript contract. Validation
of supplied hashes is not a calculation or proof of the corresponding bytes.
Future trusted ingestion must compute hashes itself and enforce authorization
and immutability in storage. Pure helper results are not security credentials.

### Future persistence

Add tables only in separately admitted migration slices: requests, statements,
decisions, snapshots, branches, plans/tasks, task dependencies, artifact
lineage, attempts, verification results, approvals, knowledge and events.
Organization consistency must be enforced across every relationship. Reuse
current identity and storage contracts; do not create parallel part identity.
Release operations and per-system receipts arrive with external publication.

## Intent, realization and adoption (OVD-472)

Keep four state dimensions independent:

| Dimension | States |
| --- | --- |
| Decision | Proposed, accepted for evaluation, superseded, rejected. |
| Execution | Blocked, queued, running, succeeded, failed, canceled. |
| Verification | Unverified, checking, passed, failed, stale. |
| Adoption/publication | Unadopted, approved for action, publishing, partially published, reconciled, recovery required. |

Accepted intent is a desired change, not proof of feasibility. A succeeded
native operation is not proof of verification. A passed check set is not
evidence of PDM adoption. Baseline updates require observed authoritative
identity; a model success flag must never advance it.

For baseline S142 and accepted decisions D143–D147, track a graph, not a
numerical revision frontier. D143 and D144 may evaluate independent copies;
D146 can wait for verified geometry from D144 while D147 performs conceptual
analysis. A candidate containing D143/D144/D146 must explicitly exclude D145;
its highest decision number is not a PDM revision.

Dependencies distinguish information, ordered change, verification, authority
and external facts. Reject cycles and missing predecessors. Conservatively
treat the assembly dependency closure as coupled when independence is unknown.

Superseding a decision preserves history and invalidates dependent candidates,
checks and approvals. Late attempts may retain historical evidence but cannot
become current. A changed source or requirement creates a new binding; it does
not mutate the old snapshot. Preserve independent results when another task
fails, but do not omit failed requirements from an integrated candidate.

## Prepared transaction and execution (OVD-470)

An operation envelope identifies its exact scope/baseline/decisions,
requirements, supported capability/version, ordered operations, prepared
targets, expected outputs, required checks and bounded resource policy.
Preflight success means contract eligibility only. It does not authorize a
worker or prove that any native operation succeeded.

Initial operations are declared dimension changes, approved component
addition, optional-occurrence suppression, approved component substitution,
and DFM/DFA inspection. Include configuration, occurrence scope, target
bindings and interface/mate maps. A dimension in a shared part can affect every
placement; do not infer occurrence-local editing. Unmapped or ambiguous targets
stop the operation. Hard deletion, arbitrary remating and unrestricted feature
editing are not initial capabilities.

One worker serializes native mutations. Parallelism uses private candidate
copies, never a common writable model. Integrate alternatives by replaying
chosen changes against one baseline and verifying the combined assembly.
Even distinct parameters can be geometrically coupled.

Use attempt-specific roots and output keys, expiring leases, heartbeats and
fencing tokens. A stale attempt must have no writable path to authoritative
files. Finalize the current attempt only after immutable artifacts exist.
Database fencing alone cannot stop a process writing external files.
After interruption, quarantine partial output and restart from a verified
input. Allow at most one classified transient retry; no blind retry of an
unknown external effect.

## Verification and approval

Each result names the exact artifact, configuration, requirement revision,
check version, measured quantities, tolerances, outcome and evidence.
Verification coverage includes:

1. Correct inputs, scope, worker identity and API outcome.
2. Rebuild, features, references, mates, body validity and fresh save/reopen.
3. Declared dimensions, units, datums, mass, envelope, interfaces and BOM.
4. Applicable tolerance, DFM/DFA, standards and solver checks.
5. Qualitative/visual engineering review.
6. Current signer authority and exact release eligibility.

Every mandatory check must be present and pass. Missing checks are unknown,
not pass. Independent AI critique can find omissions but is not a physical
measurement or independent solver. A permitted deviation retains the failed
check and records who accepted which exact requirement deviation.

Approval binds action, baseline, included decisions, candidate manifest,
requirements, verification evidence and relevant policy/tool versions.
Recheck authority and freshness at action time. Output regeneration,
supersession, source drift or requirements changes invalidate prior approval.

## Native qualification and release boundary

OVD-480 must qualify a legitimate SolidWorks edition/service pack, Windows
runtime, process/session binding, filesystem/network isolation, dangerous
content suppression, scanning, quarantine, timeouts, recovery and teardown.
The initial local implementation environment is macOS; no native qualification
has been performed. C# source or simulated outputs would not establish it.

Pack and Go is a packaging tool, not proof of complete dependency isolation.
Reopen and verify every reference resolves within the job root, including
suppressed/lightweight components and duplicate filenames. Persistent native
references can become deleted, suppressed or ambiguous; semantic remapping
requires its own qualified evidence.

MVP candidates are detached copies. If the engineer changes the original,
compare a newly supplied source manifest before adoption; otherwise adoption
remains unverified. Exported files are candidate packages, not manufacturing
release certifications. Affected drawings remain stale unless regenerated
and checked through a qualified path.

Later PDM publication requires an exclusive coordinator, exact approved
manifest, authoritative preflight, permitted checkout, per-file/system receipts
and post-action readback. Partial success produces recovery-required state.
There is no assumed atomic transaction across CAD/PDM/BOM/ERP. Private rollback
discards/restores a candidate; post-publication correction is a new authorized
operation rather than erasing history.

## Pilot scope and acceptance

After promotion, support one prepared top-level assembly with about 2–20
unique parts, one qualified configuration, explicit materials, named editable
dimensions, approved components and declared interfaces. The engineer queues
changes/reviews, accepts evaluation, continues working, compares evidence,
chooses compatible alternatives, reviews integrated output and approves
export. Native adoption remains manual.

Initial limits: one worker, three alternatives per batch, one transient retry,
two planner revisions, ten-minute native task deadline, and an explicitly set
batch spending ceiling. No cost-bearing execution without its budget.

Pilot gates: p95 request acknowledgment below two seconds excluding upload;
five decisions recorded during running native work; at least 90% completion
of 30 supported cases across five prepared assemblies; all seeded hard
violations block approval; at least 30% less hands-on effort including
preparation amortized over three uses; three engineers repeat real workflows.
Measure licensed minutes, cost per useful alternative, recovery and review
effort. These are targets, not demonstrated results.

At least 20 adverse cases cover units/ranges, missing and ambiguous references,
conflicts, changed originals, crashes, hangs, leases, duplicate/late completion,
wrong instance, materials, invalid geometry, stale/revoked approval, tenant
separation, unexpected movement and stale drawings. Synthetic contract cases
are separate from the required native CAD corpus and customer evidence.

## Knowledge and staged expansion

Capture raw history with provenance. Searchable summaries remain source-linked.
Reviewed lessons require an owner and applicability. Organizational standards
need explicit adoption. Trainable examples require usage rights and curation.
Executable rules require tests and review. Rejected designs and corrections
retain their reasons and outcomes; private customer data is not automatically
cross-customer training data.

Stage 0 preserves current automation. Stage 1 adds controlled dispatch; stage 2
proves asynchronous engineering tasks and the MVP. Stage 3 adds parallel
candidate workers only when economics justify them. Stage 4 expands reasoning
against held-out requests. Stage 5 adds governed cross-system release. Do not
advance when preparation/review exceeds saved effort or verification cannot
support claimed outcomes.

The moat is dependable cross-system execution, validated organizational
knowledge and real correction/outcome evidence. Prompt wrappers, commodity
catalog data and a generic CAD agent are insufficient. Build identity,
evidence, isolation and correction history early; defer universal CAD kernels,
unrestricted autonomy, large compute fleets and replacing mature engineering
systems.

## Implementation ledger

- OVD-476: internal ontology/identity contracts and representative synthetic
  requests; no persisted service or CAD execution.
- OVD-472: separate intent/execution/verification/adoption state semantics.
- OVD-470: prepared transaction, conflict and replay preflight semantics.
- OVD-480/473/471: qualified runtime, real context capture and capability runtime
  remain subsequent gates.
- OVD-478/477/479/483: native operations, verification, recovery and review/export
  are bounded later slices; pure contracts do not complete these issues.
- OVD-469/475/474: planner, uncertainty/evidence and cross-request evaluation
  grow alongside working capabilities.
- OVD-467: desktop prepared-assembly pilot precedes the general mobile demo.
- OVD-484: final cross-request native/customer certification remains unproven.

New persistence, public APIs, UI and native execution are separately reviewed
changes. Full architecture complexity is High; this ledger is not permission
to implement it as one undifferentiated patch.
