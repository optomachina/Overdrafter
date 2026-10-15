# Xometry option currency boundary

The synthetic provider-readiness audit demonstrated that `CAD $100.00` became
`totalPriceUsd: 100` in `parseXometryOfferSnapshots`. The audited parser at
278122145914dadb1e0f7c89385d764965f9762f matched this branch byte-for-byte before
repair. Nine new regression cases failed before the guard was added (13 original
cases total). Failure evidence is retained in the local task output directory.

The USD-only offer parser now requires an explicit USD marker on every dollar
amount. It recognizes USD before/after an amount and the US$ prefix; it rejects
bare dollar amounts, foreign currencies and contradictory currency annotations.
The guard examines recognized currency codes case-insensitively on the entire price line to catch
`USD/CAD` and `CAD US$` conflicts. Currency names come from the Node runtime's
currency-code registry for detection only; this is not FX or a supported-provider
currency policy. Ordinary lowercase prose such as “per order” and “tax included”
is not treated as a currency code. Untrusted currency annotations fail closed. Numeric precision and unit/total grammar are unchanged; this guard does not qualify every money format.

Rejection throws `xometry_offer_currency_untrusted` before any offer array returns,
with the observed native currency markers and bounded original provider text in
internal error evidence. CAD is retained as CAD, never converted or relabeled.
A mixed USD/CAD option set yields no partial USD result. The existing adapter
preserves this error payload through its failure path. No new native-currency
customer offer type, currency conversion, price arithmetic or retry policy is
introduced. Synthetic positive adapter fixtures now explicitly label USD; they
are not evidence that the live portal currently supplies those labels.

Validation: 135 focused tests passed across Xometry currency, option normalization,
full mocked adapter, and provider adapter contract suites. Worker typecheck/build,
scoped lint and provider catalog checks passed. Independent review found two
annotation edge cases that were fixed with regressions. No live provider/session,
customer data, quote execution, database write, publication or deployment occurred.

Scope is the demonstrated option parser. The legacy generic `parseFirstCurrency`
helper and manual-review summary fallback remain unchanged; this is not a claim
that every generic money parser in the repository is currency-safe. A separate
review of fallback summary fields is warranted before broader currency assurance.
No production activation is implied. Current portal currency evidence must be
qualified before expecting symbol-only options to continue working; absent that
evidence this repair deliberately withholds the offer.

Reproduce the focused checks:

```sh
npm test -- worker/src/adapters/xometryCurrency.test.ts worker/src/adapters/xometryOffers.test.ts worker/src/adapters/xometry.test.ts worker/src/adapters/providerAdapterContract.test.ts
npm run verify:worker
npm run provider:check
```

Review follow-up: explicit `Currency: CODE`/`currency = CODE` declarations bind the whole option across lines. Three-letter prose prefixes are ignored unless they are recognized currency codes; all recognized code tokens remain conflicting evidence regardless of case or separator. The narrow complete lowercase phrases `all taxes included` and `all fees included` are excluded from that scan, including when parenthesized. Other code-like prose may still be withheld as ambiguous. The phrase `all taxes/fees included` is treated as prose; explicit `ALL` remains ambiguous currency evidence and is rejected.

A `Currency:` or `currency =` declaration is validated in full: only an exact USD declaration is accepted. Mixed or unsupported values are withheld, rather than accepting their USD prefix. This intentionally conservative grammar is not a general natural-language currency interpreter.
