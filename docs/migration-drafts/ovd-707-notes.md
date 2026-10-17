# OVD-707 PR 1: providers as data (SQL draft and pgTAP)

Status: **draft, not applied.** Nothing is in `supabase/migrations/`. Promotion
needs a Blaine-approved migration window. PR 2 (resolution in the worker and
API) and PR 3 (admin UI) build on this. The JSON registry
(`provider-integrations/provider-registry.v1.json`) stays the runtime source and
the seed and fallback source until PR 2.

## Files

| File | Purpose |
| --- | --- |
| `ovd-707-a.sql` | Tables, enum, validation helpers, append-only triggers, four-eyes helper, 12 admin RPCs, 1 service read |
| `ovd-707-a.rollback.sql` | Drops all of the above. Refuses while admin-written audit rows exist, unless the export is confirmed |
| `ovd-707-b-seed.sql` | Idempotent one-time seed of the 4 `liveAdapter: true` registry providers as `approved`, version 1 (Q4) |
| `ovd-707-b-seed.rollback.sql` | Removes seeded definitions that no admin has touched. Run before the group a rollback |
| `supabase/tests/pending/ovd707_a_guards.sql.pending` | 75 assertions: posture, ACLs, RLS, and the denial matrix for every RPC |
| `supabase/tests/pending/ovd707_b_lifecycle.sql.pending` | 104 assertions: lifecycle, four-eyes on approve, dry run and activate, Blaine's override, single-admin suspend, gates, audit, append-only, service read, seed |
| `scripts/ovd707-provider-definition-seed.test.mjs` | Vitest drift check that pins the seed rows to the live registry entries and manifests, seeded `approved` |
| `.github/workflows/ovd707-pending-pgtap.yml` | Ephemeral local Supabase: apply the drafts twice, run the pending pgTAP, replay the rollbacks twice newest-first, and diff the catalog against the pre-draft snapshot |

## Object map

- `private.provider_status` enum: `draft`, `pending_review`, `approved`, `active`, `suspended`, `retired`.
- `private.provider_definitions` is the live row. It holds `id`, `slug` (unique), `display_name`, `kind` (`portal|api|email|manual`), `quote_currency` (default `USD`), `host_allowlist text[]`, `admission jsonb` (structural check), `status`, `version`, `approved_revision_id`, `credential_ref` (secret name only), the export-control fields, the dry-run fields (including `dry_run_recorded_by`), `created_by`, `created_at` and `updated_at`.
- `private.provider_definition_revisions` holds append-only snapshots. A revision is decided once (`pending` to `approved` or `rejected`, and only the decision columns change). Revisions are never deleted. Each definition has at most one pending revision.
- `private.provider_audit_log` is append-only. Triggers block UPDATE, DELETE and TRUNCATE. No API role holds any grant on it.
- `private.provider_definition_override_emails` lists who may use the single-admin override. Decided (Q1): Blaine only.
- RLS is enabled and forced on all four tables. They have no policies and no grants to `anon`, `authenticated` or `service_role`.
- Admin RPCs (`authenticated` only, verified auth + platform admin + AAL2, `SECURITY DEFINER`, `search_path = ''`): `api_admin_create_provider_definition`, `api_admin_update_provider_definition_draft`, `api_admin_submit_provider_definition`, `api_admin_approve_provider_definition`, `api_admin_reject_provider_definition`, `api_admin_record_provider_dry_run`, `api_admin_activate_provider_definition`, `api_admin_suspend_provider_definition`, `api_admin_reopen_provider_definition`, `api_admin_retire_provider_definition`, `api_admin_list_provider_definitions`, `api_admin_list_provider_definition_history`.
- Service read (`service_role` only): `api_service_list_active_provider_definitions()`.

Every admin RPC first calls `private.require_provider_definition_admin()`.
That helper calls `public.require_verified_auth()`, then `public.is_platform_admin()`,
then `public.current_user_has_aal2()`. The RPC then validates the reason, locks
the row, checks the transition and writes exactly one audit row in the same
transaction. The read RPCs write no audit row.

## Lifecycle

```
create -> draft --submit--> pending_review --approve--> approved --dry run pass--> (approved) --activate--> active
                  ^              |                          |                                                |  ^
                  +---reject-----+                          +--reopen--> draft         suspend <-------------+  |
                                                                                       suspended --activate-----+
                                                                                       suspended --reopen--> draft
draft | approved | active | suspended --retire--> retired (terminal)
```

## Assumptions

