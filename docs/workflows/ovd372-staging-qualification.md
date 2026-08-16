# OVD-372 pending-head qualification

Last verified: August 15, 2026

## Outcome

OVD-372 qualified the migration sequence frozen at commit
`81ca41b159078c2eaca305ca042c4bf5d927890a` without changing production,
reading customer rows, uploading files, or contacting a quote provider.

The approved hosted-branch path was attempted first. Supabase reported that
branching requires the Pro plan, so no branch was created and no charge was
incurred. Qualification used three disposable local Postgres 17 databases:

- a production schema-only and migration-ledger clone;
- a clean replay of the repository head;
- an interrupted-deployment recovery clone.

Only repository-seeded configuration was copied into the no-data clones:
commercial rollout controls, pricing policy, spend cap, vendor capability
profiles, and Storage bucket definitions. No Auth user, organization,
membership, job, file, Storage object, quote, billing account, or audit row was
copied from production.

## Frozen input

[`ovd-372-pending-head-manifest.json`](../release/ovd-372-pending-head-manifest.json)
pins the 23 pending files by ordered filename, byte length, and SHA-256. It also
pins the two OVD-372 qualification migrations discovered by rehearsal.

Run:

```bash
npm run verify:ovd372-head
```

The verifier is offline. It proves that the frozen source commit is an ancestor
of the current branch, the pinned source blobs still match, the qualification
migrations are the only post-freeze migration files, and no retired alias has
returned.

## Candidate decisions

| Version | Decision | Evidence |
| --- | --- | --- |
| `20260402100000` | Reconcile as applied before push | Production lacks this migration's intended `serviceRequestLineItemId` effect, but executing the historical file would temporarily replace the current fail-closed customer quote endpoint with an older direct-enqueue implementation. The reviewed `20260816015500` migration supplies the missing effect directly to the final private function without reopening that endpoint. |
| `20260403103000` | Reconcile as applied before push | Production already has the later, redacted client-workspace projection. Executing the historical definition would expose internal invalidation actor and reason fields until the final repair. |
| `20260406000000` | Reconcile as applied before push | Production does not have the deferred alert foundation, but the historical migration leaves its SECURITY DEFINER evaluator executable by PUBLIC. The reviewed `20260816015000` migration creates the same table, policies, and evaluator with final fail-closed privileges in one transaction. |
| `20260408193000` | Reconcile as applied before push | Applied `20260812004204` already supplies the hardened final table, RLS, trigger, helper, resolver, and API contract. Executing the old file regresses six functions. |
| `20260731015400` | Reconcile as applied before push | All five commercial-account admin functions match clean head in definition, security properties, configuration, and ACL; the migration has no row or Storage effects. |

These decisions authorize only the production deployment manifest below. They
do not themselves authorize a production history repair or push.

## Rehearsed upgrade

The production-first clone was created from schema-only output plus the exact
production migration ledger. The two proven-equivalent versions and three
unsafe-but-superseded historical versions were marked applied only in that
disposable clone, then every other pending migration was executed in repository
order.

The first blind rehearsal correctly failed qualification:

- executing `20260408193000` overwrote the newer vendor-preference hardening;
- `20260403103000` reintroduced internal invalidation fields in the client
  quote workspace;
- the legacy automatic-quote task still omitted service-request lineage;
- `evaluate_extraction_quality_alerts(date)` retained PostgreSQL's default
  PUBLIC execute grant.

It also proved that a single `db push` is not atomic across migration files:
an interruption left already-applied versions committed. Therefore
`20260402100000`, `20260403103000`, and `20260406000000` must be reconciled
before the push; otherwise a committed intermediate state can reopen the
historical direct-enqueue quote endpoint, expose internal quote invalidation
details, or publish the privileged evaluator before the final repairs run.

The qualified head therefore adds:

- `20260816015000_restrict_extraction_quality_alert_evaluator.sql` — revokes
  PUBLIC, anon, and authenticated execution and grants only `service_role`;
- `20260816015500_restore_production_first_quote_contracts.sql` — restores the
  queued `serviceRequestLineItemId` and removes private invalidation actor/reason
  fields from client quote projections. Both repairs fail closed if their
  expected function shape is absent.

## Convergence proof

Capture only app-owned schemas from each disposable database:

```bash
pg_dump --schema-only --no-owner --no-comments \
  --schema public --schema private \
  --dbname "$UPGRADED_STAGE_DATABASE_URL" \
  --file upgraded-app-schema.sql

pg_dump --schema-only --no-owner --no-comments \
  --schema public --schema private \
  --dbname "$CLEAN_HEAD_DATABASE_URL" \
  --file clean-app-schema.sql

npm run compare:ovd372-schema -- \
  upgraded-app-schema.sql clean-app-schema.sql
```

Before capture, the disposable clean and recovery databases were tightened to
the production-derived environment baseline: `PUBLIC` and the explicit
`postgres` role lost `public` schema usage, and clean-only `supabase_admin`
default grants were removed. This changes no app object and never broadens a
permission. Comments are excluded because they do not change runtime behavior.

