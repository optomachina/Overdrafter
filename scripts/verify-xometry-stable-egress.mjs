#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
const CLOUD_COMMAND_TIMEOUT_MS = 30_000;
const IPV4_CIDR_PATTERN = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/;

function isRequiredIpv4SubnetRange(value) {
  const match = value?.match?.(IPV4_CIDR_PATTERN);
  if (!match || Number(match[2]) !== 26) return false;
  return match[1].split(".").every((octet) => Number(octet) <= 255);
}

function basename(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.split("/").findLast(Boolean) ?? null;
}

function projectFromReference(value) {
  if (typeof value !== "string") return null;
  const match = /(?:^|\/)projects\/([^/]+)(?:\/|$)/.exec(value);
  return match?.[1] ?? null;
}

function referenceMatches(value, expectedName, expectedProject) {
  if (basename(value) !== expectedName) return false;
  const referencedProject = projectFromReference(value);
  return referencedProject === null || referencedProject === expectedProject;
}

function parseNetworkInterfaces(annotations) {
  const encoded = annotations?.["run.googleapis.com/network-interfaces"];
  if (typeof encoded !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isObject(parsed[0])) {
    return null;
  }
  return parsed[0];
}

function checkCloudRunNetwork({
  annotations,
  expectedNetwork,
  expectedSubnet,
  expectedProject,
  prefix,
  failures,
}) {
  const networkInterface = parseNetworkInterfaces(annotations);
  if (networkInterface === null) {
    failures.push(`${prefix}_network_interfaces_missing_or_invalid`);
  } else {
    if (!referenceMatches(networkInterface.network, expectedNetwork, expectedProject)) {
      failures.push(`${prefix}_network_mismatch`);
    }
    if (!referenceMatches(networkInterface.subnetwork, expectedSubnet, expectedProject)) {
      failures.push(`${prefix}_subnet_mismatch`);
    }
  }

  if (annotations?.["run.googleapis.com/vpc-access-egress"] !== "all-traffic") {
    failures.push(`${prefix}_egress_not_all_traffic`);
  }
  if (annotations?.["run.googleapis.com/vpc-access-connector"] !== undefined) {
    failures.push(`${prefix}_connector_present`);
  }
}

function serviceEnvironmentValue(service, name) {
  const containers = service.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return null;
  const env = containers[0]?.env;
  if (!Array.isArray(env)) return null;
  const matches = env.filter((entry) => entry?.name === name);
  if (matches.length !== 1 || typeof matches[0].value !== "string") return null;
  return matches[0].value;
}

function serviceImage(service) {
  const containers = service.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return null;
  return containers[0]?.image ?? null;
}

function serviceHasEnvironmentName(service, name) {
  const containers = service.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return false;
  const env = containers[0]?.env;
  return Array.isArray(env) && env.some((entry) => entry?.name === name);
}

function jobImage(job) {
  const containers = job.spec?.template?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return null;
  return containers[0]?.image ?? null;
}

function jobContainer(job) {
  const containers = job.spec?.template?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return null;
  return containers[0];
}

function jobEnvironmentValue(job, name) {
  const env = jobContainer(job)?.env;
  if (!Array.isArray(env)) return null;
  const matches = env.filter((entry) => entry?.name === name);
  if (matches.length !== 1 || typeof matches[0]?.value !== "string") return null;
  return matches[0].value;
}

function jobHasEnvironmentName(job, name) {
  const env = jobContainer(job)?.env;
  return Array.isArray(env) && env.some((entry) => entry?.name === name);
}

