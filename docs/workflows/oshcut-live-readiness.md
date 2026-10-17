# OVD-677 OSH Cut live readiness

Last updated: October 15, 2026

This workflow describes the OSH Cut production quote path. It mirrors the
Quickparts and Weerg paths in `docs/workflows/ovd674-quickparts-live-readiness.md`
and `docs/workflows/ovd675-weerg-live-readiness.md`, and was scaffolded with
`npm run fixture:onboard -- oshcut --stage=live` (OVD-687).

**State (2026-10-15).** Blaine approved the OSH Cut go-live. The envelope
`oshcut-quote-envelope.v1` is reviewed in code, the review-row migration is
written, the permission basis is `owner_approved` and egress is the shared
OVD-410 stable NAT. The adapter was rewritten against the authenticated
capture below. The path stays **default-off**: the following are still
protected actions under `AGENTS.md`, each needing Blaine's exact OK, and none
is done by this branch:

- merging the PR and applying the review-row migration to production
- recording the approved admission revision (template below)
- deploying a worker with `oshcut` in `WORKER_LIVE_ADAPTERS` (no deploy
  default or env file lists it)
- the stage 3 certification run against the live quoting app

Promotion follows the three stages in `docs/provider-integration.md` and the
1.0 beta policy in `RUNBOOK.md`.

## What the code provides

