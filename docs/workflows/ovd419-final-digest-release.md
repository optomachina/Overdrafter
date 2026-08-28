# OVD-419 final worker digest release contract

Last updated: August 27, 2026

## Purpose

This workflow defines the repository-verifiable, pre-mutation contract for the
final OVD-408 worker image release coordinated by OVD-419 and OVD-416. It does
not authorize a build, deployment, Cloud Run mutation, credential operation,
provider request, or probe. Those operations remain separately gated by the
OVD-410 live-acceptance result and exact owner authorization.

The local validator is `scripts/ovd419-digest-contract.mjs`; its focused tests
are `scripts/ovd419-digest-contract.test.mjs`. The direct CLI validates only
the digest record. A reviewed promotion helper must import
`evaluatePreMutationChecks` and pass the fresh phase-specific observation; a
record-only CLI pass is never a pre-mutation verdict. The CLI accepts record
JSON only on standard input through the explicit `--stdin` mode; it accepts no
record path. It emits only the contract id, schema version, and verdict and
does not echo the source SHA or image digest.

The bounded orchestration contract is
`scripts/run-ovd419-final-digest-release.mjs`; its focused tests are
`scripts/run-ovd419-final-digest-release.test.mjs`. Its direct CLI is
deliberately plan-only:

```bash
node scripts/run-ovd419-final-digest-release.mjs --plan-stdin < authorized-plan-bundle.json
```

The bundle contains `record` and `buildEvidence`. A valid plan emits only fixed
phase names and bounded probe counts; it does not echo a source SHA, image,
build identifier, snapshot identifier, or operator path. There is no direct
CLI execution flag and the module never shells out to `gcloud`.

## Digest record

The reviewed record is JSON with exactly these fields:

- `contractId`: `ovd419-digest-v1`
- `schemaVersion`: `1`
- `commit`: the clean full 40-character lowercase Git SHA
- `image`: the exact immutable image in
  `us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/overdrafter-cad-worker@sha256:<64 lowercase hex>`
- `worktreeClean`: `true`
- `buildVersion`: the same full SHA as `commit`

Tags, short or uppercase SHAs, dirty-tree records, mutable image references,
foreign repositories, unknown fields, and mismatched build-version fields are
rejected.

Equality between `buildVersion` and `commit` proves only that the record is
self-consistent. It does not prove that the image content was built from that
commit. Qualification must separately retain the Cloud Build record, exact
source identity and manifest, published digest, and independent runtime
inspection for the final post-OVD-408 image.

`attestBuildOnly` makes that independent evidence executable. It requires:

- a clean full-SHA source identity plus SHA-256 archive and manifest hashes;
- one successful build id bound to that same source SHA, exact image, source
  archive SHA-256, and source manifest SHA-256;
- exactly one tag resolution to the record digest;
- zero deploy steps in the build;
- a `linux/amd64`, network-disabled runtime inspection of that exact image;
- the full SHA as the inspected `WORKER_BUILD_VERSION`; and
- a stopped worker entrypoint, present required assets, and matching critical
  file hashes during inspection.

The attestation function only validates captured evidence. It cannot submit a
build, inspect a registry, start a container, or deploy a resource.

## Pre-mutation observation

Immediately before each authorized mutation, capture one observation object
with all of the following:

- `phase` is exactly `before-job` or `before-service`
- `rollout.disabled` is exactly `true`
- `queueDepthJob`, `queueDepthService`, and `executionCount` are non-negative
  integers and exactly zero; `executionCount` is the active-execution count
- `executionInventoryCount` is the total historical execution count and
  `executionInventoryFingerprint` is the SHA-256 of the canonical complete
  execution inventory
- `jobResourceVersion` and `serviceResourceVersion` are bounded, non-empty
  opaque Cloud Run resource-version strings used for concurrency protection;
  they are not assumed to be decimal
- `jobImage` and `serviceImage` are approved immutable image references
- `rollbackImage` is the approved last-known-good immutable image
- `rollbackImage` differs from the candidate digest

