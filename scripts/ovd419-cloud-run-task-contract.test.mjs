import { describe, expect, it } from "vitest";
import { validateOvd419ProbeTaskContract } from "./ovd419-cloud-run-task-contract.mjs";
import { manifestFixture, packet } from "./ovd419-diagnostic-test-fixtures.mjs";
import { digest } from "./ovd419-job-diagnostic.mjs";

function fixture() {
  const p = packet();
  const task = manifestFixture(p).spec.template.spec.template.spec;
  return { p, task };
}

describe("shared OVD-419 probe task contract", () => {
  it("returns a frozen credential-free projection and exact task fingerprint", () => {
    const { p, task } = fixture();
    const result = validateOvd419ProbeTaskContract(task, p);
    expect(result).toEqual({
      schema: "OVD419-PROBE-TASK-CONTRACT-NOT-AUTHORITY-v1",
      image: p.baselineImage,
      snapshotScope: { bucket: "fixture-bucket", object: "fixture/profile.tar.gz", maxBytes: "1000" },
      resources: { cpu: p.limits.cpu, memory: p.limits.memory, taskSeconds: p.limits.taskSeconds, retries: 0 },
      taskFingerprint: digest(task),
      privateBindingReady: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshotScope)).toBe(true);
    expect(Object.isFrozen(result.resources)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("WORKER_MODE");
  });

  it("accepts environment reordering while retaining the exact representation fingerprint", () => {
    const first = fixture(), second = fixture();
    second.task.containers[0].env.reverse();
    const one = validateOvd419ProbeTaskContract(first.task, first.p);
    const two = validateOvd419ProbeTaskContract(second.task, second.p);
    expect(two.snapshotScope).toEqual(one.snapshotScope);
    expect(two.resources).toEqual(one.resources);
    expect(two.taskFingerprint).not.toBe(one.taskFingerprint);
  });

  it.each([
    ["unknown task field", task => { task.volumes = []; }],
    ["two containers", task => { task.containers.push(structuredClone(task.containers[0])); }],
    ["wrong service account", task => { task.serviceAccountName = "TEST_ONLY@example.invalid"; }],
    ["retry", task => { task.maxRetries = 1; }],
    ["timeout", task => { task.timeoutSeconds = "901"; }],
    ["unknown container field", task => { task.containers[0].ports = []; }],
    ["container name", task => { task.containers[0].name = "TEST_ONLY"; }],
    ["image", task => { task.containers[0].image = "TEST_ONLY"; }],
    ["command", task => { task.containers[0].command = ["sh"]; }],
    ["argument", task => { task.containers[0].args.push("TEST_ONLY"); }],
    ["resources", task => { task.containers[0].resources.limits.cpu = "16"; }],
    ["unknown environment", task => { task.containers[0].env.push({ name: "TEST_ONLY", value: "TEST_ONLY" }); }],
    ["duplicate environment", task => { task.containers[0].env.push(structuredClone(task.containers[0].env[0])); }],
    ["environment secret reference", task => { task.containers[0].env[0].valueFrom = { secretKeyRef: { name: "TEST_ONLY", key: "1" } }; }],
    ["invalid snapshot object", task => { task.containers[0].env.find(entry => entry.name === "XOMETRY_PROFILE_SNAPSHOT_OBJECT").value = "bad*glob"; }],
  ])("rejects %s with one fixed error", (_, mutate) => {
    const { p, task } = fixture();
    mutate(task);
    expect(() => validateOvd419ProbeTaskContract(task, p)).toThrow(/^cloud_run_task_contract_rejected$/);
  });
});
