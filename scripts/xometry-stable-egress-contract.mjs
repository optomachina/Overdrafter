import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveStableEgressOptionalAdapters,
  readProviderRegistrySync,
} from "./provider-registry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_REGISTRY = readProviderRegistrySync(REPO_ROOT);

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

export const OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS = 1200;

/**
 * Generic-dispatch adapters that may share the governed egress, only alongside
 * the registry's required stable-NAT adapter and in this canonical order.
 * Their dispatch stays default-deny in the database until each is admitted.
 */
export const STABLE_EGRESS_OPTIONAL_ADAPTERS = Object.freeze(
  deriveStableEgressOptionalAdapters(PROVIDER_REGISTRY),
);

/**
 * Exact WORKER_LIVE_ADAPTERS values the stable-egress worker may carry:
 * `xometry` followed by any canonical-order subset of the optional adapters.
 * deploy-cloud-run.sh derives the same canonical value from the adapters it
 * enabled (pinned by contract test).
 */
export const STABLE_EGRESS_LIVE_ADAPTER_VALUES = Object.freeze(
  Array.from({ length: 2 ** STABLE_EGRESS_OPTIONAL_ADAPTERS.length }, (_, mask) =>
    ["xometry", ...STABLE_EGRESS_OPTIONAL_ADAPTERS.filter((_, index) => mask & (1 << index))].join(","),
  ),
);

/**
 * Exact HTTPS hosts a generic-portal adapter on the stable egress may reach.
 * The worker's portal kernel aborts every other request, so these must equal
 * the adapter's production portal definition (pinned by contract test).
 * Xometry and Fictiv are bespoke adapters with their own origin checks.
 */
export const STABLE_EGRESS_PROVIDER_HOSTS = Object.freeze({
  quickparts: Object.freeze(["quickparts.com", "quickquote.quickparts.com", "services.qpinternal.com"]),
  weerg: Object.freeze(["www.weerg.com"]),
});

export function isStableEgressLiveAdapterValue(value) {
  return STABLE_EGRESS_LIVE_ADAPTER_VALUES.includes(value);
}

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

export { isEntryPoint as isDirectCli } from "./lib/entry-point.mjs";
