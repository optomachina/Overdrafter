# OverDrafter 1.0 Acceptance Criteria

Last updated: October 23, 2026

## Purpose

This checklist defines the evidence required to release **OverDrafter 1.0 —
Part to Quote** as a controlled design-partner beta, not general availability.
It is intentionally limited to the product contract in
`PRD.md` and the active queue in `PLAN.md`.

**These are launch-readiness criteria, not demo-readiness criteria.** A demo
on staging, a local stack or seeded offers does not check any box below. See
[Demo readiness vs launch readiness](docs/1-0-beta-runbook.md#demo-readiness-vs-launch-readiness).
The current launch-readiness verdict is **NO-GO for a customer beta**: the
Codex readiness review's no-go stands because there are zero priced production
runs.

A passing build is necessary but insufficient. “Bug-free” is not measurable,
and collecting revenue is a 1.2 milestone. Every checkbox below must have an
artifact, production observation, test, or explicit human decision behind it.

## Supported-package promise

The exact CNC package below is the first same-package comparison milestone.
The 1.0 launch set (Blaine, October 20, 2026) is Xometry, Fictiv and
Quickparts for the CNC validation package and RMFG for the sheet-metal
validation package, each only for its own envelope. Weerg, Geomiq and OSH Cut
are 1.1. RMFG qualifies only through its process-specific envelope; this
checklist does not make it a CNC source or extend the CNC validation geometry
to fabrication processes. Provider scope, session rules, the run budget, the
go/no-go gates, and every open `TODO(Blaine)` decision are in the
[1.0 launch contract](docs/1-0-beta-runbook.md#10-launch-contract).

- [ ] Customer-facing copy names the exact package envelope in
      `docs/1-0-beta-runbook.md`: one STEP/STP file submitted as one part,
      declared units,
      CNC milling, aluminum 6061-T6, quantity one, as-machined finish, standard
      `+/- 0.005 in` or looser tolerance, no special requirements, and the
      stated non-ITAR limit.
- [ ] Customer-facing copy says that only the explicitly owner-approved validation
      geometry is certified for repeatable automatic pricing; customer geometry may end in
      manual review, provider guidance, or unsupported without implying a size
      or feature guarantee.
- [ ] The sheet-metal validation package and its exact envelope are approved
      (`TODO(Blaine)` B2 in the runbook), and customer copy names the envelope
      before any RMFG route is enabled.
- [ ] A PDF may supply drawing requirements, but missing or conflicting PDF
      evidence cannot be silently invented and an unsupported PDF-only package
      is explained honestly.
- [ ] Quantity and the minimum vendor-required manufacturing facts are reviewed
      or confirmed before quote dispatch.
- [ ] Packages outside the boundary reach a bounded unsupported or provider-
      guidance state with a useful next action.

## Core customer journey

- [ ] A new customer can create an account, sign in, and enter the responsive
      web workspace without internal-only navigation.
- [ ] The customer can upload one eligible STEP/STP part and optional drawing,
      then find that part again after a refresh or new session.
- [ ] Extracted requirements are shown as evidence, unknowns, or conflicts; the
      customer can correct the quote-facing requirements before dispatch.
- [ ] One customer action creates durable quote intent without uncontrolled
      duplicate active requests or vendor runs.
- [ ] The hosted worker processes only admitted, exactly confirmed provider
      lanes under bounded spend guards and without manufacturing-order authority.
- [ ] A successful lane produces the complete persisted set of currently
      purchasable provider options. Every option preserves real total and unit
      price, lead and/or arrival time, manufacturing tier, stable provider
      identifiers, source reference, collection time, disclosed package
      identity, quantity, geographic sourcing provenance, and
      commercial-validity facts when supplied.
- [ ] Geographic provenance is persisted in a constrained
      `vendor_quote_offers.geographic_origin` field (`domestic`, `foreign`, or
      `unknown`) separate from descriptive `sourcing` text. Existing and
      ambiguous rows remain `unknown`; no free-text or provider-name inference
      can promote them.
- [ ] The customer sees whether the outcome is a live offer, provider guidance,
      or unsupported package; recommendations and estimates are never labeled
      as returned quotes.
- [ ] When more than one trustworthy offer exists, the customer can compare and
      select one without unrelated offers being presented as a trend or Pareto
      curve.
- [ ] Multiple variants from one provider are grouped under that provider and
      remain independently selectable in the table and scatter comparison.
- [ ] The customer can switch between US-only and all-sourcing views. US-only
      includes only explicitly domestic options; all-sourcing includes domestic,
      foreign/global, and unknown options; missing or ambiguous origin is shown
      as unknown and is never mislabeled.
- [ ] A selected offer exposes only a validated official vendor destination and
      clearly states that vendor sign-in may be required.
- [ ] The 1.0 journey never claims that OverDrafter placed an order, collected
      manufacturing payment, or created a purchase order.

## Truth, authorization, and failure safety

- [ ] Cross-organization users cannot read or mutate another organization's
      uploads, requirements, quote requests, offers, or selections.
- [ ] Sign-out, account switching, organization switching, and role changes do
      not render cached data from the prior access scope.
- [ ] Server-side checks enforce package readiness, authorization, launch-lane
      enablement, rate controls, and spend controls independently of the UI.
- [ ] A server-enforced beta-organization boundary prevents every organization
      outside the enrolled allowlist from queuing automatic vendor work, even
      while the global rollout switch is on and that organization has an
      unrelated manual grant or Stripe subscription.
- [ ] During `OVD-206`, the worker and effective organization vendor set are
      exactly `xometry`; `OVD-319` may enable the beta only with the explicitly
      named set of Xometry, Fictiv and Quickparts for the CNC package and RMFG
      for the sheet-metal package, each only for its applicable process
      envelope. Every enabled automatic provider is
      individually admitted, and missing policy/configuration fails closed
      instead of inheriting legacy multi-vendor defaults.
- [ ] Simulated, synthetic, stale, mismatched-scope, or untrusted-adapter prices
      cannot pass as live offers.
- [ ] Vendor authentication expiry, portal change, timeout, disabled rollout,
      and queue failure each reach a finite, customer-safe terminal state.
- [ ] Retry and cancel behavior cannot create uncontrolled duplicate vendor work
      or any supplier order.
- [ ] Customer-visible errors contain no credentials, storage-state material,
      internal stack traces, or unnecessary personal data.
- [ ] Before each dispatch, the customer sees the named provider, the exact outbound filenames,
      and normalized requirements; affirms authority to disclose them and their
      non-ITAR/export-control status; and accepts the applicable notice revision.
- [ ] The server preserves the actor, organization, time, notice revision,
      provider, file identities, normalized requirements, and immutable
      disclosure-scope fingerprint; a scope change requires new confirmation.
- [ ] Final Terms, Privacy Policy, external-provider disclosure, retention,
      deletion, diagnostic-access, and incident/support paths are published and
      linked from the product; placeholder policy copy is absent.
- [ ] The currently public signup/upload path either requires the approved
      notice before file upload or is restricted to enrolled organizations;
      public signup is not represented as controlled-beta enrollment by itself.

## Live provider automation evaluation

- [x] The standalone evaluation harness can invoke Xometry, Fictiv, and the
      existing live evaluation adapters with operator-selected CAD and, where
      the adapter has a verified drawing flow, an optional drawing, without
      production routing or customer state. An unsupported drawing fails before
      provider interaction rather than being silently omitted.
- [x] The dedicated evaluation adapter entry point applies an explicit
      `live_evaluation` execution context and permits Xometry browser launch and
      upload without provider admission, customer disclosure,
      entitlement/rollout, production dispatch authorization/preflight,
      anti-bot certification, or order-prevention affirmations.
- [x] Evaluation upload requires an explicit operator confirmation that is bound
      to private staged copies and SHA-256 digests of the exact selected CAD and
      optional drawing bytes; changed bytes fail before browser launch, later
      path mutation cannot change the captured upload payload, and the
      authorization override does not waive export-control classification.
- [x] The normal production adapter entry point preserves its authorization
      guard even when a caller supplies an evaluation context, including zero
      Xometry browser launches without exact authorization.
- [x] Evaluation output remains local JSON/browser evidence and is not
      persisted or represented as a customer live offer or certified provider.

## Production certification

- [ ] The human owner explicitly approves authority to disclose the exact
      validation-part STEP hash to Xometry, confirms its non-ITAR/export-control status,
      and approves the complete `quote-lane-scope.v1` record before dispatch.
- [ ] The human owner separately confirms public-distribution rights for the
      currently served validation-part STEP bytes, or the public artifact is removed or
      replaced and any required incident/notification response is recorded.
- [ ] Customer surfaces do not advertise the unapproved `$49/month` or a
      self-service Pro upgrade during the Founding Beta; billing remains off and
      beta access is described truthfully.
- [ ] `OVD-206` records five consecutive hosted-worker runs of the controlled
      validation package defined in `docs/1-0-beta-runbook.md` over at least two
      separate sessions, each returning a real Xometry offer without database
      repair or staff UI operation.
- [ ] Before the `OVD-206` series begins, the merged `OVD-408` migration and
      worker revision are deployed and the hosted path proves that each run
      preserves every purchasable Xometry variant, not only the first price and
      lead pair visible to the adapter.
- [x] After the final credential rotation and any approved hosted network
      change, the exact
      recovery runtime, authentication Job, and live worker share the verified
      session/network contract, and two independent one-task, zero-retry
      no-upload probes from fresh instances confirm the authenticated Xometry
      dashboard without interaction, file selection, mutation, or profile
      persistence.
- [x] The OVD-420 recovery runtime applies one versioned, policy-digest-bound
      launcher to classifier-only and full credential recovery. Provider-free
      Linux proof permits only synthetic approved SNI through controlled DNS and
      denies wrong or missing SNI, unknown names, raw/private/metadata
      destinations, alternate DNS, UDP, and IPv6 bypasses. That synthetic proof
      did not independently satisfy OVD-410; the separate live recovery and
      fresh-instance evidence above now does.
- [ ] The same evidence records quote price, lead time, vendor/source reference,
      timing, lifecycle transitions, and approximate run cost without exposing
      secrets.
- [ ] A forced vendor/session failure proves the bounded fallback and recovery
      path; no request remains indefinitely queued or requesting.
- [ ] Production health surfaces queue progress, worker health, session age, and
      actionable failure context to the operator.
- [ ] The automatic-quote rollout can be disabled without disabling upload,
      requirement review, existing result access, or safe provider guidance.
- [ ] A rollout preflight proves the named enrolled organization is the only
      organization eligible for the certification window and that no quote-run
      lane other than Xometry can be created.
- [x] The documented rollback and session re-authentication procedure has been
      executed successfully by the named operator: revoke worker snapshot
      access and delete every old generation before provider interaction; use
      the exact immutable worker image on the bounded private IAP-only recovery
      host through the same fixed NAT path and reviewed OVD-420 exact-hostname
      policy; then verify export, tear down the host/archive, seed generation
      zero, restore narrow access, and complete two independent fresh-instance
      no-upload authentication proofs.
- [ ] Xometry, Fictiv and Quickparts are independently admitted and
      production-certified for the same CNC validation envelope, and RMFG for
      the sheet-metal validation envelope, before participant activation. The
      beta-enablement preflight fails unless all four qualify; a shortfall is
      Blaine's decision (`TODO(Blaine)` B1), never a silent substitution.
- [ ] The beta-enablement evidence names the effective provider set and its
      per-package split; manual RFQ
      sources, standalone evaluation adapters, enum/catalog entries, simulated
      offers, and disabled, expired, or incompatible
      policies do not count toward live automatic sources. Account existence,
      source integration, live quote verification, and production certification
      are recorded as distinct states; no provider is called live without
      current real-offer evidence.
- [ ] Each provider certification records the exact
      process/material/file envelope, session owner, action-time confirmation,
      immediate pre-adapter recheck, normalized offer/failure provenance,
      rollback, monitoring, and no-order proof.
- [ ] A permit, file, derivative, scope, session, organization, or envelope for
      one provider cannot authorize another provider in database or worker tests.

## External design-partner proof

- [ ] The Founding Beta follows `docs/founding-beta-program.md`; personal
      contacts receive the same qualification, terms, disclosures, access
      controls, and evidence protocol as every participant.
- [ ] At least three target users—tinkerer, student/freelance engineer, or very
      small-company buyer—each test with an eligible part they supplied; five
      participants is the operating target when capacity and segment diversity
      support it.
- [ ] Across those users, at least five production attempts reach a truthful
      terminal state without OverDrafter staff repairing records or operating
      the customer's interface.
- [ ] At least three of the external attempts receive a real live offer and the
      customer can explain the price, lead time, and next step correctly.
- [ ] At least one unaided eligible CNC participant attempt returns one current,
      independently traceable live offer from each of Xometry, Fictiv and
      Quickparts for the same disclosed package and scope, with canonical offer
      records and a buyer-understood comparison. At least one sheet-metal
      attempt (on a participant's part or the sheet-metal validation part, per
      `TODO(Blaine)` B2) returns a current, independently traceable live RMFG
      offer inside its envelope; an unsupported or manual-review outcome is
      never represented as a CNC or automatic live offer.
- [ ] Every observed stop, misunderstanding, and unsupported package is logged;
      launch-blocking failures are fixed and retested, while expansion requests
      are routed to the Linear Product Portfolio & Future Capability Index.
- [ ] At least two participants say the resulting quote decision would replace
      or materially shorten a sourcing step they perform today.
- [ ] Every attempt has sanitized customer-time, elapsed-time, staff-
      intervention, direct-cost, result-type, and comprehension evidence; no
      filenames, file contents, raw quote payloads, credentials, or unnecessary
      personal data enter analytics or Linear.
- [ ] The default program stops after four weeks from first activation or twenty
      automatic-provider runs. Any higher-cap routing is a separately approved
      experiment whose revised spend/run boundary is recorded in `PLAN.md` and
      this checklist before participant activation. With send-to-all-applicable
      routing a CNC package uses three runs and a sheet-metal package one, so
      the five-attempt minimum fits (at most 15 runs) but ten CNC packages (30
      runs) do not. The cap or package-count choice is `TODO(Blaine)` B7 in the
      runbook's run budget. The completion report records
      value, reliability, support burden, unit economics, incidents, expansion
      themes, and an explicit proceed/change/manage/narrow/stop recommendation.
- [ ] Paid-pilot reactions may inform the report, but a real offer, acceptance,
      charge, or paid customer remains a 1.2 decision rather than a 1.0 gate.

## Verification and release readiness

- [ ] Targeted upload, authorization, extraction/review, quote lifecycle,
      trusted-offer, comparison/selection, and vendor-link tests pass.
- [ ] The full repository and worker verification gates pass against the release
      candidate.
- [ ] The authenticated production smoke covers signup/sign-in through vendor
      handoff on the deployed release candidate.
- [ ] The viewport, browser, keyboard, focus, label/status, and automated
      accessibility checks in `docs/1-0-beta-runbook.md` pass or have an
      explicitly narrowed customer-facing support claim.
- [ ] There are no known P0/P1 defects in the scoped journey; lower-severity
      known defects have an owner, workaround or risk statement, and Linear ID.
- [ ] Every go/no-go gate in the runbook's
      [1.0 launch contract](docs/1-0-beta-runbook.md#launch-gates) passes on
      the frozen release candidate. In particular:
  - [ ] `OVD-1018` is applied in production after its staging drill, and
        `OVD-746`, `OVD-949`, and `OVD-734` are fixed and deployed or accepted
        in writing by Blaine (`TODO(Blaine)` B9).
  - [ ] `OVD-1067`: a new part uploaded with the approved drawing reaches
        approved requirements or a review hold on production, never an
        extraction task failure.
  - [ ] Wake on submit: a customer submission starts the scale-to-zero
        production worker without an operator wake request.
  - [ ] `OVD-1068`: a missing or unconfirmed shipping address is confirmed
        inside the quote confirmation dialog.
  - [ ] `OVD-1011`: the real-stack steps 1 to 7 browser journey passes, then
        passes again with real offers.
  - [ ] `OVD-686`: every High audit finding is fixed and verified or accepted
        by Blaine before the `OVD-319` walk.
- [ ] Monitoring owner, customer-support route, spend ceiling, rollout control,
      rollback trigger, and vendor-session owner are recorded.
- [ ] `README.md`, `PRD.md`, `PLAN.md`, `ROADMAP.md`,
      `docs/1-0-beta-runbook.md`, `docs/founding-beta-program.md`,
      `docs/plans/beta-launch-plan.md`, and public copy describe the same 1.0
      capability and exclusions.
- [ ] Evidence and checkbox state are recorded in the single rolling Linear
      comments for `OVD-206`, `OVD-359`, `OVD-319`, and `OVD-358` as assigned
      in the runbook; proprietary customer files are not attached to Linear.
- [ ] A human release decision records the evidence links and explicitly accepts
      any remaining non-blocking risk.

## Non-gates

The following are not required for 1.0 and must not be used to hold the release:

- anonymous upload or quote claim into a new account
- self-service subscription billing or a paid customer
- provider lanes beyond the four named 1.0 providers and their qualified
  process-specific envelopes, including Weerg, Geomiq and OSH Cut (1.1)
- native apps or CAD plug-ins
- supplier discovery or supplier-communication agents
- geometry characterization, estimates, heatmaps, or DFM/DFA
- CAD/drawing automation or PDM
- manufacturing payment, ordering, inspection, warehousing, or fulfillment

Their promotion rules and future homes are in `ROADMAP.md`.
