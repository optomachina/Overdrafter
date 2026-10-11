# OVD-675 Weerg live readiness

Last updated: October 11, 2026

This workflow describes the Weerg production quote path. It mirrors the
Quickparts path in `docs/workflows/ovd674-quickparts-live-readiness.md`. The
path is implemented and disabled by default. Shipping the code does not
authorize any of the following:

- Weerg login
- session capture
- CAD upload
- quote creation
- live DOM capture or locator review against the real portal
- deployment
- admission
- rollout

Each of those remains a protected action under `AGENTS.md`. Promotion still
follows the three stages in `docs/provider-integration.md`, and the 1.0 beta
policy in `RUNBOOK.md`. The local evaluation definition in
`provider-integrations/weerg/offline-evaluation.md` is unchanged.

## What the code provides

| Layer | Behavior |
| --- | --- |
| Reviewed envelope | `weerg-quote-envelope.v1` is reviewed in code (`worker/src/providerDispatchEnvelope.ts`). It covers one STEP file (`step`/`stp`), no drawing, aluminium 6082 and quantities 1–10,000 (the public catalog envelope). Migration `20261011200000_ovd675_weerg_reviewed_dispatch_envelope.sql` records it with a 7,200-second permit TTL. The row admits nothing on its own. |
| Permit and preflight | The generic OVD-458/459 path is unchanged. A Weerg permit is issued only when all of these hold: an approved, generically dispatchable admission policy; an active reviewed envelope; rollout; entitlement; organization enablement; and exact scope. |
| Worker routing | In live mode, a Weerg task that carries a generic permit goes through `api_authorize_provider_worker_dispatch`. A Weerg task without a permit is refused before any browser launches (`dispatch_live_provider_not_permitted`). |
| Production portal definition | `buildWeergProductionPortalDefinition()` in `worker/src/adapters/weergPortal.ts`. The only host is `www.weerg.com`, and every other request is aborted. After upload, the kernel fills the quantity and selects the reviewed material option (`aluminium-6082`). If the material control is missing, the attempt stops in `selector_drift` (`weerg_material_control_missing`) rather than quote a portal-default material. Offers are read only through `WEERG_PRODUCTION_LOCATORS` (`weerg-production-locators.v1`). Terminal states are finite: login required (including "session expired"), captcha, unavailable, manual review, configuration required, unexpected origin, selector drift, and unsupported. |
| Currency (EUR) | Each option needs an option ID, a label, the exact requested quantity, unit and total amounts that agree to within one cent, and an explicit ISO currency field (`EUR` or `USD`). A bare `€` or `$` is not a currency anchor. Amounts accept `.` or `,` as the decimal separator only when that is unambiguous (two decimal digits; thousands groups use the other separator). Any symbol or code inside an amount must agree with the anchored currency. One malformed option, or options in different currencies, withholds the whole batch. There is no reviewed exchange-rate source, so **nothing is converted**. `productionNativeOfferDisposition` (`worker/src/adapters/productionNativeOffers.ts`) decides the result. |
| EUR result | An EUR batch produces `manual_vendor_followup` with `unitPriceUsd`, `totalPriceUsd` and `leadTimeBusinessDays` null and `offers: []`. `rawPayload.reason` is `native_currency_not_comparable`. `rawPayload.nativeCurrencyQuote` holds `{ comparable: false, currency: "EUR", currencyConversion: "none", offers }`, with the native amounts and their selector provenance. A note states that the quote was in EUR and was not converted. The quote is never comparable with USD offers and never reaches a USD field. |
| USD result | Only when Weerg itself anchors `USD` on every option does the batch become ordinary `instant_quote_received` USD offers. Values are unchanged, and each offer's `rawPayload` records `anchoredCurrency: "USD"` and `currencyConversion: "none"`. |
| Adapter binding | The production branch of `PortalQuoteWorkflowAdapter` exists only for a definition that declares `productionDispatch` (Quickparts and Weerg). Before the kernel reads a session or launches a browser, it re-checks the authorization through the shared `providerDispatchAuthorizationDenial`. The check requires all of: provider `weerg`; the reviewed envelope revision; an unexpired permit; the exact quantity; and outbound files that are exactly the staged CAD. It then captures the CAD bytes into memory and requires them to hash to the authorized SHA-256. The kernel refuses any drawing and any CAD type other than STEP. If any check fails, the result is a terminal `unsupported` with `providerInteractionAttempted: false`. Material or quantity outside the envelope also ends as `unsupported` before any session read. |
| Registry | The production registry builds the Weerg production definition. In live mode the registry is filtered to `WORKER_LIVE_ADAPTERS`, so a worker without `weerg` has no Weerg adapter. In simulate mode the adapter returns manual follow-up and never touches the provider. |
| Worker readiness | Live readiness accepts only `xometry`, `fictiv`, `quickparts`, and/or `weerg` in `WORKER_LIVE_ADAPTERS`. When `weerg` is listed, readiness requires a Weerg storage state that the portal kernel itself can open. It uses the kernel's own resolver: regular file, no symlinked path component, and cookies and origins limited to `www.weerg.com`. Quickparts and Weerg share one generic readiness check. |
| Deploy | In live mode, `worker/scripts/deploy-cloud-run.sh` accepts `xometry`, `fictiv`, `quickparts`, and/or `weerg`, each at most once and with no empty fields. Whenever `weerg` is listed, `WEERG_STORAGE_STATE_SECRET_NAME` is required. That secret is mounted at the fixed path `/var/secrets/weerg-storage-state/storage-state.json`, and that path is added to `QUOTE_VENDOR_STORAGE_STATE_PATHS`. Quickparts and Weerg sessions share one JSON map, for example `{"quickparts":"…","weerg":"…"}`. Every other deploy removes the Weerg mount. Apart from the extra `--remove-secrets` entry, the Xometry-only deploy command is unchanged; a contract test pins its full argument list. A Quickparts-only deploy is byte-identical to OVD-674. |
| Stable egress | The governed OVD-410 service may carry `xometry` followed by any canonical-order subset of `fictiv`, `quickparts`, `weerg` (`STABLE_EGRESS_OPTIONAL_ADAPTERS` and `STABLE_EGRESS_LIVE_ADAPTER_VALUES`, eight values). The deploy script derives the same canonical value from the adapters it enabled. `STABLE_EGRESS_PROVIDER_HOSTS.weerg` declares `www.weerg.com`, and a test pins it to both Weerg definitions. |
| Customer UI | Not changed. `VITE_LIVE_DISPATCH_PROVIDER` still accepts only `xometry` or `fictiv`. Weerg is also outside `PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS`. |

