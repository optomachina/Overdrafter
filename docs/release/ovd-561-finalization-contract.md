# OVD-561 atomic native finalization

Source-only staged continuation of OVD-558/560, outside active migrations.
No API grant, transport, native execution, production key or activation is added.

Receipt v2 adds `candidateContextSha256`: SHA-256 of the UTF-8 bytes of
`JSON.stringify(verified.context)`, where `verified.context` is the validated
`NativeContext` returned by `verifyStoredNativeCandidate`. SQL stores those exact
bytes, never a jsonb reserialization. HMAC-SHA256 covers the exact UTF-8
`JSON.stringify(receipt.payload)` bytes. Supply these as payload text and hex
signature; no consumer may reserialize the payload before verification. v1,
missing/changed candidate digest, forged signatures and substituted context fail.
The v1 producer could not authenticate committed candidate context bytes; v2
repairs that downstream gap without invalidating historical OVD-560 evidence.

The private key table is empty by default. Only the database owner can insert a
key or call finalization. Fixtures inject a generated ephemeral key; real key
provisioning and runtime adapter qualification are separate protected work.
No caller-supplied key or boolean grants verification authority.

## Source-only delivery bridge

`server/engineering/native-result-finalization.ts` composes the existing
registered-byte verifier with this exact transaction. It remains default-off and
accepts only trusted private repository adapters and an already supplied verifier
key; it exposes no route, credential loader or SQL grant. The envelope producer
retains the exact verified candidate-context text together with signed payload
text, signature and an idempotency UUID. The persistence adapter must atomically
insert-if-absent by task/attempt and durably return that immutable envelope before
delivery. A conflicting concurrent preparation never delivers its losing bytes.

An existing pending envelope requires explicit `replay`, which sends those exact
arguments without a new verification/signature/idempotency key. Missing or
altered envelopes and mismatched completion identities fail closed. One bounded
invocation and caller cancellation cover pending lookup, verification,
persistence and delivery; late adapter completion cannot start a successor.
Cancellation propagates to active registered-object readers. An interrupted
write is uncertain and requires exact reconciliation, not a rollback claim.

The deterministic tests use synthetic registered bytes, generated in-memory keys
and injected persistence/SQL functions. A production durable-envelope adapter,
qualified-stop/registry integration and the owner-only transaction executor are
still separate missing implementation/provisioning gates. The source bridge
does not establish deployed transport, native execution or successor dispatch.

The transaction requires READ COMMITTED; repeatable-read and serializable
transactions are rejected before processing so old authority snapshots cannot
bypass revocation. The transaction locks organization slot, worker, conversation, task and attempt
in existing canonical order. Authority tables are held against mutation before
rechecking access and admission revocation; registry Storage generations are
locked and compared. After all lock waits, it rechecks the worker boot/revocation,
current attempt/fence, cancellation, input lineage, deadline and receipt age.
A stopped process no longer renews a lease: the fixed attempt deadline and a
five-minute receipt lifetime bound result finalization. A live native lease is
not extended or revived. Existing occupancy is never changed by finalization.

A verified candidate commits one immutable completion record, one snapshot, one
verified input admission, task success and conversation head advancement together.
Only the immediate accepted, blocked, unverified successor is queued; earlier
unfinished work prevents finalization. Identical payload/context/signature/key
replay returns the original completion even after expiry, with no authority for
another native run. Conflicting replay rejects. New work uses existing claim and
fresh authority checks. Errors roll back every finalization mutation; pre-existing
immutable registry rows remain historical evidence.

Verification covers signature/context substitution, exact/conflicting replay,
identity/fence/registry mismatch, partial-write failure, concurrent writers,
lock-wait cancellation/revocation/expiry/fence changes, permissions and reverse /
reapply. Synthetic SQL records do not qualify Windows or a live deployment.
Reverse refuses populated finalization history and preserves prior registry data.

## Fixture scope

Run `node scripts/ovd510-disposable-replay.mjs --durable-migration --ovd561
--reviewed-authority-baseline` (one command). The baseline option selects the
reviewed migration names from the manifest's exact Git revision, reads their
current checked-out bytes and retains the existing digest checks. It records
excluded later migrations explicitly. The historical fixture proves staged
forward/reverse behavior. A separate owned database clone applies the later
current-source migrations, proves the seven-call verifier allowlist and repeats
finalization behavior and concurrency checks. That order verifies source
compatibility; it does not qualify applying OVD-558 to a database already on
current production. No shared OVD-558 pin is regenerated or waived.

Reverse acquires exclusive key/history table locks before inspecting history;
a concurrent committed finalization prevents rollback from dropping its receipt.

The current-source clone suffix creates two cluster-wide validator roles. The
race fixture records whether those roles already exist, then drops only newly
created suffix roles after every owned clone is removed. It uses no cascading
cleanup; any remaining dependency fails the fixture. Exact catalog rollback
comparison remains in force, including roles, memberships and effective grants.
