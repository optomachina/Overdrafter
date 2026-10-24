# OVD-463/464 commercial observation contract proposal

Status: PROPOSED for integration/validator-owner review, not an approved schema,
production change, or OVD-569 readiness claim. Source baseline:
6fcbf41d5a3380a97b8b7eab5d97793cfc28f2ff. Prepared 2026-10-02.

## 1. Separate immutable observations from projections

OVD-463 should validate an immutable `CommercialObservation` bound to the existing
provider/offer, execution, scope/package, quantity, destination, collection time,
and evidence identities. A caller's `confirmed` tag alone proves nothing: the
validator must establish the relevant provenance and binding.

OVD-569 should later consume that observation plus an explicit `Scenario`; it
returns a projection referencing the observation ID and scenario ID. It must not
rewrite source amounts, dates, lead time, validity, or provenance. OVD-464 persists
only validated observations and finite outcomes; projections confer no dispatch,
publication, selection, or purchase authority.

Proposed fact union (conceptual, not an implemented TypeScript/API contract):

- `confirmed { value, evidenceRefs }`: directly supported by validated provider
  evidence for this scope. Means observed provider statement, not independently
  guaranteed truth or an OverDrafter promise.
- `estimated { value, methodId, assumptions, inputRefs }`: reproducible calculation
  or explicitly provider-labeled estimate. Never promoted merely because precise.
- `unknown { reason }`: absent, ambiguous, contradictory, unsupported precision,
  or mismatched scope. No numeric zero, empty date, or optimistic default.

A derived result additionally carries `derivation: observed | computed`, dependencies,
and scope applicability. All-confirmed arithmetic can be `confirmed/computed` only
when every necessary amount and coverage fact is confirmed; it remains a computed
cost, not a provider-offered new price. Any estimated dependency makes the result
estimated. Any unresolved required dependency makes that aggregate unknown, while
known components remain separately visible. Contradictions need review, not averaging.

## 2. Money and inclusion: account once, do not guess

Each observed money value is `{ currency, minorUnits }`, where `minorUnits` is a
nonnegative integer encoded as a decimal string. Currency and its exponent must come
from the validator's explicit supported-currency contract, not a symbol or locale.
Never convert currencies in this slice. Preserve the raw source amount reference.

Parse observed decimals exactly at that exponent. Excess precision is rejected or
unknown with a precision reason; never silently round provider evidence. Sum and
compare integer amounts in deterministic code. Estimates require an explicit,
versioned rounding policy and stage (e.g. round an estimated tax line once before
summing); without that policy the estimate is unknown. Do not use floating-point
money or infer tax rates. Refunds, discounts and negative adjustments are outside
this first fixture slice pending an explicit adjustment contract.

Use charge groups with stable IDs and explicit coverage rather than summing every
visible number. A confirmed aggregate may cover several categories whose internal
split is unknown. Proposed initial categories: manufacturing, shipping, tax, fees.
This set is not proof that all possible charges are covered: require a separate
confirmed `coverageComplete` fact for a final delivered total.

Each category records one relationship:

- `includedIn(groupId)`: already covered by that observed aggregate; add nothing.
- `additional(groupId)`: separately payable; include that group exactly once.
- `notApplicable(evidenceRef)`: explicitly absent/waived; contributes confirmed zero.
- `unknown(reason)`: relationship or amount is not known; delivered total is unknown.

Reject dangling references, duplicate group IDs, overlapping aggregate coverage,
cycles, conflicting inclusion assertions and mixed-currency sums. An itemized amount
inside an aggregate is explanatory evidence, not another payable group. Unresolved
reconciliation (e.g. line items disagree with total) produces review/unknown; do not
silently prefer whichever is cheaper. A known subtotal may remain visible but must
not be labeled delivered total.

A hypothetical replacement shipping service cannot simply be added to a total that
already includes shipping. It needs an explicit replacement relationship and a known
removable original shipping amount. Otherwise that scenario total is unknown. Keep
scenario estimates separate from the provider's original option; no synthetic offer.

## 3. Arrival: endpoint and calendar are required facts

Represent fixed provider dates and durations separately:

- Fixed date observation: date-only or timestamp, explicit endpoint
  (`ship | receive | unknown`), timezone if stated, and source evidence. Preserve the
  original representation. A ship date is never a receive date.
- Lead duration: value/unit (`business_day | calendar_day`), start event
  (`order_accepted | payment_received | quote_collected | unknown`), and end event
  (`manufacturing_complete | ship | receive | unknown`). Never infer endpoints from
  a generic "lead time" label.
- Transit duration/range: separately sourced service/destination-bound fact unless
  lead duration explicitly ends at receipt. Do not add transit twice.
- Calendar inputs: versioned working-day/holiday calendar, applicable timezone,
  provider cutoff rule and boundary convention, and relevant start timestamp.
  Missing fields remain unknown; generic Monday–Friday arithmetic is not a provider
  calendar. "Order today" does not prove provider acceptance or payment receipt.

A duration-based arrival projection requires every relevant endpoint, anchor,
calendar and transit fact. It is labeled hypothetical/estimated even when all inputs
are confirmed, because future acceptance and performance are not guaranteed. Unknown
transit/calendar/cutoff must not produce a single promised arrival date. An explicit
bounded range may be returned only when supported input bounds actually suffice;
never manufacture a conservative-looking range from missing inputs.

