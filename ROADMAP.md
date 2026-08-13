# OverDrafter Roadmap

Last updated: August 12, 2026

## Purpose

This file preserves OverDrafter's product ambitions without allowing them to
compete with the current release. `PRD.md` defines stable product intent,
`PLAN.md` defines the exact execution queue, and this roadmap defines when a
capability may enter that queue.

The release ladder is outcome-based. Dates may be added when evidence supports
them; dates are not substitutes for release proof.

## Product wedge

**One upload. One trustworthy quote decision.**

OverDrafter first serves hands-on buyers who need a price for a manufacturable
part: individual tinkerers, students, freelance engineers, and very small
companies. The later team-procurement release serves engineers with purchasing
authority and procurement professionals whose time is expensive.

The controlled 1.0 beta journey is intentionally narrower than the long-term manufacturing
co-pilot vision:

`sign in -> upload a supported part -> confirm requirements -> request quotes -> understand the result -> compare/select -> continue with the vendor`

## Release ladder

### 1.0 — Part to Quote (controlled design-partner beta)

**Outcome:** An invited small buyer can make a trustworthy sourcing decision
from one supported part without OverDrafter staff repairing data or operating
the UI for them. The release remains invitation-only and is not general
availability.

Committed scope:

- responsive web application
- authentication before upload
- the exact non-ITAR CNC-milled aluminum 6061-T6 STEP/STP package envelope in
  `docs/1-0-beta-runbook.md`; an attached PDF may add only compatible
  requirements and is not a substitute for supported CAD
- extracted requirements that the buyer can review and correct
- one production-certified automatic quote lane, initially Xometry
- accurate, plain-language terminal states: live offer, provider guidance, or
  unsupported package; recommendations are never labeled as quotes
- comparison and selection when more than one trustworthy offer exists
- safe handoff through an official vendor link; vendor sign-in may still be
  required
- production monitoring, bounded recovery, and a documented rollback control
- approved external-file disclosure, data-handling, retention/deletion, and
  support paths before proprietary design-partner uploads
- a bounded Founding Beta using the cohort, run/spend caps, safeguards, and
  evidence protocol in `docs/founding-beta-program.md`

Release evidence is defined in `ACCEPTANCE_CRITERIA.md`. In particular, 1.0 is
not complete because the app builds, because one internal fixture once quoted,
or because no bugs are known. It is complete when the scoped journey is
repeatable in production and external design partners complete it unaided.

Explicitly not in 1.0:

- anonymous upload or transferring an anonymous quote into a new account
- Stripe subscription activation, a paid plan, or a first paid customer
- in-app manufacturing checkout, payment, purchase-order creation, or ordering
- another automatic vendor integration beyond the certified launch lane
- native mobile or CAD plug-in release work
- supplier-directory sourcing, supplier outreach, or email/voice agents
- DFM/DFA services, geometry intelligence, internal price estimates, or cost
  heatmaps
- CAD/drawing editing, text-to-CAD, CAD-to-drawing, or drawing-to-CAD
- inspection, shipment, warehousing, or fulfillment services
- another redesign of the primary journey unless external validation shows a
  comprehension failure

### 1.1 — Monetization and First Paid Pilot

**Entry gate:** The controlled 1.0 beta evidence is complete.

**Outcome:** OverDrafter converts a validated quote workflow into a deliberately
priced, supportable commercial pilot.

Candidate scope:

- decide the commercial packaging from 1.0 usage and interviews
- enable and validate the monthly Stripe subscription path
- define Free and paid access without weakening the 1.0 sourcing outcome
- onboard the first external paid organization
- instrument signup-to-quote and quote-to-purchase-handoff conversion
- decide whether an anonymous-to-account claim flow is worth its security and
  persistence complexity

The first paid customer is evidence for 1.1, not the definition of 1.0.

### 1.2 — Quote Reliability and Coverage

**Entry gate:** A paid pilot uses 1.1 and the current lane's reliability is
measured.

**Outcome:** More supported requests receive trustworthy offers with less
operational intervention.

Candidate scope, admitted one evidence-backed slice at a time:

- certify Fictiv as the second automatic quote lane
- improve session-health operations, retry policy, and portal-change detection
- benchmark deterministic-first drawing extraction against labeled drawings;
  keep model fallback bounded, measurable, and traceable instead of replacing
  deterministic evidence with open-ended agent review
- add materials, processes, quantities, or package types only where customer
  failures justify them
- harden manual RFQ intake and status follow-up when automation cannot succeed
- consider Protolabs, SendCutSend, OSH Cut, or another provider based on observed
  demand rather than adapter count

### 2.0 — Team Procurement

**Entry gate:** Small-buyer usage shows repeat demand and at least one larger
buyer validates the workflow and controls.

**Outcome:** Engineers and purchasing teams can move a quote decision through a
durable, auditable internal handoff.

Candidate scope:

- durable procurement handoffs, approvals, comments, and notifications
- team roles and organization administration
- audit history, quote validity, revision identity, and repeat sourcing
- recurring-demand and blanket-PO intent, including requested quantity,
  cadence, term, approvals, and supplier constraints; recording intent does not
  authorize OverDrafter to issue a PO or commit spend
- project and assembly context where it reduces real coordination cost
- external order references and status visibility without pretending
  OverDrafter placed or paid for the order
- browser and mobile access justified by buyer workflow evidence

## Incubators — captured, not committed

Incubators preserve good ideas. They have no release promise, active
implementation card, or priority until they pass the promotion rule below.
Existing research, issues, prototypes, and documentation remain valid input.

### Supplier network

