import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OVD410_RECOVERY_HOST_CONTRACT } from "./xometry-recovery-host-contract.mjs";
import {
  collectRecoveryHostEvidence,
  evaluateRecoveryHostEvidence,
  runCli,
  validateRecoveryHostExpectations,
} from "./verify-xometry-recovery-host.mjs";

const EXPECTED = {
  contractId: "synthetic-recovery-v1",
  project: "synthetic-project",
  region: "us-west1",
  zone: "us-west1-b",
  network: "xometry-egress",
  subnet: "xometry-egress-us-west1",
  subnetRange: "10.81.0.0/26",
  router: "xometry-egress-router",
  nat: "xometry-egress-nat",
  address: "xometry-egress-address",
  addressId: "1234567890123456789",
  service: "overdrafter-cad-worker",
  job: "overdrafter-xometry-auth-probe",
  serviceAccount: "worker@synthetic-project.iam.gserviceaccount.com",
  instance: "overdrafter-xometry-auth-recovery",
  machineType: "n2-standard-2",
  preemptible: false,
  provisioningModel: "STANDARD",
  instanceTerminationAction: null,
  hostLicense: "ubuntu-2404-lts",
  recoveryServiceAccount: "recovery@synthetic-project.iam.gserviceaccount.com",
  artifactRepository: "worker-images",
  recoveryRole: "roles/artifactregistry.reader",
  firewallRule: "overdrafter-xometry-auth-recovery-iap",
  networkTag: "overdrafter-xometry-auth-recovery",
  iapSourceRange: "35.235.240.0/20",
  iapService: "iap.googleapis.com",
  startupScript: "scripts/ovd410-recovery-host-startup.sh",
  snapshotAccessPhase: "granted",
};

function resource(type, name, project = EXPECTED.project) {
  return `https://www.googleapis.com/compute/v1/projects/${project}/${type}/${name}`;
}

function networkAnnotations(expectations) {
  return {
    "run.googleapis.com/network-interfaces": JSON.stringify([
      { network: expectations.network, subnetwork: expectations.subnet },
    ]),
    "run.googleapis.com/vpc-access-egress": "all-traffic",
  };
}