- **A1. Schema.** All tables and the enum live in `private`, like the kill switch tables. Nothing is in `public`, so the OVD-602 "every public table has RLS" check is not affected.
- **A2. Editing a live provider.** In v1 you edit only in `draft`. To change an active provider, you suspend, reopen, edit, submit, approve, record the dry run and activate it again. This creates a new version. While it is in draft, the provider is not served. See Q3.
- **A3. Export-control fields (OVD-723).** There are two fields. `export_jurisdiction` is `us` or `foreign`, the same values `private.export_control_provider_jurisdiction` returns. `export_controlled_allowed` is a boolean. A foreign provider can never be set to `true`. Activation requires both fields to be set.
- **A4. Dry-run gate.** `api_admin_record_provider_dry_run` records the result of an offline dry-run check with a required evidence reference, and who recorded it (`dry_run_recorded_by`). The database performs no dispatch. A pass is tied to the current `version`. Approving a new version, reopening, or recording a failing result clears the pass. Activation requires `dry_run_passed_version = version`. Resuming from `suspended` keeps the pass for the same version. Recording and activating are four-eyes steps (A12, Q2).
- **A5. Seed.** Only the `liveAdapter: true` registry providers (today fictiv, quickparts, weerg and xometry) are seeded, as `approved`, version 1 (Q4). They have these sources:
  - `admission`: the registry entry, verbatim.
  - `display_name`: the manifest `displayName`.
  - `host_allowlist`: the manifest `official.domains`.
  - `kind`: from the manifest `integration.adapterKind` (`api` maps to `api`, `*_portal` to `portal`, `guidance_only` to `manual`).
  - `quote_currency`: `EUR` for weerg and `USD` for every other provider.
  - `credential_ref`: the first `sessionSecrets[].secretNameEnv`, or null.
  - Export-control fields: `export_jurisdiction` from the OVD-723 function, and `export_controlled_allowed = false`.

  Seeded rows are grandfathered through review only:
  - The revision has no proposer, reviewer or contributors.
  - No dry run is recorded. Each provider is activated explicitly after a real dry run (record, then activate by a different admin, or by Blaine through the override).
  - Each row gets one audit row with actor `cli:ovd-707-seed` and `actor_kind = 'cli'`.

  Non-live registry entries are not seeded. When one is needed it goes through create, submit and approve.

  The seed is idempotent: it skips existing slugs. `scripts/ovd707-provider-definition-seed.test.mjs` fails if the registry or a manifest changes without the seed being regenerated.
- **A6. `credential_ref`** must match `^[A-Z][A-Z0-9_]{0,100}_SECRET_NAME$`. That is the registry's `secretNameEnv` convention: the name of an env var that holds the secret name. API keys, tokens, JSON, URLs and lowercase values are refused by a check constraint.
- **A7. Kill switches win.** The service read excludes a provider when `private.provider_kill_switch_engaged_text(slug)` is true. That covers an engaged provider switch, an engaged global switch, and fail-closed cases (a slug with no switch row, including a slug that is not yet a `vendor_name` value). As a result, a brand-new provider is not served until it has an enum value and a kill switch row. That is consistent with "the `vendor_name` enum remains the runtime identity contract" in `docs/provider-integration.md`. PR 2 should still re-check the kill switch at dispatch, as it does today.
- **A8. Reasons.** Every transition requires a reason of at least 10 trimmed characters, the same rule as the kill switch RPCs. The override reason uses the same rule.
- **A9. Reads.** The admin read RPCs use the same guard (AAL2) as the writes. They write no audit row.
- **A10. Audit shape.** `actor` is text. It holds a user id for `user` rows (enforced by a check constraint) and a free label for `cli` rows. `request_id` is taken from the PostgREST `request.headers` `x-request-id` when present. `before` and `after` hold the full row state.
- **A11. "Active" is not "admitted".** An active definition does not admit a provider or enable dispatch. Admission policies, permits, the production-certified allowlist and the kill switches still decide every dispatch.
- **A12. Four-eyes steps.** Approve, record dry run and activate (including resume from `suspended`) are four-eyes steps. None of them may be done by a contributor to the revision (A13). The activator also must not be the admin who recorded the dry run. Violations raise `42501 four_eyes_required`. The only exception is the single-admin override (Q1): `p_override = true`, the caller's email is in the override list, verified auth, platform admin, AAL2 and a reason of at least 10 characters. It is audited as `approve_override`, `record_dry_run_override` or `activate_override`. Passing `p_override` when there is no conflict raises `22023 four_eyes_override_not_needed`. Reject by the proposer (a withdrawal), suspend, reopen and retire stay single-admin. Suspend in particular must never be blocked.
- **A13. Four-eyes covers every contributor.** At submit, the revision records `contributors`: the distinct users behind `create` and `update_draft` audit rows since the definition's last `approve` or `approve_override` (or since creation), plus the submitter. None of them may approve that revision, record its dry run or activate it, except through the single-admin override. `contributors` and `proposal_reason` cannot change after submit; the approver's or rejecter's reason goes in `decision_reason`.

