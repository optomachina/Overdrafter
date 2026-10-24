# OVD-677 OSH Cut live readiness

Last updated: October 20, 2026

This workflow describes the OSH Cut production quote path. It mirrors the
Quickparts and Weerg paths in `docs/workflows/ovd674-quickparts-live-readiness.md`
and `docs/workflows/ovd675-weerg-live-readiness.md`, and was scaffolded with
`npm run fixture:onboard -- oshcut --stage=live` (OVD-687).

**State (2026-10-20): portal automation is HARD-DISABLED pending OVD-1022.**
OSH Cut remains default-off and outside the 1.0 portfolio (Xometry, Fictiv,
Quickparts, RMFG). Production, live evaluation, the live harness, session
bootstrap, upload, configuration, and cleanup refuse with:

> OSH Cut portal automation is disabled until row-bound cart configuration exists (OVD-1022)

The refusal runs before browser launch or page interaction. `OshcutAdapter.quote`,
`PortalQuoteWorkflowAdapter` (quote and local evaluation), and direct
`runProviderPortalKernel` calls all refuse OSH Cut. The harness rejects an OSH Cut
batch before configuration, secrets preparation, or staging; its single-quote
entry point also refuses. `bootstrapVendor` refuses before session setup.
Both definitions' upload/configuration/cleanup hooks refuse before accessing
page capabilities, including direct calls to `configureOshcutCart` and
`cleanupOshcutCart`. No environment variable, feature flag, config, approval,
or dispatch permit can bypass the stop in this PR.

The empty-cart guard cannot establish ownership of rows that render later;
page-wide quantity/material selectors can mutate a pre-existing row. Row-bound
configuration needs the OVD-1022 design and a separate reviewed source change
before any automation can resume. The adapter implementation remains dormant
scaffolding. Parser, selector, eligibility, and pure cleanup-report tests run
in isolation; OSH Cut browser suites now assert refusal without opening a page.

The registry still has `liveAdapter: false`, `sessionSecrets: []`, and
`egress: "none"`; the envelope remains absent from
`REVIEWED_PROVIDER_DISPATCH_ENVELOPES`. Production deployment rejects `oshcut`,
and no generated deploy binding names its session secret.

The SQL below and under `provider-integrations/oshcut/admit/` is retained as
future review material only. No migration or admission is promoted by this
branch. Future enablement needs a separate reviewed source change with the
Provider go-live checklist, plus exact authorization for production database,
credential, deploy, and provider operations. Adapter merge is not go-live.

## Retained scaffolding (unreachable while hard-disabled)

The following describes the dormant implementation, not an enabled execution
path. The unconditional OVD-1022 refusal above takes precedence over every
eligibility, authorization, thickness, abort, and cleanup branch below.

