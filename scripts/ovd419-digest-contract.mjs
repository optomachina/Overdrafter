import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RESOURCE_VERSION_PATTERN = /^\d{1,20}$/;
const PRE_MUTATION_PHASES = new Set(["before-job", "before-service"]);

export const OVD419_DIGEST_CONTRACT = Object.freeze({
  contractId: "ovd419-digest-v1",
  schemaVersion: 1,
  project: "overdrafter-worker-9133",
  region: "us-west1",
  service: "overdrafter-cad-worker",
  job: "overdrafter-xometry-auth-probe",
  imageRepository:
    "us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/overdrafter-cad-worker",
});

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isFullSha(value) {
  return FULL_SHA_PATTERN.test(value ?? "");
}

export function isImmutableImage(value) {
  if (typeof value !== "string") {
    return false;
  }
  const prefix = `${OVD419_DIGEST_CONTRACT.imageRepository}@`;
  return value.startsWith(prefix) && IMAGE_DIGEST_PATTERN.test(value.slice(prefix.length));
}

/**
 * Parse and fully validate an OVD-419 digest release record.
 * Fail-closed: rejects tags, short-SHA-only evidence, dirty worktree records,
 * record-version mismatch, and unknown fields.
 */
export function parseDigestRecord(source) {
  if (ArrayBuffer.isView(source)) {
    source = new TextDecoder("utf-8", { fatal: true }).decode(source);
  }
  if (typeof source !== "string") {
    throw new TypeError("digest record source must be a string or UTF-8 bytes");
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new TypeError(`digest record is not valid JSON: ${error.message}`);
  }
  if (!isObject(raw)) {
    throw new TypeError("digest record must be a JSON object");
  }

  const allowed = new Set([
    "contractId",
    "schemaVersion",
    "commit",
    "image",
    "worktreeClean",
    "buildVersion",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new TypeError(`digest record has unknown field "${key}"`);
    }
  }

  if (raw.contractId !== OVD419_DIGEST_CONTRACT.contractId) {
    throw new TypeError(`digest record contractId must be "${OVD419_DIGEST_CONTRACT.contractId}"`);
  }
  if (raw.schemaVersion !== OVD419_DIGEST_CONTRACT.schemaVersion) {
    throw new TypeError(
      `digest record schemaVersion must be ${OVD419_DIGEST_CONTRACT.schemaVersion}`,
    );
  }
  if (!isFullSha(raw.commit)) {
    throw new TypeError('digest record "commit" must be a full 40-character hex SHA; tags, short SHAs, and annotated refs are rejected');
  }
  if (!isImmutableImage(raw.image)) {
    throw new TypeError(
      `digest record "image" must be "${OVD419_DIGEST_CONTRACT.imageRepository}@sha256:<64-hex>"`,
    );
  }
  if (raw.worktreeClean !== true) {
    throw new TypeError('digest record "worktreeClean" must be true; dirty-tree builds are rejected');
  }
  // Record consistency only: independent build evidence must attest that this
  // immutable image was actually built from the recorded source commit.
  if (raw.buildVersion !== raw.commit) {
    throw new TypeError('digest record "buildVersion" must equal the full commit SHA');
  }

  return Object.freeze({
    contractId: raw.contractId,
    schemaVersion: raw.schemaVersion,
    commit: raw.commit,
    image: raw.image,
    worktreeClean: raw.worktreeClean,
    buildVersion: raw.buildVersion,
  });
}

/**
 * Evaluate fail-closed pre-mutation checks for promoting one digest to both
 * governed resources. Aggregates violated invariants; returns a
 * frozen verdict object when every check passes.
 */
export function evaluatePreMutationChecks(record, observed) {
  const validatedRecord = parseDigestRecord(JSON.stringify(record));
  if (!isObject(observed)) {
    throw new TypeError("observed preconditions must be an object");
  }

  const failures = [];
  const expect = (condition, label) => {
    if (!condition) failures.push(label);
  };
  const expectZero = (field, emptyLabel) => {
    const value = observed[field];
    if (!Number.isInteger(value) || value < 0) {
      failures.push(`${field} must be a non-negative integer`);
      return;
    }
    expect(value === 0, emptyLabel);
  };

  expect(PRE_MUTATION_PHASES.has(observed.phase), "phase must be before-job or before-service");

  expect(isObject(observed.rollout), "rollout observation missing");
  if (isObject(observed.rollout)) {
    expect(observed.rollout.disabled === true, "rollout must be disabled before mutation");
  }

  expectZero("queueDepthJob", "probe job queue must be empty");
  expectZero("queueDepthService", "service queue must be empty");
  expectZero("executionCount", "execution count must be zero");

  for (const field of ["jobResourceVersion", "serviceResourceVersion"]) {
    const value = observed[field];
    expect(typeof value === "string" && RESOURCE_VERSION_PATTERN.test(value), `${field} must be a decimal resource version string`);
  }

  for (const field of ["jobImage", "serviceImage", "rollbackImage"]) {
    expect(isImmutableImage(observed[field]), `${field} must be an approved immutable image reference`);
  }
  if (
    isImmutableImage(observed.jobImage) &&
    isImmutableImage(observed.serviceImage) &&
    isImmutableImage(observed.rollbackImage)
  ) {
    expect(
      observed.rollbackImage !== validatedRecord.image,
      "rollbackImage must differ from the candidate image",
    );
    if (observed.phase === "before-job") {
      expect(observed.jobImage === observed.rollbackImage, "jobImage must match rollbackImage before Job mutation");
      expect(observed.serviceImage === observed.rollbackImage, "serviceImage must match rollbackImage before Job mutation");
    } else if (observed.phase === "before-service") {
      expect(observed.jobImage === validatedRecord.image, "jobImage must match the candidate image before Service mutation");
      expect(observed.serviceImage === observed.rollbackImage, "serviceImage must match rollbackImage before Service mutation");
    }
  }

  if (failures.length > 0) {
    throw new Error(`pre-mutation checks failed:\n  - ${failures.join("\n  - ")}`);
  }

  return Object.freeze({
    verdict: "pass",
    contractId: OVD419_DIGEST_CONTRACT.contractId,
    phase: observed.phase,
    commit: validatedRecord.commit,
    image: validatedRecord.image,
    rollbackImage: observed.rollbackImage,
    jobResourceVersion: observed.jobResourceVersion,
    serviceResourceVersion: observed.serviceResourceVersion,
  });
}

export function isDirectCli(importMetaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(path.resolve(entry));
  } catch {
    return false;
  }
}

if (isDirectCli(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "--stdin" || process.argv.length !== 3) {
    process.stderr.write(
      "usage: node scripts/ovd419-digest-contract.mjs --stdin < digest-record.json\n",
    );
    process.exit(2);
  }
  try {
    const record = parseDigestRecord(readFileSync(0, "utf8"));
    process.stdout.write(
      `${JSON.stringify({
        verdict: "record-valid",
        contractId: record.contractId,
        schemaVersion: record.schemaVersion,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof TypeError ? error.message : "digest record rejected";
    process.stderr.write(`REJECTED: ${message}\n`);
    process.exit(1);
  }
}
