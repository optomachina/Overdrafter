import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  attestBuildOnly,
  promoteDigest,
  runCli,
  runNoUploadProbes,
} from "./run-ovd419-final-digest-release.mjs";
import { OVD419_DIGEST_CONTRACT as CONTRACT } from "./ovd419-digest-contract.mjs";

const SHA = "a".repeat(40);
const IMAGE = `${CONTRACT.imageRepository}@sha256:${"b".repeat(64)}`;
const ROLLBACK = `${CONTRACT.imageRepository}@sha256:${"c".repeat(64)}`;
const JOB_VERSION_BEFORE = "AAZZ6/F6rtU";
const JOB_VERSION_AFTER = "AAZZ7+JobAfter=";
const SERVICE_VERSION_BEFORE = "AAZZ67PZ2+s";
const SERVICE_VERSION_AFTER = "AAZZ7+ServiceAfter=";
const EXECUTION_INVENTORY_COUNT = 11;
const EXECUTION_INVENTORY_FINGERPRINT = "f".repeat(64);
const PROBE_JOB_RESOURCE_VERSION = "AAZZ9+ProbeJob=";
const PROBE_JOB_CONFIGURATION_FINGERPRINT = "8".repeat(64);
const BASELINE_EXECUTION_IDS = Array.from(
  { length: EXECUTION_INVENTORY_COUNT },
  (_, index) => `historical-execution-${index + 1}`,
);
const RECORD = {
  contractId: CONTRACT.contractId,
  schemaVersion: CONTRACT.schemaVersion,
  commit: SHA,
  image: IMAGE,
  worktreeClean: true,
  buildVersion: SHA,
};
const RECORD_SOURCE = JSON.stringify(RECORD);

async function captureFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

function probeInventory(completedExecutionIds = BASELINE_EXECUTION_IDS, activeCount = 0) {
  const ids = [...completedExecutionIds];
  return {
    totalCount: ids.length,
    activeCount,
    completedExecutionIds: ids,
    fingerprint: createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex"),
  };
}

function passingContainment(overrides = {}) {
  return {
    ok: true,
    admissionBlocked: true,
    failures: [],
    jobResourceVersion: PROBE_JOB_RESOURCE_VERSION,
    jobConfigurationFingerprint: PROBE_JOB_CONFIGURATION_FINGERPRINT,
    ...overrides,
  };
}

function buildEvidence(overrides = {}) {
  return {
    source: {
      commit: SHA,
      worktreeClean: true,
      archiveSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
    },
    build: {
      id: "build-1",
      status: "SUCCESS",
      sourceCommit: SHA,
      sourceArchiveSha256: "d".repeat(64),
      sourceManifestSha256: "e".repeat(64),
      exactImage: IMAGE,
      tagEntryCount: 1,
      tagResolvedManifestDigest: `sha256:${"b".repeat(64)}`,
      deployStepCount: 0,
    },
    runtime: {
      image: IMAGE,
      buildVersion: SHA,
      platform: "linux/amd64",
      network: "none",
      workerEntrypointStarted: false,
      requiredRuntimeAssetsPresent: true,
      criticalFileHashesMatched: true,
    },
    ...overrides,
  };
}

function observed(phase, jobImage, serviceImage, jobVersion, serviceVersion) {
  return {
    phase,
    rollout: { disabled: true },
    queueDepthJob: 0,
    queueDepthService: 0,
    executionCount: 0,
    executionInventoryCount: EXECUTION_INVENTORY_COUNT,
    executionInventoryFingerprint: EXECUTION_INVENTORY_FINGERPRINT,
    jobResourceVersion: jobVersion,
    serviceResourceVersion: serviceVersion,
    jobImage,
    serviceImage,
    rollbackImage: ROLLBACK,
  };
}