| Layer | Behavior |
| --- | --- |
| Dispatch envelope | `oshcut-quote-envelope.v1` (`OSHCUT_DISPATCH_ENVELOPE` in `worker/src/providerDispatchEnvelope.ts`, re-exported from `oshcutDispatchAuthorization.ts`) is deliberately absent from `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`. The review row is a **deferred draft, not approved for promotion**: `docs/migration-drafts/20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql` records it with a 7,200-second permit TTL; it admits nothing and leaves the OSH Cut admission `disabled`. It is not in `supabase/migrations`, not in the free-quote CI manifest, and its pgTAP checks wait in `supabase/tests/pending/ovd677_oshcut_reviewed_envelope.sql.pending`. Until it is applied, no OSH Cut permit can be minted, so dispatch fails closed. Review-only admit files are in `provider-integrations/oshcut/admit/`. |
| Adapter production branch | `OshcutAdapter` (`worker/src/adapters/oshcut.ts`) first applies the static OSH Cut envelope: flat-sheet laser cutting, Aluminum 6061-T6, one CAD file in a listed format, no drawing, quantities 1 to 10,000. A package outside it ends as a finite `unsupported` or `manual_vendor_followup` result. An eligible production package is then checked with the shared `providerDispatchAuthorizationDenial` (provider, envelope, unexpired permit, exact quantity, exact staged CAD bytes); a denial throws a terminal `unsupported` with `providerInteractionAttempted: false`. |
| Thickness rule | The envelope leaves stock thickness to the provider, but the cart prices nothing until one is picked. The approved requirement must state `spec_snapshot.sheetThicknessInch` (`OSHCUT_SHEET_THICKNESS_RULE`): a number of inches from 0.020 to 1.000 with at most three decimals, rendered as the filter label (`0.125"`). If it is missing or invalid, the adapter returns `manual_vendor_followup` with `terminalState: "configuration_required"` (`thickness_confirmation_required`) **before** any session read or upload. |
| Abort signal (OVD-748) | After authorization and the thickness rule, `throwIfProviderAborted(input.signal, "before_navigation")`. |
| Production portal definition | `buildOshcutProductionPortalDefinition()` in `worker/src/adapters/oshcutProductionPortal.ts` (`oshcut-production-adapter.v2`). The only host is `app.oshcut.com`. Every route is `https://app.oshcut.com/cart`, because `/login` only redirects there. After upload the app moves to `/cart/O-<uuid>` and `/cart/O-<uuid>/P-<uuid>` on the same host, and both are accepted. A logged-out session is detected by the header `Sign In` control (or "session expired") and ends in `login_required` before upload. |
| Configuration | The kernel waits (bounded) for `.cartQuantity input.input` and fills the quantity. The hook then clicks the "Select material" link, checks the `.Slideover .filterItem` labelled `6061 T6 Aluminum`, and checks the thickness filter whose text is exactly the reviewed label. A missing link, material or thickness filter stops in `selector_drift` (`oshcut_material_control_missing`, `oshcut_material_option_missing`, `oshcut_thickness_option_missing`) rather than quote a portal default. The kernel refuses configuration selectors that mention `cart`, so the link is anchored on its text (`span.error.link:text-is('Select material')`). The kernel's new declared `click` operation matches exact element text and refuses checkout, order, purchase, payment or cart text. |
| Offers (USD) | `OSHCUT_PRODUCTION_LOCATORS` (`oshcut-production-locators.v2`) reads the single cart row's `.cartSinglePrice` and `.cartExtendedPrice`. `-` means "not priced yet": the read repeats within 30 s and then stops in `selector_drift` (`oshcut_price_pending`); `-` is never parsed. Amounts must be `$`-denominated (optional `USD` suffix only), and single × quantity must equal extended within one cent. More than one priced row, or anything malformed, withholds the offer. There is no currency conversion. |
| Cart cleanup (report-only) | Once the price is read, or after a failure that followed upload, the kernel reports new candidate rows relative to its pre-upload DOM snapshot. Every candidate, including a single exact filename match, is left untouched. `cartCleanup` and `providerPortalCleanup` report `removed: 0`, the candidate count in `remaining`, the observed names in `manualCleanupRows` (or `null` when unavailable), `status: "incomplete"`, and `reason: "manual_cleanup_required"`. No candidates yields `not_found`; an invalidated snapshot yields `failed` with an unknown count. OSH Cut declares no remove/confirm selectors, never clicks them, and registers no native-dialog acceptance handler. Reporting is bounded at 30 s and skipped while the kill switch is engaged. It preserves the original result/error and also runs on `buildOshcutEvaluationDefinition`. |
| Live harness | `vendorWorkflowSmoke` (`npm --prefix worker run …` capture/certification runs) adds a `supplierCartCleanup` record per run and logs `liveHarnessSupplierCleanup`. Any run that reached upload without a confirmed removal, including through an adapter that declares no cleanup (`not_declared`), is flagged `SUPPLIER CART CLEANUP NEEDED` for manual removal. |
| Registry | The production registry wraps the definition in `PortalQuoteWorkflowAdapter` behind `OshcutAdapter`. In live mode the registry is filtered to `WORKER_LIVE_ADAPTERS`, so a worker without `oshcut` has no OSH Cut adapter. |
| Worker readiness and deploy | `oshcut` is rejected in production `WORKER_LIVE_ADAPTERS` (`liveAdapter: false`). Its session secrets list is empty, and generated deployment wiring contains no OSH Cut secret binding. The retained session-readiness implementation is available for future qualification only. |
| Stable egress | `egress: "none"`; OSH Cut is absent from the governed adapter combinations and `STABLE_EGRESS_PROVIDER_HOSTS`. |
| Customer UI | Not changed. OSH Cut is outside `PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS`. |

## Default-off switches

No switch enables automation now. Future enablement first requires OVD-1022
row-bound configuration and a separately reviewed source change removing the
hard stop; switches 1 to 5 would then also be required.

1. **Admission policy.** `private.quote_provider_admission_policies` for
   `oshcut` stays `disabled` until the reviewed revision in
   `provider-integrations/oshcut/admit/oshcut_admission_revision.sql.review`
   is recorded (`approved`, `generic_dispatch_enabled = true`).
2. **Reviewed envelope.** Absent from the code allow-list; the review row is a deferred draft
   requiring a separate go-live decision (`docs/migration-drafts/20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql`).
   It exists only after Blaine approves a window and the draft is promoted
   into `supabase/migrations` and applied. Until then permits are refused.
