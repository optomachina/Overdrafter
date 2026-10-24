# OVD-419 migration-scope review

Reviewed 2026-09-23 01:26 UTC against clean source `7da20710b25a6a30d0f9ac59e88e00f685defc67` and read-only production metadata for Supabase project `ozuatdcakezjtevztjlr`. This is a release-scope decision record, not a migration authorization or OVD-419 admission verdict. No schema or data was changed.

## Decision

**Defer all five unapplied September 10 migrations from OVD-419.** Keep its database target at the observed production head `20260905233435`, subject to fresh catalog, API/client-readback and other release preconditions immediately before any protected operation. Do not run a general `supabase db push` as part of OVD-419: it would attempt the pending suffix, combining separate engineering and commercial-admin changes with the worker release. Qualify and authorize those changes in their own bounded production windows.

This recommendation is supported by the repository's `PLAN.md` and OVD-419 release contract: the required migration-first OVD-408 quote-path suffix is the four-migration OVD-418 package, already applied; OVD-419's remaining outcome is the exact worker digest and hosted proof. `docs/engineering-task-coordinator.md` says the engineering APIs are not deployed, and `docs/commercial-audit-revocation-scopes.md` explicitly requires separate production approval for OVD-504 and states that OVD-419's authentication proof does not invoke the revocation path. Static searches found no direct dependency on the five new engineering/audit objects in the worker or OVD-419 release runner. Static absence is not a runtime proof.

## Five-file review

| Pending migration | Scope and relevant risk | OVD-419 disposition |
| --- | --- | --- |
| `20260910045917_engineering_durable_inbox.sql` (OVD-496) | Adds default-off engineering intake, but also creates a unique index on shared `public.projects`; production DDL still has lock and compatibility risk. | Defer; unrelated to Xometry worker proof. |
| `20260910055556_engineering_ordered_changes.sql` (OVD-497) | Adds ordered engineering records, policies and server/owner RPCs; depends on OVD-496. | Defer with its prerequisite. |
| `20260910064137_engineering_worker_sessions.sql` (OVD-498) | Adds worker pairing, private credential digests and owner-enabled sessions; activation requires a separately qualified gateway. | Defer; no worker-session activation is part of OVD-419. |
| `20260910104500_engineering_native_ownership.sql` (OVD-501) | Adds native attempt/slot/recovery state and changes the engineering cancellation function; large, cross-cutting migration with separate Windows stop qualification. | Defer; not a quote-path prerequisite. |
| `20260910134500_bind_entitlement_revocation_audit_scope.sql` (OVD-504) | Replaces a shared private commercial-admin audit function to fix a scoped revocation false positive. No row rewrite or grant change is intended, but production application and forward rollback require separate review. | Defer; OVD-419 does not invoke entitlement revocation. |

## Evidence and limits

- Live migration inventory: 106 recorded versions; head `20260905233435`; all four frozen OVD-418 versions (`20260817133902`, `20260821223849`, `20260821223851`, `20260822213330`) present; no September 10 version recorded.
- Read-only catalog at 01:25:38 UTC: admission policy and history tables present; admission policy has forced RLS and no direct `anon`, `authenticated` or `service_role` SELECT grant; `vendor_quote_offers.geographic_origin` is non-null with validated check; `reconcile_vendor_quote_offers(uuid,jsonb,jsonb)` exists with `service_role` EXECUTE and no `anon`/`authenticated` EXECUTE.
- Read-only catalog at 01:25:47 UTC: no `engineering_private` schema or sampled engineering intake, queue, worker or native-attempt tables. This supports, but cannot fully prove, absence of out-of-band engineering deployment.
- Zero-row anonymous Data API readback at approximately 01:29 UTC: `vendor_quote_offers?select=geographic_origin&limit=0` and `vendor_capability_profiles?select=vendor_name,process_types,materials,domestic_us&limit=0` each returned HTTP 200 with an empty JSON array. The publishable legacy anon key was passed only through a no-echo process input; no key or customer row was written into this packet. This confirms field exposure for that client role at capture, not authenticated-role behavior or later release-time state.
- `npm run verify:migration-lineage` passed on the selected source. OVD-418's historical production postaudit reported catalog, client and advisor postconditions passing; its exact 104-row final-head verifier is historical and cannot validate today's 106-row head.
- Current Supabase security/performance advisors still report WARN categories, including functions and quote-offer policies. No accepted-baseline comparison was completed in this review. Existing findings must not be mislabeled as new or as cleared. See the main approval packet for the timestamped category counts and links.
- This review did **not** replay the five pending SQL files in a disposable database, test a production push, perform an authenticated-client readback, inspect customer records, apply a migration, or change rollout controls.

## Remaining OVD-419 gates

Before any release authorization is requested or used: recapture the OVD-418 catalog and zero-row API/client readback immediately before admission; disposition the current advisor findings against the accepted baseline; bind the private snapshot identity; prove a global sole owner; recapture rollout, queues, executions, egress and resource versions; and review the exact plan-only bundle, rollback target and protected operations. The already qualified image and this migration decision do not authorize Job/Service replacement or either no-upload probe. OVD-419 and OVD-206 stay Blocked.