function compliantStable(expectations, retainedImage) {
  const annotations = networkAnnotations(expectations);
  const service = {
    metadata: { name: expectations.service, resourceVersion: "service-version-1" },
    spec: {
      traffic: [{ latestRevision: true, percent: 100 }],
      template: {
        metadata: {
          annotations: {
            ...annotations,
            "autoscaling.knative.dev/maxScale": "1",
          },
        },
        spec: {
          containerConcurrency: 1,
          serviceAccountName: expectations.serviceAccount,
          containers: [
            {
              image: retainedImage,
              env: [
                { name: "WORKER_MODE", value: "live" },
                { name: "WORKER_LIVE_ADAPTERS", value: "xometry" },
                { name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" },
                { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
                { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "private-bucket" },
                { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "profiles/production.tgz" },
                { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "268435456" },
              ],
            },
          ],
        },
      },
    },
    status: {
      latestCreatedRevisionName: "ready-revision",
      latestReadyRevisionName: "ready-revision",
      traffic: [
        { latestRevision: true, percent: 100, revisionName: "ready-revision" },
      ],
    },
  };
  const job = {
    metadata: { name: expectations.job, resourceVersion: "job-version-1" },
    spec: {
      template: {
        metadata: { annotations },
        spec: {
          taskCount: 1,
          parallelism: 1,
          template: {
            spec: {
              maxRetries: 0,
              serviceAccountName: expectations.serviceAccount,
              containers: [
                {
                  image: retainedImage,
                  command: ["node"],
                  args: ["dist/tools/probeXometryProfileAuth.js"],
                  env: [
                    { name: "WORKER_MODE", value: "simulate" },
                    { name: "WORKER_TEMP_DIR", value: "/root/.cache/overdrafter-worker" },
                    { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
                    { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "private-bucket" },
                    { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "profiles/production.tgz" },
                    { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "268435456" },
                    { name: "PLAYWRIGHT_HEADLESS", value: "true" },
                    { name: "PLAYWRIGHT_BROWSER_TIMEOUT_MS", value: "45000" },
                    { name: "PLAYWRIGHT_DISABLE_SANDBOX", value: "true" },
                    { name: "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", value: "true" },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
  const router = {
    name: expectations.router,
    network: resource("global/networks", expectations.network, expectations.project),
    region: resource("regions", expectations.region, expectations.project),
    fingerprint: "router-fingerprint-1",
  };
  const nat = {
    name: expectations.nat,
    natIpAllocateOption: "MANUAL_ONLY",
    natIps: [
      resource(
        `regions/${expectations.region}/addresses`,
        expectations.address,
        expectations.project,
      ),
    ],
    sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
    subnetworks: [
      {
        name: resource(
          `regions/${expectations.region}/subnetworks`,
          expectations.subnet,
          expectations.project,
        ),
        sourceIpRangesToNat: ["ALL_IP_RANGES"],
      },
    ],
    logConfig: { enable: true, filter: "ERRORS_ONLY" },
  };
  return {
    service,
    job,
    iamPolicy: { bindings: [] },
    jobIamPolicy: { bindings: [] },
    projectIamPolicy: { etag: "project-policy-1", bindings: [] },
    network: {
      name: expectations.network,
      autoCreateSubnetworks: false,
      routingConfig: { routingMode: "REGIONAL" },
      subnetworks: [
        resource(
          `regions/${expectations.region}/subnetworks`,
          expectations.subnet,
          expectations.project,
        ),
      ],
    },
    subnet: {
      name: expectations.subnet,
      network: resource("global/networks", expectations.network, expectations.project),
      region: resource("regions", expectations.region, expectations.project),
      ipCidrRange: expectations.subnetRange,
      privateIpGoogleAccess: true,
      purpose: "PRIVATE",
      stackType: "IPV4_ONLY",
    },
    router,
    nat,
    address: {
      id: expectations.addressId,
      name: expectations.address,
      addressType: "EXTERNAL",
      ipVersion: "IPV4",
      networkTier: "PREMIUM",
      status: "IN_USE",
      region: resource("regions", expectations.region, expectations.project),
    },
    routes: [
      {
        name: "default-route",
        network: resource("global/networks", expectations.network, expectations.project),
        destRange: "0.0.0.0/0",
        priority: 1000,
        nextHopGateway: resource("global/gateways", "default-internet-gateway", expectations.project),
      },
      {
        name: "subnet-route",
        network: resource("global/networks", expectations.network, expectations.project),
        destRange: expectations.subnetRange,
        priority: 0,
        nextHopNetwork: resource("global/networks", expectations.network, expectations.project),
      },
    ],
    policyBasedRoutes: [],
    natMappings: [
      {
        instanceName: resource(
          `zones/${expectations.zone}/instances`,
          expectations.instance,
          expectations.project,
        ),
      },
    ],
    jobExecutions: [],
    confirmService: structuredClone(service),
    confirmJob: structuredClone(job),
    confirmRouter: structuredClone(router),
    confirmNat: structuredClone(nat),
  };
}

function compliantEvidence(expectations = EXPECTED) {
  const retainedImage = `${expectations.region}-docker.pkg.dev/${expectations.project}/${expectations.artifactRepository}/worker@sha256:${"c".repeat(64)}`;
  const startupScriptSource = "#!/usr/bin/env bash\nprintf 'ready'\n";
  const instance = {
    id: "instance-id-1",
    name: expectations.instance,
    zone: resource("zones", expectations.zone, expectations.project),
    machineType: resource(
      `zones/${expectations.zone}/machineTypes`,
      expectations.machineType,
      expectations.project,
    ),
    status: "RUNNING",
    canIpForward: false,
    deletionProtection: false,
    tags: { items: [expectations.networkTag] },
    labels: {
      "ovd410-purpose": "xometry-auth-recovery",
      "ovd410-contract": "recovery-host-v1",
    },
    networkInterfaces: [
      {
        network: resource("global/networks", expectations.network, expectations.project),
        subnetwork: resource(
          `regions/${expectations.region}/subnetworks`,
          expectations.subnet,
          expectations.project,
        ),
        stackType: "IPV4_ONLY",
      },
    ],
    metadata: {
      fingerprint: "metadata-fingerprint-1",
      items: [
        { key: "enable-oslogin", value: "TRUE" },
        { key: "block-project-ssh-keys", value: "TRUE" },
        { key: "serial-port-enable", value: "FALSE" },
        { key: "ovd410-worker-image", value: retainedImage },
        { key: "startup-script", value: startupScriptSource },
      ],
    },
    fingerprint: "instance-fingerprint-1",
    shieldedInstanceConfig: {
      enableSecureBoot: true,
      enableVtpm: true,
      enableIntegrityMonitoring: true,
    },
    scheduling: {
      automaticRestart: false,
      onHostMaintenance: "TERMINATE",
      preemptible: false,
      provisioningModel: "STANDARD",
    },
    disks: [
      {
        boot: true,
        autoDelete: true,
        mode: "READ_WRITE",
        licenses: [resource("global/licenses", expectations.hostLicense, "ubuntu-os-cloud")],
      },
    ],
    serviceAccounts: [
      {
        email: expectations.recoveryServiceAccount,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    ],
  };
  const firewall = {
    id: "firewall-id-1",
    name: expectations.firewallRule,
    network: resource("global/networks", expectations.network, expectations.project),
    direction: "INGRESS",
    disabled: false,
    priority: 1000,
    sourceRanges: [expectations.iapSourceRange],
    allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
    targetTags: [expectations.networkTag],
    fingerprint: "firewall-fingerprint-1",
  };
  const instanceInventory = [
    {
      name: expectations.instance,
      zone: instance.zone,
      status: instance.status,
      networkInterfaces: structuredClone(instance.networkInterfaces),
    },
  ];
  const firewallInventory = [structuredClone(firewall)];
  const serviceAccountPolicy = { etag: "service-account-policy-1", bindings: [] };
  const artifactRepositoryPolicy = {
    etag: "artifact-repository-policy-1",
    bindings: [
      {
        role: expectations.recoveryRole,
        members: [`serviceAccount:${expectations.recoveryServiceAccount}`],
      },
    ],
  };
  const snapshotBucketPolicy = {
    etag: "snapshot-bucket-policy-1",
    bindings: [
      {
        role: "roles/storage.objectUser",
        members: [`serviceAccount:${expectations.serviceAccount}`],
      },
    ],
  };
  const projectMetadata = { projectNumber: "123456789012" };
  const snapshotBucketMetadata = {
    projectNumber: projectMetadata.projectNumber,
    iamConfiguration: {
      publicAccessPrevention: "enforced",
      uniformBucketLevelAccess: { enabled: true },
    },
    versioning: { enabled: true },
    lifecycle: { rule: [{ action: { type: "Delete" } }] },
  };
  const iapService = [{ config: { name: expectations.iapService }, state: "ENABLED" }];
  return {
    stable: compliantStable(expectations, retainedImage),
    instance,
    confirmInstance: structuredClone(instance),
    instanceInventory,
    confirmInstanceInventory: structuredClone(instanceInventory),
    firewall,
    confirmFirewall: structuredClone(firewall),
    firewallInventory,
    confirmFirewallInventory: structuredClone(firewallInventory),
    serviceAccountPolicy,
    confirmServiceAccountPolicy: structuredClone(serviceAccountPolicy),
    artifactRepositoryPolicy,
    confirmArtifactRepositoryPolicy: structuredClone(artifactRepositoryPolicy),
    snapshotBucketPolicy,
    confirmSnapshotBucketPolicy: structuredClone(snapshotBucketPolicy),
    projectMetadata,
    confirmProjectMetadata: structuredClone(projectMetadata),
    snapshotBucketMetadata,
    confirmSnapshotBucketMetadata: structuredClone(snapshotBucketMetadata),
    iapService,
    confirmIapService: structuredClone(iapService),
    confirmProjectIamPolicy: structuredClone(
      compliantStable(expectations, retainedImage).projectIamPolicy,
    ),
    startupScriptSource,
  };
}

function productionEnv() {
  return {
    GOOGLE_CLOUD_PROJECT: OVD410_RECOVERY_HOST_CONTRACT.project,
    CLOUD_RUN_REGION: OVD410_RECOVERY_HOST_CONTRACT.region,
    CLOUD_RUN_NETWORK: OVD410_RECOVERY_HOST_CONTRACT.network,
    CLOUD_RUN_SUBNET: OVD410_RECOVERY_HOST_CONTRACT.subnet,
    CLOUD_RUN_SUBNET_RANGE: OVD410_RECOVERY_HOST_CONTRACT.subnetRange,
    CLOUD_RUN_ROUTER: OVD410_RECOVERY_HOST_CONTRACT.router,
    CLOUD_RUN_NAT: OVD410_RECOVERY_HOST_CONTRACT.nat,
    CLOUD_RUN_NAT_ADDRESS: OVD410_RECOVERY_HOST_CONTRACT.address,
    CLOUD_RUN_NAT_ADDRESS_ID: OVD410_RECOVERY_HOST_CONTRACT.addressId,
    CLOUD_RUN_SERVICE_ACCOUNT: OVD410_RECOVERY_HOST_CONTRACT.serviceAccount,
  };
}

describe("recovery-host evidence", () => {
  it("accepts the exact private recovery host and exclusive fixed-NAT mapping", () => {
    expect(validateRecoveryHostExpectations(EXPECTED)).toBe(true);
    expect(evaluateRecoveryHostEvidence(compliantEvidence(), EXPECTED)).toEqual({
      ok: true,
      invalid: false,
      failures: [],
    });
  });

  it("rejects an external address on the recovery host", () => {
    const evidence = compliantEvidence();
    evidence.instance.networkInterfaces[0].accessConfigs = [{ name: "external" }];
    evidence.confirmInstance = structuredClone(evidence.instance);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_instance_external_address_present",
    );
  });

  it("rejects external IPv6 and alias ranges on the recovery host", () => {
    const evidence = compliantEvidence();
    evidence.instance.networkInterfaces[0].ipv6AccessConfigs = [{ name: "external-v6" }];
    evidence.instance.networkInterfaces[0].aliasIpRanges = [{ ipCidrRange: "10.81.0.2/32" }];
    evidence.confirmInstance = structuredClone(evidence.instance);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "recovery_instance_external_ipv6_present",
        "recovery_instance_alias_range_present",
      ]),
    );
  });

  it("rejects image drift from the retained production worker", () => {
    const evidence = compliantEvidence();
    evidence.instance.metadata.items.find(
      (item) => item.key === "ovd410-worker-image",
    ).value = `us-west1-docker.pkg.dev/synthetic/other@sha256:${"d".repeat(64)}`;
    evidence.confirmInstance = structuredClone(evidence.instance);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_instance_worker_image_mismatch",
    );
  });

  it("rejects an immutable worker image from a different repository", () => {
    const evidence = compliantEvidence();
    const image = `${EXPECTED.region}-docker.pkg.dev/${EXPECTED.project}/other/worker@sha256:${"d".repeat(64)}`;
    evidence.stable.service.spec.template.spec.containers[0].image = image;
    evidence.stable.job.spec.template.spec.template.spec.containers[0].image = image;
    evidence.stable.confirmService = structuredClone(evidence.stable.service);
    evidence.stable.confirmJob = structuredClone(evidence.stable.job);
    evidence.instance.metadata.items.find(
      (item) => item.key === "ovd410-worker-image",
    ).value = image;
    evidence.confirmInstance = structuredClone(evidence.instance);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_instance_worker_repository_mismatch",
    );
  });

  it("rejects broad firewall sources or browser-display ports", () => {
    const evidence = compliantEvidence();
    evidence.firewall.sourceRanges = ["0.0.0.0/0"];
    evidence.firewall.allowed[0].ports.push("6080");
    evidence.confirmFirewall = structuredClone(evidence.firewall);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "recovery_firewall_source_not_iap_only",
        "recovery_firewall_port_scope_invalid",
      ]),
    );
  });

  it("rejects recovery credentials broader than artifact read", () => {
    const evidence = compliantEvidence();
    evidence.artifactRepositoryPolicy.bindings.push({
      role: "roles/artifactregistry.writer",
      members: [`serviceAccount:${EXPECTED.recoveryServiceAccount}`],
    });
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_service_account_repository_role_scope_invalid",
    );
  });

  it("rejects public artifact repository access", () => {
    const evidence = compliantEvidence();
    evidence.artifactRepositoryPolicy.bindings.push({
      role: "roles/artifactregistry.reader",
      members: ["allUsers"],
    });
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_artifact_repository_public_principal_present",
    );
  });

  it("rejects recovery access to the snapshot bucket", () => {
    const evidence = compliantEvidence();
    evidence.snapshotBucketPolicy.bindings.push({
      role: "roles/storage.objectViewer",
      members: [`serviceAccount:${EXPECTED.recoveryServiceAccount}`],
    });
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_service_account_snapshot_access_present",
    );
  });

  it("accepts complete worker snapshot-role absence in the explicit revoked phase", () => {
    const evidence = compliantEvidence();
    evidence.snapshotBucketPolicy.bindings = [];
    evidence.confirmSnapshotBucketPolicy.bindings = [];
    const expectations = { ...EXPECTED, snapshotAccessPhase: "revoked" };
    expect(evaluateRecoveryHostEvidence(evidence, expectations)).toEqual({
      ok: true,
      invalid: false,
      failures: [],
    });
  });

  it("rejects a retained worker snapshot role in the revoked phase", () => {
    const expectations = { ...EXPECTED, snapshotAccessPhase: "revoked" };
    expect(evaluateRecoveryHostEvidence(compliantEvidence(), expectations).failures).toContain(
      "recovery_worker_snapshot_role_present_after_revocation",
    );
  });

  it("rejects missing snapshot-bucket controls", () => {
    const evidence = compliantEvidence();
    evidence.snapshotBucketMetadata.versioning.enabled = false;
    evidence.confirmSnapshotBucketMetadata = structuredClone(
      evidence.snapshotBucketMetadata,
    );
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_snapshot_versioning_disabled",
    );
  });

  it("rejects competing hosts or firewall rules on the governed network", () => {
    const evidence = compliantEvidence();
    evidence.instanceInventory.push({
      name: "unexpected-instance",
      zone: evidence.instance.zone,
      networkInterfaces: structuredClone(evidence.instance.networkInterfaces),
    });
    evidence.confirmInstanceInventory = structuredClone(evidence.instanceInventory);
    evidence.firewallInventory.push({
      name: "unexpected-firewall",
      network: evidence.firewall.network,
    });
    evidence.confirmFirewallInventory = structuredClone(evidence.firewallInventory);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "recovery_instance_inventory_not_exclusive",
        "recovery_firewall_inventory_not_exclusive",
      ]),
    );
  });

  it("rejects a competing NAT mapping", () => {
    const evidence = compliantEvidence();
    evidence.stable.natMappings.push({ instanceName: "unexpected-instance" });
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_nat_mapping_not_exclusive",
    );
  });

  it("rejects an unavailable IAP tunnel service", () => {
    const evidence = compliantEvidence();
    evidence.iapService = [];
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_iap_service_not_enabled",
    );
  });

  it("preserves stable-egress failures while the host exists", () => {
    const evidence = compliantEvidence();
    evidence.stable.service.spec.template.metadata.annotations[
      "run.googleapis.com/vpc-access-egress"
    ] = "private-ranges-only";
    evidence.stable.confirmService = structuredClone(evidence.stable.service);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "stable_service_egress_not_all_traffic",
    );
  });

  it.each([
    ["network count", (evidence) => { evidence.instance.networkInterfaces = []; }, "recovery_instance_network_interface_count_invalid"],
    ["network", (evidence) => { evidence.instance.networkInterfaces[0].network = "wrong-network"; }, "recovery_instance_network_mismatch"],
    ["subnet", (evidence) => { evidence.instance.networkInterfaces[0].subnetwork = "wrong-subnet"; }, "recovery_instance_subnet_mismatch"],
    ["IPv4 stack", (evidence) => { delete evidence.instance.networkInterfaces[0].stackType; }, "recovery_instance_not_ipv4_only"],
    ["metadata shape", (evidence) => { evidence.instance.metadata.items.push({ key: "ssh-keys", value: "unexpected" }); }, "recovery_instance_metadata_scope_invalid"],
    ["OS Login", (evidence) => { evidence.instance.metadata.items.find((item) => item.key === "enable-oslogin").value = "FALSE"; }, "recovery_instance_os_login_disabled"],
    ["project keys", (evidence) => { evidence.instance.metadata.items.find((item) => item.key === "block-project-ssh-keys").value = "FALSE"; }, "recovery_instance_project_ssh_keys_not_blocked"],
    ["serial port", (evidence) => { evidence.instance.metadata.items.find((item) => item.key === "serial-port-enable").value = "TRUE"; }, "recovery_instance_serial_port_not_disabled"],
    ["startup script", (evidence) => { evidence.instance.metadata.items.find((item) => item.key === "startup-script").value += "\nchanged"; }, "recovery_instance_startup_script_mismatch"],
    ["instance name", (evidence) => { evidence.instance.name = "wrong-instance"; }, "recovery_instance_name_mismatch"],
    ["instance zone", (evidence) => { evidence.instance.zone = "zones/us-west1-c"; }, "recovery_instance_zone_mismatch"],
    ["machine type", (evidence) => { evidence.instance.machineType = "machineTypes/n2-standard-4"; }, "recovery_instance_machine_type_mismatch"],
    ["running state", (evidence) => { evidence.instance.status = "STOPPED"; }, "recovery_instance_not_running"],
    ["IP forwarding", (evidence) => { evidence.instance.canIpForward = true; }, "recovery_instance_ip_forwarding_enabled"],
    ["deletion protection", (evidence) => { evidence.instance.deletionProtection = true; }, "recovery_instance_deletion_protection_enabled"],
    ["network tag", (evidence) => { evidence.instance.tags.items = ["wrong-tag"]; }, "recovery_instance_network_tag_mismatch"],
    ["labels", (evidence) => { evidence.instance.labels.extra = "value"; }, "recovery_instance_labels_mismatch"],
    ["accelerator", (evidence) => { evidence.instance.guestAccelerators = [{ acceleratorCount: 1 }]; }, "recovery_instance_accelerator_present"],
    ["resource policy", (evidence) => { evidence.instance.resourcePolicies = ["unexpected-policy"]; }, "recovery_instance_resource_policy_present"],
    ["Shielded VM", (evidence) => { evidence.instance.shieldedInstanceConfig.enableSecureBoot = false; }, "recovery_instance_shielded_controls_invalid"],
    ["confidential runtime", (evidence) => { evidence.instance.confidentialInstanceConfig = { enableConfidentialCompute: true }; }, "recovery_instance_unexpected_confidential_runtime"],
    ["automatic restart", (evidence) => { evidence.instance.scheduling.automaticRestart = true; }, "recovery_instance_scheduling_invalid"],
    ["preemptibility", (evidence) => { evidence.instance.scheduling.preemptible = true; }, "recovery_instance_scheduling_invalid"],
    ["provisioning model", (evidence) => { evidence.instance.scheduling.provisioningModel = "SPOT"; }, "recovery_instance_scheduling_invalid"],
    ["preemption action", (evidence) => { evidence.instance.scheduling.instanceTerminationAction = "STOP"; }, "recovery_instance_scheduling_invalid"],
    ["boot disk", (evidence) => { evidence.instance.disks[0].autoDelete = false; }, "recovery_instance_boot_disk_invalid"],
    ["service account", (evidence) => { evidence.instance.serviceAccounts[0].email = "other@synthetic-project.iam.gserviceaccount.com"; }, "recovery_instance_service_account_invalid"],
    ["firewall name", (evidence) => { evidence.firewall.name = "wrong-firewall"; }, "recovery_firewall_name_mismatch"],
    ["firewall network", (evidence) => { evidence.firewall.network = "wrong-network"; }, "recovery_firewall_network_mismatch"],
    ["firewall control", (evidence) => { evidence.firewall.disabled = true; }, "recovery_firewall_control_invalid"],
    ["firewall target", (evidence) => { evidence.firewall.targetTags = ["wrong-tag"]; }, "recovery_firewall_target_mismatch"],
    ["firewall extra scope", (evidence) => { evidence.firewall.sourceTags = ["unexpected-source"]; }, "recovery_firewall_unexpected_scope_present"],
    ["project role", (evidence) => { evidence.stable.projectIamPolicy.bindings.push({ role: "roles/viewer", members: [`serviceAccount:${EXPECTED.recoveryServiceAccount}`] }); }, "recovery_service_account_project_role_present"],
    ["service-account impersonation", (evidence) => { evidence.serviceAccountPolicy.bindings = [{ role: "roles/iam.serviceAccountTokenCreator", members: ["user:operator@example.com"] }]; }, "recovery_service_account_impersonation_binding_present"],
    ["bucket policy", (evidence) => { evidence.snapshotBucketPolicy.bindings = "invalid"; }, "recovery_snapshot_bucket_iam_policy_invalid"],
    ["worker snapshot role", (evidence) => { evidence.snapshotBucketPolicy.bindings[0].role = "roles/storage.objectAdmin"; }, "recovery_worker_snapshot_role_scope_invalid"],
    ["instance inventory", (evidence) => { evidence.instanceInventory = null; }, "recovery_instance_inventory_invalid"],
    ["firewall inventory", (evidence) => { evidence.firewallInventory = null; }, "recovery_firewall_inventory_invalid"],
  ])("rejects %s drift", (_label, mutate, failure) => {
    const evidence = compliantEvidence();
    mutate(evidence);
    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(failure);
  });
});

