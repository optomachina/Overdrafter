// @vitest-environment node
// All replies are synthetic raw data. This suite imports the real prefix and
// every real interpreter; only the injected transport is supplied by the test.
import { describe, expect, it } from "vitest";
import { compatibilityFixture } from "./ovd419-acquisition-test-fixtures.mjs";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { completedExecutionFixtures, fullJobFixtures, fullServiceFixtures,
  prefixEgressFixtures } from "./ovd419-reader-test-fixtures.mjs";
import { createSyntheticAcquisitionReader, isSyntheticAcquisitionHandoff,
  SYNTHETIC_ACQUISITION_READER_CONTRACT as CONTRACT } from "./ovd419-synthetic-acquisition-reader.mjs";

function fixture({ invalidService = false } = {}) {
  const compatibility = compatibilityFixture();
  const execution = completedExecutionFixtures.fixture();
  const packet = execution.p;
  const job = fullJobFixtures.fixture().value;
  const service = fullServiceFixtures.fixture().value;
  const snapshotScope = { bucket: "fixture-bucket", object: "fixture/profile.tar.gz", maxBytes: "1000" };
  const secretReference = { name: "supabase-service-role-key", key: "latest" };
  const principal = "TEST_ONLY_operator@example.invalid";
  const snapshot = { generation: "1", metageneration: "1", etag: "TEST_ONLY" };
  packet.baseline.account = digest({ ...snapshotScope, principal });
  packet.baseline.snapshot = digest(snapshot);
  const precondition = { ...execution.precondition,
    packetSha256: digest(packet), snapshotFingerprint: packet.baseline.snapshot };
  execution.value.spec.template.spec.containers[0].env.at(-1).value =
    Buffer.from(JSON.stringify(precondition)).toString("base64url");
  job.metadata.uid = packet.baseline.job.uid;
  job.spec.template.spec.template.spec = execution.baseTask;
  job.status.latestCreatedExecution.creationTimestamp = execution.value.metadata.creationTimestamp;
  job.status.latestCreatedExecution.completionTimestamp = execution.value.status.completionTime;
  service.spec.template.spec.containers[0].env.find(item =>
    item.name === "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES").value = snapshotScope.maxBytes;
  const inventory = [{ metadata: { name: execution.value.metadata.name,
    uid: execution.value.metadata.uid, creationTimestamp: execution.value.metadata.creationTimestamp,
    labels: { "run.googleapis.com/job": TARGET.job } },
  status: { completionTime: execution.value.status.completionTime, runningCount: 0 } }];
  const egress = prefixEgressFixtures.compliantEgress();
  egress.job = job;
  egress.service = service;
  const byPrefix = new Map([
    ["run services describe", egress.service], ["run jobs describe", egress.job],
    ["run services get-iam-policy", egress.iamPolicy], ["run jobs get-iam-policy", egress.jobIamPolicy],
    ["projects get-iam-policy", egress.projectIamPolicy], ["compute networks describe", egress.network],
    ["compute networks subnets describe", egress.subnet], ["compute routers describe", egress.router],
    ["compute routers nats describe", egress.nat], ["compute addresses describe", egress.address],
    ["compute routes list", egress.routes], ["network-connectivity policy-based-routes list", egress.policyBasedRoutes],
    ["compute routers get-nat-mapping-info", egress.natMappings], ["run jobs executions list", egress.jobExecutions],
  ]);
  const calls = [];
  let responseBytes = 0;
  const transport = async request => {
    calls.push(request);
    let payload;
    if (request.id === "catalogue") payload = compatibility.input.observations[0].payload;
    else if (request.id.startsWith("containment")) payload = compatibility.input.observations[1].payload;
    else if (request.id.startsWith("IAM")) payload = JSON.stringify({ includedPermissions: ["run.jobs.get", "run.executions.list"] });
    else if (request.id.startsWith("principal")) payload = JSON.stringify([{ account: principal, status: "ACTIVE" }]);
    else if (request.id.startsWith("snapshot")) payload = JSON.stringify(snapshot);
    else if (request.id.startsWith("secretVersion")) payload = JSON.stringify({
      name: "projects/123456789/secrets/supabase-service-role-key/versions/1", state: "ENABLED" });
    else if (request.id.startsWith("fullJob")) payload = JSON.stringify(job);
    else if (request.id.startsWith("fullService")) {
      const value = structuredClone(service);
      if (invalidService) value.status.conditions.find(item => item.type === "Ready").status = "False";
      payload = JSON.stringify(value);
    } else if (request.id.startsWith("fullInventory")) payload = JSON.stringify(inventory);
    else if (request.id.startsWith("completedExecution")) payload = JSON.stringify(execution.value);
    else if (request.id === "closingE13") payload = "[]";
    else {
      const match = [...byPrefix].find(([prefix]) => request.args.join(" ").startsWith(prefix));
      if (!match) throw new Error(`TEST_ONLY unexpected request: ${request.id}`);
      payload = JSON.stringify(match[1]);
    }
    const response = JSON.stringify({ schema: CONTRACT.responseSchema, mode: "TEST_ONLY", id: request.id,
      sequence: request.sequence, requestSha256: request.requestSha256, provenance: request.provenance,
      complete: true, settled: true, isError: false, payload });
    responseBytes += Buffer.byteLength(response);
    return response;
  };
  const reader = createSyntheticAcquisitionReader({ transport, packet, projectNumber: "123456789",
    snapshotScope, secretReference, qualification: { mode: "TEST_ONLY",
      acquisitionSourceCommit: compatibility.qualification.acquisitionSourceCommit,
      inputManifestSha256: compatibility.qualification.inputManifestSha256,
      invocationId: "TEST_ONLY_real_reader" } });
  return { reader, calls, get responseBytes() { return responseBytes; } };
}

