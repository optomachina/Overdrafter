# Pure commercial contract proposal v1

Status: **proposal, not production policy**. This self-contained module is not
imported by a live projection, provider adapter, selection, or publication path.
It does not establish OVD-569 readiness or reactivate any blocked issue.

`src/features/quotes/commercial-contract-proposal/contract.ts` supplies exact
source-decimal parsing, a once-per-group cost sum, and fixed date-only receive
observation passthrough. Callers must provide previously validated, scope-bound
observations. Evidence references and confirmed labels are caller assertions;
this module neither validates evidence nor grants authority. `confirmed` output
means computed from confirmed input assertions, not a guaranteed or newly offered
price. No aggregate result replaces its immutable source observation.

Cost groups list covered categories. All four proposed categories (manufacturing,
shipping, tax, fees) must be covered exactly once or explicitly waived. A separate
coverage-complete assertion is also required; covering four categories alone is
not evidence that all payable charges are known. A single all-in amount can cover
several categories without a known allocation. Itemized explanatory amounts must
not be submitted again as payable groups: overlapping categories produce unknown,
including conflicting totals or an attempted replacement of included shipping.
No choice between conflicting amounts is made. Original known components remain
in the source observation even when the aggregate is unknown.

Confirmed, estimated, and unknown are distinct. Estimates propagate from amount,
waiver, or coverage dependencies; they are never upgraded by precise arithmetic.
Unknown or unsupported required information produces no numeric total. The module
calculates no estimates, tax, shipping, discounts, FX, or currency rounding. Money
uses exact nonnegative decimal-string minor units, a retained currency exponent,
and BigInt sums. Same-code amounts with different exponents are rejected. Decimal parsing
rejects excess precision (including extra trailing zeros), negative values,
scientific notation, currency symbols and whitespace. Currency code and exponent
are supplied explicitly; accepted exponents 0–6 are a proposal envelope, not an ISO
currency registry or approved supported-currency policy. A runtime provider-input
validator, size limits and reconciliation rules remain outside this slice.

Receive dates support only explicit Gregorian `YYYY-MM-DD` dates with a receive
endpoint. Ship dates, durations, malformed dates and timestamps do not become
receive dates. Confirmed/estimated/unknown status is preserved. Unknown timezone
and validity remain unknown; no date is shifted by an order-date scenario, no
expiry is renewed, and no comparison to a deadline is supplied. No calendar or
transit promise is inferred. Returned date facts are copied, not shared with source.

## Worked synthetic examples

| Inputs | Result |
| --- | --- |
| USD manufacturing 10000 + shipping 1000 + tax 880 minor units, fee explicitly waived, complete coverage | Confirmed computed USD 11880 |
| USD 12000 all-in covers all four categories; internal split absent | Confirmed computed USD 12000, counted once; no component allocation invented |
| All-in USD 12000 plus shipping USD 1500 covering shipping again | Unknown: overlapping coverage; no 13500 total |
| USD 10000 subtotal includes manufacturing/shipping; tax and fees missing | Unknown: incomplete categories; original subtotal preserved at source |
| EUR manufacturing group plus USD shipping | Unknown: currency mismatch; no conversion |
| Complete USD 12000 provider estimate | Estimated USD 12000, never confirmed |
| USD `1.005`, `1.999`, or `1.230` at exponent 2 | Excess precision; no rounding to cents |
| USD exponent 3 amount used with a USD exponent 2 observation | Unknown: precision mismatch; no silent rescaling |
| Exact USD 9007199254740993 + 1 minor unit | Exact 9007199254740994 minor units, no float loss |
| Receive by `2026-10-14`, timezone/validity unstated | Exact date-only fact preserved; timezone/validity unknown |
| Ship date or `3 business days` without receive evidence | Receive date unknown |

## Verification and remaining decisions

Run focused fixtures and source checks:

```sh
npm test -- src/features/quotes/commercial-contract-proposal/contract.test.ts
npm run typecheck
npm exec eslint -- src/features/quotes/commercial-contract-proposal
```

Validation: 37 focused fixture cases passed; root typechecks and scoped lint passed.
Independent source review identified and then cleared a currency-exponent loss
issue; the same-currency/mixed-precision regression is included. No full suite was
rerun for this isolated pure module, and no live consumer imports it.

Business/validator owners must still approve category coverage semantics, source
currency/exponent support, evidence/scope validation, permissible unknowns,
reconciliation and adjustment rules, estimate rounding policies, and receive-date
comparison conventions. Duration-based arrival needs separate endpoint, acceptance,
cutoff, transit, timezone and holiday-calendar contracts. This slice settles none
of those policies and has no production integration or provider side effects.
