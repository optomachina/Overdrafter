# Production Apply Packet v3: Migration Manifest

**Date**: October 10, 2026  
**Project**: ozuatdcakezjtevztjlr (Website - Production Supabase)  
**Source branch**: `codex/recovered-release-free-safety-20261003`  
**Source commit**: 454687c  
**Target PR**: #564

## Current State

- **Current ledger**: 112 rows, ending at `20260924014552`
- **Fingerprint formula**: `md5(string_agg(version||':'||name, ',' ORDER BY version))`
- **Pre-apply fingerprint**: `fa6ab54024ac2fc2d570a67b963a7a4f`
- **Last verified**: October 10, 2026

## Target State

- **Target ledger**: 140 rows, ending at `20261008055500`
- **Post-apply fingerprint**: `e3ab3b22bc1bfc9ad67092dfc877a3a8`
- **New migrations**: 28 (14 from main + 13 from branch + 1 from OVD-641)

## Apply Sequence

All 28 migrations must be applied in the order below. This is a forward-only apply; no migration may be skipped or reordered.

### Group 1: Missing from main (14 migrations)

These migrations exist on `main` but were not applied to production.

| # | Version | Filename | SHA-256 |
|---|---------|----------|---------|
| 113 | 20260910045917 | 20260910045917_engineering_durable_inbox.sql | 3c1dfa563a2b0f7a8542f77cd2e097f79e512e80fcf6f6fe0201d3c8d868c777 |
| 114 | 20260910055556 | 20260910055556_engineering_ordered_changes.sql | 42086d9036fc5ef2f3f7a32495facaea4eb73637d20d1c1e0647004540bde5a0 |
| 115 | 20260910064137 | 20260910064137_engineering_worker_sessions.sql | 9783d20b5c6182f444963b347b327626cb3fd53e0fac7d49bf26e120710e9cdd |
| 116 | 20260910104500 | 20260910104500_engineering_native_ownership.sql | 44c21b987bfd03fa4cbe1242992c2ed4c3ec3d3d5db98485d0a7a54b7490c2b5 |
| 117 | 20260910134500 | 20260910134500_bind_entitlement_revocation_audit_scope.sql | c1764cddb20c4b14569ffa3bb3f0e926e33664bdb5be54724109fe3d8acee338 |
| 118 | 20260911031500 | 20260911031500_add_capability_observation_ledger.sql | 8a527214f3601c1238f38fe3084c553a61eb96d5975c8696b35307a041d86341 |
| 119 | 20260926225000 | 20260926225000_confirm_sourcing_intent.sql | 249815c28c9255044413ff2e9bd2a726a0e0728cb117895b25c3bbc91c9d8ffc |
| 120 | 20260927060736 | 20260927060736_engineering_interpretation_reservations.sql | d45dc38214f9a05b9e089e1d8bc0d2951d6e881cd70323009a9fc11dd7176837 |
| 121 | 20260927065514 | 20260927065514_ovd513_capability_record_resolver_rpcs.sql | f4442724209e68d880ec782ed40117597786a0d227863e5f31d14f317d820d75 |
| 122 | 20260927130000 | 20260927130000_ovd575_native_observer_registry.sql | 3fef2299c7cc512460d47342feb0c97a8c7cb538b29052dcd912bc063815f291 |
| 123 | 20260927140000 | 20260927140000_ovd576_atomic_native_stop.sql | a148de19878779dd5867a5bacce550a6872191075a541b6d36c9c5a228f4b970 |
| 124 | 20260927225843 | 20260927225843_ovd576_stop_caller_fence.sql | 16b0d64b6cc3da447d4372a6afaa9c64bf2c18b7f6e3d2cd1f43c97b4198d9cf |
| 125 | 20260928081530 | 20260928081530_add_rmfg_vendor_name.sql | e9eed80924bdea98ab22b082672d82744972ef381a33d797cdb02577a82488cb |
| 126 | 20260928081534 | 20260928081534_seed_rmfg_disabled_admission.sql | 83881da61d311d20f770f4d3893113f2c2d2ef06b20061ae0a8bd7fc0b8e604d |

