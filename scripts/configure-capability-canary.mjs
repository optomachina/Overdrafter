#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const KEYS = ["project", "region", "job", "scheduler", "image", "runtimeServiceAccount", "schedulerServiceAccount", "timeoutSeconds"];
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const IMAGE = /^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

function valid(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== KEYS.length
    || !KEYS.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && "value" in descriptor && descriptor.enumerable;
    })) return false;
  const account = (value) => typeof value === "string"
    && new RegExp(`^[a-z][a-z0-9-]{4,28}[a-z0-9]@${input.project}\\.iam\\.gserviceaccount\\.com$`).test(value);
  return typeof input.project === "string" && PROJECT.test(input.project)
    && typeof input.region === "string" && /^[a-z]+-[a-z]+[0-9]$/.test(input.region)
    && [input.job, input.scheduler].every((value) => typeof value === "string" && NAME.test(value))
    && typeof input.image === "string" && input.image.length <= 512 && IMAGE.test(input.image)
    && account(input.runtimeServiceAccount) && account(input.schedulerServiceAccount)
    && input.runtimeServiceAccount !== input.schedulerServiceAccount
    && Number.isSafeInteger(input.timeoutSeconds) && input.timeoutSeconds >= 1 && input.timeoutSeconds <= 60;
}

/** Pure review artifacts only: never installs, enables, executes, or changes IAM. */
export function prepareDisabledCapabilityCanaryDeployment(input) {
  if (!valid(input)) throw new Error("invalid_canary_deployment_configuration");
  return {
    state: "disabled_configuration",
    cloudRunJob: {
      apiVersion: "run.googleapis.com/v1", kind: "Job",
      metadata: { name: input.job, namespace: input.project, labels: { "cloud.googleapis.com/location": input.region } },
      spec: { template: { spec: { taskCount: 1, parallelism: 1, template: { spec: {
        maxRetries: 0, timeoutSeconds: input.timeoutSeconds, serviceAccountName: input.runtimeServiceAccount,
        containers: [{ image: input.image, command: ["node"], args: ["dist/tools/providerCapabilityCanary.js"],
          env: [{ name: "CANARY_SCHEDULE_ENABLED", value: "false" }, { name: "CANARY_TRIGGER_ENABLED", value: "false" }],
          resources: { limits: { cpu: "1", memory: "512Mi" } },
        }],
      } } } } },
    },
    // REST state is output-only. Terraform's paused property expresses desired state.
    schedulerTerraform: { resource: { google_cloud_scheduler_job: { capability_canary: {
      project: input.project, region: input.region, name: input.scheduler,
      description: "OVD-415 capability canary; separate operator authorization required",
      paused: true, schedule: "0 * * * *", time_zone: "Etc/UTC", attempt_deadline: "15s",
      retry_config: { retry_count: 0, max_retry_duration: "0s" },
      http_target: { http_method: "POST",
        uri: `https://run.googleapis.com/v2/projects/${input.project}/locations/${input.region}/jobs/${input.job}:run`,
        headers: { "Content-Type": "application/json" }, body: "e30=",
        oauth_token: { service_account_email: input.schedulerServiceAccount, scope: "https://www.googleapis.com/auth/cloud-platform" },
      },
      lifecycle: { prevent_destroy: true },
    } } } },
  };
}

export async function runCli(args, { read = readFile, write = console.log } = {}) {
  if (args.length !== 1 || args[0].startsWith("-")) {
    write(JSON.stringify({ state: "invalid_configuration" }));
    return 2;
  }
  try {
    const bytes = await read(args[0], "utf8");
    if (bytes.length > 8192) throw new Error("oversize");
    write(JSON.stringify(prepareDisabledCapabilityCanaryDeployment(JSON.parse(bytes)), null, 2));
    return 0;
  } catch {
    write(JSON.stringify({ state: "invalid_configuration" }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
