#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  evaluatePreMutationChecks,
  isDirectCli,
  isImmutableImage,
  isObject,
  isResourceVersion,
  parseDigestRecord,
} from "./ovd419-digest-contract.mjs";

const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d{0,19}$/;
const BOUNDED_TOKEN_PATTERN = /^[A-Za-z0-9+/_=-]{1,256}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EXECUTION_INVENTORY = 10_000;
const PROBE_COUNT = 2;
const PUBLIC_ERROR_CODES = new Set([
  "build_evidence_invalid",
  "build_attestation_failed",
  "containment_operation_failed",
  "execution_inventory_invalid",
  "execution_inventory_changed",
  "final_containment_failed",
  "job_readback_failed",
  "job_replacement_operation_failed",
  "internal_contract_error",
  "live_observation_invalid",
  "live_observation_not_verified",
  "observation_operation_failed",
  "observation_snapshot_failed",
  "observation_verifier_operation_failed",
  "pre_service_observation_changed",
  "probe_evidence_failed",
  "probe_execution_contract_failed",
  "probe_execution_operation_failed",
  "probe_final_containment_failed",
  "probe_image_invalid",
  "probe_inventory_changed",
  "probe_inventory_completion_mismatch",
  "probe_inventory_invalid",
  "probe_inventory_operation_failed",
  "probe_job_identity_changed",
  "probe_job_identity_invalid",
  "probe_job_observation_operation_failed",
  "probe_operations_missing",
  "probe_preflight_failed",
  "probe_sequence_failed",
  "promotion_failed_before_mutation",
  "promotion_failed_rolled_back",
  "promotion_operations_missing",
  "resource_readback_operation_failed",
  "resource_rollback_operation_failed",
  "rollback_or_containment_failed",
  "rollback_resource_observation_invalid",
  "service_readback_failed",
  "service_replacement_operation_failed",
  "snapshot_changed_before_probe",
  "snapshot_changed_by_probe",
  "snapshot_operation_failed",
  "snapshot_version_invalid",
]);

class Ovd419RunnerError extends Error {
  constructor(code) {
    super(`OVD-419 ${code}`);
    this.name = "Ovd419RunnerError";
    this.code = code;
  }
}

function freeze(value, seen = new WeakSet()) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => freeze(entry, seen));
  } else if (isObject(value)) {
    Object.values(value).forEach((entry) => freeze(entry, seen));
  }
  return Object.freeze(value);
}

function fail(code) {
  const publicCode = PUBLIC_ERROR_CODES.has(code) ? code : "internal_contract_error";
  throw new Ovd419RunnerError(publicCode);
}

function publicError(error, fallbackCode) {
  const code =
    error instanceof Ovd419RunnerError && PUBLIC_ERROR_CODES.has(error.code)
      ? error.code
      : fallbackCode;
  return new Ovd419RunnerError(code);
}

function snapshotValue(value, code) {
  try {
    return freeze(structuredClone(value));
  } catch {
    fail(code);
  }
}

async function invoke(operation, input, code) {
  try {
    return await operation(input);
  } catch {
    throw new Ovd419RunnerError(code);
  }
}

async function invokeSnapshot(operation, input, operationCode, snapshotCode) {
  const value = await invoke(operation, input, operationCode);
  return snapshotValue(value, snapshotCode);
}

function digestFromImage(image) {
  const digest = image?.split("@")[1];
  return DIGEST_PATTERN.test(digest ?? "") ? digest : null;
}

/**
 * Bind independently captured clean-source, Cloud Build, registry, and
 * network-disabled runtime evidence to the reviewed immutable digest record.
 * This validates evidence only; it never starts a build or deployment.
 */