describe("whole synthetic acquisition with real validators", () => {
  it("accepts raw synthetic resources through the real prefix and retains the exact closing plan", async () => {
    const f = fixture();
    const result = await f.reader.read();
    expect(result).toMatchObject({ completeAcquisitionQualified: true,
      transportQualified: false, privateBindingReady: false,
      usage: { calls: 37, cloudCalls: 34, sqlCalls: 3, receivedBytes: f.responseBytes } });
    expect(isSyntheticAcquisitionHandoff(result)).toBe(true);
    expect(isSyntheticAcquisitionHandoff({ ...result })).toBe(false);
    expect(f.calls.map(request => request.sequence)).toEqual([...Array(37).keys()]);
    expect(f.calls.filter(request => ["catalogue", "containmentOpening", "E13",
      "containmentClosing", "closingE13"].includes(request.id)).map(({ id, sequence, requestSha256 }) =>
      ({ id, sequence, requestSha256 }))).toEqual(compatibilityFixture().input.observations.map(
      ({ id, sequence, requestSha256 }) => ({ id, sequence, requestSha256 })));
    expect(f.calls.slice(21).map(request => request.id)).toEqual([
      "principalOpening", "snapshotOpening", "secretVersionOpening", "principalClosing",
      "snapshotClosing", "secretVersionClosing", "containmentClosing", "fullJobPass1",
      "fullServicePass1", "fullInventoryPass1", "completedExecutionPass1", "fullJobPass2",
      "fullServicePass2", "fullInventoryPass2", "completedExecutionPass2", "closingE13",
    ]);
    await expect(f.reader.read()).rejects.toThrow("acquisition_request_budget_exhausted");
    expect(f.calls).toHaveLength(37);
  });

  it("rejects a complete attributable but semantically unready full Service", async () => {
    const f = fixture({ invalidService: true });
    await expect(f.reader.read()).rejects.toThrow("acquisition_full_service_rejected");
    expect(f.calls.at(-1).id).toBe("fullServicePass1");
    expect(f.calls).toHaveLength(30);
    await expect(f.reader.read()).rejects.toThrow("acquisition_request_budget_exhausted");
    expect(f.calls).toHaveLength(30);
  });
});
