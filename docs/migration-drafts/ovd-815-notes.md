# OVD-815 notes: fixture-heal ledger (DRAFT)

OVD-796 slice 4. Draft only: nothing applied, nothing in `supabase/migrations/`. Production apply is a separate Blaine approval card. This slice adds the ledger and commitment guards; it does not run certifications or authorize provider operations.

## Files

- `docs/migration-drafts/ovd-815-fixture-heal-a.sql`: five private tables, seven RPCs, three trigger functions and seven triggers (four integrity triggers and three commitment guards).
- `docs/migration-drafts/ovd-815-fixture-heal-a.rollback.sql`: removes the complete ledger and guards; safe to replay, destructive to ledger data.
- `docs/migration-drafts/ovd-815-notes.md`: access model, deviations, inventory pins and promotion steps.
- `supabase/tests/pending/ovd815_fixture_heal_a.sql.pending`: 172 assertions covering access, lifecycles, evidence integrity and commitments.
- `supabase/tests/pending/ovd815_fixture_heal_a_rollback.sql.pending`: 12 state-invariant assertions, both with and without the draft.

CI: `.github/workflows/ephemeral-db.yml`, through `scripts/ephemeral-db-apply.mjs`, resolves family `815` alone. It applies the draft, re-applies the idempotent draft, runs both pending suites, rolls back twice with a DM-1R schema dump comparison after each pass, and runs the tagged post-rollback suite after each pass. The main suite is not a post-rollback test.

## Deviations from design §16

- Use `public.require_verified_auth()`, then `public.current_user_has_aal2()`, then `coalesce(public.is_platform_admin(), false)`. The design's private helpers do not exist; the Architect corrected them. AAL2 is checked before platform-admin membership.
- Provider keys use the registry regex `^[a-z][a-z0-9]{1,49}$`, not the sketch's underscore-permitting pattern or the frozen vendor enum.
- Global standing events use `standing_granted` / `standing_revoked` and NULL provider. The sketch's placeholder repair event and wildcard provider cannot represent a standing approval accurately.
- Events record `actor` / `actor_kind`. Admin events require an actor UUID; worker events have no actor. Workers cannot manufacture standing events.
- Approvals retain `revoke_reason` and allow only one immutable grant-to-revoke update. DELETE, TRUNCATE, re-revoke, un-revoke and edits to grant evidence are refused.
- Certification recording supports start and finish under a row lock, with coupled outcome/time and explicit cleanup-state transitions. Cleanup recording implements ledger-first intended rows, controlled reference assignment on creation, removal attempt counting and terminal verification. The composite foreign key prevents a cleanup item from naming a different provider than its certification.
- Add `api_worker_fixture_heal_active_standing_approval()` so class-S merges can cite the current approval id and observe revocation.
- Every worker RPC checks `auth.role()` as defense in depth, in addition to service-role-only EXECUTE.
- Add INVOKER triggers instead of restating deployed publish/select bodies. This avoids function collisions and preserves existing signatures, grants and policies. Include the `jobs.selected_vendor_quote_offer_id` path used by `api_set_job_selected_vendor_quote_offer`, as well as published options and client selections.
- Use `ovd-815-*` draft filenames and `ovd815_*` pending filenames rather than the sketch's generic names. The ephemeral-db runner groups by issue prefix; pending headers claim only this draft stem. The idempotency and post-rollback markers remain in leading comment blocks.
- OVD-771 is already applied as `20261015221725_ovd771_service_kill_switch.sql`. This draft does not depend on it or any other draft.
- Harden the sketch's values: bounded object JSON, bounded reasons, validated revisions/part keys/storage paths, clock timestamps, forced RLS without policies, revoked direct service-role access, and UPDATE/DELETE plus TRUNCATE protection. These enforce the ledger contract independently of callers.

## Access model