function jobEnvironmentIsAllowlisted(job) {
  const env = jobContainer(job)?.env;
  if (!Array.isArray(env)) return false;
  const allowed = new Set([
    "WORKER_MODE",
    "WORKER_TEMP_DIR",
    "XOMETRY_BROWSER_ENGINE",
    "XOMETRY_PROFILE_SNAPSHOT_BUCKET",
    "XOMETRY_PROFILE_SNAPSHOT_OBJECT",
    "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES",
    "PLAYWRIGHT_HEADLESS",
    "PLAYWRIGHT_CAPTURE_TRACE",
    "PLAYWRIGHT_BROWSER_TIMEOUT_MS",
    "PLAYWRIGHT_DISABLE_SANDBOX",
    "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE",
  ]);
  const shapeIsAllowlisted = env.every(
    (entry) =>
      isObject(entry) &&
      typeof entry.name === "string" &&
      allowed.has(entry.name) &&
      typeof entry.value === "string" &&
      entry.valueFrom === undefined,
  );
  if (!shapeIsAllowlisted) return false;
  const requiredValues = new Map([
    ["WORKER_MODE", "simulate"],
    ["WORKER_TEMP_DIR", "/root/.cache/overdrafter-worker"],
    ["XOMETRY_BROWSER_ENGINE", "camoufox"],
    ["PLAYWRIGHT_HEADLESS", "true"],
    ["PLAYWRIGHT_BROWSER_TIMEOUT_MS", "45000"],
    ["PLAYWRIGHT_DISABLE_SANDBOX", "true"],
    ["PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", "true"],
  ]);
  for (const [name, value] of requiredValues) {
    if (jobEnvironmentValue(job, name) !== value) return false;
  }
  const traceCapture = jobEnvironmentValue(job, "PLAYWRIGHT_CAPTURE_TRACE");
  return traceCapture === null || traceCapture === "false";
}

function hasPublicMember(policy) {
  if (!isObject(policy)) return null;
  if (policy.bindings === undefined) return false;
  if (!Array.isArray(policy.bindings)) return null;
  for (const binding of policy.bindings) {
    if (!isObject(binding) || typeof binding.role !== "string") return null;
    if (!Array.isArray(binding.members)) return null;
    if (binding.members.some((member) => typeof member !== "string")) return null;
    if (
      binding.members.some(
        (member) => member === "allUsers" || member === "allAuthenticatedUsers",
      )
    ) {
      return true;
    }
  }
  return false;
}

function sameVersion(left, right, path) {
  const leftValue = path(left);
  const rightValue = path(right);
  return typeof leftValue === "string" && leftValue.length > 0 && leftValue === rightValue;
}

