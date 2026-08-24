import { describe, expect, it } from "vitest";
import {
  collectStableEgressEvidence,
  evaluateStableEgressEvidence,
  runCli,
  validateStableEgressExpectations,
} from "./verify-xometry-stable-egress.mjs";
import { OVD410_PRODUCTION_CONTRACT } from "./xometry-stable-egress-contract.mjs";

const EXPECTED = {
  contractId: "synthetic-contract-v1",
  project: "synthetic-project",
  region: "us-west1",
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
};

function resource(type, name, project = EXPECTED.project) {
  return `https://www.googleapis.com/compute/v1/projects/${project}/${type}/${name}`;
}

function networkAnnotations(network = EXPECTED.network, subnet = EXPECTED.subnet) {
  return {
    "run.googleapis.com/network-interfaces": JSON.stringify([
      { network, subnetwork: subnet },
    ]),
    "run.googleapis.com/vpc-access-egress": "all-traffic",
  };
}

function compliantEvidence() {
  const retainedImage = `us-west1-docker.pkg.dev/synthetic/worker@sha256:${"c".repeat(64)}`;
  const evidence = {
    service: {
      metadata: { name: EXPECTED.service, resourceVersion: "service-version-1" },
      spec: {
        traffic: [{ latestRevision: true, percent: 100 }],
        template: {
          metadata: {
            annotations: {
              ...networkAnnotations(),
              "autoscaling.knative.dev/maxScale": "1",
            },
          },
          spec: {
            containerConcurrency: 1,
            serviceAccountName: EXPECTED.serviceAccount,
            containers: [
              {
                image: retainedImage,
                env: [
                  { name: "WORKER_MODE", value: "live" },
                  { name: "WORKER_LIVE_ADAPTERS", value: "xometry" },
                  { name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" },
                  { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
                  {
                    name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET",
                    value: "synthetic-private-bucket",
                  },
                  {
                    name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT",
                    value: "profiles/production.tgz",
                  },
                  { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "268435456" },
                ],
              },
            ],
          },
        },
      },
      status: {
        latestCreatedRevisionName: "synthetic-ready-revision",
        latestReadyRevisionName: "synthetic-ready-revision",
        traffic: [
          {
            latestRevision: true,
            percent: 100,
            revisionName: "synthetic-ready-revision",
          },
        ],
      },
    },
    job: {
      metadata: { name: EXPECTED.job, resourceVersion: "job-version-1" },
      spec: {
        template: {
          metadata: { annotations: networkAnnotations() },
          spec: {
            taskCount: 1,
            parallelism: 1,
            template: {
              spec: {
                containers: [
                  {
                    image: retainedImage,
                    command: ["node"],
                    args: ["dist/tools/probeXometryProfileAuth.js"],
                    env: [
                      { name: "WORKER_MODE", value: "simulate" },
                      {
                        name: "WORKER_TEMP_DIR",
                        value: "/root/.cache/overdrafter-worker",
                      },
                      { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
                      {
                        name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET",
                        value: "synthetic-private-bucket",
                      },
                      {
                        name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT",
                        value: "profiles/production.tgz",
                      },
                      {
                        name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES",
                        value: "268435456",
                      },
                      { name: "PLAYWRIGHT_HEADLESS", value: "true" },
                      { name: "PLAYWRIGHT_BROWSER_TIMEOUT_MS", value: "45000" },
                      { name: "PLAYWRIGHT_DISABLE_SANDBOX", value: "true" },
                      { name: "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", value: "true" },
                    ],
                  },
                ],
                maxRetries: 0,
                serviceAccountName: EXPECTED.serviceAccount,
              },
            },
          },
        },
      },
    },
    iamPolicy: { bindings: [] },
    jobIamPolicy: { etag: "empty-policy" },
    projectIamPolicy: { bindings: [] },
    network: {
      name: EXPECTED.network,
      autoCreateSubnetworks: false,
      routingConfig: { routingMode: "REGIONAL" },
      subnetworks: [resource(`regions/${EXPECTED.region}/subnetworks`, EXPECTED.subnet)],
    },
    subnet: {
      name: EXPECTED.subnet,
      network: resource("global/networks", EXPECTED.network),
      region: resource("regions", EXPECTED.region),
      ipCidrRange: EXPECTED.subnetRange,
      privateIpGoogleAccess: true,
      purpose: "PRIVATE",
      stackType: "IPV4_ONLY",
    },
    router: {
      name: EXPECTED.router,
      network: resource("global/networks", EXPECTED.network),
      region: resource("regions", EXPECTED.region),
      fingerprint: "router-fingerprint-1",
    },
    nat: {
      name: EXPECTED.nat,
      natIpAllocateOption: "MANUAL_ONLY",
      natIps: [resource(`regions/${EXPECTED.region}/addresses`, EXPECTED.address)],
      sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
      subnetworks: [
        {
          name: resource(`regions/${EXPECTED.region}/subnetworks`, EXPECTED.subnet),
          sourceIpRangesToNat: ["ALL_IP_RANGES"],
        },
      ],
      logConfig: { enable: true, filter: "ERRORS_ONLY" },
    },
    address: {
      name: EXPECTED.address,
      addressType: "EXTERNAL",
      ipVersion: "IPV4",
      networkTier: "PREMIUM",
      status: "IN_USE",
      region: resource("regions", EXPECTED.region),
      id: EXPECTED.addressId,
    },
    routes: [
      {
        name: "default-route-internet",
        destRange: "0.0.0.0/0",
        priority: 1000,
        network: resource("global/networks", EXPECTED.network),
        nextHopGateway: resource("global/gateways", "default-internet-gateway"),
      },
      {
        name: "default-route-subnet",
        destRange: EXPECTED.subnetRange,
        priority: 0,
        network: resource("global/networks", EXPECTED.network),
        nextHopNetwork: resource("global/networks", EXPECTED.network),
      },
    ],
    policyBasedRoutes: [],
    natMappings: [],
    jobExecutions: [],
  };
  evidence.confirmService = clone(evidence.service);
  evidence.confirmJob = clone(evidence.job);
  evidence.confirmRouter = clone(evidence.router);
  evidence.confirmNat = clone(evidence.nat);
  return evidence;
}

function clone(value) {
  return structuredClone(value);
}

function productionEvidence() {
  let encoded = JSON.stringify(compliantEvidence());
  const replacements = Object.keys(EXPECTED)
    .filter((key) => key !== "contractId")
    .map((key) => [String(EXPECTED[key]), `__CONTRACT_${key}__`, String(OVD410_PRODUCTION_CONTRACT[key])])
    .sort((left, right) => right[0].length - left[0].length);
  for (const [from, placeholder] of replacements) {
    encoded = encoded.split(from).join(placeholder);
  }
  for (const [, placeholder, to] of replacements) {
    encoded = encoded.split(placeholder).join(to);
  }
  return JSON.parse(encoded);
}

describe("stable egress expectation validation", () => {
  it("accepts names but never a raw address in the contract", () => {
    expect(validateStableEgressExpectations(EXPECTED)).toBe(true);
    expect(
      validateStableEgressExpectations({ ...EXPECTED, address: "203.0.113.42" }),
    ).toBe(false);
    expect(
      validateStableEgressExpectations({ ...EXPECTED, subnetRange: "10.81.0.0/24" }),
    ).toBe(false);
  });
});

describe("stable egress evidence evaluation", () => {
  it("accepts the exact private service, bounded Job, and manual-address NAT contract", () => {
    expect(evaluateStableEgressEvidence(compliantEvidence(), EXPECTED)).toEqual({
      ok: true,
      invalid: false,
      failures: [],
    });
  });

  it("accepts the regional IPv4 address shape when ipVersion is omitted", () => {
    const evidence = compliantEvidence();
    delete evidence.address.ipVersion;
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).ok).toBe(true);
  });

  it("accepts omitted Job parallelism only when the single task makes it effectively one", () => {
    const evidence = compliantEvidence();
    delete evidence.job.spec.template.spec.parallelism;
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).ok).toBe(true);
  });

  it("rejects dynamic or malformed service and Job egress", () => {
    const dynamic = compliantEvidence();
    dynamic.service.spec.template.metadata.annotations = {
      "autoscaling.knative.dev/maxScale": "1",
    };
    dynamic.job.spec.template.metadata.annotations = {};
    expect(evaluateStableEgressEvidence(dynamic, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "service_network_interfaces_missing_or_invalid",
        "service_egress_not_all_traffic",
        "job_network_interfaces_missing_or_invalid",
        "job_egress_not_all_traffic",
      ]),
    );

    const malformed = compliantEvidence();
    malformed.service.spec.template.metadata.annotations[
      "run.googleapis.com/network-interfaces"
    ] = "{not-json";
    expect(evaluateStableEgressEvidence(malformed, EXPECTED).failures).toContain(
      "service_network_interfaces_missing_or_invalid",
    );
  });

  it("rejects multiple or automatic NAT addresses", () => {
    const multiple = compliantEvidence();
    multiple.nat.natIps.push(
      resource(`regions/${EXPECTED.region}/addresses`, "unexpected-address"),
    );
    expect(evaluateStableEgressEvidence(multiple, EXPECTED).failures).toContain(
      "nat_reserved_address_mismatch",
    );

    const automatic = compliantEvidence();
    automatic.nat.natIpAllocateOption = "AUTO_ONLY";
    expect(evaluateStableEgressEvidence(automatic, EXPECTED).failures).toContain(
      "nat_address_allocation_not_manual",
    );
  });

  it("rejects wrong projects, regions, networks, and subnets", () => {
    const wrongProject = compliantEvidence();
    wrongProject.subnet.network = resource(
      "global/networks",
      EXPECTED.network,
      "different-project",
    );
    expect(evaluateStableEgressEvidence(wrongProject, EXPECTED).failures).toContain(
      "subnet_network_mismatch",
    );

    const wrongRegion = compliantEvidence();
    wrongRegion.router.region = resource("regions", "us-east1");
    expect(evaluateStableEgressEvidence(wrongRegion, EXPECTED).failures).toContain(
      "router_region_mismatch",
    );

    const wrongNetwork = compliantEvidence();
    wrongNetwork.service.spec.template.metadata.annotations = {
      ...networkAnnotations("different-network", EXPECTED.subnet),
      "autoscaling.knative.dev/maxScale": "1",
    };
    expect(evaluateStableEgressEvidence(wrongNetwork, EXPECTED).failures).toContain(
      "service_network_mismatch",
    );

    const wrongSubnet = compliantEvidence();
    wrongSubnet.job.spec.template.metadata.annotations = networkAnnotations(
      EXPECTED.network,
      "different-subnet",
    );
    expect(evaluateStableEgressEvidence(wrongSubnet, EXPECTED).failures).toContain(
      "job_subnet_mismatch",
    );
  });

  it("rejects service and Job network mismatch, connector drift, and unsafe scaling", () => {
    const evidence = compliantEvidence();
    evidence.job.spec.template.metadata.annotations = {
      ...networkAnnotations(EXPECTED.network, "different-subnet"),
      "run.googleapis.com/vpc-access-connector": "legacy-connector",
    };
    evidence.service.spec.template.spec.containerConcurrency = 2;
    evidence.service.spec.template.metadata.annotations[
      "autoscaling.knative.dev/maxScale"
    ] = "2";
    evidence.service.spec.template.metadata.annotations[
      "autoscaling.knative.dev/minScale"
    ] = "1";
    evidence.service.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "WORKER_LIVE_ADAPTERS",
    ).value = "xometry,fictiv";
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "job_subnet_mismatch",
        "job_connector_present",
        "service_concurrency_not_one",
        "service_max_scale_not_one",
        "service_min_scale_not_zero",
        "service_live_adapters_not_xometry_only",
      ]),
    );
  });

  it("rejects a not-ready or traffic-pinned service revision", () => {
    const evidence = compliantEvidence();
    evidence.service.status.latestCreatedRevisionName = "new-not-ready-revision";
    evidence.service.spec.traffic = [{ revisionName: "old-revision", percent: 100 }];
    evidence.service.status.traffic = [
      { revisionName: "old-revision", percent: 100 },
    ];
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "service_latest_revision_not_ready",
        "service_spec_traffic_not_latest_only",
        "service_status_traffic_not_ready_latest_only",
      ]),
    );
  });

  it("rejects mutable or divergent retained images", () => {
    const evidence = compliantEvidence();
    evidence.service.spec.template.spec.containers[0].image =
      "us-west1-docker.pkg.dev/synthetic/worker:latest";
    evidence.job.spec.template.spec.template.spec.containers[0].image =
      `us-west1-docker.pkg.dev/synthetic/other@sha256:${"d".repeat(64)}`;
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining(["service_image_not_immutable"]),
    );

    const divergent = compliantEvidence();
    divergent.job.spec.template.spec.template.spec.containers[0].image =
      `us-west1-docker.pkg.dev/synthetic/other@sha256:${"d".repeat(64)}`;
    expect(evaluateStableEgressEvidence(divergent, EXPECTED).failures).toContain(
      "service_job_image_mismatch",
    );
  });

  it("rejects auth Job command, snapshot-runtime, or secret-environment drift", () => {
    const evidence = compliantEvidence();
    const container = evidence.job.spec.template.spec.template.spec.containers[0];
    container.args = ["dist/index.js"];
    container.env.find(
      (entry) => entry.name === "XOMETRY_BROWSER_ENGINE",
    ).value = "playwright";
    container.env.push({ name: "SUPABASE_SERVICE_ROLE_KEY", value: "forbidden" });
    container.env.push({ name: "UNEXPECTED_PROVIDER_SETTING", value: "drift" });
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "job_command_not_bounded_auth_probe",
        "job_snapshot_runtime_not_bounded",
        "job_forbidden_environment_present",
        "job_environment_not_allowlisted",
      ]),
    );
  });

  it("rejects missing or unsafe values within the Job environment allowlist", () => {
    const evidence = compliantEvidence();
    const container = evidence.job.spec.template.spec.template.spec.containers[0];
    container.env = container.env.filter((entry) => entry.name !== "WORKER_MODE");
    container.env.find((entry) => entry.name === "PLAYWRIGHT_HEADLESS").value = "false";
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toContain(
      "job_environment_not_allowlisted",
    );
  });

  it("rejects divergent service/Job profile identity and legacy service credentials", () => {
    const evidence = compliantEvidence();
    evidence.job.spec.template.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "XOMETRY_PROFILE_SNAPSHOT_OBJECT",
    ).value = "profiles/different.tgz";
    evidence.job.spec.template.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES",
    ).value = "1048576";
    evidence.service.spec.template.spec.containers[0].env.push({
      name: "XOMETRY_STORAGE_STATE_JSON",
      value: "legacy",
    });
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "service_job_profile_runtime_mismatch",
        "service_legacy_profile_environment_present",
      ]),
    );
  });

  it("rejects public invocation and Job retry or parallelism drift", () => {
    const evidence = compliantEvidence();
    evidence.iamPolicy.bindings = [
      { role: "roles/run.invoker", members: ["allUsers"] },
    ];
    evidence.job.spec.template.spec.parallelism = 2;
    evidence.job.spec.template.spec.template.spec.maxRetries = 1;
    evidence.jobIamPolicy.bindings = [
      { role: "roles/run.invoker", members: ["allAuthenticatedUsers"] },
    ];
    evidence.projectIamPolicy.bindings = [
      { role: "roles/viewer", members: ["allUsers"] },
    ];
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "service_public_invocation_present",
        "job_public_execution_present",
        "project_public_principal_present",
        "job_parallelism_not_one",
        "job_max_retries_not_zero",
      ]),
    );
  });

  it("rejects disabled Cloud Run invoker IAM enforcement even with empty IAM bindings", () => {
    const evidence = compliantEvidence();
    evidence.service.metadata.annotations = {
      "run.googleapis.com/invoker-iam-disabled": "true",
    };
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toContain(
      "service_invoker_iam_check_disabled",
    );
  });

  it("rejects malformed IAM evidence instead of treating it as private", () => {
    const evidence = compliantEvidence();
    evidence.iamPolicy.bindings = [{ role: "roles/run.invoker", members: "allUsers" }];
    evidence.jobIamPolicy.bindings = [{ members: [] }];
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining(["service_iam_policy_invalid", "job_iam_policy_invalid"]),
    );
  });

  it("rejects broad NAT scope, wrong subnet, and unbounded logging", () => {
    const evidence = compliantEvidence();
    evidence.nat.sourceSubnetworkIpRangesToNat = "ALL_SUBNETWORKS_ALL_IP_RANGES";
    evidence.nat.subnetworks[0].name = resource(
      `regions/${EXPECTED.region}/subnetworks`,
      "different-subnet",
    );
    evidence.nat.subnetworks[0].sourceIpRangesToNat = ["PRIMARY_IP_RANGE"];
    evidence.nat.logConfig = { enable: true, filter: "ALL" };
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "nat_subnet_scope_not_explicit",
        "nat_subnet_mismatch",
        "nat_subnet_range_incomplete",
        "nat_error_logging_not_bounded",
      ]),
    );
  });

  it("rejects network routing and subnet shape drift", () => {
    const evidence = compliantEvidence();
    evidence.network.routingConfig.routingMode = "GLOBAL";
    evidence.subnet.ipCidrRange = "10.81.1.0/26";
    evidence.subnet.purpose = "PRIVATE_SERVICE_CONNECT";
    evidence.subnet.stackType = "IPV4_IPV6";
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "network_routing_not_regional",
        "subnet_range_mismatch",
        "subnet_purpose_not_private",
        "subnet_not_ipv4_only",
      ]),
    );
  });

  it("rejects competing routes, peerings, BGP peers, or policy routes", () => {
    const evidence = compliantEvidence();
    evidence.routes.push({
      name: "competing-default",
      destRange: "0.0.0.0/0",
      priority: 900,
      nextHopIp: "10.81.0.2",
    });
    evidence.network.peerings = [{ name: "unexpected-peer" }];
    evidence.router.bgpPeers = [{ name: "unexpected-bgp-peer" }];
    evidence.policyBasedRoutes = [
      { network: resource("global/networks", EXPECTED.network) },
    ];
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "effective_route_inventory_mismatch",
        "network_peering_present_or_invalid",
        "router_bgp_peer_present_or_invalid",
        "policy_based_route_present",
      ]),
    );
  });

  it("rejects a route returned from a similarly named network", () => {
    const evidence = compliantEvidence();
    evidence.routes[0].network = resource("global/networks", "xometry-egress-shadow");
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toContain(
      "route_network_mismatch",
    );
  });

  it("rejects address recreation, NAT drains, active mappings, or active Job executions", () => {
    const evidence = compliantEvidence();
    evidence.address.id = "987654321";
    evidence.address.status = "RESERVED";
    evidence.nat.drainNatIps = [resource(`regions/${EXPECTED.region}/addresses`, "old")];
    evidence.natMappings = [{ instanceName: "unexpected-instance" }];
    evidence.jobExecutions = [{ metadata: { name: "active" }, status: { runningCount: 1 } }];
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toEqual(
      expect.arrayContaining([
        "address_identity_mismatch",
        "address_not_in_use",
        "nat_draining_address_present_or_invalid",
        "nat_mapping_inventory_not_quiescent",
        "job_execution_inventory_not_quiescent",
      ]),
    );
  });

  it("rejects evidence that changes during collection", () => {
    const evidence = compliantEvidence();
    evidence.confirmService.metadata.resourceVersion = "service-version-2";
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toContain(
      "evidence_changed_during_collection",
    );
  });

  it("fails closed for malformed cloud metadata", () => {
    expect(evaluateStableEgressEvidence(null, EXPECTED)).toEqual({
      ok: false,
      invalid: true,
      failures: ["invalid_evidence"],
    });
    const evidence = compliantEvidence();
    evidence.nat = "not-an-object";
    expect(evaluateStableEgressEvidence(evidence, EXPECTED).failures).toContain(
      "nat_metadata_invalid",
    );
  });
});

