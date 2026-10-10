# Production Apply Packet v3: Migration Manifest

**Date**: October 10, 2026  
**Project**: ozuatdcakezjtevztjlr (Website - Production Supabase)  
**Source branch**: `codex/recovered-release-free-safety-20261003`  
**Source commit**: 454687c  
**Target PR**: #564

## Current State

- **Current ledger**: 112 rows, ending at `20260924014552`
- **Recorded fingerprint**: `212b70060764426f5f83ee6c58fa2085`
- **Last verified**: October 10, 2026

## Target State

- **Target ledger**: 140 rows, ending at `20261008055500`
- **New migrations**: 28 (14 from main + 13 from branch + 1 from OVD-641)

## Apply Sequence

All 28 migrations must be applied in the order below. This is a forward-only apply; no migration may be skipped or reordered.

### Group 1: Missing from main (14 migrations)

These migrations exist on `main` but were not applied to production.

| # | Version | Filename |
|---|---------|----------|
| 113 | 20260910045917 | 20260910045917_engineering_durable_inbox.sql |
| 114 | 20260910055556 | 20260910055556_engineering_ordered_changes.sql |
| 115 | 20260910064137 | 20260910064137_engineering_worker_sessions.sql |
| 116 | 20260910104500 | 20260910104500_engineering_native_ownership.sql |
| 117 | 20260910134500 | 20260910134500_bind_entitlement_revocation_audit_scope.sql |
| 118 | 20260911031500 | 20260911031500_add_capability_observation_ledger.sql |
| 119 | 20260926225000 | 20260926225000_confirm_sourcing_intent.sql |
| 120 | 20260927060736 | 20260927060736_engineering_interpretation_reservations.sql |
| 121 | 20260927065514 | 20260927065514_ovd513_capability_record_resolver_rpcs.sql |
| 122 | 20260927130000 | 20260927130000_ovd575_native_observer_registry.sql |
| 123 | 20260927140000 | 20260927140000_ovd576_atomic_native_stop.sql |
| 124 | 20260927225843 | 20260927225843_ovd576_stop_caller_fence.sql |
| 125 | 20260928081530 | 20260928081530_add_rmfg_vendor_name.sql |
| 126 | 20260928081534 | 20260928081534_seed_rmfg_disabled_admission.sql |

### Group 2: Branch migrations 127-139 (13 migrations)

These migrations were developed on the release branch and add free-quote safety, capability persistence, and provider dispatch infrastructure.

| # | Version | Filename | Issue | Notes |
|---|---------|----------|-------|-------|
| 127 | 20261002041305 | 20261002041305_enforce_quote_selection_expiry.sql | recovered | Revokes direct INSERT on client_selections, drops policy |
| 128 | 20261002053133 | 20261002053133_align_selection_and_publication_sources.sql | recovered | Revokes UPDATE grants (including service_role) |
| 129 | 20261002090339 | 20261002090339_add_atomic_capability_window_attention_persistence.sql | OVD-591 | 5 new private tables |
| 130 | 20261002133713 | 20261002133713_add_capability_preparation_retention.sql | OVD-591 | 3 new private tables |
| 131 | 20261002182714 | 20261002182714_free_quote_job_meter.sql | recovered | 3 new private tables |
| 132 | 20261002182910 | 20261002182910_free_confirmed_quote_access.sql | recovered | Quote access policy |
| 133 | 20261003011148 | 20261003011148_reconcile_free_quote_job_reservations.sql | recovered | Reconciliation RPC |
| 134 | 20261003150000 | 20261003150000_ovd536_restrict_audit_event_writer.sql | OVD-536 | Revokes log_audit_event from PUBLIC/anon/authenticated |
| 135 | 20261003160000 | 20261003160000_ovd458_generic_provider_dispatch_permits.sql | OVD-458 | 3 new private tables, default off |
| 136 | 20261003170000 | 20261003170000_ovd459_provider_dispatch_preflight.sql | OVD-459 | Service-role preflight RPC |
| 137 | 20261004100000 | 20261004100000_ovd598_serialize_legacy_xometry_admission.sql | OVD-598 | NOWAIT locks |
| 138 | 20261004110000 | 20261004110000_reject_empty_job_file_uploads.sql | OVD-601 | Upload validation |
| 139 | 20261004130000 | 20261004130000_ovd628_generic_admission_nowait.sql | OVD-628 | NOWAIT on generic admission |

### Group 3: OVD-641 (1 migration)

This migration merged into main after the release branch was created.

| # | Version | Filename | Issue |
|---|---------|----------|-------|
| 140 | 20261008055500 | 20261008055500_ovd641_allow_owner_approved_permission_basis.sql | OVD-641 |

## Migration Impact Summary

**Tables created**: 14 new private forced-RLS tables
- 5 from migration 129 (capability window/attention)
- 3 from migration 130 (preparation retention)
- 3 from migration 131 (free quote meter)
- 3 from migration 135 (provider dispatch)

**Privileges revoked**:
- Migration 127: Direct INSERT on public.client_selections
- Migration 128: UPDATE grants on public.client_selections (including service_role)
- Migration 134: PUBLIC/anon/authenticated EXECUTE on log_audit_event

**Policies dropped**:
- Migration 127: client_selections_insert_members policy

**All migrations are forward-only**. No migration drops a table or column, and no migration deletes data at apply time.

## Apply Method

Use Supabase CLI 2.78.1 or compatible:

```bash
supabase db push --db-url <connection-string> --include-all --yes
```

Or apply via Supabase Dashboard or your preferred connector.

## Pre-Apply Checklist

- [ ] Run `production-apply-packet-v3-pre-check.sql` and verify all checks pass
- [ ] Verify production is quiescent (no active jobs, no quote requests in flight)
- [ ] Verify rollout controls remain disabled
- [ ] Verify billing self-service remains disabled
- [ ] Record the pre-apply fingerprint (or document drift)

## Post-Apply Checklist

- [ ] Run `production-apply-packet-v3-readback.sql` and verify all checks pass
- [ ] Verify ledger is at 140 rows ending at 20261008055500
- [ ] Record the post-apply fingerprint
- [ ] Verify no unexpected schema changes
- [ ] Ready to merge PR #564 into main

## Rollback Notes

Database rollback is forward-only per migration, not via migration revert. See PR #564 rollback section for per-migration rollback SQL if needed.

**Principal risks**: lock ordering (137, 139), authorization (134, 136), quota accounting (131-133). All covered by hosted SQL qualification suites.

## References

- PR: https://github.com/optomachina/Overdrafter/pull/564
- Runbook: docs/workflows/ovd418-qualified-database-release.md
- Runbook: docs/workflows/ovd361-production-deployment.md
- Branch: codex/recovered-release-free-safety-20261003 @ 454687c