describe("recovery-host CLI", () => {
  it("passes only the fixed production contract", async () => {
    const output = { value: "", write(chunk) { this.value += chunk; } };
    const code = await runCli({
      env: productionEnv(),
      output,
      collectEvidence: async (expectations) => compliantEvidence(expectations),
    });
    expect(code).toBe(0);
    expect(output.value).toContain("Recovery-host verification passed");
  });

  it("fails before collection when one fixed name drifts", async () => {
    let collected = false;
    const output = { value: "", write(chunk) { this.value += chunk; } };
    const code = await runCli({
      env: { ...productionEnv(), CLOUD_RUN_SUBNET: "different-subnet" },
      output,
      collectEvidence: async () => {
        collected = true;
        return compliantEvidence(OVD410_RECOVERY_HOST_CONTRACT);
      },
    });
    expect(code).toBe(2);
    expect(collected).toBe(false);
    expect(output.value).not.toContain("different-subnet");
  });
});

describe("recovery-host metadata collection", () => {
  it("reads the bounded instance, firewall, repository, and service-account surfaces", async () => {
    const expectedEvidence = compliantEvidence();
    const responses = [
      expectedEvidence.instance,
      expectedEvidence.firewall,
      expectedEvidence.instanceInventory,
      expectedEvidence.firewallInventory,
      expectedEvidence.serviceAccountPolicy,
      expectedEvidence.artifactRepositoryPolicy,
      expectedEvidence.snapshotBucketPolicy,
      expectedEvidence.projectMetadata,
      expectedEvidence.snapshotBucketMetadata,
      expectedEvidence.iapService,
      expectedEvidence.confirmInstance,
      expectedEvidence.confirmFirewall,
      expectedEvidence.confirmInstanceInventory,
      expectedEvidence.confirmFirewallInventory,
      expectedEvidence.confirmProjectIamPolicy,
      expectedEvidence.confirmServiceAccountPolicy,
      expectedEvidence.confirmArtifactRepositoryPolicy,
      expectedEvidence.confirmSnapshotBucketPolicy,
      expectedEvidence.confirmProjectMetadata,
      expectedEvidence.confirmSnapshotBucketMetadata,
      expectedEvidence.confirmIapService,
    ];
    const calls = [];
    const evidence = await collectRecoveryHostEvidence(EXPECTED, {
      gcloudBin: "synthetic-gcloud",
      collectStableEvidence: async (expectations, options) => {
        expect(expectations).toBe(EXPECTED);
        expect(options.gcloudBin).toBe("synthetic-gcloud");
        return expectedEvidence.stable;
      },
      runCommand: async (bin, args) => {
        calls.push({ bin, args });
        return responses[calls.length - 1];
      },
      readStartupScript: async (filePath) => {
        expect(filePath.endsWith(EXPECTED.startupScript)).toBe(true);
        return expectedEvidence.startupScriptSource;
      },
    });

    expect(evidence).toEqual(expectedEvidence);
    expect(calls).toHaveLength(21);
    expect(calls.every((call) => call.bin === "synthetic-gcloud")).toBe(true);
    expect(calls.filter((call) => call.args[1] === "instances")).toHaveLength(4);
    expect(
      calls.some((call) =>
        call.args.includes("--format=json(name,zone,status,networkInterfaces)"),
      ),
    ).toBe(true);
    expect(calls.filter((call) => call.args[1] === "firewall-rules")).toHaveLength(4);
    expect(calls.some((call) => call.args[0] === "iam")).toBe(true);
    expect(calls.some((call) => call.args[0] === "artifacts")).toBe(true);
    expect(calls.some((call) => call.args[0] === "services")).toBe(true);
    expect(calls.some((call) => call.args[0] === "storage")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("address=");
  });
});

describe("recovery-host startup contract", () => {
  it("pulls only the pinned image and exposes the display on loopback", async () => {
    const source = await readFile(OVD410_RECOVERY_HOST_CONTRACT.startupScript, "utf8");
    expect(source).toContain(
      "^us-west1-docker\\.pkg\\.dev/overdrafter-worker-9133/cloud-run-source-deploy/",
    );
    const patternSource = source.match(/readonly OVD410_IMAGE_PATTERN='([^']+)'/)?.[1];
    expect(patternSource).toBeDefined();
    const imagePattern = new RegExp(patternSource);
    expect(
      imagePattern.test(
        `us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/worker@sha256:${"a".repeat(64)}`,
      ),
    ).toBe(true);
    expect(
      imagePattern.test(`evil.example/worker@sha256:${"a".repeat(64)}`),
    ).toBe(false);
    expect(source.indexOf("OVD410_IMAGE_PATTERN")).toBeLessThan(
      source.indexOf("OVD410_ACCESS_TOKEN"),
    );
    expect(source).toContain("docker pull --quiet \"$OVD410_WORKER_IMAGE\"");
    expect(source).toContain("x11vnc -display :99 -localhost");
    expect(source).toContain(
      "websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900",
    );
    expect(source).toContain(
      "iptables -C DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT",
    );
    expect(source).toContain(
      "iptables -C DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT",
    );
    expect(source).toContain(
      "iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT",
    );
    expect(source.indexOf("--dport 53 -j ACCEPT")).toBeLessThan(
      source.indexOf("-d 169.254.169.254/32 -j REJECT"),
    );
    expect(source).not.toContain("dist/tools/xometryAuth.js");
    expect(source).not.toContain("dist/tools/probeXometryProfileAuth.js");
    expect(source).not.toContain("XOMETRY_PROFILE_SNAPSHOT_BUCKET");
  });
});

