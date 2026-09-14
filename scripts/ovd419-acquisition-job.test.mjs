import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSyntheticFullJob } from "./ovd419-acquisition-job.mjs";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";

import { fullJobFixtures } from "./ovd419-reader-test-fixtures.mjs";
const { fixture, PROJECT_NUMBER } = fullJobFixtures;

describe("synthetic full Job acquisition contract", () => {
  it("returns exact bytes and a deeply frozen non-authority projection", () => {
    const { p, value, raw, options } = fixture();
    const task = value.spec.template.spec.template.spec;
    const result = validateSyntheticFullJob(raw, options);
    expect(result).toEqual({
      schema: "OVD419-SYNTHETIC-FULL-JOB-NOT-AUTHORITY-v1",
      kind: "job",
      raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      projection: {
        identity: { name: TARGET.job, uid: value.metadata.uid, generation: 7,
          resourceVersion: value.metadata.resourceVersion, projectNumber: PROJECT_NUMBER },
        image: p.baselineImage,
        snapshotScope: { bucket: "fixture-bucket", object: "fixture/profile.tar.gz", maxBytes: "1000" },
        resources: { cpu: p.limits.cpu, memory: p.limits.memory, taskSeconds: p.limits.taskSeconds, retries: 0 },
        taskFingerprint: digest(task),
        configurationFingerprint: digest({ name: TARGET.job, spec: value.spec }),
        statusFingerprint: digest(value.status),
        latestCompletedExecution: {
          name: `${TARGET.job}-test-only`, createdAt: "2026-09-10T15:01:00.000Z",
          completedAt: "2026-09-10T15:02:00.000Z", completionStatus: "EXECUTION_FAILED",
        },
        executionCount: 20,
      },
      transportQualified: false,
      fullAcquisitionQualified: false,
      privateBindingReady: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projection)).toBe(true);
    expect(Object.isFrozen(result.projection.identity)).toBe(true);
    expect(JSON.stringify(result.projection)).not.toContain("TEST_ONLY_operator");
  });

  it("allows source-defined metadata variants without using them as authority", () => {
    const { value, options } = fixture();
    value.metadata.annotations = {
      "run.googleapis.com/execution-environment": "gen2",
      "run.googleapis.com/launch-stage": "GA",
    };
    value.spec.template.metadata.labels = { "cloud.googleapis.com/location": TARGET.region };
    value.spec.template.spec.template.spec.containers[0].env.reverse();
    expect(validateSyntheticFullJob(JSON.stringify(value), options).privateBindingReady).toBe(false);
  });

  it.each([
    ["root", value => { value.unknown = true; }],
    ["metadata", value => { value.metadata.unknown = true; }],
    ["root annotation", value => { value.metadata.annotations.TEST_ONLY = "TEST_ONLY"; }],
    ["root label", value => { value.metadata.labels.TEST_ONLY = "TEST_ONLY"; }],
    ["spec", value => { value.spec.unknown = true; }],
    ["execution template", value => { value.spec.template.unknown = true; }],
    ["execution spec", value => { value.spec.template.spec.unknown = true; }],
    ["task template metadata absent from observed shape", value => { value.spec.template.spec.template.metadata = {}; }],
    ["task", value => { value.spec.template.spec.template.spec.unknown = true; }],
    ["container name absent from observed shape", value => { value.spec.template.spec.template.spec.containers[0].name = "worker"; }],
    ["status", value => { value.status.unknown = true; }],
    ["condition", value => { value.status.conditions[0].unknown = true; }],
    ["latest execution", value => { value.status.latestCreatedExecution.unknown = true; }],
  ])("rejects an unsupported %s field", (_, mutate) => {
    const { value, options } = fixture(); mutate(value);
    expect(() => validateSyntheticFullJob(JSON.stringify(value), options)).toThrow(/^acquisition_full_job_rejected$/);
  });

  it.each([
    ["api version", value => { value.apiVersion = "serving.knative.dev/v1"; }],
    ["kind", value => { value.kind = "Service"; }],
    ["name", value => { value.metadata.name = "TEST_ONLY"; }],
    ["namespace", value => { value.metadata.namespace = "987654321"; }],
    ["self link", value => { value.metadata.selfLink += "-other"; }],
    ["generation", value => { value.metadata.generation = 0; }],
    ["observed generation", value => { value.status.observedGeneration = 6; }],
    ["task count", value => { value.spec.template.spec.taskCount = 2; }],
    ["parallelism", value => { value.spec.template.spec.parallelism = 2; }],
    ["missing condition", value => { value.status.conditions = []; }],
    ["duplicate condition", value => { value.status.conditions.push({ ...value.status.conditions[0] }); }],
    ["condition state", value => { value.status.conditions[0].status = "TEST_ONLY"; }],
    ["execution count", value => { value.status.executionCount = -1; }],
    ["latest name", value => { value.status.latestCreatedExecution.name = "foreign-job-test-only"; }],
    ["latest active", value => { delete value.status.latestCreatedExecution.completionTimestamp; }],
    ["latest time order", value => { value.status.latestCreatedExecution.completionTimestamp = "2026-09-10T15:00:00.000Z"; }],
  ])("rejects inconsistent %s", (_, mutate) => {
    const { value, options } = fixture(); mutate(value);
    expect(() => validateSyntheticFullJob(JSON.stringify(value), options)).toThrow(/^acquisition_full_job_rejected$/);
  });

  it("rejects duplicate decoded JSON fields, malformed input and excess bytes", () => {
    const { value, options } = fixture();
    const ordinary = JSON.stringify(value);
    for (const raw of [
      ordinary.replace('"kind":"Job"', '"kind":"Job","k\\u0069nd":"Job"'),
      "not-json",
      "null",
      `${ordinary}${" ".repeat(4194304)}`,
    ]) expect(() => validateSyntheticFullJob(raw, options)).toThrow(/^acquisition_full_job_rejected$/);
  });

  it("rejects unknown options, production mode and invalid project-number binding", () => {
    const { raw, options } = fixture();
    for (const invalid of [undefined, {}, { ...options, mode: "PRODUCTION" },
      { ...options, trusted: true }, { ...options, projectNumber: "overdrafter-worker-9133" }]) {
      expect(() => validateSyntheticFullJob(raw, invalid)).toThrow(/^acquisition_full_job_rejected$/);
    }
  });
});