## OVD-602 privilege inventory

`supabase/tests/api_role_privilege_inventory.sql` pins every `SECURITY DEFINER`
function that `authenticated` can execute. It is **not** changed in this PR. Its
hygiene assertion requires every allowlisted signature to exist
(`to_regprocedure`), and these functions do not exist until promotion. The
pending guards test pins the exact ACLs instead. In the promotion change, add
these rows (inventory text form, no spaces after commas):

```sql
  ('public.api_admin_activate_provider_definition(uuid,text,boolean)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_approve_provider_definition(uuid,text,boolean)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_create_provider_definition(text,jsonb,text)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_list_provider_definition_history(uuid)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_list_provider_definitions()', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_record_provider_dry_run(uuid,boolean,text,text,boolean)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_reject_provider_definition(uuid,text)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_reopen_provider_definition(uuid,text)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_retire_provider_definition(uuid,text)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_submit_provider_definition(uuid,text)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_suspend_provider_definition(uuid,text)', 'authenticated', 'admin-aal2', 'OVD-707'),
  ('public.api_admin_update_provider_definition_draft(uuid,jsonb,text)', 'authenticated', 'admin-aal2', 'OVD-707'),
```

The service read is `service_role` only and the private helpers are revoked from every API role, so the inventory needs no other rows.

## Design questions

1. **How is Blaine identified for the four-eyes override?** *Decided, see
   Decisions below.* The draft follows
   the existing pattern of a lowercase email allowlist,
   `private.provider_definition_override_emails`. The existing pattern is
   `private.platform_admin_emails`, which the 20260303123000 migration seeds
   with Blaine's address. The override also requires a verified email or OAuth
   sign-in (`require_verified_auth()`), AAL2, and a reason of at least 10
   characters. It is recorded as `approve_override` and as
   `four_eyes_override = true` on the revision. Alternatives:
   - pin Blaine's `auth.users.id`, which survives an email change;
   - use a capability row in `private.platform_admin_capabilities`, the
     commercial-admin pattern with expiry and revocation.

   Which should promotion use?
2. **Should activation and dry-run recording also need a second admin?**
   *Decided: yes, see Decisions below.*
3. **Should active providers support zero-downtime edits?** That would mean a
   pending revision alongside the live one, so the active version keeps serving
   until the new one is activated. v1 needs suspend and reopen (A2).
4. **How should the seed land?** *Decided, see Decisions below.* Options:
   - Seed `active` with grandfathered review and dry run, as drafted.
   - Seed `approved`, so each provider is activated explicitly after a real dry
     run.
   - Seed only the `liveAdapter: true` providers.

   Should non-live registry entries be `active` at all, given A11?
5. **Should `slug` be constrained to `vendor_name`?** Today it is free text and
   the service read fails closed for unknown slugs (A7). The alternative is to
   add enum values and kill switch rows through the definition lifecycle in
   PR 2 or PR 3.
6. **Where should export jurisdiction come from?** PR 2 could make
   `private.export_control_provider_jurisdiction` and the worker's
   `FOREIGN_JURISDICTION_PROVIDERS` read from the definitions, so there is one
   source of jurisdiction. Or the two stay duplicated with a parity check.

### Decisions

Recorded from the OVD-707 Linear thread after the PR 1 review.

- **Q1 (Blaine).** The override list is Blaine only for now.
  `private.provider_definition_override_emails` is seeded with Blaine's
  address and nothing else. Adding anyone needs a reviewed migration and
  Blaine's approval. The override still requires verified auth, platform
  admin, AAL2 and a reason of at least 10 characters, and is audited
  (`approve_override` for approval).
- **Q2 (Architect, conservative).** Dry-run recording and activation are
  four-eyes too. The recorder and the activator must not be contributors to
  the revision (the same rule as approve), and the activator must not be the
  recorder. Violations raise `42501 four_eyes_required`. The only exception is
  the Q1 override, audited as `record_dry_run_override` or
  `activate_override`. Suspend stays single-admin, because switching a
  provider off must never be blocked.
- **Q4 (Architect, conservative).** Seed only the `liveAdapter: true`
  registry entries, as `approved`, not `active`. Each one is activated
  explicitly after a real dry run is recorded. Non-live entries are not
  seeded; they go through create, submit and approve when needed. The service
  read fails closed, so the promotion runbook must activate the live
  providers (Xometry and every other live one) in the same window, or they
  will not be served.

7. **What format should `credential_ref` use?** It currently uses the env-var
   name convention (A6). If PR 2 wants the Secret Manager secret name itself
   (lowercase with hyphens), the check needs a different, still value-rejecting
   pattern.
