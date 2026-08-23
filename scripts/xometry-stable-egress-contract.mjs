import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME_PATTERN = /^[a-z](?:[-a-z0-9]*[a-z0-9])?$/;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z]+-[a-z]+\d$/;
const SERVICE_ACCOUNT_PATTERN =
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const IMMUTABLE_IMAGE_PATTERN = /^\S+@sha256:[0-9a-f]{64}$/;

export const OVD410_PRODUCTION_CONTRACT = Object.freeze({
  contractId: "ovd410-production-v1",
  project: "overdrafter-worker-9133",
  region: "us-west1",
  network: "overdrafter-xometry-egress",
  subnet: "overdrafter-xometry-egress-us-west1",
  // This fixed RFC1918 range is the intentional dedicated production subnet.
  subnetRange: "10.81.0.0/26", // NOSONAR
  router: "overdrafter-xometry-egress-router",
  nat: "overdrafter-xometry-egress-nat",
  address: "overdrafter-xometry-egress-ip",
  addressId: "7266654960671511103",
  service: "overdrafter-cad-worker",
  job: "overdrafter-xometry-auth-probe",
  serviceAccount:
    "overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com",
});

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isResourceName(value) {
  return NAME_PATTERN.test(value ?? "");
}

export function isProjectId(value) {
  return PROJECT_PATTERN.test(value ?? "");
}

export function isRegion(value) {
  return REGION_PATTERN.test(value ?? "");
}

export function isServiceAccount(value) {
  return SERVICE_ACCOUNT_PATTERN.test(value ?? "");
}

export function isImmutableImage(value) {
  return IMMUTABLE_IMAGE_PATTERN.test(value ?? "");
}

export function isDirectCli(importMetaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(path.resolve(entry));
  } catch {
    return false;
  }
}
