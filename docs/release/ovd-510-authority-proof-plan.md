# OVD-510 disposable authority proof plan

Status: source-only plan, September 24, 2026. No privilege change has been
applied to a shared or production database. This plan is for the isolated
disposable replay and is subordinate to
[the verifier authority contract](../verifier-authority-contract.md).

## OVD-558 staged migration source

The forward and reverse SQL are staged at
`ovd-558-verifier-authority-forward.sql` and
`ovd-558-verifier-authority-reverse.sql`. They are deliberately outside
`supabase/migrations`: their presence in source control does not schedule a
hosted database operation. The forward SQL leaves all seven entry points inert
and creates an empty, owner-controlled registered-object table. It creates no
JWT, delivery route, worker enablement, receipt, or customer data.

The source generator uses the pinned prechange compatibility manifest and
checks both SQL files with:

```sh
node scripts/ovd510-generate-migration-sql.mjs b5a5bbd163458c2ea4a519846ba6c25b3860e069900c788a01b48150a3e24d92 --check
```

The digest argument is the `supabase_admin` PostgreSQL JSONB rendering of the
exact post-forward catalog; the existing manifest's source catalog was captured
as `postgres`. The runner compares the source manifest, both runner-role
catalog fingerprints, the exact forward file digest recorded in the reverse
file, and all 13 platform roles' effective function access. It runs a durable
forward/reverse proof with:

```sh
node scripts/ovd510-disposable-replay.mjs --durable-migration
```

The reverse SQL refuses an unknown catalog and a nonempty registered-object
table rather than deleting evidence. Since OVD-737 it first refuses any
isolation level other than READ COMMITTED with SQLSTATE `0A000`
(`ovd558_reverse_read_committed_required`). It then takes the advisory lock
and `ACCESS EXCLUSIVE` locks on `storage.objects` and then the
registered-object table before it reads the catalog or the registry. A
registry writer that commits while the reverse waits is therefore seen by the
emptiness check, and a writer that arrives later waits for the reverse to
finish. Storage comes first because a verifier read takes the two tables in
that order through its Storage policy; the opposite order deadlocks with a
concurrent verifier read. The disposable replay proves both writer orders, the
verifier read during the lock (and the deadlock when the registry is locked
first), the REPEATABLE READ and SERIALIZABLE refusals, and a forward, reverse,
forward, reverse reapplication with identical catalogs, all with live sessions
(`durable-reverse-lock-proof.json`, `durable-reapply.json`). To allow that
reapplication, the forward preflight still accepts the pinned prechange catalog
and otherwise accepts only the exact catalog the reverse leaves: the normalized
digest must equal the pinned prechange digest and every Storage function must
carry exactly the explicit owner and `PUBLIC` EXECUTE entries. The post-forward
digest check is unchanged. Pinned SHA-256 values: forward
`9a60a19f734da9e46384df9ab6e27911d10eafacc240c2993d3dc000ea75bb5f`, reverse
`56ff1fffaac04240501c26a4b3418096fe85c96962743554351838ffc8d31e3f`.

The reverse also restores the exact public function ACL
order and preserves the old effective callers. The 20 Storage functions that
started with null `proacl` return with explicit owner/PUBLIC entries after the
required revoke and regrant; their expanded grants, grantors, grant options,
effective access, and all other catalog fields must match the baseline.
The disposable runner executes 230 existing pgTAP assertions across engineering
inbox, native ownership, quote publication, mobile Auth, and Storage before the
forward migration, after it, and after the reverse. Only temporary fixture
helpers receive explicit test-role function defaults; the application assertions
are unchanged. The runner also compares representative role outcomes and proves
direct `42501` denials, second application, injected failure, unknown-state
rejection, and fixture cleanup separately.
Production owner/runner parity and deployment remain separately unverified.

## Acceptance and boundary

Prove that one `NOLOGIN` verifier role can execute only the seven exact
signatures in the contract, can read only registered Storage objects, and
cannot acquire function authority from existing `PUBLIC EXECUTE` or the
approved owners' future default grants. A later explicit grant to `PUBLIC`
would still reach the verifier and must be rejected by subsequent migration
checks.
Preserve the recorded effective access of `anon`, `authenticated`, and
`service_role`; classify all 13 cataloged platform roles before choosing
additional exact grants. Run the migration and rollback proof against synthetic
local data only. This is Lane 3 verification: catalog, role, RLS, behavior, failure,
rerun, rollback, repository checks, and hosted review are separate gates.

