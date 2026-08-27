import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OVD410_RECOVERY_HOST_CONTRACT } from "./xometry-recovery-host-contract.mjs";
import {
  OVD420_RECOVERY_EGRESS_CONTRACT,
  parseRecoveryEgressPolicy,
  sha256Hex,
} from "./ovd420-recovery-egress-contract.mjs";
import {
  collectRecoveryHostEvidence,
  collectRecoveryStartupStatus,
  evaluateRecoveryHostEvidence,
  evaluateRecoveryStartupStatus,
  runCli,
  validateRecoveryHostExpectations,
} from "./verify-xometry-recovery-host.mjs";

const RECOVERY_EGRESS_POLICY_SOURCE = JSON.stringify({
  version: OVD420_RECOVERY_EGRESS_CONTRACT.policyVersion,
  hostnames: ["api.xometry.com", "www.xometry.com"],
});
const RECOVERY_EGRESS_POLICY = parseRecoveryEgressPolicy(
  RECOVERY_EGRESS_POLICY_SOURCE,
);

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
  startupStatusPath: OVD410_RECOVERY_HOST_CONTRACT.startupStatusPath,
  startupStages: OVD410_RECOVERY_HOST_CONTRACT.startupStages,
  recoveryEgressContractId: OVD420_RECOVERY_EGRESS_CONTRACT.contractId,
  recoveryEgressPolicyVersion: OVD420_RECOVERY_EGRESS_CONTRACT.policyVersion,
  recoveryEgressNetwork: OVD420_RECOVERY_EGRESS_CONTRACT.network,
  recoveryEgressSubnet: OVD420_RECOVERY_EGRESS_CONTRACT.subnet,
  recoveryEgressGateway: OVD420_RECOVERY_EGRESS_CONTRACT.gateway,
  recoveryEgressBridge: OVD420_RECOVERY_EGRESS_CONTRACT.bridge,
  recoveryEgressControlScript: "scripts/ovd420-recovery-egress-control.sh",
  recoveryEgressControlPath: "/usr/local/sbin/ovd420-recovery-egress-control",
  recoveryEgressControlOwnerUid: 0,
  recoveryEgressControlOwnerGid: 0,
  recoveryEgressControlMode: "700",
  recoveryEgressControlMetadataKey: "ovd420-recovery-egress-control",
  recoveryEgressPolicyMetadataKey: "ovd420-recovery-egress-policy",
  recoveryEgressEvidencePath: "/run/ovd420-recovery-egress/evidence.json",
  recoveryEgressPolicySha256: RECOVERY_EGRESS_POLICY.digest,
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
    metadata: { name: expectations.service, resourceVersion: "service-version-1"},
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
                { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "private-bucket"},
                { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "profiles/production.tgz"},
                { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "268435456"},
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
                    { name: "WORKER_TEMP_DIR", value: "/root/.cache/overdrafter-worker"},
                    { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
                    { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "private-bucket"},
                    { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "profiles/production.tgz"},
                    { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "268435456"},
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
  const recoveryEgressControlSource =
    "#!/usr/bin/env bash\nprintf 'controlled'\n";
  const recoveryEgressIdentity = {
    contractId: expectations.recoveryEgressContractId,
    digest: RECOVERY_EGRESS_POLICY.digest,
  };
  const recoveryEgressRuntime = {
    schema: OVD420_RECOVERY_EGRESS_CONTRACT.evidenceSchema,
    contractId: expectations.recoveryEgressContractId,
    policyDigest: RECOVERY_EGRESS_POLICY.digest,
    hostnames: [...RECOVERY_EGRESS_POLICY.hostnames],
    topology: {
      network: expectations.recoveryEgressNetwork,
      subnet: expectations.recoveryEgressSubnet,
      gateway: expectations.recoveryEgressGateway,
      bridge: expectations.recoveryEgressBridge,
    },
    services: { dns: "healthy", gateway: "healthy", browser: "absent" },
    listeners: {
      dnsTcp: {
        host: expectations.recoveryEgressGateway,
        protocol: "tcp",
        port: 53,
      },
      dnsUdp: {
        host: expectations.recoveryEgressGateway,
        protocol: "udp",
        port: 53,
      },
      tls: {
        host: expectations.recoveryEgressGateway,
        protocol: "tcp",
        port: 443,
      },
    },
    firewall: {
      dockerUserDefaultDeny: true,
      browserNetworkRestricted: true,
    },
    policyIdentities: {
      classifier: { ...recoveryEgressIdentity },
      fullRecovery: { ...recoveryEgressIdentity },
    },
  };
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
        { key: expectations.recoveryEgressControlMetadataKey,
          value: recoveryEgressControlSource,
        },
        {
          key: expectations.recoveryEgressPolicyMetadataKey,
          value: RECOVERY_EGRESS_POLICY_SOURCE,
        },
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
  const serviceAccountPolicy = { etag: "service-account-policy-1", bindings: []};
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
  const startupStatus = { stage: "ready", exitCode: 0 };
  const evidence = {
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
    startupStatus,
    confirmStartupStatus: structuredClone(startupStatus),
    confirmProjectIamPolicy: structuredClone(
      compliantStable(expectations, retainedImage).projectIamPolicy,
    ),
    startupScriptSource,
    recoveryEgressControlSource,
    recoveryEgressControlAttestation: {
      sha256: sha256Hex(recoveryEgressControlSource),
      ownerUid: expectations.recoveryEgressControlOwnerUid,
      ownerGid: expectations.recoveryEgressControlOwnerGid,
      mode: expectations.recoveryEgressControlMode,
      size: Buffer.byteLength(recoveryEgressControlSource, "utf8"),
    },
    recoveryEgressRuntime,
    confirmRecoveryEgressRuntime: structuredClone(recoveryEgressRuntime),
  };
  evidence.confirmRecoveryEgressControlAttestation = structuredClone(
    evidence.recoveryEgressControlAttestation,
  );
  return evidence;
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
    OVD420_RECOVERY_EGRESS_POLICY_SHA256: RECOVERY_EGRESS_POLICY.digest,
  };
}