describe("stable egress live collector", () => {
  it("uses only read-only describe and IAM-policy commands", async () => {
    const fixtures = compliantEvidence();
    const calls = [];
    const byPrefix = new Map([
      ["run services describe", fixtures.service],
      ["run jobs describe", fixtures.job],
      ["run services get-iam-policy", fixtures.iamPolicy],
      ["run jobs get-iam-policy", fixtures.jobIamPolicy],
      ["projects get-iam-policy", fixtures.projectIamPolicy],
      ["compute networks describe", fixtures.network],
      ["compute networks subnets describe", fixtures.subnet],
      ["compute routers describe", fixtures.router],
      ["compute routers nats describe", fixtures.nat],
      ["compute addresses describe", fixtures.address],
      ["compute routes list", fixtures.routes],
      ["network-connectivity policy-based-routes list", fixtures.policyBasedRoutes],
      ["compute routers get-nat-mapping-info", fixtures.natMappings],
      ["run jobs executions list", fixtures.jobExecutions],
    ]);
    const runCommand = async (_bin, args) => {
      calls.push(args);
      const match = [...byPrefix.entries()].find(([prefix]) =>
        args.join(" ").startsWith(prefix),
      );
      if (!match) throw new Error("unexpected command");
      return clone(match[1]);
    };

    const result = await collectStableEgressEvidence(EXPECTED, { runCommand });
    expect(evaluateStableEgressEvidence(result, EXPECTED).ok).toBe(true);
    expect(calls).toHaveLength(18);
    const mutatingVerbs = ["create", "delete", "deploy", "execute", "replace", "update"];
    for (const call of calls) {
      for (const verb of mutatingVerbs) {
        expect(call, call.join(" ")).not.toContain(verb);
      }
      expect(call.join(" ")).not.toContain("ipAddress");
    }
  });
});