| Object | anon | authenticated | service_role |
| --- | --- | --- | --- |
| All five `private.fixture_heal_*` tables | none | none, including AAL2 admin | none |
| Four worker record RPCs and active-approval RPC | none | none | EXECUTE, role claim required |
| Two admin standing-approval RPCs | none | EXECUTE, verified + AAL2 + platform admin | none |
| Three private trigger functions | none | none | none |

All five tables enable and force RLS, with zero policies. Every ledger write uses an owner-executed DEFINER RPC. No API role has a direct table privilege. Integrity triggers also refuse owner writes outside the allowed one-time revoke. Trigger firing does not require an EXECUTE grant.

## Functions

All functions pin `search_path = ''`. Each RPC revokes all four broad roles first, then grants EXECUTE to exactly one role.

| Function | Kind | Execute | Guard |
| --- | --- | --- | --- |
| `public.api_worker_fixture_heal_record_fingerprint(jsonb)` | DEFINER | service_role | role claim, closed object payload, insert only |
| `public.api_worker_fixture_heal_record_certification(jsonb)` | DEFINER | service_role | role claim, closed start/update payload, locked finish and cleanup lifecycle |
| `public.api_worker_fixture_heal_record_cleanup_item(jsonb)` | DEFINER | service_role | role claim, closed payload, locked ledger-first transitions |
| `public.api_worker_fixture_heal_record_event(jsonb)` | DEFINER | service_role | role claim, closed payload, no standing event kinds |
| `public.api_worker_fixture_heal_active_standing_approval()` | stable DEFINER | service_role | role claim; active selector-only metadata or SQL NULL |
| `public.api_admin_grant_fixture_heal_standing_approval(text)` | DEFINER | authenticated | verified auth, AAL2, platform admin, reason; one active grant |
| `public.api_admin_revoke_fixture_heal_standing_approval(uuid,text)` | DEFINER | authenticated | same guards; active row only, audited revoke |
| `private.fixture_heal_events_immutable()` | INVOKER trigger | nobody | refuses UPDATE/DELETE/TRUNCATE |
| `private.fixture_heal_standing_approvals_guard()` | INVOKER trigger | nobody | one-time revoke only, no DELETE/TRUNCATE |
| `private.fixture_heal_guard_quote_commitment()` | INVOKER trigger | nobody | checks both result sources, refuses marked or unreadable sources |

The commitment triggers are `guard_fixture_heal_published_option` on `public.published_quote_options`, `guard_fixture_heal_client_selection` on `public.client_selections`, and `guard_fixture_heal_job_offer_selection` on `public.jobs`. They sort after the existing `guard_direct_job_offer_selection`, preserving its direct-API-role refusal. INVOKER accommodates direct service-role spreadsheet imports and owner-executed RPCs without exposing private helper functions.

## Guard semantics

For each referenced result, any `fixtureHeal` marker counts as internal unless it is an object with an explicit JSON boolean `internal: false`. This includes malformed marker objects, nulls and scalars. Internal takes precedence over an explicit JSON boolean `fixtureSanity.held: true`, which is a sanity hold. Only the S1 gate writes the internal marker; it strips adapter-supplied markers. Errors expose only `reason=internal_test_quote` or `reason=sanity_hold`, never payloads or identifiers.

Options check both their result id and the result owning their offer id. Selections resolve their option and check both paths. Jobs check the chosen offer's result. Missing or RLS-hidden sources fail closed. Source-less legacy options have nothing to check. Rewriting an option's source columns rechecks even unchanged ids; unchanged selection/job commitments are left alone for the later admin workflow.

`manual_review_pending` status alone is not an extra trigger predicate: publication already filters status, and older rows predate these markers. A path that rewrites `raw_payload`, such as `api_admin_complete_manual_quote_request`, removes markers; that is an admin decision outside these guards. Releasing a sanity hold must clear `fixtureSanity.held`; the release RPC belongs to a later slice. This is no supplier-ordering implementation and does not retroactively undo commitments.

## OVD-602 privilege inventory (rows to add at promotion)

Add exactly these rows to `api_priv_definer_allowlist` in `supabase/tests/api_role_privilege_inventory.sql` at promotion:

```sql
  ('public.api_admin_grant_fixture_heal_standing_approval(text)', 'authenticated', 'admin-aal2', 'OVD-815'),
  ('public.api_admin_revoke_fixture_heal_standing_approval(uuid,text)', 'authenticated', 'admin-aal2', 'OVD-815'),
```

A second file pins the same authenticated definer set: `ovd736_authenticated_allowlist` in `supabase/tests/ovd736_anon_definer_privileges.sql` (OVD-736). Add these two rows to it in the same change (its reasons must be at least 20 characters):

```sql
  ('public.api_admin_grant_fixture_heal_standing_approval(text)', 'admin RPC: OVD-815 fixture-heal standing approval grant (AAL2 platform admin only)'),
  ('public.api_admin_revoke_fixture_heal_standing_approval(uuid,text)', 'admin RPC: OVD-815 fixture-heal standing approval revoke (AAL2 platform admin only)'),
```

Checked on a disposable local stack with the draft applied: both files fail on exactly these two signatures without the rows (`Extra records`), and pass with them (inventory 10/10, OVD-736 106/106).

Nothing else changes: worker RPCs are service_role only; trigger functions are INVOKER and granted to nobody; there are no new public tables. Pending tests pin the real `admin-aal2` helpers: `public.current_user_has_aal2()` and `public.is_platform_admin()` resolve, while `private.require_verified_auth()` and `private.is_platform_admin()` do not. They also pin the existing publication and selection RPC ACLs. Neither inventory file is edited in this draft slice: both assert that every allowlisted signature exists, so the rows can only land with the migration.

## How to verify

The ephemeral-db job is the full migration-chain proof. Both pending suites run in transactions and roll back their synthetic records. The main plan is 172; the state-invariant plan is 12, with no skipped or TODO assertions. Offline lints cannot establish database behavior.

For a separately authorized local verification, use a disposable scratch copy of `supabase/` and start its stack with `supabase db start`. Record a baseline `pg_dump --schema-only`; apply the draft with `psql --single-transaction -v ON_ERROR_STOP=1 -f docs/migration-drafts/ovd-815-fixture-heal-a.sql`, then apply it again to prove idempotency. Stage both pending files with `.sql` suffixes in a test directory and run `supabase test db --local <staged dir>`. Run the rollback with the same single-transaction/error-stop flags, dump and compare to baseline, and run only the tagged state-invariant suite. Repeat that rollback/dump/test pass. Both DM-1R diffs must be empty. Use the scratch stack's connection configuration exclusively.

Local run evidence: recorded in the PR.

## Promotion checklist (Blaine-approved window only)

1. Use `npm run migration:new` and copy the draft body unchanged into one migration.
2. Rename both pending files to `supabase/tests/ovd815_fixture_heal_a.sql` and `supabase/tests/ovd815_fixture_heal_a_rollback.sql` in the same change.
3. Add the two OVD-602 rows to `supabase/tests/api_role_privilege_inventory.sql` and the two OVD-736 rows to `supabase/tests/ovd736_anon_definer_privileges.sql` (both above), and regenerate `src/integrations/supabase/types.ts`.
4. Attach the OVD-602 diff (exactly two rows), DM-1R diff (empty), and pgTAP output to the approval card. Confirm current migration-chain compatibility, idempotency and both rollback passes.
5. Apply the migration before worker code that calls these RPCs. The S1 sanity gate does not call them and has no dependency on this ledger migration.
6. For rollback, unwire callers first; export `private.fixture_heal_events` and `private.fixture_heal_standing_approvals` if needed as evidence. With exact approval, run the rollback, verify the schema diff and state-invariant suite. Rollback deletes the entire ledger, including active standing approvals.

## Open questions for Blaine

- What fingerprint retention period and purge process should be used?
- Should `manual_review_pending` status alone block publish/select in addition to markers?
- Is an admin ledger-read RPC wanted before slice 5?