| Layer | Behavior |
| --- | --- |
| Dispatch envelope | `oshcut-quote-envelope.v1` (`OSHCUT_DISPATCH_ENVELOPE` in `worker/src/providerDispatchEnvelope.ts`, re-exported from `oshcutDispatchAuthorization.ts`) is listed in `REVIEWED_PROVIDER_DISPATCH_ENVELOPES` with `requiredAdmission: "generic_dispatch"`. The review row is a **draft pending Blaine window**: `docs/migration-drafts/20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql` records it with a 7,200-second permit TTL; it admits nothing and leaves the OSH Cut admission `disabled`. It is not in `supabase/migrations`, not in the free-quote CI manifest, and its pgTAP checks wait in `supabase/tests/pending/ovd677_oshcut_reviewed_envelope.sql.pending`. Until it is applied, no OSH Cut permit can be minted, so dispatch fails closed. Review-only admit files are in `provider-integrations/oshcut/admit/`. |
| Adapter production branch | `OshcutAdapter` (`worker/src/adapters/oshcut.ts`) first applies the static OSH Cut envelope: flat-sheet laser cutting, Aluminum 6061-T6, one CAD file in a listed format, no drawing, quantities 1 to 10,000. A package outside it ends as a finite `unsupported` or `manual_vendor_followup` result. An eligible production package is then checked with the shared `providerDispatchAuthorizationDenial` (provider, envelope, unexpired permit, exact quantity, exact staged CAD bytes); a denial throws a terminal `unsupported` with `providerInteractionAttempted: false`. |
| Thickness rule | The envelope leaves stock thickness to the provider, but the cart prices nothing until one is picked. The approved requirement must state `spec_snapshot.sheetThicknessInch` (`OSHCUT_SHEET_THICKNESS_RULE`): a number of inches from 0.020 to 1.000 with at most three decimals, rendered as the filter label (`0.125"`). If it is missing or invalid, the adapter returns `manual_vendor_followup` with `terminalState: "configuration_required"` (`thickness_confirmation_required`) **before** any session read or upload. |
| Abort signal (OVD-748) | After authorization and the thickness rule, `throwIfProviderAborted(input.signal, "before_navigation")`. |
| Production portal definition | `buildOshcutProductionPortalDefinition()` in `worker/src/adapters/oshcutProductionPortal.ts` (`oshcut-production-adapter.v2`). The only host is `app.oshcut.com`. Every route is `https://app.oshcut.com/cart`, because `/login` only redirects there. After upload the app moves to `/cart/O-<uuid>` and `/cart/O-<uuid>/P-<uuid>` on the same host, and both are accepted. A logged-out session is detected by the header `Sign In` control (or "session expired") and ends in `login_required` before upload. |
| Configuration | The kernel waits (bounded) for `.cartQuantity input.input` and fills the quantity. The hook then clicks the "Select material" link, checks the `.Slideover .filterItem` labelled `6061 T6 Aluminum`, and checks the thickness filter whose text is exactly the reviewed label. A missing link, material or thickness filter stops in `selector_drift` (`oshcut_material_control_missing`, `oshcut_material_option_missing`, `oshcut_thickness_option_missing`) rather than quote a portal default. The kernel refuses configuration selectors that mention `cart`, so the link is anchored on its text (`span.error.link:text-is('Select material')`). The kernel's new declared `click` operation matches exact element text and refuses checkout, order, purchase, payment or cart text. |
| Offers (USD) | `OSHCUT_PRODUCTION_LOCATORS` (`oshcut-production-locators.v2`) reads the single cart row's `.cartSinglePrice` and `.cartExtendedPrice`. `-` means "not priced yet": the read repeats within 30 s and then stops in `selector_drift` (`oshcut_price_pending`); `-` is never parsed. Amounts must be `$`-denominated (optional `USD` suffix only), and single × quantity must equal extended within one cent. More than one priced row, or anything malformed, withholds the offer. There is no currency conversion. |
| Cart cleanup (standing rule) | Once the price is read, or after any failure that followed upload, the kernel runs the definition's cleanup hook: it deletes every cart row that shows the staged file name through a remove/delete/trash control in the row, then confirms an in-page or native dialog. The cleanup is bounded at 30 s and skipped while the kill switch is engaged. It never throws and never changes the result or error; a `providerPortalCleanup` log line and a `cartCleanup` report (`removed`, `not_found`, `incomplete`, `failed`, `skipped_kill_switch`) record it. The same cleanup runs on the live-harness evaluation definition (`buildOshcutEvaluationDefinition`). |
| Live harness | `vendorWorkflowSmoke` (`npm --prefix worker run …` capture/certification runs) adds a `supplierCartCleanup` record per run and logs `liveHarnessSupplierCleanup`. Any run that reached upload without a confirmed removal, including through an adapter that declares no cleanup (`not_declared`), is flagged `SUPPLIER CART CLEANUP NEEDED` for manual removal. |
| Registry | The production registry wraps the definition in `PortalQuoteWorkflowAdapter` behind `OshcutAdapter`. In live mode the registry is filtered to `WORKER_LIVE_ADAPTERS`, so a worker without `oshcut` has no OSH Cut adapter. |
| Worker readiness and deploy | `oshcut` is listable in `WORKER_LIVE_ADAPTERS` (registry `liveAdapter: true`). When it is listed, readiness requires an OSH Cut storage state limited to `app.oshcut.com`, mounted from `OSHCUT_STORAGE_STATE_SECRET_NAME` at `/var/secrets/oshcut-storage-state/storage-state.json`. The captured session is stored in Secret Manager as `oshcut-storage-state` (project `overdrafter-worker-9133`). |
| Stable egress | Shared: `oshcut` is an optional adapter on the governed OVD-410 service (`egress: "stable_nat"`), and `STABLE_EGRESS_PROVIDER_HOSTS.oshcut` declares `app.oshcut.com`. |
| Customer UI | Not changed. OSH Cut is outside `PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS`. |

## Default-off switches

A new OSH Cut quote needs switches 1 to 5 on.

1. **Admission policy.** `private.quote_provider_admission_policies` for
   `oshcut` stays `disabled` until the reviewed revision in
   `provider-integrations/oshcut/admit/oshcut_admission_revision.sql.review`
   is recorded (`approved`, `generic_dispatch_enabled = true`).
2. **Reviewed envelope.** Done in code; the review row is a draft pending
   Blaine window (`docs/migration-drafts/20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql`).
   It exists only after Blaine approves a window and the draft is promoted
   into `supabase/migrations` and applied. Until then permits are refused.
3. **Rollout.** The shared `automatic_quote_collection` rollout control.
4. **Organization enablement.** The organization has OSH Cut enabled, and the
   part lists OSH Cut as applicable.