OVD-419 is not a first deployment. A missing rollback image is invalid. If the
candidate already equals the rollback image, the release is a no-op and must
stop before mutation rather than manufacture new revision evidence. The helper
therefore rejects both a missing rollback baseline and a candidate/rollback
match.

Image-state expectations are phase-specific:

- `before-job`: both `jobImage` and `serviceImage` equal `rollbackImage`
- `before-service`: `jobImage` equals the candidate image and `serviceImage`
  still equals `rollbackImage`

The second state is the intentional transient fail-closed state after the
dormant Job is replaced without execution. It is eligible only for immediate
Service mutation or rollback; it is never a release handoff.

Malformed and violated observations are aggregated into one fail-closed error
so an operator can see every known pre-mutation failure without treating one
early parse exception as a complete result.

Every injected observation is structured-cloned and recursively frozen before
the verifier or evaluator receives it. The verifier cannot mutate nested
rollout, queue, execution, image, or version evidence after collection. A
non-cloneable observation fails with a fixed public error code.

## Mutation and rollback boundary

Passing the local helper is necessary but not sufficient for release. An
authorized operator must still:

1. prove OVD-410 live acceptance is complete and OVD-418 production readback
   remains valid;
2. qualify one clean post-OVD-408 image and bind its independent build evidence
   to the record;
3. recapture the pre-mutation observation immediately before replacing the
   dormant Job without executing it;
4. read the Job back and prove its image and every OVD-410 control;
5. recapture the observation immediately before the Service mutation, using
   the current resource versions and the recorded last-known-good parity image;
6. deploy and shift the private Service, then prove Job/Service convergence on
   the candidate digest;
7. on any failed or uncertain mutation, read both resources before acting,
   restore every changed resource to `rollbackImage`, and re-prove parity,
   zero executions, empty queues, disabled rollout, and containment; and
8. run the two fresh-instance no-upload proofs only under their separate exact
   authorizations.

`promoteDigest` enforces those configuration phases around dependency-injected
operations. Execution mode has no permissive defaults: the authorized caller
must supply fresh observation, a real observation verifier, Job replacement,
Service replacement, resource-local rollback observation and readback, and
final containment callbacks. The runner:

1. re-attests the build evidence;
2. obtains and evaluates a fresh `before-job` observation;
3. passes that exact Job resource version to a Job replacement with
   `execute: false`;
4. reads the Job back and requires a new version, candidate digest, unchanged
   Service version, zero active executions, and the unchanged total execution
   inventory count and fingerprint;
5. obtains and evaluates a distinct fresh `before-service` observation;
6. rejects any version or total execution-inventory change between the Job
   readback and Service preflight;
7. passes the exact Service resource version and full build SHA to Service
   replacement;
8. reads both resources back at the candidate digest with a new Service
   version, empty queues, disabled rollout, and zero Job executions; and
9. requires the final total execution inventory to match the original
   `before-job` inventory and passes that immutable baseline into final
   containment verification.

Once either replacement is attempted, any failed or uncertain step enters
symmetric rollback. The runner freshly observes the Service and Job
individually, passes each observed resource version to its rollback mutation
when its image changed, reads each resource back, and then verifies containment
at the last-known-good digest. It emits fixed failure codes rather than raw
cloud errors. Rollback containment receives the original total execution
inventory baseline so a completed or otherwise newly recorded Job execution
cannot be treated as reversible. A mixed-digest, changed execution inventory,
or unverified rollback is always a failure.

Every dependency-injected callback is invoked through the internal typed error
boundary. Exceptions, rejected promises, non-cloneable return values, and
invalid verifier results are mapped to allowlisted fixed codes. Raw messages,
provider responses, credentials, cookies, and operator paths are never copied
into an outward error.