function promotionOperations({ failAt, executionDriftAt } = {}) {
  const observations = [
    observed("before-job", ROLLBACK, ROLLBACK, JOB_VERSION_BEFORE, SERVICE_VERSION_BEFORE),
    observed("after-job", IMAGE, ROLLBACK, JOB_VERSION_AFTER, SERVICE_VERSION_BEFORE),
    observed("before-service", IMAGE, ROLLBACK, JOB_VERSION_AFTER, SERVICE_VERSION_BEFORE),
    observed("after-service", IMAGE, IMAGE, JOB_VERSION_AFTER, SERVICE_VERSION_AFTER),
  ];
  const events = [];
  return {
    events,
    observe: vi.fn(async ({ phase }) => {
      events.push(`observe:${phase}`);
      const value = observations.shift();
      if (failAt === phase) throw new Error("raw secret must not escape");
      if (executionDriftAt === phase) {
        value.executionInventoryCount += 1;
        value.executionInventoryFingerprint = "9".repeat(64);
      }
      return value;
    }),
    verifyObservation: vi.fn(async ({ phase }) => {
      events.push(`verify:${phase}`);
      return { ok: true, failures: [] };
    }),
    replaceJob: vi.fn(async (input) => {
      events.push("replace:job");
      if (failAt === "replace-job") throw new Error("unknown result");
      expect(input).toEqual({
        image: IMAGE,
        expectedResourceVersion: JOB_VERSION_BEFORE,
        execute: false,
      });
    }),
    replaceService: vi.fn(async (input) => {
      events.push("replace:service");
      if (failAt === "replace-service") throw new Error("unknown result");
      expect(input).toEqual({
        image: IMAGE,
        buildVersion: SHA,
        expectedResourceVersion: SERVICE_VERSION_BEFORE,
      });
    }),
    rollbackResource: vi.fn(async ({ resource, image }) => {
      events.push(`rollback:${resource}`);
      return { ok: true, image };
    }),
    observeRollbackResource: vi.fn(async ({ resource }) => {
      events.push(`observe-rollback:${resource}`);
      return {
        resource,
        image: IMAGE,
        resourceVersion: resource === "service" ? SERVICE_VERSION_AFTER : JOB_VERSION_AFTER,
      };
    }),
    readbackRollbackResource: vi.fn(async ({ resource }) => {
      events.push(`readback-rollback:${resource}`);
      return {
        resource,
        image: ROLLBACK,
        resourceVersion: resource === "service" ? "AAZZ8+ServiceRollback=" : "AAZZ8+JobRollback=",
      };
    }),
    verifyContainment: vi.fn(async ({ expectedImage }) => {
      events.push(`contain:${expectedImage === IMAGE ? "candidate" : "rollback"}`);
      return { ok: true, admissionBlocked: true, failures: [] };
    }),
  };
}

describe("OVD-419 build-only attestation", () => {
  it("binds clean source, successful build, registry digest, and offline runtime", () => {
    const result = attestBuildOnly(RECORD_SOURCE, buildEvidence());
    expect(result).toMatchObject({ verdict: "build-attested", image: IMAGE, commit: SHA });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["dirty source", { source: { ...buildEvidence().source, worktreeClean: false } }],
    ["wrong source", { source: { ...buildEvidence().source, commit: "f".repeat(40) } }],
    ["failed build", { build: { ...buildEvidence().build, status: "FAILURE" } }],
    ["deploying build", { build: { ...buildEvidence().build, deployStepCount: 1 } }],
    ["wrong digest", { build: { ...buildEvidence().build, exactImage: ROLLBACK } }],
    [
      "archive mismatch",
      { build: { ...buildEvidence().build, sourceArchiveSha256: "0".repeat(64) } },
    ],
    [
      "manifest mismatch",
      { build: { ...buildEvidence().build, sourceManifestSha256: "0".repeat(64) } },
    ],
    ["online runtime", { runtime: { ...buildEvidence().runtime, network: "default" } }],
    ["started worker", { runtime: { ...buildEvidence().runtime, workerEntrypointStarted: true } }],
  ])("rejects %s", (_label, override) => {
    expect(() => attestBuildOnly(RECORD_SOURCE, buildEvidence(override))).toThrow(
      "build_attestation_failed",
    );
  });
});