describe("recovery-host evidence", () => {
  it("accepts the exact private recovery host and exclusive fixed-NAT mapping", () => {
    expect(validateRecoveryHostExpectations(EXPECTED)).toBe(true);
    expect(evaluateRecoveryHostEvidence(compliantEvidence(), EXPECTED)).toEqual({
      ok: true,
      invalid: false,
      failures: [],
    },
    );
  });

  it("rejects malformed recovery-egress policy metadata", () => {
    const evidence = compliantEvidence();
    const policyItem = evidence.instance.metadata.items.find(
      (item) => item.key === EXPECTED.recoveryEgressPolicyMetadataKey,
    );
    policyItem.value = '{"version":1,"hostnames":["*.xometry.com"]}';
    evidence.confirmInstance = structuredClone(evidence.instance);

    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_egress_policy_invalid",
    );
  });

  it("rejects metadata and runtime that self-approve a different policy digest", () => {
    const evidence = compliantEvidence();
    const untrustedPolicySource = JSON.stringify({
      version: OVD420_RECOVERY_EGRESS_CONTRACT.policyVersion,
      hostnames: ["different.example"],
    });
    const untrustedPolicy = parseRecoveryEgressPolicy(untrustedPolicySource);
    const policyItem = evidence.instance.metadata.items.find(
      (item) => item.key === EXPECTED.recoveryEgressPolicyMetadataKey,
    );
    policyItem.value = untrustedPolicySource;
    evidence.confirmInstance = structuredClone(evidence.instance);
    evidence.recoveryEgressRuntime.policyDigest = untrustedPolicy.digest;
    evidence.recoveryEgressRuntime.hostnames = [...untrustedPolicy.hostnames];
    for (const identity of Object.values(
      evidence.recoveryEgressRuntime.policyIdentities,
    )) {
      identity.digest = untrustedPolicy.digest;
    }
    evidence.confirmRecoveryEgressRuntime = structuredClone(
      evidence.recoveryEgressRuntime,
    );

    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "recovery_egress_policy_digest_mismatch",
        "recovery_egress_runtime_policy_digest_mismatch",
      ]),
    );
  });

  it("rejects installed recovery-egress control ownership, mode, or digest drift", () => {
    const evidence = compliantEvidence();
    evidence.recoveryEgressControlAttestation.sha256 = "d".repeat(64);
    evidence.recoveryEgressControlAttestation.ownerUid = 1000;
    evidence.recoveryEgressControlAttestation.mode = "755";
    evidence.confirmRecoveryEgressControlAttestation = structuredClone(
      evidence.recoveryEgressControlAttestation,
    );

    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "recovery_egress_control_owner_mismatch",
        "recovery_egress_control_mode_mismatch",
        "recovery_egress_control_local_digest_mismatch",
        "recovery_egress_control_metadata_digest_mismatch",
      ]),
    );
  });

  it("rejects an installed recovery-egress control that changes during collection", () => {
    const evidence = compliantEvidence();
    evidence.confirmRecoveryEgressControlAttestation.sha256 = "e".repeat(64);

    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toContain(
      "recovery_egress_control_changed_during_collection",
    );
  });

  it("rejects recovery-egress control source or runtime drift", () => {
    const evidence = compliantEvidence();
    const controlItem = evidence.instance.metadata.items.find(
      (item) => item.key === EXPECTED.recoveryEgressControlMetadataKey,
    );
    controlItem.value = "#!/usr/bin/env bash\nexit 0\n";
    evidence.confirmInstance = structuredClone(evidence.instance);
    evidence.recoveryEgressRuntime.firewall.browserNetworkRestricted = false;

    expect(evaluateRecoveryHostEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "recovery_egress_control_source_mismatch",
        "recovery_egress_firewall_not_default_deny",
        "recovery_egress_changed_during_collection",
      ]),
    );
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

  it("prints only the sanitized startup status and classifies readiness", async () => {
    for (const [status, expectedCode, expectedOutput] of [
      [{ stage: "ready", exitCode: 0 }, 0, "stage=ready exit=0\n"],
      [{ stage: "image-pull", exitCode: 0 }, 1, "stage=image-pull exit=0\n"],
      [{ stage: "image-pull", exitCode: 17 }, 1, "stage=image-pull exit=17\n"],
    ]) {
      const output = { value: "", write(chunk) { this.value += chunk; } };
      const code = await runCli({
        args: ["--startup-status"],
        env: productionEnv(),
        output,
        collectStartupStatus: async () => status,
      });
      expect(code).toBe(expectedCode);
      expect(output.value).toBe(expectedOutput);
    }
  });

  it("redacts startup transport failures and rejects untrusted status shapes", async () => {
    const transportOutput = {
      value: "",
      write(chunk) {
        this.value += chunk;
      },
    };
    const transportCode = await runCli({
      args: ["--startup-status"],
      env: productionEnv(),
      output: transportOutput,
      collectStartupStatus: async () => {
        throw new Error("secret raw ssh output");
      },
    });
    expect(transportCode).toBe(2);
    expect(transportOutput.value).toBe(
      "Recovery-host startup status unavailable; failing closed.\n",
    );
    expect(transportOutput.value).not.toContain("secret");

    for (const status of [
      { stage: "unknown", exitCode: 0 },
      { stage: "ready", exitCode: "0" },
      { stage: "ready", exitCode: 0.5 },
      { stage: "ready", exitCode: -1 },
      { stage: "ready", exitCode: 256 },
      { stage: "ready", exitCode: 0, raw: "unexpected" },
      "not-json",
      null,
    ]) {
      const output = { value: "", write(chunk) { this.value += chunk; } };
      const code = await runCli({
        args: ["--startup-status"],
        env: productionEnv(),
        output,
        collectStartupStatus: async () => status,
      });
      expect(code).toBe(2);
      expect(output.value).toBe(
        "Recovery-host startup status is invalid; failing closed.\n",
      );
    }
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

  it("fails before collection when the trusted policy digest is missing or malformed", async () => {
    for (const policyDigest of [undefined, "not-a-sha256", "A".repeat(64)]) {
      let collected = false;
      const output = {
        value: "",
        write(chunk) {
          this.value += chunk;
        },
      };
      const env = {
        ...productionEnv(),
        OVD420_RECOVERY_EGRESS_POLICY_SHA256: policyDigest,
      };
      const code = await runCli({
        env,
        output,
        collectEvidence: async () => {
          collected = true;
          return compliantEvidence(OVD410_RECOVERY_HOST_CONTRACT);
        },
      });
      expect(code).toBe(2);
      expect(collected).toBe(false);
      expect(output.value).toBe(
        "Recovery-host verifier configuration is invalid; failing closed.\n",
      );
    }
  });
});

