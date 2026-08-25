#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  isDirectCli,
  isImmutableImage,
  isObject,
  isProjectId,
  isRegion,
  isResourceName,
  isServiceAccount,
} from "./xometry-stable-egress-contract.mjs";
import { OVD410_RECOVERY_HOST_CONTRACT } from "./xometry-recovery-host-contract.mjs";
import { evaluateSnapshotBucketControls } from "./verify-snapshot-bucket-controls.mjs";
import {
  collectStableEgressEvidence,
  evaluateStableEgressEvidence,
} from "./verify-xometry-stable-egress.mjs";

const execFileAsync = promisify(execFile);
const CLOUD_COMMAND_TIMEOUT_MS = 30_000;
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const ZONE_PATTERN = /^[a-z]+-[a-z]+\d-[a-z]$/;

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

function exactly(values, expected) {
  return (
    Array.isArray(values) &&
    values.length === expected.length &&
    expected.every((value) => values.includes(value))
  );
}

function absentOrEmpty(value) {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function serviceImage(service) {
  const containers = service?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return null;
  return containers[0]?.image ?? null;
}

function serviceEnvironmentValue(service, name) {
  const containers = service?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return null;
  const env = containers[0]?.env;
  if (!Array.isArray(env)) return null;
  const matches = env.filter((entry) => entry?.name === name);
  if (matches.length !== 1 || typeof matches[0]?.value !== "string") return null;
  return matches[0].value;
}

function imageMatchesRepository(image, expectations) {
  if (!isImmutableImage(image)) return false;
  const [host, project, repository] = image.split("/");
  return (
    host === `${expectations.region}-docker.pkg.dev` &&
    project === expectations.project &&
    repository === expectations.artifactRepository
  );
}

function metadataMap(instance) {
  const items = instance?.metadata?.items;
  if (!Array.isArray(items)) return null;
  const entries = new Map();
  for (const item of items) {
    if (
      !isObject(item) ||
      typeof item.key !== "string" ||
      typeof item.value !== "string" ||
      entries.has(item.key)
    ) {
      return null;
    }
    entries.set(item.key, item.value);
  }
  return entries;
}

function policyBindings(policy) {
  if (!isObject(policy)) return null;
  if (policy.bindings === undefined) return [];
  if (!Array.isArray(policy.bindings)) return null;
  for (const binding of policy.bindings) {
    if (
      !isObject(binding) ||
      typeof binding.role !== "string" ||
      !Array.isArray(binding.members) ||
      binding.members.some((member) => typeof member !== "string")
    ) {
      return null;
    }
  }
  return policy.bindings;
}

function hasPublicMember(bindings) {
  return bindings.some((binding) =>
    binding.members.some(
      (member) => member === "allUsers" || member === "allAuthenticatedUsers",
    ),
  );
}

/** Validate fixed recovery-host expectations before any gcloud lookup. */
export function validateRecoveryHostExpectations(expectations) {
  if (!isObject(expectations)) return false;
  return (
    isProjectId(expectations.project) &&
    isRegion(expectations.region) &&
    ZONE_PATTERN.test(expectations.zone ?? "") &&
    expectations.zone.startsWith(`${expectations.region}-`) &&
    [
      expectations.network,
      expectations.subnet,
      expectations.router,
      expectations.nat,
      expectations.address,
      expectations.service,
      expectations.job,
      expectations.instance,
      expectations.machineType,
      expectations.hostLicense,
      expectations.artifactRepository,
      expectations.firewallRule,
      expectations.networkTag,
    ].every((value) => isResourceName(value)) &&
    isServiceAccount(expectations.serviceAccount) &&
    isServiceAccount(expectations.recoveryServiceAccount) &&
    /^roles\/[A-Za-z0-9_.]+$/.test(expectations.recoveryRole ?? "") &&
    /^\d+$/.test(expectations.addressId ?? "") &&
    expectations.iapSourceRange === OVD410_RECOVERY_HOST_CONTRACT.iapSourceRange &&
    expectations.iapService === "iap.googleapis.com" &&
    ["granted", "revoked"].includes(expectations.snapshotAccessPhase) &&
    typeof expectations.startupScript === "string" &&
    expectations.startupScript.startsWith("scripts/") &&
    !expectations.startupScript.includes("..")
  );
}

function matchesProductionContract(expectations) {
  return Object.entries(OVD410_RECOVERY_HOST_CONTRACT).every(
    ([key, value]) => expectations[key] === value,
  );
}

function evaluateInstanceNetwork(instance, expectations, failures) {
  const interfaces = instance.networkInterfaces;
  if (!Array.isArray(interfaces) || interfaces.length !== 1) {
    failures.push("recovery_instance_network_interface_count_invalid");
    return;
  }
  const [networkInterface] = interfaces;
  if (!referenceMatches(networkInterface?.network, expectations.network, expectations.project)) {
    failures.push("recovery_instance_network_mismatch");
  }
  if (!referenceMatches(networkInterface?.subnetwork, expectations.subnet, expectations.project)) {
    failures.push("recovery_instance_subnet_mismatch");
  }
  if (!absentOrEmpty(networkInterface?.accessConfigs)) {
    failures.push("recovery_instance_external_address_present");
  }
  if (!absentOrEmpty(networkInterface?.ipv6AccessConfigs)) {
    failures.push("recovery_instance_external_ipv6_present");
  }
  if (!absentOrEmpty(networkInterface?.aliasIpRanges)) {
    failures.push("recovery_instance_alias_range_present");
  }
  if (networkInterface?.stackType !== "IPV4_ONLY") {
    failures.push("recovery_instance_not_ipv4_only");
  }
}

function evaluateInstanceRuntime(instance, service, startupScriptSource, expectations, failures) {
  const image = serviceImage(service);
  const metadata = metadataMap(instance);
  if (metadata === null) {
    failures.push("recovery_instance_metadata_invalid");
    return;
  }
  const expectedMetadataKeys = [
    "block-project-ssh-keys",
    "enable-oslogin",
    "ovd410-worker-image",
    "serial-port-enable",
    "startup-script",
  ];
  if (!exactly([...metadata.keys()], expectedMetadataKeys)) {
    failures.push("recovery_instance_metadata_scope_invalid");
  }
  if (metadata.get("enable-oslogin") !== "TRUE") {
    failures.push("recovery_instance_os_login_disabled");
  }
  if (metadata.get("block-project-ssh-keys") !== "TRUE") {
    failures.push("recovery_instance_project_ssh_keys_not_blocked");
  }
  if (metadata.get("serial-port-enable") !== "FALSE") {
    failures.push("recovery_instance_serial_port_not_disabled");
  }
  if (!isImmutableImage(image) || metadata.get("ovd410-worker-image") !== image) {
    failures.push("recovery_instance_worker_image_mismatch");
  }
  if (!imageMatchesRepository(image, expectations)) {
    failures.push("recovery_instance_worker_repository_mismatch");
  }
  if (
    typeof startupScriptSource !== "string" ||
    startupScriptSource.length === 0 ||
    metadata.get("startup-script") !== startupScriptSource
  ) {
    failures.push("recovery_instance_startup_script_mismatch");
  }
}

function evaluateInstanceIdentity(instance, expectations, failures) {
  if (!isObject(instance)) {
    failures.push("recovery_instance_metadata_invalid");
    return;
  }
  if (instance.name !== expectations.instance) failures.push("recovery_instance_name_mismatch");
  if (basename(instance.zone) !== expectations.zone) failures.push("recovery_instance_zone_mismatch");
  if (basename(instance.machineType) !== expectations.machineType) {
    failures.push("recovery_instance_machine_type_mismatch");
  }
  if (instance.status !== "RUNNING") failures.push("recovery_instance_not_running");
  if (instance.canIpForward !== false) failures.push("recovery_instance_ip_forwarding_enabled");
  if (instance.deletionProtection !== false) {
    failures.push("recovery_instance_deletion_protection_enabled");
  }
  if (!exactly(instance.tags?.items, [expectations.networkTag])) {
    failures.push("recovery_instance_network_tag_mismatch");
  }
  if (
    !isObject(instance.labels) ||
    instance.labels["ovd410-purpose"] !== "xometry-auth-recovery" ||
    instance.labels["ovd410-contract"] !== "recovery-host-v1" ||
    Object.keys(instance.labels).length !== 2
  ) {
    failures.push("recovery_instance_labels_mismatch");
  }
  if (!absentOrEmpty(instance.guestAccelerators)) {
    failures.push("recovery_instance_accelerator_present");
  }
  if (!absentOrEmpty(instance.resourcePolicies)) {
    failures.push("recovery_instance_resource_policy_present");
  }
}

function evaluateInstanceSecurity(instance, expectations, failures) {
  const shielded = instance.shieldedInstanceConfig;
  if (
    shielded?.enableSecureBoot !== true ||
    shielded?.enableVtpm !== true ||
    shielded?.enableIntegrityMonitoring !== true
  ) {
    failures.push("recovery_instance_shielded_controls_invalid");
  }
  if (instance.confidentialInstanceConfig?.enableConfidentialCompute === true) {
    failures.push("recovery_instance_unexpected_confidential_runtime");
  }
  const scheduling = instance.scheduling;
  if (
    scheduling?.automaticRestart !== false ||
    scheduling?.onHostMaintenance !== "TERMINATE" ||
    scheduling?.preemptible !== expectations.preemptible ||
    scheduling?.provisioningModel !== expectations.provisioningModel ||
    (scheduling?.instanceTerminationAction ?? null) !== expectations.instanceTerminationAction
  ) {
    failures.push("recovery_instance_scheduling_invalid");
  }
  if (
    !Array.isArray(instance.disks) ||
    instance.disks.length !== 1 ||
    instance.disks[0]?.boot !== true ||
    instance.disks[0]?.autoDelete !== true ||
    instance.disks[0]?.mode !== "READ_WRITE" ||
    !exactly(
      instance.disks[0]?.licenses?.map((license) => basename(license)),
      [expectations.hostLicense],
    )
  ) {
    failures.push("recovery_instance_boot_disk_invalid");
  }
  const serviceAccounts = instance.serviceAccounts;
  if (
    !Array.isArray(serviceAccounts) ||
    serviceAccounts.length !== 1 ||
    serviceAccounts[0]?.email !== expectations.recoveryServiceAccount ||
    !exactly(serviceAccounts[0]?.scopes, [CLOUD_PLATFORM_SCOPE])
  ) {
    failures.push("recovery_instance_service_account_invalid");
  }
}

function evaluateInstanceEvidence(evidence, expectations, failures) {
  const { instance } = evidence;
  evaluateInstanceIdentity(instance, expectations, failures);
  if (!isObject(instance)) return;
  evaluateInstanceNetwork(instance, expectations, failures);
  evaluateInstanceRuntime(
    instance,
    evidence.stable?.service,
    evidence.startupScriptSource,
    expectations,
    failures,
  );
  evaluateInstanceSecurity(instance, expectations, failures);
}

function evaluateInstanceInventory(evidence, expectations, failures) {
  if (!Array.isArray(evidence.instanceInventory)) {
    failures.push("recovery_instance_inventory_invalid");
    return;
  }
  const matching = evidence.instanceInventory.filter((instance) =>
    instance?.networkInterfaces?.some(
      (networkInterface) =>
        referenceMatches(
          networkInterface?.network,
          expectations.network,
          expectations.project,
        ) ||
        referenceMatches(
          networkInterface?.subnetwork,
          expectations.subnet,
          expectations.project,
        ),
    ),
  );
  if (
    matching.length !== 1 ||
    matching[0]?.name !== expectations.instance ||
    basename(matching[0]?.zone) !== expectations.zone
  ) {
    failures.push("recovery_instance_inventory_not_exclusive");
  }
}

function evaluateFirewallEvidence(firewall, expectations, failures) {
  if (!isObject(firewall)) {
    failures.push("recovery_firewall_metadata_invalid");
    return;
  }
  if (firewall.name !== expectations.firewallRule) failures.push("recovery_firewall_name_mismatch");
  if (!referenceMatches(firewall.network, expectations.network, expectations.project)) {
    failures.push("recovery_firewall_network_mismatch");
  }
  if (
    firewall.direction !== "INGRESS" ||
    firewall.disabled !== false ||
    firewall.priority !== 1000
  ) {
    failures.push("recovery_firewall_control_invalid");
  }
  if (!exactly(firewall.sourceRanges, [expectations.iapSourceRange])) {
    failures.push("recovery_firewall_source_not_iap_only");
  }
  if (
    !Array.isArray(firewall.allowed) ||
    firewall.allowed.length !== 1 ||
    firewall.allowed[0]?.IPProtocol !== "tcp" ||
    !exactly(firewall.allowed[0]?.ports, ["22"])
  ) {
    failures.push("recovery_firewall_port_scope_invalid");
  }
  if (!exactly(firewall.targetTags, [expectations.networkTag])) {
    failures.push("recovery_firewall_target_mismatch");
  }
  if (
    !absentOrEmpty(firewall.denied) ||
    !absentOrEmpty(firewall.sourceTags) ||
    !absentOrEmpty(firewall.sourceServiceAccounts) ||
    !absentOrEmpty(firewall.targetServiceAccounts) ||
    !absentOrEmpty(firewall.destinationRanges)
  ) {
    failures.push("recovery_firewall_unexpected_scope_present");
  }
}

function evaluateFirewallInventory(evidence, expectations, failures) {
  if (!Array.isArray(evidence.firewallInventory)) {
    failures.push("recovery_firewall_inventory_invalid");
    return;
  }
  const matching = evidence.firewallInventory.filter((firewall) =>
    referenceMatches(firewall?.network, expectations.network, expectations.project),
  );
  if (matching.length !== 1 || matching[0]?.name !== expectations.firewallRule) {
    failures.push("recovery_firewall_inventory_not_exclusive");
  }
}

function evaluateProjectRoleAbsence(evidence, expectations, failures) {
  const projectBindings = policyBindings(evidence.stable?.projectIamPolicy);
  if (projectBindings === null) {
    failures.push("recovery_project_iam_policy_invalid");
  } else {
    const member = `serviceAccount:${expectations.recoveryServiceAccount}`;
    const bindings = projectBindings.filter((binding) => binding.members.includes(member));
    if (bindings.length !== 0) failures.push("recovery_service_account_project_role_present");
  }
}

function evaluateRepositoryRoleScope(evidence, expectations, failures) {
  const repositoryBindings = policyBindings(evidence.artifactRepositoryPolicy);
  if (repositoryBindings === null) {
    failures.push("recovery_artifact_repository_iam_policy_invalid");
  } else {
    if (hasPublicMember(repositoryBindings)) {
      failures.push("recovery_artifact_repository_public_principal_present");
    }
    const member = `serviceAccount:${expectations.recoveryServiceAccount}`;
    const bindings = repositoryBindings.filter((binding) => binding.members.includes(member));
    if (
      bindings.length !== 1 ||
      bindings[0].role !== expectations.recoveryRole ||
      bindings[0].condition !== undefined
    ) {
      failures.push("recovery_service_account_repository_role_scope_invalid");
    }
  }
}

function evaluateImpersonationAbsence(evidence, failures) {
  const accountBindings = policyBindings(evidence.serviceAccountPolicy);
  if (accountBindings === null) {
    failures.push("recovery_service_account_iam_policy_invalid");
  } else if (accountBindings.length !== 0 || hasPublicMember(accountBindings)) {
    failures.push("recovery_service_account_impersonation_binding_present");
  }
}

function evaluateSnapshotBucketRoles(evidence, expectations, failures) {
  const bucketBindings = policyBindings(evidence.snapshotBucketPolicy);
  if (bucketBindings === null) {
    failures.push("recovery_snapshot_bucket_iam_policy_invalid");
  } else {
    if (hasPublicMember(bucketBindings)) {
      failures.push("recovery_snapshot_bucket_public_principal_present");
    }
    const recoveryMember = `serviceAccount:${expectations.recoveryServiceAccount}`;
    if (bucketBindings.some((binding) => binding.members.includes(recoveryMember))) {
      failures.push("recovery_service_account_snapshot_access_present");
    }
    const workerMember = `serviceAccount:${expectations.serviceAccount}`;
    const workerBindings = bucketBindings.filter((binding) =>
      binding.members.includes(workerMember),
    );
    if (expectations.snapshotAccessPhase === "revoked") {
      if (workerBindings.length !== 0) {
        failures.push("recovery_worker_snapshot_role_present_after_revocation");
      }
    } else if (
      workerBindings.length !== 1 ||
      workerBindings[0].role !== "roles/storage.objectUser" ||
      workerBindings[0].condition !== undefined ||
      !exactly(workerBindings[0].members, [workerMember])
    ) {
      failures.push("recovery_worker_snapshot_role_scope_invalid");
    }
  }
}

function evaluateRecoveryIam(evidence, expectations, failures) {
  evaluateProjectRoleAbsence(evidence, expectations, failures);
  evaluateRepositoryRoleScope(evidence, expectations, failures);
  evaluateImpersonationAbsence(evidence, failures);
  evaluateSnapshotBucketRoles(evidence, expectations, failures);
}

function evaluateRecoveryMapping(stable, expectations, failures) {
  const mappings = stable?.natMappings;
  if (
    !Array.isArray(mappings) ||
    mappings.length !== 1 ||
    basename(mappings[0]?.instanceName) !== expectations.instance
  ) {
    failures.push("recovery_nat_mapping_not_exclusive");
  }
}

function evaluateSnapshotControls(evidence, failures) {
  const result = evaluateSnapshotBucketControls(
    evidence.snapshotBucketMetadata,
    evidence.projectMetadata?.projectNumber,
  );
  if (result.invalid) {
    failures.push("recovery_snapshot_bucket_metadata_invalid");
    return;
  }
  for (const failure of result.failures) {
    failures.push(`recovery_snapshot_${failure}`);
  }
}

function evaluateIapService(evidence, expectations, failures) {
  if (
    !Array.isArray(evidence.iapService) ||
    evidence.iapService.length !== 1 ||
    evidence.iapService[0]?.config?.name !== expectations.iapService ||
    evidence.iapService[0]?.state !== "ENABLED"
  ) {
    failures.push("recovery_iap_service_not_enabled");
  }
}

function evaluateCollectionStability(evidence, failures) {
  if (
    evidence.instance?.id === undefined ||
    evidence.instance?.id !== evidence.confirmInstance?.id ||
    evidence.instance?.fingerprint !== evidence.confirmInstance?.fingerprint ||
    evidence.instance?.metadata?.fingerprint !== evidence.confirmInstance?.metadata?.fingerprint ||
    evidence.instance?.status !== evidence.confirmInstance?.status
  ) {
    failures.push("recovery_instance_changed_during_collection");
  }
  if (
    evidence.firewall?.id === undefined ||
    evidence.firewall?.id !== evidence.confirmFirewall?.id ||
    evidence.firewall?.fingerprint !== evidence.confirmFirewall?.fingerprint
  ) {
    failures.push("recovery_firewall_changed_during_collection");
  }
  if (
    JSON.stringify(evidence.instanceInventory) !==
      JSON.stringify(evidence.confirmInstanceInventory) ||
    JSON.stringify(evidence.firewallInventory) !==
      JSON.stringify(evidence.confirmFirewallInventory)
  ) {
    failures.push("recovery_inventory_changed_during_collection");
  }
  const policies = [
    [evidence.stable?.projectIamPolicy, evidence.confirmProjectIamPolicy],
    [evidence.serviceAccountPolicy, evidence.confirmServiceAccountPolicy],
    [evidence.artifactRepositoryPolicy, evidence.confirmArtifactRepositoryPolicy],
    [evidence.snapshotBucketPolicy, evidence.confirmSnapshotBucketPolicy],
  ];
  if (
    policies.some(
      ([before, after]) =>
        typeof before?.etag !== "string" ||
        before.etag.length === 0 ||
        before.etag !== after?.etag,
    ) ||
    JSON.stringify(evidence.iapService) !== JSON.stringify(evidence.confirmIapService)
  ) {
    failures.push("recovery_access_controls_changed_during_collection");
  }
  if (
    JSON.stringify(evidence.projectMetadata) !==
      JSON.stringify(evidence.confirmProjectMetadata) ||
    JSON.stringify(evidence.snapshotBucketMetadata) !==
      JSON.stringify(evidence.confirmSnapshotBucketMetadata)
  ) {
    failures.push("recovery_snapshot_controls_changed_during_collection");
  }
}

/**
 * Validate the temporary private recovery host while reusing every stable-
 * egress control except the deliberately non-quiescent single NAT mapping.
 */
export function evaluateRecoveryHostEvidence(evidence, expectations) {
  if (!validateRecoveryHostExpectations(expectations)) {
    return { ok: false, invalid: true, failures: ["invalid_expectations"] };
  }
  if (!isObject(evidence) || !isObject(evidence.stable)) {
    return { ok: false, invalid: true, failures: ["invalid_evidence"] };
  }

  const stableResult = evaluateStableEgressEvidence(
    { ...evidence.stable, natMappings: [] },
    expectations,
  );
  if (stableResult.invalid) {
    return { ok: false, invalid: true, failures: ["stable_evidence_invalid"] };
  }

  const failures = stableResult.failures.map((failure) => `stable_${failure}`);
  evaluateRecoveryMapping(evidence.stable, expectations, failures);
  evaluateSnapshotControls(evidence, failures);
  evaluateIapService(evidence, expectations, failures);
  evaluateInstanceEvidence(evidence, expectations, failures);
  evaluateInstanceInventory(evidence, expectations, failures);
  evaluateFirewallEvidence(evidence.firewall, expectations, failures);
  evaluateFirewallInventory(evidence, expectations, failures);
  evaluateRecoveryIam(evidence, expectations, failures);
  evaluateCollectionStability(evidence, failures);
  return { ok: failures.length === 0, invalid: false, failures };
}

async function defaultRunCommand(gcloudBin, args) {
  const { stdout } = await execFileAsync(gcloudBin, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: CLOUD_COMMAND_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
}

/** Collect only bounded configuration metadata; never execute or contact Xometry. */
export async function collectRecoveryHostEvidence(
  expectations,
  {
    gcloudBin = "gcloud",
    runCommand = defaultRunCommand,
    collectStableEvidence = collectStableEgressEvidence,
    readStartupScript = (filePath) => readFile(filePath, "utf8"),
  } = {},
) {
  const project = ["--project", expectations.project];
  const zonal = [...project, "--zone", expectations.zone];
  const instanceArgs = [
    "compute",
    "instances",
    "describe",
    expectations.instance,
    ...zonal,
    "--format=json(id,name,zone,machineType,status,canIpForward,deletionProtection,tags,labels,guestAccelerators,resourcePolicies,networkInterfaces,metadata,fingerprint,shieldedInstanceConfig,confidentialInstanceConfig,scheduling,disks,serviceAccounts)",
  ];
  const firewallArgs = [
    "compute",
    "firewall-rules",
    "describe",
    expectations.firewallRule,
    ...project,
    "--format=json(id,name,network,direction,disabled,priority,sourceRanges,allowed,denied,targetTags,sourceTags,sourceServiceAccounts,targetServiceAccounts,destinationRanges,fingerprint)",
  ];
  const instanceInventoryArgs = [
    "compute",
    "instances",
    "list",
    ...project,
    "--format=json(name,zone,status,networkInterfaces)",
  ];
  const firewallInventoryArgs = [
    "compute",
    "firewall-rules",
    "list",
    ...project,
    "--format=json(name,network,direction,disabled,priority,sourceRanges,allowed,denied,targetTags,sourceTags,sourceServiceAccounts,targetServiceAccounts,destinationRanges)",
  ];
  const serviceAccountPolicyArgs = [
    "iam",
    "service-accounts",
    "get-iam-policy",
    expectations.recoveryServiceAccount,
    ...project,
    "--format=json",
  ];
  const artifactRepositoryPolicyArgs = [
    "artifacts",
    "repositories",
    "get-iam-policy",
    expectations.artifactRepository,
    "--location",
    expectations.region,
    ...project,
    "--format=json",
  ];
  const iapServiceArgs = [
    "services",
    "list",
    "--enabled",
    ...project,
    "--filter",
    `config.name=${expectations.iapService}`,
    "--format=json(config.name,state)",
  ];
  const projectIamPolicyArgs = [
    "projects",
    "get-iam-policy",
    expectations.project,
    "--format=json",
  ];
  const projectMetadataArgs = [
    "projects",
    "describe",
    expectations.project,
    "--format=json(projectNumber)",
  ];

  const stable = await collectStableEvidence(expectations, { gcloudBin, runCommand });
  const snapshotBucket = serviceEnvironmentValue(
    stable.service,
    "XOMETRY_PROFILE_SNAPSHOT_BUCKET",
  );
  if (typeof snapshotBucket !== "string" || snapshotBucket.length === 0) {
    throw new Error("Snapshot bucket metadata is unavailable.");
  }
  const snapshotBucketPolicyArgs = [
    "storage",
    "buckets",
    "get-iam-policy",
    `gs://${snapshotBucket}`,
    ...project,
    "--format=json",
  ];
  const snapshotBucketMetadataArgs = [
    "storage",
    "buckets",
    "describe",
    `gs://${snapshotBucket}`,
    ...project,
    "--raw",
    "--format=json(projectNumber,iamConfiguration.publicAccessPrevention,iamConfiguration.uniformBucketLevelAccess.enabled,versioning.enabled,lifecycle)",
  ];

  const evidence = {
    stable,
    instance: await runCommand(gcloudBin, instanceArgs),
    firewall: await runCommand(gcloudBin, firewallArgs),
    instanceInventory: await runCommand(gcloudBin, instanceInventoryArgs),
    firewallInventory: await runCommand(gcloudBin, firewallInventoryArgs),
    serviceAccountPolicy: await runCommand(gcloudBin, serviceAccountPolicyArgs),
    artifactRepositoryPolicy: await runCommand(gcloudBin, artifactRepositoryPolicyArgs),
    snapshotBucketPolicy: await runCommand(gcloudBin, snapshotBucketPolicyArgs),
    projectMetadata: await runCommand(gcloudBin, projectMetadataArgs),
    snapshotBucketMetadata: await runCommand(gcloudBin, snapshotBucketMetadataArgs),
    iapService: await runCommand(gcloudBin, iapServiceArgs),
    startupScriptSource: await readStartupScript(
      path.resolve(process.cwd(), expectations.startupScript),
    ),
  };
  evidence.confirmInstance = await runCommand(gcloudBin, instanceArgs);
  evidence.confirmFirewall = await runCommand(gcloudBin, firewallArgs);
  evidence.confirmInstanceInventory = await runCommand(gcloudBin, instanceInventoryArgs);
  evidence.confirmFirewallInventory = await runCommand(gcloudBin, firewallInventoryArgs);
  evidence.confirmProjectIamPolicy = await runCommand(gcloudBin, projectIamPolicyArgs);
  evidence.confirmServiceAccountPolicy = await runCommand(
    gcloudBin,
    serviceAccountPolicyArgs,
  );
  evidence.confirmArtifactRepositoryPolicy = await runCommand(
    gcloudBin,
    artifactRepositoryPolicyArgs,
  );
  evidence.confirmSnapshotBucketPolicy = await runCommand(
    gcloudBin,
    snapshotBucketPolicyArgs,
  );
  evidence.confirmProjectMetadata = await runCommand(gcloudBin, projectMetadataArgs);
  evidence.confirmSnapshotBucketMetadata = await runCommand(
    gcloudBin,
    snapshotBucketMetadataArgs,
  );
  evidence.confirmIapService = await runCommand(gcloudBin, iapServiceArgs);
  return evidence;
}

function expectationsFromEnv(env) {
  return {
    ...OVD410_RECOVERY_HOST_CONTRACT,
    project: env.GOOGLE_CLOUD_PROJECT,
    region: env.CLOUD_RUN_REGION ?? OVD410_RECOVERY_HOST_CONTRACT.region,
    zone: env.XOMETRY_RECOVERY_ZONE ?? OVD410_RECOVERY_HOST_CONTRACT.zone,
    network: env.CLOUD_RUN_NETWORK,
    subnet: env.CLOUD_RUN_SUBNET,
    subnetRange: env.CLOUD_RUN_SUBNET_RANGE,
    router: env.CLOUD_RUN_ROUTER,
    nat: env.CLOUD_RUN_NAT,
    address: env.CLOUD_RUN_NAT_ADDRESS,
    addressId: env.CLOUD_RUN_NAT_ADDRESS_ID,
    serviceAccount: env.CLOUD_RUN_SERVICE_ACCOUNT,
    recoveryServiceAccount:
      env.XOMETRY_RECOVERY_SERVICE_ACCOUNT ??
      OVD410_RECOVERY_HOST_CONTRACT.recoveryServiceAccount,
    snapshotAccessPhase: env.XOMETRY_RECOVERY_SNAPSHOT_ACCESS_PHASE ?? "granted",
  };
}

/** CLI contract: exit 0 pass, 1 control mismatch, 2 invalid or unreadable metadata. */
export async function runCli({
  env = process.env,
  output = process.stdout,
  collectEvidence = collectRecoveryHostEvidence,
} = {}) {
  const expectations = expectationsFromEnv(env);
  if (
    !validateRecoveryHostExpectations(expectations) ||
    !matchesProductionContract(expectations)
  ) {
    output.write("Recovery-host verifier configuration is invalid; failing closed.\n");
    return 2;
  }

  let evidence;
  try {
    evidence = await collectEvidence(expectations, { gcloudBin: env.GCLOUD_BIN ?? "gcloud" });
  } catch {
    output.write("Recovery-host metadata collection failed; failing closed.\n");
    return 2;
  }

  const result = evaluateRecoveryHostEvidence(evidence, expectations);
  if (result.invalid) {
    output.write("Recovery-host metadata is invalid; failing closed.\n");
    return 2;
  }
  if (!result.ok) {
    output.write("Recovery-host verification failed:\n");
    for (const failure of result.failures) output.write(`  - ${failure}\n`);
    output.write("Provider authentication remains blocked.\n");
    return 1;
  }

  output.write(
    `Recovery-host verification passed; contract=${expectations.contractId}, exact worker image, private IAP-only host, and exclusive fixed-NAT mapping match.\n`,
  );
  return 0;
}

if (isDirectCli(import.meta.url)) {
  process.exitCode = await runCli();
}
