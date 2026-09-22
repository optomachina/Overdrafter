# OVD-522 receipt contract — accepted specification, version 1

This is the maintained copy of the independently reviewed OVD-522 specification.
The original accepted artifact SHA256 is `dcec7588aeeebf50092a2ba114f2ebd1a70f88f8424f3f4752a982110b2d1c8f`.
Repository-relative locations below replace historical local evidence paths; normative behavior is unchanged.
It defines local synthetic evidence only, grants no production authority and is not runtime verification.

Source baseline: `4bcfb6b26e79cba42ea22642a670caddbc22edfe`. Owner: `01a096c3-8f7e-7e40-9bc8-21cfece24f6e`. The user authorized continuation of this contract-review unit. Current-main AGENTS governs technical review; High classification is retained and independent Astra xhigh review is required. No permission-only pause is inferred from complexity.

## 1. Inputs and evidence boundary

Reuse the unchanged retained `private-bindings-v2.schema.json`, SHA256 `2321e4c430ba7d50eca583a1c31709df5e115d9a23bcbc43ea490779d038471f`, at `scripts/ovd419-acquisition-schemas/private-bindings-v2.schema.json`. The receipt schema is `scripts/ovd419-acquisition-schemas/offline-acquisition-result.schema.json`, SHA256 `24719b225bd01ea150ab66afa2322a3b41f0ab85065cd9420796671437c89cc7`. A future source unit must vendor the exact accepted bytes or pin their existing canonical path/hash in its qualified manifest; it must not rediscover or regenerate a schema from prose.

Normative retained design: `acquisition-tooling-proposal-1/PROPOSAL.md` sections C and executable adversarial cases, SHA256 `38bd1f69a8db62684322e91ea6a6b8cfb7e5fe2a582f8eef59df9331f546e71b`. Prior proposal `../ovd516-contract-proposal-20260918/proposal.md` is historical and is superseded only where this reviewed contract makes explicit choices.

All response records are generated synthetic fixtures. The fixture harness establishes a private invocation scope and pins the acquisition source, immutable input manifest, packet, schema bytes and test-root ownership before reading. Schema files are inputs; generated binding and receipt outputs are never hashed into their own input manifest. The current reader's caller-supplied qualification tuple is not independent source qualification: the later integration must bind it to that harness-owned record. No claim is made that TEST_ONLY qualification authenticates a remote service or real checkout. Changed input/source/schema bytes reject. No default transport, CLI, credential discovery or live adapter is added.

## 2. Receipt shape and decisions

The receipt draft-2020-12 schema is a closed eleven-field object. All fields required; additional and decoded duplicate keys reject. Shape validation is only one predicate.

| Field | Derivation and cross-check |
| --- | --- |
| schema | `OVD419-SYNTHETIC-ACQUISITION-RESULT-NOT-AUTHORITY-v1`; explicit new discriminator |
| mode | `TEST_ONLY` |
| bindingsSha256 | SHA-256 of the exact final UTF-8 binding file bytes |
| bindingsBytes | Exact byte length, integer 1..1048576 |
| acquisitionSourceCommit | 40 lowercase hex; equality to harness-qualified source AND private v2 field |
| diagnosticSourceCommit | Fixed `e9c1073c47277f7ba7709655d94d4a399e78fffa`; equality to private v2 field |
| inputManifestSha256 | 64 lowercase hex; equality to harness-qualified manifest AND private v2 field |
| readPlanSha256 | Fixed `58f007868ada20901080b914cfeb0c7f90d1169166a62bdb25314a4ea3bc5354`; equality to private v2 field |
| handoffSha256 | Exact existing reader handoff hash, equality to privately retained receipt/record; no caller replacement |
| transportQualified | `false`, even after successful persistence |
| privateBindingReady | `false`, meaning no production binding readiness; fixture settlement is separate |

Decision: no timestamp, usage object, message, path, scope token, principal, provider/resource/Execution ID, secret reference/value, snapshot identifier/content, customer rows, raw response or nested private binding in receipt/errors. Hashes permit linkage and do not promise anonymity. Both files remain private. No publication is authorized. No persisted failure receipt or receipt self-hash is added.

## 3. Exact serialization