describe("OVD-419 promotion orchestration", () => {
  it("plans without requiring operations or mutating anything", async () => {
    const result = await promoteDigest({
      recordSource: RECORD_SOURCE,
      buildEvidence: buildEvidence(),
    });
    expect(result.status).toBe("plan");
    expect(result.phases).toContain("replace-job-no-execute");
  });

  it("promotes Job-first with fresh versions and never executes the Job", async () => {
    const operations = promotionOperations();
    const result = await promoteDigest({
      recordSource: RECORD_SOURCE,
      buildEvidence: buildEvidence(),
      operations,
      execute: true,
    });
    expect(result).toMatchObject({
      status: "promoted",
      jobExecutedDuringPromotion: false,
      jobResourceVersion: JOB_VERSION_AFTER,
      serviceResourceVersion: SERVICE_VERSION_AFTER,
      contained: true,
      executionInventoryCount: EXECUTION_INVENTORY_COUNT,
      executionInventoryFingerprint: EXECUTION_INVENTORY_FINGERPRINT,
    });
    expect(operations.events).toEqual([
      "observe:before-job",
      "verify:before-job",
      "replace:job",
      "observe:after-job",
      "verify:after-job",
      "observe:before-service",
      "verify:before-service",
      "replace:service",
      "observe:after-service",
      "verify:after-service",
      "contain:candidate",
    ]);
    expect(operations.rollbackResource).not.toHaveBeenCalled();
  });

  it.each(["replace-job", "after-job", "replace-service", "after-service"])(
    "rolls back both resources and verifies containment after %s uncertainty",
    async (failAt) => {
      const operations = promotionOperations({ failAt });
      await expect(
        promoteDigest({
          recordSource: RECORD_SOURCE,
          buildEvidence: buildEvidence(),
          operations,
          execute: true,
        }),
      ).rejects.toThrow("promotion_failed_rolled_back");
      expect(operations.events).toContain("rollback:service");
      expect(operations.events).toContain("rollback:job");
      expect(operations.events.at(-1)).toBe("contain:rollback");
      expect(operations.rollbackResource).toHaveBeenNthCalledWith(1, {
        resource: "service",
        image: ROLLBACK,
        expectedResourceVersion: SERVICE_VERSION_AFTER,
      });
      expect(operations.rollbackResource).toHaveBeenNthCalledWith(2, {
        resource: "job",
        image: ROLLBACK,
        expectedResourceVersion: JOB_VERSION_AFTER,
      });
    },
  );

  it("requires the live observation verifier and stops before mutation when it fails", async () => {
    const missingVerifier = promotionOperations();
    delete missingVerifier.verifyObservation;
    await expect(
      promoteDigest({
        recordSource: RECORD_SOURCE,
        buildEvidence: buildEvidence(),
        operations: missingVerifier,
        execute: true,
      }),
    ).rejects.toThrow("promotion_operations_missing");

    const rejected = promotionOperations();
    rejected.verifyObservation.mockResolvedValue({ ok: false, failures: ["queue_not_empty"] });
    await expect(
      promoteDigest({
        recordSource: RECORD_SOURCE,
        buildEvidence: buildEvidence(),
        operations: rejected,
        execute: true,
      }),
    ).rejects.toThrow("live_observation_not_verified");
    expect(rejected.replaceJob).not.toHaveBeenCalled();
    expect(rejected.rollbackResource).not.toHaveBeenCalled();
  });

  it("fails closed when a supposedly fresh readback keeps the stale Job version", async () => {
    const operations = promotionOperations();
    operations.observe = vi.fn(async ({ phase }) => {
      if (phase === "before-job") {
        return observed(
          phase,
          ROLLBACK,
          ROLLBACK,
          JOB_VERSION_BEFORE,
          SERVICE_VERSION_BEFORE,
        );
      }
      if (phase === "after-job") {
        return observed(
          phase,
          IMAGE,
          ROLLBACK,
          JOB_VERSION_BEFORE,
          SERVICE_VERSION_BEFORE,
        );
      }
      throw new Error("unexpected");
    });
    const failure = await promoteDigest({
      recordSource: RECORD_SOURCE,
      buildEvidence: buildEvidence(),
      operations,
      execute: true,
    }).catch((error) => error);
    expect(failure).toMatchObject({
      code: "promotion_failed_rolled_back",
      promotionFailureCode: "job_readback_failed",
      promotionFailureStage: "verify_after_job",
    });
  });

  it.each(["after-job", "before-service", "after-service"])(
    "rolls back when the total execution inventory changes at %s",
    async (executionDriftAt) => {
      const operations = promotionOperations({ executionDriftAt });
      await expect(
        promoteDigest({
          recordSource: RECORD_SOURCE,
          buildEvidence: buildEvidence(),
          operations,
          execute: true,
        }),
      ).rejects.toThrow("promotion_failed_rolled_back");
      expect(operations.rollbackResource).toHaveBeenCalledTimes(2);
      expect(operations.verifyContainment).toHaveBeenLastCalledWith({
        expectedImage: ROLLBACK,
        expectedExecutionInventory: {
          count: EXECUTION_INVENTORY_COUNT,
          fingerprint: EXECUTION_INVENTORY_FINGERPRINT,
        },
        stage: "rollback-final",
      });
    },
  );

  it("deep-freezes a structured clone before the verifier can mutate it", async () => {
    const operations = promotionOperations();
    let mutationRejected = false;
    operations.verifyObservation.mockImplementation(async ({ observed: snapshot }) => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.rollout)).toBe(true);
      try {
        snapshot.rollout.disabled = false;
      } catch {
        mutationRejected = true;
      }
      return { ok: true, failures: [] };
    });
    await expect(
      promoteDigest({
        recordSource: RECORD_SOURCE,
        buildEvidence: buildEvidence(),
        operations,
        execute: true,
      }),
    ).resolves.toMatchObject({ status: "promoted" });
    expect(mutationRejected).toBe(true);
  });

  it("maps injected observation exceptions to an allowlisted public error", async () => {
    const operations = promotionOperations();
    operations.observe.mockRejectedValue(
      new Error("secret=abc cookie=session provider-body /Users/operator/private"),
    );
    const error = await captureFailure(
      promoteDigest({
        recordSource: RECORD_SOURCE,
        buildEvidence: buildEvidence(),
        operations,
        execute: true,
      }),
    );
    expect(error).toMatchObject({
      name: "Ovd419RunnerError",
      code: "observation_operation_failed",
      message: "OVD-419 observation_operation_failed",
    });
    expect(error.message).not.toMatch(/secret|cookie|provider|Users|private/);
  });

  it("reconstructs tampered runner errors with the injected operation code", async () => {
    const injected = await captureFailure(runNoUploadProbes({ image: "mutable-tag" }));
    injected.code = "probe_evidence_failed";
    injected.message =
      "secret=abc cookie=session provider=xometry path=/Users/operator/private";
    const operations = promotionOperations();
    operations.observe.mockRejectedValue(injected);

    const error = await captureFailure(
      promoteDigest({
        recordSource: RECORD_SOURCE,
        buildEvidence: buildEvidence(),
        operations,
        execute: true,
      }),
    );

    expect(error).not.toBe(injected);
    expect(error).toMatchObject({
      name: "Ovd419RunnerError",
      code: "observation_operation_failed",
      message: "OVD-419 observation_operation_failed",
    });
    expect(error.message).not.toMatch(/secret|cookie|provider|xometry|Users|private/);
  });

  it("reports rollback failure without leaking the triggering error", async () => {
    const operations = promotionOperations({ failAt: "replace-service" });
    operations.readbackRollbackResource.mockResolvedValueOnce({
      resource: "service",
      image: IMAGE,
      resourceVersion: "AAZZ8+ServiceRollback=",
    });
    await expect(
      promoteDigest({
        recordSource: RECORD_SOURCE,
        buildEvidence: buildEvidence(),
        operations,
        execute: true,
      }),
    ).rejects.toThrow("rollback_or_containment_failed");
  });
});

