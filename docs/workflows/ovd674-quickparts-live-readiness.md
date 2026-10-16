# OVD-674 Quickparts live readiness

Last updated: October 10, 2026

This workflow describes the Quickparts production quote path. It mirrors the
Fictiv path in `docs/workflows/ovd673-fictiv-live-readiness.md`. The path is
implemented and disabled by default. Shipping the code does not authorize any
of the following:

- Quickparts login
- session capture
- CAD upload
- quote creation
- live DOM capture or locator review against the real portal
- deployment
- admission
- rollout

Each of those remains a protected action under `AGENTS.md`. Promotion still
follows the three stages in `docs/provider-integration.md`, and the 1.0 beta
policy in `RUNBOOK.md`.

## What the code provides

| Layer | Behavior |
| --- | --- |
| Reviewed envelope | `quickparts-quote-envelope.v1` is reviewed in code (`worker/src/providerDispatchEnvelope.ts`). It covers one CAD file and no drawing. Migration `20261011190000_ovd674_quickparts_reviewed_dispatch_envelope.sql` records it with a 7,200-second permit TTL. The row admits nothing on its own. |
| Permit and preflight | The generic OVD-458/459 path is unchanged. A Quickparts permit is issued only when all of these hold: an approved, generically dispatchable admission policy; an active reviewed envelope; rollout; entitlement; organization enablement; and exact scope. |
| Worker routing | In live mode, a Quickparts task that carries a generic permit goes through `api_authorize_provider_worker_dispatch`. A Quickparts task without a permit is refused before any browser launches (`dispatch_live_provider_not_permitted`). |
| Production portal definition | `buildQuickpartsProductionPortalDefinition()` in `worker/src/adapters/quickpartsPortal.ts`. Hosts are exactly `quickparts.com` and `quickquote.quickparts.com`, and every other request is aborted. Offers are read only through `QUICKPARTS_PRODUCTION_LOCATORS` (`quickparts-production-locators.v1`). Each option needs an option ID, a label, the exact requested quantity, USD unit and total prices that agree to within one cent, and a `USD` currency field. One malformed option withholds the whole batch. Terminal states are finite: login required, captcha, unavailable, manual review, configuration required, unexpected origin, selector drift, and unsupported. |
| Adapter binding | The production branch of `PortalQuoteWorkflowAdapter` exists only for a definition that declares `productionDispatch`, and only Quickparts does. Before the kernel reads a session or launches a browser, it re-checks the authorization it was handed. The check requires all of: provider `quickparts`; the reviewed envelope revision; an unexpired permit; the exact quantity; and outbound files that are exactly the staged CAD. It then captures the CAD bytes into memory and requires them to hash to the authorized SHA-256. The kernel refuses any drawing and any CAD type outside the instant-file envelope (SLDPRT is a manual quote). If any check fails, the result is a terminal `unsupported` with `providerInteractionAttempted: false`. |
| Registry | The production registry builds the Quickparts production definition. In live mode the registry is filtered to `WORKER_LIVE_ADAPTERS`. A worker without `quickparts` therefore has no Quickparts adapter. In simulate mode the adapter returns manual follow-up and never touches the provider. |
| Worker readiness | Live readiness accepts only `xometry`, `fictiv`, and/or `quickparts` in `WORKER_LIVE_ADAPTERS`. When `quickparts` is listed, readiness requires a Quickparts storage state that the portal kernel itself can open. It uses the kernel's own resolver: regular file, no symlinked path component, and cookies and origins limited to the Quickparts hosts. |
| Deploy | In live mode, `worker/scripts/deploy-cloud-run.sh` accepts `xometry`, `fictiv`, and/or `quickparts`, each at most once and with no empty fields. Whenever `quickparts` is listed, `QUICKPARTS_STORAGE_STATE_SECRET_NAME` is required. That secret is mounted at the fixed path `/var/secrets/quickparts-storage-state/storage-state.json`, and `QUOTE_VENDOR_STORAGE_STATE_PATHS={"quickparts":"<that path>"}` is set. Every other deploy removes the mount. Apart from that one `--remove-secrets` entry, the Xometry-only deploy command is unchanged; a contract test pins its full argument list. |
| Stable egress | The governed OVD-410 service may carry exactly `xometry`, `xometry,fictiv`, `xometry,quickparts`, or `xometry,fictiv,quickparts` (`STABLE_EGRESS_LIVE_ADAPTER_VALUES`). `STABLE_EGRESS_PROVIDER_HOSTS.quickparts` declares the Quickparts hosts, and a test pins them to the production portal definition. |
| Customer UI | Not changed. `VITE_LIVE_DISPATCH_PROVIDER` still accepts only `xometry` or `fictiv`. Quickparts is also outside `PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS`. |

## Default-off switches

A new Quickparts quote needs switches 1–5 on.

