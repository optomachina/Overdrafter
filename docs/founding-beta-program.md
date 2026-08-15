# OverDrafter Founding Beta Program

Last updated: August 12, 2026

## Purpose

This is the durable operating specification for the 1.0 Founding Beta. It
turns the production contract in `docs/1-0-beta-runbook.md` into a small,
evidence-driven customer program without expanding the product promise.

Linear issue `OVD-358` owns the program. `OVD-359`, `OVD-206`, and `OVD-319`
must close first. The beta is free, invitation-only product research—not
general availability, a paid pilot, or a reason to bypass launch safeguards.

## Outcome and valid decisions

At the end, the product owner chooses one evidence-backed direction:

1. proceed to a separately approved 1.1 paid pilot;
2. improve the same narrow workflow;
3. position some or all delivery as a managed service;
4. narrow or change the supported-package boundary; or
5. stop because value, reliability, safety, or economics are insufficient.

A negative conclusion is valid. Scope does not expand to make metrics pass.

## Cohort and limits

- Begin with up to three qualified personal contacts of the founder. They use
  the same eligibility rubric, terms, disclosures, access controls, and
  observation protocol as any later participant.
- The release minimum remains three participants, five truthful production
  attempts, and at least three live offers that participants understand.
- Operating target: five accepted participants and ten eligible customer-
  supplied packages.
- Hard cap: twenty automatic-provider runs across the program.
- Stop after four weeks from first activation or when the run cap is reached,
  whichever comes first.
- Each participant may bring one to three genuine parts.
- Access is free; no card is required. No payment, order, PO, or supplier
  commitment may be created.
- Public recruitment is optional after the initial private tranche. Use it only
  if more diversity or capacity is needed. A public application never accepts
  files and never grants product or vendor access.
- If public recruitment is used, cap the waitlist at ten applicants and close
  recruitment when the cohort and waitlist are full.

## Supported and prohibited work

The exact supported package and geometry non-promise live in the 1.0 beta
runbook. A useful outcome may be a trustworthy live Xometry offer, truthful
provider guidance, or a bounded unsupported-package result.

Do not accept ITAR, export-controlled, classified, CUI, weapon, firearm,
medical-implant, life-safety, or otherwise regulated work. Also reject files
the applicant lacks authority to share, unsupported materials/processes,
time-critical requests, or work whose failure creates material safety or
business harm.

The beta provides no uptime or quote-delivery SLA. Customers independently
verify vendor price, validity, availability, requirements, and purchasing terms.

## Readiness gate

No participant—including a friend—may upload a proprietary file until all of
the following are verified:

- `OVD-359`: approved and deployed terms, privacy/data handling, participant
  safeguards, disclosure affirmation, beta-organization boundary, Xometry-only
  routing, support, retention/deletion, incident, and withdrawal behavior;
- `OVD-206`: repeatable hosted Xometry quote and forced-failure evidence;
- `OVD-319`: certified deployed journey, organization isolation, monitoring,
  spend/run stop controls, rollback, browser/accessibility checks, and no-order
  authority; and
- the beta intake, evidence, communications, support, and stop-control checklist
  in `OVD-358` is complete.

The founder explicitly authorizes each invitation. Signup alone is not
enrollment.

## Participant commitment and safeguards

Accepted participants agree to bring a real eligible part, complete a short
baseline, attend a 30-minute kickoff, complete the first attempt while observed
but not coached, join a 20-minute debrief, report untrustworthy results, and
avoid relying on the beta for time-critical production.

Screen or session recording requires separate optional consent. Participation
cannot require recording permission. Customer files and quote data are not used
to train unrelated models without a separate explicit opt-in.

Participants retain ownership. File use is limited to operating the service and
preparing the requested quote under the published terms. Research recordings,
if any, stay separately access-controlled. The current policy revision is
`founding-beta-2026-08-15`; its Terms and Privacy/data-handling notice are
published at `/legal/beta-terms` and `/legal/privacy`. Participants may withdraw
through `blaineswilson@gmail.com`, and operators follow
`docs/workflows/founding-beta-support.md` so published deletion behavior matches
what the service can execute.

## Qualification

Record only what is needed: contact, segment/role, organization size, sourcing
frequency, current sourcing process and active time, genuine need, supported
STEP/STP and aluminum-CNC fit, quantity, needed-by context, authority to share,
regulated-work exclusion, research availability, and referral source.

Score consistently:

- 2: genuine sourcing need within 30 days;
- 2: exact supported-package fit;
- 1: target-customer fit;
- 1: describable current process/time baseline;
- 1: observed first attempt and debrief commitment; and
- 1: likely repeat need or second eligible part.

Any prohibited-work match rejects regardless of score. Select useful variation
across target segments, not merely the highest company value.

## Evidence and metrics

