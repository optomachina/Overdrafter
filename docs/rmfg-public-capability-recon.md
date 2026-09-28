# RMFG public capability reconnaissance (OVD-580)

Reviewed: September 28, 2026. Scope: public first-party material and the current OverDrafter source tree at `926f68059df2f557081fd49efc3ef2f0ac9eb7ad`. This record contains no account, uploaded file, or live quote observation.

## Supported by public evidence

| Area | Public evidence | Conservative conclusion |
| --- | --- | --- |
| Process | [RMFG services](https://www.rmfg.com/docs) and [flat laser cutting](https://www.rmfg.com/laser-cutting-services) | Sheet and tube laser cutting, press brake bending, welding, tapping, hardware insertion, and finishing are advertised. The reviewed sources do not establish CNC milling or turning. STEP support alone cannot establish a machining process. |
| File | [Hosted MCP guide](https://www.rmfg.com/docs/api/mcp) and [agent workflow](https://www.rmfg.com/docs/api/agent-guide.txt) | The hosted upload flow accepts STEP/STP files up to 50 MiB. The REST guide documents STEP analysis. No other upload format is established here. |
| Material | [RMFG materials](https://www.rmfg.com/docs/materials) | Public families include aluminum, steel, and stainless steel for flat stock, plus a tube-profile catalog. Exact stock IDs and availability must come from the current catalog for each quote; family names are not valid API IDs. |
| Quantity | [RMFG flat laser cutting](https://www.rmfg.com/laser-cutting-services) and [agent workflow](https://www.rmfg.com/docs/api/agent-guide.txt) | One-part quoting is advertised. The API quantity is completed design units, with repeated assembly parts accounted for separately. No fixed maximum or assembly-wide support envelope is proved. |
| Quote path | [API and agent guide](https://www.rmfg.com/docs/api), [hosted MCP guide](https://www.rmfg.com/docs/api/mcp), and [agent workflow](https://www.rmfg.com/docs/api/agent-guide.txt) | RMFG offers hosted MCP and REST quote flows: authenticate, analyze/upload, inspect unique parts, select catalog IDs, configure, quote, and review manufacturability findings. Actual result shape, prices, lead times, expiry, and account permissions require authorized observation. |
| Account | User confirmation recorded in [OVD-580](https://linear.app/overdrafter/issue/OVD-580/make-rmfg-quotes-operational-for-the-10-provider-portfolio) | An account is reported to exist. Current session, OAuth scope, and quote access are unverified. Do not create another account or infer access from public docs. |

The [agent workflow](https://www.rmfg.com/docs/api/agent-guide.txt) describes review links and checkout/cart preparation, and a separate payment flow. OverDrafter's quote-only boundary prohibits cart, checkout, order, and payment actions. A future adapter must make those actions unreachable even if RMFG's client exposes them. Quote status and manufacturability findings must remain attached to any reported offer; `requires_input`, `blocked`, pending, and manual-review states cannot become an instant quote by inference.

## Repository fit and next boundary

The provider-neutral manifest, generated catalogs, offline envelope evaluator, adapter contract, and portal kernel already exist. A second generic foundation is unnecessary. `npm run provider:add -- --url https://www.rmfg.com/ --dry-run` identifies `rmfg` as a new provider and proposes a manifest plus **review-only** enum and disabled-admission SQL stubs. The repository's `provider:check` requires exact parity between manifest keys and the `vendor_name` enum. Adding only the RMFG manifest or a generated catalog entry would break that gate; applying a database migration is a separately reviewed schema task. Neither the stub nor a future manifest authorizes provider traffic or customer-facing admission.

Before a provider-specific adapter is shaped, decide whether an API quote-only path can satisfy the contract more safely than portal selectors. Use the current published API schema and an authorized account observation to confirm exact requests, scope, response fields, finite states, and provenance. Do not copy example material IDs, prices, or selectors into production code. A separate exact-file approval is required before any live upload or quote evaluation. Production admission requires its own independent evidence and authorization.

The current [PRD](../PRD.md) and [PLAN](../PLAN.md) still describe a five-provider 1.0 threshold. The September 28 seven-provider direction in OVD-580 needs a central planning-doc reconciliation; this public research record does not change the release gate.
