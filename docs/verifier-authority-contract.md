# Native verifier database authority contract

OVD-521 defines the database authority boundary required before OVD-510 can
write a migration. It is a design and proof contract only. It does not restore
the verifier client, create a role, change a grant, activate result
finalization, deliver a preview, or prove any hosted or production state.

## Evidence baseline and current-main reconciliation

The retained September 11 inventory under
`output/ovd510-inventory-20260911/` was captured from a disposable PostgreSQL
17.6 database against source `5030afc162afded656e783639ae5f24763eb6309`.
It found that `engineering_native_verifier` could reach 92 `public`, 48
`engineering_private`, and 15 `storage` functions. Only five public functions
had a direct verifier grant; 87 public functions were reachable through
`PUBLIC EXECUTE`. All 344 captured functions were owned by `postgres`, and the
captured defaults had no global or `engineering_private` function override for
that owner. The inventory's 16 checks establish those retained facts only.

This contract was first reconciled against `origin/main` at
`4bcfb6b26e79cba42ea22642a670caddbc22edfe` on September 18, 2026. That
main contained the pure stored-evidence validators and JARVIS journal work, but
contains none of the historical verifier role, verifier RPCs, verifier client,
or four deferred migrations preserved at
`125af011d11cc176f89ad685eafc6d203ed0ce98`. There is therefore no current-main
verifier authority to amend in place. The retained September 11 catalog remains
historical design evidence; the fresh September 24 replay below supersedes its
owner assumptions for this source-only slice. Neither catalog is a hosted-owner
inventory or production-parity claim.

The authority mutation still requires a fresh, exclusively owned, disposable
replay of its exact source revision. It must capture the same catalog
dimensions as the retained inventory before choosing statements: signatures,
owners, schema ACLs, function ACLs, effective privileges, role memberships,
default ACLs, security mode, body provenance, policies, and database callers.

## Exact verifier allowlist

The role's complete callable function set is the following seven signatures.
Names without argument types do not satisfy this contract.

<!-- verifier-authority-allowlist:start -->
- `public.api_load_native_verification(uuid,uuid)`
- `public.api_complete_native_verification(uuid,text)`
- `public.api_reject_native_verification(uuid,jsonb)`
- `engineering_private.load_native_verification(uuid,uuid)`
- `engineering_private.complete_native_verification(uuid,text)`
- `engineering_private.reject_native_verification(uuid,jsonb)`
- `engineering_private.native_verifier_can_read_object(text,text)`
<!-- verifier-authority-allowlist:end -->

The only admitted runtime caller is `engineering_native_verifier`, selected by
the platform after a valid verifier JWT. The first three signatures are its
REST RPC surface. Their `SECURITY INVOKER` bodies call the next three
`SECURITY DEFINER` functions, so the role needs both schema `USAGE` and
`EXECUTE` on both layers. The seventh signature is called by the restrictive
`storage.objects` read policy and is also `SECURITY DEFINER`. The function
owner can execute owned functions independently of ACL entries; that inherent
owner behavior is administration, not verifier-role authority.

No preview signature is admitted. In particular,
`api_load_native_preview(uuid,uuid)`,
`api_complete_native_preview(uuid,text,integer)`, their private implementations,
and `native_preview_can_read(text,text,boolean)` remain outside the contract.
Preview delivery is separate deferred work. Internal helpers such as
`require_native_verifier()`, `lock_verifier_attempt(uuid)`,
`engineering_actor_access(uuid,uuid,uuid)`, trigger functions, and receipt
helpers must remain non-callable by the verifier even when an admitted
`SECURITY DEFINER` function invokes them as its owner.

TypeSafe and Jev are not authorization inputs. They may later help type or
route natural-language intent, but neither may add a signature, role,
membership, grant, policy, migration exception, or proof waiver.

## Selected privilege strategy

Use explicit privilege hardening, not a new schema. A new schema alone cannot
isolate this role: the verifier needs the historical public RPC surface and
bounded `storage.objects` reads, while every PostgreSQL role receives grants
made to `PUBLIC`. `NOINHERIT` also does not cancel `PUBLIC` privileges.

The later migration must satisfy all of these invariants in one transaction:

