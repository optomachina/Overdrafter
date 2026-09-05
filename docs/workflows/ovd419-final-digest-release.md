# OVD-419 final worker digest release contract

Last updated: September 4, 2026

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

The live execution adapter installs a one-shot in-Job guard that enforces every
exact token after snapshot restoration and browser guard setup, immediately
before the browser may activate networking. It fails closed if it
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

If either qualification probe fails after promotion, the live adapter does not
leave the unqualified candidate serving. It freshly observes and restores the
Service and Job to the last-known-good digest with resource-version CAS, restores
the prior Service build version, and verifies final containment against the
post-probe execution inventory. Any incomplete rollback is a fixed fail-closed
terminal state.

### Live adapter usage and stop conditions

The reviewed adapter is `scripts/run-ovd419-live-release.mjs`. It supplies every
callback required by `promoteDigest` and `runNoUploadProbes` from fresh
production readbacks. It has no plan mode, no implicit execution mode, no
automatic retry, and no permissive production defaults. Invocation requires
all of the following:

- the literal `--execute` flag;
- a private owner-only authorization JSON file outside the repository;
- the reviewed digest/build-evidence bundle;
- a new private evidence path directly under the operating-system temporary
  directory;
- the exact OVD-410 production resource tuple, snapshot identity, and service
  role secret in the process environment; and
- an effective project role on the runtime service identity containing the
  read capabilities needed for `run.jobs.get` and `run.executions.list`;
  and
- an explicit absolute `OVD419_OWNER_LOCK_PATH` directly under the operating
  system temporary directory.

The authorization must be short-lived and exact for OVD-419, the candidate
image, full source commit, final-digest promotion, and two read-only provider
probes. It must separately set `authorizePromotion` and
`authorizeProviderReadOnlyProbes` to `true`. Treat this JSON as single-use and
keep it only as a private temporary operator artifact; do not add authorization
markdown or credential-bearing evidence to the repository. Before any cloud
operation, the adapter atomically consumes the nonce into an owner-only local
state receipt containing only its hash at the canonical OverDrafter OVD-419
authorization ledger; production invocation cannot redirect that ledger. A
replay is rejected even if the authorization has not expired.

```bash
export OVD419_OWNER_LOCK_PATH="${TMPDIR%/}/overdrafter-ovd419-live-release.lock"
node scripts/run-ovd419-live-release.mjs \
  --execute \
  --authorization-file /private/tmp/ovd419-authorization.json \
  --bundle-file /private/tmp/ovd419-qualified-bundle.json \
  --evidence-file "${TMPDIR%/}/ovd419-live-evidence.json"
```

Before any mutation, the adapter atomically acquires the owner-only lock and
binds it to the controller PID, process group, and session. When terminal-backed,
the controller must own the foreground terminal process group. Every
Job/Service replacement and every provider-facing execution revalidates that
same owner. An existing, replaced, malformed, non-private, or non-foreground
owner stops the release. Do not run a background or private competing driver.

Each promotion observation freshly recollects rollout state, both active
queues, the complete bounded execution inventory, both Cloud Run resources,
resource versions, immutable images, and stable-egress metadata. The dormant
Job is replaced first with `execute: false`; the Service is replaced second.
Every mutation uses the immediately observed resource version. Rollback is
symmetric: both resources are freshly read, restored with their own CAS token,
read back, and then subjected to full containment verification.
Containment also verifies the Service `WORKER_BUILD_VERSION` matches the
candidate source commit after promotion and the saved baseline after rollback.
When the only failing stable-egress fact is one or multiple syntactically valid
NAT mappings, containment performs a fixed 30-second, 40-minute-35-second
passive wait. The finite bound conservatively budgets Cloud Run's documented
20-minute Direct VPC address retention after scale-down, Cloud NAT's documented
20-minute established TCP idle timeout and five-second processing variance,
and one final observation interval. It does not admit any non-NAT failure.
The stable-egress verifier also requires the NAT's established TCP idle timeout
to be the provider's omitted 1,200-second default or an explicit value of
exactly 1,200 seconds; configuration drift fails closed without mutating NAT.
The after-Service phase check may hand only that exact NAT-only pending state
forward to the containment observer; it is not containment success, and any
malformed, mixed, or non-NAT stable-egress failure still stops promotion.
Every observation reasserts sole ownership and freshly rechecks rollout, both
queues, the complete execution inventory, snapshot version, Job/Service image
and build parity, and the full stable-egress contract. Any other drift stops the
wait immediately. The observer performs metadata reads only: it does not run a
Job, replace or roll back a resource, contact the provider, or generate traffic.
Success still requires a final fresh observation with exactly zero NAT mappings;
a timeout remains failed containment and never authorizes retry.

Immediately before each of exactly two sequential Job executions, the adapter
rechecks the snapshot version, complete execution inventory, Job resource
version, and canonical Job configuration fingerprint. The execution override
adds an in-Job guard that independently repeats those checks with the runtime
service identity after snapshot restoration and browser guard setup,
immediately before network activation. It admits
only the baseline inventory plus that execution's one active identity, so a
competing execution or configuration race stops before browser networking is
enabled. The adapter retains only the runner's bounded evidence; snapshot
tokens, execution names, provider URLs, logs, credentials, session data, and
customer data are excluded. The CLI reserves the evidence file with owner-only
permissions before ownership acquisition and refuses to overwrite an existing
path, so storage availability cannot fail for the first time after cloud
mutation. After qualification it syncs the bounded success evidence before
releasing the owner lock; standard output contains only a fixed success line.

### Offline Cloud CLI compatibility gate

