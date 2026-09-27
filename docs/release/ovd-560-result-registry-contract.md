# OVD-560 native result registry and receipt contract

This is a source-only continuation of the staged OVD-558 verifier authority
layer. Apply `ovd-560-result-registry-forward.sql` after that layer in an
exclusively owned disposable database. Neither SQL file belongs to the active
`supabase/migrations` tree. There is no production bucket, upload route, JWT,
receipt key, native operation, or finalization in this change.

## Registration and delivery

The private registry row binds tenant, task, current attempt and fence, exact
input snapshot and candidate snapshot, one of seven approved artifact roles,
Storage bucket/name/row ID/version/updated time, measured SHA-256, and byte
length. Each attempt has at most one artifact per role; a Storage row ID can
belong to at most one registration. The owner-only registration function locks
the attempt and rechecks current task ownership, result eligibility, admitted
process stop, scoped snapshots, private Storage bucket and exact object
generation. An identical retry returns `false` without rewriting history. A
changed replay, stale attempt or fence, foreign tenant, public bucket, or
changed Storage generation rejects. Update and delete triggers reject registry
mutation. The reverse script refuses a nonempty registry.

The private source registration service reads the actual uploaded object by
trusted Storage ID, bounds the stream by role and time, and measures SHA-256 and
length before invoking the owner-only SQL function. Its repository adapter must
use the admitted attempt and Storage row, and must never accept a worker URL,
path, digest, or byte count as authority. The SQL function rechecks Storage
version after the read. Storage's `updated_at` trigger uses transaction-stable
`now()`, so version is also required; updated time alone cannot distinguish
two writes in one transaction. The verifier measures every byte again, so a
same-ID/same-version byte substitution still fails digest verification.

The OVD-558 Storage policy keeps its exact seven-function verifier allowlist.
Its registered-object helper now requires a task-scoped verifier JWT claim set
for organization, project, task, attempt, and fence, plus a still eligible
attempt and unchanged Storage identity/version. No new function is callable by
the verifier. The verifier has no registry table access or Storage mutation
grant. The exact JWT issuer, storage upload transport, and private repository
adapters remain inactive until separately qualified and authorized.

## Trusted receipt

`produceNativeVerificationReceipt` loads a private registered admission,
reads the seven registered objects by ID, invokes the existing complete
prepared-native validator, then rechecks current eligibility. It signs a
canonical payload containing tenant, task, attempt, fence, input/candidate
snapshots, context/job/result digests, policy version, issue time, and all
seven measured object identities/digests/lengths. The key is injected; this
source change creates no production secret. A forged or modified payload
fails `verifyNativeVerificationReceipt`. OVD-561 must verify the signature and
recheck the current attempt, registry rows, and snapshot lineage inside its
own finalization transaction. A valid historical receipt is never current
authority by itself.

## Evidence and rollback

`node scripts/ovd510-disposable-replay.mjs --durable-migration --ovd560`
replays the pinned source migrations in an exclusively owned synthetic
fixture, applies OVD-558 and OVD-560, exercises exact and changed retries,
tenant and fence denials, immutable history, scoped Storage read and
substitution denial, then reverses OVD-560 and OVD-558. The runner compares
catalogs across rollback and records resource cleanup. TypeScript tests cover
actual stream measurement, size/transport failures, all seven-byte validation,
stale attempts, and forged receipts. These are synthetic source proofs; they
do not attest a Windows process or live Supabase deployment.

## OVD-561 receipt continuation

The downstream finalization consumer requires receipt v2, adding the SHA-256 of
the exact serialized verified candidate context. See
[the OVD-561 byte and transaction contract](ovd-561-finalization-contract.md).
The v1 registry/verification checkpoint above remains historical evidence; v1
receipts cannot authorize a new snapshot commit.