Define `C(value)` over schema-validated plain JSON data: recursively sort object keys with the existing `compareCodeUnits` ordering from `ovd419-job-diagnostic.mjs`; preserve array order; retain string content exactly; permit only finite safe integers where the schema permits numbers. Reject non-plain objects, cycles, sparse arrays, accessors, symbols, non-JSON values and unpaired UTF-16 surrogates; never invoke user-supplied serialization hooks. The future implementation works on privately constructed records, not arbitrary caller objects. Perform closed-schema validation before canonicalization so unknown keys cannot be stripped.

Stored bytes = UTF-8 encoding of compact `JSON.stringify(C(value))`, with **no BOM, indentation or final newline**. This is a deliberately selected local serialization rule consistent with the existing diagnostic digest's object-key ordering, not a claim to implement RFC canonical JSON. Both exact stored files independently must be <=1048576 bytes. Compute the binding byte length/hash from the immutable byte buffer once; construct and serialize receipt afterward. Readback compares bytes, length AND hash; a reordered or whitespace-modified byte string is not the accepted serialization. Schema parsing also uses the reviewed bounded duplicate-key-rejecting parser limits: depth 16, keys 32768, structural tokens 131072, with the tighter file byte cap. Do not equate character count with UTF-8 bytes.

Configuration fingerprints retain the EXISTING `digest()` algorithm and existing projection semantics. Do not replace them with file hashes or this receipt's hash. Hash equality and a receipt cannot authenticate provenance.

## 4. Every private v2 field

Use the module-owned second resource pass after exact raw-byte stability with the first pass, plus the validated prefix/metadata. Existing validations are mandatory, not inferred from successful schema matching. Reparse only retained validated raw bytes with the existing bounded parser; no additional transport reads.

| Private path | Exact origin / algorithm |
| --- | --- |
| schema | Existing v2 schema constant, unchanged |
| capturedAt | Reader completion observation timestamp derived as UTC milliseconds from a harness-owned safe epoch anchor at reader start plus floor(final-closing monotonic time minus start). Anchor/time retained privately; format roundtrips through ISO UTC milliseconds. Not a freshness clock or authority. Reject invalid/range-overflow dates. |
| readPlanSha256 | `ACQUISITION_IDENTITIES.readPlanSha256` |
| baseline.job.uid/generation/resourceVersion | `second.job.projection.identity` corresponding fields |
| baseline.job.configuration | `second.job.projection.configurationFingerprint` = existing `digest({name: fullJob.metadata.name, spec: fullJob.spec})` |
| baseline.service.uid/generation/resourceVersion | `second.service.projection.identity` corresponding fields |
| baseline.service.configuration | `second.service.projection.configurationFingerprint` = existing name/spec digest |
| baseline.snapshot | Existing `digest(snapshotClosing.projection)`; projection is exactly generation/metageneration/etag; opening equals closing; equality to the bound packet snapshot predicate required |
| baseline.account | Existing `digest({...second.job.projection.snapshotScope, principal: principalClosing.projection.principal})`; opening equals closing and packet account equality required |
| baseline.secretVersion | `secretClosing.projection.secretVersion`; same enabled numeric version as opening and bound Service reference/packet |
| baseline.inventory | `second.inventory.ids`, already unique and code-unit sorted; identical first/second IDs and selected name/UID |
| baseline.controls | `containmentClosing.controls`, equal prefix.controlsFingerprint; existing digest of sorted exact capability/enabled records, NOT SQL row fingerprints |
| baseline.egress | Diagnostic-compatible `digest(immutableEgress)` defined below; NEVER prefix.egressFingerprint |
| candidateConfiguration | Existing name/spec digest of the validated baseline Job with ONLY its single task container image replaced by the bound packet.image, as in diagnostic adapter replaceJob. Derive from retained full spec, never copy a syntactically valid packet hash. Require result equal bound packet.candidateConfiguration; mismatch rejects rather than repairing the packet. |
| snapshotScope.bucket/object/maxBytes | `second.job.projection.snapshotScope`; cross-resource equality with Service, Execution and bound scope is required |
| snapshotScope.generation/metageneration/etag | `snapshotClosing.projection`, copied as strings without numeric coercion |
| principal | `principalClosing.projection.principal` |
| resources.cpu/memory/taskSeconds/retries | `second.job.projection.resources`, equal realized Execution resources and checked against packet limits |
| resources.tasks/parallelism | Exact full Job taskCount and parallelism, each explicitly required to be 1 by full-Job validator; no default for absent fields |
| compatibility.catalogue | true only after the attributable prefix's catalogue validation and complete same-invocation reader success |
| compatibility.executionRepresentation | true only after both complete Execution validations, inventory selection/Job owner/task agreement and exact raw stability |
| compatibility.baselineSafeForTemporaryManifest | true only after in-memory baseline AND image-only candidate outgoing-manifest projections pass existing validatePrivateManifest with the original bound packet; exact derivation below |
| compatibility.controlsEncodingVerified | true only after existing containment validator and opening/closing equality; no unconditional readiness default |
| catalogueFingerprint | prefix.catalogueFingerprint, existing catalogue algorithm |
| completedExecutionRepresentationFingerprint | `second.execution.sha256`, exact raw complete-Execution UTF-8 representation already validated and matched with first pass. This chooses the existing byte fingerprint, NOT configuration/status/label/log-URI digests. It is a local representation binding, not historical authentication success. |
| acquisitionSourceCommit/diagnosticSourceCommit/inputManifestSha256 | Same privately qualified tuple and fixed diagnostic identity as receipt; no inherited old acquisition commit |

