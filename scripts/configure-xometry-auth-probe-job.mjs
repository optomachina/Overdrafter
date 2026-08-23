#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  isDirectCli,
  isImmutableImage,
  isObject,
  OVD410_PRODUCTION_CONTRACT,
} from "./xometry-stable-egress-contract.mjs";

const execFileAsync = promisify(execFile);
const CLOUD_READ_TIMEOUT_MS = 30_000;
const CLOUD_MUTATION_TIMEOUT_MS = 10 * 60_000;

function sanitizeMetadata(metadata) {
  const result = structuredClone(metadata ?? {});
  for (const key of [
    "creationTimestamp",
    "deletionGracePeriodSeconds",
    "deletionTimestamp",
    "generation",
    "managedFields",
    "ownerReferences",
    "selfLink",
    "uid",
  ]) {
    delete result[key];
  }
  delete result.annotations?.["run.googleapis.com/creator"];
  delete result.annotations?.["run.googleapis.com/lastModifier"];
  return result;
}

function snapshotEnvironment(expectations) {
  return [
    { name: "WORKER_MODE", value: "simulate" },
    { name: "WORKER_TEMP_DIR", value: "/root/.cache/overdrafter-worker" },
    { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
    { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: expectations.snapshotBucket },
    { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: expectations.snapshotObject },
    {
      name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES",
      value: expectations.snapshotMaxBytes,
    },
    { name: "PLAYWRIGHT_HEADLESS", value: "true" },
    { name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" },
    { name: "PLAYWRIGHT_BROWSER_TIMEOUT_MS", value: "45000" },
    { name: "PLAYWRIGHT_DISABLE_SANDBOX", value: "true" },
    { name: "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", value: "true" },
  ];
}

/**
 * Build a configuration-only authentication Job manifest. The live resource
 * version is retained so Cloud Run rejects a stale replacement.
 */
export function buildAuthProbeJobManifest(
  job,
  expectations,
  { clearNetwork = false } = {},
) {
  if (
    !isObject(job) ||
    job.apiVersion !== "run.googleapis.com/v1" ||
    job.kind !== "Job" ||
    job.metadata?.name !== expectations.job ||
    typeof job.metadata?.resourceVersion !== "string" ||
    job.metadata.resourceVersion.length === 0 ||
    !isObject(job.spec)
  ) {
    throw new Error("current authentication Job metadata is invalid");
  }
  const containers = job.spec?.template?.spec?.template?.spec?.containers;
  if (
    !Array.isArray(containers) ||
    containers.length !== 1 ||
    !isImmutableImage(containers[0]?.image)
  ) {
    throw new Error("current authentication Job container contract is invalid");
  }

  const manifest = {
    apiVersion: job.apiVersion,
    kind: job.kind,
    metadata: sanitizeMetadata(job.metadata),
    spec: structuredClone(job.spec),
  };
  manifest.metadata.name = expectations.job;
  manifest.metadata.labels ??= {};
  manifest.metadata.labels["cloud.googleapis.com/location"] = expectations.region;
  const template = manifest.spec.template;
  template.metadata ??= {};
  template.metadata.annotations ??= {};
  delete template.metadata.name;
  delete template.metadata.annotations["run.googleapis.com/vpc-access-connector"];

  if (clearNetwork) {
    delete template.metadata.annotations["run.googleapis.com/network-interfaces"];
    delete template.metadata.annotations["run.googleapis.com/vpc-access-egress"];
    return manifest;
  }

  template.metadata.annotations["run.googleapis.com/network-interfaces"] = JSON.stringify([
    { network: expectations.network, subnetwork: expectations.subnet },
  ]);
  template.metadata.annotations["run.googleapis.com/vpc-access-egress"] = "all-traffic";
  template.spec.taskCount = 1;
  template.spec.parallelism = 1;
  const executionSpec = template.spec.template.spec;
  executionSpec.maxRetries = 0;
  executionSpec.serviceAccountName = expectations.serviceAccount;
  const [container] = executionSpec.containers;
  container.command = ["node"];
  container.args = ["dist/tools/probeXometryProfileAuth.js"];
  container.env = snapshotEnvironment(expectations);
  return manifest;
}

function expectationsFromEnv(env) {
  return {
    project: env.GOOGLE_CLOUD_PROJECT,
    region: env.CLOUD_RUN_REGION ?? "us-west1",
    job: env.XOMETRY_AUTH_PROBE_JOB_NAME ?? "overdrafter-xometry-auth-probe",
    serviceAccount: env.CLOUD_RUN_SERVICE_ACCOUNT,
    network: env.CLOUD_RUN_NETWORK,
    subnet: env.CLOUD_RUN_SUBNET,
    vpcEgress: env.CLOUD_RUN_VPC_EGRESS,
    snapshotBucket: env.XOMETRY_PROFILE_SNAPSHOT_BUCKET,
    snapshotObject: env.XOMETRY_PROFILE_SNAPSHOT_OBJECT,
    snapshotMaxBytes: env.XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES ?? "268435456",
  };
}

function validateExpectations(expectations, clearNetwork) {
  if (
    expectations.project !== OVD410_PRODUCTION_CONTRACT.project ||
    expectations.region !== OVD410_PRODUCTION_CONTRACT.region ||
    expectations.job !== OVD410_PRODUCTION_CONTRACT.job ||
    expectations.serviceAccount !== OVD410_PRODUCTION_CONTRACT.serviceAccount
  ) {
    return false;
  }
  if (clearNetwork) return true;
  return (
    expectations.network === OVD410_PRODUCTION_CONTRACT.network &&
    expectations.subnet === OVD410_PRODUCTION_CONTRACT.subnet &&
    expectations.vpcEgress === "all-traffic" &&
    typeof expectations.snapshotBucket === "string" &&
    expectations.snapshotBucket.length > 0 &&
    !expectations.snapshotBucket.includes(",") &&
    typeof expectations.snapshotObject === "string" &&
    expectations.snapshotObject.length > 0 &&
    !expectations.snapshotObject.includes(",") &&
    /^[1-9]\d*$/.test(expectations.snapshotMaxBytes)
  );
}

async function defaultDescribeJob(expectations, gcloudBin) {
  const { stdout } = await execFileAsync(
    gcloudBin,
    [
      "run",
      "jobs",
      "describe",
      expectations.job,
      "--project",
      expectations.project,
      "--region",
      expectations.region,
      "--format=json",
    ],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: CLOUD_READ_TIMEOUT_MS,
    },
  );
  return JSON.parse(stdout);
}

async function defaultReplaceJob(manifest, expectations, gcloudBin) {
  const directory = await mkdtemp(
    path.join(homedir(), ".overdrafter-auth-job-egress-"),
  );
  const manifestPath = path.join(directory, "job.json");
  try {
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await execFileAsync(
      gcloudBin,
      [
        "run",
        "jobs",
        "replace",
        manifestPath,
        "--project",
        expectations.project,
        "--region",
        expectations.region,
        "--quiet",
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: CLOUD_MUTATION_TIMEOUT_MS,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** CLI contract: exit 0 configured, 1 invalid/failure/ambiguous mutation. */
export async function runCli({
  args = process.argv.slice(2),
  env = process.env,
  output = process.stdout,
  describeJob = defaultDescribeJob,
  replaceJob = defaultReplaceJob,
} = {}) {
  const clearNetwork = args.length === 1 && args[0] === "--clear-network";
  if (args.length > 0 && !clearNetwork) {
    output.write("Authentication Job configuration arguments are invalid; failing closed.\n");
    return 1;
  }
  const expectations = expectationsFromEnv(env);
  if (!validateExpectations(expectations, clearNetwork)) {
    output.write("Authentication Job configuration is invalid; failing closed.\n");
    return 1;
  }

  let mutationStarted = false;
  try {
    const job = await describeJob(expectations, env.GCLOUD_BIN ?? "gcloud");
    const manifest = buildAuthProbeJobManifest(job, expectations, { clearNetwork });
    mutationStarted = true;
    await replaceJob(manifest, expectations, env.GCLOUD_BIN ?? "gcloud");
  } catch {
    output.write(
      mutationStarted
        ? "Authentication Job mutation outcome is unknown; run the stable-egress verifier before retrying.\n"
        : "Authentication Job configuration failed; provider execution remains blocked.\n",
    );
    return 1;
  }

  output.write(
    clearNetwork
      ? "Authentication Job Direct VPC egress was cleared while preserving current configuration.\n"
      : "Authentication Job Direct VPC egress and bounded probe contract were configured.\n",
  );
  return 0;
}

if (isDirectCli(import.meta.url)) process.exitCode = await runCli();
