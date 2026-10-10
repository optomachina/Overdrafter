# Trusted artifact mapping writer (source only)

`prepareNativeArtifactInputs` is an explicit default-off internal owner operation
BEFORE worker dispatch. It takes an existing qualified input admission, trusted actor
ID and exact seed manifest text (null for finalized candidates). It returns three
stable opaque IDs, in ordinal order, for the existing run-task InputArtifactIds
argument. No attempt is required or created. Transport still checks exact boot,
session, actor and live input eligibility when those IDs are used.

`prepareNativeArtifactOutputs` runs internally AFTER independently qualified stop.
It takes an exact attempt ID and trusted configured private output bucket. It
locks task execution and attempt, checks awaiting_result, result_eligible,
stop_admission_id, stopped_at, verification state, access and revocations, then
creates seven deterministic targets. It needs no seed manifest. Bucket/manifest
selection must never come from worker route bodies. The combined
`writeNativeArtifactMappings` remains an optional poststop convenience, not the
only bootstrap API. Each call uses fixed SQL in the existing READ COMMITTED driver.

The functions do not upload, claim, qualify, enable, release a slot or read
credentials. Driver COMMIT acknowledgement, cancellation rollback and unknown
outcomes must be enforced by the actual driver, not inferred from Node mocks.
Only explicit same-argument reconciliation is permitted; there is no automatic retry.

Canonical migration **purpose**, for the authorized Supabase CLI operator: add
owner-only immutable preclaim input and poststop output mapping functions after native ownership,
OVD558 verifier authority, OVD560 registry, OVD561 finalizations and the staged
`private-artifact-forward.sql` mapping tables. Source lives in
`native-artifact-mapping-forward.sql`; no timestamp/name or active migration has
been fabricated. Existing OVD558 catalog preflight must pass unchanged. No grant,
role, bucket or qualification record is created by this function.

Seed manifests currently have only a digest in the admission table; no stored body
or existing schema is supplied by the repository. This writer accepts an ordered
three-object JSON array with roles assembly, target, companion. Each object contains
`role`, `path`, `bytes`, `sha256`, `storageObjectId`, `storageVersion`,
`storageUpdatedAt`. Its **exact UTF-8 text SHA-256** must equal the existing seed
admission's storage_manifest_sha256, and each path/size/hash must equal its frozen
snapshot file. This is an input requirement for the independent seed qualification
owner, not an automatic admission or conversion of an existing incompatible hash.
Storage IDs/version/timestamps must identify extant private objects. The writer
uses pinned trusted admission hashes; it does not derive them from worker claims.

Candidates accept null seed text only. Their mapping comes from the finalized
producer receipt and its exact registry objects. The admission's manifest hash is
checked using the same PostgreSQL jsonb text digest as OVD561, not a JavaScript
serialization. Snapshot context equality, producer admission/snapshot receipt,
registry role/scope/bytes/hash and current private storage generation are bound.
Each phase is atomic. Three input rows and seven deterministic `native-results/<attempt>/<role>` targets
remain immutable. Existing opaque IDs survive exact replay; changed targets fail closed.

## Disposable PostgreSQL qualification packet

After applying the real prerequisite schema and staged source in a separately
approved fresh fixture, generate SQL without any connection or credentials:

```
node scripts/test-native-artifact-mapping.mjs > mapping-fixture.sql
```

The generator reuses the actual ownership pgTAP fixture through its first real
`api_claim_native_task`, adds synthetic object metadata and a matching admission
manifest before admission insertion, prepares IDs before claim, then uses the
existing fixture synthetic stop admission and real api_record_native_stop before
appending `native-artifact-mapping-proof.sql`.
It emits one transaction ending in rollback; it never runs psql/docker or rewrites
OVD558 preflight. Run emitted SQL with ON_ERROR_STOP and treat any pgTAP `not ok`,
missing finish(), SQL error or timeout as failure. Requires pgTAP and the unchanged
real API functions; no authority Boolean stubs are supplied. Metadata uses prepared
seed hashes but no matching file bytes are uploaded: this cannot qualify byte
transport, native work, or the prepared seed itself.

Included SQL checks: IDs before any attempt, unstopped output denial, malformed
manifest, public bucket, no partial rows, three/seven
cardinality, exact replay, conflicting bucket, immutable rows, replaced generation,
revocation, anon/authenticated/service_role denial. Node tests cover default-off,
fixed bound SQL, immutable receipt validation, pre-abort and no automatic retry.

Additional required runtime acceptance (not claimed by this packet): concurrent
same-admission/two-attempt replay, lock contention and revocation ordering, lost
COMMIT acknowledgement followed by exact replay, candidate mapping after **real**
OVD561 finalization, foreign-producer rejection, and driver cancellation rollback.
Storage conditional create/exact generation and Windows qualification remain
separate. No SQL tests have run in this cloud environment.
