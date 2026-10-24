QA: PASS on 7c31703bfa83971aac29036b2c36887899e1e295
- Bare `$` parses only for USD registry: `xometryCurrency.test.ts` covers `$41.41`/T1 tier text passing for USD and failing `price_currency_unverified` for CAD, EUR and null registry.
- `C$41.41`, `A$41.41`, `€41.41`, `£41.41` rejected even with USD registry (plus CA$/GBP/EUR-prefixed variants).
- Local: 4 files / 219 tests pass (xometryCurrency, xometryOffers, xometry, providerAdapterContract). All checks green, including required `ci` and `provider-go-live`.
CI: https://github.com/optomachina/Overdrafter/actions/runs/38827830640