describe("recovery-host startup status", () => {
  it("accepts only the exact ready status", () => {
    expect(evaluateRecoveryStartupStatus({ stage: "ready", exitCode: 0 })).toEqual({
      ok: true,
      invalid: false,
      status: { stage: "ready", exitCode: 0 },
    });
    expect(
      evaluateRecoveryStartupStatus({ stage: "display", exitCode: 0 }),
    ).toMatchObject({ ok: false, invalid: false });
  });

  it("requires stable ready status in the full recovery evidence", () => {
    const failed = compliantEvidence();
    failed.startupStatus = { stage: "image-pull", exitCode: 17 };
    failed.confirmStartupStatus = structuredClone(failed.startupStatus);
    expect(evaluateRecoveryHostEvidence(failed, EXPECTED).failures).toContain(
      "recovery_startup_not_ready",
    );

    const unstable = compliantEvidence();
    unstable.confirmStartupStatus = { stage: "ready", exitCode: 1 };
    const failures = evaluateRecoveryHostEvidence(unstable, EXPECTED).failures;
    expect(failures).toContain("recovery_startup_not_ready");
    expect(failures).toContain("recovery_startup_status_unstable");
  });

  it("uses one fixed status-only SSH command with bounded connection controls", async () => {
    const calls = [];
    const status = await collectRecoveryStartupStatus(EXPECTED, {
      gcloudBin: "synthetic-gcloud",
      runCommand: async (bin, args) => {
        calls.push({ bin, args });
        return { stage: "ready", exitCode: 0 };
      },
    });
    expect(status).toEqual({ stage: "ready", exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("synthetic-gcloud");
    expect(calls[0].args).toEqual([
      "compute",
      "ssh",
      EXPECTED.instance,
      "--project",
      EXPECTED.project,
      "--zone",
      EXPECTED.zone,
      "--tunnel-through-iap",
      "--quiet",
      "--ssh-flag=-oBatchMode=yes",
      "--ssh-flag=-oConnectTimeout=10",
      "--ssh-flag=-oConnectionAttempts=1",
      "--ssh-flag=-oServerAliveInterval=5",
      "--ssh-flag=-oServerAliveCountMax=1",
      "--command",
      `sudo cat ${EXPECTED.startupStatusPath}`,
    ]);
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
      expectedEvidence.startupStatus,
      expectedEvidence.recoveryEgressControlAttestation,
      expectedEvidence.recoveryEgressRuntime,
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
      expectedEvidence.confirmStartupStatus,
      expectedEvidence.confirmRecoveryEgressRuntime,
      expectedEvidence.confirmRecoveryEgressControlAttestation,
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
      readRecoveryEgressControl: async (filePath) => {
        expect(filePath.endsWith(EXPECTED.recoveryEgressControlScript)).toBe(
          true,
        );
        return expectedEvidence.recoveryEgressControlSource;
      },
    });

    expect(evidence).toEqual(expectedEvidence);
    expect(calls).toHaveLength(27);
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
    expect(
      calls.filter(
        (call) => call.args[0] === "compute" && call.args[1] === "ssh",
      ),
    ).toHaveLength(6);
    const runtimeCalls = calls.filter(
      (call) =>
        call.args[0] === "compute" &&
        call.args[1] === "ssh" &&
        call.args.some((arg) =>
          arg.includes(EXPECTED.recoveryEgressEvidencePath),
        ),
    );
    const attestationCalls = calls.filter(
      (call) =>
        call.args[0] === "compute" &&
        call.args[1] === "ssh" &&
        call.args.some((arg) => arg.includes("sha256sum")),
    );
    const startupStatusCalls = calls.filter(
      (call) =>
        call.args[0] === "compute" &&
        call.args[1] === "ssh" &&
        call.args.includes(`sudo cat ${EXPECTED.startupStatusPath}`),
    );
    expect(runtimeCalls).toHaveLength(2);
    expect(attestationCalls).toHaveLength(2);
    expect(startupStatusCalls).toHaveLength(2);
    expect(
      startupStatusCalls.every(
        (call) =>
          call.args.includes("--ssh-flag=-oBatchMode=yes") &&
          call.args.includes("--ssh-flag=-oConnectTimeout=10") &&
          call.args.includes("--ssh-flag=-oConnectionAttempts=1") &&
          call.args.includes("--ssh-flag=-oServerAliveInterval=5") &&
          call.args.includes("--ssh-flag=-oServerAliveCountMax=1"),
      ),
    ).toBe(true);
    expect(
      runtimeCalls.every((call) =>
        call.args.includes(
          `sudo ${EXPECTED.recoveryEgressControlPath} verify ${EXPECTED.recoveryEgressPolicySha256} >/dev/null && sudo cat ${EXPECTED.recoveryEgressEvidencePath}`,
        ),
      ),
    ).toBe(true);
    expect(
      attestationCalls.every(
        (call) =>
          call.args.some((arg) => arg.includes('test ! -L "$control"')) &&
          call.args.some((arg) =>
            arg.includes(
              'digest="$(sha256sum "$control" | cut -d " " -f 1)"',
            ),
          ) &&
          call.args.some((arg) => arg.includes("stat -c %u")) &&
          call.args.some((arg) => arg.includes("stat -c %g")) &&
          call.args.some((arg) => arg.includes("stat -c %a")),
      ),
    ).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("address=");
  });
});