describe("recovery-host runbook contract", () => {
  it("keeps every recovery block fail-fast and preserves explicit isolation gates", async () => {
    const source = await readFile("docs/workflows/ovd410-stable-egress.md", "utf8");
    const section = source.slice(
      source.indexOf("## Exact-runtime recovery through the fixed path"),
      source.indexOf("## Cost envelope"),
    );
    const bashBlocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
      (match) => match[1],
    );
    const fullRecoveryBlock = bashBlocks.find((block) =>
      block.includes("--name ovd410-xometry-auth-recovery"),
    );
    const fullRecoveryNetworkValues = [
      ...(fullRecoveryBlock ?? "").matchAll(
        /--network(?:[ \t]+|=)([^\s"'`)\\]+)/g,
      ),
    ].map((match) => match[1]);

    expect(bashBlocks.length).toBeGreaterThan(0);
    expect(bashBlocks.every((block) => block.startsWith("set -euo pipefail\n"))).toBe(
      true,
    );
    expect(section).toContain("gcloud storage objects list");
    expect(section).not.toContain("gcloud storage ls --all-versions");
    expect(section).toContain("Security hold: do not execute this diagnostic");
    expect(section).toContain("--network none");
    expect(section).not.toContain("--network bridge");
    expect(fullRecoveryBlock).toBeDefined();
    expect(fullRecoveryNetworkValues).toEqual(["none"]);
    expect(section).toContain("--ipc=host");
    expect(section).not.toContain("--shm-size 1g");
    expect(section).toContain("--ssh-flag='-N'");
    expect(section).toContain("--ssh-flag='-L127.0.0.1:6080:127.0.0.1:6080'");
    expect(section).toContain("both exact-image dashboard-classifier lifecycles pass");
    expect(section).toContain("standing confirmation for pre-beta OVD-410");
    expect(section).toContain("chmod 0700 /var/lib/ovd410-credential");
    expect(section).toContain("OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED");
    expect(section).toContain("--lifetime=300s");
    expect(section).toContain("cleanup_ovd410_token_binding");
    expect(section.match(/for _attempt in \$\(seq 1 12\)/g)).toHaveLength(2);
    expect(section).toContain("OVD410_REPOSITORY_BINDING_ADDED='FALSE'");
    expect(section).toContain("for _attempt in $(seq 1 12)");
    expect(section).toContain("sleep 5");
    expect(section.indexOf("add-iam-policy-binding")).toBeLessThan(
      section.indexOf("--lifetime=300s"),
    );
    expect(section.indexOf("cleanup_ovd410_token_binding\nOVD410_TOKEN_BINDING_ADDED='FALSE'")).toBeLessThan(
      section.indexOf("gcloud storage rm --all-versions"),
    );
  });
});