1. `engineering_native_verifier` is `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
   NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Its only membership edge is that
   `authenticator` is a member so PostgREST can select the JWT role; `postgres`
   may retain its administrative membership. The verifier is not a member of
   `anon`, `authenticated`, `service_role`, or any platform/admin role.
2. The verifier has `USAGE` only on `public`, `engineering_private`, and
   `storage`. It has no schema `CREATE`. Schema usage is not treated as function
   authority.
3. Remove `EXECUTE` granted to `PUBLIC` from every existing function in those
   three schemas. Regrant `anon`, `authenticated`, and `service_role` only the
   exact effective signature matrix captured before the change. Regrant the
   verifier only the seven signatures above.
4. The verifier has `SELECT` only on `storage.objects`, with both a permissive
   registered-object policy and a restrictive registered-only policy. It has no
   direct table, sequence, DML, DDL, ownership, or RLS-bypass authority.
5. Every admitted `SECURITY DEFINER` function is owned by the approved owner,
   fixes `search_path` to the empty string, schema-qualifies references, checks
   the principal and immutable scope again, and exposes no dynamic SQL or
   caller-chosen relation/function name. All other definers remain unreachable.
6. Revoking a direct grant, changing `NOINHERIT`, or filtering PostgREST's
   exposed schemas is never accepted as proof of effective denial.

### Owners and default privileges

The September 11 retained database had one applicable owner, `postgres`, but
its Storage functions were not created by the pinned Storage service role. A
fresh, exclusively owned September 24 replay recorded branch HEAD
`82a8275634ddbaf1d6ac6f8ba11de73110c8130e`, based on main
`1992765b0258e4a980ba7462c85d8d92db9498d1`. The fixture manifest pins
all 117 repository migration filenames and hashes. It used pinned
PostgreSQL `17.6.1.095`, GoTrue `v2.187.0`, and Storage `v1.41.8` images. It
applied 68 Auth, 56 Storage, and 117 repository SQL migrations, then captured a
read-only catalog of 352 functions, 132 policies, and 135 relations across ten
non-system schemas. The 211 `public` and `engineering_private` functions are
owned by `postgres`; all 20 `storage` functions are owned by
`supabase_storage_admin`. Fixture `7c76b147` first established the owner split;
`8de0f25c` captured the full schema and relation matrix. Both fixtures removed
their exclusively owned resources. This is local source evidence, not a hosted
owner or production-parity claim.

The same replay found that `postgres` can create functions in `public`,
`engineering_private`, `private`, and `extensions`; `supabase_storage_admin`
can create them in `storage` only. Neither has a global function default-ACL
override. Existing `storage` functions retain `PUBLIC EXECUTE`, and a new
function created by either owner would receive PostgreSQL's global `PUBLIC`
default unless that owner's defaults are changed. The migration must abort
before mutation unless the non-extension function-owner set in the three
verifier-usable schemas is exactly `{postgres,supabase_storage_admin}`, the
recorded creator/owner matrix matches the reviewed manifest, and no new owner
or creatable schema appears.

The repository migrations replay as `postgres`; the pinned Storage service
creates its functions as `supabase_storage_admin`. PostgreSQL permits altering
another role's default privileges only through membership or superuser
authority. The fixture's `postgres` role is not a member of
`supabase_storage_admin`; therefore an ordinary `postgres` migration must fail
preflight, not attempt a partial hardening. Source-only disposable proof may
use the fixture's pinned `supabase_admin` superuser as one transaction runner,
with its role and authority asserted before mutation. New verifier functions
and tables must be created under an asserted `SET ROLE postgres` within that
transaction; the runner must reset to asserted `supabase_admin` only for
privilege operations that need it. Final catalog checks must reject any
verifier object owned by `supabase_admin` or another unapproved role. Production
execution requires a separately reviewed exact runner and explicit approval; this
contract grants no production database change.

For **both** `postgres` and `supabase_storage_admin`, the forward migration
must apply the global default rule equivalent to:

```sql
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role supabase_storage_admin
  revoke execute on functions from public;