The authentication Job manifest sets `command: ["node"]`, and the stable-egress
verifier rejects any other command before probe admission. Job identity and
configuration are rechecked immediately before execution and by the in-Job
guard. The execution inherits that validated command and overrides only its
arguments with the guarded module expression; `gcloud run jobs execute` does
not support `--command`. Do not replace this with a Job update or weaken the
configuration checks.

Before reviewing a probe invocation change, run the normal focused tests and
the explicit installed-SDK compatibility check:

```bash
OVD419_VALIDATE_GCLOUD_HELP=1 npm test -- scripts/run-ovd419-live-release.test.mjs
```

The opt-in check captures the adapter's generated arguments without executing
them, then compares their flag names with the real `gcloud run jobs execute
--help` surface using an isolated local configuration. It fails if the SDK is
missing or an unsupported flag is present. Ordinary CI still checks the fixed
supported flag contract without requiring an SDK. This check reads local help
only: it does not submit a Job, inspect cloud resources, contact a provider, or
prove live release success. See the [official command reference](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/execute).

### Failure and interruption evidence

Failure writes the same owner-only evidence path when possible and emits only
one fixed terminal code. `probe_failed_rolled_back` means the candidate failed
qualification and the last-known-good baseline was restored;
`probe_failed_rollback_failed` means rollback containment is unverified and the
release must be treated as quarantined. Neither state authorizes retry.
Probe failures retain only an allowlisted `probeFailureStage`, an allowlisted
`probeFailureCode`, and the boolean `probeExecutionIdIndependentlyObserved`.
Both orchestration layers use the private allowlists in
`scripts/ovd419-failure-vocabulary.mjs`; the shared predicates preserve exact
membership without exposing mutable collections or changing fallback values.
An unrecognized error becomes bounded unknown evidence; raw errors, command
arguments, identifiers, and logs are not retained. A false
`probeExecutionIdIndependentlyObserved` value means no execution ID was
independently corroborated by fresh inventory. The adapter may already have
returned an ID before result validation or inventory corroboration fails.
False is not proof that Cloud Run rejected the request or that provider traffic
was absent.
`promotion_failed_before_mutation` means the promotion stopped before a Cloud
Run replacement was attempted, while `promotion_failed_rolled_back` means a
replacement path failed and verified baseline containment was restored. Both
states release the owner lock after durable evidence and require a new
authorization for any later attempt.
`promotion_failed_rollback_unverified` means a replacement path failed and
rollback containment could not be verified. It preserves only the allowlisted
promotion failure code and stage, retains the owner lock as a recovery
sentinel, quarantines the release, and never authorizes a retry.
`SIGINT` and `SIGTERM` are deferred rather than allowed to terminate the
controller immediately. During promotion or probe containment, the controller
finishes the current bounded metadata collection, notices the signal before the
next passive observation, and performs fresh readback and rollback/containment
when mutation may have occurred. Rollback containment itself is not interrupted;
it reaches its finite verified or failed terminal result before the controller
syncs `interrupted_before_mutation`,
`interrupted_rolled_back`, or `interrupted_rollback_failed` evidence, and only
then releases ownership. A signal received after both probes have passed is
recorded as `passed_interrupted_after_qualification`; the qualified result is
not rolled back or retried.
Rollback-unverified and otherwise unclassified failures retain the owner lock
as a recovery sentinel; only a before-mutation or verified-contained failure
releases it normally.
`passed_owner_lock_release_failed` and `passed_evidence_write_failed` preserve a
successful release outcome while truthfully reporting local residue or missing
durable evidence; they also do not authorize retry.

`SIGKILL`, host loss, and power loss cannot be handled in-process. After any
stale owner lock, empty evidence file, or partial evidence file, do not delete
the lock and do not reuse the authorization. First confirm that the recorded
owner process is absent, then perform fresh read-only inspection of both Cloud
Run image digests, resource versions, the Service build version, the complete
execution inventory, both active queues, rollout controls, the snapshot
generation/metageneration/etag tuple, and stable-egress configuration. A mixed
digest, active execution, changed snapshot, non-empty queue, enabled rollout,
or otherwise ambiguous result remains quarantined and requires separately
authorized baseline containment. Remove the stale lock only after the live
state is classified and safely contained. A new authorization and evidence
path are required for any later attempt; no provider probe may run during
recovery classification.

Live execution must stop if any required environment value, authorization
field, owner check, readback, stable-egress fact, queue fact, inventory entry,
CAS token, snapshot token, configuration fingerprint, probe evidence field, or
containment result is missing or ambiguous. The plan-only
`run-ovd419-final-digest-release.mjs` CLI remains validation only and is not
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

## Current contained live handoff

The latest sanitized terminal state is recorded in
[`docs/release/ovd-419-contained-live-handoff.json`](../release/ovd-419-contained-live-handoff.json).
The single newly authorized controller ended `probe_failed_rolled_back`;
baseline containment was restored and the owner lock was released. Complete
execution inventory remained stable at 13 total and zero active across pre- and
post-terminal reads, but no execution identity crossed the adapter boundary.
Cloud Run acceptance and provider activity therefore remain unknown rather than
being claimed false. The controller did not advance to ordinal 2. The runner
still invoked its mandatory final inventory and containment evaluation before
surfacing the failure, but the retained evidence did not attribute the failing
stage. The candidate remains absent; baseline Job/Service image and Service
build parity hold; rollout controls remain disabled; both queues are empty; the
snapshot is stable; and egress/NAT checks remain clean.

The exact pre-acceptance trigger is not recoverable from the bounded evidence.
The next admitted work is an offline code/evidence improvement that retains an
allowlisted probe failure stage and code. The consumed authorization and prior
evidence path are not reusable, and this handoff does not authorize another
live controller or provider-facing request.