function probeEvidence(generation = "101") {
  return {
    authenticated: true,
    reason: "authenticated_dashboard",
    browserEngine: "camoufox",
    snapshotGeneration: generation,
    snapshotPersisted: false,
    fileSelectionPerformed: false,
    userInputInteractionPerformed: false,
    screenshotCaptured: false,
    domCaptured: false,
    traceCaptured: false,
    providerMutationObserved: false,
    dashboardInteraction: "read_only_authentication",
    blockedNonReadMethods: [],
    url: "https://www.xometry.com/secure/account/quotes",
    customerName: "must not be retained",
  };
}

function probeOperations() {
  let active = 0;
  let maximumActive = 0;
  const completedExecutionIds = [...BASELINE_EXECUTION_IDS];
  const calls = [];
  const operations = {
    calls,
    maximumActive: () => maximumActive,
    recordCompletedExecution: (executionId) => completedExecutionIds.push(executionId),
    snapshot: vi.fn(async () => ({ generation: "101", metageneration: "7", etag: "etag-1" })),
    executionInventory: vi.fn(async () => probeInventory(completedExecutionIds)),
    observeProbeJob: vi.fn(async () => ({
      resourceVersion: PROBE_JOB_RESOURCE_VERSION,
      configurationFingerprint: PROBE_JOB_CONFIGURATION_FINGERPRINT,
    })),
    executeProbe: vi.fn(async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(input);
      await Promise.resolve();
      active -= 1;
      const executionId = `execution-${input.ordinal}`;
      completedExecutionIds.push(executionId);
      return {
        executionId,
        image: input.image,
        taskCount: input.taskCount,
        maxRetries: input.maxRetries,
        freshInstance: true,
        preconditionsEnforcedBeforeBrowserNetworkActivation: true,
        evidence: probeEvidence(),
      };
    }),
    verifyContainment: vi.fn(async () => passingContainment()),
  };
  return operations;
}

