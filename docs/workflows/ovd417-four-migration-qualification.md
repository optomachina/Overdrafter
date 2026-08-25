# OVD-417 four-migration suffix qualification

This local-only rehearsal freezes source `5c3b6864e63ada75561f4ff7019bde70962d6e39` and a local 100-row rehearsal baseline through `20260817054500` with fingerprint `5dabebda8a0fc1a3cf697e00de64418b`.

Every OVD-417 ledger fingerprint is local-rehearsal-only. The baseline
`5dabebda8a0fc1a3cf697e00de64418b`, partial-prefix fingerprints
`237b68dd5f9cbfaa353c8ee32e1133f1`,
`984345d23b318111d43e7af57c1ff6e3`, and
`7119bdd3cd717b0f26ace2b5af0172af`, and final fingerprint
`6dd6911df342f253a303e837d8881f7a` reflect the local rehearsal's historical
`schema_migrations.statements` representation. They qualify the four migration
files and recovery behavior locally, but they are not hosted-production ledger
fingerprints and must never be used in an OVD-418 production authorization or
release-state gate.

It never targets a linked Supabase target, performs migration repair, uses production credentials, contacts a provider, or reads customer rows. The runner preflights Docker, Git, Node.js, ripgrep (`rg`), and the Supabase CLI; Supabase CLI must be exactly `2.78.1`. Its database client image is pinned to `public.ecr.aws/supabase/postgres@sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144`. On Linux, Docker must support `host-gateway`: the runner adds `host.docker.internal:host-gateway` to every client container so the container can reach the loopback PostgreSQL databases. Pre-create three pairwise-distinct, loopback-only `ovd417_` databases as exact, zero-customer-row clones of the local 100-migration rehearsal baseline: clean, recovery, and restore. Connection URLs must not contain query or fragment parameters. Supply those URLs, an exact temporary project copy, and a newly created empty local evidence directory; the runner enables no-clobber mode and refuses any pre-existing evidence entry. The runner independently verifies each clone's local baseline ledger and zero customer-row aggregates before applying anything.

```bash
export OVD417_CLEAN_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55417/ovd417_clean'
export OVD417_RECOVERY_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55418/ovd417_recovery'
export OVD417_RESTORED_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55419/ovd417_restored'
export OVD417_TEMP_PROJECT_DIR=/local/temp-project
export OVD417_EVIDENCE_DIR=/local/evidence
bash scripts/qualify-ovd417-four-migration-suffix.sh
```

The runner dry-runs and verifies the exact four-migration plan, then applies it uninterrupted to the clean database. On the recovery database it first verifies the same dry-run plan, injects a failure immediately after `20260817133902`, proves the exact one-row prefix and final-state promotion block through the OVD-417 verifier, removes only that injected file, rehashes the reviewed suffix, and fixes forward. It then runs final ledger postconditions and the four suffix-specific pgTAP suites on clean, recovered, and restored databases; takes and restores the schema, application-data, and migration-ledger logical backup shape qualified by OVD-373 after proving protected customer-bearing tables are empty, retaining schema comments because the geographic-origin evidence boundary is part of the database contract; compares clean and recovered application schema plus ledger byte-for-byte after nonce normalization; and compares the recovered/restored ledger while using the restored postconditions and 154 pgTAP assertions as semantic application-schema proof. This avoids treating PostgreSQL's removal of redundant parentheses from four pre-existing CHECK expressions during dump/restore as drift. The qualification never invokes reconciliation: it verifies the immutable function body, provenance constraint, and service-role-only ACL without creating offer/customer fixtures, while worker tests cover explicit `domestic`, `foreign`, and `unknown` serialization. A separate local `supabase db reset --no-seed` of the repository head supplies the clean-from-zero replay comparison and the repository-wide pgTAP gate, because several concurrency suites intentionally require the canonical disposable database name. The runner records only zero-count aggregate evidence for protected customer-bearing tables. A failure stops local qualification; do not retry against a hosted target.