A provider's fixed receive date stays fixed when the hypothetical order date changes.
The changed scenario may be inapplicable or require review; it does not shift or renew
the provider promise. Preserve unknown expiry and existing invalidation independently.
A date-only receive-by observation can remain displayed as a provider-stated date;
do not invent midnight UTC. Precise deadline comparisons across unknown timezones
remain unknown unless an approved same-calendar-date comparison rule applies.

## 4. OVD-464 outcome boundary

Use existing task lifecycle/diagnostic authorities; do not introduce competing retry
states. Proposed semantic outputs for the owner to map onto those existing enums:

1. Validated complete offer set (including explicit commercial unknowns permitted by
   its contract); valid observation does not imply selectable/publishable eligibility.
2. Validated provider follow-up/unsupported outcome with bounded client-safe reason.
3. Rejected malformed, partial or mismatched result, with zero canonical offer writes.
4. Authorized transient failure handled only by the existing finite retry policy.

Missing optional tax/transit is different from malformed required price or partial
option-set reconciliation. The schema owner must explicitly identify which unknowns
are admissible; the projection layer cannot relax a validator requirement.

OVD-571 completion notice requires a request-level terminal predicate and complete
expected-lane accounting. One completed provider is not request completion. Retry
pending, unknown lane state, canceled/revoked scope, and mixed terminal outcomes need
explicit existing-state mappings. No "quotes ready" message merely because processing
ended, and no new generic notification system.

## 5. Five synthetic worked examples

| Case | Authoritative synthetic inputs | Required result |
| --- | --- | --- |
| 1: separated charges | USD manufacturing 10000 minor units; additional shipping 1000; additional tax 880; fees explicitly waived; complete coverage; all confirmed | Computed delivered cost USD 11880, confirmed inputs; original observations unchanged. No rounding or price-generation step. |
| 2: all-in total, unknown split | USD grand-total group 12000 explicitly includes manufacturing, shipping, tax and fees; complete coverage confirmed; individual allocations absent | Delivered cost USD 12000 from confirmed total. Shipping/tax/fee allocations remain unknown. Never add invented zero components or add the total to itself. |
| 3: incomplete coverage and shipping replacement | USD group 10000 covers manufacturing and embedded shipping; tax and fees unknown. Scenario requests estimated replacement shipping USD 1500; original embedded shipping amount unknown | Original known subtotal USD 10000; delivered total unknown. Replacement scenario total also unknown: cannot subtract unknown shipping or add 1500 to an already inclusive total. |
| 4: mixed currency | Manufacturing EUR 10000; additional shipping USD 1000; no authorized FX observation | Components remain in source currencies; delivered total unknown (`currency_mismatch`). No USD relabeling or guessed FX conversion. |
| 5: duration versus fixed date | Offer A says "3 business days" with unspecified endpoint/calendar/cutoff and unknown transit. Offer B explicitly states receive by 2026-10-14, date-only, timezone/expiry unstated | A has unknown delivered arrival regardless of quote date. B retains exactly 2026-10-14 as provider-stated receive-by evidence with unknown timezone/expiry. Changing order-today scenario never moves B's date or makes it newly valid. |

## 6. Exact unresolved questions for the owning integrator

1. Which normalized result fields/evidence prove total coverage and each inclusion
   relationship? Does a given provider's `totalPriceUsd` mean manufacturing subtotal
   or all payable charges? Current types cannot answer this.
2. What supported source-currency/exponent and estimation-rounding policy is canonical?
   How should signed discounts/adjustments reconcile with totals in a later extension?
3. Which confirmed destination identity and shipping-service observation bind transit?
   Are date/duration facts anchored to acceptance, payment, manufacture, shipment, or
   receipt? Who supplies and versions cutoff/timezone/holiday calendars?
4. Which optional commercial unknowns may OVD-463 accept while still rejecting malformed
   required amounts and partial offer sets? Which states prevent selection/publication?
5. What exact existing OVD-464 request/lane states and expected-lane snapshot define
   terminal completion, especially cancellation/revocation, retries and mixed outcomes?
6. What does the OVD-571 label "expected OTD" mean in the approved consumer contract,
   and what unknown/estimated labeling and date-comparison rule should it use?

These cannot safely be settled from the inspected source. No production activation
or live provider contact is needed to decide the contract, but the owners must decide
before consumers are implemented.

## 7. Smallest next pure-contract fixture slice

After owner acceptance, add one versioned observation/projection type module and one
pure, dependency-injected fixture suite under quote-domain ownership. First support
only observed all-in totals or nonoverlapping additional groups in one explicit
currency, plus fixed receive-date passthrough. Test the five examples, source deep-
freeze immutability, missing versus confirmed-zero, duplicate/overlap rejection,
malformed decimal precision, and scope/validity preservation. No worker wiring, schema
migration, UI, tax calculator, FX, or inferred duration-based arrival.

Keep duration-to-arrival as unknown until endpoint/calendar/cutoff inputs are settled;
then add deterministic calendar fixtures in a separate slice. This provides an honest
small contract without pretending the full OVD-569 acceptance or OVD-571 dependency
has been satisfied. Existing 56 selection/sourcing tests remain baseline evidence,
not proof of this unimplemented proposal.