describe("OVD-419 no-upload probes", () => {
  it("plans exactly two bounded executions without operations", async () => {
    await expect(runNoUploadProbes({ image: IMAGE })).resolves.toMatchObject({
      status: "plan",
      count: 2,
      sequential: true,
      taskCount: 1,
      maxRetries: 0,
      uploadPermitted: false,
    });
  });

  it("runs exactly two sequential fresh executions and retains only sanitized evidence", async () => {
    const operations = probeOperations();
    const result = await runNoUploadProbes({ image: IMAGE, operations, execute: true });
    expect(operations.executeProbe).toHaveBeenCalledTimes(2);
    expect(operations.maximumActive()).toBe(1);
    expect(operations.calls).toHaveLength(2);
    for (const [index, call] of operations.calls.entries()) {
      expect(call).toMatchObject({
        ordinal: index + 1,
        image: IMAGE,
        taskCount: 1,
        maxRetries: 0,
        uploadPermitted: false,
        expectedSnapshot: { generation: "101", metageneration: "7", etag: "etag-1" },
        expectedJobIdentity: {
          resourceVersion: PROBE_JOB_RESOURCE_VERSION,
          configurationFingerprint: PROBE_JOB_CONFIGURATION_FINGERPRINT,
        },
        expectedExecutionInventory: {
          totalCount: EXECUTION_INVENTORY_COUNT + index,
          activeCount: 0,
        },
        enforceBeforeBrowserNetworkActivation: true,
      });
      expect(Object.isFrozen(call)).toBe(true);
      expect(Object.isFrozen(call.expectedSnapshot)).toBe(true);
      expect(Object.isFrozen(call.expectedJobIdentity)).toBe(true);
      expect(Object.isFrozen(call.expectedExecutionInventory)).toBe(true);
    }
    expect(operations.snapshot).toHaveBeenCalledTimes(7);
    expect(operations.executionInventory).toHaveBeenCalledTimes(8);
    expect(operations.observeProbeJob).toHaveBeenCalledTimes(2);
    expect(operations.verifyContainment).toHaveBeenCalledTimes(4);
    expect(operations.verifyContainment.mock.calls.map(([input]) => input.stage)).toEqual([
      "probe-before-snapshot",
      "probe-before-execution",
      "probe-before-execution",
      "probe-final",
    ]);
    expect(operations.verifyContainment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: "probe-final",
        expectedExecutionInventory: expect.objectContaining({
          totalCount: EXECUTION_INVENTORY_COUNT + 2,
          activeCount: 0,
        }),
      }),
    );
    const finalInventory = operations.verifyContainment.mock.calls.at(-1)[0]
      .expectedExecutionInventory;
    expect(finalInventory.completedExecutionIds).toEqual([
      ...BASELINE_EXECUTION_IDS,
      "execution-1",
      "execution-2",
    ]);
    expect(result.count).toBe(2);
    expect(result.executionInventoryCount).toBe(EXECUTION_INVENTORY_COUNT + 2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("customerName");
    expect(serialized).not.toContain("xometry.com");
    expect(serialized).not.toContain('"snapshotGeneration"');
    expect(serialized).not.toContain('"generation"');
    expect(serialized).not.toContain('"metageneration"');
    expect(serialized).not.toContain('"etag"');
    expect(serialized).not.toContain("etag-1");
    expect(result).not.toHaveProperty("snapshotGeneration");
    expect(result.probes[0]).not.toHaveProperty("snapshotGeneration");
    expect(result.probes[0]).toMatchObject({
      screenshotCaptured: false,
      domCaptured: false,
      traceCaptured: false,
      providerMutationObserved: false,
      dashboardInteraction: "read_only_authentication",
    });
    expect(Object.isFrozen(result.probes[0])).toBe(true);
  });

  it("blocks provider execution when the snapshot changes after preflight", async () => {
    const operations = probeOperations();
    operations.snapshot
      .mockResolvedValueOnce({ generation: "101", metageneration: "7", etag: "etag-1" })
      .mockResolvedValueOnce({ generation: "101", metageneration: "7", etag: "etag-1" })
      .mockResolvedValueOnce({ generation: "102", metageneration: "8", etag: "etag-2" });
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("snapshot_changed_before_probe");
    expect(operations.executeProbe).not.toHaveBeenCalled();
    expect(operations.verifyContainment).toHaveBeenCalledTimes(3);
  });

  it("stops before probe two when the awaited probe changes the snapshot", async () => {
    const operations = probeOperations();
    operations.snapshot
      .mockResolvedValueOnce({ generation: "101", metageneration: "7", etag: "etag-1" })
      .mockResolvedValueOnce({ generation: "101", metageneration: "7", etag: "etag-1" })
      .mockResolvedValueOnce({ generation: "101", metageneration: "7", etag: "etag-1" })
      .mockResolvedValueOnce({ generation: "102", metageneration: "8", etag: "etag-2" });
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("snapshot_changed_by_probe");
    expect(operations.executeProbe).toHaveBeenCalledTimes(1);
    expect(operations.verifyContainment).toHaveBeenCalledTimes(3);
  });

  it("blocks provider execution when Job configuration changes after preflight", async () => {
    const operations = probeOperations();
    operations.observeProbeJob.mockResolvedValue({
      resourceVersion: "AAZZ10+ConcurrentChange=",
      configurationFingerprint: "7".repeat(64),
    });
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_job_identity_changed");
    expect(operations.executeProbe).not.toHaveBeenCalled();
  });

  it("blocks a concurrent execution inventory change after preflight", async () => {
    const operations = probeOperations();
    const baselineInventory = probeInventory();
    const concurrentInventory = probeInventory([
      ...BASELINE_EXECUTION_IDS,
      "concurrent-execution",
    ]);
    operations.executionInventory
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(concurrentInventory);
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_inventory_changed");
    expect(operations.executeProbe).not.toHaveBeenCalled();
  });

  it("rejects multiple completed executions after one awaited probe", async () => {
    const operations = probeOperations();
    const baselineInventory = probeInventory();
    const multipleInventory = probeInventory([
      ...BASELINE_EXECUTION_IDS,
      "execution-1",
      "unexpected-execution",
    ]);
    operations.executionInventory
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(multipleInventory);
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_inventory_completion_mismatch");
    expect(operations.executeProbe).toHaveBeenCalledTimes(1);
  });

  it("rejects an independently observed execution id mismatch", async () => {
    const operations = probeOperations();
    const executeProbe = operations.executeProbe;
    operations.executeProbe = vi.fn(async (input) => ({
      ...(await executeProbe(input)),
      executionId: "different-returned-execution",
    }));
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_inventory_completion_mismatch");
  });

  it("requires zero active executions after an awaited probe", async () => {
    const operations = probeOperations();
    const baselineInventory = probeInventory();
    const activeInventory = probeInventory(
      [...BASELINE_EXECUTION_IDS, "execution-1"],
      1,
    );
    operations.executionInventory
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(baselineInventory)
      .mockResolvedValueOnce(activeInventory);
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_inventory_completion_mismatch");
  });

  it.each([
    ["zero generation", { generation: "0", metageneration: "7", etag: "etag-1" }],
    ["blank etag", { generation: "101", metageneration: "7", etag: "" }],
    ["control etag", { generation: "101", metageneration: "7", etag: "bad\netag" }],
    [
      "oversized etag",
      { generation: "101", metageneration: "7", etag: "a".repeat(257) },
    ],
  ])("rejects a %s snapshot token and still checks containment", async (_label, snapshot) => {
    const operations = probeOperations();
    operations.snapshot.mockResolvedValue(snapshot);
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("snapshot_version_invalid");
    expect(operations.executeProbe).not.toHaveBeenCalled();
    expect(operations.verifyContainment).toHaveBeenCalledTimes(2);
  });

  it("requires containment and admission before the initial snapshot", async () => {
    const operations = probeOperations();
    operations.verifyContainment
      .mockResolvedValueOnce({ ok: false, admissionBlocked: false, failures: ["admitted"] })
      .mockResolvedValue(passingContainment());
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_preflight_failed");
    expect(operations.snapshot).not.toHaveBeenCalled();
    expect(operations.executeProbe).not.toHaveBeenCalled();
    expect(operations.verifyContainment).toHaveBeenCalledTimes(2);
  });

  it("rechecks containment and admission immediately before each execution", async () => {
    const operations = probeOperations();
    operations.verifyContainment.mockImplementation(async (input) => {
      if (input.stage === "probe-before-execution" && input.ordinal === 2) {
        return { ok: false, admissionBlocked: false, failures: ["admitted"] };
      }
      return passingContainment();
    });
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_preflight_failed");
    expect(operations.executeProbe).toHaveBeenCalledTimes(1);
    expect(operations.executeProbe).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 1 }),
    );
  });

  it.each([
    ["automatic retry", { maxRetries: 1 }],
    ["not fresh", { freshInstance: false }],
    [
      "unenforced pre-network tokens",
      { preconditionsEnforcedBeforeBrowserNetworkActivation: false },
    ],
    ["wrong image", { image: ROLLBACK }],
    ["failed authentication", { evidence: { ...probeEvidence(), authenticated: false } }],
    ["file selection", { evidence: { ...probeEvidence(), fileSelectionPerformed: true } }],
    ["snapshot persistence", { evidence: { ...probeEvidence(), snapshotPersisted: true } }],
    ["blocked mutation", { evidence: { ...probeEvidence(), blockedNonReadMethods: ["POST"] } }],
    ["screenshot capture", { evidence: { ...probeEvidence(), screenshotCaptured: true } }],
    ["DOM capture", { evidence: { ...probeEvidence(), domCaptured: true } }],
    ["trace capture", { evidence: { ...probeEvidence(), traceCaptured: true } }],
    [
      "provider mutation",
      { evidence: { ...probeEvidence(), providerMutationObserved: true } },
    ],
    [
      "interactive dashboard behavior",
      { evidence: { ...probeEvidence(), dashboardInteraction: "click" } },
    ],
  ])("rejects %s", async (_label, override) => {
    const operations = probeOperations();
    const baseExecute = operations.executeProbe;
    operations.executeProbe = vi.fn(async (input) => ({ ...(await baseExecute(input)), ...override }));
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow(/probe_(execution_contract|evidence)_failed/);
  });

  it("rejects duplicate execution identities", async () => {
    const operations = probeOperations();
    let callCount = 0;
    operations.executeProbe = vi.fn(async (input) => {
      callCount += 1;
      if (callCount === 1) operations.recordCompletedExecution("same-execution");
      return {
        executionId: "same-execution",
        image: IMAGE,
        taskCount: 1,
        maxRetries: 0,
        freshInstance: true,
        preconditionsEnforcedBeforeBrowserNetworkActivation: true,
        evidence: probeEvidence(),
      };
    });
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_execution_contract_failed");
  });

  it("rejects an oversized execution identity", async () => {
    const operations = probeOperations();
    operations.executeProbe = vi.fn(async () => ({
      executionId: "x".repeat(257),
      image: IMAGE,
      taskCount: 1,
      maxRetries: 0,
      freshInstance: true,
      preconditionsEnforcedBeforeBrowserNetworkActivation: true,
      evidence: probeEvidence(),
    }));
    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_execution_contract_failed");
  });

  it("sanitizes an unexpected probe execution failure and still checks containment", async () => {
    const operations = probeOperations();
    operations.executeProbe.mockRejectedValue(
      new Error("secret=abc cookie=session provider-body /Users/operator/private"),
    );
    const error = await captureFailure(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    );
    expect(error).toMatchObject({
      name: "Ovd419RunnerError",
      code: "probe_execution_operation_failed",
      message: "OVD-419 probe_execution_operation_failed",
    });
    expect(error.message).not.toMatch(/secret|cookie|provider|Users|private/);
    expect(operations.verifyContainment).toHaveBeenCalledTimes(3);
  });

  it("sanitizes a containment callback exception before any snapshot", async () => {
    const operations = probeOperations();
    operations.verifyContainment
      .mockRejectedValueOnce(
        new Error("secret=abc cookie=session provider-body /Users/operator/private"),
      )
      .mockResolvedValue(passingContainment());
    const error = await captureFailure(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    );
    expect(error).toMatchObject({
      name: "Ovd419RunnerError",
      code: "containment_operation_failed",
      message: "OVD-419 containment_operation_failed",
    });
    expect(error.message).not.toMatch(/secret|cookie|provider|Users|private/);
    expect(operations.snapshot).not.toHaveBeenCalled();
  });

  it("preserves an earlier probe failure when final containment also fails", async () => {
    const operations = probeOperations();
    operations.executeProbe.mockRejectedValue(new Error("first probe failed"));
    operations.verifyContainment.mockImplementation(async ({ stage }) => {
      if (stage === "probe-final") throw new Error("final containment failed");
      return passingContainment();
    });

    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_execution_operation_failed");
    expect(operations.verifyContainment).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: "probe-final" }),
    );
  });

  it("reports final containment failure when no earlier failure exists", async () => {
    const operations = probeOperations();
    operations.verifyContainment.mockImplementation(async ({ stage }) => {
      if (stage === "probe-final") throw new Error("final containment failed");
      return passingContainment();
    });

    await expect(
      runNoUploadProbes({ image: IMAGE, operations, execute: true }),
    ).rejects.toThrow("probe_final_containment_failed");
  });
});

describe("OVD-419 plan CLI", () => {
  it("accepts a valid stdin bundle and never exposes protected evidence", async () => {
    let output = "";
    const status = await runCli({
      args: ["--plan-stdin"],
      input: () => JSON.stringify({ record: RECORD, buildEvidence: buildEvidence() }),
      output: { write: (value) => { output += value; } },
    });
    expect(status).toBe(0);
    expect(JSON.parse(output).verdict).toBe("plan-valid");
    expect(output).not.toContain("build-1");
    expect(output).not.toContain(SHA);
    expect(output).not.toContain(IMAGE);
  });

  it("rejects execution arguments and malformed evidence", async () => {
    await expect(runCli({ args: ["--execute"], output: { write: () => undefined } })).resolves.toBe(2);
    await expect(
      runCli({
        args: ["--plan-stdin"],
        input: () => "{bad json",
        output: { write: () => undefined },
      }),
    ).resolves.toBe(1);
  });
});