### Egress algorithm

The prefix validates an `egress` object created by `collectStableEgressEvidence`; the later implementation must retain that exact validated object privately or reconstruct it without I/O from attributable E01–E18 payloads using the following exact mapping: E01 service, E02 job, E03 iamPolicy, E04 jobIamPolicy, E05 projectIamPolicy, E06 network, E07 subnet, E08 router, E09 nat, E10 address, E11 routes, E12 policyBasedRoutes, E13 natMappings, E14 jobExecutions, E15 confirmService, E16 confirmJob, E17 confirmRouter, E18 confirmNat. All 18 unique expected records/command hashes must be present and match the original prefix validation; no fallback collector call.

Remove exactly service, job, confirmService, confirmJob, natMappings, jobExecutions from that object. Retain all other fields and their accepted representation, including confirmRouter/confirmNat. Compute existing `digest()` over this object, matching diagnostic adapter lines 261–268. Its expected value is not the prefix's observation-list SHA-256. Require the existing egress evaluator's complete success and final closing E13 zero. Cross-check prefix E01/E15 and E02/E16 projected Service/Job resourceVersions against the full-resource pair; if the configuration changed between prefix and full reads, reject rather than merge intervals. This is still synthetic evidence, not network-state authority.

### Outgoing-manifest compatibility

Reproduce only the existing adapter's in-memory manifest projection (lines 185–191): clone validated full baseline Job; root remains apiVersion/kind/metadata/spec after removing status; metadata retains name, resourceVersion, labels and annotations, removing only run.googleapis.com/creator and run.googleapis.com/lastModifier. No unknown spec field is dropped, normalized or defaulted. Require full baseline name/spec digest equals packet.baseline.job.configuration. Validate this baseline with existing `validatePrivateManifest`; clone it and replace only the single container image with packet.image; require derived candidate digest equals packet.candidateConfiguration and validate that candidate too. These helpers are interpretation only; do NOT invoke createPrivateManifest or instantiate a production adapter. Missing retained packet/full raw data requires a reader-private retention extension in the next unit; it does not permit reconstructing facts from a hash.

## 5. Invocation capability and time

Future internal interface: a harness-owned scope is bound to exactly one reader at creation. Reader owns the scope identity, qualified tuple, packet, immutable handoff data, original monotonic clock, start, absolute deadline, UTC anchor and final closing-observation time. A private writer closure bound to that same reader/scope consumes its exact handle once. No exported general unwrap, raw-record setter, caller-supplied validated flag or serializable prepared capability is permitted. Interface spelling is implementation-local; observable acceptance is fixed here.

For a valid bound handle, atomically change AVAILABLE to CLAIMED before any await or creation. A concurrent or second request rejects. Validation failure permanently invalidates that attempt; foreign/forged handles cannot claim another invocation. Each scope permits one attempt, no retry or deadline reset. The resulting prepared record remains module-private and one-use. The handoff hash is an integrity cross-check, not the identity key.

Use the SAME original monotonic clock and deadline through preparation and persistence. Reject nonfinite, negative or backward samples. Require writer-entry final-closing age in [0,30000] ms and current time strictly less than original deadline; total ceiling remains <=900000 ms. If preparation and persistence are split, repeat age/deadline checks at actual writer entry. Do not require the observation to remain <=30000 ms old throughout a permitted write; require original deadline and all revalidation predicates throughout. UTC capturedAt is never used for elapsed-time admission.