export function attestBuildOnly(recordSource, evidence) {
  const record = parseDigestRecord(recordSource);
  if (!isObject(evidence)) fail("build_evidence_invalid");

  const source = evidence.source;
  const build = evidence.build;
  const runtime = evidence.runtime;
  const expectedDigest = digestFromImage(record.image);
  const failures = [];
  const expect = (condition, code) => {
    if (!condition) failures.push(code);
  };

  expect(isObject(source), "source_evidence_missing");
  if (isObject(source)) {
    expect(source.commit === record.commit, "source_commit_mismatch");
    expect(source.worktreeClean === true, "source_not_clean");
    expect(HASH_PATTERN.test(source.archiveSha256 ?? ""), "source_archive_hash_invalid");
    expect(HASH_PATTERN.test(source.manifestSha256 ?? ""), "source_manifest_hash_invalid");
  }

  expect(isObject(build), "build_evidence_missing");
  if (isObject(build)) {
    expect(BUILD_ID_PATTERN.test(build.id ?? ""), "build_id_invalid");
    expect(build.status === "SUCCESS", "build_not_successful");
    expect(build.sourceCommit === record.commit, "build_source_commit_mismatch");
    expect(
      build.sourceArchiveSha256 === source?.archiveSha256,
      "build_source_archive_mismatch",
    );
    expect(
      build.sourceManifestSha256 === source?.manifestSha256,
      "build_source_manifest_mismatch",
    );
    expect(build.exactImage === record.image, "build_image_mismatch");
    expect(build.tagEntryCount === 1, "build_tag_not_unique");
    expect(build.tagResolvedManifestDigest === expectedDigest, "build_digest_mismatch");
    expect(build.deployStepCount === 0, "build_was_not_build_only");
  }

  expect(isObject(runtime), "runtime_evidence_missing");
  if (isObject(runtime)) {
    expect(runtime.image === record.image, "runtime_image_mismatch");
    expect(runtime.buildVersion === record.commit, "runtime_build_version_mismatch");
    expect(runtime.platform === "linux/amd64", "runtime_platform_mismatch");
    expect(runtime.network === "none", "runtime_network_not_disabled");
    expect(runtime.workerEntrypointStarted === false, "runtime_worker_started");
    expect(runtime.requiredRuntimeAssetsPresent === true, "runtime_assets_missing");
    expect(runtime.criticalFileHashesMatched === true, "runtime_hashes_mismatch");
  }

  if (failures.length > 0) fail("build_attestation_failed");

  return freeze({
    verdict: "build-attested",
    contractId: record.contractId,
    commit: record.commit,
    image: record.image,
    buildId: build.id,
    sourceArchiveSha256: source.archiveSha256,
    sourceManifestSha256: source.manifestSha256,
  });
}

async function verifyObservation(operations, observed, phase) {
  if (!isObject(observed)) fail("live_observation_invalid");
  const verdict = await invokeSnapshot(
    operations.verifyObservation,
    { observed, phase },
    "observation_verifier_operation_failed",
    "observation_snapshot_failed",
  );
  if (
    !isObject(verdict) ||
    verdict.ok !== true ||
    !Array.isArray(verdict.failures) ||
    verdict.failures.length !== 0
  ) {
    fail("live_observation_not_verified");
  }
  return observed;
}

async function collectObservation(operations, phase) {
  const observed = await invokeSnapshot(
    operations.observe,
    { phase },
    "observation_operation_failed",
    "observation_snapshot_failed",
  );
  return verifyObservation(operations, observed, phase);
}

function captureExecutionInventory(observed) {
  if (
    !Number.isSafeInteger(observed?.executionInventoryCount) ||
    observed.executionInventoryCount < 0 ||
    !HASH_PATTERN.test(observed?.executionInventoryFingerprint ?? "")
  ) {
    fail("execution_inventory_invalid");
  }
  return freeze({
    count: observed.executionInventoryCount,
    fingerprint: observed.executionInventoryFingerprint,
  });
}

function requireUnchangedExecutionInventory(observed, expected) {
  const current = captureExecutionInventory(observed);
  if (current.count !== expected.count || current.fingerprint !== expected.fingerprint) {
    fail("execution_inventory_changed");
  }
}

function containmentPassed(verdict) {
  return (
    isObject(verdict) &&
    verdict.ok === true &&
    verdict.admissionBlocked === true &&
    Array.isArray(verdict.failures) &&
    verdict.failures.length === 0
  );
}