The comparator removes only pg_dump's random session restriction tokens. It
does not ignore function, table, constraint, index, trigger, RLS, policy, or
grant differences. Its negative test proves that an otherwise identical
object-level grant change fails comparison.

Verified normalized SHA-256:
`631284c32e0945f9d2d328313d5c804ec168544601c0d635fcd58f5572e815be`.

Supabase-managed Storage internals and the migration-ledger table shape were
recorded separately and are intentionally outside the app-owned equality gate;
their versions differ between hosted Supabase and the local CLI image. App
Storage policies and bucket binding remain covered by pgTAP.

Both the upgraded clone and clean-head database passed the same suite:

```text
Files=26, Tests=650, Result: PASS
```

That includes Founding Beta enrollment, file boundaries, dispatch permits,
worker preflight, drawing/CAD Storage policy, supplier/mobile/manual-quote
foundations, and the 39-test deferred-foundations fail-closed suite.

The concurrency suites honor the database setting `ovd.test_conninfo`. Each
disposable database was explicitly bound to its own published port before the
suite ran; relying on the canonical local-port fallback is not acceptable for
qualification. This prevents a parallel local stack from producing a false
pass.

## Recovery rehearsal

A third production-schema clone received an injected migration that failed
immediately after `20260409000000`. The push stopped with 8 newly applied
versions committed and no Founding Beta RPC present. The injected file was
removed from the temporary migration copy; no reviewed migration was edited.

Running the exact reviewed head again applied the remaining 12 versions. The
recovered database then passed all 650 pgTAP assertions and produced the same
normalized app-schema SHA-256 as clean head.

The rehearsed production response is therefore fix-forward from the exact
reviewed commit. A database snapshot remains a pre-deploy safety net, but
snapshot restore is not the default response because it creates downtime and
does not restore deleted Storage objects.

## Earliest-interruption rehearsal

A fourth production-schema clone received only the five reviewed history
reconciliations and the earliest executable pending migration,
`20260330144838_align_destructive_job_auth_contract`. The later historical
quote migration was not executed.

The three customer quote endpoints retained their exact production function
fingerprints:

```text
api_request_quote(uuid,boolean)                          0d515533235ec8a93c95776dd7927acc
api_request_quote_scoped(uuid,vendor_name[])             ff4a98a5f55f7e91fb1df664eb31d234
api_request_quotes(uuid[],boolean)                       2312e5fcb093cb5340e4b76c74428b0e
```

A synthetic verified member and editable job then exercised all three routes.
Each returned `pro_required`, and the before/after counts remained zero for
`quote_requests`, `quote_runs`, `vendor_quote_results`, and `work_queue`. The
transaction rolled back the synthetic identity, organization, membership, and
job. The local Auth image used `confirmed_at` rather than hosted
`email_confirmed_at`, so the disposable clone used a functionally equivalent
verified-auth shim only for this synthetic call; no quote or rollout function
was changed.

This proves that a failure immediately after the first executable migration
does not reopen any of the three legacy automatic-quote routes when the unsafe
`20260402100000` version is reconciled rather than executed.

## Production deployment manifest — not yet authorized

Production work remains a separate OVD-361 checkpoint. When explicitly
authorized, the operator must:

1. Confirm production still has migration head `20260813005020`, enrollment is
   absent/default-off, and automatic quote rollout is disabled.
2. Take the normal platform backup and record the pre-deploy migration list and
   app authorization catalog.
3. Run the offline frozen-head verifier from the reviewed commit.
4. Run the read-only live-catalog precondition before any history write:

   ```bash
   psql "$OVD372_PRODUCTION_DATABASE_URL" \
     --no-psqlrc \
     --set ON_ERROR_STOP=1 \
     --file scripts/verify-ovd372-production-preconditions.sql
   ```

   It must print `OVD-372 production preconditions passed.` The reviewed
   script passed against the untouched production catalog on August 15, 2026.
   It reads only migration and authorization catalogs; it checks function
   definitions, owners, security properties and grants plus both vendor-
   preference tables' columns, constraints, RLS, policies, triggers, owners,
   and grants. It reads no customer, file, quote, billing, or Storage rows.
5. Reconcile only `20260402100000`, `20260403103000`, `20260406000000`,
   `20260408193000`, and `20260731015400` as applied. The first three are
   replaced or preserved by reviewed final-state migrations; the other two are
   catalog-equivalent or behaviorally superseded.
6. Run linked `db push --include-all --dry-run`; require exactly the 18
   executable frozen migrations plus the two qualification migrations, in
   timestamp order.
7. Run the governed full-head push once. Do not split the Founding Beta
   migrations from their earlier prerequisites or the two final repairs.
8. Immediately rerun all authorization, RLS, Storage, dormant-foundation, and
   app-schema fingerprint checks.
9. Keep Founding Beta enrollment and automatic provider rollout disabled until
   the separate beta enrollment/certification step explicitly enables them.

Stop on any manifest, dry-run, catalog, permission, test, or hash mismatch.
Never execute the three unsafe superseded versions against production, never
broadly mark pending versions applied, and never improvise an object-by-object
rollback.
