# OverDrafter 1.0 Acceptance Criteria

Last updated: August 12, 2026

## Purpose

This checklist defines the evidence required to release **OverDrafter 1.0 —
Part to Quote** as a controlled design-partner beta, not general availability.
It is intentionally limited to the product contract in
`PRD.md` and the active queue in `PLAN.md`.

A passing build is necessary but insufficient. “Bug-free” is not measurable,
and collecting revenue is a 1.1 milestone. Every checkbox below must have an
artifact, production observation, test, or explicit human decision behind it.

## Supported-package promise

- [ ] Customer-facing copy names the exact package envelope in
      `docs/1-0-beta-runbook.md`: one STEP/STP file submitted as one part,
      declared units,
      CNC milling, aluminum 6061-T6, quantity one, as-machined finish, standard
      `+/- 0.005 in` or looser tolerance, no special requirements, and the
      stated non-ITAR limit.
- [ ] Customer-facing copy says that only the explicitly owner-approved golden
      geometry is certified for repeatable automatic pricing; customer geometry may end in
      manual review, provider guidance, or unsupported without implying a size
      or feature guarantee.
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
- [ ] The hosted worker processes the validated Xometry lane under a bounded
      spend guard and without manufacturing-order authority.
- [ ] A successful lane produces a persisted live offer with real total price,
      lead time, vendor identity, source reference, collection time, disclosed
      package identity, quantity, and commercial-validity facts when supplied.
- [ ] The customer sees whether the outcome is a live offer, provider guidance,
      or unsupported package; recommendations and estimates are never labeled
      as returned quotes.
- [ ] When more than one trustworthy offer exists, the customer can compare and
      select one without unrelated offers being presented as a trend or Pareto
      curve.
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
- [ ] The 1.0 worker is configured with exactly `xometry`, the enrolled
      organization's effective vendor list is exactly `xometry`, and a missing
      organization-vendor configuration fails closed instead of inheriting the
      legacy multi-vendor defaults.
- [ ] Simulated, synthetic, stale, mismatched-scope, or untrusted-adapter prices
      cannot pass as live offers.
- [ ] Vendor authentication expiry, portal change, timeout, disabled rollout,
      and queue failure each reach a finite, customer-safe terminal state.
- [ ] Retry and cancel behavior cannot create uncontrolled duplicate vendor work
      or any supplier order.
- [ ] Customer-visible errors contain no credentials, storage-state material,
      internal stack traces, or unnecessary personal data.
- [ ] Before dispatch, the customer sees Xometry, the exact outbound filenames,
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

## Production certification

- [ ] The human owner explicitly approves authority to disclose the exact
      golden STEP hash to Xometry, confirms its non-ITAR/export-control status,
      and approves the complete `quote-lane-scope.v1` record before dispatch.
- [ ] The human owner separately confirms public-distribution rights for the
      currently served golden STEP bytes, or the public artifact is removed or
      replaced and any required incident/notification response is recorded.
- [ ] Customer surfaces do not advertise the unapproved `$49/month` or a
      self-service Pro upgrade during the Founding Beta; billing remains off and
      beta access is described truthfully.
- [ ] `OVD-206` records five consecutive hosted-worker runs of the controlled
      golden package defined in `docs/1-0-beta-runbook.md` over at least two
      separate sessions, each returning a real Xometry offer without database
      repair or staff UI operation.
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
- [ ] The documented rollback and session re-authentication procedure has been
      executed successfully by the named operator using the hosted worker's
      supported Playwright storage-state deployment path.

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
- [ ] Every observed stop, misunderstanding, and unsupported package is logged;
      launch-blocking failures are fixed and retested, while expansion requests
      are routed to `ROADMAP.md`.
- [ ] At least two participants say the resulting quote decision would replace
      or materially shorten a sourcing step they perform today.
- [ ] Every attempt has sanitized customer-time, elapsed-time, staff-
      intervention, direct-cost, result-type, and comprehension evidence; no
      filenames, file contents, raw quote payloads, credentials, or unnecessary
      personal data enter analytics or Linear.
- [ ] The program stops after four weeks from first activation or twenty
      automatic-provider runs, and the completion report records value,
      reliability, support burden, unit economics, incidents, expansion themes,
      and an explicit proceed/change/manage/narrow/stop recommendation.
- [ ] Paid-pilot reactions may inform the report, but a real offer, acceptance,
      charge, or paid customer remains a 1.1 decision rather than a 1.0 gate.

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
- [ ] Monitoring owner, customer-support route, spend ceiling, rollout control,
      rollback trigger, and vendor-session owner are recorded.
- [ ] `README.md`, `PRD.md`, `PLAN.md`, `ROADMAP.md`,
      `docs/1-0-beta-runbook.md`, `docs/founding-beta-program.md`, and public
      copy describe the same 1.0 capability and exclusions.
- [ ] Evidence and checkbox state are recorded in the single rolling Linear
      comments for `OVD-206`, `OVD-359`, `OVD-319`, and `OVD-358` as assigned
      in the runbook; proprietary customer files are not attached to Linear.
- [ ] A human release decision records the evidence links and explicitly accepts
      any remaining non-blocking risk.

## Non-gates

The following are not required for 1.0 and must not be used to hold the release:

- anonymous upload or quote claim into a new account
- self-service subscription billing or a paid customer
- additional automatic vendor lanes
- native apps or CAD plug-ins
- supplier discovery or supplier-communication agents
- geometry characterization, estimates, heatmaps, or DFM/DFA
- CAD/drawing automation or PDM
- manufacturing payment, ordering, inspection, warehousing, or fulfillment

Their promotion rules and future homes are in `ROADMAP.md`.
