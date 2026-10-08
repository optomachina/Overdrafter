# Production database apply packet v3 (2026-10-08): 27 migrations (28 with OVD-641)

Target: production project `ozuatdcakezjtevztjlr`. PROTECTED. Owner-executed only. Nothing in this document is to be run by an agent. v1 and v2 stay as history. v3 replaces both for the apply decision. v1/v2 rollback text for 134-139 is carried into section 7.

## 1. Baseline

| Item | Value | Source |
|---|---|---|
| Ledger rows | 112, max `20260924014552` | owner query A, 2026-10-08 |
| Version list | main's first 104 (through `20260822213330`, the OVD-418 final ledger) plus `20260905030647`, `20260905233435`, `20260923035755`, `20260924001152`, `20260924001203`, `20260924004159`, `20260924004202`, `20260924014552`. No production version is missing from main. | owner query E, artifact `production-migration-versions.json` (owner machine, beside the ledger artifact) |
| Cross-check | `md5(string_agg(version, ',' order by version))` = `b4accb673ce2fa0d4bb0e65783679e36`. The coordinator's subset search over main's versions matched only this set. I recomputed it locally from `origin/main` and it agrees. This is a cross-check only: the version list comes from E, not from the fingerprint. | query A |
| Runbook statements fingerprint F | OBSERVED 2026-10-08 (owner, read-only): F1 = 112 rows, head 20260924014552, fingerprint `212b70060764426f5f83ee6c58fa2085`; F2 = 104 rows through 20260822213330, fingerprint `28b8ae8752e5beb8e91505a2becfde86` (equals the runbook); F3 per-row statement md5 of the 8 post-104 rows recorded in section 4 | section 4, F1-F3 |
| 104-row prefix fingerprint | expected `28b8ae8752e5beb8e91505a2becfde86`, from the OVD-418 runbook final ledger | section 4, F2 |
| Missing, on main (14) | the six 2026-09-10/11 files (main #107-112), plus the eight 2026-09-26..28 files (#119-126) | E minus main |
| Missing, integration only (13) | #127-139, `20261002041305` .. `20261004130000` | B |
| Conditional 28th | `20261008055500_ovd641_allow_owner_approved_permission_basis` (PR #605, open at `f776fe3`, not merged on 2026-10-08) | include only after #605 merges |

Correction to v2: v2 assumed the ledger ended at `20261003011148` (#133). It does not. It ends at `20260924014552` (#118), and the ledger has six older gaps (#107-112). Because of those gaps, the OVD-534..539 restriction set (#113-118) ran in production before #107-112. In CI the order was the reverse. Section 2 decides whether that matters.

Owner confirmations still required before any window: F1 and F2 (section 4). Every other value in this table is confirmed.

## 2. Ordering inversion analysis

### 2.1 Objects touched by #113-118 (applied in production)

| # | File:line | Object | Change |
|---|---|---|---|
| 113 | `20260923035755_restrict_quote_publication_helper_execute.sql:3-5` | `public.insert_published_quote_option(uuid, public.client_option_kind, uuid, integer, numeric, numeric, text, uuid)` | revoke EXECUTE from public, anon, authenticated, service_role |
| 114 | `20260924001152_ovd535_restrict_worker_rpcs.sql:4-10` | `public.api_claim_next_task(text)`, `public.api_auto_approve_job_requirements(uuid)` | revoke public/anon/authenticated; grant service_role |
| 115 | `20260924001203_ovd534_restrict_job_detail.sql:14-18` | `public.build_manufacturing_quote_service_detail(uuid)` | same pattern |
| 116 | `20260924004159_ovd537_restrict_internal_readers.sql:11-34` | `get_active_pricing_policy_id`, `get_enabled_client_quote_vendors`, `get_quote_request_guardrails`, `get_quote_request_pending_estimated_cost_usd`, `get_self_service_membership_role` (each `(uuid)`) | revoke all public/anon/authenticated; grant service_role |
| 117 | `20260924004202_ovd538_restrict_global_spend.sql:7-63` | `public.api_spend_summary()` | `create or replace` body (platform-admin guard); ACL preserved |
| 118 | `20260924014552_ovd539_restrict_quote_status_helpers.sql:5-15` | `sync_quote_request_status_for_run(uuid,text)`, `sync_service_request_line_item_status(uuid)` | revoke public/anon/authenticated; grant service_role |

### 2.2 Per-object result for #107-112

Method: I read all six files in full (`git show origin/main:supabase/migrations/<file>`). I then searched #107-139 and the #605 migration for all 13 object names above, for `default privileges`, for `in schema`, for `pg_proc`, `pg_namespace` and `information_schema`, and for `execute format`, `owner to` and `drop`.

| # | What it creates or replaces | Overlap with 2.1 | Treatment |
|---|---|---|---|
| 107 `20260910045917` | new schema `engineering_private` (`:5-7`, usage to authenticated, service_role), 4 `public.engineering_*` tables, private gate and RPC functions, unique index `engineering_projects_scope_key` on `public.projects(id, organization_id)` (`:21`) | none | (i) apply as-is |
| 108 `20260910055556` | 5 `public.engineering_*` tables and 4 functions | none | (i) |
| 109 `20260910064137` | 3 public and 2 `engineering_private` tables, and 13 functions | none | (i) |
| 110 `20260910104500` | 8 tables and native RPCs. Its DO loops (`:184-210`) iterate only fixed arrays of its own new table names. `create or replace engineering_private.cancel_engineering_suffix` (`:700`) replaces #108's function. | none | (i) |
| 111 `20260910134500` | `create or replace private.append_commercial_admin_audit_event(...)` (`:5-94`) plus revoke (`:96-108`). Its only other definitions are `20260731015213:357-447` (production's current body) and `20260731015226`. It is not in #113-139. | none | (i) |
| 112 `20260911031500` | `private.capability_observations` (forced RLS, `:87`, `:482-483`) and 4 private functions (`owner to postgres`) | none | (i) |

Supporting facts:

- (a) None of #107-112 names any of the 13 objects, alters default privileges, grants on `ALL ... IN SCHEMA`, or derives targets from the catalog.
- (b) #113-118 committed in production without #107-112, which shows they depend on nothing #107-112 creates.
- (c) Every function #107-112 creates in `public` is followed in the same file by `revoke all ... from public, anon, authenticated, service_role` and an explicit grant. So Supabase's default EXECUTE grants on new `public` functions are closed in-file, in either order.
- (d) No compensating statement is required.

Result: the static analysis finds no object that #107-112 would re-open. Jev's 0.75 estimate was a prior made before the files were read. This analysis does not support it.

Residual risk is drift that the repository cannot see, such as a hand-made production grant. V1 (section 4) snapshots the 13 restrictions before the window and re-checks them after phase 1 and at the end. If V1 differs after phase 1, stop. Then apply treatment (ii): re-run the exact statement from 2.1 for the object that changed, for example:
`revoke execute on function public.build_manufacturing_quote_service_detail(uuid) from public, anon, authenticated; grant execute on function public.build_manufacturing_quote_service_detail(uuid) to service_role;`
That statement runs outside the ledger and needs owner review at the time.

Empirical confirmation (R1, recommended, not yet run): replay order A (#1..139) and order B (#1..106, #113..118, #107..139) into two disposable databases. Diff the output of the catalog snapshot query S1 (section 6). Expected diff: empty.

I attempted R1 in this session and did not complete it. The plain `supabase/postgres:17.6.1.095` image lacks the `storage` schema that migration `20251106035356` needs. Extending the stub schemas was then blocked by the session's permission policy. Two local disposable containers that I created, `ovdinv-a` and `ovdinv-b`, may still exist (they contain partial local replays only). R1 should run in the `free-quote-sql` CI harness or a full local `supabase start` stack.

### 2.3 Dependencies of #119-126 on #107-112

#119-126 ran after #107-112 in CI, and they will also run after them in production, because the CLI applies missing versions in ascending order. No pair is reversed. The phase order is still mandatory:

| Dependent | Needs |
|---|---|
| 120 `20260927060736` | `public.engineering_requests`, `engineering_private.*` (107/108) |
| 121 `20260927065514` | `private.record_capability_observation`, `private.capability_observations` (112) |
| 122-124 | `engineering_private` schema, `engineering_execution_attempts`, `native_stop_admissions` (107-110) |
| 119 | calls `public.get_enabled_client_quote_vendors` (116-restricted) from `private.quote_lane_candidates`. CI had the same order (116 before 119). |

### 2.4 Dependencies of #127-139 on #119-126

There is no inversion here: all 13 versions are newer than #126.

| Dependent | Needs |
|---|---|
| 129 | redefines `private.record_capability_observation` and reads `private.capability_observations` (112/121) |
| 131, 132, 135, 136, 139 | `private.quote_lane_candidates` as redefined by 119 |
| 135, 139 | `private.effective_sourcing_address` / sourcing objects (119) |
| 128 | re-creates `insert_published_quote_option` and revokes all, including service_role. This is consistent with 113. |

OVD-641 (`20261008055500`) only drops and re-adds two CHECK constraints on `private.quote_provider_admission_policies`. #126 inserts a disabled row that satisfies both versions. #135, #136 and #139 only read the table. Its position after #139 is therefore safe.

### 2.5 Properties of the 14 main migrations

| Property | Finding |
|---|---|
| Non-idempotent | 107-110, 112 and 119-124 use plain `create` (schema, table, trigger, function, policy). Re-running fails, which is good: it exposes a partial apply. 111 is idempotent. 125 uses `add value if not exists`. 126 uses `on conflict do nothing`. |
| Data-touching | 119 backfills `private.sourcing_destination_history` (one `inferred` row per `public.organizations` row, `:89-91`) and `private.part_deadline_history` (one row per `public.approved_part_requirements` row, `:214-218`). It also adds AFTER triggers on both source tables, so future writes append history. 126 inserts one row (below). Nothing else writes rows. |
| 126 seed | Inserts 1 row into `private.quote_provider_admission_policies`: provider `rmfg`, `admission_state='disabled'`, `generic_dispatch_enabled=false`, `policy_revision='rmfg-disabled-2026-09-28.v1'`, empty processes and extensions, all else null, `change_reason='initial_seed'`. The AFTER INSERT trigger (`20260817133902:211-261`) adds 1 history row with `changed_by_role = session_user`. Safe: it is default-deny and admits nothing. It is irreversible: the DELETE guard (`:178-209`) raises, and enum value `rmfg` (125) cannot be dropped. |
| Drops | None in #107-126. #127 drops policy `client_selections_insert_members` (if it exists). OVD-641 drops and re-adds 2 constraints. |
| Locks | 107: `create unique index` on `public.projects` (SHARE lock, blocks writes while it builds). 119: triggers on `public.organizations` and `public.approved_part_requirements` plus the backfill. 125: `alter type`. Under quiescence these are short. |
| Role, owner, search_path | Functions pin `search_path` to `''` or `pg_catalog`. 112, 121, 129 and 130 run `owner to postgres`, and 107 creates schema `engineering_private` owned by the executing role. Both need the session to act as `postgres`; with the CLI temp role `cli_login_postgres` this is expected. UNCERTAIN until rehearsal; readback checks the owners. 122/123 run `create role ovd575_observer_validator` / `ovd576_stop_validator` (nologin noinherit, guarded, no members). This needs CREATEROLE. These roles do not trip #134's guard, because they are not superuser or bypassrls. |
| Rollout coupling | 119's header (`:4-6`) says to deploy the matching frontend and worker together. Legacy pending permits then fail closed. This packet makes no worker or Cloud Run change, and rollout controls stay off (quiescence), so fail-closed is the intended interim state. Owner decision: confirm that is acceptable. |

## 3. Apply mechanics

| Option | Assessment |
|---|---|
| `supabase db push --db-url ... --include-all` (CLI 2.78.1, pinned by the OVD-361/418 runbooks; also installed locally) | Applies every local file whose version is missing from the remote ledger, in ascending version order, older gaps included, and writes each ledger row in the CLI's own `statements` format. This is the only mutation path the OVD-418 runner admits (`scripts/run-ovd418-production-release.sh:404-408`). Recommended. |
| Manual `psql` plus hand-inserted `schema_migrations` rows | Rejected. The hand-written `statements` payload would diverge from the CLI's, which breaks any F-style fingerprint. 125 and 126 must be separate transactions. Files 121, 127, 128, 129 and 130 contain their own `BEGIN`/`COMMIT`, so `psql -1` cannot wrap them. Jev advisory: 0.01. |

Transactions: the push is not one transaction. The CLI applies each file with its ledger row as one unit and stops at the first failure. Files before the failure stay committed, so a failure leaves an exact prefix of the plan. How the CLI 2.78.1 per-file wrapper interacts with in-file `BEGIN`/`COMMIT` in 121 and 127-130 is UNCERTAIN; the CI replay passes. Rehearsal R2 should induce a failure at #129 and record the resulting ledger.

### 3.1 Plans (Jev advisory, not a decision: one window 0.52, two windows 0.47 (uncertain))

| Plan | Window | Checkout (clean, detached) | Dry-run must list exactly |
|---|---|---|---|
| A (one window) | W1: phases 1-3 (+4) | `f9348a2768088214be0febb5b08def3f40674e20` (139 files). After #605 merges and is synced into the integration branch: that new head, re-pinned (140 files). | 27 versions in section 5 order (28 with OVD-641 last) |
| B (two windows) | W1: phases 1-2 | `7b50f0ddbc457a9372d1c900c9eb607acfcea3c6` (origin/main; exactly 126 files, byte-identical to f9348a2's first 126) | the 14 main versions |
| B | W2: phases 3 (+4) | `f9348a2` or the synced head | the 13 (or 14) integration versions |

The inversion analysis favours Plan A, because no compensation is needed and only verification checkpoints remain. Plan B is still valid and has two advantages. Between the windows, production equals main's tree, which is what the live frontend is built from. And the owner sees V1 and phase 1-2 readback before committing the release migrations. Choose B if R1 is not run first.

A stop between phase 1 and phase 2 is not possible with `db push` from a clean commit, because no commit holds only #1-118. That would need a pruned directory, which breaks the clean-checkout rule, so it is not offered.

### 3.2 Commands (lock session open first, as in the OVD-418 runbook)

```bash
set -euo pipefail
test "$(supabase --version | awk '{print $NF}')" = "2.78.1"
git checkout --detach <PIN>; test -z "$(git status --porcelain)"; test "$(git rev-parse HEAD)" = "<PIN>"
sha256sum -c ovd-v3-manifest.sha256        # section 3.3; every line must print OK
# terminal 1, held for the whole window:
psql "$OVD418_POOLER_URL" -f scripts/hold-ovd418-production-locks.sql   # needs the six OVD-373/418 + rollout locks and quiescence; prints 'locks acquired'
# terminal 2:
export PGPASSFILE="$OVD361_PRODUCTION_PGPASS_FILE"; OVD418_POOLER_URL="$(tr -d '\r\n' < supabase/.temp/pooler-url)"
supabase db push --db-url "$OVD418_POOLER_URL" --include-all --dry-run --yes > dry1.txt 2>&1
supabase db push --db-url "$OVD418_POOLER_URL" --include-all --dry-run --yes > dry2.txt 2>&1
cmp dry1.txt dry2.txt
# read the 'Would push these migrations:' bullets; they must equal the plan list in order. Any difference: STOP.
supabase db push --db-url "$OVD418_POOLER_URL" --include-all --yes
```

`scripts/run-ovd418-production-release.sh` and its authorization schema are pinned to the 4-migration OVD-417 package and the 104-row final state. They cannot run this suffix unchanged, and neither can `verify-ovd418-production-postconditions.sql`, which asserts exactly 104 rows. A frozen manifest and authorization for this suffix is the OVD-635 preparation. Until it exists, the commands above are the manual equivalent, under the owner's own authorization.

### 3.3 Pins (`ovd-v3-manifest.sha256`; SHA-256 of file bytes)

For #127-139, every SHA-256 below equals the pin in the #564 body and in v1/v2. For the 14 main files, the git blob is from `git rev-parse origin/main:supabase/migrations/<file>`; the f9348a2 blobs are identical.

| # | File | git blob | SHA-256 |
|---|---|---|---|
| 107 | 20260910045917_engineering_durable_inbox.sql | 68aaf6206772eb20d73ba9feeab021c76f2b9954 | 3c1dfa563a2b0f7a8542f77cd2e097f79e512e80fcf6f6fe0201d3c8d868c777 |
| 108 | 20260910055556_engineering_ordered_changes.sql | 32ea12849432d75041ccc037238bc62efbccabbd | 42086d9036fc5ef2f3f7a32495facaea4eb73637d20d1c1e0647004540bde5a0 |
| 109 | 20260910064137_engineering_worker_sessions.sql | 38a74630063dfe7d133b453f187a7e741899bd0b | 9783d20b5c6182f444963b347b327626cb3fd53e0fac7d49bf26e120710e9cdd |
| 110 | 20260910104500_engineering_native_ownership.sql | 7db03572ad12c7396149e4b02aeeeefae645e0e1 | 44c21b987bfd03fa4cbe1242992c2ed4c3ec3d3d5db98485d0a7a54b7490c2b5 |
| 111 | 20260910134500_bind_entitlement_revocation_audit_scope.sql | 168828008dc30c564bce1420ea6bad0cdb53b9e2 | c1764cddb20c4b14569ffa3bb3f0e926e33664bdb5be54724109fe3d8acee338 |
| 112 | 20260911031500_add_capability_observation_ledger.sql | 821ac84ef973f6fc4a311c2c6081b56844c0e18d | 8a527214f3601c1238f38fe3084c553a61eb96d5975c8696b35307a041d86341 |
| 119 | 20260926225000_confirm_sourcing_intent.sql | f5675cd50e718d2bba8540d672bcacb76bc03508 | 249815c28c9255044413ff2e9bd2a726a0e0728cb117895b25c3bbc91c9d8ffc |
| 120 | 20260927060736_engineering_interpretation_reservations.sql | 933ded3b358f88a287eb961eb7b19a6b1261672a | d45dc38214f9a05b9e089e1d8bc0d2951d6e881cd70323009a9fc11dd7176837 |
| 121 | 20260927065514_ovd513_capability_record_resolver_rpcs.sql | 9771e85284db059ddfc49e8750ac548f7f57bd97 | f4442724209e68d880ec782ed40117597786a0d227863e5f31d14f317d820d75 |
| 122 | 20260927130000_ovd575_native_observer_registry.sql | e005c09ece3f17d3f06a3a1cd33adc5e00ff0d70 | 3fef2299c7cc512460d47342feb0c97a8c7cb538b29052dcd912bc063815f291 |
| 123 | 20260927140000_ovd576_atomic_native_stop.sql | b93c9dbf134a7240b458ec71ba522b69bef7b197 | a148de19878779dd5867a5bacce550a6872191075a541b6d36c9c5a228f4b970 |
| 124 | 20260927225843_ovd576_stop_caller_fence.sql | 9f620e91397ab190734099dfa58dfe478e04c42c | 16b0d64b6cc3da447d4372a6afaa9c64bf2c18b7f6e3d2cd1f43c97b4198d9cf |
| 125 | 20260928081530_add_rmfg_vendor_name.sql | 7d5f557a86079714867d5e3986af0250b79fa49e | e9eed80924bdea98ab22b082672d82744972ef381a33d797cdb02577a82488cb |
| 126 | 20260928081534_seed_rmfg_disabled_admission.sql | 0dc161a68669870a8fe7d5bc4b7eddcd2e487638 | 83881da61d311d20f770f4d3893113f2c2d2ef06b20061ae0a8bd7fc0b8e604d |
| 127 | 20261002041305_enforce_quote_selection_expiry.sql | 325743c90c889e8691b03491342e388c24b95d13 | 30b0e6c41d1c727df269177bb90292d0117674d7b05bc92cdc4dc2fc84ef3da6 |
| 128 | 20261002053133_align_selection_and_publication_sources.sql | 16accdd7e0f53695f3a05196d5e6a40b83f9f9d3 | 70359183621feca322414cd4a2968c3611578ac7b571cbbf455603cd272aa3bf |
| 129 | 20261002090339_add_atomic_capability_window_attention_persistence.sql | 2a0bbe6ff32ca987de15068d80668ce72c2c5c1e | 6ca3a955b01fa7781c616f850778c7e76b1dd7a34cb57fa9f0677dfc1fd27297 |
| 130 | 20261002133713_add_capability_preparation_retention.sql | 7f6d03049508100ae884710b1458d5a6afbcbe7a | 9ccc23d277d901a5808a65d7b622536fe761a29e490c6d74200b35e311196214 |
| 131 | 20261002182714_free_quote_job_meter.sql | 46ef393b555ec7d68dbfc5bb9e6f434dc4e25950 | 32ea33b168021233cd5e3ed8414ec0c94f97d5fc3cc6ee7c35f6423a81c98db2 |
| 132 | 20261002182910_free_confirmed_quote_access.sql | 5ca101011f93cb253e86c97dee5d72791bb0720b | d0c25c26d8fa2275bc554d6089665d350ef9cc5a5323ae27a4e7e3671b7a2676 |
| 133 | 20261003011148_reconcile_free_quote_job_reservations.sql | 5a1290e4ee0a73d4a3b66fa2fc78fe8ed4f833d7 | e2e940492e2c9bb3220cd31471a43fb8711db532311f225c794c245aced671ea |
| 134 | 20261003150000_ovd536_restrict_audit_event_writer.sql | f099a3ec2731ed821d3b22706b3c1ff7ad147ef2 | a625b16028242489c5e86e723815f1ee2d7e49f9c8d885d4cf6de12c1308bfa5 |
| 135 | 20261003160000_ovd458_generic_provider_dispatch_permits.sql | 5356259f8de01ada3d6043d768ad45296c2a2323 | a991e6560d784c9f27516e1cba554ffcf1df440891d4ab22e523827752f472fc |
| 136 | 20261003170000_ovd459_provider_dispatch_preflight.sql | 8c7a1797f3f400612bb5c6e1c9b7b7fd3892a2a3 | 7e6d7ce55d2badd3bedc745ab5fe6adb51413160965d49db15ddf3e6fe1bcb10 |
| 137 | 20261004100000_ovd598_serialize_legacy_xometry_admission.sql | cecd945cfd2cefb90a0ff63714a119da60992e56 | 666863ee3aada933945fcb14caa6821e711c5d16651d1781f66f6d0415dcbebd |
| 138 | 20261004110000_reject_empty_job_file_uploads.sql | bb4f9508990f25e03a3479d670b5fb02d62caa15 | 4029cba9743f4b80cba4f058345636e1d8f41264a26cad9efc49f89b38384277 |
| 139 | 20261004130000_ovd628_generic_admission_nowait.sql | 4226a4673f7ce1dfc40fdb94ac6d0b6bf694a6ef | 441494e77b7e09d9e931ed2f458dfff719ece8fc45fb2cc3a886466b93374da5 |
| 140? | 20261008055500_ovd641_allow_owner_approved_permission_basis.sql | 7cc078bab880d231fd1ed7ffb20138459bf26797 (PR head f776fe3) | d8076199f865a4ddf1eac5ac8c8c3c68479de1d14cfcb4e364f0fd24719d4fe6. Re-pin from the merged commit; it may change before merge. |

## 4. Pre-apply read-only checks (inside the lock session; any mismatch: STOP)

C (from v1/v2; #571). Expected: exactly `postgres`, `service_role`, `supabase_admin`; owner `postgres`; ACL `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` (matches fact C). Re-run it under the window credential. If `cli_login_postgres` appears, it inherits EXECUTE through `postgres` and is not stranded.

```sql
select r.rolname, r.rolsuper, r.rolbypassrls, pg_get_userbyid(p.proowner) as function_owner,
  p.proacl::text as current_acl, has_function_privilege(r.oid, p.oid, 'EXECUTE') as executes_now
from pg_roles r cross join pg_proc p
where p.oid = 'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::regprocedure
  and (r.rolsuper or r.rolbypassrls or r.oid = (select relowner from pg_class where oid = 'public.jobs'::regclass))
  and has_table_privilege(r.oid, 'public.jobs', 'DELETE')
order by r.rolname;
```

D (#571). Expected: 36 rows, all `prosecdef=t`, owner `postgres`, `owner_can_execute=t` (matches fact D).

```sql
select p.oid::regprocedure as caller, p.prosecdef, pg_get_userbyid(p.proowner) as caller_owner,
  has_function_privilege(p.proowner, 'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::regprocedure, 'EXECUTE') as owner_can_execute
from pg_proc p where p.prosrc ~* '(^|[^a-z_])log_audit_event\s*\(' and p.proname <> 'log_audit_event' order by 1;
```

E. The confirmed list (section 1). Re-run at the window. Expected: count 112, max `20260924014552`, version md5 `b4accb673ce2fa0d4bb0e65783679e36`.

```sql
select count(*), max(version), md5(string_agg(version, ',' order by version)) from supabase_migrations.schema_migrations;
```

F1 (OVD-418 runbook formula, full ledger). OBSERVED 2026-10-08 (owner, read-only, project ozuatdcakezjtevztjlr): 112 | 20260924014552 | `212b70060764426f5f83ee6c58fa2085`. At the window it must be unchanged; any difference means the ledger moved since this packet and the window stops.

F3 observed (version | n_statements | statements md5): 20260905030647 | 13 | 3a3f59730bf162149fc3d7419d2b854c; 20260905233435 | 5 | 79329189237eb33933388ced1b1e7ef2; 20260923035755 | 1 | 6274f650b8bf483e4bf8f70c9f897fd3; 20260924001152 | 6 | cadc44ff29499f21d7cc2018c600832c; 20260924001203 | 2 | 6581495b261db3305e2967072648a204; 20260924004159 | 10 | 24f2b5f9d48903a82ee3458fc1dc48e7; 20260924004202 | 1 | 2ee5083b9d3fac71e4afc5ded291ecb1; 20260924014552 | 4 | 7d0f79f7917e0082775cc275c3f7f79c. Owner artifact: output/owner-tasks-2026-10-08/production-statement-fingerprints.json.
F2 (104-row prefix). Expected: `104 | 20260822213330 | 28b8ae8752e5beb8e91505a2becfde86`.
F3 (per-row detail for the 8 post-104 rows). Record it. It shows how those rows were written, and they were not applied through the OVD-418 runner. Unknown: who applied them, and how.

```sql
select count(*), max(version), md5(string_agg(version || ':' || md5(to_json(statements)::text), E'\n' order by version))
from supabase_migrations.schema_migrations;                                   -- F1
select count(*), max(version), md5(string_agg(version || ':' || md5(to_json(statements)::text), E'\n' order by version))
from supabase_migrations.schema_migrations where version <= '20260822213330'; -- F2
select version, name, coalesce(array_length(statements, 1), 0) as n_statements, md5(to_json(statements)::text)
from supabase_migrations.schema_migrations where version > '20260822213330' order by version; -- F3
```

Q (quiescence, OVD-418 include; emits no rows and raises on failure). This also runs inside the lock holder through `verify-ovd418-production-preconditions.sql`, which emits aggregate JSON and does not classify the ledger.

```bash
psql "$OVD418_POOLER_URL" -v ON_ERROR_STOP=1 -c "begin read only" -c "set local ovd418.audit_phase = 'precondition'" -f scripts/verify-ovd418-production-quiescence.sql -c "commit"
```

P (partial earlier apply). Expected: every column false or 0. Any true value: an object from the plan already exists outside the ledger. STOP for incident review.

```sql
select
  to_regnamespace('engineering_private') is not null                                   as m107_schema,
  exists (select 1 from pg_class where relname = 'engineering_projects_scope_key')       as m107_index,
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'engineering\_%' and relkind = 'r') as m107_110_public_tables,
  to_regproc('public.api_submit_engineering_message') is not null                        as m107_rpc,
  to_regproc('public.api_resolve_engineering_request') is not null                       as m108_rpc,
  to_regproc('public.api_create_worker_pairing') is not null                             as m109_rpc,
  to_regproc('public.api_claim_native_task') is not null                                 as m110_rpc,
  (select prosrc like '%organization_entitlement_revoke:%' from pg_proc where oid = to_regproc('private.append_commercial_admin_audit_event')) as m111_body,
  to_regclass('private.capability_observations') is not null                             as m112_table,
  to_regclass('private.sourcing_destination_history') is not null                        as m119_table,
  to_regproc('public.api_reserve_prepared_interpretation') is not null                   as m120_rpc,
  to_regproc('public.api_record_capability_observation') is not null                     as m121_rpc,
  exists (select 1 from pg_roles where rolname in ('ovd575_observer_validator', 'ovd576_stop_validator')) as m122_123_roles,
  exists (select 1 from pg_enum where enumtypid = 'public.vendor_name'::regtype and enumlabel = 'rmfg') as m125_enum,
  to_regclass('private.capability_runtime_windows') is not null                          as m129_table,
  to_regclass('private.free_quote_policies') is not null                                 as m131_table,
  to_regclass('private.provider_dispatch_permits') is not null                           as m135_table,
  to_regproc('private.lock_provider_dispatch_scope_rows') is not null                    as m139_fn;
```

V1 (113-118 restriction snapshot). Run it before the window, after phase 1 or 2, and at the end. Expected at every run: anon=f and authenticated=f on every row except `api_spend_summary` (authenticated=t). service_role=t except `insert_published_quote_option` (service_role=f). `md5(pg_get_functiondef)` is unchanged on every row.

```sql
select f::regprocedure, has_function_privilege('anon', f::regprocedure, 'EXECUTE') as anon,
  has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') as authn,
  has_function_privilege('service_role', f::regprocedure, 'EXECUTE') as svc,
  (select proacl::text from pg_proc where oid = f::regprocedure) as acl, md5(pg_get_functiondef(f::regprocedure)) as def_md5
from unnest(array[
 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)',
 'public.api_claim_next_task(text)', 'public.api_auto_approve_job_requirements(uuid)',
 'public.build_manufacturing_quote_service_detail(uuid)', 'public.get_active_pricing_policy_id(uuid)',
 'public.get_enabled_client_quote_vendors(uuid)', 'public.get_quote_request_guardrails(uuid)',
 'public.get_quote_request_pending_estimated_cost_usd(uuid)', 'public.get_self_service_membership_role(uuid)',
 'public.api_spend_summary()', 'public.sync_quote_request_status_for_run(uuid,text)',
 'public.sync_service_request_line_item_status(uuid)']) f order by 1;
```

The `def_md5` of `insert_published_quote_option` is expected to change at #128, which replaces its body; record the new value.

## 5. Apply order (ascending version = CLI order). Each file is its own unit.

| Phase | # | Version | Purpose (one line) |
|---|---|---|---|
| 1 | 107 | 20260910045917 | OVD-496: `engineering_private` schema, operator gate (none seeded), 4 engineering inbox tables, submit RPC (authenticated) |
| 1 | 108 | 20260910055556 | OVD-497: ordered change queue, interpretations, decisions, tasks, events; resolve (service) and cancel (authenticated) RPCs |
| 1 | 109 | 20260910064137 | OVD-498: worker identity, pairing, credential digests, sessions; 5 RPCs; nothing seeded |
| 1 | 110 | 20260910104500 | OVD-501: native ownership, attempts, slots, stop and retry RPCs; replaces `cancel_engineering_suffix` |
| 1 | 111 | 20260910134500 | OVD-504: `append_commercial_admin_audit_event` accepts the server-built UUID revocation scope |
| 1 | 112 | 20260911031500 | OVD-512: private append-only capability observation ledger (forced RLS) |
| Stop point 1 | | | Plan A: this is a post-push checkpoint only. Plan B: not a stop (W1 continues). |
| 2 | 119 | 20260926225000 | OVD-570: sourcing destination and part deadline confirmation; 2 history tables (backfilled); new lane scope builder |
| 2 | 120 | 20260927060736 | engineering interpretation reservations (service RPCs) |
| 2 | 121 | 20260927065514 | OVD-513: two service_role ledger wrappers (record, resolve) |
| 2 | 122 | 20260927130000 | OVD-575: native observer registry and validator role (no members) |
| 2 | 123 | 20260927140000 | OVD-576: qualified native stop admission and stop-validator role |
| 2 | 124 | 20260927225843 | OVD-576: fence-checked wrapper; grant moved to it |
| 2 | 125 | 20260928081530 | OVD-582: enum value `rmfg` (must commit before 126) |
| 2 | 126 | 20260928081534 | OVD-582: disabled `rmfg` admission row |
| Stop point 2 | | | Plan B: end of W1. Run readback (section 6, items 1-5 and 7, expecting 126 rows) and V1. The next window needs a separate go. |
| 3 | 127-133 | 20261002041305 .. 20261003011148 | as in the #564 table (selection expiry, selection and publication sources, capability window and retention, free meter, free access, reservation reconcile) |
| 3 | 134 | 20261003150000 | OVD-536: revoke PUBLIC/anon/authenticated EXECUTE on `log_audit_event` (guarded DO) |
| 3 | 135-139 | 20261003160000 .. 20261004130000 | OVD-458 permits, OVD-459 preflight, OVD-598, OVD-601, OVD-628 |
| 4 (if #605 merged and synced) | 140 | 20261008055500 | OVD-641: `owner_approved` permission basis; no policy row changes |

Single transaction per phase: no. The CLI commits per file, and 125 must commit before 126 can use `'rmfg'`.

On failure: the ledger holds the baseline plus an exact prefix of the plan. Classify it with E. Do not re-push until the cause is reviewed; then a fresh dry-run must list exactly the remaining versions.

#134 guard abort (`ovd536: archive-capable roles would lose EXECUTE ...: <role>`): the DO block rolls back, so #134 is not recorded and #127-133 stay committed. STOP. Do not edit the migration. The owner decides one of two things:

- (a) The role is legitimate. Run a separately reviewed `grant execute on function public.log_audit_event(uuid,text,jsonb,uuid,uuid) to <role>;`, then re-run C, then re-push. The dry-run must list exactly 134-139 (+140).
- (b) The role's BYPASSRLS is unintended. That is an incident, outside this packet.

Fact C predicts the guard passes.

## 6. Readback (read-only; values are recorded, not predicted, unless stated)

1. Ledger. Plan A or B end: `139 | 20261004130000 | 7ade7aae500043443d93d52625f46932` (version md5). With OVD-641: `140 | 20261008055500 | b3f904e7bf6d6a848af3182b62dbaff1`. Plan B after W1: `126 | 20260928081534 | 8f7606e1b8568ca17cf0be12ce5f56a1`. F2 is still `28b8ae8752e5beb8e91505a2becfde86`. F1 is recorded only. Rule: the statements fingerprint after the push is recorded, never predicted or used to pass or fail.
2. `log_audit_event` after 134: C returns the same 3 roles, all `executes_now=t`. ACL is `{postgres=X/postgres,service_role=X/postgres}`. `has_function_privilege('anon'|'authenticated', ..., 'EXECUTE')` is false for both. D returns all `prosecdef=t` and owner `postgres`; the row count is recorded, because 127, 131 and 138 add or replace callers.
3. V1 unchanged (apart from the expected #128 `def_md5` change).
4. Engineering objects. All are present and owned by `postgres`. `select count(*) from engineering_private.engineering_operators` returns 0, so the feature is default-off. Anon has no EXECUTE on any `public.api_*` function created by 107-110 and 120-121. Authenticated has EXECUTE only on `api_submit_engineering_message`, `api_cancel_engineering_suffix`, `api_create_worker_pairing`, `api_control_worker_session`, `api_reconcile_native_stop` and `api_retry_native_task`.
   `select nspowner::regrole from pg_namespace where nspname='engineering_private'` returns `postgres`.
5. Observer and stop registry. `to_regclass` is non-null for `engineering_private.native_observer_profiles`, `native_observer_evidence`, `native_stop_qualifications`. The roles `ovd575_observer_validator` and `ovd576_stop_validator` exist with `rolcanlogin=f`, `rolinherit=f`, `rolbypassrls=f`, and they have no members (`select count(*) from pg_auth_members where roleid in (...)` returns 0).
6. Free and dispatch release objects: the v2 readback items (definitions match a local `supabase db reset` at the same commit, by `md5(pg_get_functiondef)`), plus the synthetic denials from v2 section 5.3, which use a throwaway verified user and are rolled back.
7. `rmfg`:
   `select provider, admission_state, generic_dispatch_enabled, policy_revision from private.quote_provider_admission_policies where provider='rmfg'` returns `rmfg | disabled | f | rmfg-disabled-2026-09-28.v1`. History has 1 row for `rmfg`; its `changed_by_role` is recorded.
8. RLS. Forced (`relrowsecurity and relforcerowsecurity`) on the 14 release tables:
   - 129: `capability_runtime_revisions`, `capability_runtime_windows`, `capability_attention_state`, `capability_attention_outbox`, `capability_attention_evaluations`
   - 130: `capability_claim_preparations`, `capability_completion_preparations`, `capability_attention_preparations`
   - 131: `free_quote_policies`, `free_quote_buckets`, `quote_access_admissions`
   - 135: `provider_dispatch_envelope_reviews`, `provider_dispatch_permits`, `provider_dispatch_permit_revocations`

   Also forced: `private.capability_observations` (112) and `private.sourcing_destination_history` and `private.part_deadline_history` (119). The engineering tables have RLS enabled but not forced, by design.
9. Catalog snapshot S1 (also used for R1). Store it privately with the window evidence:

```sql
select 'fn' k, oid::regprocedure::text o, coalesce(proacl::text,'<default>') a, md5(pg_get_functiondef(oid)) d from pg_proc where pronamespace in (select oid from pg_namespace where nspname in ('public','private','engineering_private'))
union all select 'rel', oid::regclass::text, coalesce(relacl::text,'<default>'), relrowsecurity::text || relforcerowsecurity::text from pg_class where relkind in ('r','v','S') and relnamespace in (select oid from pg_namespace where nspname in ('public','private','engineering_private'))
union all select 'pol', schemaname||'.'||tablename||'.'||policyname, array_to_string(roles,','), md5(coalesce(qual,'')||coalesce(with_check,'')) from pg_policies
union all select 'dacl', defaclrole::regrole::text||'/'||defaclnamespace::text||'/'||defaclobjtype, defaclacl::text, '' from pg_default_acl order by 1,2;
```

## 7. Rollback (forward-only in production; no history deletion)

| # | Containment or rollback | Data-loss note |
|---|---|---|
| 107 | Revoke EXECUTE on `public.api_submit_engineering_message(...)` and `engineering_private.submit_engineering_message(...)` from authenticated. The feature is already off: there are no operator rows. | Dropping objects only works before 108-110/120/122-124, and it is not recommended. |
| 108 | Revoke `api_resolve_engineering_request` (service_role) and `api_cancel_engineering_suffix` (authenticated), plus their `engineering_private` implementations. | none |
| 109 | Revoke `api_create_worker_pairing` and `api_control_worker_session` (authenticated), and `api_consume_worker_pairing`, `api_register_worker_boot`, `api_worker_session_eligibility` (service_role). | none |
| 110 | Revoke `api_claim_native_task`, `api_heartbeat_native_attempt`, `api_native_attempt_eligibility`, `api_record_native_stop`, `api_request_native_retry` (service_role) and `api_reconcile_native_stop`, `api_retry_native_task` (authenticated). Optionally re-apply #108's `cancel_engineering_suffix` body (`20260910055556:322-385`). | none |
| 111 | Re-run `20260731015213_secure_commercial_admin_operations.sql:357-447` (the prior body plus its revoke). | none; audit rows retained |
| 112 | Nothing to revoke: the function is owner-only. The table stays, and triggers block update, delete and truncate. | none |
| 119 | Only before phase 3: drop triggers `record_sourcing_address_change` (on `public.organizations`) and `record_part_deadline_change` (on `public.approved_part_requirements`), re-apply `20260812044000:86-136` and `:139-192` (lane builder and candidates) with their revokes, and revoke the 4 authenticated RPCs and `api_get_worker_sourcing_intent`. After phase 3: forward-fix only, because 131/132/135/136/139 depend on the new builder. | History rows retained. Re-applying the old builder changes lane fingerprints again. |
| 120 | Revoke the three `api_*_prepared_interpretation` functions from service_role. | none |
| 121 | Revoke both functions from service_role (the file header's steps 1-3). | none |
| 122 | `revoke execute on function engineering_private.store_native_observer_evidence(uuid,bytea,bytea) from ovd575_observer_validator;` | The role stays. |
| 123/124 | Revoke `engineering_private.admit_qualified_native_stop` (both overloads) from `ovd576_stop_validator`. | The role stays. |
| 125 | Not reversible: PostgreSQL cannot drop an enum value. Harmless. | n/a |
| 126 | Not reversible (the DELETE guard raises). The row is already disabled. | n/a |
| 127/128 | Forward-only. Re-granting `client_selections` INSERT/UPDATE or recreating `client_selections_insert_members` re-opens the bypass (#564 body). | none |
| 129-133 | Revoke the new `api_*` entrypoints from their roles. The 14 private tables stay as unused objects. | none |
| 134 | `grant execute on function public.log_audit_event(uuid,text,jsonb,uuid,uuid) to public, anon, authenticated;`. This re-opens the forgeable writer. Preferred instead: grant EXECUTE to the exact failing role. | none |
| 135 | Revoke EXECUTE on `api_request_provider_dispatch` from the API roles; the Xometry path is unaffected. | none |
| 136 | `revoke execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz) from service_role`, then drop both functions. Also revoke the SECURITY DEFINER wrapper (#574). | none |
| 137 | Re-apply the `20261002182910` definition of `api_request_xometry_beta_dispatch` with its revoke and grant; drop `private.lock_xometry_beta_dispatch_scope_rows(uuid)`. | none |
| 138 | Re-run the two `create or replace` statements for prepare and finalize from `20260815093000`. | none |
| 139 | Re-apply the `20261003160000` definitions of `api_request_provider_dispatch` and `private.resolve_provider_dispatch_scope`; drop `private.lock_provider_dispatch_scope_rows`. | none |
| 140 | Per its header: move any `owner_approved` policy to a new revision first, then restore both constraints to their `20260817133902` definitions. | none at apply time |

## 8. Boundaries

- PROTECTED. Owner-executed, with an explicit go at action time for each window. No agent runs any command in this document against a hosted database. Agents may run R1 and R2 only on disposable local or CI databases.
- Merge #564 into main only after the final readback (Plan A: after W1; Plan B: after W2). The merge auto-deploys the Vercel frontend.
- No Cloud Run, worker, credential, Edge Function, secret or billing change in either window. Rollout controls stay off (Q). The worker and frontend coupling flagged in #119 is the owner's decision.
- No linked default, history repair, seed command, dashboard SQL or MCP `apply_migration`. The only mutation is the pinned `supabase db push --include-all --yes` from the pinned clean commit.
- Phone-loop activation SQL under `docs/release/` (OVD-520) is out of scope, as in v1/v2.

## 9. Open uncertainties

1. F1, F2 and F3 were observed on 2026-10-08 (F2 equals the runbook value). Still unknown: how the 8 post-104 rows were applied; their statement payloads are now pinned by F3.
2. R1 (inversion replay diff) and R2 (induced partial-failure shape) have not run. The section 2 conclusion rests on static reading of every statement.
3. The session identity under `cli_login_postgres` is unconfirmed. It affects object owners for `create schema` and `owner to postgres`, the ability to `create role` (122/123), and the value of `session_user` in #126's history row.
4. How CLI 2.78.1 handles in-file `BEGIN`/`COMMIT` (121, 127-130) inside its per-file unit is unconfirmed.
5. Unknown: how the 8 post-104 rows were applied in production, and whether any out-of-ledger production grant exists. V1 and S1 detect drift; they cannot explain it.
6. Unknown: whether the live frontend, built from main, already calls 119-era RPCs that are missing in production today. Not verified.
7. OVD-641 is conditional: #605 is open, and its pins must be re-taken from the merged commit and the synced integration head.
