# OverDrafter Roadmap

Last updated: August 17, 2026

## Purpose

This file is the repository bridge between active product contracts and the
Linear portfolio. It intentionally does not duplicate the future-feature
inventory.

- `PRD.md` defines stable product intent.
- `PLAN.md` defines the exact active execution queue.
- Numbered Linear release projects define release scope.
- The
  [OverDrafter Product Portfolio & Future Capability Index](https://linear.app/overdrafter/document/overdrafter-product-portfolio-and-future-capability-index-e5566af77774)
  is the single detailed home for deferred feature ideas.
- Incubator projects are routing categories, not implementation queues.

Git history preserves the superseded horizon, capability-map, TODO, and
speculative roadmap documents removed during the August 2026 consolidation.

## Product wedge

**One upload. One trustworthy quote decision.**

OverDrafter first serves hands-on buyers who need a price for a manufacturable
part: individual tinkerers, students, freelance engineers, and very small
companies. Later releases may serve engineers with purchasing authority and
procurement professionals whose time is expensive.

## Release ladder

### 1.0 — Controlled Founding Beta: Part to Quote

[Linear project](https://linear.app/overdrafter/project/overdrafter-10-controlled-beta-part-to-quote-1b4d94414424)

Prove that invited buyers independently complete the exact authenticated,
supported-part-to-safely-confirmed-multi-provider-quotes-to-vendor-handoff
journey. Release requires at least three production-certified quote sources;
five are preferred. This is not general availability, billing, purchasing, or
a promise of broader part coverage.

### 1.1 — Monetization and First Paid Pilot

[Linear project](https://linear.app/overdrafter/project/overdrafter-11-monetization-and-first-paid-pilot-b8595bf411d2)

Use Founding Beta evidence to choose one commercial model, validate subscription
access, and onboard the first paid organization.

### 1.2 — Quote Reliability and Coverage

[Linear project](https://linear.app/overdrafter/project/overdrafter-12-quote-reliability-and-coverage-d3964d2f26a6)

Improve measured quote reliability, extraction quality, supported-package
coverage, and provider coverage one bounded gap at a time.

### 2.0 — Team Procurement

[Linear project](https://linear.app/overdrafter/project/overdrafter-20-team-procurement-6bef19d4d389)

Add durable team decisions, repeat-sourcing intent, and audited procurement
handoffs without implying unconfirmed purchase orders, spend, or delivery
commitments.

## Incubator routing

Deferred capabilities live in the portfolio index and route to one project:

- [Supplier Network](https://linear.app/overdrafter/project/incubator-supplier-network-125e906d0457)
- [Manufacturing Intelligence](https://linear.app/overdrafter/project/incubator-manufacturing-intelligence-292d715bc3c5)
- [CAD & Design Lifecycle](https://linear.app/overdrafter/project/incubator-cad-and-design-lifecycle-ee2229ff978d)
- [Native & Cross-platform Apps](https://linear.app/overdrafter/project/incubator-native-and-cross-platform-apps-65f3c7856fc7)
- [Compliance, Quality & Managed Services](https://linear.app/overdrafter/project/incubator-compliance-quality-and-managed-services-1d364989fee2)

Do not add speculative milestones or narrative parent issues to incubators.

## Promotion gate

A deferred capability may enter a numbered release only when all are true:

1. A named target customer has a repeatedly observed problem.
2. Evidence is linked: an interview, failed quote, usage, support burden, or
   paid commitment.
3. The intended outcome and success measure fit in one sentence.
4. The smallest safe slice fits one bounded issue or an explicitly decomposed
   parent.
5. Dependencies, compliance implications, and opportunity cost are explicit.
6. It does not delay the active release gate.

Technical curiosity, competitor parity, a prototype, or existing partial code
is insufficient.

## Portfolio rules

- Only one numbered release is active at a time.
- Normally only one product issue is `In Progress`.
- Linear priority is meaningful only inside the active release.
- Add a new idea to the portfolio index with its evidence link; do not create an
  issue during the same brainstorm.
- Create issues only for promoted bounded slices or active-release defects.
- Incubators have no active priority, target date, or speculative milestones.
- At weekly review ask: **What is the smallest proof still missing from the
  active release?**

## Terminology

- **Validation part:** CAD model used to exercise a live beta/provider path.
- **Validation package:** validation part plus frozen requirements and exact
  provider scope.
- **Reference part:** synthetic or curated estimator/characterization benchmark.
- **Test fixture / fixture mode:** reserved for software tests, mocks,
  extraction corpora, and developer tooling.

Public availability of a validation part does not prove distribution rights or
provider-upload permission.