## 6. State transitions and completion

| State / event | Next state and required observable result |
| --- | --- |
| Reader fails/incomplete/unsettled | No handle eligible, no writer output |
| AVAILABLE + exact bound handle | CLAIMED synchronously, one attempt consumed |
| CLAIMED + invalid provenance/schema/size/time/root/token | REJECTED; creation counters zero; fixed acquisition_fixture_rejected |
| CLAIMED + all validation | PREPARED private immutable bytes; no filesystem creations yet |
| PREPARED + actual write entry checks | WRITING; create owned child 0700; fixed bindings.json first, receipt.json last, exclusive O_NOFOLLOW, each 0600 |
| WRITING + each I/O settles and succeeds | Verify descriptor/path dev/inode, current UID, regular/nlink1, modes, canonical root/child path, size and exact bytes before/after sync. No recursive deletion or overwrite. |
| Both files verified + file close succeeds + all final checks within deadline | SETTLED; return module-owned in-memory completion capability tied to exact pair identities and byte hashes |
| Any stage failure after creation | Permanently FAILED; one bounded owned cleanup attempt; return acquisition_fixture_rejected only if all operations settled and cleanup proved |
| Pending/late I/O, timeout or cleanup not proved | UNSETTLED/cleanup_unproved; no completion capability, no resumed writes/reads/validation from late results |
| Crash/restart, even with two plausible files | Evidence only; no SETTLED capability recovered from disk; any consumption attempt rejects |

Retain directory/file descriptors during pre/post-sync checks; before SETTLED all owned descriptors must close successfully and post-close path identity/ownership/mode/byte readback checks must finish using bounded read-only handles which must also close successfully. Do not assert immunity to a malicious same-user process; it is outside the fixture isolation boundary. No atomic crash durability or cross-process recovery is promised. Receipt bytes may become visible before a close failure; they contain no success flag and must NEVER be treated as a durable commit marker.

A matching pair is necessary but not sufficient for fixture consumption: require the same-process module-owned SETTLED capability plus fresh verification of the exact pair. No disk-only consumer, production consumer or resume-from-files API is admitted. Losing the capability on crash is fail-closed. This explicit consumer rule resolves the receipt-last/failed-close ambiguity without a third file, new authority store or impossible promise to undo a late OS write.

Cleanup deadline = min(failure-time+30000, original absolute deadline). No extension when time is exhausted. Remove only objects whose recorded creation ownership and current descriptor/path identity can be proved; preserve foreign/pre-existing/unknown entries. Never race deletion against an unsettled write: if quiescence cannot be established within the remaining deadline, skip destructive cleanup, return cleanup_unproved and retain the private directory. A late completion cannot schedule further creation or change failure to success. No unconditional recursive cleanup or retries. Finite external failure-code allowlist: acquisition_fixture_rejected, cleanup_unproved; no raw exceptions/logged payloads.

## 7. Deterministic future runtime oracles

The retained OVD-522 `test-oracles.json` (SHA256 `33d49937e1a265f0cb6e5ea2badeef401bce2f9a7d1241eb563c8c56cace5194`) enumerates inputs/events and outcomes. It is a test specification, NOT executed writer evidence. The later handoff unit must use real synthetic validator fixtures (not a chain of mocked success flags). The later writer unit must run the entire reader-to-writer success path and fault matrix, counting creation calls and checking preserved identities/bytes, not merely directory emptiness. No network or real secrets.

Doc/schema checks in OVD-522 may verify the schema meta-structure, examples, fixed source hashes and correspondence between schema/field matrix/oracles. They cannot satisfy future runtime acceptance. No database migration. Rollback is to leave the unaccepted contract version unused and preserve it as evidence, never rewrite the historical inputs.

## 8. Bounded source units

B implements private reader-scope consume/preparation, including clock/UTC
anchor/packet/egress retention and every projection above, with zero filesystem
creation. C implements one indivisible local TEST_ONLY filesystem transaction,
including identity-bounded cleanup, a same-process SETTLED capability and fresh
exact-pair verification. Their integration tests use actual disposable private
files plus deterministic failure injection. OVD-516 remains aggregate High and
requires its repository and independent-review gates before integration. No
OVD-517 or live workflow is admitted by this implementation.
