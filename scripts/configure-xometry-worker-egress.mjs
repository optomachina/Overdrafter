#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  isDirectCli,
  isImmutableImage,
  isObject,
  isProjectId,
  isRegion,
  isResourceName,
  isServiceAccount,
  OVD410_PRODUCTION_CONTRACT,
} from "./xometry-stable-egress-contract.mjs";

const execFileAsync = promisify(execFile);
const CLOUD_READ_TIMEOUT_MS = 30_000;
const CLOUD_MUTATION_TIMEOUT_MS = 10 * 60_000;

function environmentValue(container, name) {
  if (!Array.isArray(container.env)) return null;
  const matches = container.env.filter((entry) => entry?.name === name);
  if (matches.length !== 1 || typeof matches[0]?.value !== "string") return null;
  return matches[0].value;
}

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
  delete result.annotations?.["run.googleapis.com/ingress-status"];
  delete result.annotations?.["run.googleapis.com/operation-id"];
  delete result.annotations?.["run.googleapis.com/urls"];
  delete result.annotations?.["serving.knative.dev/creator"];
  delete result.annotations?.["serving.knative.dev/lastModifier"];
  return result;
}

/**
 * Build a configuration-only Cloud Run service manifest from the current live
 * service. The existing image and non-network configuration are preserved;
 * server-managed metadata is removed before replacement. The resource version
 * is deliberately retained so Cloud Run rejects a stale replace instead of
 * overwriting a concurrent service update.
 */
export function buildWorkerEgressManifest(service, expectations, { clearNetwork = false } = {}) {
  if (
    !isObject(service) ||
    !isObject(service.spec) ||
    service.apiVersion !== "serving.knative.dev/v1" ||
    service.kind !== "Service" ||
    service.metadata?.name !== expectations.service ||
    typeof service.metadata?.resourceVersion !== "string" ||
    service.metadata.resourceVersion.length === 0
  ) {
    throw new Error("current service metadata is invalid");
  }
  const containers = service.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) {
    throw new Error("current service container contract is invalid");
  }
  if (!isImmutableImage(containers[0]?.image)) {
    throw new Error("current service image is not immutable");
  }
  const template = service.spec.template;
  const currentAnnotations = template.metadata?.annotations;
  const [currentContainer] = containers;
  const minScale = currentAnnotations?.["autoscaling.knative.dev/minScale"];
  if (
    !clearNetwork &&
    (
      template.spec?.containerConcurrency !== 1 ||
      template.spec?.serviceAccountName !== expectations.serviceAccount ||
      (minScale !== undefined && minScale !== "0") ||
      currentAnnotations?.["autoscaling.knative.dev/maxScale"] !== "1" ||
      currentAnnotations?.["run.googleapis.com/cpu-throttling"] !== "false" ||
      currentAnnotations?.["run.googleapis.com/execution-environment"] !== "gen2" ||
      environmentValue(currentContainer, "WORKER_MODE") !== "live" ||
      environmentValue(currentContainer, "WORKER_LIVE_ADAPTERS") !== "xometry" ||
      environmentValue(currentContainer, "PLAYWRIGHT_CAPTURE_TRACE") !== "false" ||
      service.metadata?.annotations?.["run.googleapis.com/invoker-iam-disabled"] ===
        "true"
    )
  ) {
    throw new Error("current service safety contract is invalid");
  }

  const manifest = {
    apiVersion: service.apiVersion ?? "serving.knative.dev/v1",
    kind: service.kind ?? "Service",
    metadata: sanitizeMetadata(service.metadata),
    spec: structuredClone(service.spec),
  };
  delete manifest.spec.template.metadata?.name;
  manifest.metadata.name = expectations.service;
  manifest.metadata.labels ??= {};
  manifest.metadata.labels["cloud.googleapis.com/location"] = expectations.region;
  const manifestTemplate = manifest.spec.template;
  manifestTemplate.metadata ??= {};
  manifestTemplate.metadata.annotations ??= {};
  const annotations = manifestTemplate.metadata.annotations;
  delete annotations["run.googleapis.com/vpc-access-connector"];
  if (clearNetwork) {
    delete annotations["run.googleapis.com/network-interfaces"];
    delete annotations["run.googleapis.com/vpc-access-egress"];
  } else {
    annotations["run.googleapis.com/network-interfaces"] = JSON.stringify([
      { network: expectations.network, subnetwork: expectations.subnet },
    ]);
    annotations["run.googleapis.com/vpc-access-egress"] = "all-traffic";
  }
  return manifest;
}

