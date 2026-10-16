# OVD-677 OSH Cut live readiness

Last updated: October 14, 2026

This workflow describes the OSH Cut production quote path. It mirrors the
Quickparts and Weerg paths in `docs/workflows/ovd674-quickparts-live-readiness.md`
and `docs/workflows/ovd675-weerg-live-readiness.md`, and was scaffolded with
`npm run fixture:onboard -- oshcut --stage=live` (OVD-687). The path is
implemented and disabled by default. Shipping the code does not authorize any
of the following:

- OSH Cut login
- session capture
- CAD upload
- quote creation
- live DOM capture or locator review against the real quoting app
- deployment
- admission
- rollout

Each of those remains a protected action under `AGENTS.md`. Promotion follows
the three stages in `docs/provider-integration.md` and the 1.0 beta policy in
`RUNBOOK.md`.

## What the code provides

| Layer | Behavior |
| --- | --- |
| Dispatch envelope | `oshcut-quote-envelope.v1` (`OSHCUT_DISPATCH_ENVELOPE` in `worker/src/adapters/oshcutDispatchAuthorization.ts`). It is **not** reviewed: it is absent from `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`, there is no review row or migration, and a test pins that absence. No real permit can name it, so production OSH Cut dispatch cannot run today. `test-fixtures/provider-dispatch-envelope/oshcut-v1.json` is a synthetic fixture for tests only. |
| Adapter production branch | `OshcutAdapter` (`worker/src/adapters/oshcut.ts`) first applies the static OSH Cut envelope: flat-sheet laser cutting, Aluminum 6061-T6, one CAD file in a listed format, no drawing, quantities 1 to 10,000. A package outside it ends as a finite `unsupported` or `manual_vendor_followup` result. An eligible production package is then checked with the shared `providerDispatchAuthorizationDenial`. It needs provider `oshcut`, the OSH Cut envelope revision, an unexpired permit, the exact quantity, and outbound files that are exactly the staged CAD. Any denial throws a terminal `unsupported` with `providerInteractionAttempted: false` before the production delegate runs. This holds in simulate mode too. Live evaluation keeps its existing local-only path and never yields a customer offer. |
| Abort signal (OVD-748) | After authorization and before the portal reads a session, the adapter calls `throwIfProviderAborted(input.signal, "before_navigation")`. A run whose permit expired or whose lease was lost stops with `ProviderAbortedError`, which is never retried and never feeds the block switch. Inside the portal, the kernel's kill-switch checkpoints are already abort-aware through `withProviderAbortSignal`. |
| Production portal definition | `buildOshcutProductionPortalDefinition()` in `worker/src/adapters/oshcutProductionPortal.ts`. The only host is `app.oshcut.com`, and every other request is aborted. The routes are `https://app.oshcut.com/login` and `https://app.oshcut.com/`, taken from the existing workflow catalog. The kernel re-checks the authorization, captures the CAD bytes into memory, and requires them to hash to the authorized SHA-256. After upload it fills the quantity and selects the reviewed material option (`aluminum-6061-t6`). A missing material control stops in `selector_drift` (`oshcut_material_control_missing`) rather than quote a portal-default material. Terminal states are finite: login required (including an in-page "session expired"), captcha, unavailable, manual review, configuration required, unexpected origin, selector drift, and unsupported. |
| Offers (USD) | Offers are read only through `OSHCUT_PRODUCTION_LOCATORS` (`oshcut-production-locators.v1`) with the shared `extractUsdOfferCards` reader (`worker/src/adapters/usdOfferCards.ts`, extracted unchanged from Quickparts). Each option needs an ID, a label, the exact requested quantity, unit and total prices that agree to within one cent, and an anchored `USD` currency field. One malformed or non-USD option withholds the whole batch. There is no currency conversion. |
| Registry | The production registry wraps the definition in `PortalQuoteWorkflowAdapter` behind `OshcutAdapter`. In live mode the registry is filtered to `WORKER_LIVE_ADAPTERS`, so a worker without `oshcut` has no OSH Cut adapter. |
| Worker readiness | `oshcut` is now listable in `WORKER_LIVE_ADAPTERS` (registry `liveAdapter: true`). When it is listed, readiness requires an OSH Cut storage state that the portal kernel itself can open, with cookies and origins limited to `app.oshcut.com`. |
| Deploy | The registry entry names `OSHCUT_STORAGE_STATE_SECRET_NAME` and the mount `/var/secrets/oshcut-storage-state/storage-state.json`; `provider:sync` generates the deploy wiring. Whenever `oshcut` is listed, the secret name is required, the mount is added, and the path joins `QUOTE_VENDOR_STORAGE_STATE_PATHS`. Every other deploy removes the OSH Cut mount. That extra `--remove-secrets` entry is the only change to existing deploys; contract tests pin the full Xometry-only and Xometry plus Fictiv argument lists. |
| Stable egress | `oshcut` is an optional adapter on the governed OVD-410 service (`egress: "stable_nat"`), in canonical order `fictiv`, `oshcut`, `quickparts`, `weerg` (16 allowed values). `STABLE_EGRESS_PROVIDER_HOSTS.oshcut` declares `app.oshcut.com`, and a test pins it to the production definition. |
| Customer UI | Not changed. OSH Cut is outside `PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS`. |