```

PostgreSQL initially supplies function `EXECUTE` to `PUBLIC` globally. A
schema-specific revoke cannot subtract that global default, so a global
owner-specific revoke is required. Because that changes the default for every
schema, the pre-change manifest must cover every schema in the replay, not only
the three schemas usable by the verifier. For each existing non-verifier schema,
the migration must restore the pre-change future-function behavior with an
explicit schema default, including `PUBLIC EXECUTE` where the baseline supplied
it. A future schema must declare its caller defaults in its creating migration;
it may not silently depend on PostgreSQL's global default. Existing owner/schema
defaults that grant `anon`, `authenticated`, or `service_role` explicitly may
be recreated only from the pinned compatibility manifest. No default may grant
the verifier. Each later function migration must explicitly grant its intended
caller set.

The disposable proof must create one harmless future function as each approved
owner in every schema that owner can create in. In verifier-usable schemas, the
verifier must not execute it and it must have no default `PUBLIC EXECUTE`. In
every other schema, its effective callers must match a pre-change future
function created by the same owner in the same schema. The proof functions
must then be dropped before retaining the fixture. Catalog inspection must
show no global `PUBLIC EXECUTE` default for either owner, no verifier entry in
any default ACL, no changed non-verifier schema behavior, and no unreviewed
function owner.

## Legitimate caller compatibility contract

Before revoking anything, generate a versioned manifest covering every schema,
keyed by schema, name, identity arguments, owner, security mode, and body
digest. For each signature, record effective `USAGE` plus `EXECUTE` for
`PUBLIC`, `anon`, `authenticated`, `service_role`, and the worker-facing service
path. Also record global and per-schema function defaults for every approved
owner. Generate explicit grants and preserved non-verifier schema defaults from
this reviewed manifest; never generate them from the post-change catalog or
from names alone.

Compatibility means:

- `anon` retains exactly its pre-change successful and denied public/storage
  calls; it gains no engineering-private usage.
- `authenticated` retains signed-in quote, project, engineering, owner-history,
  and storage behavior, including the same authorization failures.
- `service_role` retains mobile-auth, publication worker, and engineering
  gateway calls without becoming a verifier member.
- Existing workers continue through their gateway/service-role path. Worker
  bearer tokens never become PostgreSQL verifier credentials.
- Database-internal callers, policies, and triggers continue to work through
  ownership or explicit grants. A missing application `.rpc()` reference is
  not evidence that a function is unused.

The five dynamic RPC sites reported by the retained inventory must be resolved
to exact signatures in the fresh manifest. Any unresolved dynamic call,
unmatched function body, unknown deployed caller, or owner drift makes the
migration proof fail closed.

The source-only September 24 compatibility artifact is
`docs/release/ovd-510-prechange-compatibility-manifest.json` (SHA-256
`d4eb1152f107fb59d8f79107acf3a9c9506ed829bf8195c7ba02379670160bc0`).
It binds the `8de0f25c` fixture catalog, 117 migration hashes, 352 exact
function identities and effective caller matrices, all schema/default ACLs,
roles, memberships, policies and relations. The current source scan found 101
literal RPC calls naming 95 unique public functions and four dynamic dispatch
sites. Two browser-wrapper sites accept only literal names at their current
callers; the two gateway sites forward a checked three-name union. Each named
call resolves to one catalog identity. The earlier five-site count is a
historical source snapshot. This local artifact does not establish hosted
caller or owner parity; deployment preflight must recheck those dimensions.

## Forward migration order

The implementation issue must encode and test this order. Steps 1–4 are
preflight and create no durable authority change.

1. Pin the source revision, PostgreSQL/Supabase toolchain, migration set, and
   disposable database identity; prove the target is exclusively owned and not
   shared or production.
2. Replay all current migrations from empty state. Capture the pre-change
   catalog and effective compatibility manifest in a read-only transaction.
3. Assert the owner set, role attributes, memberships, schema ACLs, dynamic
   caller resolution, function identities/bodies, policies, and default ACLs
   match the reviewed inputs. Abort on any difference.
4. Parse the reviewed verifier object definitions without executing them.
   Compare every declared object and exact function signature with this
   contract; abort if the source introduces an unlisted signature or object.
5. Begin one short transaction with lock and statement deadlines. Acquire a
   migration-scoped advisory lock and recheck the preflight digests.
6. Under an asserted `current_user = postgres`, install the verifier objects
   and their immutable tables/policies without a credential or runtime
   principal. Assert their identities and `postgres` ownership before
   continuing. The privileged session must not create a verifier object while
   `current_user = supabase_admin`.
7. Set both approved owners' default privileges to fail closed, revoke existing
   `PUBLIC EXECUTE` in `public`, `engineering_private`, and `storage`, then
   restore the pinned per-schema defaults outside those schemas and apply the
   pinned legitimate-role grants by exact signature.
8. Apply verifier role attributes, membership, schema/table privileges, the
   seven exact function grants, and the two storage policies. Revoke the
   verifier from every other function/table/sequence explicitly.
9. Run catalog assertions inside the transaction. Any extra verifier-callable
   signature, missing allowlist signature, `PUBLIC EXECUTE`, unknown owner,
   non-`postgres` verifier-object owner, default-ACL leak, membership edge, or
   policy mismatch raises and rolls back.
10. Commit. Immediately capture post-change catalogs and run every proof case
   below. Do not issue a credential or enable delivery.

## Disposable-database proof matrix

Bind every result to the exact commit, migration digest, fixture identity,
database version, runner, and timestamp.

| Proof | Required result |
| --- | --- |
| Catalog allowlist | Effective verifier callable signatures equal the seven-entry set, with no extras and no missing entry. |
| Allowed calls | Load, complete, reject, and registered-object policy calls reach their intended function; fixture business preconditions may reject, but PostgreSQL privilege checks must pass. |
| Public denial | At least one unrelated ordinary public function and one unrelated public `SECURITY DEFINER` function fail with `42501` for the verifier. |
| Private denial | Direct calls to `require_native_verifier`, `lock_verifier_attempt`, a trigger helper, and an unrelated private definer fail with `42501`. |
| Storage denial | Unregistered result objects and all insert/update/delete operations fail; unrelated storage functions are not executable. |
| Future functions | A new function created by every approved owner in every creatable schema is denied to the verifier in verifier-usable schemas and preserves the pre-change effective callers elsewhere. |
| Membership | The only non-administrative incoming edge is `authenticator -> engineering_native_verifier`; the verifier inherits no role. `anon`, `authenticated`, and `service_role` cannot `SET ROLE` to it. |
| SECURITY DEFINER | Every admitted definer has the pinned owner/body/search path; all unlisted definers are denied directly. Altered owner, body, configuration, or overload fails the proof. |
| Legitimate roles | The before/after effective matrix and behavioral fixtures for `anon`, `authenticated`, `service_role`, mobile auth, publication, gateway, and workers are identical except for the intentional removal of implicit `PUBLIC` provenance. |
| Transaction failure | An injected failure after revokes leaves catalogs byte-for-byte equal to pre-change state. |
| Re-run | A second application is either an explicitly proved no-op or fails before mutation; it never broadens grants. |

An RPC returning an application denial is not enough to prove database denial.
Tests must distinguish privilege failure (`42501`) from business errors. Catalog,
allowed-call, denied-call, policy, compatibility, transaction, and cleanup
verdicts remain separate.

## Rollback and unknown-state handling

Rollback is a separately reviewed migration generated from the captured
pre-change ACL/default/membership manifest. It must run only against the exact
forward migration digest and post-change catalog digest.

1. Disable verifier delivery and prove no verifier request is admitted.
2. Acquire the same advisory lock and recheck source, migration, and catalog
   digests. Unknown or mismatched state stops without mutation.
3. In one bounded transaction, revoke the seven verifier grants, table access,
   policies, schema usage, and authenticator membership; then restore the
   pre-change legitimate-role ACLs and both approved owners' default ACLs from the pinned
   manifest.
4. Drop only forward-created verifier objects whose identities and dependency
   graph match the forward manifest. Preserve receipts, failures, native
   evidence, attempts, and any pre-existing object.
5. Assert the post-rollback catalog equals the pre-change catalog, commit, and
   rerun the legitimate-role fixtures. No verifier credential is reissued.

Timeout, lost connection, canceled runner, failed assertion, or missing receipt
is `unknown`, never success. Reconnect read-only, check the migration ledger,
transaction visibility, catalog digest, role/default ACLs, and proof artifacts.
Resume only from a proven pre-change or committed post-change state. A mixed or
unrecognized state remains blocked for a new recovery plan; do not retry the
forward or rollback sequence blindly.

## Review boundary

Review of this document admits only a later migration implementation issue. It
does not satisfy OVD-510, authorize the migration, approve production/shared
database access, provision credentials, execute native CAD, finalize a result,
restore delivery, or admit previews. Those require their own scoped
implementation, disposable proof, current-head review, and protected-boundary
authorization where applicable.
