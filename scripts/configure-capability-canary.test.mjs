import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareDisabledCapabilityCanaryDeployment, runCli } from "./configure-capability-canary.mjs";

const input = {
  project: "synthetic-project", region: "us-west1", job: "capability-canary", scheduler: "capability-canary-schedule",
  image: `us-west1-docker.pkg.dev/synthetic-project/worker/image@sha256:${"a".repeat(64)}`,
  runtimeServiceAccount: "canary-runtime@synthetic-project.iam.gserviceaccount.com",
  schedulerServiceAccount: "canary-scheduler@synthetic-project.iam.gserviceaccount.com", timeoutSeconds: 60,
};

describe("disabled capability canary deployment artifacts", () => {
  it("emits two disabled gates and a paused schedule with finite bounds and no inherited environment", () => {
    const result = prepareDisabledCapabilityCanaryDeployment(input);
    const execution = result.cloudRunJob.spec.template.spec;
    expect(execution).toMatchObject({ taskCount: 1, parallelism: 1, template: { spec: { maxRetries: 0, timeoutSeconds: 60 } } });
    expect(execution.template.spec.containers).toEqual([{
      image: input.image, command: ["node"], args: ["dist/tools/providerCapabilityCanary.js"],
      env: [{ name: "CANARY_SCHEDULE_ENABLED", value: "false" }, { name: "CANARY_TRIGGER_ENABLED", value: "false" }],
      resources: { limits: { cpu: "1", memory: "512Mi" } },
    }]);
    expect(result.schedulerTerraform.resource.google_cloud_scheduler_job.capability_canary).toMatchObject({
      paused: true, schedule: "0 * * * *", retry_config: { retry_count: 0, max_retry_duration: "0s" },
      http_target: { body: "e30=", uri: "https://run.googleapis.com/v2/projects/synthetic-project/locations/us-west1/jobs/capability-canary:run" },
      lifecycle: { prevent_destroy: true },
    });
    expect(result).toEqual(prepareDisabledCapabilityCanaryDeployment(input));
  });
  it.each([
    null, {}, { ...input, enabled: true }, { ...input, timeoutSeconds: 0 }, { ...input, timeoutSeconds: 61 },
    { ...input, timeoutSeconds: 1.5 }, { ...input, timeoutSeconds: "60" },
    { ...input, image: "worker:latest" }, { ...input, image: `${input.image}\nsecret` },
    { ...input, project: "../project" }, { ...input, job: "job:run?override=1" },
    { ...input, region: "us-west1/../../" },
    { ...input, runtimeServiceAccount: input.schedulerServiceAccount },
    { ...input, schedulerServiceAccount: "foreign@other-project.iam.gserviceaccount.com" },
  ])("rejects malformed or activation-capable config %j", (value) => {
    expect(() => prepareDisabledCapabilityCanaryDeployment(value)).toThrow("invalid_canary_deployment_configuration");
  });
  it("rejects accessors without invoking them", () => {
    const getter = vi.fn();
    const value = { ...input };
    Object.defineProperty(value, "image", { get: getter, enumerable: true });
    expect(() => prepareDisabledCapabilityCanaryDeployment(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("prints review data only from the explicit file", async () => {
    const read = vi.fn().mockResolvedValue(JSON.stringify(input));
    const write = vi.fn();
    expect(await runCli(["synthetic.json"], { read, write })).toBe(0);
    expect(read).toHaveBeenCalledExactlyOnceWith("synthetic.json", "utf8");
    expect(JSON.parse(write.mock.calls[0][0]).state).toBe("disabled_configuration");
  });
  it("runs the actual CLI without copying ambient credentials or enablement", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "canary-config-test-"));
    try {
      const file = path.join(directory, "input.json");
      writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
      const output = execFileSync(process.execPath, ["scripts/configure-capability-canary.mjs", file], {
        cwd: process.cwd(), encoding: "utf8", timeout: 3000,
        env: { CANARY_SCHEDULE_ENABLED: "true", CANARY_TRIGGER_ENABLED: "true", SUPABASE_SERVICE_ROLE_KEY: "synthetic-secret" },
      });
      expect(JSON.parse(output)).toEqual(prepareDisabledCapabilityCanaryDeployment(input));
      expect(output).not.toContain("synthetic-secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([{ args: [] }, { args: ["--apply"] }, { args: ["input.json", "--enable"] }])("has no apply or enable CLI path %j", async ({ args }) => {
    const read = vi.fn(), write = vi.fn();
    expect(await runCli(args, { read, write })).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["{" + "s".repeat(8192), "secret malformed JSON"])("does not echo malformed input", async (bytes) => {
    const write = vi.fn();
    expect(await runCli(["synthetic.json"], { read: async () => bytes, write })).toBe(2);
    expect(write).toHaveBeenCalledExactlyOnceWith('{"state":"invalid_configuration"}');
  });
});
