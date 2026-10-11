# OVD-673 Fictiv live readiness

Last updated: October 10, 2026

This workflow describes the Fictiv production quote path. The path is fully
implemented and disabled by default. Shipping the code does not authorize any
of the following:

- Fictiv login
- session capture
- CAD upload
- quote creation
- deployment
- admission
- rollout

Each of those remains a protected action under `AGENTS.md`. Promotion still
follows the three stages in `docs/provider-integration.md`, and the 1.0 beta
policy in `RUNBOOK.md`.

## What the code provides

| Layer | Behavior |
| --- | --- |
| Customer confirmation | `VITE_LIVE_DISPATCH_PROVIDER=fictiv` points the part confirmation dialog at Fictiv. The dialog uses the generic `api_get_provider_dispatch_scope` and `api_request_provider_dispatch` RPCs. It never shows a scope computed for a different provider. Unset or any other value keeps the legacy Xometry flow. |
| Permit and preflight | The generic OVD-458/459 path is unchanged. A Fictiv permit is issued only when all of these hold: an approved, generically dispatchable admission policy; an active reviewed envelope; rollout; entitlement; organization enablement; and exact scope. |
| Reviewed envelope | `fictiv-quote-envelope.v1` is reviewed in code (`worker/src/providerDispatchEnvelope.ts`). It is recorded by migration `20261010120000_ovd673_fictiv_reviewed_dispatch_envelope.sql` with a 7,200-second permit TTL. That lifetime covers one full 3,600-second task ahead on the single-instance worker plus the 1/5/15-minute retry schedule. The row admits nothing on its own. |
| Worker routing | In live mode, a Fictiv task that carries a generic permit goes through `api_authorize_provider_worker_dispatch`. A Fictiv task without a permit is refused before any browser launches. |
| Adapter binding | Before launch, the Fictiv adapter re-checks the authorization it was handed. The check requires all of: provider `fictiv`; the reviewed envelope revision; an unexpired permit; the exact quantity; and outbound files whose SHA-256 values match the staged CAD and drawing bytes. If any check fails, the adapter returns a terminal `unsupported` before launch. |
| Worker readiness | Live readiness accepts only `xometry` and/or `fictiv` in `WORKER_LIVE_ADAPTERS`. When `fictiv` is listed, `FICTIV_STORAGE_STATE_PATH` or `FICTIV_STORAGE_STATE_JSON` is required. |
| Deploy | In live mode, `worker/scripts/deploy-cloud-run.sh` accepts `xometry` and/or `fictiv`, each at most once and with no empty fields. Whenever `fictiv` is listed, `FICTIV_STORAGE_STATE_SECRET_NAME` is required, and that secret is mounted as `FICTIV_STORAGE_STATE_JSON`. Every other deploy removes the binding. Fictiv-only or `fictiv,xometry` services are allowed only outside the governed stable-egress tuple. |
| Stable egress | The governed OVD-410 service, including the production `overdrafter-cad-worker`, may carry exactly `xometry` or `xometry,fictiv`. |

## Default-off switches

A new Fictiv quote needs switches 1–5 on. Switch 6 only chooses what the
customer UI shows. It is not a security control, because any authenticated
user can call `api_request_provider_dispatch` directly. The server-side
switches still gate that call.

1. **Admission policy.** `private.quote_provider_admission_policies` for
   `fictiv` is `disabled` until a reviewed revision records `approved` with
   `generic_dispatch_enabled = true`.
2. **Reviewed envelope.** An active row in
   `private.provider_dispatch_envelope_reviews`. Withdraw it with
   `withdrawn_at`.
3. **Rollout.** The `automatic_quote_collection` rollout control. This switch
   is shared with Xometry.
4. **Organization enablement.** The organization has Fictiv enabled in its
   vendor configuration, and the part lists Fictiv as applicable.
5. **Worker adapters.** The worker runs with `fictiv` in
   `WORKER_LIVE_ADAPTERS`, using a Fictiv session secret.
6. **Client provider (UI only).** The web app is built with
   `VITE_LIVE_DISPATCH_PROVIDER=fictiv`.

Turning off any of switches 1–5 stops queued tasks before the browser
launches. The worker preflight re-checks admission, the active reviewed
envelope, rollout, and organization enablement for each task. A worker
without `fictiv` routes the task to manual follow-up. Permit rows stay
recorded until they expire. To refuse a specific permit regardless of the
switches, revoke it with `private.revoke_provider_dispatch_permit`.

## Inputs only Blaine can provide

These steps are protected actions, so this repository cannot perform them.

1. **Fictiv account and session.**
   - A Fictiv account approved for automated quote-only use.
   - A Playwright storage state captured with `npm --prefix worker run auth:fictiv`.
   - The storage state stored in Secret Manager under a name of Blaine's
     choosing. That name becomes `FICTIV_STORAGE_STATE_SECRET_NAME`.
   - The worker runtime service account must be able to read the secret.
2. **Permission basis.** Written Fictiv authorization, or a determination that
   Fictiv's terms allow automation. This supplies
   `permission_basis = 'written_provider_authorization'` or
   `'provider_terms_allow_automation'`, plus the evidence reference. `owner_approved` is
   also accepted (OVD-641) if Blaine elects that basis.
3. **Egress decision.** Choose one of:
   - **Shared egress.** Fictiv shares the OVD-410 static NAT address with
     Xometry on `overdrafter-cad-worker` (`WORKER_LIVE_ADAPTERS=xometry,fictiv`).
     Fictiv sessions and quotes then originate from the Xometry egress IP.
   - **Separate service.** A separate Fictiv service and egress. This needs new
     infrastructure, and the governed tuple does not cover it.

   If Fictiv requires an IP allowlist, provide the address to allowlist.
4. **Admission values.** The policy revision, supported processes (for example
   `cnc_milling`), accepted extensions (for example `step`, `stp`, `pdf`),
   session owner (`overdrafter_managed`), reviewer user ID, and an optional
   expiry.
5. **Certification run.** One authorized, exact-file, non-export-controlled
   live quote through the Fictiv live-evaluation harness.

   This run is what qualifies Fictiv for
   `PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS` in
   `src/features/quotes/sourcing-result.ts`. Until Fictiv is on that list,
   Fictiv results are shown as recommendations, not certified live offers.

## Admission revision template (not applied)

Record admission as a separate reviewed migration once the inputs above exist.
The history trigger keeps every revision.

```sql
update private.quote_provider_admission_policies
set admission_state = 'approved',
    generic_dispatch_enabled = true,
    policy_revision = 'fictiv-generic-<yyyy-mm-dd>.v1',
    evidence_reference = 'OVD-<n>',
    permission_basis = '<written_provider_authorization|provider_terms_allow_automation>',
    supported_processes = array['cnc_milling']::public.process_types[],
    accepted_file_extensions = array['step', 'stp', 'pdf'],
    session_owner = 'overdrafter_managed',
    reviewed_by = '<reviewer user uuid>',
    reviewed_at = pg_catalog.now(),
    expires_at = null,
    change_reason = 'approval_recorded'
where provider = 'fictiv'::public.vendor_name;
```

Rollback: record a new revision with `admission_state = 'disabled'`,
`generic_dispatch_enabled = false`, and `change_reason = 'policy_disabled'`.
Then revoke any issued permits.
