import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireLiveOwnerLock,
  consumeLiveAuthorization,
  createTerminationState,
  createOvd419LiveOperations,
  installDeferredTerminationHandlers,
  runAuthorizedLiveRelease,
  runCli,
  validateLiveAuthorization,
} from "./run-ovd419-live-release.mjs";
import { promoteDigest } from "./run-ovd419-final-digest-release.mjs";
import { OVD419_DIGEST_CONTRACT as CONTRACT } from "./ovd419-digest-contract.mjs";
import { OVD410_PRODUCTION_CONTRACT as PRODUCTION } from "./xometry-stable-egress-contract.mjs";

const SHA = "a".repeat(40);
const IMAGE = `${CONTRACT.imageRepository}@sha256:${"b".repeat(64)}`;
const ROLLBACK = `${CONTRACT.imageRepository}@sha256:${"c".repeat(64)}`;
const RECORD = {
  contractId: CONTRACT.contractId,
  schemaVersion: CONTRACT.schemaVersion,
  commit: SHA,
  image: IMAGE,
  worktreeClean: true,
  buildVersion: SHA,
};
const NOW = Date.parse("2026-08-28T20:00:00Z");
const AUTHORIZATION = {
  issue: "OVD-419",
  action: "promote-final-digest-and-run-two-no-upload-probes",
  image: IMAGE,
  sourceCommit: SHA,
  authorized: true,
  authorizePromotion: true,
  authorizeProviderReadOnlyProbes: true,
  issuedAt: "2026-08-28T19:55:00Z",
  expiresAt: "2026-08-28T20:55:00Z",
  nonce: "single-use-live-release-1",
};

const ENV = {
  GOOGLE_CLOUD_PROJECT: PRODUCTION.project,
  CLOUD_RUN_REGION: PRODUCTION.region,
  CLOUD_RUN_NETWORK: PRODUCTION.network,
  CLOUD_RUN_SUBNET: PRODUCTION.subnet,
  CLOUD_RUN_SUBNET_RANGE: PRODUCTION.subnetRange,
  CLOUD_RUN_ROUTER: PRODUCTION.router,
  CLOUD_RUN_NAT: PRODUCTION.nat,
  CLOUD_RUN_NAT_ADDRESS: PRODUCTION.address,
  CLOUD_RUN_NAT_ADDRESS_ID: PRODUCTION.addressId,
  SERVICE_NAME: PRODUCTION.service,
  XOMETRY_AUTH_PROBE_JOB_NAME: PRODUCTION.job,
  CLOUD_RUN_SERVICE_ACCOUNT: PRODUCTION.serviceAccount,
  CLOUD_RUN_VPC_EGRESS: "all-traffic",
  XOMETRY_PROFILE_SNAPSHOT_BUCKET: "private-snapshot-bucket",
  XOMETRY_PROFILE_SNAPSHOT_OBJECT: "profiles/xometry.tar.gz",
  XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES: "268435456",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_synthetic",
};

function stableEgressResult(failure) {
  if (failure === undefined) {
    return { ok: true, invalid: false, failures: [] };
  }
  return { ok: false, invalid: false, failures: [failure] };
}

function buildEvidence() {
  const archiveSha256 = "d".repeat(64);
  const manifestSha256 = "e".repeat(64);
  return {
    source: { commit: SHA, worktreeClean: true, archiveSha256, manifestSha256 },
    build: {
      id: "build-1",
      status: "SUCCESS",
      sourceCommit: SHA,
      sourceArchiveSha256: archiveSha256,
      sourceManifestSha256: manifestSha256,
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
  };
}

function service({
  image = ROLLBACK,
  version = "service-v1",
  buildVersion = "old-build",
} = {}) {
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
      name: PRODUCTION.service,
      resourceVersion: version,
      annotations: {},
    },
    spec: {
      traffic: [{ latestRevision: true, percent: 100 }],
      template: {
        metadata: {
          annotations: {
            "autoscaling.knative.dev/maxScale": "1",
            "run.googleapis.com/cpu-throttling": "false",
            "run.googleapis.com/execution-environment": "gen2",
          },
        },
        spec: {
          containerConcurrency: 1,
          serviceAccountName: PRODUCTION.serviceAccount,
          containers: [
            {
              image,
              env: [
                { name: "WORKER_MODE", value: "live" },
                { name: "WORKER_LIVE_ADAPTERS", value: "xometry" },
                { name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" },
                { name: "WORKER_BUILD_VERSION", value: buildVersion },
              ],
            },
          ],
        },
      },
    },
    status: {
      latestCreatedRevisionName: "worker-1",
      latestReadyRevisionName: "worker-1",
      traffic: [
        { latestRevision: true, percent: 100, revisionName: "worker-1" },
      ],
    },
  };
}

function job({ image = ROLLBACK, version = "job-v1" } = {}) {
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "Job",
    metadata: { name: PRODUCTION.job, resourceVersion: version },
    spec: {
      template: {
        metadata: { annotations: {} },
        spec: {
          taskCount: 1,
          parallelism: 1,
          template: {
            spec: {
              maxRetries: 0,
              serviceAccountName: PRODUCTION.serviceAccount,
              containers: [
                {
                  image,
                  command: ["node"],
                  args: ["dist/tools/probeXometryProfileAuth.js"],
                  env: [],
                },
              ],
            },
          },
        },
      },
    },
  };
}

function emptyEnvelope() {
  return {
    controls: [
      "automatic_quote_collection",
      "commercial_admin_mutations",
      "order_administration",
      "promotion_codes",
    ].map((capability) => ({ capability, enabled: false })),
    workQueue: { activeCount: 0 },
    quoteRequests: { activeCount: 0 },
  };
}

