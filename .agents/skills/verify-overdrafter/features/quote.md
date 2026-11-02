# Quote

A client uploads a STEP part, sees it open as a part with its CAD view, compares provider quote offers, picks one, and sets the shipping destination used for quoting. No order, checkout or payment happens in this journey.

## Sub-features

- `quote-intake` STEP upload opens the part, survives reload, rejects empty and non-STEP payloads, creates one job on repeated selection.
- `quote-compare` offers table and chart agree on selection; US-only filter; missing lead time shown as unavailable; stale/expired offers not selectable; keyboard-only selection; phone layout.
- `quote-destination` a client-role member edits and confirms the org shipping address.
- `quote-confirmation` separate harness for the confirmation flow (`npm run e2e:quote-confirmation`).

## How to get to it (user POV)

- `/parts` upload control, then the part page.
- Quote comparison panel on a part page.
- Account menu, Settings dialog, Shipping Address Edit.

## Driving it with Playwright

Preconditions: `quote-compare` fixture mode; `quote-intake`, `quote-destination` local mode with the seeded client and its organization "Fixture Machine Co.".

- **Compare (fixture).** `verify.sh --features quote`. Runs `e2e/quote-comparison.spec.ts` (cases a to i plus lapse and phone). Expect one selected offer, no order/checkout control in the decision panel.
- **Intake and destination (local).** `verify.sh --mode local --prepare --features quote`. Runs `e2e/intake.spec.ts` and `e2e/sourcing-destination.spec.ts`. Expect the part to reopen after reload; after saving the address, reload Settings and see it persisted.
- **Confirmation harness.** `npm run e2e:quote-confirmation` (own config, not wrapped by `verify.sh`).

## Gotchas

- Fixture mode shows a "Founding Beta new-part access could not be verified" banner on the part page because Supabase is a dead port there. It is expected and not part of the comparison journey; do not report it as a regression from a fixture run.
- Intake needs real storage and the local stack; fixture mode cannot prove it.
- Mutations touch only the disposable local database. Reset with `npm run db:reset` if state drifts.
- Real supplier carts and live quotes are out of scope; never upload parts to a provider from this skill.