function sameCollectedMetadata(left, right) {
  return isObject(left) && isObject(right) && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validate the expected resource identities before they are passed to gcloud.
 * The verifier accepts names only, never a raw IP address.
 */
export function validateStableEgressExpectations(expectations) {
  if (!isObject(expectations)) return false;
  const names = [
    expectations.network,
    expectations.subnet,
    expectations.router,
    expectations.nat,
    expectations.address,
    expectations.service,
    expectations.job,
  ];
  return (
    isProjectId(expectations.project) &&
    isRegion(expectations.region) &&
    names.every((name) => isResourceName(name)) &&
    isServiceAccount(expectations.serviceAccount) &&
    /^\d+$/.test(expectations.addressId ?? "") &&
    isRequiredIpv4SubnetRange(expectations.subnetRange)
  );
}

function matchesProductionContract(expectations) {
  return Object.entries(OVD410_PRODUCTION_CONTRACT).every(
    ([key, value]) => expectations[key] === value,
  );
}

function evaluateServiceIdentity(service, expectations, failures) {
  if (service.metadata?.name !== expectations.service) failures.push("service_name_mismatch");
  if (service.metadata?.annotations?.["run.googleapis.com/invoker-iam-disabled"] === "true") {
    failures.push("service_invoker_iam_check_disabled");
  }
  checkCloudRunNetwork({
    annotations: service.spec?.template?.metadata?.annotations,
    expectedNetwork: expectations.network,
    expectedSubnet: expectations.subnet,
    expectedProject: expectations.project,
    prefix: "service",
    failures,
  });
  if (service.spec?.template?.spec?.containerConcurrency !== 1) {
    failures.push("service_concurrency_not_one");
  }
  if (service.spec?.template?.spec?.serviceAccountName !== expectations.serviceAccount) {
    failures.push("service_account_mismatch");
  }
}

function evaluateServiceRuntime(service, failures) {
  if (serviceEnvironmentValue(service, "WORKER_MODE") !== "live") {
    failures.push("service_worker_mode_not_live");
  }
  if (serviceEnvironmentValue(service, "WORKER_LIVE_ADAPTERS") !== "xometry") {
    failures.push("service_live_adapters_not_xometry_only");
  }
  if (serviceEnvironmentValue(service, "PLAYWRIGHT_CAPTURE_TRACE") !== "false") {
    failures.push("service_trace_capture_not_disabled");
  }
  const snapshotBucket = serviceEnvironmentValue(service, "XOMETRY_PROFILE_SNAPSHOT_BUCKET");
  const snapshotObject = serviceEnvironmentValue(service, "XOMETRY_PROFILE_SNAPSHOT_OBJECT");
  if (
    serviceEnvironmentValue(service, "XOMETRY_BROWSER_ENGINE") !== "camoufox" ||
    !snapshotBucket ||
    !snapshotObject ||
    !serviceEnvironmentValue(service, "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES")
  ) {
    failures.push("service_snapshot_runtime_not_bounded");
  }
  if (
    ["XOMETRY_STORAGE_STATE_JSON", "XOMETRY_STORAGE_STATE_PATH", "XOMETRY_USER_DATA_DIR"].some(
      (name) => serviceHasEnvironmentName(service, name),
    )
  ) {
    failures.push("service_legacy_profile_environment_present");
  }
  const annotations = service.spec?.template?.metadata?.annotations;
  if (annotations?.["autoscaling.knative.dev/maxScale"] !== "1") {
    failures.push("service_max_scale_not_one");
  }
  const minScale = annotations?.["autoscaling.knative.dev/minScale"];
  if (minScale !== undefined && minScale !== "0") failures.push("service_min_scale_not_zero");
}

function evaluateServiceRelease(service, failures) {
  const latestReady = service.status?.latestReadyRevisionName;
  if (typeof latestReady !== "string") failures.push("service_ready_revision_missing");
  const latestCreated = service.status?.latestCreatedRevisionName;
  if (typeof latestCreated !== "string") {
    failures.push("service_created_revision_missing");
  } else if (latestCreated !== latestReady) {
    failures.push("service_latest_revision_not_ready");
  }
  const specTraffic = service.spec?.traffic;
  if (
    !Array.isArray(specTraffic) ||
    specTraffic.length !== 1 ||
    specTraffic[0]?.latestRevision !== true ||
    specTraffic[0]?.percent !== 100
  ) {
    failures.push("service_spec_traffic_not_latest_only");
  }
  const statusTraffic = service.status?.traffic;
  if (
    !Array.isArray(statusTraffic) ||
    statusTraffic.length !== 1 ||
    statusTraffic[0]?.latestRevision !== true ||
    statusTraffic[0]?.percent !== 100 ||
    statusTraffic[0]?.revisionName !== latestReady
  ) {
    failures.push("service_status_traffic_not_ready_latest_only");
  }
  if (!isImmutableImage(serviceImage(service))) failures.push("service_image_not_immutable");
}

function evaluateServiceEvidence(service, expectations, failures) {
  if (!isObject(service)) {
    failures.push("service_metadata_invalid");
    return;
  }
  evaluateServiceIdentity(service, expectations, failures);
  evaluateServiceRuntime(service, failures);
  evaluateServiceRelease(service, failures);
}

function evaluateJobIdentity(job, expectations, failures) {
  if (job.metadata?.name !== expectations.job) failures.push("job_name_mismatch");
  checkCloudRunNetwork({
    annotations: job.spec?.template?.metadata?.annotations,
    expectedNetwork: expectations.network,
    expectedSubnet: expectations.subnet,
    expectedProject: expectations.project,
    prefix: "job",
    failures,
  });
  const taskCount = job.spec?.template?.spec?.taskCount;
  const parallelism = job.spec?.template?.spec?.parallelism;
  if (taskCount !== 1) failures.push("job_task_count_not_one");
  if (parallelism !== undefined && parallelism !== 1) failures.push("job_parallelism_not_one");
  if (job.spec?.template?.spec?.template?.spec?.maxRetries !== 0) {
    failures.push("job_max_retries_not_zero");
  }
  if (
    job.spec?.template?.spec?.template?.spec?.serviceAccountName !== expectations.serviceAccount
  ) {
    failures.push("job_service_account_mismatch");
  }
  if (!isImmutableImage(jobImage(job))) failures.push("job_image_not_immutable");
}

function evaluateJobCommand(job, failures) {
  const container = jobContainer(job);
  if (
    !Array.isArray(container?.command) ||
    container.command.length !== 1 ||
    container.command[0] !== "node" ||
    !Array.isArray(container?.args) ||
    container.args.length !== 1 ||
    container.args[0] !== "dist/tools/probeXometryProfileAuth.js"
  ) {
    failures.push("job_command_not_bounded_auth_probe");
  }
}

function evaluateJobProfile(job, service, failures) {
  if (
    jobEnvironmentValue(job, "XOMETRY_BROWSER_ENGINE") !== "camoufox" ||
    !jobEnvironmentValue(job, "XOMETRY_PROFILE_SNAPSHOT_BUCKET") ||
    !jobEnvironmentValue(job, "XOMETRY_PROFILE_SNAPSHOT_OBJECT")
  ) {
    failures.push("job_snapshot_runtime_not_bounded");
  }
  if (
    isObject(service) &&
    (jobEnvironmentValue(job, "XOMETRY_BROWSER_ENGINE") !==
      serviceEnvironmentValue(service, "XOMETRY_BROWSER_ENGINE") ||
      jobEnvironmentValue(job, "XOMETRY_PROFILE_SNAPSHOT_BUCKET") !==
        serviceEnvironmentValue(service, "XOMETRY_PROFILE_SNAPSHOT_BUCKET") ||
      jobEnvironmentValue(job, "XOMETRY_PROFILE_SNAPSHOT_OBJECT") !==
        serviceEnvironmentValue(service, "XOMETRY_PROFILE_SNAPSHOT_OBJECT") ||
      jobEnvironmentValue(job, "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES") !==
        serviceEnvironmentValue(service, "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES"))
  ) {
    failures.push("service_job_profile_runtime_mismatch");
  }
  const forbidden = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "XOMETRY_STORAGE_STATE_JSON",
    "XOMETRY_STORAGE_STATE_PATH",
    "XOMETRY_USER_DATA_DIR",
  ];
  if (forbidden.some((name) => jobHasEnvironmentName(job, name))) {
    failures.push("job_forbidden_environment_present");
  }
  if (!jobEnvironmentIsAllowlisted(job)) failures.push("job_environment_not_allowlisted");
}