function expectationsFromEnv(env) {
  return {
    project: env.GOOGLE_CLOUD_PROJECT,
    region: env.CLOUD_RUN_REGION ?? "us-west1",
    service: env.SERVICE_NAME ?? "overdrafter-cad-worker",
    serviceAccount: env.CLOUD_RUN_SERVICE_ACCOUNT,
    network: env.CLOUD_RUN_NETWORK,
    subnet: env.CLOUD_RUN_SUBNET,
    vpcEgress: env.CLOUD_RUN_VPC_EGRESS,
  };
}

function validateExpectations(expectations, clearNetwork) {
  const baseValid =
    isProjectId(expectations.project) &&
    isRegion(expectations.region) &&
    isResourceName(expectations.service) &&
    isServiceAccount(expectations.serviceAccount);
  if (!baseValid) return false;
  const productionIdentityMatches =
    expectations.project === OVD410_PRODUCTION_CONTRACT.project &&
    expectations.region === OVD410_PRODUCTION_CONTRACT.region &&
    expectations.service === OVD410_PRODUCTION_CONTRACT.service &&
    expectations.serviceAccount === OVD410_PRODUCTION_CONTRACT.serviceAccount;
  if (!productionIdentityMatches) return false;
  if (clearNetwork) return true;
  return (
    expectations.network === OVD410_PRODUCTION_CONTRACT.network &&
    expectations.subnet === OVD410_PRODUCTION_CONTRACT.subnet &&
    expectations.vpcEgress === "all-traffic"
  );
}

async function defaultDescribeService(expectations, gcloudBin) {
  const { stdout } = await execFileAsync(
    gcloudBin,
    [
      "run",
      "services",
      "describe",
      expectations.service,
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

async function defaultReplaceService(manifest, expectations, gcloudBin) {
  const directory = await mkdtemp(
    path.join(homedir(), ".overdrafter-worker-egress-"),
  );
  const manifestPath = path.join(directory, "service.json");
  try {
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await execFileAsync(
      gcloudBin,
      [
        "run",
        "services",
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

/** CLI contract: exit 0 configured, 1 invalid input or cloud failure. */
export async function runCli({
  args = process.argv.slice(2),
  env = process.env,
  output = process.stdout,
  describeService = defaultDescribeService,
  replaceService = defaultReplaceService,
} = {}) {
  const clearNetwork = args.length === 1 && args[0] === "--clear-network";
  if (args.length > 0 && !clearNetwork) {
    output.write("Worker egress configuration arguments are invalid; failing closed.\n");
    return 1;
  }
  const expectations = expectationsFromEnv(env);
  if (!validateExpectations(expectations, clearNetwork)) {
    output.write("Worker egress configuration is invalid; failing closed.\n");
    return 1;
  }

  let mutationStarted = false;
  try {
    const service = await describeService(expectations, env.GCLOUD_BIN ?? "gcloud");
    const manifest = buildWorkerEgressManifest(service, expectations, { clearNetwork });
    mutationStarted = true;
    await replaceService(manifest, expectations, env.GCLOUD_BIN ?? "gcloud");
  } catch {
    output.write(
      mutationStarted
        ? "Worker egress mutation outcome is unknown; run the stable-egress verifier before retrying.\n"
        : "Worker egress configuration failed; provider execution remains blocked.\n",
    );
    return 1;
  }

  output.write(
    clearNetwork
      ? "Worker Direct VPC egress was cleared while preserving the current service configuration.\n"
      : "Worker Direct VPC egress was configured with bounded controls preserved.\n",
  );
  return 0;
}

if (isDirectCli(import.meta.url)) process.exitCode = await runCli();