3. **Rollout.** The shared `automatic_quote_collection` rollout control.
4. **Organization enablement.** The organization has OSH Cut enabled, and the
   part lists OSH Cut as applicable.
5. **Worker adapters.** A future reviewed registry edit would need to enable
   the adapter, its session binding, and egress, then regenerate the outputs.
   Current production configuration rejects `oshcut` even with a secret name supplied.

Turning off any of switches 1 to 5 stops queued tasks before the browser
launches. Revoke a specific permit with `private.revoke_provider_dispatch_permit`.

## Known gaps before admission

- **Row-bound cart configuration (OVD-1022).** The initial empty-cart check
  does not protect against late-rendering pre-existing rows. Production and
  evaluation must remain hard-disabled until row ownership and all mutations
  are safely bound by design and verified.

- **Material commit step is unobserved.** The capture opened the slideover but
  committed no material. The hook checks the material and thickness filters.
  If the app needs a further click to commit the stock, the cart keeps showing
  `-` and the attempt stops in `selector_drift` (`oshcut_price_pending`) or
  `configuration_required`. That is safe, but it yields no offer. The first
  certification run confirms the step.
- **Upload ownership cannot be proved.** The portal exposes no upload-correlated
  provider identity. A filename match or a newly rendered row can belong to a
  customer or another session. Cleanup is report-only; candidate names/counts
  are inspection evidence, never permission to delete. Manual inspection is
  also required when the snapshot becomes invalid or reporting fails.
- **Stale cart parts.** A cart row that still says "Select material" before
  upload ends the attempt in `configuration_required`. More than one priced
  row withholds the offer.
- **Thickness data.** Requirements need `spec_snapshot.sheetThicknessInch`.
  No intake flow writes it yet, so every package without it ends in
  `thickness_confirmation_required` before upload.
- **Pricing latency.** The price wait is bounded at 30 s after configuration.

## Deferred go-live inputs (not authorized by adapter merge)

1. **Separate go-live decision and migration window.** Approve future
   enablement and a migration window that promotes the draft
   `docs/migration-drafts/20261015084957_ovd677_oshcut_reviewed_dispatch_envelope.sql`
   into `supabase/migrations` (with the free-quote CI manifest entry and the
   pending pgTAP file renamed into `supabase/tests`) and applies it, as
   separate actions.
2. **Admission revision.** Approve recording
   `oshcut_admission_revision.sql.review` with a reviewer UUID and policy date.
3. **Deploy.** Approve a worker deploy that lists `oshcut` and names the
   `oshcut-storage-state` secret.
4. **Certification run.** Approve one exact-file certification quote. The
   operator must inspect the report and manually remove only independently
   verified test parts afterwards, under the exact authorized operation.

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
(`withdrawn_at`). Any future enablement must define removal of its session mount; current deployment wiring never binds it.

## Permissions matrix (OVD-724)

The matrix row stays `draft_outreach_prepared` with `tos_stance: silent`. Its
notes record the `owner_approved` admission basis (OVD-641, 2026-10-15) and
the earlier shared-egress proposal, superseded by the default-off decision above.
That historical admission approval is not a recorded matrix `owner_override`, so the derived
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

Historical scaffold update (automation remains disabled pending OVD-1022): `oshcut-production-locators.v2` and the rewritten
`configure` hook implement the slideover, thickness pick and cart-row price cells; see
"What the code provides" above.

## Test-part cleanup rule (Blaine)

Every authorized live capture and certification run must include a manual
cleanup step after capture, whether the quote succeeds or fails:

1. Inspect `cartCleanup` / `supplierCartCleanup` and the
   `SUPPLIER CART CLEANUP NEEDED` warning. Any candidate requires manual cleanup
   review. Failed, skipped, or unknown reporting is not evidence of an empty cart.
2. Inspect the provider cart and independently establish which parts belong to
   this run. Candidate names and counts do not establish ownership, even when
   the name exactly matches the uploaded file. Leave uncertain parts untouched.
3. Under the separately authorized provider operation, manually remove only
   the verified test parts and verify each confirmation targets that part.
   Preserve pre-existing/customer parts. Record the resulting cart state;
   confirm an empty cart only if it was empty before the run.

All automated portal access, including cleanup reporting and removal, is disabled
in both the production and evaluation paths pending OVD-1022. The pure
`reportOshcutCartCleanup` projection remains available without any page access.
The adapter stays default-off; this procedure authorizes no provider operation.
The 2026-10-15 capture's test plate was removed from `/cart/O-97bd2644-a03a-4232-a714`
and the cart was confirmed empty.