- brick-and-mortar shop and facility directory
- capability, material, process, geography, certification, quality, provenance,
  evidence freshness, and qualification data
- verified provider role: direct fabricator, marketplace/aggregator,
  broker/agent, or unknown; customer filters must not infer this from a brand
  name alone
- Tucson-first discovery and historical supplier-data import
- assisted RFQ preparation and intake
- quote adapters for APIs, portals, email, and assisted workflows, including a
  brick-and-mortar/direct-fabricator adapter without conflating integration
  transport with provider role
- email or voice follow-up for quote status and vendor qualification
- organic ranking and, only after eligibility is independently testable,
  clearly labeled sponsored placement

### Manufacturing intelligence

- deterministic geometry and feature characterization
- tolerance, material, process, and finish normalization
- common-language plating requirements normalized to controlled, reviewable
  specifications while preserving the customer's source text
- a labeled reference-part ladder for estimator evaluation: plain plate,
  drilled plate, irregular plate with holes, and packages whose tolerances or
  features require nonstandard routes such as surface grinding or EDM
- a smart pricing estimator that learns only from versioned requirements,
  reviewed corrections, firm quote outcomes, and measured prediction error—not
  untrusted free-form feedback presented as price truth
- feature-level price ranges and cost-driver heatmaps
- DFM/DFA reviews and engineering-standards assistance
- quote benchmarking, supplier outcome comparisons, and recommendation models

### Design lifecycle

- CAD-to-drawing generation and editing
- automatic revision-linked 3D PDF generation with verifiable source geometry,
  rendering settings, and derivative provenance
- drawing-to-CAD reconstruction
- text-to-CAD and controlled model edits
- feature- and geometry-level selection, characterization, and editing
- revision graphs, PDM, branching/merging, and associative package history
- a shared plug-in contract followed by evidence-backed integrations for major
  platforms such as SolidWorks, Fusion, Inventor, Onshape, Creo, Solid Edge,
  NX, CATIA/3DEXPERIENCE, and other customer-validated CAD systems
- a conversational workspace that can display any authorized structured
  artifact or result and can invoke capability-scoped actions only with
  explicit confirmation, idempotency, authorization, and audit evidence
- structured cross-domain requests such as ranked supplier discovery, a needed
  quantity/date, or recurring blanket-PO intent; the assistant must surface
  missing constraints and approvals and must never turn intent into an
  unconfirmed quote, delivery promise, purchase order, or supplier commitment

### Fulfillment and services

- authorized purchasing and manufacturing payments
- inspection and quality records
- production, shipment, and delivery tracking
- warehousing and fulfillment
- CAD modeling, redrafting, FEA, assembly support, and other service lines

### Compliance and quality

- part/package classifications for ITAR, EAR jurisdiction/classification such
  as an owner-asserted EAR99 designation, CUI, and other regulated constraints;
  the product must not supply legal classification advice
- fail-closed storage, access, transmission, geography, provider eligibility,
  audit, incident, retention, and deletion controls for any promoted regulated
  workflow
- sticky regulated classification: organization administrators may designate a
  part, while removal requires elevated authority, a recorded reason, and an
  immutable review trail rather than a casual toggle
- ISO and other quality-system requirements with exact standard, scope,
  facility, issuer, validity, and source-evidence fields
- material certificates, plating/finish certificates, certificates of
  conformance, inspection records, and their required/received/verified states
- supplier and quote filtering that proves the facility and transaction meet
  the requested compliance/quality evidence; marketing claims are insufficient

Regulated transactions require a separately reviewed product, legal, security,
privacy, data-residency, and operating contract. They remain prohibited in the
1.0 Founding Beta.

### Cross-platform experiences

- iPhone/iPad production release
- native macOS and Windows applications
- Android application
- actionable mobile inbox and contextual assistant

## Promotion rule

An incubator item may enter a numbered release only when all of the following
are true:

1. A named target customer has a repeatedly observed problem.
2. The evidence is recorded: interview, failed quote, usage data, or paid
   commitment.
3. The expected customer outcome and success measure fit in one sentence.
4. The smallest slice fits one bounded Linear issue or a clearly decomposed
   parent.
5. Its dependency and opportunity cost are explicit.
6. It does not delay the active release gate.

Technical curiosity, competitor parity, a promising prototype, or already
having built part of a feature is not sufficient promotion evidence.

## Portfolio rules

- Only one numbered release is active at a time.
- Only one product issue should normally be `In Progress`; production incidents
  and independent review may interrupt it.
- Linear priority is meaningful only inside the active release. Deferred work
  has no urgency merely because it is strategically interesting.
- New ideas go into the appropriate incubator with their evidence link. They do
  not enter the active queue during the same conversation in which they arise.
- Linear free-plan capacity is protected by keeping raw ideas in this roadmap
  and the relevant incubator project description. Create an issue only for an
  admitted, bounded slice; do not create one ticket per brainstorm bullet.
- At every weekly review, ask: **What is the smallest proof still missing from
  the active release?** The answer determines the next issue.

## Idea-source index

These files retain deeper context but do not set current execution order:

- `capabilitymap.md`
- `horizon1.md` through `horizon6.md`
- `TODOS.md`
- `docs/bidirectional-cad-drawing-roadmap.md`
- `docs/fulfillment-state-model.md`
- `docs/manufacturing-review-status-model.md`
- `docs/service-request-taxonomy.md`
- `docs/quote-intelligence-release.md`
- `docs/founding-beta-program.md`

Linear projects for CAD-native work, supplier discovery, manufacturing
intelligence, mobile readiness, and the deferred roadmap are portfolio parking
lots until promoted through this document.