describe("recovery-host startup contract", () => {
  it("pulls only the pinned image and exposes the display on loopback", async () => {
    const source = await readFile(OVD410_RECOVERY_HOST_CONTRACT.startupScript, "utf8");
    expect(
      spawnSync("bash", ["-n", OVD410_RECOVERY_HOST_CONTRACT.startupScript], {
        encoding: "utf8",
      }).status,
    ).toBe(0);
    expect(source).toContain("set -Eeuo pipefail");
    expect(source).toContain(
      `readonly STARTUP_STATUS="${OVD410_RECOVERY_HOST_CONTRACT.startupStatusPath}"`,
    );
    expect(source).toContain(
      "printf '{\"stage\":\"%s\",\"exitCode\":%s}\\n'",
    );
    expect(source).toContain('status_tmp="$(mktemp "${STARTUP_STATUS}.tmp.XXXXXX")"');
    expect(source).toContain('chown root:root "$status_tmp"');
    expect(source).toContain('chmod 0600 "$status_tmp"');
    expect(source).toContain('mv -fT -- "$status_tmp" "$STARTUP_STATUS"');
    expect(source.indexOf("trap 'record_startup_failure")).toBeLessThan(
      source.indexOf("apt-get update"),
    );
    let priorStageIndex = -1;
    for (const stage of OVD410_RECOVERY_HOST_CONTRACT.startupStages) {
      const stageIndex = source.indexOf(`set_startup_stage ${stage}`);
      expect(stageIndex).toBeGreaterThan(priorStageIndex);
      priorStageIndex = stageIndex;
    }
    expect(source.indexOf('install -m 0600 /dev/null "$READY_MARKER"')).toBeLessThan(
      source.indexOf("set_startup_stage ready"),
    );
    for (const forbidden of [
      "BASH_COMMAND",
      "LINENO",
      "journalctl",
      "get-serial-port-output",
      "startup-script-log",
    ]) {
      expect(source).not.toContain(forbidden);
    }
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
    expect(source).toContain('docker pull --quiet "$OVD410_WORKER_IMAGE"');
    expect(source).toContain("x11vnc -display :99 -localhost");
    expect(source).toContain(
      "websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900",
    );
    expect(source).not.toContain(
      "iptables -C DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT",
    );
    expect(source).not.toContain(
      "iptables -C DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT",
    );
    expect(source).toContain(
      "iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT",
    );
    expect(source).toContain(
      '"$OVD420_CONTROL_PATH" install "$OVD420_POLICY_TMP"',
    );
    expect(source).toContain('"$OVD420_CONTROL_PATH" verify');
    expect(source).not.toContain("dist/tools/xometryAuth.js");
    expect(source).not.toContain("dist/tools/probeXometryProfileAuth.js");
    expect(source).not.toContain("XOMETRY_PROFILE_SNAPSHOT_BUCKET");
  });

  it("atomically records the original failing stage and exit code", async () => {
    const source = await readFile(
      OVD410_RECOVERY_HOST_CONTRACT.startupScript,
      "utf8",
    );
    const statusDirectory = await mkdtemp(join(tmpdir(), "ovd410-startup-"));
    const statusPath = join(statusDirectory, "status.json");
    try {
      await writeFile(statusPath, "stale\n", { mode: 0o600 });
      const instrumentation = source
        .slice(
          source.indexOf("readonly STARTUP_STATUS="),
          source.indexOf("export DEBIAN_FRONTEND="),
        )
        .replace(OVD410_RECOVERY_HOST_CONTRACT.startupStatusPath, statusPath)
        .replace("(( EUID == 0 )) || return 77", ":")
        .replace('chown root:root "$status_tmp"', ":")
        .replace(
          'mv -fT -- "$status_tmp" "$STARTUP_STATUS"',
          'mv -f -- "$status_tmp" "$STARTUP_STATUS"',
        )
        .replace(
          'write_startup_status "$OVD410_STARTUP_STAGE" "$exit_code" || true',
          'write_startup_status "$OVD410_STARTUP_STAGE" "$exit_code"',
        );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -Eeuo pipefail
umask 077
${instrumentation}
set_startup_stage image-pull
fail_stage() { return 23; }
fail_stage`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(23);
      expect(
        await readFile(statusPath, "utf8"),
        `${result.stderr}\n${result.stdout}`,
      ).toBe(
        '{"stage":"image-pull","exitCode":23}\n',
      );
      expect((await stat(statusPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(statusDirectory)).toEqual(["status.json"]);
    } finally {
      await rm(statusDirectory, { recursive: true, force: true });
    }
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
    const fullRecoveryBlock = bashBlocks.find(
      (block) =>
        block.includes("ovd420-recovery-egress-control launch") &&
        block.includes("full-recovery"),
    );
    const startupProbeBlock = bashBlocks.find((block) =>
      block.includes("--startup-status"),
    );

    expect(bashBlocks.length).toBeGreaterThan(0);
    expect(bashBlocks.every((block) => block.startsWith("set -euo pipefail\n"))).toBe(
      true,
    );
    expect(section).toContain("gcloud storage objects list");
    expect(section).not.toContain("gcloud storage ls --all-versions");
    expect(section).toContain("Keep the reviewed production policy\nuncommitted");
    expect(section).toContain("OVD420_RECOVERY_EGRESS_POLICY_SHA256");
    expect(section).toContain(
      'OVD420_RECOVERY_EGRESS_POLICY_SHA256="$OVD420_RECOVERY_EGRESS_POLICY_SHA256"',
    );
    expect(section).toContain("ovd420-recovery-egress-control launch");
    expect(section).toContain("--network none");
    expect(section).not.toContain("--network bridge");
    expect(fullRecoveryBlock).toBeDefined();
    expect(startupProbeBlock).toBeDefined();
    expect(
      spawnSync("bash", ["-n"], {
        encoding: "utf8",
        input: startupProbeBlock,
      }).status,
    ).toBe(0);
    expect(startupProbeBlock).toContain(
      "readonly OVD410_STARTUP_OBSERVATION_SECONDS=1200",
    );
    expect(startupProbeBlock).toContain(
      "OVD410_STARTUP_DEADLINE=$((SECONDS + OVD410_STARTUP_OBSERVATION_SECONDS))",
    );
    expect(startupProbeBlock).toContain(
      "while (( SECONDS < OVD410_STARTUP_DEADLINE ))",
    );
    expect(startupProbeBlock).toContain(
      "readonly OVD410_STARTUP_STATUS_PATTERN=",
    );
    expect(startupProbeBlock).not.toContain("stage=*)");
    expect(startupProbeBlock).not.toContain("for _attempt in $(seq 1 12)");
    expect(startupProbeBlock).toContain("2>/dev/null");
    expect(startupProbeBlock).toContain("stage=ready exit=0");
    expect(startupProbeBlock).toContain("trap - EXIT");
    expect(startupProbeBlock).toContain("trap '' HUP INT TERM");
    expect(startupProbeBlock.indexOf("trap '' HUP INT TERM")).toBeLessThan(
      startupProbeBlock.indexOf("node scripts/teardown-ovd410-recovery-host.mjs"),
    );
    expect(startupProbeBlock).not.toContain("journalctl");
    expect(startupProbeBlock).not.toContain("get-serial-port-output");
    expect(section.indexOf("--startup-status")).toBeLessThan(
      section.indexOf("npm run verify:xometry-recovery-host"),
    );
    const probeDirectory = await mkdtemp(join(tmpdir(), "ovd410-probe-"));
    const probeBin = join(probeDirectory, "bin");
    const teardownMarker = join(probeDirectory, "teardown-called");
    try {
      await mkdir(probeBin, { recursive: true });
      const nodeStub = join(probeBin, "node");
      const sleepStub = join(probeBin, "sleep");
      await writeFile(
        nodeStub,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"--startup-status"* ]]; then
  printf '%s\\n' 'stage=image-pull exit=17'
  exit 1
fi
if [[ "$*" == *"teardown-ovd410-recovery-host.mjs"* ]]; then
  : >"$TEARDOWN_MARKER"
  exit 0
fi
exit 99
`,
      );
      await writeFile(sleepStub, "#!/usr/bin/env bash\nexit 0\n");
      await chmod(nodeStub, 0o700);
      await chmod(sleepStub, 0o700);
      const probeResult = spawnSync("bash", ["-c", startupProbeBlock], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${probeBin}:${process.env.PATH}`,
          TEARDOWN_MARKER: teardownMarker,
        },
      });
      expect(probeResult.status).toBe(1);
      expect(probeResult.stdout).toContain("stage=image-pull exit=17");
      expect(await readFile(teardownMarker, "utf8")).toBe("");
    } finally {
      await rm(probeDirectory, { recursive: true, force: true });
    }

    const deadlineProbeDirectory = await mkdtemp(
      join(tmpdir(), "ovd410-deadline-probe-"),
    );
    const deadlineProbeBin = join(deadlineProbeDirectory, "bin");
    const deadlineTeardownMarker = join(
      deadlineProbeDirectory,
      "teardown-called",
    );
    try {
      await mkdir(deadlineProbeBin, { recursive: true });
      const nodeStub = join(deadlineProbeBin, "node");
      const sleepStub = join(deadlineProbeBin, "sleep");
      await writeFile(
        nodeStub,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"--startup-status"* ]]; then
  printf '%s\\n' 'stage=image-pull exit=0'
  exit 1
fi
if [[ "$*" == *"teardown-ovd410-recovery-host.mjs"* ]]; then
  : >"$TEARDOWN_MARKER"
  exit 0
fi
exit 99
`,
      );
      await writeFile(
        sleepStub,
        "#!/usr/bin/env bash\nset -euo pipefail\n/bin/sleep 1\n",
      );
      await chmod(nodeStub, 0o700);
      await chmod(sleepStub, 0o700);
      const boundedDeadlineBlock = startupProbeBlock.replace(
        "readonly OVD410_STARTUP_OBSERVATION_SECONDS=1200",
        "readonly OVD410_STARTUP_OBSERVATION_SECONDS=2",
      );
      const deadlineStartedAt = Date.now();
      const deadlineResult = spawnSync("bash", ["-c", boundedDeadlineBlock], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${deadlineProbeBin}:${process.env.PATH}`,
          TEARDOWN_MARKER: deadlineTeardownMarker,
        },
      });
      const deadlineElapsedMs = Date.now() - deadlineStartedAt;
      expect(deadlineResult.status).toBe(1);
      expect(deadlineResult.stdout).toContain("stage=image-pull exit=0");
      expect(deadlineElapsedMs).toBeGreaterThanOrEqual(900);
      expect(deadlineElapsedMs).toBeLessThan(5_000);
      expect(await readFile(deadlineTeardownMarker, "utf8")).toBe("");

      await rm(deadlineTeardownMarker, { force: true });
      await writeFile(
        nodeStub,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"--startup-status"* ]]; then
  printf '%s\\n' 'stage=image-pull exit=0' 'untrusted-extra-output'
  exit 1
fi
if [[ "$*" == *"teardown-ovd410-recovery-host.mjs"* ]]; then
  : >"$TEARDOWN_MARKER"
  exit 0
fi
exit 99
`,
      );
      await chmod(nodeStub, 0o700);
      const malformedResult = spawnSync("bash", ["-c", boundedDeadlineBlock], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${deadlineProbeBin}:${process.env.PATH}`,
          TEARDOWN_MARKER: deadlineTeardownMarker,
        },
      });
      expect(malformedResult.status).toBe(1);
      expect(malformedResult.stdout).toBe("startup-status-unavailable\n");
      expect(malformedResult.stdout).not.toContain("untrusted-extra-output");
      expect(await readFile(deadlineTeardownMarker, "utf8")).toBe("");
    } finally {
      await rm(deadlineProbeDirectory, { recursive: true, force: true });
    }
    expect(fullRecoveryBlock).not.toContain("--network");
    expect(fullRecoveryBlock).toContain("full-recovery");
    expect(section).toContain("shares the dedicated");
    expect(section).toContain("host's IPC namespace");
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

  it("rejects a classifier payload hash mismatch before staging", async () => {
    const source = await readFile("docs/workflows/ovd410-stable-egress.md", "utf8");
    const gateStart = source.indexOf("OVD410_CLASSIFIER_ACTUAL_SHA256=\"$(");
    const gateEnd = source.indexOf("# Stage only the already-hashed bytes.", gateStart);
    const hashGate = source.slice(gateStart, gateEnd);
    const payload = "readonly OVD410_RECOVERY_MODE=classifier-only";
    const approvedHash = sha256Hex(`${payload}\n`);
    const runGate = (approved) => spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
OVD410_CLASSIFIER_PAYLOAD="$TEST_PAYLOAD"
OVD410_CLASSIFIER_PAYLOAD_SHA256="$TEST_APPROVED_HASH"
${hashGate}
printf '%s\\n' 'staging_allowed'`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_APPROVED_HASH: approved,
          TEST_PAYLOAD: payload,
        },
      },
    );

    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const accepted = runGate(approvedHash);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toBe("staging_allowed\n");

    const rejected = runGate("0".repeat(64));
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
  });
});