OVD-510 excludes result finalization, live verifier delivery, credentials,
production database changes, native execution, customer files, and candidate
adoption. The recommended OVD-510 proof uses inert disposable-only functions
with the seven exact signatures. Functional RPCs belong to OVD-511's
finalization work; OVD-560 owns the separate source-only immutable result
registry and receipt producer. This is the selected bounded source-proof scope; no fixture
function is a production migration.

## Pinned pre-change evidence

The current compatibility artifact is
`ovd-510-prechange-compatibility-manifest.json`; its SHA-256 is recorded in the
contract. It binds the `6ecc934d` replay from branch `000d82a3` based on main
`1992765b`, 117 repository migration hashes, pinned Auth and Storage images,
352 functions, ten schemas, 132 policies, 135 relations, seven sequences,
function configuration, explicit grant provenance, and effective caller
matrices for 13 non-system roles. All replay resources were removed by fixture
identity.

**Window 2 rebaseline (OVD-743, October 12).** The manifest now binds a fresh
replay of main `26b0b76e` with all 148 repository migrations (the production
ledger): 452 functions, 10 schemas, 132 policies, 158 relations, 12 sequences
and 15 non-system roles (adding `ovd575_observer_validator` and
`ovd576_stop_validator`); SHA-256
`854ec2fc0f7141f9a770378a0290a9c71bc32389ba2c3d2ba585309fc4b99296`. The source scan
found 118 literal RPC calls, 13 dynamic sites (9 new, each with a reviewed rule
in the manifest) and 3 calls to RPCs that only staged window 2 SQL creates. The
OVD-558 forward and reverse were regenerated from it to run as `postgres`, the
hosted Supabase owner role, with no superuser (option A): the catalog digest is
taken with `search_path = pg_catalog`, so it is role independent (prechange
`e1947671…`, post change `be97ed54…`). Storage functions belong to
`supabase_storage_admin` and keep the ACLs Supabase ships; the postflight proves
the verifier can call exactly the 7 application functions outside `storage`, and
inside `storage` exactly the functions `anon` can call, pinned by name (20), with
no `storage` table privilege `anon` lacks. `storage.delete_leaf_prefixes` and the
other Storage definer functions therefore stay callable by the verifier exactly as
by anon. Option C (no `storage` USAGE for the verifier; signed URLs or a
`service_role` fetch after a definer check) is a 1.1 follow up. The September 24
values above are history; `docs/release/window-2/manifest.json` records the old
and new pins.


| Schema | Functions | Owner | `PUBLIC EXECUTE` | Direct grants to application roles |
| --- | ---: | --- | ---: | --- |
| `public` | 181 | `postgres` | 77 | The 77 `anon`, 127 `authenticated`, and 149 `service_role` effective executions are already direct grants. |
| `engineering_private` | 30 | `postgres` | 0 | Seven `authenticated` and nine `service_role` executions are direct grants. |
| `storage` | 20 | `supabase_storage_admin` | 20 | None; 60 exact direct grants are needed to retain the three application roles' current execution. `dashboard_user` also currently executes all 20 through `PUBLIC` and needs a reviewed preservation decision. |

`PUBLIC` has schema usage in `public`, but not `engineering_private` or
`storage`. `dashboard_user` currently reaches the 77 `PUBLIC` public functions
and all 20 Storage functions without direct grants; `authenticator` likewise
reaches the 77 public functions. Other cataloged platform roles also inherit
some current access through `PUBLIC`. Removing that access is not silently
classified as safe: each role's need and exact replacement grant must be
reviewed before SQL is finalized. Neither function owner has a global default
ACL override. The
fixture's `postgres` can create in `public`, `engineering_private`, `private`,
and `extensions`; `supabase_storage_admin` can create in `storage`. No sequence
is in a verifier-usable schema. The verifier role does not exist in the
pre-change catalog.

The current effective access requiring a preservation decision is finite.
Counts below require both schema usage and function execution; `PUBLIC-only`
means there is no direct grant to the named role and the role is not the
function owner. It is a catalog observation, not a proposed grant list.

| Role | `public` executable / PUBLIC-only | `storage` executable / PUBLIC-only |
| --- | ---: | ---: |
| `anon` | 77 / 0 | 20 / 20 |
| `authenticated` | 127 / 0 | 20 / 20 |
| `authenticator` | 77 / 77 | 0 / 0 |
| `dashboard_user` | 77 / 77 | 20 / 20 |
| `postgres` | 181 / 0 (owner) | 20 / 20 |
| `service_role` | 149 / 0 | 20 / 20 |
| `supabase_admin` | 181 / 77 (superuser) | 20 / 20 (superuser) |
| `supabase_auth_admin` | 77 / 77 | 0 / 0 |
| `supabase_etl_admin` | 77 / 77 | 20 / 20 |
| `supabase_privileged_role` | 77 / 77 | 0 / 0 |
| `supabase_read_only_user` | 77 / 77 | 20 / 20 |
| `supabase_replication_admin` | 77 / 77 | 0 / 0 |
| `supabase_storage_admin` | 77 / 77 | 20 / 0 (owner) |