## Default-off switches

A new OSH Cut quote needs switches 1 to 5 on. Switch 2 cannot be turned on
without a reviewed code change.

1. **Admission policy.** `private.quote_provider_admission_policies` for
   `oshcut` stays `disabled` until a reviewed revision records `approved` with
   `generic_dispatch_enabled = true`.
2. **Reviewed envelope.** `oshcut-quote-envelope` must be added to
   `REVIEWED_PROVIDER_DISPATCH_ENVELOPES` and recorded in
   `private.provider_dispatch_envelope_reviews`. Neither exists.
3. **Rollout.** The shared `automatic_quote_collection` rollout control.
4. **Organization enablement.** The organization has OSH Cut enabled, and the
   part lists OSH Cut as applicable.
5. **Worker adapters.** The worker runs with `oshcut` in
   `WORKER_LIVE_ADAPTERS`, using an OSH Cut session secret. No deploy does
   this today.

Turning off any of switches 1 to 5 stops queued tasks before the browser
launches. Revoke a specific permit with `private.revoke_provider_dispatch_permit`.

## Known gaps before admission

- **Locators are a reviewed contract, not an observation.** The browser
  fixture in `worker/src/adapters/oshcutProductionPortal.browser.test.ts` pins
  `OSHCUT_PRODUCTION_LOCATORS`, the upload input, the quantity input, and the
  material control against synthetic pages. Nobody has captured the
  authenticated OSH Cut quoting app, because that is a protected action. A real
  session therefore most likely ends in `selector_drift`. That is safe, but it
  yields no offers.
- **Thickness and units.** The envelope leaves stock thickness to the
  provider. OSH Cut asks for units, and for 2D files a thickness, after upload.
  The definition configures only the material, so a 2D file most likely stops
  in `configuration_required` or `selector_drift`. A reviewed thickness rule
  needs its own envelope revision.
- **Hosts and cookies.** The quoting app may load assets or APIs from other
  hosts (`www.oshcut.com`, a CDN, analytics). Each such request stops the
  attempt in `unexpected_origin` before upload. A session whose cookies are set
  for `.oshcut.com` or `www.oshcut.com` is refused at readiness. Any extra host
  needs review and an update to both the definition and
  `STABLE_EGRESS_PROVIDER_HOSTS`.
- **Pricing latency.** After upload and configuration, the kernel waits for up
  to one browser timeout plus 2.5 seconds. Slower pricing ends in
  `selector_drift`.
- **Envelope review.** Adding the envelope to `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`
  turns on the `provider:check` gate for this provider and requires the
  review-only SQL from `npm run fixture:onboard -- oshcut --stage=admit`.

## Inputs only Blaine can provide

1. **Account and session.** An OSH Cut account approved for automated
   quote-only use, and a Playwright storage state captured with
   `npm --prefix worker run auth:vendor -- oshcut`. Store it in Secret Manager
   under a name that becomes `OSHCUT_STORAGE_STATE_SECRET_NAME`, readable by the
   worker runtime service account.
2. **Permission basis.** Written OSH Cut authorization, a determination that
   its terms allow automation, or `owner_approved` (OVD-641). See the
   permissions matrix below.
3. **Live DOM review.** One authorized capture of the quoting app. It confirms
   or revises the routes, the allowed hosts, `OSHCUT_PRODUCTION_LOCATORS`, the
   material option value, and the thickness and units controls.