function evaluateJobEvidence(job, service, expectations, failures) {
  if (!isObject(job)) {
    failures.push("job_metadata_invalid");
    return;
  }
  evaluateJobIdentity(job, expectations, failures);
  evaluateJobCommand(job, failures);
  evaluateJobProfile(job, service, failures);
}

function evaluateImageParity(service, job, failures) {
  const serviceValue = serviceImage(service);
  const jobValue = jobImage(job);
  if (
    isImmutableImage(serviceValue) &&
    isImmutableImage(jobValue) &&
    serviceValue !== jobValue
  ) {
    failures.push("service_job_image_mismatch");
  }
}

function evaluatePublicPolicy(policy, invalidCode, publicCode, failures) {
  const publicMember = hasPublicMember(policy);
  if (publicMember === null) {
    failures.push(invalidCode);
  } else if (publicMember) {
    failures.push(publicCode);
  }
}

function evaluateIamPolicies(evidence, failures) {
  evaluatePublicPolicy(
    evidence.iamPolicy,
    "service_iam_policy_invalid",
    "service_public_invocation_present",
    failures,
  );
  evaluatePublicPolicy(
    evidence.jobIamPolicy,
    "job_iam_policy_invalid",
    "job_public_execution_present",
    failures,
  );
  evaluatePublicPolicy(
    evidence.projectIamPolicy,
    "project_iam_policy_invalid",
    "project_public_principal_present",
    failures,
  );
}

function evaluateNetworkEvidence(network, expectations, failures) {
  if (!isObject(network)) {
    failures.push("network_metadata_invalid");
    return;
  }
  if (network.name !== expectations.network) failures.push("network_name_mismatch");
  if (network.autoCreateSubnetworks !== false) failures.push("network_not_custom_mode");
  if (network.routingConfig?.routingMode !== "REGIONAL") {
    failures.push("network_routing_not_regional");
  }
  if (
    !Array.isArray(network.subnetworks) ||
    network.subnetworks.length !== 1 ||
    !referenceMatches(network.subnetworks[0], expectations.subnet, expectations.project)
  ) {
    failures.push("network_subnet_inventory_mismatch");
  }
  if (
    network.peerings !== undefined &&
    (!Array.isArray(network.peerings) || network.peerings.length > 0)
  ) {
    failures.push("network_peering_present_or_invalid");
  }
}

