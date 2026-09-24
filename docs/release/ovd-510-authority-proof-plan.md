# OVD-510 disposable authority proof plan

Status: source-only plan, September 24, 2026. No privilege change has been
applied to a shared or production database. This plan is for the isolated
disposable replay and is subordinate to
[the verifier authority contract](../verifier-authority-contract.md).

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
with the seven exact signatures. Functional RPCs and immutable result registry
belong to OVD-511. This boundary awaits the user's routing choice; no fixture
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
   `service_role`, using the function owner as grantor. Determine whether
   `dashboard_user`, `authenticator`, or another platform role needs an exact
   direct replacement from the expanded catalog and source/behavior proof
   before finalizing SQL. Do not infer that a superuser or function owner needs
   a redundant grant from its pre-change `PUBLIC` access alone.
6. Create the verifier role with the contracted attributes. Grant it schema
   usage on only the three target schemas, `SELECT` on `storage.objects`, and
   execute on only the seven proof signatures. Give `authenticator` membership
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