async function requireContainment(operations, input, failureCode) {
  const verdict = await invokeSnapshot(
    operations.verifyContainment,
    input,
    "containment_operation_failed",
    "observation_snapshot_failed",
  );
  if (!containmentPassed(verdict)) fail(failureCode);
  return verdict;
}

function hasResourceVersion(observed, field) {
  return isResourceVersion(observed?.[field]);
}

function assertFreshJobReadback(observed, record, before) {
  if (
    observed.jobImage !== record.image ||
    observed.serviceImage !== before.rollbackImage ||
    observed.executionCount !== 0 ||
    !hasResourceVersion(observed, "jobResourceVersion") ||
    !hasResourceVersion(observed, "serviceResourceVersion") ||
    observed.jobResourceVersion === before.jobResourceVersion ||
    observed.serviceResourceVersion !== before.serviceResourceVersion
  ) {
    fail("job_readback_failed");
  }
}

function assertFinalReadback(observed, record, beforeService) {
  if (
    observed.jobImage !== record.image ||
    observed.serviceImage !== record.image ||
    observed.executionCount !== 0 ||
    observed.queueDepthJob !== 0 ||
    observed.queueDepthService !== 0 ||
    observed.rollout?.disabled !== true ||
    !hasResourceVersion(observed, "jobResourceVersion") ||
    !hasResourceVersion(observed, "serviceResourceVersion") ||
    observed.jobResourceVersion !== beforeService.jobResourceVersion ||
    observed.serviceResourceVersion === beforeService.serviceResourceVersion
  ) {
    fail("service_readback_failed");
  }
}

function validateResourceSnapshot(snapshot, resource) {
  if (
    !isObject(snapshot) ||
    snapshot.resource !== resource ||
    !isImmutableImage(snapshot.image) ||
    !isResourceVersion(snapshot.resourceVersion)
  ) {
    fail("rollback_resource_observation_invalid");
  }
  return snapshot;
}

async function rollbackPromotion(operations, rollbackImage, executionInventory) {
  const results = [];
  for (const resource of ["service", "job"]) {
    try {
      const before = validateResourceSnapshot(
        await invokeSnapshot(
          operations.observeRollbackResource,
          { resource },
          "resource_readback_operation_failed",
          "observation_snapshot_failed",
        ),
        resource,
      );
      if (before.image !== rollbackImage) {
        await invoke(
          operations.rollbackResource,
          {
            resource,
            image: rollbackImage,
            expectedResourceVersion: before.resourceVersion,
          },
          "resource_rollback_operation_failed",
        );
      }
      const after = validateResourceSnapshot(
        await invokeSnapshot(
          operations.readbackRollbackResource,
          { resource },
          "resource_readback_operation_failed",
          "observation_snapshot_failed",
        ),
        resource,
      );
      const versionIsValid =
        before.image === rollbackImage
          ? after.resourceVersion === before.resourceVersion
          : after.resourceVersion !== before.resourceVersion;
      results.push(after.image === rollbackImage && versionIsValid);
    } catch {
      results.push(false);
    }
  }
  let contained = false;
  try {
    await requireContainment(
      operations,
      {
        expectedImage: rollbackImage,
        expectedExecutionInventory: executionInventory,
        stage: "rollback-final",
      },
      "rollback_or_containment_failed",
    );
    contained = true;
  } catch {
    contained = false;
  }
  if (results.some((result) => !result) || !contained) fail("rollback_or_containment_failed");
}

/**
 * Promote a pre-attested digest Job-first and Service-second. Every operation
 * is injected, making the contract testable without cloud access. A failed or
 * uncertain mutation triggers fresh, resource-local rollback of both sides.
 */