function evaluateSubnetEvidence(subnet, expectations, failures) {
  if (!isObject(subnet)) {
    failures.push("subnet_metadata_invalid");
    return;
  }
  if (subnet.name !== expectations.subnet) failures.push("subnet_name_mismatch");
  if (!referenceMatches(subnet.network, expectations.network, expectations.project)) {
    failures.push("subnet_network_mismatch");
  }
  if (basename(subnet.region) !== expectations.region) failures.push("subnet_region_mismatch");
  if (subnet.privateIpGoogleAccess !== true) {
    failures.push("subnet_private_google_access_disabled");
  }
  if (subnet.ipCidrRange !== expectations.subnetRange) failures.push("subnet_range_mismatch");
  if (subnet.purpose !== "PRIVATE") failures.push("subnet_purpose_not_private");
  if (subnet.stackType !== "IPV4_ONLY") failures.push("subnet_not_ipv4_only");
}

function evaluateRouterEvidence(router, expectations, failures) {
  if (!isObject(router)) {
    failures.push("router_metadata_invalid");
    return;
  }
  if (router.name !== expectations.router) failures.push("router_name_mismatch");
  if (!referenceMatches(router.network, expectations.network, expectations.project)) {
    failures.push("router_network_mismatch");
  }
  if (basename(router.region) !== expectations.region) failures.push("router_region_mismatch");
  if (
    router.bgpPeers !== undefined &&
    (!Array.isArray(router.bgpPeers) || router.bgpPeers.length > 0)
  ) {
    failures.push("router_bgp_peer_present_or_invalid");
  }
}

function evaluateNatIdentity(nat, expectations, failures) {
  if (nat.name !== expectations.nat) failures.push("nat_name_mismatch");
  if (nat.natIpAllocateOption !== "MANUAL_ONLY") {
    failures.push("nat_address_allocation_not_manual");
  }
  if (
    !Array.isArray(nat.natIps) ||
    nat.natIps.length !== 1 ||
    !referenceMatches(nat.natIps[0], expectations.address, expectations.project)
  ) {
    failures.push("nat_reserved_address_mismatch");
  }
  if (nat.sourceSubnetworkIpRangesToNat !== "LIST_OF_SUBNETWORKS") {
    failures.push("nat_subnet_scope_not_explicit");
  }
}

function evaluateNatSubnet(nat, expectations, failures) {
  if (!Array.isArray(nat.subnetworks) || nat.subnetworks.length !== 1) {
    failures.push("nat_subnet_count_not_one");
    return;
  }
  const [natSubnet] = nat.subnetworks;
  if (!referenceMatches(natSubnet?.name, expectations.subnet, expectations.project)) {
    failures.push("nat_subnet_mismatch");
  }
  if (
    !Array.isArray(natSubnet?.sourceIpRangesToNat) ||
    natSubnet.sourceIpRangesToNat.length !== 1 ||
    natSubnet.sourceIpRangesToNat[0] !== "ALL_IP_RANGES"
  ) {
    failures.push("nat_subnet_range_incomplete");
  }
}

function evaluateNatSafety(nat, failures) {
  if (nat.logConfig?.enable !== true || nat.logConfig?.filter !== "ERRORS_ONLY") {
    failures.push("nat_error_logging_not_bounded");
  }
  if (
    nat.drainNatIps !== undefined &&
    (!Array.isArray(nat.drainNatIps) || nat.drainNatIps.length > 0)
  ) {
    failures.push("nat_draining_address_present_or_invalid");
  }
  if (nat.rules !== undefined && (!Array.isArray(nat.rules) || nat.rules.length > 0)) {
    failures.push("nat_rule_present_or_invalid");
  }
}

function evaluateNatEvidence(nat, expectations, failures) {
  if (!isObject(nat)) {
    failures.push("nat_metadata_invalid");
    return;
  }
  evaluateNatIdentity(nat, expectations, failures);
  evaluateNatSubnet(nat, expectations, failures);
  evaluateNatSafety(nat, failures);
}

function evaluateAddressEvidence(address, expectations, failures) {
  if (!isObject(address)) {
    failures.push("address_metadata_invalid");
    return;
  }
  if (address.name !== expectations.address) failures.push("address_name_mismatch");
  if (address.addressType !== "EXTERNAL") failures.push("address_not_external");
  if (address.ipVersion !== undefined && address.ipVersion !== "IPV4") {
    failures.push("address_not_ipv4");
  }
  if (basename(address.region) !== expectations.region) failures.push("address_region_mismatch");
  if (address.status !== "IN_USE") failures.push("address_not_in_use");
  if (address.networkTier !== "PREMIUM") failures.push("address_network_tier_not_premium");
  if (String(address.id ?? "") !== expectations.addressId) {
    failures.push("address_identity_mismatch");
  }
}