Preserving every non-owner, non-superuser execution currently reached only
through `PUBLIC` would require up to 616 exact `public` grants and 140 exact
`storage` grants, including the 60 Storage grants for the application roles.
This is a conservative upper bound from the disposable catalog; owner and
superuser privileges, role inheritance, runtime need, and hosted role parity
must be checked before choosing the final grant set. The 30
`engineering_private` functions have no `PUBLIC EXECUTE` path.

## Forward proof sequence

1. Pin the exact catalog and migration-set digests. Fail before mutation on
   owner, function body, role, schema/default ACL, membership, policy, or
   caller drift. Assert the disposable database identity and the
   `supabase_admin` superuser runner; ordinary `postgres` cannot change the
   Storage owner's defaults.
2. Start one bounded transaction, take a migration-scoped advisory lock, and
   recheck the same catalog before changing privileges. Do not provision a JWT,
   login, service endpoint, or runtime principal.
3. Create any disposable proof functions as `postgres` and assert their exact
   signatures, owner, security mode, empty search path for definers, and
   fail-closed behavior. Keep them out of `supabase/migrations`.
4. Revoke global future-function `PUBLIC EXECUTE` defaults for both owners.
   Restore the prior future-function `PUBLIC` behavior for `postgres` in only
   the non-verifier schemas it can create in: `private` and `extensions`.
   Preserve existing owner/schema-specific direct defaults.
5. Revoke `PUBLIC EXECUTE` from every existing function in `public`,
   `engineering_private`, and `storage`. Preserve existing direct grants. Add
   the 60 pinned Storage `EXECUTE` grants to `anon`, `authenticated`, and
   `service_role`, using the function owner as grantor. For `dashboard_user`,
   `authenticator`, and every other non-owner, non-superuser platform role,
   determine each exact direct replacement grant needed to retain the
   pre-change effective matrix. Generate those grants from the pinned
   pre-change identities and verify every role after the change. Do not infer
   that a superuser or function owner needs a redundant grant from its
   pre-change `PUBLIC` access alone.
6. Create the verifier role with the contracted attributes. Grant it schema
   usage on only the three target schemas, `SELECT` on `storage.objects`, and
   execute on only the seven proof signatures. Revoke any owner-default direct
   `EXECUTE` grants from application roles on those seven functions and assert
   every other non-owner, non-superuser role is denied. Give `authenticator` membership
   with `INHERIT FALSE`, `SET TRUE`, `ADMIN FALSE`. Add the permissive and
   restrictive registered-object read policies. Grant no table DML, schema
   create, sequence, helper function, preview, or admin membership authority.
7. Assert the complete post-change effective catalog and exactly seven
   verifier-callable signatures before commit. On any mismatch, roll back.

## Required independent verdicts

- Allowed calls must reach each proof function; a fixture business rejection
  is distinct from PostgreSQL privilege rejection.
- Direct calls to unrelated public, private, definer, trigger-helper, preview,
  and Storage functions must fail with SQLSTATE `42501`.
- New harmless functions created by both approved owners in every creatable
  schema must not become verifier-callable. In non-verifier schemas, their
  legitimate-role behavior must match pre-change defaults. In verifier-usable
  schemas, `PUBLIC EXECUTE` must be absent; later migrations must grant each
  intended caller explicitly.
- `storage.objects` read must require a registered object; unregistered read
  and every insert, update, and delete must fail. Test the function, policies,
  and table privileges separately.
- The expanded caller matrix for the three application roles and every
  classified platform role must match the pre-change manifest. Exercise
  signed-in engineering, publication worker, gateway, and
  Storage fixtures; no static `.rpc()` scan proves runtime behavior alone.
- Inject failure after revokes and prove transaction rollback from the exact
  pre-change catalog. A second forward attempt must stop before mutation or
  prove a no-op. Keep failure and cleanup receipts.
- A separately reviewed rollback must restore the entire pre-change catalog,
  normalizing only raw function ACL representation for the 20 Storage
  functions whose pre-change ACL was null. Expanded grants, grantors, grant
  options, effective access, and every other catalog field must match.

Hosted owner/runner parity and unknown deployed callers remain unverified.
Source proof does not authorize a production migration or credential.
