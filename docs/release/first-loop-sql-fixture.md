# First-loop rollback SQL fixture

Source qualification only. The generator opens no connection, reads no credentials, launches no process and writes no storage bytes. The generated SQL is **unrun** here. It is intended only for the separately owned Mac disposable, cached PostgreSQL fixture. Do not use a hosted database.

## Required schema and operator boundary

Use the complete maintained application schema, not the narrow OVD575 stub tables. This includes both `20260927140000_ovd576_atomic_native_stop.sql` and `20260927225843_ovd576_stop_caller_fence.sql`: the fixture invokes the checked nine-argument stop entrypoint with caller fence, not the retired eight-argument overload. Apply the reviewed staged authority and registry sources in their required order: OVD558 authority, OVD560 result registry, `ovd-561-finalization-forward.sql`, the OVD575 observer replay replacement, and the result reader's `native-result-reader-forward.sql`. The OVD561 finalization schema is required because the mapping writer declares `native_finalizations%rowtype`, including for this seed-only packet; this fixture creates no receipt key and executes no finalization. The complete command below includes mapping proofs and requires `private-artifact-forward.sql` and `native-artifact-mapping-forward.sql`. These are source inputs for canonical migration generation by the parent; this packet creates no migration or grant.

**Preserve OVD558's catalog hash and runner preflight unchanged.** A mismatch is a prerequisite failure requiring exact catalog diagnosis. Do not omit, replace, or weaken that preflight. Run the fixture under disposable `postgres` ownership after reviewed schema setup; this identity must already be able to `SET ROLE ovd575_observer_validator` and `ovd576_stop_validator`. The fixture adds no membership or grants. If the role transition is denied, stop and report the missing approved setup prerequisite.

pgTAP and pgcrypto in `extensions`, Supabase `auth`, Storage metadata tables and all current application dependencies must already exist. The ownership fixture itself contains its maintained `CREATE EXTENSION IF NOT EXISTS pgtap`; no installer or network mechanism is supplied. Fixture UUIDs use the maintained `50100000-0000-4000-8000-*` namespace, the composed mapping bucket is `mapping-synthetic` (standalone default uses `first-loop-synthetic`), and actor/profile rows must initially be absent. Any collision fails; nothing pre-existing is deleted.

## Generate and run

From the integrated source checkout:

```sh
python3 scripts/native-result-reader-proof.py --dynamic-first-loop --fragment \
  --filesystem-json '{"input":{"path":"C:\\Fixture\\input","volumeSerial":"1111111111111111","fileId":"11111111111111111111111111111111"},"candidate":{"path":"C:\\Fixture\\candidate","volumeSerial":"2222222222222222","fileId":"22222222222222222222222222222222"}}' > /tmp/first-loop-reader-fragment.sql
python3 scripts/first-loop-sql-fixture.py \
  --seed-setup scripts/first-loop-sql-fixture-seed-setup.sql \
  --seed-manifest scripts/first-loop-sql-fixture-seed-manifest.sql \
  --preclaim scripts/first-loop-sql-fixture-preclaim.sql \
  --poststop scripts/first-loop-sql-fixture-poststop.sql \
  --registry scripts/first-loop-sql-fixture-registry.sql \
  --reader /tmp/first-loop-reader-fragment.sql > /tmp/first-loop.sql
```

The separately authorized Mac fixture owner executes `/tmp/first-loop.sql` using its existing no-network fixture connection and captures psql exit code plus complete output. Use psql `-X -v ON_ERROR_STOP=1`; the packet also sets `ON_ERROR_STOP`, per-statement 30-second and lock 5-second limits. The fixture lifecycle owner enforces its overall deadline. Do not supply any real filesystem identity: those strings are synthetic attestations solely for this disposable SQL proof.

For mapping composition, `--seed-setup FILE` runs before the immutable seed admission INSERT, and `--seed-manifest FILE` supplies its exact SQL digest expression. The generator substitutes only the maintained fixture’s seed manifest value; it never rewrites an admission. `--registry FILE` replaces the default metadata/registry block with the reviewed mapping-target-bound block.

Optional `--preclaim FILE` and `--poststop FILE` insert reviewed mapping SQL at the named boundaries. `--reader FILE` executes the actual reader SQL proof after all seven registrations. Fragments are trusted source code, must have no outer transaction commands, and must be included in the retained source/hash manifest. They are not arbitrary API/user input.

## Exact stages and expectations

1. Reuses `supabase/tests/engineering_native_ownership.sql` through qualified seed/runtime admission, before its first successful claim. This uses the real authenticated request/interpretation APIs and owner enablement. Existing negative pgTAP assertions remain present.
2. Calls the real claim API; outcome must be `claimed`. `pg_temp.task()` and `pg_temp.attempt()` expose actual IDs, with maintained worker `pg_temp.n(50)`, boot `n(52)`, runtime `n(60)`, seed admission `n(70)`.
3. Rebinds maintained `stop-observer/fixtures/{manifest,journal}.json` to exact attempt/job hashes, deadline and current synthetic timestamps. Recomputes every chain digest with `native_observer_canonical_json`. Compiler/native/lifecycle/operation records, all terminal processes and process identity relationships remain present. No evidence row is directly inserted.
4. Owner inserts a synthetic observer profile/attribution row; restricted OVD575 role calls the real ingestion function. `pg_temp.first_loop_evidence()` exposes the returned opaque UUID. Profile `native_qualification` and `stop_admission` remain false.
5. Owner separately inserts a synthetic exact evidence qualification and stop actor; restricted OVD576 role calls the checked stop function with actual fence/revision. Outcome must be `process_stopped`, phase `awaiting_result`, `result_eligible=true`, and stop admission non-null. No recovery/manual-stop shortcut is used.
6. Calls the real preclaim input mapping writer with the exact seed manifest digest fixed at initial admission; after qualified stop calls the real output mapping writer and creates seven synthetic Storage **metadata** rows at those exact mapped targets and calls the actual OVD560 registry function for assembly/target/companion/result/identity/preservation/native. Each call must return true and the exact attempt must have seven rows. Their lengths/hashes are deliberately synthetic; there are no bytes to verify.
7. Reader fragment admits its synthetic filesystem binding and executes source-extracted load/object SQL, positive scope/process/role checks and negative replacement/public-bucket/current-attempt/revocation/replay checks. Its failures raise exceptions.
8. Emits JSON `first_loop_fixture_ids` containing task/attempt/evidence IDs and stop receipt, completes pgTAP and **ROLLBACK**. Retain this row as diagnostic output, not live reusable identifiers.

Expected failures: missing role authority `42501`; invalid observer bytes/time/chain `22023`; unqualified/stale stop `PT409`; collisions `23505`; changed reader binding replay `23505`; `fixture_clock_precision_retry_required` is a synthetic timestamp precision failure. Any SQL exception or pgTAP `not ok` fails the packet; exit zero alone does not prove all TAP assertions passed. Confirm rollback and absence of fixture rows/bucket afterward using the owner's existing lifecycle checks.

This packet does not test candidate finalization, cumulative successor claims, actual storage reads/writes, concurrency, HTTP transport, Windows PowerShell, model calls or native CAD. Each needs its own exact-source evidence. No PostgreSQL, storage or native pass may be inferred from generator tests.