function operationHarness(overrides = {}) {
  const resources = {
    service: service(),
    job: job(),
    ...overrides.resources,
  };
  const replacements = [];
  const calls = [];
  const runCommand = vi.fn(async (_bin, args) => {
    calls.push(args);
    if (args[0] === "projects" && args[1] === "get-iam-policy") {
      return {
        bindings: (overrides.policyRoles ?? ["roles/run.viewer"]).map(
          (role) => ({
            role,
            members: [`serviceAccount:${PRODUCTION.serviceAccount}`],
          }),
        ),
      };
    }
    if (args[0] === "iam" && args[1] === "roles") {
      return {
        includedPermissions: overrides.runtimePermissions ?? [
          "run.jobs.get",
          "run.executions.list",
        ],
      };
    }
    if (args.includes("executions") && args.includes("list")) return [];
    if (args[0] === "storage") {
      if (typeof overrides.snapshotMetadata === "function") {
        return overrides.snapshotMetadata();
      }
      return (
        overrides.snapshotMetadata ?? {
          generation: "101",
          metageneration: "7",
          etag: "snapshot-etag",
        }
      );
    }
    if (args.includes("describe") && args.includes(PRODUCTION.job))
      return resources.job;
    if (args.includes("describe") && args.includes(PRODUCTION.service))
      return resources.service;
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const collectEnvelope =
    overrides.collectEnvelope ?? vi.fn(async () => emptyEnvelope());
  const collectStableEgress =
    overrides.collectStableEgress ??
    vi.fn(async () => {
      const stable = {
        service: resources.service,
        job: resources.job,
        jobExecutions: [],
      };
      return overrides.projectStableEgress?.(stable) ?? stable;
    });
  const evaluateStableEgress =
    overrides.evaluateStableEgress ??
    vi.fn(() => ({ ok: true, invalid: false, failures: [] }));
  const assertOwnership =
    overrides.assertOwnership ?? vi.fn(async () => undefined);
  const fetchImpl = overrides.fetchImpl ?? vi.fn();
  const operations = createOvd419LiveOperations({
    env: ENV,
    expectations: PRODUCTION,
    runCommand,
    replaceManifest: vi.fn(async (_bin, args, manifest) => {
      replacements.push({ args, manifest });
      if (overrides.mutateOnReplace === true) {
        if (args.includes("services")) {
          resources.service = structuredClone(manifest);
          resources.service.metadata.resourceVersion = `service-v${
            replacements.length + 1
          }`;
        } else {
          resources.job = structuredClone(manifest);
          resources.job.metadata.resourceVersion = `job-v${
            replacements.length + 1
          }`;
        }
      }
      await overrides.onReplace?.({ args, manifest, resources, replacements });
    }),
    fetchImpl,
    collectEnvelope,
    collectStableEgress,
    evaluateStableEgress,
    assertOwnership,
    terminationState: overrides.terminationState,
    now: overrides.now,
    waitFor: overrides.waitFor,
  });
  return {
    assertOwnership,
    calls,
    collectEnvelope,
    collectStableEgress,
    evaluateStableEgress,
    fetchImpl,
    operations,
    replacements,
    resources,
    runCommand,
  };
}

async function runContainmentVerification(overrides = {}) {
  const harness = operationHarness(overrides);
  await harness.operations.promotion.observe({ phase: "before-job" });
  const expectedExecutionInventory =
    await harness.operations.probes.executionInventory();
  const result = await harness.operations.promotion.verifyContainment({
    expectedImage: ROLLBACK,
    expectedExecutionInventory,
  });
  return { harness, result };
}

function expectNoActiveReleaseCalls(harness) {
  expect(harness.replacements).toHaveLength(0);
  expect(harness.fetchImpl).not.toHaveBeenCalled();
  expect(harness.calls.some((args) => args.includes("execute"))).toBe(false);
}

describe("OVD-419 explicit live authorization", () => {
  it("accepts only the exact short-lived promotion and two-probe authorization", () => {
    expect(validateLiveAuthorization(AUTHORIZATION, RECORD, NOW)).toEqual({
      issue: "OVD-419",
      expiresAt: AUTHORIZATION.expiresAt,
    });
  });

  it.each([
    ["wrong issue", { issue: "OVD-410" }],
    ["wrong image", { image: ROLLBACK }],
    ["promotion omitted", { authorizePromotion: false }],
    ["probes omitted", { authorizeProviderReadOnlyProbes: false }],
    ["expired", { expiresAt: "2026-08-28T19:59:59Z" }],
    ["overlong", { expiresAt: "2026-08-29T01:00:01Z" }],
    ["unknown field", { note: "do it" }],
  ])("rejects %s", (_label, change) => {
    expect(() =>
      validateLiveAuthorization({ ...AUTHORIZATION, ...change }, RECORD, NOW),
    ).toThrow("authorization_invalid");
  });

  it("has no plan-like or implicit execution CLI mode", async () => {
    const errorOutput = { write: vi.fn() };
    const runRelease = vi.fn();
    expect(await runCli({ args: [], errorOutput, runRelease })).toBe(2);
    expect(await runCli({ args: ["--execute"], errorOutput, runRelease })).toBe(
      2,
    );
    expect(runRelease).not.toHaveBeenCalled();
  });

  it("defers SIGINT and SIGTERM until the release controller reaches a safe boundary", () => {
    const processObject = new EventEmitter();
    const terminationState = createTerminationState();
    const remove = installDeferredTerminationHandlers({
      terminationState,
      processObject,
    });

    expect(processObject.emit("SIGTERM")).toBe(true);
    expect(terminationState.isRequested()).toBe(true);
    expect(() => terminationState.throwIfRequested()).toThrow(
      "termination_requested",
    );
    remove();
    expect(processObject.listenerCount("SIGINT")).toBe(0);
    expect(processObject.listenerCount("SIGTERM")).toBe(0);
  });

  it("consumes each private authorization nonce exactly once", async () => {
    const stateRoot = path.join(tmpdir(), `ovd419-auth-${randomUUID()}`);
    try {
      await consumeLiveAuthorization({
        authorization: AUTHORIZATION,
        repositoryRoot: process.cwd(),
        stateRoot,
      });
      await expect(
        consumeLiveAuthorization({
          authorization: AUTHORIZATION,
          repositoryRoot: process.cwd(),
          stateRoot,
        }),
      ).rejects.toThrow("authorization_replayed");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("records successful evidence only in a new owner-only temporary file", async () => {
    const prefix = path.join(tmpdir(), `ovd419-cli-${randomUUID()}`);
    const authorizationFile = `${prefix}-authorization.json`;
    const bundleFile = `${prefix}-bundle.json`;
    const evidenceFile = `${prefix}-evidence.json`;
    await writeFile(authorizationFile, JSON.stringify(AUTHORIZATION), {
      mode: 0o600,
    });
    await writeFile(
      bundleFile,
      JSON.stringify({ record: RECORD, buildEvidence: {} }),
    );
    const output = { write: vi.fn() };
    const errorOutput = { write: vi.fn() };
    const release = vi.fn(async () => undefined);
    try {
      const exitCode = await runCli({
        args: [
          "--execute",
          "--authorization-file",
          authorizationFile,
          "--bundle-file",
          bundleFile,
          "--evidence-file",
          evidenceFile,
        ],
        env: { ...ENV, OVD419_OWNER_LOCK_PATH: `${prefix}-lock` },
        output,
        errorOutput,
        runRelease: vi.fn(async () => ({
          schema: "ovd419-live-release-v1",
          status: "passed",
        })),
        acquireOwner: vi.fn(async () => ({
          assertOwnership: vi.fn(async () => undefined),
          release,
        })),
      });
      expect(exitCode).toBe(0);
      expect(output.write).toHaveBeenCalledWith(
        "OVD-419 live release passed; private bounded evidence recorded.\n",
      );
      expect(errorOutput.write).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(evidenceFile, "utf8"))).toEqual({
        schema: "ovd419-live-release-v1",
        status: "passed",
      });
      expect((await stat(evidenceFile)).mode & 0o077).toBe(0);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await Promise.all(
        [authorizationFile, bundleFile, evidenceFile].map((file) =>
          rm(file, { force: true }),
        ),
      );
    }
  });

  it.each([
    ["promotion_failed_before_mutation", "not_required", "completed"],
    [
      "promotion_failed_rollback_unverified",
      "rollback_unverified",
      "retained",
    ],
    ["promotion_failed_rolled_back", "baseline_restored", "completed"],
    ["probe_failed_rolled_back", "baseline_restored", "completed"],
    ["probe_failed_rollback_failed", "rollback_unverified", "retained"],
    ["interrupted_before_mutation", "not_required", "completed"],
    ["interrupted_rolled_back", "baseline_restored", "completed"],
    ["interrupted_rollback_failed", "rollback_unverified", "retained"],
  ])(
    "records and emits the truthful %s terminal state",
    async (terminalCode, containment, ownerDisposition) => {
      const prefix = path.join(tmpdir(), `ovd419-failure-${randomUUID()}`);
      const authorizationFile = `${prefix}-authorization.json`;
      const bundleFile = `${prefix}-bundle.json`;
      const evidenceFile = `${prefix}-evidence.json`;
      await writeFile(authorizationFile, JSON.stringify(AUTHORIZATION), {
        mode: 0o600,
      });
      await writeFile(
        bundleFile,
        JSON.stringify({ record: RECORD, buildEvidence: {} }),
      );
      const errorOutput = { write: vi.fn() };
      let handlersRemoved = false;
      const release = vi.fn(async () => {
        expect(handlersRemoved).toBe(false);
      });
      try {
        const exitCode = await runCli({
          args: [
            "--execute",
            "--authorization-file",
            authorizationFile,
            "--bundle-file",
            bundleFile,
            "--evidence-file",
            evidenceFile,
          ],
          env: { ...ENV, OVD419_OWNER_LOCK_PATH: `${prefix}-lock` },
          errorOutput,
          runRelease: vi.fn(async () => {
            throw Object.assign(new Error("private diagnostics"), {
              code: terminalCode,
              ...([
                "promotion_failed_rolled_back",
                "promotion_failed_rollback_unverified",
              ].includes(terminalCode)
                ? {
                    promotionFailureCode: "job_resource_version_unchanged",
                    promotionFailureStage: "verify_after_job",
                  }
                : {}),
            });
          }),
          acquireOwner: vi.fn(async () => ({
            assertOwnership: vi.fn(async () => undefined),
            release,
          })),
          installTermination: vi.fn(() => () => {
            handlersRemoved = true;
          }),
        });
        expect(exitCode).toBe(1);
        expect(errorOutput.write).toHaveBeenCalledWith(
          `OVD-419 live release ${terminalCode}; private bounded failure evidence recorded; owner lock release ${ownerDisposition}.\n`,
        );
        expect(JSON.parse(await readFile(evidenceFile, "utf8"))).toEqual({
          schema: "ovd419-live-release-v1",
          status: "failed",
          issue: "OVD-419",
          terminalCode,
          containment,
          ...([
            "promotion_failed_rolled_back",
            "promotion_failed_rollback_unverified",
          ].includes(terminalCode)
            ? {
                promotionFailureCode: "job_resource_version_unchanged",
                promotionFailureStage: "verify_after_job",
              }
            : {}),
          retryAuthorized: false,
        });
        expect(release).toHaveBeenCalledTimes(
          ownerDisposition === "completed" ? 1 : 0,
        );
        expect(handlersRemoved).toBe(true);
      } finally {
        await Promise.all(
          [authorizationFile, bundleFile, evidenceFile].map((file) =>
            rm(file, { force: true }),
          ),
        );
      }
    },
  );

  it("records success before reporting an owner-lock release failure", async () => {
    const prefix = path.join(tmpdir(), `ovd419-release-fault-${randomUUID()}`);
    const authorizationFile = `${prefix}-authorization.json`;
    const bundleFile = `${prefix}-bundle.json`;
    const evidenceFile = `${prefix}-evidence.json`;
    await writeFile(authorizationFile, JSON.stringify(AUTHORIZATION), {
      mode: 0o600,
    });
    await writeFile(
      bundleFile,
      JSON.stringify({ record: RECORD, buildEvidence: {} }),
    );
    const output = { write: vi.fn() };
    const errorOutput = { write: vi.fn() };
    try {
      const exitCode = await runCli({
        args: [
          "--execute",
          "--authorization-file",
          authorizationFile,
          "--bundle-file",
          bundleFile,
          "--evidence-file",
          evidenceFile,
        ],
        env: { ...ENV, OVD419_OWNER_LOCK_PATH: `${prefix}-lock` },
        output,
        errorOutput,
        runRelease: vi.fn(async () => ({
          schema: "ovd419-live-release-v1",
          status: "passed",
        })),
        acquireOwner: vi.fn(async () => ({
          assertOwnership: vi.fn(async () => undefined),
          release: vi.fn(async () => {
            throw new Error("private lock diagnostics");
          }),
        })),
      });
      expect(exitCode).toBe(3);
      expect(output.write).not.toHaveBeenCalled();
      expect(errorOutput.write).toHaveBeenCalledWith(
        "OVD-419 live release passed_owner_lock_release_failed; private bounded success evidence recorded; retry not authorized.\n",
      );
      expect(JSON.parse(await readFile(evidenceFile, "utf8"))).toEqual({
        schema: "ovd419-live-release-v1",
        status: "passed",
      });
    } finally {
      await Promise.all(
        [authorizationFile, bundleFile, evidenceFile].map((file) =>
          rm(file, { force: true }),
        ),
      );
    }
  });

  it("records a fixed passed-interrupted state when termination arrives after qualification", async () => {
    const prefix = path.join(tmpdir(), `ovd419-passed-signal-${randomUUID()}`);
    const authorizationFile = `${prefix}-authorization.json`;
    const bundleFile = `${prefix}-bundle.json`;
    const evidenceFile = `${prefix}-evidence.json`;
    await writeFile(authorizationFile, JSON.stringify(AUTHORIZATION), {
      mode: 0o600,
    });
    await writeFile(
      bundleFile,
      JSON.stringify({ record: RECORD, buildEvidence: {} }),
    );
    const output = { write: vi.fn() };
    const release = vi.fn(async () => undefined);
    try {
      const exitCode = await runCli({
        args: [
          "--execute",
          "--authorization-file",
          authorizationFile,
          "--bundle-file",
          bundleFile,
          "--evidence-file",
          evidenceFile,
        ],
        env: { ...ENV, OVD419_OWNER_LOCK_PATH: `${prefix}-lock` },
        output,
        errorOutput: { write: vi.fn() },
        runRelease: vi.fn(async ({ terminationState }) => {
          terminationState.markQualificationPassed();
          terminationState.request("SIGTERM");
          return {
            schema: "ovd419-live-release-v1",
            status: "passed",
          };
        }),
        acquireOwner: vi.fn(async () => ({
          assertOwnership: vi.fn(async () => undefined),
          release,
        })),
      });
      expect(exitCode).toBe(0);
      expect(output.write).toHaveBeenCalledWith(
        "OVD-419 live release passed_interrupted_after_qualification; private bounded success evidence recorded; retry not authorized.\n",
      );
      expect(JSON.parse(await readFile(evidenceFile, "utf8"))).toMatchObject({
        status: "passed",
        terminalCode: "passed_interrupted_after_qualification",
        retryAuthorized: false,
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await Promise.all(
        [authorizationFile, bundleFile, evidenceFile].map((file) =>
          rm(file, { force: true }),
        ),
      );
    }
  });

  it("reports missing durable success evidence without reclassifying the release as failed", async () => {
    const prefix = path.join(tmpdir(), `ovd419-write-fault-${randomUUID()}`);
    const authorizationFile = `${prefix}-authorization.json`;
    const bundleFile = `${prefix}-bundle.json`;
    const evidenceFile = `${prefix}-evidence.json`;
    await writeFile(authorizationFile, JSON.stringify(AUTHORIZATION), {
      mode: 0o600,
    });
    await writeFile(
      bundleFile,
      JSON.stringify({ record: RECORD, buildEvidence: {} }),
    );
    const errorOutput = { write: vi.fn() };
    try {
      const exitCode = await runCli({
        args: [
          "--execute",
          "--authorization-file",
          authorizationFile,
          "--bundle-file",
          bundleFile,
          "--evidence-file",
          evidenceFile,
        ],
        env: { ...ENV, OVD419_OWNER_LOCK_PATH: `${prefix}-lock` },
        errorOutput,
        runRelease: vi.fn(async () => ({
          schema: "ovd419-live-release-v1",
          status: "passed",
        })),
        acquireOwner: vi.fn(async () => ({
          assertOwnership: vi.fn(async () => undefined),
          release: vi.fn(async () => undefined),
        })),
        writeEvidence: vi.fn(async () => {
          throw new Error("private fsync diagnostics");
        }),
      });
      expect(exitCode).toBe(4);
      expect(errorOutput.write).toHaveBeenCalledWith(
        "OVD-419 live release passed_evidence_write_failed; owner lock release completed; retry not authorized.\n",
      );
      expect(await readFile(evidenceFile, "utf8")).toBe("");
    } finally {
      await Promise.all(
        [authorizationFile, bundleFile, evidenceFile].map((file) =>
          rm(file, { force: true }),
        ),
      );
    }
  });

  it("reserves the private evidence path before acquiring ownership or mutating", async () => {
    const prefix = path.join(
      tmpdir(),
      `ovd419-existing-evidence-${randomUUID()}`,
    );
    const authorizationFile = `${prefix}-authorization.json`;
    const bundleFile = `${prefix}-bundle.json`;
    const evidenceFile = `${prefix}-evidence.json`;
    await writeFile(authorizationFile, JSON.stringify(AUTHORIZATION), {
      mode: 0o600,
    });
    await writeFile(
      bundleFile,
      JSON.stringify({ record: RECORD, buildEvidence: {} }),
    );
    await writeFile(evidenceFile, "existing", { mode: 0o600 });
    const runRelease = vi.fn();
    const acquireOwner = vi.fn();
    try {
      expect(
        await runCli({
          args: [
            "--execute",
            "--authorization-file",
            authorizationFile,
            "--bundle-file",
            bundleFile,
            "--evidence-file",
            evidenceFile,
          ],
          env: { ...ENV, OVD419_OWNER_LOCK_PATH: `${prefix}-lock` },
          errorOutput: { write: vi.fn() },
          runRelease,
          acquireOwner,
        }),
      ).toBe(1);
      expect(runRelease).not.toHaveBeenCalled();
      expect(acquireOwner).not.toHaveBeenCalled();
      expect(await readFile(evidenceFile, "utf8")).toBe("existing");
    } finally {
      await Promise.all(
        [authorizationFile, bundleFile, evidenceFile].map((file) =>
          rm(file, { force: true }),
        ),
      );
    }
  });
});

describe("OVD-419 post-promotion failure containment", () => {
  it("classifies runtime guard verification failures before mutation", async () => {
    const terminationState = createTerminationState();
    const promote = vi.fn();
    await expect(
      runAuthorizedLiveRelease({
        recordSource: JSON.stringify(RECORD),
        buildEvidence: {},
        authorization: AUTHORIZATION,
        env: ENV,
        now: NOW,
        assertOwnership: vi.fn(async () => undefined),
        terminationState,
        dependencies: {
          consumeAuthorization: vi.fn(async () => undefined),
          createOperations: vi.fn(() => ({
            verifyRuntimeGuardPermissions: vi.fn(async () => {
              throw new Error("private runtime guard diagnostics");
            }),
          })),
          promote,
        },
      }),
    ).rejects.toThrow("promotion_failed_before_mutation");
    expect(promote).not.toHaveBeenCalled();
    expect(terminationState.mutationAttempted()).toBe(false);
  });

  it("stops with a fixed interrupted state before any mutation begins", async () => {
    const terminationState = createTerminationState();
    terminationState.request("SIGINT");
    const promote = vi.fn();
    await expect(
      runAuthorizedLiveRelease({
        recordSource: JSON.stringify(RECORD),
        buildEvidence: {},
        authorization: AUTHORIZATION,
        env: ENV,
        now: NOW,
        assertOwnership: vi.fn(async () => undefined),
        terminationState,
        dependencies: {
          consumeAuthorization: vi.fn(async () => undefined),
          promote,
        },
      }),
    ).rejects.toThrow("interrupted_before_mutation");
    expect(promote).not.toHaveBeenCalled();
    expect(terminationState.mutationAttempted()).toBe(false);
  });

  it.each([
    ["promotion_failed_rolled_back", "interrupted_rolled_back"],
    [
      "promotion_failed_rollback_unverified",
      "interrupted_rollback_failed",
    ],
  ])(
    "maps %s to %s when termination arrives during promotion",
    async (promotionCode, interruptedCode) => {
      const terminationState = createTerminationState();
      await expect(
        runAuthorizedLiveRelease({
          recordSource: JSON.stringify(RECORD),
          buildEvidence: {},
          authorization: AUTHORIZATION,
          env: ENV,
          now: NOW,
          assertOwnership: vi.fn(async () => undefined),
          terminationState,
          dependencies: {
            consumeAuthorization: vi.fn(async () => undefined),
            createOperations: vi.fn(() => ({
              promotion: {},
              probes: {},
              rollbackAfterProbeFailure: vi.fn(async () => undefined),
              verifyRuntimeGuardPermissions: vi.fn(async () => undefined),
            })),
            promote: vi.fn(async () => {
              terminationState.markMutationAttempted();
              terminationState.request("SIGTERM");
              throw Object.assign(
                new Error("private promotion diagnostics"),
                { code: promotionCode },
              );
            }),
          },
        }),
      ).rejects.toThrow(interruptedCode);
    },
  );

  it("rolls the candidate back when termination arrives during a probe", async () => {
    const terminationState = createTerminationState();
    const rollbackAfterProbeFailure = vi.fn(async () => undefined);
    await expect(
      runAuthorizedLiveRelease({
        recordSource: JSON.stringify(RECORD),
        buildEvidence: {},
        authorization: AUTHORIZATION,
        env: ENV,
        now: NOW,
        assertOwnership: vi.fn(async () => undefined),
        terminationState,
        dependencies: {
          consumeAuthorization: vi.fn(async () => undefined),
          createOperations: vi.fn(() => ({
            promotion: {},
            probes: {},
            rollbackAfterProbeFailure,
            verifyRuntimeGuardPermissions: vi.fn(async () => undefined),
          })),
          promote: vi.fn(async () => {
            terminationState.markMutationAttempted();
            return { status: "promoted" };
          }),
          runProbes: vi.fn(async () => {
            terminationState.request("SIGINT");
            throw new Error("private probe diagnostics");
          }),
        },
      }),
    ).rejects.toThrow("interrupted_rolled_back");
    expect(rollbackAfterProbeFailure).toHaveBeenCalledOnce();
  });

  it("rolls both resources back when qualification probes fail", async () => {
    const rollbackAfterProbeFailure = vi.fn(async () => undefined);
    await expect(
      runAuthorizedLiveRelease({
        recordSource: JSON.stringify(RECORD),
        buildEvidence: {},
        authorization: AUTHORIZATION,
        env: ENV,
        now: NOW,
        assertOwnership: vi.fn(async () => undefined),
        dependencies: {
          consumeAuthorization: vi.fn(async () => undefined),
          createOperations: vi.fn(() => ({
            promotion: {},
            probes: {},
            rollbackAfterProbeFailure,
            verifyRuntimeGuardPermissions: vi.fn(async () => undefined),
          })),
          promote: vi.fn(async () => ({ status: "promoted" })),
          runProbes: vi.fn(async () => {
            throw new Error("private probe diagnostics");
          }),
        },
      }),
    ).rejects.toThrow("probe_failed_rolled_back");
    expect(rollbackAfterProbeFailure).toHaveBeenCalledOnce();
  });

  it("reports a fixed containment error when probe rollback is incomplete", async () => {
    await expect(
      runAuthorizedLiveRelease({
        recordSource: JSON.stringify(RECORD),
        buildEvidence: {},
        authorization: AUTHORIZATION,
        env: ENV,
        now: NOW,
        assertOwnership: vi.fn(async () => undefined),
        dependencies: {
          consumeAuthorization: vi.fn(async () => undefined),
          createOperations: vi.fn(() => ({
            promotion: {},
            probes: {},
            rollbackAfterProbeFailure: vi.fn(async () => {
              throw new Error("private rollback diagnostics");
            }),
            verifyRuntimeGuardPermissions: vi.fn(async () => undefined),
          })),
          promote: vi.fn(async () => ({ status: "promoted" })),
          runProbes: vi.fn(async () => {
            throw new Error("private probe diagnostics");
          }),
        },
      }),
    ).rejects.toThrow("probe_failed_rollback_failed");
  });
});

describe("OVD-419 sole-controller ownership", () => {
  it("inspects and releases the current process with the host ps dialect", async () => {
    const lockPath = path.join(tmpdir(), `ovd419-host-ps-${randomUUID()}.lock`);
    const lock = await acquireLiveOwnerLock({
      lockPath,
      repositoryRoot: process.cwd(),
    });
    await lock.assertOwnership();
    await lock.release();
    await expect(access(lockPath)).rejects.toThrow();
  });

  it("uses one atomic owner-only lock bound to the current PID and PGID", async () => {
    const lockPath = path.join(tmpdir(), `ovd419-live-${randomUUID()}.lock`);
    const inspectProcess = vi.fn(async (pid) => ({
      pid,
      parentPid: 2,
      processGroupId: 2345,
      sessionId: 2345,
      terminalGroupId: 2345,
    }));
    const lock = await acquireLiveOwnerLock({
      lockPath,
      repositoryRoot: process.cwd(),
      inspectProcess,
    });
    await lock.assertOwnership();
    await expect(
      acquireLiveOwnerLock({
        lockPath,
        repositoryRoot: process.cwd(),
        inspectProcess,
      }),
    ).rejects.toThrow("owner_lock_unavailable");
    await lock.release();
    await expect(access(lockPath)).rejects.toThrow();
  });
});

describe("OVD-419 live promotion callbacks", () => {
  it("revalidates the same full Job document used for replacement", async () => {
    const currentJob = job();
    currentJob.spec.template.spec.template.spec.timeoutSeconds = 600;
    const harness = operationHarness({
      resources: { job: currentJob },
      projectStableEgress: (stable) => {
        const projected = structuredClone(stable);
        delete projected.job.spec.template.spec.template.spec.timeoutSeconds;
        return projected;
      },
    });

    const observed = await harness.operations.promotion.observe({
      phase: "before-job",
    });
    await expect(
      harness.operations.promotion.verifyObservation({
        observed,
        phase: "before-job",
      }),
    ).resolves.toEqual({ ok: true, failures: [] });
    await expect(
      harness.operations.promotion.replaceJob({
        image: IMAGE,
        expectedResourceVersion: observed.jobResourceVersion,
        execute: false,
      }),
    ).resolves.toBeUndefined();
    expect(harness.replacements).toHaveLength(1);
  });

  it("normalizes numeric gcloud snapshot metadata before live readback verification", async () => {
    const harness = operationHarness({
      snapshotMetadata: {
        generation: "101",
        metageneration: 7,
        etag: "snapshot-etag",
      },
    });

    const observed = await harness.operations.promotion.observe({
      phase: "before-job",
    });

    expect(observed.snapshot).toEqual({
      generation: "101",
      metageneration: "7",
      etag: "snapshot-etag",
    });
    await expect(
      harness.operations.promotion.verifyObservation({
        observed,
        phase: "before-job",
      }),
    ).resolves.toEqual({ ok: true, failures: [] });
  });

  it.each([
    [
      "stable egress",
      (observed) => {
        observed.stableEgressResult.failures = ["unexpected_failure"];
      },
      "stable_egress_observation_invalid",
    ],
    [
      "phase",
      (observed) => {
        observed.phase = "after-job";
      },
      "observation_phase_invalid",
    ],
    [
      "rollout control",
      (observed) => {
        observed.rollout.disabled = false;
      },
      "rollout_not_disabled",
    ],
    [
      "Job queue",
      (observed) => {
        observed.queueDepthJob = 1;
      },
      "job_queue_not_empty",
    ],
    [
      "Service queue",
      (observed) => {
        observed.queueDepthService = 1;
      },
      "service_queue_not_empty",
    ],
    [
      "active execution",
      (observed) => {
        observed.executionCount = 1;
      },
      "active_execution_present",
    ],
    [
      "execution inventory",
      (observed) => {
        observed.executionInventoryCount = -1;
      },
      "execution_inventory_invalid",
    ],
    [
      "Job configuration",
      (observed) => {
        observed.jobConfigurationFingerprint = "invalid";
      },
      "job_configuration_observation_invalid",
    ],
    [
      "snapshot version",
      (observed) => {
        observed.snapshot = { ...observed.snapshot, generation: null };
      },
      "snapshot_version_invalid",
    ],
  ])(
    "classifies an invalid %s readback with one bounded code",
    async (_label, mutate, expectedFailure) => {
      const harness = operationHarness();
      const observed = await harness.operations.promotion.observe({
        phase: "before-job",
      });
      mutate(observed);

      await expect(
        harness.operations.promotion.verifyObservation({
          observed,
          phase: "before-job",
        }),
      ).resolves.toEqual({ ok: false, failures: [expectedFailure] });
    },
  );

  it.each([
    ["one mapping", "nat_mapping_inventory_not_quiescent"],
    ["multiple mappings", "nat_mapping_inventory_multiple"],
  ])(
    "hands an after-Service NAT-only observation for %s to bounded containment polling",
    async (_label, natFailure) => {
      let currentTime = 0;
      const evaluateStableEgress = vi
        .fn()
        .mockReturnValueOnce(stableEgressResult())
        .mockReturnValueOnce(stableEgressResult("service_job_image_mismatch"))
        .mockReturnValueOnce(stableEgressResult("service_job_image_mismatch"))
        .mockReturnValueOnce(stableEgressResult(natFailure))
        .mockReturnValueOnce(stableEgressResult(natFailure))
        .mockReturnValueOnce(stableEgressResult());
      const waitFor = vi.fn(async (milliseconds) => {
        currentTime += milliseconds;
      });
      const harness = operationHarness({
        evaluateStableEgress,
        mutateOnReplace: true,
        now: () => currentTime,
        waitFor,
      });

      await expect(
        promoteDigest({
          recordSource: JSON.stringify(RECORD),
          buildEvidence: buildEvidence(),
          operations: harness.operations.promotion,
          execute: true,
        }),
      ).resolves.toMatchObject({
        status: "promoted",
        image: IMAGE,
        jobExecutedDuringPromotion: false,
        contained: true,
      });

      expect(waitFor).toHaveBeenCalledOnce();
      expect(waitFor).toHaveBeenCalledWith(30_000);
      expect(harness.replacements.map(({ args }) => args[1])).toEqual([
        "jobs",
        "services",
      ]);
      expect(
        harness.resources.job.spec.template.spec.template.spec.containers[0]
          .image,
      ).toBe(IMAGE);
      expect(
        harness.resources.service.spec.template.spec.containers[0].image,
      ).toBe(IMAGE);
      expect(
        harness.resources.service.spec.template.spec.containers[0].env.find(
          ({ name }) => name === "WORKER_BUILD_VERSION",
        ).value,
      ).toBe(SHA);
      expect(harness.calls.some((args) => args.includes("execute"))).toBe(
        false,
      );
      expect(harness.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "a mixed NAT and non-NAT failure",
      {
        ok: false,
        invalid: false,
        failures: ["nat_mapping_inventory_not_quiescent", "unexpected_failure"],
      },
    ],
    [
      "invalid NAT evidence",
      {
        ok: false,
        invalid: true,
        failures: ["nat_mapping_inventory_not_quiescent"],
      },
    ],
    [
      "contradictory ready evidence",
      { ok: false, invalid: false, failures: [] },
    ],
    [
      "ready evidence without a boolean status",
      { invalid: false, failures: [] },
    ],
    ["a non-NAT failure", stableEgressResult("unexpected_failure")],
  ])("rejects %s after Service promotion", async (_label, stableResult) => {
    const harness = operationHarness({
      evaluateStableEgress: vi.fn(() => stableResult),
    });
    const observed = await harness.operations.promotion.observe({
      phase: "after-service",
    });

    await expect(
      harness.operations.promotion.verifyObservation({
        observed,
        phase: "after-service",
      }),
    ).resolves.toEqual({
      ok: false,
      failures: ["stable_egress_observation_invalid"],
    });
  });

  it.each([
    ["array", [7]],
    ["object", { value: 7 }],
    ["fractional number", 7.5],
    ["negative number", -7],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a malformed %s snapshot metageneration", async (_label, value) => {
    const harness = operationHarness({
      snapshotMetadata: {
        generation: "101",
        metageneration: value,
        etag: "snapshot-etag",
      },
    });

    await expect(
      harness.operations.promotion.observe({ phase: "before-job" }),
    ).rejects.toThrow("snapshot_metadata_invalid");
  });

  it("requires the runtime identity to read the Job and execution inventory", async () => {
    const allowed = operationHarness();
    await expect(
      allowed.operations.verifyRuntimeGuardPermissions(),
    ).resolves.toBeUndefined();

    const denied = operationHarness({ runtimePermissions: ["run.jobs.get"] });
    await expect(
      denied.operations.verifyRuntimeGuardPermissions(),
    ).rejects.toThrow("runtime_guard_permissions_missing");
  });

  it("keeps Job replacement execute:false and passes the fresh resource version", async () => {
    const assertOwnership = vi.fn(async () => undefined);
    const harness = operationHarness({ assertOwnership });
    await harness.operations.promotion.observe({ phase: "before-job" });
    await harness.operations.promotion.replaceJob({
      image: IMAGE,
      expectedResourceVersion: "job-v1",
      execute: false,
    });
    expect(assertOwnership).toHaveBeenCalledTimes(2);
    expect(harness.replacements).toHaveLength(1);
    expect(harness.replacements[0].args.slice(0, 3)).toEqual([
      "run",
      "jobs",
      "replace",
    ]);
    expect(
      harness.replacements[0].manifest.spec.template.spec.template.spec
        .containers[0].image,
    ).toBe(IMAGE);
    expect(harness.calls.some((args) => args.includes("execute"))).toBe(false);
  });

  it("defers termination raised by Job replacement to the promotion rollback boundary", async () => {
    const terminationState = createTerminationState();
    const harness = operationHarness({
      mutateOnReplace: true,
      terminationState,
      onReplace: () => terminationState.request("SIGTERM"),
    });
    await harness.operations.promotion.observe({ phase: "before-job" });
    await expect(
      harness.operations.promotion.replaceJob({
        image: IMAGE,
        expectedResourceVersion: "job-v1",
        execute: false,
      }),
    ).rejects.toThrow("termination_requested");
    expect(harness.replacements).toHaveLength(1);
    expect(
      harness.resources.job.spec.template.spec.template.spec.containers[0]
        .image,
    ).toBe(IMAGE);
    expect(terminationState.mutationAttempted()).toBe(true);
  });

  it("rejects a resource-version race before mutation", async () => {
    const harness = operationHarness();
    await harness.operations.promotion.observe({ phase: "before-job" });
    harness.resources.job = job({ version: "job-raced" });
    await expect(
      harness.operations.promotion.replaceJob({
        image: IMAGE,
        expectedResourceVersion: "job-v1",
        execute: false,
      }),
    ).rejects.toThrow("resource_version_changed");
    expect(harness.replacements).toHaveLength(0);
  });

  it("rejects queue and Job-configuration races in the last pre-mutation readback", async () => {
    const collectEnvelope = vi
      .fn()
      .mockResolvedValueOnce(emptyEnvelope())
      .mockResolvedValue({
        ...emptyEnvelope(),
        workQueue: { activeCount: 1 },
      });
    const queueRace = operationHarness({ collectEnvelope });
    await queueRace.operations.promotion.observe({ phase: "before-job" });
    await expect(
      queueRace.operations.promotion.replaceJob({
        image: IMAGE,
        expectedResourceVersion: "job-v1",
        execute: false,
      }),
    ).rejects.toThrow("resource_version_changed");
    expect(queueRace.replacements).toHaveLength(0);

    const configurationRace = operationHarness();
    await configurationRace.operations.promotion.observe({
      phase: "before-job",
    });
    configurationRace.resources.job.spec.template.spec.template.spec.containers[0].args =
      ["dist/tools/other.js"];
    await expect(
      configurationRace.operations.promotion.replaceJob({
        image: IMAGE,
        expectedResourceVersion: "job-v1",
        execute: false,
      }),
    ).rejects.toThrow("resource_version_changed");
    expect(configurationRace.replacements).toHaveLength(0);
  });

  it("restores both resources symmetrically with fresh CAS and the baseline build version", async () => {
    const harness = operationHarness();
    await harness.operations.promotion.observe({ phase: "before-job" });
    harness.resources.service = service({
      image: IMAGE,
      version: "service-candidate",
    });
    harness.resources.job = job({ image: IMAGE, version: "job-candidate" });
    await harness.operations.promotion.observeRollbackResource({
      resource: "service",
    });
    await harness.operations.promotion.rollbackResource({
      resource: "service",
      image: ROLLBACK,
      expectedResourceVersion: "service-candidate",
    });
    await harness.operations.promotion.observeRollbackResource({
      resource: "job",
    });
    await harness.operations.promotion.rollbackResource({
      resource: "job",
      image: ROLLBACK,
      expectedResourceVersion: "job-candidate",
    });
    expect(harness.replacements).toHaveLength(2);
    const serviceManifest = harness.replacements[0].manifest;
    expect(serviceManifest.spec.template.spec.containers[0].image).toBe(
      ROLLBACK,
    );
    expect(
      serviceManifest.spec.template.spec.containers[0].env.find(
        (entry) => entry.name === "WORKER_BUILD_VERSION",
      ).value,
    ).toBe("old-build");
    expect(
      harness.replacements[1].manifest.spec.template.spec.template.spec
        .containers[0].image,
    ).toBe(ROLLBACK);
  });

  it("automatically restores both candidate resources after a probe failure", async () => {
    const harness = operationHarness({ mutateOnReplace: true });
    await harness.operations.promotion.observe({ phase: "before-job" });
    harness.resources.service = service({
      image: IMAGE,
      version: "service-candidate",
      buildVersion: SHA,
    });
    harness.resources.job = job({ image: IMAGE, version: "job-candidate" });

    await harness.operations.rollbackAfterProbeFailure();

    expect(
      harness.resources.service.spec.template.spec.containers[0].image,
    ).toBe(ROLLBACK);
    expect(
      harness.resources.service.spec.template.spec.containers[0].env.find(
        (entry) => entry.name === "WORKER_BUILD_VERSION",
      ).value,
    ).toBe("old-build");
    expect(
      harness.resources.job.spec.template.spec.template.spec.containers[0]
        .image,
    ).toBe(ROLLBACK);
  });

  it("rejects containment when the Service build version does not match its digest", async () => {
    const harness = operationHarness();
    await harness.operations.promotion.observe({ phase: "before-job" });
    await harness.operations.promotion.observe({ phase: "before-service" });
    await harness.operations.promotion.replaceService({
      image: IMAGE,
      buildVersion: SHA,
      expectedResourceVersion: "service-v1",
    });
    harness.resources.job = job({ image: IMAGE, version: "job-candidate" });
    harness.resources.service = service({
      image: IMAGE,
      version: "service-candidate",
      buildVersion: "wrong-build",
    });
    const inventory = await harness.operations.probes.executionInventory();

    await expect(
      harness.operations.promotion.verifyContainment({
        expectedImage: IMAGE,
        expectedExecutionInventory: inventory,
      }),
    ).resolves.toMatchObject({ ok: false });

    harness.resources.service.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "WORKER_BUILD_VERSION",
    ).value = SHA;
    await expect(
      harness.operations.promotion.verifyContainment({
        expectedImage: IMAGE,
        expectedExecutionInventory: inventory,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["one mapping", ["nat_mapping_inventory_not_quiescent"]],
    [
      "multiple mappings draining through one mapping",
      [
        "nat_mapping_inventory_multiple",
        "nat_mapping_inventory_not_quiescent",
      ],
    ],
  ])(
    "passively waits for %s and requires a fresh zero-mapping observation",
    async (_label, pendingFailures) => {
      let currentTime = 0;
      const stableResults = [
        stableEgressResult(),
        ...pendingFailures.map((failure) => stableEgressResult(failure)),
        stableEgressResult(),
      ];
      const evaluateStableEgress = vi.fn(() => stableResults.shift());
      const waitFor = vi.fn(async (milliseconds) => {
        currentTime += milliseconds;
      });
      const { harness, result } = await runContainmentVerification({
        evaluateStableEgress,
        now: () => currentTime,
        waitFor,
      });
      expect(result).toMatchObject({ ok: true, failures: [] });

      const containmentObservations = pendingFailures.length + 1;
      expect(waitFor).toHaveBeenCalledTimes(pendingFailures.length);
      expect(harness.assertOwnership).toHaveBeenCalledTimes(
        containmentObservations * 2,
      );
      expect(harness.collectEnvelope).toHaveBeenCalledTimes(
        containmentObservations + 1,
      );
      expect(harness.collectStableEgress).toHaveBeenCalledTimes(
        containmentObservations + 1,
      );
      expectNoActiveReleaseCalls(harness);
    },
  );

  it("stops passive NAT observation immediately when another release invariant drifts", async () => {
    const collectEnvelope = vi
      .fn()
      .mockResolvedValueOnce(emptyEnvelope())
      .mockResolvedValueOnce({
        ...emptyEnvelope(),
        workQueue: { activeCount: 1 },
      });
    const evaluateStableEgress = vi
      .fn()
      .mockReturnValueOnce(stableEgressResult())
      .mockReturnValueOnce(
        stableEgressResult("nat_mapping_inventory_not_quiescent"),
      );
    const waitFor = vi.fn();
    const { result } = await runContainmentVerification({
      collectEnvelope,
      evaluateStableEgress,
      now: () => 0,
      waitFor,
    });
    expect(result).toMatchObject({ ok: false, failures: ["containment_invalid"] });
    expect(waitFor).not.toHaveBeenCalled();
  });

  it("stops passive NAT observation immediately when the snapshot changes", async () => {
    let snapshotCalls = 0;
    const snapshotMetadata = vi.fn(() => {
      snapshotCalls += 1;
      return {
        generation: snapshotCalls === 1 ? "101" : "102",
        metageneration: "7",
        etag: "snapshot-etag",
      };
    });
    const evaluateStableEgress = vi
      .fn()
      .mockReturnValueOnce(stableEgressResult())
      .mockReturnValueOnce(
        stableEgressResult("nat_mapping_inventory_not_quiescent"),
      );
    const waitFor = vi.fn();
    const { result } = await runContainmentVerification({
      evaluateStableEgress,
      now: () => 0,
      snapshotMetadata,
      waitFor,
    });
    expect(result).toMatchObject({ ok: false, failures: ["containment_invalid"] });
    expect(waitFor).not.toHaveBeenCalled();
  });

  it("times out with containment still failed when NAT mappings persist", async () => {
    let currentTime = 0;
    const evaluateStableEgress = vi
      .fn()
      .mockReturnValueOnce(stableEgressResult())
      .mockReturnValue(
        stableEgressResult("nat_mapping_inventory_not_quiescent"),
      );
    const waitFor = vi.fn(async (milliseconds) => {
      currentTime += milliseconds;
    });
    const { harness, result } = await runContainmentVerification({
      evaluateStableEgress,
      now: () => currentTime,
      waitFor,
    });
    expect(result).toMatchObject({ ok: false, failures: ["containment_invalid"] });
    expect(waitFor).toHaveBeenCalledTimes(40);
    expectNoActiveReleaseCalls(harness);
  });

  it("rejects a zero-mapping observation that completes after the deadline", async () => {
    let currentTime = 0;
    const evaluateStableEgress = vi
      .fn()
      .mockReturnValueOnce(stableEgressResult())
      .mockReturnValueOnce(
        stableEgressResult("nat_mapping_inventory_not_quiescent"),
      )
      .mockReturnValueOnce(stableEgressResult());
    const waitFor = vi.fn(async () => {
      currentTime = 20 * 60_000 + 1;
    });
    const { result } = await runContainmentVerification({
      evaluateStableEgress,
      now: () => currentTime,
      waitFor,
    });
    expect(result).toMatchObject({ ok: false, failures: ["containment_invalid"] });
    expect(waitFor).toHaveBeenCalledTimes(1);
  });

  it("never waits on malformed NAT evidence or another egress failure", async () => {
    const evaluateStableEgress = vi
      .fn()
      .mockReturnValueOnce(stableEgressResult())
      .mockReturnValueOnce({
        ok: false,
        invalid: true,
        failures: ["nat_mapping_inventory_invalid"],
      });
    const waitFor = vi.fn();
    const { result } = await runContainmentVerification({
      evaluateStableEgress,
      now: () => 0,
      waitFor,
    });
    expect(result).toMatchObject({ ok: false, failures: ["containment_invalid"] });
    expect(waitFor).not.toHaveBeenCalled();
  });
});

describe("OVD-419 live no-upload probe callback", () => {
  it("defers termination during the provider probe until rollback can run", async () => {
    const terminationState = createTerminationState();
    const harness = operationHarness({ terminationState });
    harness.runCommand.mockImplementation(async (_bin, args) => {
      if (args.includes("execute")) {
        terminationState.request("SIGINT");
        return {
          metadata: { name: "execution-interrupted" },
          spec: { taskCount: 1 },
          status: { succeededCount: 1, failedCount: 0 },
        };
      }
      throw new Error("unexpected command");
    });
    await expect(
      harness.operations.probes.executeProbe({
        image: IMAGE,
        expectedSnapshot: {
          generation: "101",
          metageneration: "7",
          etag: "snapshot-etag",
        },
        expectedJobIdentity: {
          resourceVersion: "job-v1",
          configurationFingerprint: "d".repeat(64),
        },
        expectedExecutionInventory: {
          totalCount: 0,
          activeCount: 0,
          completedExecutionIds: [],
          fingerprint:
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e808b7c03261f3c790b85",
        },
      }),
    ).rejects.toThrow("termination_requested");
    expect(terminationState.mutationAttempted()).toBe(true);
    expect(
      harness.runCommand.mock.calls.some(([, args]) => args[0] === "logging"),
    ).toBe(false);
  });

  it("injects the in-Job precondition guard and returns only bounded probe evidence", async () => {
    const harness = operationHarness();
    const executionId = "overdrafter-xometry-auth-probe-live1";
    const evidence = {
      authenticated: true,
      reason: "authenticated_dashboard",
      browserEngine: "camoufox",
      snapshotGeneration: "101",
      snapshotPersisted: false,
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
      screenshotCaptured: false,
      domCaptured: false,
      traceCaptured: false,
      providerMutationObserved: false,
      dashboardInteraction: "read_only_authentication",
      blockedNonReadMethods: [],
      preconditionsEnforcedBeforeBrowserNetworkActivation: true,
    };
    harness.runCommand.mockImplementation(async (_bin, args) => {
      if (args.includes("execute")) {
        const expressionArgument = args.find((arg) =>
          arg.startsWith("--args="),
        );
        expect(expressionArgument).toContain("data:text/javascript;base64,");
        const encodedGuard = /base64,([A-Za-z0-9+/=]+)"\)/.exec(
          expressionArgument,
        )?.[1];
        const guardSource = Buffer.from(encodedGuard, "base64").toString(
          "utf8",
        );
        expect(guardSource).toContain("storage.googleapis.com/storage/v1");
        expect(guardSource).toContain("jobIdentity.configurationFingerprint");
        expect(guardSource).toContain("activeCount !== 1");
        expect(guardSource).toContain("executionInventory.fingerprint");
        expect(guardSource).toContain(
          'Symbol.for("overdrafter.xometryAuthProbe.preNetworkGuard")',
        );
        expect(guardSource).toContain("guardState.executed = true");
        expect(guardSource.indexOf("precondition failed")).toBeLessThan(
          guardSource.indexOf("probeXometryProfileAuth.js"),
        );
        expect(guardSource).not.toContain("screenshotCaptured: false");
        expect(guardSource).not.toContain("providerMutationObserved: false");
        expect(args).toContain("--tasks=1");
        expect(args).toContain("--wait");
        expect(
          args.some((arg) =>
            arg.startsWith("--update-env-vars=OVD419_EXPECTED"),
          ),
        ).toBe(true);
        return {
          metadata: { name: executionId },
          spec: { taskCount: 1 },
          status: {
            succeededCount: 1,
            failedCount: 0,
            completionTime: "2026-08-28T20:10:00Z",
          },
        };
      }
      if (args[0] === "logging")
        return [{ textPayload: JSON.stringify(evidence) }];
      throw new Error("unexpected command");
    });
    const result = await harness.operations.probes.executeProbe({
      image: IMAGE,
      expectedSnapshot: {
        generation: "101",
        metageneration: "7",
        etag: "snapshot-etag",
      },
      expectedJobIdentity: {
        resourceVersion: "job-v1",
        configurationFingerprint: "d".repeat(64),
      },
      expectedExecutionInventory: {
        totalCount: 0,
        activeCount: 0,
        completedExecutionIds: [],
        fingerprint:
          "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e808b7c03261f3c790b85",
      },
    });
    expect(result).toMatchObject({
      executionId,
      image: IMAGE,
      taskCount: 1,
      maxRetries: 0,
      freshInstance: true,
      preconditionsEnforcedBeforeBrowserNetworkActivation: true,
      evidence: {
        authenticated: true,
        dashboardInteraction: "read_only_authentication",
        fileSelectionPerformed: false,
        providerMutationObserved: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-snapshot-bucket");
    expect(JSON.stringify(result)).not.toContain("profiles/xometry.tar.gz");
  });

  it("fails closed when bounded runtime evidence is ambiguous", async () => {
    const harness = operationHarness();
    harness.runCommand.mockImplementation(async (_bin, args) => {
      if (args.includes("execute")) {
        return {
          metadata: { name: "execution-1" },
          spec: { taskCount: 1 },
          status: { succeededCount: 1, failedCount: 0 },
        };
      }
      if (args[0] === "logging") return [];
      throw new Error("unexpected command");
    });
    await expect(
      harness.operations.probes.executeProbe({
        image: IMAGE,
        expectedSnapshot: { generation: "101", metageneration: "7", etag: "e" },
        expectedJobIdentity: {
          resourceVersion: "job-v1",
          configurationFingerprint: "d".repeat(64),
        },
        expectedExecutionInventory: {
          totalCount: 0,
          activeCount: 0,
          completedExecutionIds: [],
          fingerprint:
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e808b7c03261f3c790b85",
        },
      }),
    ).rejects.toThrow("probe_log_invalid");
  });
});
