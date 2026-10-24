QA: PASS on b4d105cf4695b87cd65f90cd85af2568add0a7d2
- T1 replay: `providerAdapterContract.test.ts` replays the scrubbed `xometry-t1-saved-requirement-mismatch.json` (it has no `terminalState` and does contain "Continue to Checkout"). The result is `ok: true`, `configuration_required`, with no violations. The fixture notes it is scrubbed, with the quote id replaced by Q00-TEST-0001.
- Checkout false positive: "Continue to Checkout" in page text or `bodyExcerpt` raises no `purchasing_action_observed`. A real checkout click, navigation, request or URL still raises it, and a non-settled page still reports `finite_terminal_state_missing`.
- Local: 33/33 tests pass. All checks are green, including required `ci` and `provider-go-live`.
CI: https://github.com/optomachina/Overdrafter/actions/runs/38827828580
