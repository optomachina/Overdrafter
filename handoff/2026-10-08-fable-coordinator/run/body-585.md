## Linear issue ID

- Issue: OVD-617 (https://linear.app/overdrafter/issue/OVD-617). The child issue was created by the coordinator after this PR was opened as a draft; the original "issue pending" wording is superseded.
- Source acceptance: not fully met. Open: the hosted CI fixture step on the final head, plus the owner-blocked items listed under Review findings (the (e) Pending defect, the Fictiv deviation, the expired-offer "live" wording, and the missing bot review). Nothing is claimed satisfied that is not proven below.
- Main PR for this unit: yes. No earlier PR.
- This PR names no release-outcome parent issue.

## Summary

Adds a `client-comparison` fixture scenario (canonical path `/parts/fx-job-comparison?fixture=client-comparison`) and a new `@fixture` browser spec, `e2e/quote-comparison.spec.ts`, at 1440x900 and 390x844. It covers variant grouping, row and chart selection, the points-only chart, the US-only and all-sourcing views, a missing lead time, stale and expired offers (with a positive control), vendor link attributes, no order, checkout or payment controls in the decision panel, keyboard selection, and phone overflow and tap selection. A new unit test runs the builder through the real selection and trusted-live code.

There are no product code changes. Product defects that surfaced are reported below, not fixed here.

Changes since the first review round (head 722fca9):
- Check (h) was vacuous for ordinary order buttons (its pattern only matched a few phrasings). It now matches any control naming order, reorder, checkout, cart, pay, purchase, buy or PO, drops only the exact legacy handoff name "Review order", and has a positive control for the pattern. A scratch "Place your order" button made (h) fail (see Verification).
- Check (e) never looked at the selected-offer summary. A separate test now selects the offer with no lead time and pins what the summary shows today ("Pending"). It uses ordinary assertions, not `test.fail()`, so a regression in any earlier step still fails it. See Finding 9.
- The spec header and fixture comments no longer say the expired offer fails the trusted-live rules. It passes them and is listed as blocked.
- The unit test no longer stubs `VITE_ENABLE_FIXTURE_MODE`, which does not gate this path (fixture mode is build-mode based).

## Problem

Variant grouping, stale and expired offer handling, the sourcing filter and vendor links had unit coverage only (gap map G9, G10). Every fixture offer resolved to `unknown` origin, so the US-only filter never ran in a browser. Relevant criteria: `ACCEPTANCE_CRITERIA.md` lines 68-80 (comparison, grouping, US-only vs all, vendor destination and sign-in note, no order claims), line 102 (stale prices cannot pass as live), lines 262-263 (comparison/selection and vendor-link tests) and line 268 (viewport, keyboard, focus). This PR adds browser evidence for those behaviours. It does not complete any of those criteria on its own.

## Acceptance criteria addressed

- [x] The new spec passes: 11 tests (10 at 1440x900 plus the 390x844 touch test) at head 3539956, with `client-shell.spec.ts` (22 passed together). The whole `e2e:fixture` lane last ran at 722fca9 in hosted CI (31 passed, 5 skipped, the pre-existing `admin-operations.spec.ts` port-4174 guard); it has not been rerun locally at the new head.
- [x] Mutations ran as scratch edits that were reverted and never committed. Each made the named assertion fail (details under Verification; the first three were run at 722fca9 and the (h) mutation at 3539956).
- [x] The spec passed on a scratch merge of #564+#567+#569+#570 at 722fca9 (details under Verification). Not rerun at the new head.
- [x] No product code changes. The only non-test source change is the fixture module.
- [ ] CI step "Test fixture browser workflows" is green on the final head. Pending the hosted run on 3539956. At 722fca9 it was green (run 37215268299) and all 15 check runs concluded success.
- [ ] (e) "a missing lead time is shown as not available": not satisfied for the selected-offer summary (reads "Pending"). The table and chart are correct and asserted. owner-blocked, see Finding 9.

## Files changed

- `src/features/quotes/client-workspace-fixtures.ts`: registers the `client-comparison` scenario and adds `buildComparisonScenario`. The shared fixture quote helper gains optional `geographicOrigin`, `validUntil` and `tier` fields, and accepts a null lead time. Existing scenarios produce identical data.
- `src/features/quotes/client-comparison-fixture.test.ts` (new): unit test for the builder. `client-workspace-fixtures.test.ts` is not edited (#570 edits it).
- `e2e/quote-comparison.spec.ts` (new): the browser spec.

## Scope

Included. The scenario's offers, all with HTTPS vendor URLs:
- three domestic Xometry variants (US Economy, US Standard, US Expedite) in one provider result;
- a foreign Xometry variant;
- an Xometry offer with no origin;
- an Xometry offer with no lead time;
- an expired Xometry offer (quoted 2 days ago, validity ended yesterday);
- a stale Xometry offer (quoted 20 days ago, otherwise passes every live rule);
- a fresh foreign Fictiv offer.

The approved requirement is 21 days old, so the stale offer fails only the 14-day window. A unit test proves this.

**Deviation from the unit text, owner-blocked.** The unit asked for "one foreign Fictiv offer" that the all-sourcing view shows. Today Fictiv is not in `PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS` (`src/features/quotes/sourcing-result.ts`), so no Fictiv offer can appear in the part-route comparison under either filter. I kept the Fictiv offer as an uncertified-provider negative control and added a foreign Xometry variant ("Overseas Economy"), which the filter assertion (d) uses. The browser asserts a single Xometry provider entry in both views, and the unit test asserts Fictiv is excluded from the live offers. Because only one provider is ever listed, (a) pins the provider-entry rendering only; the step that collects one vendor's offers together (`groupedOptions`) is not observable until a second provider is certified.

Not included: U8 currency (Q18), U12 refresh/requote (Q29), in-session requirement invalidation (Q29), the legacy procurement handoff (Q21), the axe scan (Q27, Q28), colour and contrast. This PR does not complete U10-U13 or R7/R8/R12.

## Findings

1. **Defect, exposed by assertion (b), not fixed here: the first click on a decision-map point is often dropped while a quote table row has focus.**
   - Repro: on `/parts/fx-job-comparison?fixture=client-comparison`, click any table row (or Tab to it), then click a different chart point. Mousedown, focusin and mouseup reach the point, but Chrome dispatches no `click`, so the selection does not change. A second click works.
   - Rate: dropped in 2 of 3 runs after a row click and 1 of 1 after keyboard focus. A neutral click first, or no row focus, avoids it.
   - Likely cause, confirmed with a reverted scratch edit: `QuoteComparisonRow`'s `onBlur={() => onHover(null)}` changes `hoveredKey` between mousedown and mouseup. Recharts then re-keys and remounts the scatter symbols, so the click target is lost. With that handler made a no-op, the first click selected in 5 of 5 runs.
   - Spec handling: (b) and (f) exercise each direction from a state where no row has focus, and the comment in (b) names this defect. Because the failure is intermittent, there is no expected-failure marker.
2. **Expired offer and the word "live".** An expired offer that was quoted recently passes the 14-day trusted-adapter rule, which `PRD.md` line 224 keeps separate from commercial validity. So it appears in the comparison as a blocked row labelled "Needs review before selection", it is counted in "7 live offers shown in comparison", and its row keeps the vendor "Open" link.
   - The spec asserts that it is blocked: not in the Tab order, and row and chart clicks never select it. A chart click on it sits between two chart clicks that do select, so a dropped click cannot make this pass.
   - The literal unit text "(f) not shown as live" holds for the stale offer, which is never listed. It does not hold for the live-offer count. Owner decision: should commercially expired offers leave that count, and should their vendor link remain?
3. **The live-offer count ignores the sourcing scope.** "7 live offers shown in comparison" is shown while US-only lists 3 rows. Not asserted.
4. **Origin filter, as implemented.** US-only lists only explicitly domestic offers. The no-origin offer is hidden there, and in all sourcing it is labelled "Unknown" (table and chart tooltip), never "US".
5. **Links.** Vendor quote links (`Open from Xometry`, `Open vendor quote from Xometry`) are https, `target=_blank`, `rel="noopener noreferrer"`, and have a sign-in `title`. The panel shows the sign-in note, and the spec asserts it. The official "Open RFQ" links under "Additional sourcing paths" use `rel="noreferrer"` only. The HTML standard makes that imply noopener, but the literal `noopener` token is absent. The spec asserts the current attributes.
6. **(h) scope.** The decision panel header renders a "Review order" button that opens the legacy procurement handoff (`/parts/:id/review`). The unit's scope excludes that handoff, so the test drops exactly that accessible name and asserts nothing about the handoff. Every other control in the panel (any of button, link, menuitem, checkbox, radio, hidden ones included) must not name ordering, checkout, cart, payment or purchase. The test title says "apart from the excluded Q21 handoff" so it is not read as "no control mentions order". An owner may want to revisit the label.
7. **Chart accessibility.** Chart points expose no accessible selected state. Under the roles-and-text-only rule, the row-to-point direction of (b) has nothing to assert, so (b) asserts point-to-row and row-to-selection. The unit asks for both directions where both exist, so this direction remains untested.
8. **Focus check.** Tailwind 3's `outline-none` is a 2px transparent outline, so the suggested "outline-style is not none" check would pass with no visible indicator. The spec requires a non-transparent outline, or a shadow layer with blur or spread.
9. **Defect, added in review round 1, not fixed here: the selected-offer summary shows a missing lead time as "Pending".** `formatEstimatedDeliveryDays` returns `resolvedDeliveryDate ?? "Pending"` (`src/components/quotes/ClientQuoteDecisionPanel.tsx`), and the same panel uses "Pending" for a queued quote. After selecting "Custom Finish" in all sourcing, the "Ready to ship" fact reads "Pending", not a not-available label. The table ("Unavailable") and chart ("Not quoted") are correct and asserted in the first (e) test.
   - Spec handling: a separate test, "(e) KNOWN DEFECT (pinned)", selects the offer, asserts the row, vendor and total ("$295.00"), then asserts "Ready to ship" matches /Pending/ and does not match a not-available wording. It uses ordinary assertions, not `test.fail()`, so it also fails if an earlier step regresses. When the product is fixed, the last two assertions fail and must be flipped to the not-available label.
   - Status: owner-blocked. The unit forbids product changes, and which wording the summary should show is a product decision.

## Verification

Commands run (head `3539956f98c7c923ac004718ac94a0d0ca9d4be2` unless noted, Linux container, Node 22, Playwright 1.58.2; Chromium runs sandboxed as user `ubuntu` under `/tmp/ovd-e2e.lock`):

```bash
npx vitest run src/features/quotes/client-comparison-fixture.test.ts
PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test --grep @fixture e2e/quote-comparison.spec.ts
PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test --grep @fixture e2e/quote-comparison.spec.ts e2e/client-shell.spec.ts
npm run lint
npx tsc --noEmit -p tsconfig.app.json
```

Results at 3539956:

- New unit test: 5/5 passed.
- New spec: 11/11 passed (10 tests at 1440x900, 1 at 390x844).
- New spec plus `client-shell.spec.ts`: 22/22 passed.
- `npm run lint`: passed. `npx tsc --noEmit -p tsconfig.app.json`: passed.
- Environment note: the container's Playwright 1.58.2 expects Chromium build 1208 but only build 1194 (Chromium 141) is installed, so the local run used a private `PLAYWRIGHT_BROWSERS_PATH` of symlinks to build 1194. The hosted lane uses its own browser.

(h) mutation, at 3539956: I temporarily added `<button type="button">Place your order</button>` next to `{headerActions}` in `ClientQuoteDecisionPanel.tsx`. (h) failed: `expect(await orderCheckoutOrPaymentControls(panel)).toEqual([])` received `["button \"Place your order\""]`. The edit was reverted with `git checkout -- src/components/quotes/ClientQuoteDecisionPanel.tsx`; `git status` was clean afterwards. At 722fca9 the same button passed the old (h).

Earlier evidence, from head `722fca926eb56b012592d470a8a14b6c8162e5e3` (first commit; the changes since then touch only the spec, the unit test header, and comments, with no logic change in the fixture module):

```bash
PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test --grep @fixture e2e/quote-comparison.spec.ts --repeat-each=3
npm run e2e:fixture
npx vitest run src/features/quotes src/components/quotes/ClientQuoteDecisionPanel.test.tsx src/components/debug/FixturePanel.test.tsx
npm run verify
npm run build && npm run verify:worker
```

- New spec, `--repeat-each=3`: 30/30 passed.
- `npm run e2e:fixture`: 31 passed, 5 skipped (pre-existing `admin-operations.spec.ts` guard).
- vitest (quotes, decision panel, fixture panel): a reviewer reproduced 88 files, 738 tests passed at 722fca9 (an earlier count of 89 files, 740 tests did not reproduce).
- `npm run verify`, run as root: every step through `npm test` passed, except that `worker/src/recovery/browserRecovery.test.ts` cannot launch sandboxed Chromium as root. Run as the non-root `ubuntu` user, that file passes 26/26. `npm run build && npm run verify:worker` passed separately. So `npm run verify` did not pass end to end as root in this container. This was not rerun at the new head.
- Hosted CI at 722fca9: all 15 check runs success, including "Test fixture browser workflows" (36 tests, 31 passed, 5 skipped). Not yet available for 3539956.

Failure-first mutations (at 722fca9). Each was a scratch edit, reverted with `git checkout -- <file>`, and the full spec was rerun after it:
- **Missing origin mapped to domestic.** `resolveDomesticStatus` returns `domestic` for non-foreign values. (d) fails at `quoteRow(panel, "Partner Network")` toHaveCount(0): expected 0, received 1. (a), (f), (g) and (i) also fail because US-only grows to 4 rows. 5 failed, 5 passed.
- **Grouping disabled.** Each option is rendered as its own provider entry (`startsProviderGroup` always true, `providerGroupSize={1}`). (a) fails at the `^Xometry` provider entry count: expected 1, received 3. 1 failed, 9 passed.
- **Freshness window widened to 400 days.** `LIVE_OFFER_MAX_AGE_MS`. (f) fails at `getByText("Archived Economy")` toHaveCount(0): expected 0, received 1. 7 failed, 3 passed.
- **Positive control.** In (f), a fresh offer is selected from the chart and the row ("Current selection", "Recently collected") in every passing run.

Scratch merge (at 722fca9), on a detached HEAD that was never committed and was then aborted:
- `git merge --no-commit 1d71236b 189d486c 63356381`, the PR heads of #567, #569 and #570.
- #567 and #570 have a delete/modify conflict on `src/components/workspace/QuoteChart.tsx`; for the scratch merge only, it was resolved by deleting the file. This conflict is independent of this PR.
- After `npm ci`: `npm run typecheck` passed with #570's `strictNullChecks: true`. vitest (`client-comparison-fixture`, `client-workspace-fixtures`, `ClientQuoteDecisionPanel`) passed 40/40. The new spec plus `client-shell.spec.ts` passed 21/21. A reviewer's independent scratch merge passed typecheck and the new spec but saw `client-shell.spec.ts:89` fail with a dynamic-import error on `/search` (likely Vite re-optimisation after a lockfile change, unconfirmed). This is outside this diff and is not resolved.

- [ ] all listed verification passed (the local `npm run verify` and the hosted run at the final head are not complete; see above)
- [x] unrelated baseline failures are described below

Baseline failures or exceptions:
- `worker/src/recovery/browserRecovery.test.ts` fails under root, because this container's sandboxed Chromium refuses root. It is unrelated to this diff and passes as the non-root user.
- A standalone strict-null pass over this base reports 85 errors in other files; #570 fixes those.
- e2e specs are not type-checked by CI (pre-existing gap, outside this PR).

Not verified here:
- Hosted CI on the final head.
- Deno Edge Function tests (`npm run test:functions`): deno.land egress is blocked in this container, and this PR does not touch functions.
- `npm run verify` and the full `e2e:fixture` lane at the new head.
- Windows and other browsers.

## Review findings and coverage

- Final PR head SHA: `3539956f98c7c923ac004718ac94a0d0ca9d4be2`
- Sonar issue findings: at 722fca9 the quality gate passed with 0 new issues, 0 security hotspots and no annotations (SonarQube Cloud, pull request 585). Not yet analysed at 3539956; no readable finding exists on it.
- CodeRabbit: owner-blocked, no review has run on this PR. It skipped the draft PR ("Draft PR not reviewed"). The coordinator must request a review on the final head (or un-draft the PR). Not counted as clean.
- Codex and other reviewers: no completed review on the final head. A round-1 independent review at 722fca9 found two blocking findings, both fixed in this head: (h) vacuous for order buttons, and (e) not checking the selected-offer summary. Its remaining findings were non-blocking and are covered above. Not counted as clean.
- owner-blocked: the (e) selected-offer "Pending" wording (Finding 9), because it needs a product change and the unit forbids product changes.
- owner-blocked: the Fictiv offer versus the certified-provider set (Scope), because it needs an owner decision on the unit text.
- owner-blocked: whether commercially expired, recently collected offers count as "live" and keep their vendor link, and whether the count follows the sourcing scope (Findings 2, 3), because it needs an owner decision.
- owner-blocked: bot review on the final head, because no CodeRabbit or equivalent review has run.
- [ ] Inspected findings and threads on the final head. Review is pending, so this is not counted as clean.

## Tests

- Added `e2e/quote-comparison.spec.ts` (11 `@fixture` tests: (a)-(i) at 1440x900 with (e) split in two, plus one 390x844 touch test). Assertions use roles, text, ARIA state and link attributes only, never colour classes. The exceptions are those the unit names: the chart series structure for (c), computed focus style for (i), and `scrollWidth` for overflow.
- Added `src/features/quotes/client-comparison-fixture.test.ts` (5 tests): scenario registration, offer facts, the live set (excludes only the stale and Fictiv offers), stale fails only the 14-day window, the expired offer is the only non-selectable one, and US-only keeps exactly the 3 domestic variants.

## Migration notes

- [x] No migration impact

## Rollback / risk notes

- Risk: the new scenario appears in the dev-only fixture selector. Its timestamps are computed when the scenario is built, as `client-published` does, so they stay relative to the current time. The browser spec depends on the 14-day window, the expiry date and the selection behaviour; a product change to any of these will fail it, which is intended. The pinned (e) test is meant to fail when the Pending defect is fixed.
- The new builder ships in the production App chunk through the existing static import of the fixtures module, but it is unreachable at runtime (every consumer is build-mode gated) and holds synthetic data only. Splitting the module out is a follow-up for #567.
- Rollback: revert the commits. Only fixture data and tests change.

## Documentation

- [x] No doc updates needed

## Screenshots or videos (if UI)

No UI changes. Browser evidence is the Playwright runs listed above.

## Follow-up items

- [ ] Fix the dropped decision-map click while a table row has focus (Finding 1).
- [ ] Fix or decide the selected-offer "Ready to ship" wording for a missing lead time (Finding 9), then flip the pinned (e) test.
- [ ] Owner decision: whether commercially expired, recently collected offers count as "live" in the sourcing-paths summary, keep their vendor link, and whether the count follows the sourcing scope (Findings 2, 3).
- [ ] Owner decision: Fictiv in the unit text versus the current certified-provider set (Scope deviation).
- [ ] Give chart points an accessible selected state, then assert the row-to-point direction of (b) (Finding 7).
- [ ] Add a second certified provider to the fixture so the cross-provider grouping step is exercised.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GqaoSqia9BNetUBaGnMQSM