`runNoUploadProbes` similarly has no live defaults. It requires injected
snapshot, complete execution-inventory, Job-identity, execution, and containment
callbacks. Before the initial snapshot, it independently captures the complete
historical execution-id inventory, verifies its canonical SHA-256 fingerprint,
requires zero active executions, and passes that frozen baseline into full
containment and blocked-admission verification. It then records one immutable
generation/metageneration/etag baseline and runs exactly two awaited executions
in sequence.

Immediately before each execution, the runner:

1. recaptures the complete execution inventory and requires exact equality to
   the expected baseline;
2. recaptures and compares the snapshot version;
3. obtains full containment/admission preflight evidence, including the exact
   Job resource version and canonical configuration fingerprint;
4. recaptures the snapshot, Job identity, and execution inventory after that
   preflight and rejects any concurrency change; and
5. passes the frozen snapshot triple, Job identity, and execution inventory to
   `executeProbe` with `enforceBeforeBrowserNetworkActivation: true`.

The future live execution adapter must enforce every exact token inside the Job
execution before the browser may activate networking. It must fail closed if it
cannot prove the snapshot generation/metageneration/etag, Job resource version,
Job configuration fingerprint, and complete execution inventory still match;
merely accepting or echoing the callback input is not evidence. A successful
adapter result must set
`preconditionsEnforcedBeforeBrowserNetworkActivation: true`; omission or false
is rejected, while the independent post-execution inventory remains the
authoritative proof of what actually completed.

Each execution must prove a unique execution identity, fresh instance, exact
candidate image, one task, zero retries, authenticated dashboard, no file
selection, no user-input interaction, no snapshot persistence, no screenshot,
DOM, or trace capture, no provider mutation, the exact
`read_only_authentication` dashboard interaction, and no blocked non-read
method. Snapshot version evidence is recaptured before and after each
execution. After each awaited execution, the runner independently recaptures
the complete inventory and requires exactly one new completed execution whose
id equals the adapter result, while active execution count is zero. Probe two
cannot start otherwise. Final evidence must be the original inventory plus
exactly those two execution ids, and that final frozen inventory is passed into
containment verification. The runner independently recaptures the inventory
once more before final containment even when execution returns an error or an
earlier check fails; the containment callback receives both the expected and
last observed frozen inventories. Output is reconstructed from an allowlist
and cannot retain the provider URL, execution id, raw log content, unexpected
fields, or the exact snapshot generation, metageneration, or etag. Those
snapshot tokens remain internal validation inputs only and are omitted from
both per-probe public evidence and the top-level probe result.
Final containment and blocked admission are attempted even when a probe,
preflight, inventory, or snapshot check fails.

### Live adapter stop condition

This repository does not currently contain one reviewed adapter that can
freshly and atomically collect all of the live rollout-disabled, dual-queue,
execution, Cloud Run resource-version, image, and stable-egress facts required
by `evaluatePreMutationChecks`. The local runner therefore must not be invoked
for live execution by inventing a queue source, replaying saved observations,
or substituting a boolean for an unperformed verifier. OVD-419 live execution
stops until a separately reviewed authorized adapter supplies every mandatory
callback from fresh live readbacks and preserves the resource-version and
total-execution-inventory preconditions. The probe adapter must also produce,
not infer, the expanded no-capture/read-only evidence fields and preserve the
snapshot generation/metageneration/etag and Job resource-version/configuration
preconditions before browser network activation. Its independent inventory
collector must return the complete bounded execution-id set, zero-or-positive
active count, total count, and canonical fingerprint. The plan-only CLI is not
promotion or probe evidence.

No mixed-digest state is a valid handoff. No helper result permits an automatic
retry, `:latest` update, provider upload, quote request, billing enablement, or
order action.

## Evidence boundary

Repository-safe evidence may retain the contract version, full source SHA,
exact immutable digest, non-secret build identifiers, resource-version
postcondition result, zero-count active queue/execution facts, total execution
inventory count and fingerprint, and sanitized rollback result. Do not retain
credentials, session or snapshot material (including exact snapshot generation,
metageneration, or etag), provider
response bodies, customer files, protected operator paths, or raw cloud logs in
the repository, GitHub, or Linear.