function evaluateRouteEvidence(routes, expectations, failures) {
  if (!Array.isArray(routes)) {
    failures.push("route_inventory_invalid");
    return;
  }
  if (
    routes.some(
      (route) => !referenceMatches(route?.network, expectations.network, expectations.project),
    )
  ) {
    failures.push("route_network_mismatch");
  }
  const defaultRoutes = routes.filter((route) => route?.destRange === "0.0.0.0/0");
  const subnetRoutes = routes.filter((route) => route?.destRange === expectations.subnetRange);
  if (
    routes.length !== 2 ||
    defaultRoutes.length !== 1 ||
    defaultRoutes[0]?.priority !== 1000 ||
    basename(defaultRoutes[0]?.nextHopGateway) !== "default-internet-gateway" ||
    subnetRoutes.length !== 1 ||
    subnetRoutes[0]?.priority !== 0 ||
    !referenceMatches(
      subnetRoutes[0]?.nextHopNetwork,
      expectations.network,
      expectations.project,
    )
  ) {
    failures.push("effective_route_inventory_mismatch");
  }
}

function evaluateQuiescence(evidence, expectations, failures) {
  const policyBasedRoutes = evidence.policyBasedRoutes;
  if (!Array.isArray(policyBasedRoutes)) {
    failures.push("policy_based_route_inventory_invalid");
  } else if (
    policyBasedRoutes.some((route) =>
      referenceMatches(route?.network, expectations.network, expectations.project),
    )
  ) {
    failures.push("policy_based_route_present");
  }
  if (
    !Array.isArray(evidence.natMappings) ||
    evidence.natMappings.some(
      (mapping) => !isObject(mapping) || typeof mapping.instanceName !== "string" || !mapping.instanceName,
    )
  ) {
    failures.push("nat_mapping_inventory_invalid");
  } else if (evidence.natMappings.length === 1) {
    failures.push("nat_mapping_inventory_not_quiescent");
  } else if (evidence.natMappings.length > 1) {
    failures.push("nat_mapping_inventory_multiple");
  }
  if (
    !Array.isArray(evidence.jobExecutions) ||
    evidence.jobExecutions.some(
      (execution) =>
        !isObject(execution) ||
        typeof execution.status?.completionTime !== "string" ||
        Number(execution.status?.runningCount ?? 0) !== 0,
    )
  ) {
    failures.push("job_execution_inventory_not_quiescent");
  }
}

function evaluateCollectionStability(evidence, failures) {
  if (
    !sameVersion(
      evidence.service,
      evidence.confirmService,
      (value) => value?.metadata?.resourceVersion,
    ) ||
    !sameVersion(evidence.job, evidence.confirmJob, (value) => value?.metadata?.resourceVersion) ||
    !sameCollectedMetadata(evidence.router, evidence.confirmRouter) ||
    !sameCollectedMetadata(evidence.nat, evidence.confirmNat)
  ) {
    failures.push("evidence_changed_during_collection");
  }
}

/**
 * Fail-closed evaluation of the private Cloud Run service, authentication Job,
 * custom VPC/subnet, regional router, manual-address Public NAT, and reserved
 * address. Results contain stable failure codes only; resource identifiers and
 * raw addresses are never copied into the result.
 */
export function evaluateStableEgressEvidence(evidence, expectations) {
  if (!validateStableEgressExpectations(expectations)) {
    return { ok: false, invalid: true, failures: ["invalid_expectations"] };
  }
  if (!isObject(evidence)) {
    return { ok: false, invalid: true, failures: ["invalid_evidence"] };
  }

  const failures = [];
  evaluateServiceEvidence(evidence.service, expectations, failures);
  evaluateJobEvidence(evidence.job, evidence.service, expectations, failures);
  evaluateImageParity(evidence.service, evidence.job, failures);
  evaluateIamPolicies(evidence, failures);
  evaluateNetworkEvidence(evidence.network, expectations, failures);
  evaluateSubnetEvidence(evidence.subnet, expectations, failures);
  evaluateRouterEvidence(evidence.router, expectations, failures);
  evaluateNatEvidence(evidence.nat, expectations, failures);
  evaluateAddressEvidence(evidence.address, expectations, failures);
  evaluateRouteEvidence(evidence.routes, expectations, failures);
  evaluateQuiescence(evidence, expectations, failures);
  evaluateCollectionStability(evidence, failures);
  return { ok: failures.length === 0, invalid: false, failures };
}