export async function promoteDigest({ recordSource, buildEvidence, operations, execute = false }) {
  const record = parseDigestRecord(recordSource);
  const attestation = attestBuildOnly(recordSource, buildEvidence);
  if (!execute) {
    return freeze({
      status: "plan",
      contractId: record.contractId,
      phases: [
        "attest-build-only",
        "observe-before-job",
        "replace-job-no-execute",
        "readback-job",
        "observe-before-service",
        "replace-service",
        "readback-convergence",
        "verify-containment",
      ],
    });
  }
  if (
    !isObject(operations) ||
    ![
      "observe",
      "verifyObservation",
      "replaceJob",
      "replaceService",
      "observeRollbackResource",
      "rollbackResource",
      "readbackRollbackResource",
      "verifyContainment",
    ].every((name) => typeof operations[name] === "function")
  ) {
    fail("promotion_operations_missing");
  }

  let rollbackImage;
  let executionInventory;
  let mutationAttempted = false;
  try {
    const beforeJob = await collectObservation(operations, "before-job");
    const beforeJobVerdict = evaluatePreMutationChecks(record, beforeJob);
    executionInventory = captureExecutionInventory(beforeJob);
    rollbackImage = beforeJobVerdict.rollbackImage;
    mutationAttempted = true;
    await invoke(
      operations.replaceJob,
      {
        image: record.image,
        expectedResourceVersion: beforeJobVerdict.jobResourceVersion,
        execute: false,
      },
      "job_replacement_operation_failed",
    );

    const afterJob = await collectObservation(operations, "after-job");
    assertFreshJobReadback(afterJob, record, beforeJob);
    requireUnchangedExecutionInventory(afterJob, executionInventory);

    const beforeService = await collectObservation(operations, "before-service");
    const beforeServiceVerdict = evaluatePreMutationChecks(record, beforeService);
    requireUnchangedExecutionInventory(beforeService, executionInventory);
    if (
      beforeServiceVerdict.rollbackImage !== rollbackImage ||
      beforeServiceVerdict.jobResourceVersion !== afterJob.jobResourceVersion ||
      beforeServiceVerdict.serviceResourceVersion !== afterJob.serviceResourceVersion
    ) {
      fail("pre_service_observation_changed");
    }

    await invoke(
      operations.replaceService,
      {
        image: record.image,
        buildVersion: record.commit,
        expectedResourceVersion: beforeServiceVerdict.serviceResourceVersion,
      },
      "service_replacement_operation_failed",
    );
    const final = await collectObservation(operations, "after-service");
    assertFinalReadback(final, record, beforeService);
    requireUnchangedExecutionInventory(final, executionInventory);
    await requireContainment(
      operations,
      {
        expectedImage: record.image,
        expectedExecutionInventory: executionInventory,
        stage: "promotion-final",
      },
      "final_containment_failed",
    );

    return freeze({
      status: "promoted",
      contractId: record.contractId,
      commit: record.commit,
      image: record.image,
      buildId: attestation.buildId,
      jobResourceVersion: final.jobResourceVersion,
      serviceResourceVersion: final.serviceResourceVersion,
      executionInventoryCount: executionInventory.count,
      executionInventoryFingerprint: executionInventory.fingerprint,
      jobExecutedDuringPromotion: false,
      contained: true,
    });
  } catch (error) {
    if (mutationAttempted && isImmutableImage(rollbackImage)) {
      await rollbackPromotion(operations, rollbackImage, executionInventory);
      fail("promotion_failed_rolled_back");
    }
    throw publicError(error, "promotion_failed_before_mutation");
  }
}

function validateSnapshot(snapshot) {
  if (
    !isObject(snapshot) ||
    !POSITIVE_DECIMAL_PATTERN.test(snapshot.generation ?? "") ||
    !POSITIVE_DECIMAL_PATTERN.test(snapshot.metageneration ?? "") ||
    !BOUNDED_TOKEN_PATTERN.test(snapshot.etag ?? "")
  ) {
    fail("snapshot_version_invalid");
  }
  return snapshot;
}

async function collectSnapshot(operations) {
  return validateSnapshot(
    await invokeSnapshot(
      operations.snapshot,
      undefined,
      "snapshot_operation_failed",
      "observation_snapshot_failed",
    ),
  );
}