### Group 2: Branch migrations 127-139 (13 migrations)

These migrations were developed on the release branch and add free-quote safety, capability persistence, and provider dispatch infrastructure.

| # | Version | Filename | SHA-256 | Issue | Notes |
|---|---------|----------|---------|-------|-------|
| 127 | 20261002041305 | 20261002041305_enforce_quote_selection_expiry.sql | 30b0e6c41d1c727df269177bb90292d0117674d7b05bc92cdc4dc2fc84ef3da6 | recovered | Revokes direct INSERT on client_selections, drops policy |
| 128 | 20261002053133 | 20261002053133_align_selection_and_publication_sources.sql | 70359183621feca322414cd4a2968c3611578ac7b571cbbf455603cd272aa3bf | recovered | Revokes UPDATE grants (including service_role) |
| 129 | 20261002090339 | 20261002090339_add_atomic_capability_window_attention_persistence.sql | 6ca3a955b01fa7781c616f850778c7e76b1dd7a34cb57fa9f0677dfc1fd27297 | OVD-591 | 5 new private tables |
| 130 | 20261002133713 | 20261002133713_add_capability_preparation_retention.sql | 9ccc23d277d901a5808a65d7b622536fe761a29e490c6d74200b35e311196214 | OVD-591 | 3 new private tables |
| 131 | 20261002182714 | 20261002182714_free_quote_job_meter.sql | 32ea33b168021233cd5e3ed8414ec0c94f97d5fc3cc6ee7c35f6423a81c98db2 | recovered | 3 new private tables |
| 132 | 20261002182910 | 20261002182910_free_confirmed_quote_access.sql | d0c25c26d8fa2275bc554d6089665d350ef9cc5a5323ae27a4e7e3671b7a2676 | recovered | Quote access policy |
| 133 | 20261003011148 | 20261003011148_reconcile_free_quote_job_reservations.sql | e2e940492e2c9bb3220cd31471a43fb8711db532311f225c794c245aced671ea | recovered | Reconciliation RPC |
| 134 | 20261003150000 | 20261003150000_ovd536_restrict_audit_event_writer.sql | a625b16028242489c5e86e723815f1ee2d7e49f9c8d885d4cf6de12c1308bfa5 | OVD-536 | Revokes log_audit_event from PUBLIC/anon/authenticated |
| 135 | 20261003160000 | 20261003160000_ovd458_generic_provider_dispatch_permits.sql | a991e6560d784c9f27516e1cba554ffcf1df440891d4ab22e523827752f472fc | OVD-458 | 3 new private tables, default off |
| 136 | 20261003170000 | 20261003170000_ovd459_provider_dispatch_preflight.sql | 7e6d7ce55d2badd3bedc745ab5fe6adb51413160965d49db15ddf3e6fe1bcb10 | OVD-459 | Service-role preflight RPC |
| 137 | 20261004100000 | 20261004100000_ovd598_serialize_legacy_xometry_admission.sql | 666863ee3aada933945fcb14caa6821e711c5d16651d1781f66f6d0415dcbebd | OVD-598 | NOWAIT locks |
| 138 | 20261004110000 | 20261004110000_reject_empty_job_file_uploads.sql | 4029cba9743f4b80cba4f058345636e1d8f41264a26cad9efc49f89b38384277 | OVD-601 | Upload validation |
| 139 | 20261004130000 | 20261004130000_ovd628_generic_admission_nowait.sql | 441494e77b7e09d9e931ed2f458dfff719ece8fc45fb2cc3a886466b93374da5 | OVD-628 | NOWAIT on generic admission |

### Group 3: OVD-641 (1 migration)

This migration merged into main after the release branch was created.

| # | Version | Filename | SHA-256 | Issue |
|---|---------|----------|---------|-------|
| 140 | 20261008055500 | 20261008055500_ovd641_allow_owner_approved_permission_basis.sql | d8076199f865a4ddf1eac5ac8c8c3c68479de1d14cfcb4e364f0fd24719d4fe6 | OVD-641 |

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
