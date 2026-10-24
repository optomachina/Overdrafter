# Delivered cost / arrival source readiness

Read-only audit on 2026-10-02 at source 6fcbf41d5a3380a97b8b7eab5d97793cfc28f2ff.
No issue transitions/writes, production activity, new source code, or new commit.

## Current issue evidence

- OVD-569 is Backlog, no comments. Requires immutable provider observations,
  component delivered costs with confirmed/estimated/unknown provenance, bounded
  shipping scenarios, order-today durations and fixed dates, deterministic cutoff/
  calendar tests, and a registered consumer contract before dependent work.
- OVD-571 is Backlog, no comments. Depends on OVD-569, OVD-464, OVD-570, OVD-337.
  Requires delivered dates/expected OTD, unknown/estimate distinctions, exact options,
  accessible controls, stable selection/focus/viewport, terminal completion notice,
  and real browser evidence.
- OVD-463 is Backlog. Its latest available rolling comment explicitly says no
  implementation active and dependency-sequenced behind OVD-380/411-414. Its strict
  normalized result/provenance schema is source work, not just a runtime release gate.
- OVD-464 is Backlog. Latest available rolling comment says no implementation active
  pending OVD-461/462/463. Canonical finite terminal outcomes/worker integration are
  source prerequisites for the completion notice, beyond provider release admission.
- OVD-345, OVD-347, and OVD-570 are Done. Do not reopen their completed source work;
  immutable scope/validity and persisted destination/deadline foundations exist.

Issue sources: https://linear.app/overdrafter/issue/OVD-569,
https://linear.app/overdrafter/issue/OVD-571,
https://linear.app/overdrafter/issue/OVD-463,
https://linear.app/overdrafter/issue/OVD-464.

## Actual source boundaries

worker/src/types.ts VendorQuoteAdapterOffer supplies USD unit/total amounts,
leadTimeBusinessDays, shipReceiveBy and selector provenance. It has no typed freight,
tax, fee components; inclusion/double-count semantics; shipping-service transit;
provider cutoff/timezone/calendar; or confirmed/estimated/unknown component facts.
VendorQuoteAdapterOutput preserves explicit validity separately from collection time.

src/features/quotes/utils.ts ImportedVendorOffer similarly has unit/total and
lead/fixed dates, without delivered component or scenario contracts.
selection.ts resolves fixed receive/due dates first, otherwise adds business days to
the quote date (or now). That is an existing lead-time projection, not a canonical
order-today delivered-arrival contract. It does not account for shipping transit,
cutoff timezone, provider holidays, or shipping scenarios. Relabeling it as confirmed
arrival would invent evidence.
sourcing-result.ts already preserves fixed source dates when published lead times
change, and recomputes duration-derived dates when appropriate. Existing tests cover
these meaningful invariants; duplicating them adds no new acceptance proof.

## Next bounded implementation slice

First register OVD-569's pure observation-to-projection input/output contract with
its result-validator owner. Settle: whether provider total includes freight/tax/fees;
minor-unit/currency and rounding rules; component evidence references and unknown
semantics; which confirmed destination/scenario binds transit; whether lead time ends
at manufacture/ship/receive; and explicit cutoff timezone/business-calendar inputs.
No model may supply these missing rules or promote unknown values to zero/confirmed.

Once settled, implement a pure projection with a frozen-source fixture matrix:
all-known total; unknown tax/fee; zero explicitly confirmed charge; already-included
shipping (no double count); scenario-only estimated freight; fixed date unchanged by
order date; duration+transit with weekend/holiday/cutoff boundaries; missing transit
keeps arrival unknown; expired/unknown validity remains distinct. Register this exact
contract before OVD-571 consumes it. OVD-571's terminal notice separately needs the
OVD-464 terminal outcome contract and browser qualification.

## Proof and decision

Existing selection + sourcing tests: 56/56 pass. Command:
npm test -- src/features/quotes/selection.test.ts src/features/quotes/sourcing-result.test.ts

No demonstrated defect or unsettled-semantics-free new fixture gap was found in this
bounded audit. Therefore no implementation was invented and no blocked issue was
activated. Future live provider qualification is an additional release gate; it does
not resolve the missing source semantics above. Prior expiry commit remains unchanged.