function sameSnapshot(left, right) {
  return (
    left.generation === right.generation &&
    left.metageneration === right.metageneration &&
    left.etag === right.etag
  );
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function executionInventoryFingerprint(completedExecutionIds) {
  return createHash("sha256")
    .update(JSON.stringify([...completedExecutionIds].sort(compareText)))
    .digest("hex");
}

function validateProbeExecutionInventory(inventory) {
  const completedExecutionIds = inventory?.completedExecutionIds;
  if (
    !isObject(inventory) ||
    !Number.isSafeInteger(inventory.totalCount) ||
    inventory.totalCount < 0 ||
    !Number.isSafeInteger(inventory.activeCount) ||
    inventory.activeCount < 0 ||
    !Array.isArray(completedExecutionIds) ||
    completedExecutionIds.length !== inventory.totalCount ||
    completedExecutionIds.length > MAX_EXECUTION_INVENTORY ||
    completedExecutionIds.some(
      (executionId) => !BOUNDED_TOKEN_PATTERN.test(executionId ?? ""),
    ) ||
    new Set(completedExecutionIds).size !== completedExecutionIds.length ||
    inventory.fingerprint !== executionInventoryFingerprint(completedExecutionIds)
  ) {
    fail("probe_inventory_invalid");
  }
  return inventory;
}

async function collectProbeExecutionInventory(operations) {
  return validateProbeExecutionInventory(
    await invokeSnapshot(
      operations.executionInventory,
      undefined,
      "probe_inventory_operation_failed",
      "observation_snapshot_failed",
    ),
  );
}

function requireSameProbeExecutionInventory(observed, expected) {
  if (
    observed.totalCount !== expected.totalCount ||
    observed.activeCount !== expected.activeCount ||
    observed.fingerprint !== expected.fingerprint
  ) {
    fail("probe_inventory_changed");
  }
}

function requireSingleCompletedExecution(before, after, executionId) {
  if (
    before.activeCount !== 0 ||
    after.activeCount !== 0 ||
    after.totalCount !== before.totalCount + 1
  ) {
    fail("probe_inventory_completion_mismatch");
  }
  const priorIds = new Set(before.completedExecutionIds);
  const newIds = after.completedExecutionIds.filter((candidate) => !priorIds.has(candidate));
  const priorIdsPreserved = before.completedExecutionIds.every((candidate) =>
    after.completedExecutionIds.includes(candidate),
  );
  if (!priorIdsPreserved || newIds.length !== 1 || newIds[0] !== executionId) {
    fail("probe_inventory_completion_mismatch");
  }
}

function validateProbeJobIdentity(value) {
  if (
    !isObject(value) ||
    !isResourceVersion(value.resourceVersion) ||
    !HASH_PATTERN.test(value.configurationFingerprint ?? "")
  ) {
    fail("probe_job_identity_invalid");
  }
  return freeze({
    resourceVersion: value.resourceVersion,
    configurationFingerprint: value.configurationFingerprint,
  });
}

function jobIdentityFromPreflight(preflight) {
  return validateProbeJobIdentity({
    resourceVersion: preflight.jobResourceVersion,
    configurationFingerprint: preflight.jobConfigurationFingerprint,
  });
}

async function collectProbeJobIdentity(operations) {
  return validateProbeJobIdentity(
    await invokeSnapshot(
      operations.observeProbeJob,
      undefined,
      "probe_job_observation_operation_failed",
      "observation_snapshot_failed",
    ),
  );
}

function requireSameProbeJobIdentity(observed, expected) {
  if (
    observed.resourceVersion !== expected.resourceVersion ||
    observed.configurationFingerprint !== expected.configurationFingerprint
  ) {
    fail("probe_job_identity_changed");
  }
}

function sanitizeProbeResult(result, ordinal, image, snapshot, executionIds) {
  if (
    !isObject(result) ||
    result.image !== image ||
    result.taskCount !== 1 ||
    result.maxRetries !== 0 ||
    result.freshInstance !== true ||
    result.preconditionsEnforcedBeforeBrowserNetworkActivation !== true ||
    !BOUNDED_TOKEN_PATTERN.test(result.executionId ?? "") ||
    executionIds.has(result.executionId)
  ) {
    fail("probe_execution_contract_failed");
  }
  executionIds.add(result.executionId);
  const evidence = result.evidence;
  if (
    !isObject(evidence) ||
    evidence.authenticated !== true ||
    evidence.reason !== "authenticated_dashboard" ||
    !["playwright", "camoufox"].includes(evidence.browserEngine) ||
    evidence.snapshotGeneration !== snapshot.generation ||
    evidence.snapshotPersisted !== false ||
    evidence.fileSelectionPerformed !== false ||
    evidence.userInputInteractionPerformed !== false ||
    evidence.screenshotCaptured !== false ||
    evidence.domCaptured !== false ||
    evidence.traceCaptured !== false ||
    evidence.providerMutationObserved !== false ||
    evidence.dashboardInteraction !== "read_only_authentication" ||
    !Array.isArray(evidence.blockedNonReadMethods) ||
    evidence.blockedNonReadMethods.length !== 0
  ) {
    fail("probe_evidence_failed");
  }
  return {
    executionId: result.executionId,
    publicEvidence: freeze({
      ordinal,
      authenticated: true,
      reason: evidence.reason,
      browserEngine: evidence.browserEngine,
      snapshotPersisted: false,
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
      screenshotCaptured: false,
      domCaptured: false,
      traceCaptured: false,
      providerMutationObserved: false,
      dashboardInteraction: "read_only_authentication",
      blockedNonReadMethods: [],
    }),
  };
}

function requireProbeOperations(operations) {
  const operationNames = [
    "snapshot",
    "executionInventory",
    "observeProbeJob",
    "executeProbe",
    "verifyContainment",
  ];
  if (
    !isObject(operations) ||
    !operationNames.every((name) => typeof operations[name] === "function")
  ) {
    fail("probe_operations_missing");
  }
}

async function requireMatchingSnapshot(operations, baseline, errorCode) {
  const observed = await collectSnapshot(operations);
  if (!sameSnapshot(baseline, observed)) fail(errorCode);
}

/**
 * Execute one probe only after fresh snapshot, Job identity, containment, and
 * inventory checks, then return independently verified completion evidence.
 */
async function executeOneNoUploadProbe({
  image,
  operations,
  baseline,
  expectedInventory,
  executionIds,
  ordinal,
}) {
  const beforeInventory = await collectProbeExecutionInventory(operations);
  requireSameProbeExecutionInventory(beforeInventory, expectedInventory);
  await requireMatchingSnapshot(operations, baseline, "snapshot_changed_before_probe");
  const preflight = await requireContainment(
    operations,
    {
      expectedImage: image,
      expectedExecutionInventory: expectedInventory,
      ordinal,
      stage: "probe-before-execution",
    },
    "probe_preflight_failed",
  );
  const expectedJobIdentity = jobIdentityFromPreflight(preflight);
  await requireMatchingSnapshot(operations, baseline, "snapshot_changed_before_probe");
  const observedJobIdentity = await collectProbeJobIdentity(operations);
  requireSameProbeJobIdentity(observedJobIdentity, expectedJobIdentity);
  const afterPreflightInventory = await collectProbeExecutionInventory(operations);
  requireSameProbeExecutionInventory(afterPreflightInventory, expectedInventory);
  const raw = await invokeSnapshot(
    operations.executeProbe,
    freeze({
      ordinal,
      image,
      taskCount: 1,
      maxRetries: 0,
      uploadPermitted: false,
      expectedSnapshot: baseline,
      expectedJobIdentity,
      expectedExecutionInventory: expectedInventory,
      enforceBeforeBrowserNetworkActivation: true,
    }),
    "probe_execution_operation_failed",
    "observation_snapshot_failed",
  );
  const sanitized = sanitizeProbeResult(raw, ordinal, image, baseline, executionIds);
  const afterInventory = await collectProbeExecutionInventory(operations);
  requireSingleCompletedExecution(expectedInventory, afterInventory, sanitized.executionId);
  return {
    expectedInventory: afterInventory,
    publicEvidence: sanitized.publicEvidence,
  };
}

/**
 * Run the two-probe sequence and advance the mutable state only after each
 * independently observed completion so final containment sees the last known
 * inventory even when a later snapshot check fails.
 */
async function executeProbeSequence({ image, operations, state }) {
  state.expectedInventory = await collectProbeExecutionInventory(operations);
  if (state.expectedInventory.activeCount !== 0) fail("probe_inventory_changed");
  await requireContainment(
    operations,
    {
      expectedImage: image,
      expectedExecutionInventory: state.expectedInventory,
      stage: "probe-before-snapshot",
    },
    "probe_preflight_failed",
  );
  const baseline = await collectSnapshot(operations);
  const baselineInventory = state.expectedInventory;
  const executionIds = new Set();
  for (let index = 0; index < PROBE_COUNT; index += 1) {
    const result = await executeOneNoUploadProbe({
      image,
      operations,
      baseline,
      expectedInventory: state.expectedInventory,
      executionIds,
      ordinal: index + 1,
    });
    state.expectedInventory = result.expectedInventory;
    state.probes.push(result.publicEvidence);
    await requireMatchingSnapshot(operations, baseline, "snapshot_changed_by_probe");
  }
  if (state.expectedInventory.totalCount !== baselineInventory.totalCount + PROBE_COUNT) {
    fail("probe_inventory_completion_mismatch");
  }
}

/** Run exactly two sequential, fresh, zero-retry, no-upload probe executions. */
export async function runNoUploadProbes({ image, operations, execute = false }) {
  if (!isImmutableImage(image)) fail("probe_image_invalid");
  if (!execute) {
    return freeze({
      status: "plan",
      count: PROBE_COUNT,
      sequential: true,
      taskCount: 1,
      maxRetries: 0,
      uploadPermitted: false,
    });
  }
  requireProbeOperations(operations);

  const state = { expectedInventory: undefined, probes: [] };
  let sequenceFailure;
  let finalInventoryObservation;
  try {
    await executeProbeSequence({ image, operations, state });
  } catch (error) {
    sequenceFailure = publicError(error, "probe_sequence_failed");
  }
  try {
    finalInventoryObservation = await collectProbeExecutionInventory(operations);
    if (state.expectedInventory) {
      requireSameProbeExecutionInventory(finalInventoryObservation, state.expectedInventory);
    }
  } catch (error) {
    sequenceFailure ??= publicError(error, "probe_sequence_failed");
  }
  try {
    await requireContainment(
      operations,
      {
        expectedImage: image,
        expectedExecutionInventory: state.expectedInventory,
        observedExecutionInventory: finalInventoryObservation,
        stage: "probe-final",
      },
      "probe_final_containment_failed",
    );
  } catch {
    sequenceFailure ??= new Ovd419RunnerError("probe_final_containment_failed");
  }
  if (sequenceFailure) throw sequenceFailure;
  return freeze({
    status: "passed",
    count: PROBE_COUNT,
    sequential: true,
    executionInventoryCount: state.expectedInventory.totalCount,
    executionInventoryFingerprint: state.expectedInventory.fingerprint,
    probes: state.probes,
    contained: true,
  });
}

/** Plan-only direct CLI; executable cloud operations must inject reviewed adapters. */
export async function runCli({
  args = process.argv.slice(2),
  input = () => readFileSync(0, "utf8"),
  output = process.stdout,
} = {}) {
  if (args.length !== 1 || args[0] !== "--plan-stdin") {
    output.write(
      "usage: node scripts/run-ovd419-final-digest-release.mjs --plan-stdin < bundle.json\n",
    );
    return 2;
  }
  try {
    const bundle = JSON.parse(input());
    const recordSource = JSON.stringify(bundle.record);
    const promotion = await promoteDigest({
      recordSource,
      buildEvidence: bundle.buildEvidence,
      execute: false,
    });
    const probes = await runNoUploadProbes({
      image: bundle.record?.image,
      execute: false,
    });
    output.write(`${JSON.stringify({ verdict: "plan-valid", promotion, probes })}\n`);
    return 0;
  } catch {
    output.write("OVD-419 plan rejected; failing closed.\n");
    return 1;
  }
}

if (isDirectCli(import.meta.url)) process.exitCode = await runCli();