describe("stable egress verifier CLI", () => {
  const env = {
    GOOGLE_CLOUD_PROJECT: OVD410_PRODUCTION_CONTRACT.project,
    CLOUD_RUN_REGION: OVD410_PRODUCTION_CONTRACT.region,
    CLOUD_RUN_NETWORK: OVD410_PRODUCTION_CONTRACT.network,
    CLOUD_RUN_SUBNET: OVD410_PRODUCTION_CONTRACT.subnet,
    CLOUD_RUN_SUBNET_RANGE: OVD410_PRODUCTION_CONTRACT.subnetRange,
    CLOUD_RUN_ROUTER: OVD410_PRODUCTION_CONTRACT.router,
    CLOUD_RUN_NAT: OVD410_PRODUCTION_CONTRACT.nat,
    CLOUD_RUN_NAT_ADDRESS: OVD410_PRODUCTION_CONTRACT.address,
    CLOUD_RUN_NAT_ADDRESS_ID: OVD410_PRODUCTION_CONTRACT.addressId,
    SERVICE_NAME: OVD410_PRODUCTION_CONTRACT.service,
    XOMETRY_AUTH_PROBE_JOB_NAME: OVD410_PRODUCTION_CONTRACT.job,
    CLOUD_RUN_SERVICE_ACCOUNT: OVD410_PRODUCTION_CONTRACT.serviceAccount,
  };

  it("emits only a sanitized pass summary", async () => {
    let output = "";
    const code = await runCli({
      env,
      output: { write: (value) => (output += value) },
      collectEvidence: async () => productionEvidence(),
    });
    expect(code, output).toBe(0);
    expect(output).toContain("verification passed");
    expect(output).not.toContain(EXPECTED.address);
    expect(output).not.toContain("203.0.113.42");
  });

  it("emits sanitized failure codes without raw addresses or cloud diagnostics", async () => {
    let output = "";
    const evidence = productionEvidence();
    evidence.nat.natIpAllocateOption = "AUTO_ONLY";
    const code = await runCli({
      env,
      output: { write: (value) => (output += value) },
      collectEvidence: async () => evidence,
    });
    expect(code).toBe(1);
    expect(output).toContain("nat_address_allocation_not_manual");
    expect(output).not.toContain(EXPECTED.address);
    expect(output).not.toContain("203.0.113.42");
  });

  it("fails closed without echoing a collector exception", async () => {
    let output = "";
    const code = await runCli({
      env,
      output: { write: (value) => (output += value) },
      collectEvidence: async () => {
        throw new Error("PERMISSION_DENIED for secret-project and 203.0.113.42");
      },
    });
    expect(code).toBe(2);
    expect(output).toBe("Stable egress metadata collection failed; failing closed.\n");
  });

  it("rejects a syntactically valid target that is not the checked-in production contract", async () => {
    let output = "";
    const code = await runCli({
      env: { ...env, GOOGLE_CLOUD_PROJECT: "different-project" },
      output: { write: (value) => (output += value) },
      collectEvidence: async () => productionEvidence(),
    });
    expect(code).toBe(2);
    expect(output).toBe("Stable egress verifier configuration is invalid; failing closed.\n");
  });
});
