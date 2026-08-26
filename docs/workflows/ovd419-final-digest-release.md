# OVD-419 final worker digest release contract

Last updated: August 26, 2026

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
record-only CLI pass is never a pre-mutation verdict. The CLI accepts only a
regular file whose resolved path remains inside its current working directory
and emits only the contract id, schema version, and verdict; it does not echo
the source SHA or image digest.

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

## Pre-mutation observation

Immediately before each authorized mutation, capture one observation object
with all of the following:

- `phase` is exactly `before-job` or `before-service`
- `rollout.disabled` is exactly `true`
- `queueDepthJob`, `queueDepthService`, and `executionCount` are non-negative
  integers and exactly zero
- `jobResourceVersion` and `serviceResourceVersion` are non-empty decimal
  resource-version strings used for concurrency protection
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

No mixed-digest state is a valid handoff. No helper result permits an automatic
retry, `:latest` update, provider upload, quote request, billing enablement, or
order action.

## Evidence boundary

Repository-safe evidence may retain the contract version, full source SHA,
exact immutable digest, non-secret build identifiers, resource-version
postcondition result, zero-count queue/execution facts, and sanitized rollback
result. Do not retain credentials, session or snapshot material, provider
response bodies, customer files, protected operator paths, or raw cloud logs in
the repository, GitHub, or Linear.