## Default-off switches

A new Weerg quote needs switches 1–5 on.

1. **Admission policy.** `private.quote_provider_admission_policies` for
   `weerg` is `disabled` until a reviewed revision records `approved` with
   `generic_dispatch_enabled = true`.
2. **Reviewed envelope.** An active `weerg-quote-envelope.v1` row in
   `private.provider_dispatch_envelope_reviews`. Withdraw it with
   `withdrawn_at`.
3. **Rollout.** The `automatic_quote_collection` rollout control. This switch
   is shared with Xometry, Fictiv and Quickparts.
4. **Organization enablement.** The organization has Weerg enabled in its
   vendor configuration, and the part lists Weerg as applicable.
5. **Worker adapters.** The worker runs with `weerg` in
   `WORKER_LIVE_ADAPTERS`, using a Weerg session secret.

Turning off any of switches 1–5 stops queued tasks before the browser
launches. To refuse a specific permit regardless of the switches, revoke it
with `private.revoke_provider_dispatch_permit`.

## Known gaps before admission

- **EUR quotes are evidence, not offers.** Until someone reviews a rate
  source, a Weerg account priced in EUR yields `manual_vendor_followup` with
  the native quote in `rawPayload`. Customers see no Weerg price. Comparable
  Weerg offers need one of two things: an account that Weerg prices in USD, or
  a separately reviewed EUR→USD normalization. That normalization would need
  its own rate source, as-of time, staleness bound, rounding rule and
  disclosure. It would also need a new revision of
  `productionNativeOfferDisposition`.