/**
 * Classify a sanitized verifier result without weakening the provider-ready
 * contract. A single nonempty NAT mapping inventory by itself is a pending
 * quiescence condition; it neither proves instance liveness nor establishes a
 * deployment failure or rollback trigger.
 */
export function classifyStableEgressResult(result) {
  if (
    !isObject(result) ||
    result.invalid === true ||
    typeof result.ok !== "boolean" ||
    !Array.isArray(result.failures)
  ) {
    return "invalid";
  }
  if (result.ok === true && result.failures.length === 0) {
    return "ready";
  }
  if (
    result.ok === false &&
    result.failures.length === 1 &&
    result.failures[0] === "nat_mapping_inventory_not_quiescent"
  ) {
    return "pending_nat_quiescence";
  }
  return "blocked";
}

/** Run one gcloud JSON query with a non-deferrable, bounded timeout. */
export async function runGcloudJsonCommand(
  gcloudBin,
  args,
  execute = execFileAsync,
) {
  const { stdout } = await execute(gcloudBin, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    timeout: CLOUD_COMMAND_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
}

/** Collect only the bounded read-only metadata required by the evaluator. */
export async function collectStableEgressEvidence(
  expectations,
  { gcloudBin = "gcloud", runCommand = runGcloudJsonCommand } = {},
) {
  const shared = ["--project", expectations.project];
  const regional = [...shared, "--region", expectations.region];
  const calls = {
    service: [
      "run",
      "services",
      "describe",
      expectations.service,
      ...regional,
      "--format=json(metadata.name,metadata.resourceVersion,metadata.annotations,spec.traffic,spec.template.metadata.annotations,spec.template.spec.containerConcurrency,spec.template.spec.serviceAccountName,spec.template.spec.containers,status.latestCreatedRevisionName,status.latestReadyRevisionName,status.traffic)",
    ],
    job: [
      "run",
      "jobs",
      "describe",
      expectations.job,
      ...regional,
      "--format=json(metadata.name,metadata.resourceVersion,spec.template.metadata.annotations,spec.template.spec.taskCount,spec.template.spec.parallelism,spec.template.spec.template.spec.containers,spec.template.spec.template.spec.maxRetries,spec.template.spec.template.spec.serviceAccountName)",
    ],
    iamPolicy: [
      "run",
      "services",
      "get-iam-policy",
      expectations.service,
      ...regional,
      "--format=json",
    ],
    jobIamPolicy: [
      "run",
      "jobs",
      "get-iam-policy",
      expectations.job,
      ...regional,
      "--format=json",
    ],
    projectIamPolicy: [
      "projects",
      "get-iam-policy",
      expectations.project,
      "--format=json",
    ],
    network: [
      "compute",
      "networks",
      "describe",
      expectations.network,
      ...shared,
      "--format=json(name,autoCreateSubnetworks,routingConfig.routingMode,subnetworks,peerings)",
    ],
    subnet: [
      "compute",
      "networks",
      "subnets",
      "describe",
      expectations.subnet,
      ...regional,
      "--format=json(name,network,region,ipCidrRange,privateIpGoogleAccess,purpose,stackType)",
    ],
    router: [
      "compute",
      "routers",
      "describe",
      expectations.router,
      ...regional,
      "--format=json(name,network,region,fingerprint,bgpPeers)",
    ],
    nat: [
      "compute",
      "routers",
      "nats",
      "describe",
      expectations.nat,
      "--router",
      expectations.router,
      ...regional,
      "--format=json(name,natIpAllocateOption,natIps,drainNatIps,rules,sourceSubnetworkIpRangesToNat,subnetworks,logConfig)",
    ],
    address: [
      "compute",
      "addresses",
      "describe",
      expectations.address,
      ...regional,
      "--format=json(id,name,addressType,ipVersion,networkTier,status,region)",
    ],
    routes: [
      "compute",
      "routes",
      "list",
      ...shared,
      "--filter",
      `network=${expectations.network}`,
      "--format=json(name,network,destRange,priority,nextHopGateway,nextHopNetwork,nextHopIp,nextHopInstance,nextHopVpnTunnel,nextHopIlb)",
    ],
    policyBasedRoutes: [
      "network-connectivity",
      "policy-based-routes",
      "list",
      ...shared,
      "--format=json(name,network,filter,priority,nextHopOtherRoutes,nextHopIlbIpRegion)",
    ],
    natMappings: [
      "compute",
      "routers",
      "get-nat-mapping-info",
      expectations.router,
      "--nat-name",
      expectations.nat,
      ...regional,
      "--format=json(instanceName)",
    ],
    jobExecutions: [
      "run",
      "jobs",
      "executions",
      "list",
      "--job",
      expectations.job,
      ...regional,
      "--format=json(metadata.name,status.completionTime,status.runningCount)",
    ],
  };

  const evidence = {};
  for (const [key, args] of Object.entries(calls)) {
    evidence[key] = await runCommand(gcloudBin, args);
  }
  evidence.confirmService = await runCommand(gcloudBin, calls.service);
  evidence.confirmJob = await runCommand(gcloudBin, calls.job);
  evidence.confirmRouter = await runCommand(gcloudBin, calls.router);
  evidence.confirmNat = await runCommand(gcloudBin, calls.nat);
  return evidence;
}

function expectationsFromEnv(env) {
  return {
    contractId: OVD410_PRODUCTION_CONTRACT.contractId,
    project: env.GOOGLE_CLOUD_PROJECT,
    region: env.CLOUD_RUN_REGION ?? "us-west1",
    network: env.CLOUD_RUN_NETWORK,
    subnet: env.CLOUD_RUN_SUBNET,
    subnetRange: env.CLOUD_RUN_SUBNET_RANGE,
    router: env.CLOUD_RUN_ROUTER,
    nat: env.CLOUD_RUN_NAT,
    address: env.CLOUD_RUN_NAT_ADDRESS,
    addressId: env.CLOUD_RUN_NAT_ADDRESS_ID,
    service: env.SERVICE_NAME ?? "overdrafter-cad-worker",
    job: env.XOMETRY_AUTH_PROBE_JOB_NAME ?? "overdrafter-xometry-auth-probe",
    serviceAccount: env.CLOUD_RUN_SERVICE_ACCOUNT,
  };
}

/** CLI contract: exit 0 pass, 1 control mismatch, 2 invalid or unreadable metadata. */
export async function runCli({
  env = process.env,
  output = process.stdout,
  collectEvidence = collectStableEgressEvidence,
} = {}) {
  const expectations = expectationsFromEnv(env);
  if (
    !validateStableEgressExpectations(expectations) ||
    !matchesProductionContract(expectations)
  ) {
    output.write("Stable egress verifier configuration is invalid; failing closed.\n");
    return 2;
  }

  let evidence;
  try {
    evidence = await collectEvidence(expectations, { gcloudBin: env.GCLOUD_BIN ?? "gcloud" });
  } catch {
    output.write("Stable egress metadata collection failed; failing closed.\n");
    return 2;
  }

  const result = evaluateStableEgressEvidence(evidence, expectations);
  const classification = classifyStableEgressResult(result);
  if (classification === "invalid") {
    output.write("Stable egress metadata is invalid; failing closed.\n");
    return 2;
  }
  if (classification === "pending_nat_quiescence") {
    output.write("Stable egress configuration matches; NAT mapping inventory is not yet quiescent.\n");
    output.write("Provider-facing execution remains blocked.\n");
    output.write(
      "Observe and rerun after the inventory reaches zero; do not redeploy, rescale, or roll back solely for this condition.\n",
    );
    return 1;
  }
  if (classification === "blocked") {
    output.write("Stable egress verification failed:\n");
    for (const failure of result.failures) output.write(`  - ${failure}\n`);
    output.write("Provider-facing execution remains blocked.\n");
    return 1;
  }

  output.write(
    `Stable egress verification passed; contract=${expectations.contractId}, private service, bounded Job, VPC, routes, and manual-address NAT controls match.\n`,
  );
  return 0;
}

if (isDirectCli(import.meta.url)) {
  process.exitCode = await runCli();
}