1. **Admission policy.** `private.quote_provider_admission_policies` for
   `quickparts` is `disabled` until a reviewed revision records `approved` with
   `generic_dispatch_enabled = true`.
2. **Reviewed envelope.** An active `quickparts-quote-envelope.v1` row in
   `private.provider_dispatch_envelope_reviews`. Withdraw it with
   `withdrawn_at`.
3. **Rollout.** The `automatic_quote_collection` rollout control. This switch
   is shared with Xometry and Fictiv.
4. **Organization enablement.** The organization has Quickparts enabled in its
   vendor configuration, and the part lists Quickparts as applicable.
5. **Worker adapters.** The worker runs with `quickparts` in
   `WORKER_LIVE_ADAPTERS`, using a Quickparts session secret.

Turning off any of switches 1–5 stops queued tasks before the browser
launches. To refuse a specific permit regardless of the switches, revoke it
with `private.revoke_provider_dispatch_permit`.

## Known gaps before admission

- **Locators are a reviewed contract, not an observation.** The fixture tests
  in `worker/src/adapters/quickpartsProductionPortal.browser.test.ts` pin
  `QUICKPARTS_PRODUCTION_LOCATORS`, the upload input, and the quantity input
  against synthetic pages. Nobody has captured the authenticated QuickQuote
  DOM, because that is a protected action. Until someone does, a real session
  most likely ends in `selector_drift`. That is safe, but it yields no offers.
  Revise the table and its revision string from that capture.
- **Third-party assets.** The kernel aborts every request outside the two
  declared hosts. Since OVD-773, a plain page subresource (CDN script, font,
  analytics beacon, CSP report) is blocked quietly and counted as
  `boundary.blocked_offhost`; it no longer stops the attempt. An off-host
  navigation, credential header, or request body still stops with
  `unexpected_origin` (see "Off-host requests" in
  `docs/provider-integration.md`). If QuickQuote genuinely needs a CDN script
  to work, that host needs the same review as the locators, an
  `offHostAllowlist` entry in the provider registry, and an update to
  `STABLE_EGRESS_PROVIDER_HOSTS`.
- **Pricing latency.** After upload, the kernel settles for up to one browser
  timeout plus 2.5 seconds before it reads offers. If instant pricing takes
  longer, the attempt ends in `selector_drift`.
- **Secret volume shape.** The worker refuses symlinked session paths.
  Readiness fails closed if the Cloud Run secret mount is not presented as a
  regular file, so the first deploy shows whether the mount shape is
  compatible.

## Inputs only Blaine can provide

1. **Quickparts account and session.** A Quickparts account approved for
   automated quote-only use. A Playwright storage state captured with
   `npm --prefix worker run auth:vendor -- quickparts`, stored in Secret
   Manager under a name that becomes `QUICKPARTS_STORAGE_STATE_SECRET_NAME`.
   The worker runtime service account must be able to read it.
2. **Permission basis.** Written Quickparts authorization, a determination
   that Quickparts' terms allow automation, or `owner_approved` (OVD-641).
3. **Live DOM review.** One authorized capture of the pricing panel, which
   confirms or revises `QUICKPARTS_PRODUCTION_LOCATORS` and the allowed hosts.
4. **Egress decision.** Choose one of:
   - **Shared egress.** Quickparts shares the OVD-410 address on
     `overdrafter-cad-worker`.
   - **Separate service.** A separate Quickparts service and egress.
5. **Admission values and certification run**, as in the Fictiv workflow,
   with `accepted_file_extensions` limited to the instant-file envelope and no
   drawing.

## Admission revision template (not applied)

```sql
update private.quote_provider_admission_policies
set admission_state = 'approved',
    generic_dispatch_enabled = true,
    policy_revision = 'quickparts-generic-<yyyy-mm-dd>.v1',
    evidence_reference = 'OVD-<n>',
    permission_basis = '<written_provider_authorization|provider_terms_allow_automation|owner_approved>',
    supported_processes = array['cnc_milling']::public.process_types[],
    accepted_file_extensions = array['step', 'stp'],
    session_owner = 'overdrafter_managed',
    reviewed_by = '<reviewer user uuid>',
    reviewed_at = pg_catalog.now(),
    expires_at = null,
    change_reason = 'approval_recorded'
where provider = 'quickparts'::public.vendor_name;
```

Rollback: record a new revision with `admission_state = 'disabled'`,
`generic_dispatch_enabled = false`, and `change_reason = 'policy_disabled'`.
Then revoke any issued permits. Redeploying without `quickparts` removes the
session mount.

## Permissions matrix (OVD-724)

Quickparts paid automated quoting is not matrix-cleared. See
[`docs/providers/permissions-matrix.md`](../providers/permissions-matrix.md#quickparts)
and [`docs/providers/acceptance-tables.md`](../providers/acceptance-tables.md).
A cease-and-desist uses the OVD-722 kill switch as step one
([playbook](../runbooks/provider-cease-and-desist.md)).
