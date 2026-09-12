import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSyntheticCompletedExecution } from "./ovd419-acquisition-execution.mjs";
import { manifestFixture, packet } from "./ovd419-diagnostic-test-fixtures.mjs";
import { compareCodeUnits, digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";

const PROJECT_NUMBER = "123456789";
const EXECUTION = `${TARGET.job}-test-only`;
const EXECUTION_UID = "TEST_ONLY-execution-uid";
const MODULE_BYTES = Buffer.from("export const TEST_ONLY = true;\n");

function fixture() {
  const p = packet();
  p.artifacts.runtimeModule.sha256 = createHash("sha256").update(MODULE_BYTES).digest("hex");
  const baseTask = structuredClone(manifestFixture(p).spec.template.spec.template.spec);
  baseTask.containers[0].env.push({ name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" });
  const precondition = {
    project: TARGET.project, region: TARGET.region, job: TARGET.job,
    packetSha256: digest(p), runtimeModuleSha256: p.artifacts.runtimeModule.sha256,
    expiresAt: p.expiresAt, snapshotFingerprint: p.baseline.snapshot,
    jobIdentity: { uid: p.baseline.job.uid, generation: 2,
      configurationFingerprint: p.candidateConfiguration },
    executionInventory: { totalCount: p.baseline.inventory.length,
      fingerprint: digest([...p.baseline.inventory].sort(compareCodeUnits)) },
  };
  const realizedTask = structuredClone(baseTask);
  realizedTask.containers[0].args = ["--input-type=module", "-e",
    `await import("data:text/javascript;base64,${MODULE_BYTES.toString("base64")}")`];
  realizedTask.containers[0].env.push({ name: "OVD419_EXPECTED_PRECONDITIONS_B64",
    value: Buffer.from(JSON.stringify(precondition)).toString("base64url") });
  const filter = `resource.type="cloud_run_job"\nresource.labels.job_name="${TARGET.job}"\nresource.labels.location="${TARGET.region}"\nlabels."run.googleapis.com/execution_name"="${EXECUTION}"`;
  const log = new URL("https://console.cloud.google.com/logs/viewer");
  log.searchParams.set("project", TARGET.project);
  log.searchParams.set("advancedFilter", filter);
  const value = {
    apiVersion: "run.googleapis.com/v1", kind: "Execution",
    metadata: {
      annotations: {
        "run.googleapis.com/network-interfaces": JSON.stringify([{ network: NETWORK.network, subnetwork: NETWORK.subnet }]),
        "run.googleapis.com/vpc-access-egress": "all-traffic",
        "run.googleapis.com/execution-environment": "gen2",
        "run.googleapis.com/client-name": "gcloud",
        "run.googleapis.com/client-version": "581.0.0",
        "run.googleapis.com/operation-id": "12345678-1234-1234-1234-123456789abc",
        "run.googleapis.com/creator": "TEST_ONLY_operator@example.invalid",
        "run.googleapis.com/lastModifier": "TEST_ONLY_operator@example.invalid",
      },
      creationTimestamp: "2026-09-10T16:00:00.000000001Z", generation: 1,
      labels: {
        "cloud.googleapis.com/location": TARGET.region,
        "run.googleapis.com/job": TARGET.job,
        "run.googleapis.com/jobGeneration": "2",
        "run.googleapis.com/jobResourceVersion": "TEST_ONLY-j2",
        "run.googleapis.com/jobUid": p.baseline.job.uid,
        "run.googleapis.com/satisfiesPzs": "true",
      },
      name: EXECUTION, namespace: PROJECT_NUMBER,
      ownerReferences: [{ apiVersion: "run.googleapis.com/v1", blockOwnerDeletion: true,
        controller: true, kind: "Job", name: TARGET.job, uid: p.baseline.job.uid }],
      resourceVersion: "TEST_ONLY-e1",
      selfLink: `/apis/run.googleapis.com/v1/namespaces/${PROJECT_NUMBER}/executions/${EXECUTION}`,
      uid: EXECUTION_UID,
    },
    spec: { parallelism: 1, taskCount: 1, template: { spec: realizedTask } },
    status: {
      completionTime: "2026-09-10T16:02:00.000000004Z",
      conditions: [
        { lastTransitionTime: "2026-09-10T16:00:10.000000002Z", message: "Resources available",
          status: "True", type: "ResourcesAvailable" },
        { lastTransitionTime: "2026-09-10T16:00:20.000000002Z", message: "Execution started",
          status: "True", type: "Started" },
        { lastTransitionTime: "2026-09-10T16:00:30.000000002Z", message: "Container ready",
          status: "True", type: "ContainerReady" },
        { lastTransitionTime: "2026-09-10T16:02:00.000000003Z", message: "Task failed",
          reason: "NonZeroExitCode", status: "False", type: "Completed" },
      ],
      failedCount: 1, logUri: log.href, observedGeneration: 1,
      startTime: "2026-09-10T16:00:20.000000001Z",
    },
  };
  return { p, baseTask, precondition, value, raw: JSON.stringify(value, null, 2),
    options: { mode: "TEST_ONLY", packet: p, projectNumber: PROJECT_NUMBER,
      selected: { name: EXECUTION, uid: EXECUTION_UID } } };
}

describe("synthetic completed Execution acquisition contract", () => {
  it("returns exact bytes and a deeply frozen primitive-only projection", () => {
    const { p, baseTask, precondition, value, raw, options } = fixture();
    const result = validateSyntheticCompletedExecution(raw, options);
    expect(result).toEqual({
      schema: "OVD419-SYNTHETIC-COMPLETED-EXECUTION-NOT-AUTHORITY-v1",
      kind: "execution", raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      projection: {
        identity: { name: EXECUTION, uid: EXECUTION_UID, generation: 1,
          resourceVersion: "TEST_ONLY-e1", projectNumber: PROJECT_NUMBER },
        ownerJob: { name: TARGET.job, uid: p.baseline.job.uid, generation: 2,
          resourceVersion: "TEST_ONLY-j2" },
        image: p.baselineImage,
        snapshotScope: { bucket: "fixture-bucket", object: "fixture/profile.tar.gz", maxBytes: "1000" },
        resources: { cpu: p.limits.cpu, memory: p.limits.memory,
          taskSeconds: p.limits.taskSeconds, retries: 0 },
        taskFingerprint: digest(baseTask),
        invocationFingerprint: digest(value.spec.template.spec),
        preconditionFingerprint: digest(precondition),
        runtimeModuleSha256: p.artifacts.runtimeModule.sha256,
        configurationFingerprint: digest({ name: EXECUTION, spec: value.spec }),
        statusFingerprint: digest(value.status), failedCount: 1,
        createdAt: value.metadata.creationTimestamp, startedAt: value.status.startTime,
        completedAt: value.status.completionTime, logUri: value.status.logUri,
        logUriFingerprint: digest(value.status.logUri),
      },
      transportQualified: false, fullAcquisitionQualified: false, privateBindingReady: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projection)).toBe(true);
    expect(Object.isFrozen(result.projection.snapshotScope)).toBe(true);
    expect(JSON.stringify(result.projection)).not.toContain("OVD419_EXPECTED_PRECONDITIONS_B64");
    expect(JSON.stringify(result.projection)).not.toContain(MODULE_BYTES.toString("base64"));
  });

  it("accepts condition and environment ordering while fingerprints preserve it", () => {
    const first = fixture(), second = fixture();
    second.value.status.conditions.reverse();
    second.value.spec.template.spec.containers[0].env.reverse();
    const one = validateSyntheticCompletedExecution(JSON.stringify(first.value), first.options);
    const two = validateSyntheticCompletedExecution(JSON.stringify(second.value), second.options);
    expect(two.projection.taskFingerprint).not.toBe(one.projection.taskFingerprint);
    expect(two.projection.statusFingerprint).not.toBe(one.projection.statusFingerprint);
    expect(two.projection.ownerJob).toEqual(one.projection.ownerJob);
  });

  it("accepts an observed empty optional condition message and baseline Job configuration", () => {
    const { p, value, options } = fixture();
    value.status.conditions.find(item => item.type === "ContainerReady").message = "";
    const entry = value.spec.template.spec.containers[0].env.at(-1);
    const decoded = JSON.parse(Buffer.from(entry.value, "base64url").toString("utf8"));
    decoded.jobIdentity.configurationFingerprint = p.baseline.job.configuration;
    entry.value = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    expect(validateSyntheticCompletedExecution(JSON.stringify(value), options).projection.failedCount).toBe(1);
  });

  it("binds the producer snapshot digest directly and rejects the former double hash", () => {
    const valid = fixture();
    const normalizedSnapshot = { generation: "1", metageneration: "1", etag: "TEST_ONLY" };
    valid.options.packet.baseline.snapshot = digest(normalizedSnapshot);
    const validEntry = valid.value.spec.template.spec.containers[0].env.at(-1);
    const validPrecondition = JSON.parse(Buffer.from(validEntry.value, "base64url").toString("utf8"));
    validPrecondition.snapshotFingerprint = digest(normalizedSnapshot);
    validPrecondition.packetSha256 = digest(valid.options.packet);
    validEntry.value = Buffer.from(JSON.stringify(validPrecondition)).toString("base64url");
    expect(validateSyntheticCompletedExecution(JSON.stringify(valid.value), valid.options)
      .projection.preconditionFingerprint).toBe(digest(validPrecondition));

    const invalid = fixture();
    const invalidEntry = invalid.value.spec.template.spec.containers[0].env.at(-1);
    const invalidPrecondition = JSON.parse(Buffer.from(invalidEntry.value, "base64url").toString("utf8"));
    invalidPrecondition.snapshotFingerprint = digest(invalid.options.packet.baseline.snapshot);
    invalidEntry.value = Buffer.from(JSON.stringify(invalidPrecondition)).toString("base64url");
    expect(() => validateSyntheticCompletedExecution(JSON.stringify(invalid.value), invalid.options))
      .toThrow(/^acquisition_completed_execution_rejected$/);
  });

  it("rejects noncanonical or nonrestrictive log filters", () => {
    const mutations = [
      filter => filter.replace('resource.type="cloud_run_job"', 'resource.type!="cloud_run_job"'),
      filter => `NOT ${filter}`,
      filter => `${filter}\nOR resource.type="gce_instance"`,
      filter => `${filter}\nresource.type="cloud_run_job"`,
      filter => filter.split("\n").slice(1).join("\n"),
      filter => [filter.split("\n")[1], filter.split("\n")[0], ...filter.split("\n").slice(2)].join("\n"),
      filter => `${filter}\r`,
      filter => `${filter}\u0000`,
      filter => filter.replace(TARGET.job, `${TARGET.job}-other`),
      filter => filter.replace(TARGET.region, "us-east1"),
      filter => filter.replace(EXECUTION, `${EXECUTION}-other`),
    ];
    for (const mutate of mutations) {
      const { value, options } = fixture();
      const log = new URL(value.status.logUri);
      log.searchParams.set("advancedFilter", mutate(log.searchParams.get("advancedFilter")));
      value.status.logUri = log.href;
      expect(() => validateSyntheticCompletedExecution(JSON.stringify(value), options))
        .toThrow(/^acquisition_completed_execution_rejected$/);
    }
  });

  it.each([
    ["root", value => { value.unknown = true; }],
    ["metadata", value => { value.metadata.unknown = true; }],
    ["annotation", value => { value.metadata.annotations.TEST_ONLY = "TEST_ONLY"; }],
    ["label", value => { value.metadata.labels.TEST_ONLY = "TEST_ONLY"; }],
    ["owner", value => { value.metadata.ownerReferences[0].unknown = true; }],
    ["spec", value => { value.spec.unknown = true; }],
    ["template", value => { value.spec.template.unknown = true; }],
    ["task", value => { value.spec.template.spec.unknown = true; }],
    ["container", value => { value.spec.template.spec.containers[0].unknown = true; }],
    ["environment", value => { value.spec.template.spec.containers[0].env[0].unknown = true; }],
    ["resources", value => { value.spec.template.spec.containers[0].resources.unknown = true; }],
    ["limits", value => { value.spec.template.spec.containers[0].resources.limits.gpu = "1"; }],
    ["status", value => { value.status.unknown = true; }],
    ["condition", value => { value.status.conditions[0].unknown = true; }],
  ])("rejects an unsupported %s field", (_, mutate) => {
    const { value, options } = fixture(); mutate(value);
    expect(() => validateSyntheticCompletedExecution(JSON.stringify(value), options))
      .toThrow(/^acquisition_completed_execution_rejected$/);
  });

  it.each([
    ["apiVersion", value => { value.apiVersion = "serving.knative.dev/v1"; }],
    ["kind", value => { value.kind = "Job"; }],
    ["name", value => { value.metadata.name += "-other"; }],
    ["uid", value => { value.metadata.uid = "other"; }],
    ["namespace", value => { value.metadata.namespace = "987654321"; }],
    ["selfLink", value => { value.metadata.selfLink += "-other"; }],
    ["generation", value => { value.metadata.generation = 0; }],
    ["owner API", value => { value.metadata.ownerReferences[0].apiVersion = "v1"; }],
    ["owner name", value => { value.metadata.ownerReferences[0].name = "other"; }],
    ["owner UID", value => { value.metadata.ownerReferences[0].uid = "other"; value.metadata.labels["run.googleapis.com/jobUid"] = "other"; }],
    ["owner controller", value => { value.metadata.ownerReferences[0].controller = false; }],
    ["job label", value => { value.metadata.labels["run.googleapis.com/job"] = "other"; }],
    ["job generation label", value => { value.metadata.labels["run.googleapis.com/jobGeneration"] = "0"; }],
    ["network", value => { value.metadata.annotations["run.googleapis.com/network-interfaces"] = "[]"; }],
    ["parallelism", value => { value.spec.parallelism = 2; }],
    ["taskCount", value => { value.spec.taskCount = 2; }],
    ["containers", value => { value.spec.template.spec.containers.push(structuredClone(value.spec.template.spec.containers[0])); }],
    ["command", value => { value.spec.template.spec.containers[0].command[0] = "sh"; }],
    ["args", value => { value.spec.template.spec.containers[0].args[0] = "-e"; }],
    ["module", value => { value.spec.template.spec.containers[0].args[2] = 'await import("data:text/javascript;base64,VEVTVA==")'; }],
    ["extra env", value => { value.spec.template.spec.containers[0].env.push({ name: "TEST_ONLY", value: "TEST_ONLY" }); }],
    ["precondition duplicate", value => { value.spec.template.spec.containers[0].env.push(structuredClone(value.spec.template.spec.containers[0].env.at(-1))); }],
    ["image", value => { value.spec.template.spec.containers[0].image = "TEST_ONLY"; }],
    ["account", value => { value.spec.template.spec.serviceAccountName = "TEST_ONLY@example.invalid"; }],
    ["failed count", value => { value.status.failedCount = 2; }],
    ["observed generation", value => { value.status.observedGeneration = 2; }],
    ["start before creation", value => { value.status.startTime = "2026-09-10T15:59:59Z"; }],
    ["completion before start", value => { value.status.completionTime = "2026-09-10T16:00:19Z"; }],
    ["missing condition", value => { value.status.conditions.pop(); }],
    ["duplicate condition", value => { value.status.conditions[1].type = value.status.conditions[0].type; }],
    ["Completed status", value => { value.status.conditions.find(x => x.type === "Completed").status = "True"; }],
    ["Completed reason", value => { delete value.status.conditions.find(x => x.type === "Completed").reason; }],
    ["foreign log", value => { value.status.logUri = "https://example.invalid/log"; }],
    ["normalized log", value => { value.status.logUri = `\n${value.status.logUri}`; }],
  ])("rejects inconsistent %s", (_, mutate) => {
    const { value, options } = fixture(); mutate(value);
    expect(() => validateSyntheticCompletedExecution(JSON.stringify(value), options))
      .toThrow(/^acquisition_completed_execution_rejected$/);
  });

  it.each([
    ["annotation operation ID", value => { value.metadata.annotations["run.googleapis.com/operation-id"] = ["12345678-1234-1234-1234-123456789abc"]; }],
    ["job generation", value => { value.metadata.labels["run.googleapis.com/jobGeneration"] = ["2"]; }],
    ["job resource version", value => { value.metadata.labels["run.googleapis.com/jobResourceVersion"] = ["TEST_ONLY-j2"]; }],
    ["condition type", value => { value.status.conditions[0].type = ["ResourcesAvailable"]; }],
    ["condition message", value => { value.status.conditions[0].message = ["Resources available"]; }],
    ["log URI", value => { value.status.logUri = [value.status.logUri]; }],
    ["precondition encoding", value => { value.spec.template.spec.containers[0].env.at(-1).value = [value.spec.template.spec.containers[0].env.at(-1).value]; }],
    ["module encoding", value => { value.spec.template.spec.containers[0].args[2] = [value.spec.template.spec.containers[0].args[2]]; }],
  ])("rejects nonprimitive %s values", (_, mutate) => {
    const { value, options } = fixture(); mutate(value);
    expect(() => validateSyntheticCompletedExecution(JSON.stringify(value), options))
      .toThrow(/^acquisition_completed_execution_rejected$/);
  });

  it("rejects paired invalid option and resource bindings", () => {
    const cases = [
      ({ value, options }) => { options.selected.name = [EXECUTION]; value.metadata.name = [EXECUTION]; },
      ({ value, options }) => { options.selected.uid = [EXECUTION_UID]; value.metadata.uid = [EXECUTION_UID]; },
      ({ value, options }) => { options.projectNumber = [PROJECT_NUMBER]; value.metadata.namespace = [PROJECT_NUMBER]; },
      ({ value, options }) => { options.packet.baseline.job.uid = ["job-uid"]; value.metadata.ownerReferences[0].uid = ["job-uid"]; value.metadata.labels["run.googleapis.com/jobUid"] = ["job-uid"]; },
      ({ options }) => { options.packet.artifacts.runtimeModule.sha256 = ["a".repeat(64)]; },
      ({ options }) => { options.packet.candidateConfiguration = ["b".repeat(64)]; },
      ({ value, options }) => { options.packet.limits.taskSeconds = [600]; value.spec.template.spec.timeoutSeconds = "600"; },
    ];
    for (const mutate of cases) {
      const f = fixture(); mutate(f);
      expect(() => validateSyntheticCompletedExecution(JSON.stringify(f.value), f.options))
        .toThrow(/^acquisition_completed_execution_rejected$/);
    }
  });

  it("rejects mismatched decoded preconditions and noncanonical encodings", () => {
    const mutations = [
      p => { p.project = "other"; }, p => { p.packetSha256 = "a".repeat(64); },
      p => { p.snapshotFingerprint = p.snapshotFingerprint.startsWith("a")
        ? "b".repeat(64) : "a".repeat(64); }, p => { p.jobIdentity.generation = 3; },
      p => { p.jobIdentity.configurationFingerprint = "c".repeat(64); },
      p => { p.executionInventory.totalCount = 2; },
      p => { p.executionInventory.fingerprint = "a".repeat(64); }, p => { p.unknown = true; },
    ];
    for (const mutate of mutations) {
      const { value, options } = fixture();
      const entry = value.spec.template.spec.containers[0].env.at(-1);
      const decoded = JSON.parse(Buffer.from(entry.value, "base64url").toString("utf8"));
      mutate(decoded); entry.value = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      expect(() => validateSyntheticCompletedExecution(JSON.stringify(value), options))
        .toThrow(/^acquisition_completed_execution_rejected$/);
    }
    const f = fixture(); f.value.spec.template.spec.containers[0].env.at(-1).value += "=";
    expect(() => validateSyntheticCompletedExecution(JSON.stringify(f.value), f.options))
      .toThrow(/^acquisition_completed_execution_rejected$/);
    const duplicate = fixture();
    const entry = duplicate.value.spec.template.spec.containers[0].env.at(-1);
    const text = Buffer.from(entry.value, "base64url").toString("utf8")
      .replace('"project":', `"project":"${TARGET.project}","projec\\u0074":`);
    entry.value = Buffer.from(text).toString("base64url");
    expect(() => validateSyntheticCompletedExecution(JSON.stringify(duplicate.value), duplicate.options))
      .toThrow(/^acquisition_completed_execution_rejected$/);
  });

  it("rejects duplicate decoded fields, malformed input and excess bytes", () => {
    const { value, options } = fixture(); const raw = JSON.stringify(value);
    for (const input of [raw.replace('"kind":"Execution"', '"kind":"Execution","k\\u0069nd":"Execution"'),
      "not-json", "null", `${raw}${" ".repeat(4194304)}`]) {
      expect(() => validateSyntheticCompletedExecution(input, options))
        .toThrow(/^acquisition_completed_execution_rejected$/);
    }
  });

  it("rejects wrong mode, unknown options and malformed selections", () => {
    const { raw, options } = fixture();
    for (const invalid of [undefined, {}, { ...options, mode: "PRODUCTION" },
      { ...options, trusted: true }, { ...options, selected: { name: EXECUTION } }]) {
      expect(() => validateSyntheticCompletedExecution(raw, invalid))
        .toThrow(/^acquisition_completed_execution_rejected$/);
    }
  });
});