8. **Should the admin read RPCs require AAL2?** They currently do (A9), which is
   stricter than the existing `internal-role` list RPCs.

## Local verification (this PR)

No Docker was available, so verification used a local throwaway PostgreSQL
17.11 cluster with pgTAP 1.3.3. Supabase was replaced by a minimal shim: the
API roles, `auth.uid()`/`auth.jwt()` and `auth.users`, the auth and admin
helpers, and the OVD-722 kill switch objects, copied from
`supabase/migrations`. Nothing was applied to any Supabase project. The
workflow above is the faithful proof on a real local Supabase stack. Results:

- Each draft applies in a single transaction and re-applies as a no-op.
- The pending pgTAP passes: 143/143 assertions (74 guards + 69 lifecycle).
  This was before review round 1, which was not re-run locally; see below.
- Both rollbacks replay twice, newest first, and the `public` and `private`
  catalog matches the pre-draft snapshot.
- Two mutation checks were run: removing the kill-switch filter, and
  bypassing the AAL2 check. Each fails the suite as expected.

## Review round 1

- **MAJOR-1 (four-eyes missed the editor).** Approval only compared the approver
  with the submitter, so A could edit, B submit and A approve. Revisions now
  carry `contributors uuid[] not null` (A13), filled in submit. Approve raises
  `42501 four_eyes_required` when the caller is a contributor, unless the
  existing override conditions hold. The check constraint is now
  `reviewed_by = any (contributors)` for an override, plus
  `proposed_by = any (contributors)`. The guard trigger keeps `contributors`
  fixed. The seed writes `'{}'`. The rollback needs no change, because the
  column goes with its table and no new function was added.
- **MINOR-1.** `reason` is split into `proposal_reason` (fixed by the guard
  trigger) and `decision_reason`. The history read returns `contributors`,
  `proposalReason` and `decisionReason`.
- **MINOR-3 (partial).** New lifecycle cases: "A edits, B submits, A approves"
  is refused and "A edits and submits, B approves" is allowed, with the
  contributors and both reasons checked. TRUNCATE on revisions and definitions
  is refused. The guards test checks that no API role has privileges on the
  audit log identity sequence. Not yet covered: `approved_revision_mismatch`,
  and re-deciding a revision.
- **MINOR-4.** The workflow passes the selected file lists through `env:` and
  rejects any name outside `^[A-Za-z0-9._/-]+$` before writing the outputs.
- Not addressed this round: MINOR-2 (`request_id` is caller-supplied) and
  MINOR-5 (digest pinning).
- These changes have not been applied or run anywhere. The CI workflow is the
  first proof.

## Decisions round (Q1, Q2, Q4)

- New column `dry_run_recorded_by`, returned as `dryRunRecordedBy` in the row state.
- New private helpers `require_provider_four_eyes(uuid, boolean, boolean)` (shared by approve, record dry run and activate) and `provider_approved_contributors(provider_definitions)`. Both are revoked from every API role and dropped by the rollback.
- `api_admin_record_provider_dry_run` and `api_admin_activate_provider_definition` take a trailing `p_override boolean default false`, so their signatures (and the OVD-602 rows above) change. Existing calls keep working.
- New audit actions `record_dry_run_override` and `activate_override`.
- The seed now holds 4 approved rows. The drift test pins it to the `liveAdapter: true` entries.
- The lifecycle test no longer adds a test email to the override list. Its override admin signs in with Blaine's address, so the test also proves the list holds exactly one row.
- Local verification, on the same throwaway PostgreSQL 17 + pgTAP shim as above (nothing applied to any Supabase project): both drafts apply twice; the pending pgTAP passes 179/179 (75 guards + 104 lifecycle); both rollbacks replay twice and the catalog matches the pre-draft snapshot. Three mutation checks were run: removing the recorder check, the dry-run contributor check, or the activation contributor check. Each one fails the suite. The CI workflow is still the faithful proof.

## Promotion checklist

1. Run `npm run migration:new` and combine `ovd-707-a.sql` and `ovd-707-b-seed.sql` into one migration (regenerate the seed first if the drift test fails).
2. Rename `supabase/tests/pending/ovd707_*.sql.pending` to `supabase/tests/ovd707_*.sql`.
3. Add the OVD-602 allowlist rows above.
4. Delete `.github/workflows/ovd707-pending-pgtap.yml` and the `ovd-707-*` Sonar CPD exclusion if the promoted migration no longer needs it.
5. Resolve the remaining design questions (Q3, Q5, Q6); Q1, Q2 and Q4 are decided above.
6. In the same window, for each seeded live provider (`fictiv`, `quickparts`, `weerg`, `xometry`): one admin records a real dry run, and a different admin activates it, or Blaine activates through the override. Until then the service read returns nothing for them.