5. **Worker adapters.** The worker runs with `oshcut` in
   `WORKER_LIVE_ADAPTERS` and `OSHCUT_STORAGE_STATE_SECRET_NAME=oshcut-storage-state`.
   No deploy does this today.

Turning off any of switches 1 to 5 stops queued tasks before the browser
launches. Revoke a specific permit with `private.revoke_provider_dispatch_permit`.

## Known gaps before admission

- **Material commit step is unobserved.** The capture opened the slideover but
  committed no material. The hook checks the material and thickness filters.
  If the app needs a further click to commit the stock, the cart keeps showing
  `-` and the attempt stops in `selector_drift` (`oshcut_price_pending`) or
  `configuration_required`. That is safe, but it yields no offer. The first
  certification run confirms the step.
- **Cleanup selectors are a guess.** The capture did not open the delete
  control. A miss is reported as `not_found` or `incomplete` and flagged for
  manual removal; it never changes the quote.
- **Stale cart parts.** A cart row that still says "Select material" before
  upload ends the attempt in `configuration_required`. More than one priced
  row withholds the offer.
- **Thickness data.** Requirements need `spec_snapshot.sheetThicknessInch`.
  No intake flow writes it yet, so every package without it ends in
  `thickness_confirmation_required` before upload.
- **Pricing latency.** The price wait is bounded at 30 s after configuration.

## Inputs only Blaine can provide

1. **Merge and migration window.** Approve the PR, then a migration window
   that promotes the draft
   `docs/migration-drafts/20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql`
   into `supabase/migrations` (with the free-quote CI manifest entry and the
   pending pgTAP file renamed into `supabase/tests`) and applies it, as
   separate actions.
2. **Admission revision.** Approve recording
   `oshcut_admission_revision.sql.review` with a reviewer UUID and policy date.
3. **Deploy.** Approve a worker deploy that lists `oshcut` and names the
   `oshcut-storage-state` secret.
4. **Certification run.** Approve one exact-file certification quote. The
   uploaded test part is removed from the cart afterwards (standing rule).

## Admission revision template (not applied)

The reviewed values live in
`provider-integrations/oshcut/admit/oshcut_admission_revision.sql.review`:

```sql
update private.quote_provider_admission_policies
set admission_state = 'approved',
    generic_dispatch_enabled = true,
    policy_revision = 'oshcut-generic-<yyyy-mm-dd>.v1',
    evidence_reference = 'OVD-677',
    permission_basis = 'owner_approved',
    supported_processes = array['laser_cutting']::public.process_types[],
    accepted_file_extensions = array['3dm', 'ai', 'catpart', 'dxf', 'iges', 'igs', 'ipt', 'jt', 'par', 'sab', 'sat', 'sldprt', 'step', 'svg', 'x_t'],
    session_owner = 'overdrafter_managed',
    reviewed_by = '<reviewer user uuid>',
    reviewed_at = pg_catalog.now(),
    expires_at = null,
    change_reason = 'approval_recorded'
where provider = 'oshcut'::public.vendor_name;
```

Rollback: record a new revision with `admission_state = 'disabled'`,
`generic_dispatch_enabled = false`, and `change_reason = 'policy_disabled'`.
Then revoke any issued permits and withdraw the envelope review row
(`withdrawn_at`). Redeploying without `oshcut` removes the session mount.

## Permissions matrix (OVD-724)

The matrix row stays `draft_outreach_prepared` with `tos_stance: silent`. Its
notes record the `owner_approved` admission basis (OVD-641, 2026-10-15) and
the shared egress. Owner approval is not a matrix clearance, so the derived
`enabled_for_paid_automation` stays false. See
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

Consequence (resolved on this branch): `oshcut-production-locators.v2` and the rewritten
`configure` hook implement the slideover, thickness pick and cart-row price cells; see
"What the code provides" above.

## Test-part cleanup rule (Blaine)

Every live capture and certification run must remove the test parts it uploaded
to the OSH Cut cart once the capture is done, and confirm the cart is empty
again. Remove only the run's own parts and touch nothing else in the account.
The 2026-10-15 capture's test plate was removed from `/cart/O-97bd2644-a03a-4232-a714`
and the cart was confirmed empty.