- **Locators are a reviewed contract, not an observation.** The fixture tests
  in `worker/src/adapters/weergProductionPortal.browser.test.ts` pin
  `WEERG_PRODUCTION_LOCATORS`, the upload input, the quantity input and the
  material control against synthetic pages. Nobody has captured the
  authenticated Weerg quotation tool, because that is a protected action. A
  real session therefore most likely ends in `selector_drift`. That is safe,
  but it yields no offers.
- **Routes.** The upload route
  `https://www.weerg.com/en/global/quotation-tool/upload` comes from the
  existing workflow catalog. It has not been observed. The OVD-432 v3
  route-recovery evidence remains on its separate branch and has not been
  incorporated.
- **Third-party assets.** The kernel aborts every request outside
  `www.weerg.com` and stops with `unexpected_origin`. If the quotation tool
  loads scripts, fonts or APIs from another host (CDN, analytics, `weerg.com`
  without `www`), every attempt stops there, before upload. Any extra host
  needs review, plus an update to both the definition and
  `STABLE_EGRESS_PROVIDER_HOSTS`.
- **Pricing latency.** After upload and configuration, the kernel waits for
  up to one browser timeout plus 2.5 seconds before it reads offers. If
  pricing takes longer, the attempt ends in `selector_drift`.
- **Secret volume shape.** The concern is the same as for Quickparts. The
  first deploy shows whether the Cloud Run secret mount is presented as a
  regular file.

## Inputs only Blaine can provide

1. **Weerg account and session.** A Weerg account approved for automated
   quote-only use. A Playwright storage state captured with
   `npm --prefix worker run auth:vendor -- weerg`, stored in Secret Manager
   under a name that becomes `WEERG_STORAGE_STATE_SECRET_NAME`. The worker
   runtime service account must be able to read it.
2. **Permission basis.** Written Weerg authorization, a determination that
   Weerg's terms allow automation, or `owner_approved` (OVD-641).
3. **Currency decision.** Choose one of:
   - **Native evidence only.** EUR quotes stay native evidence. This is the
     default in this PR.
   - **USD account.** Use an account that Weerg prices in USD.
   - **Reviewed normalization.** Commission a reviewed EUR→USD normalization
     as a follow-up issue.
4. **Live DOM review.** One authorized capture of the quotation tool, which
   confirms or revises the routes, `WEERG_PRODUCTION_LOCATORS`, the material
   option value and the allowed hosts.
5. **Egress decision.** Choose one of:
   - **Shared egress.** Weerg shares the OVD-410 address on
     `overdrafter-cad-worker`.
   - **Separate service.** A separate Weerg service and egress.
6. **Admission values and certification run**, as in the Fictiv workflow,
   with `accepted_file_extensions` limited to `step`/`stp` and no drawing.

## Admission revision template (not applied)

```sql
update private.quote_provider_admission_policies
set admission_state = 'approved',
    generic_dispatch_enabled = true,
    policy_revision = 'weerg-generic-<yyyy-mm-dd>.v1',
    evidence_reference = 'OVD-<n>',
    permission_basis = '<written_provider_authorization|provider_terms_allow_automation|owner_approved>',
    supported_processes = array['cnc_milling']::public.process_types[],
    accepted_file_extensions = array['step', 'stp'],
    session_owner = 'overdrafter_managed',
    reviewed_by = '<reviewer user uuid>',
    reviewed_at = pg_catalog.now(),
    expires_at = null,
    change_reason = 'approval_recorded'
where provider = 'weerg'::public.vendor_name;
```

Rollback: record a new revision with `admission_state = 'disabled'`,
`generic_dispatch_enabled = false`, and `change_reason = 'policy_disabled'`.
Then revoke any issued permits. Redeploying without `weerg` removes the
session mount.