Measure the smallest set needed to decide value and operating model:

- funnel: invited/applied, eligible, accepted, activated, first upload, first
  terminal result, debrief, and 1.1 paid-pilot interest;
- attempt: pseudonymous participant/organization, eligibility reason, package
  class, upload/review/request/terminal timestamps, corrected/unknown fields,
  outcome type, offer facts, retries/failures, selection/handoff, coaching, and
  repair/intervention;
- effort: customer active minutes, total elapsed time, and staff onboarding,
  support, monitoring, repair, and session-maintenance minutes;
- direct cost: worker compute, model/API, storage/transfer, browser/session,
  retry, and vendor fees; and
- value: comprehension, trust, usefulness, time saved/added, repeat intent, and
  unprompted comparison with the participant's current process.

Never put filenames, file contents, raw quote payloads, credentials, or
unnecessary personal data in analytics or Linear. Test events must be separable
from participant events. Retention and deletion must match published policy.

Building a large analytics platform is not a beta gate. Use existing product
events and sanitized operational evidence first; add only missing fields that
are required to answer the program decisions.

## Hypotheses, not manufactured pass/fail targets

- at least 70% of first attempts complete without founder guidance;
- median customer active time is 15 minutes or less;
- every attempt reaches a truthful finite state;
- at least 80% of eligible packages reach a useful result inside the published
  operating window;
- median unscheduled staff intervention is 10 minutes or less per package;
- no attempt requires direct database repair to appear successful;
- at least three participants report saving 30 minutes or more; and
- at least three correctly explain result type, price/lead time when present,
  and next action.

Missing a hypothesis blocks the related conclusion, not honest reporting.

Pricing reactions may be tested only after the participant experiences value.
The closing report may compare per-pack, subscription, and managed-service
hypotheses. A real paid offer, acceptance, billing activation, and the first paid
customer belong to 1.1 and are not 1.0 gates.

## Research interaction

Before showing price hypotheses, ask:

1. What result did OverDrafter return?
2. What would you do next?
3. What did you expect that did not happen?
4. Where did you hesitate?
5. How would you have handled this without OverDrafter?
6. How much active time did this save or add?
7. How useful and trustworthy was it, and why?
8. Would you submit a second real part?

Record the reason behind any pricing response rather than only a selected price.

## Feedback and support

Use `blaineswilson@gmail.com` as the one monitored support route, one in-product feedback path when available,
sanitized Linear triage, and scheduled kickoff/debrief calls. Do not create a
chat community, forum, and multiple survey systems for this cohort.

Classify observations as safety/privacy incident, quote-truth defect, core-
journey blocker, usability/comprehension problem, reliability/operations
problem, support burden, pricing/value evidence, or expansion request. Only the
first five categories may interrupt the beta. Expansion requests go to
`ROADMAP.md` and do not become active issues automatically.

## Immediate stop conditions

Pause all beta dispatch for cross-organization exposure, wrong-file disclosure,
credential/session leak, unexpected order/payment/commitment, uncontrolled
provider spend, a synthetic/stale/mismatched price labeled live, indefinite work
without recovery, prohibited-work acceptance, or inability to honor published
withdrawal/deletion behavior.

Disable the relevant rollout control, follow the incident path, notify affected
participants as required, and resume only after reviewed correction and retest.

## Optional public recruitment surface

Do not build this before the private cohort unless the product owner decides it
is required. If promoted, use the existing domain and the minimum routes:

- `/beta`: promise, eligibility, commitment, exclusions, FAQ, and apply action;
- `/beta/apply`: no file upload; qualification attestations, contact consent,
  and referral/UTM capture;
- `/beta/thanks`: truthful receipt, review timing, and no-file-by-email notice;
  and
- `/legal/beta-terms`: the reviewed participant contract.
- `/legal/privacy`: the reviewed Privacy and data-handling notice.

Publishing social recruitment remains a human action after the application,
legal/privacy, analytics, support, and stop controls are verified.

## Linear and issue-budget policy

Use `OVD-358` as the single Founding Beta program issue. Keep communications,
cohort operations, weekly summaries, and the closing report as checklists and
artifacts there. Reuse `OVD-359`, `OVD-206`, and `OVD-319` for their existing
safety and production evidence.

Do not pre-create the eight possible beta workstreams as issues. Create a child
only when a concrete missing implementation is admitted to the active queue;
split again only if its complexity policy requires it. This preserves Linear
free-plan capacity and keeps one obvious next task.

## Completion report

`OVD-358` closes only after a sanitized report records cohort and attempts,
eligibility mix, result/live-offer rates, customer/elapsed time, unassisted
completion, intervention, direct and fully loaded cost, trust/comprehension,
repeat use, time saved, pricing response, incidents/defects, expansion themes,
recommended product boundary, service model, price test, and explicit next
decision.