4. **Egress decision.** Choose one of:
   - **Shared egress.** OSH Cut shares the OVD-410 address on
     `overdrafter-cad-worker`. The registry is set up for this.
   - **Separate service.** A separate OSH Cut service and egress, which would
     flip the registry entry back to `egress: "none"`.
5. **Envelope review, admission values and certification run.** Approve
   `oshcut-quote-envelope.v1`, then record admission with
   `accepted_file_extensions` limited to the reviewed formats and no drawing.

## Admission revision template (not applied)

```sql
update private.quote_provider_admission_policies
set admission_state = 'approved',
    generic_dispatch_enabled = true,
    policy_revision = 'oshcut-generic-<yyyy-mm-dd>.v1',
    evidence_reference = 'OVD-<n>',
    permission_basis = '<written_provider_authorization|provider_terms_allow_automation|owner_approved>',
    supported_processes = array['laser_cutting']::public.process_types[],
    accepted_file_extensions = array['<reviewed extensions>'],
    session_owner = 'overdrafter_managed',
    reviewed_by = '<reviewer user uuid>',
    reviewed_at = pg_catalog.now(),
    expires_at = null,
    change_reason = 'approval_recorded'
where provider = 'oshcut'::public.vendor_name;
```

Rollback: record a new revision with `admission_state = 'disabled'`,
`generic_dispatch_enabled = false`, and `change_reason = 'policy_disabled'`.
Then revoke any issued permits. Redeploying without `oshcut` removes the
session mount.

## Permissions matrix (OVD-724)

OSH Cut paid automated quoting is not matrix-cleared. The row is
`draft_outreach_prepared` with `tos_stance: silent`. See
[`docs/providers/permissions-matrix.md`](../providers/permissions-matrix.md#oshcut)
and [`docs/providers/acceptance-tables.md`](../providers/acceptance-tables.md).
A cease-and-desist uses the OVD-722 kill switch as step one
([playbook](../runbooks/provider-cease-and-desist.md)).

## Authenticated capture (2026-10-15)

One read-only capture of the authenticated quote app (account session stored as
`oshcut-storage-state` in Secret Manager, project `overdrafter-worker-9133`).
A 50 x 30 mm DXF test plate was uploaded to the cart; no material was committed,
no checkout was opened and no order was placed.

Routes
- `https://app.oshcut.com/login` redirects to `/` → `/cart`; sign-in is a modal
  (`#email-input` name=username, `#password-input` name=password), no CAPTCHA, no 2FA.
- Upload lands on `/cart/O-<uuid>`; each part has `/cart/O-<uuid>/P-<uuid>`.
- All hosts observed: `app.oshcut.com` only.

Selector findings (the v1 locator table does NOT match the live DOM)
- `cadUpload` `input[type='file']`: matches (hidden input, `accept` lists dxf/svg/ai/step/...).
- `quantity`: no `name`/`aria-label`; live control is `.cartQuantity input.input` (type=text).
- Material: there is no `<select name=material>`. "Select material" (`.cartInformationArea span.error.link`)
  opens a slideover (`.Slideover`, `h1` "Select Material - <file>") with category tiles and
  filter checkboxes (`.filterItem` labels). The option label is **"6061 T6 Aluminum"**;
  there is no `aluminum-6061-t6` option value. Thickness is a separate filter (e.g. `0.125"`).
- Price: no `data-oshcut-quote-option-*` attributes exist. Per-part prices render in
  `.cartSinglePrice` / `.cartExtendedPrice` (both `-` until material and thickness are set).
  Only `data-testid="button"`/`"content"` test ids are present (checkout button).
- Text signals: "All parts need selected material and units to checkout",
  "Design check: Passed".

Consequence: the `configure` hook and `OSHCUT_PRODUCTION_LOCATORS` need a new revision
(material slideover + thickness pick, cart-row price cells) before certification; with the
current table every live attempt ends in `selector_drift`, never an inferred price.

## Test-part cleanup rule (Blaine)

Every live capture and certification run must remove the test parts it uploaded
to the OSH Cut cart once the capture is done, and confirm the cart is empty
again. Remove only the run's own parts and touch nothing else in the account.
The 2026-10-15 capture's test plate was removed from `/cart/O-97bd2644-a03a-4232-a714`
and the cart was confirmed empty.
