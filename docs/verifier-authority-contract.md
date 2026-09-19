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

This contract was reconciled against `origin/main` at
`4bcfb6b26e79cba42ea22642a670caddbc22edfe` on September 18, 2026. Current
main contains the pure stored-evidence validators and JARVIS journal work, but
contains none of the historical verifier role, verifier RPCs, verifier client,
or four deferred migrations preserved at
`125af011d11cc176f89ad685eafc6d203ed0ce98`. There is therefore no current-main
verifier authority to amend in place. The retained catalog is useful design
evidence, not a current replay, hosted-owner inventory, or production-parity
claim.

The later migration slice must start from a fresh, exclusively owned,
disposable replay of its exact main revision. It must capture the same catalog
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

The retained database has one applicable owner: `postgres`. A fresh replay
must enumerate owners of every non-extension function in `public`,
`engineering_private`, and `storage`, and separately record the execution role
used by every pending migration. The migration must abort before mutation
unless the function-owner set is exactly `{postgres}` and the migration runner
is `postgres`. Discovery of another owner or runner is contract drift: add it
to this section, review its compatibility matrix, and apply the same
owner-specific rule before proceeding.

For `postgres`, the forward migration must apply the global default rule
equivalent to:

```sql
alter default privileges for role postgres
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

The disposable proof must create one harmless future function as `postgres` in
every schema where that owner can create functions. In verifier-usable schemas,
the verifier must not execute it and it must have no default `PUBLIC EXECUTE`.
In every other schema, its effective callers must match the pre-change future
function created in the same schema. The proof functions must then be dropped
before retaining the fixture. Catalog inspection must show no global
`PUBLIC EXECUTE` default for `postgres`, no verifier entry in any default ACL,
no changed non-verifier schema behavior, and no unreviewed function owner.

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
6. Install the verifier objects and their immutable tables/policies without a
   credential or runtime principal. Assert their identities before continuing.
7. Set the `postgres` default privileges to fail closed, revoke existing
   `PUBLIC EXECUTE` in `public`, `engineering_private`, and `storage`, then
   restore the pinned per-schema defaults outside those schemas and apply the
   pinned legitimate-role grants by exact signature.
8. Apply verifier role attributes, membership, schema/table privileges, the
   seven exact function grants, and the two storage policies. Revoke the
   verifier from every other function/table/sequence explicitly.
9. Run catalog assertions inside the transaction. Any extra verifier-callable
   signature, missing allowlist signature, `PUBLIC EXECUTE`, unknown owner,
   default-ACL leak, membership edge, or policy mismatch raises and rolls back.
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
   pre-change legitimate-role ACLs and `postgres` default ACLs from the pinned
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
