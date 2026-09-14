// Shared in-memory synthetic resource fixtures. No transport or live state.
import { createHash } from "node:crypto";
import { manifestFixture, packet } from "./ovd419-diagnostic-test-fixtures.mjs";
import { compareCodeUnits, digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS, OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";

export const fullJobFixtures = (() => {
const PROJECT_NUMBER = "123456789";

function fixture() {
  const p = packet();
  const value = manifestFixture(p);
  value.spec.template.metadata.labels = {};
  value.metadata = {
    annotations: {
      "run.googleapis.com/client-name": "gcloud",
      "run.googleapis.com/client-version": "581.0.0",
      "run.googleapis.com/creator": "TEST_ONLY_operator@example.invalid",
      "run.googleapis.com/lastModifier": "TEST_ONLY_operator@example.invalid",
      "run.googleapis.com/operation-id": "12345678-1234-1234-1234-123456789abc",
    },
    creationTimestamp: "2026-09-10T15:00:00.000Z",
    generation: 7,
    labels: {
      "cloud.googleapis.com/location": TARGET.region,
      "run.googleapis.com/satisfiesPzs": "true",
    },
    name: TARGET.job,
    namespace: PROJECT_NUMBER,
    resourceVersion: "TEST_ONLY_7",
    selfLink: `/apis/run.googleapis.com/v1/namespaces/${PROJECT_NUMBER}/jobs/${TARGET.job}`,
    uid: "TEST_ONLY-job-uid",
  };
  value.status = {
    conditions: [{ status: "True", type: "Ready" }],
    executionCount: 20,
    latestCreatedExecution: {
      completionStatus: "EXECUTION_FAILED",
      completionTimestamp: "2026-09-10T15:02:00.000Z",
      creationTimestamp: "2026-09-10T15:01:00.000Z",
      name: `${TARGET.job}-test-only`,
    },
    observedGeneration: 7,
  };
  const raw = `\n${JSON.stringify(value, null, 2)}\n`;
  return { p, value, raw,
    options: { mode: "TEST_ONLY", packet: p, projectNumber: PROJECT_NUMBER } };
}

return { fixture, PROJECT_NUMBER };
})();

export const fullServiceFixtures = (() => {
const PROJECT_NUMBER = "123456789";
const SERVICE_URL = "https://overdrafter-cad-worker-test-only.us-west1.run.app";
const snapshotScope = { bucket: "fixture-bucket", object: "fixture/profile.tar.gz", maxBytes: "268435456" };
const networkAnnotations = () => ({
  "run.googleapis.com/network-interfaces": JSON.stringify([{ network: NETWORK.network, subnetwork: NETWORK.subnet }]),
  "run.googleapis.com/vpc-access-egress": "all-traffic",
  "autoscaling.knative.dev/maxScale": "1",
  "run.googleapis.com/cpu-throttling": "false",
  "run.googleapis.com/execution-environment": "gen2",
});

function environment(p) {
  return [
    { name: "SUPABASE_URL", value: "https://ozuatdcakezjtevztjlr.supabase.co" },
    { name: "WORKER_MODE", value: "live" },
    { name: "WORKER_LIVE_ADAPTERS", value: "xometry" },
    { name: "WORKER_NAME", value: TARGET.service },
    { name: "WORKER_POLL_INTERVAL_MS", value: "5000" },
    { name: "WORKER_BUILD_VERSION", value: p.baselineBuild },
    { name: "WORKER_HTTP_HOST", value: "0.0.0.0" },
    { name: "WORKER_TEMP_DIR", value: "/root/.cache/overdrafter-worker" },
    { name: "QUOTE_ARTIFACT_BUCKET", value: "quote-artifacts" },
    { name: "PLAYWRIGHT_HEADLESS", value: "true" },
    { name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" },
    { name: "PLAYWRIGHT_BROWSER_TIMEOUT_MS", value: "45000" },
    { name: "PLAYWRIGHT_DISABLE_SANDBOX", value: "true" },
    { name: "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", value: "true" },
    { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
    { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: snapshotScope.bucket },
    { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: snapshotScope.object },
    { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: snapshotScope.maxBytes },
    { name: "SUPABASE_SERVICE_ROLE_KEY", valueFrom: { secretKeyRef: { key: "latest", name: "supabase-service-role-key" } } },
  ];
}

function fixture() {
  const p = packet();
  const value = {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
      annotations: {
        "run.googleapis.com/ingress": "all",
        "run.googleapis.com/ingress-status": "all",
        "run.googleapis.com/operation-id": "12345678-1234-1234-1234-123456789abc",
        "run.googleapis.com/urls": JSON.stringify([SERVICE_URL]),
        "serving.knative.dev/creator": "TEST_ONLY_operator@example.invalid",
        "serving.knative.dev/lastModifier": "TEST_ONLY_operator@example.invalid",
      },
      creationTimestamp: "2026-09-10T15:00:00.000Z",
      generation: 8,
      labels: { "cloud.googleapis.com/location": TARGET.region, "run.googleapis.com/satisfiesPzs": "true" },
      name: TARGET.service,
      namespace: PROJECT_NUMBER,
      resourceVersion: "TEST_ONLY_8",
      selfLink: `/apis/serving.knative.dev/v1/namespaces/${PROJECT_NUMBER}/services/${TARGET.service}`,
      uid: "TEST_ONLY-service-uid",
    },
    spec: {
      template: {
        metadata: { annotations: networkAnnotations(), labels: {} },
        spec: {
          containerConcurrency: 1,
          containers: [{
            env: environment(p),
            image: p.baselineImage,
            ports: [{ containerPort: 8080, name: "http1" }],
            resources: { limits: { cpu: "2", memory: "2Gi" } },
            startupProbe: { failureThreshold: 1, periodSeconds: 240,
              tcpSocket: { port: 8080 }, timeoutSeconds: 240 },
          }],
          serviceAccountName: NETWORK.serviceAccount,
          timeoutSeconds: 3600,
        },
      },
      traffic: [{ latestRevision: true, percent: 100 }],
    },
    status: {
      address: { url: SERVICE_URL },
      conditions: [
        { lastTransitionTime: "2026-09-10T15:01:00.000Z", status: "True", type: "Ready" },
        { lastTransitionTime: "2026-09-10T15:01:00.000Z", status: "True", type: "ConfigurationsReady" },
        { lastTransitionTime: "2026-09-10T15:01:00.000Z", status: "True", type: "RoutesReady" },
      ],
      latestCreatedRevisionName: "overdrafter-cad-worker-test-only",
      latestReadyRevisionName: "overdrafter-cad-worker-test-only",
      observedGeneration: 8,
      traffic: [{ latestRevision: true, percent: 100, revisionName: "overdrafter-cad-worker-test-only" }],
      url: SERVICE_URL,
    },
  };
  const raw = `\n${JSON.stringify(value, null, 2)}\n`;
  return { p, value, raw, options: { mode: "TEST_ONLY", packet: p, projectNumber: PROJECT_NUMBER } };
}

return { fixture, PROJECT_NUMBER, SERVICE_URL, snapshotScope };
})();

export const completedExecutionFixtures = (() => {
const PROJECT_NUMBER = "123456789";
const EXECUTION = `${TARGET.job}-test-only`;
const EXECUTION_UID = "TEST_ONLY-execution-uid";
const MODULE_BYTES = Buffer.from("export const TEST_ONLY = true;\n");

function fixture() {
  const p = packet();
  p.artifacts.runtimeModule.sha256 = createHash("sha256").update(MODULE_BYTES).digest("hex");
  const baseTask = structuredClone(manifestFixture(p).spec.template.spec.template.spec);
  baseTask.containers[0].env.push({ name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" });
  const precondition = {
    project: TARGET.project, region: TARGET.region, job: TARGET.job,
    packetSha256: digest(p), runtimeModuleSha256: p.artifacts.runtimeModule.sha256,
    expiresAt: p.expiresAt, snapshotFingerprint: p.baseline.snapshot,
    jobIdentity: { uid: p.baseline.job.uid, generation: 2,
      configurationFingerprint: p.candidateConfiguration },
    executionInventory: { totalCount: p.baseline.inventory.length,
      fingerprint: digest([...p.baseline.inventory].sort(compareCodeUnits)) },
  };
  const realizedTask = structuredClone(baseTask);
  realizedTask.containers[0].args = ["--input-type=module", "-e",
    `await import("data:text/javascript;base64,${MODULE_BYTES.toString("base64")}")`];
  realizedTask.containers[0].env.push({ name: "OVD419_EXPECTED_PRECONDITIONS_B64",
    value: Buffer.from(JSON.stringify(precondition)).toString("base64url") });
  const filter = `resource.type="cloud_run_job"\nresource.labels.job_name="${TARGET.job}"\nresource.labels.location="${TARGET.region}"\nlabels."run.googleapis.com/execution_name"="${EXECUTION}"`;
  const log = new URL("https://console.cloud.google.com/logs/viewer");
  log.searchParams.set("project", TARGET.project);
  log.searchParams.set("advancedFilter", filter);
  const value = {
    apiVersion: "run.googleapis.com/v1", kind: "Execution",
    metadata: {
      annotations: {
        "run.googleapis.com/network-interfaces": JSON.stringify([{ network: NETWORK.network, subnetwork: NETWORK.subnet }]),
        "run.googleapis.com/vpc-access-egress": "all-traffic",
        "run.googleapis.com/execution-environment": "gen2",
        "run.googleapis.com/client-name": "gcloud",
        "run.googleapis.com/client-version": "581.0.0",
        "run.googleapis.com/operation-id": "12345678-1234-1234-1234-123456789abc",
        "run.googleapis.com/creator": "TEST_ONLY_operator@example.invalid",
        "run.googleapis.com/lastModifier": "TEST_ONLY_operator@example.invalid",
      },
      creationTimestamp: "2026-09-10T16:00:00.000000001Z", generation: 1,
      labels: {
        "cloud.googleapis.com/location": TARGET.region,
        "run.googleapis.com/job": TARGET.job,
        "run.googleapis.com/jobGeneration": "2",
        "run.googleapis.com/jobResourceVersion": "TEST_ONLY-j2",
        "run.googleapis.com/jobUid": p.baseline.job.uid,
        "run.googleapis.com/satisfiesPzs": "true",
      },
      name: EXECUTION, namespace: PROJECT_NUMBER,
      ownerReferences: [{ apiVersion: "run.googleapis.com/v1", blockOwnerDeletion: true,
        controller: true, kind: "Job", name: TARGET.job, uid: p.baseline.job.uid }],
      resourceVersion: "TEST_ONLY-e1",
      selfLink: `/apis/run.googleapis.com/v1/namespaces/${PROJECT_NUMBER}/executions/${EXECUTION}`,
      uid: EXECUTION_UID,
    },
    spec: { parallelism: 1, taskCount: 1, template: { spec: realizedTask } },
    status: {
      completionTime: "2026-09-10T16:02:00.000000004Z",
      conditions: [
        { lastTransitionTime: "2026-09-10T16:00:10.000000002Z", message: "Resources available",
          status: "True", type: "ResourcesAvailable" },
        { lastTransitionTime: "2026-09-10T16:00:20.000000002Z", message: "Execution started",
          status: "True", type: "Started" },
        { lastTransitionTime: "2026-09-10T16:00:30.000000002Z", message: "Container ready",
          status: "True", type: "ContainerReady" },
        { lastTransitionTime: "2026-09-10T16:02:00.000000003Z", message: "Task failed",
          reason: "NonZeroExitCode", status: "False", type: "Completed" },
      ],
      failedCount: 1, logUri: log.href, observedGeneration: 1,
      startTime: "2026-09-10T16:00:20.000000001Z",
    },
  };
  return { p, baseTask, precondition, value, raw: JSON.stringify(value, null, 2),
    options: { mode: "TEST_ONLY", packet: p, projectNumber: PROJECT_NUMBER,
      selected: { name: EXECUTION, uid: EXECUTION_UID } } };
}

return { fixture, PROJECT_NUMBER, EXECUTION, EXECUTION_UID, MODULE_BYTES };
})();

export const prefixEgressFixtures = (() => {
const TARGET = NETWORK;
const MEMBER = `serviceAccount:${TARGET.serviceAccount}`;
const IMAGE = `us-west1-docker.pkg.dev/TEST_ONLY/worker@sha256:${"c".repeat(64)}`;
const resource = (type, name) => `https://www.googleapis.com/compute/v1/projects/${TARGET.project}/${type}/${name}`;
const networkAnnotations = () => ({ "run.googleapis.com/network-interfaces": JSON.stringify([{ network: TARGET.network, subnetwork: TARGET.subnet }]), "run.googleapis.com/vpc-access-egress": "all-traffic" });

function compliantEgress(roleCount = 1) {
  const bindings = Array.from({ length: roleCount }, (_, index) => ({ role: index === 0 ? "roles/run.viewer" : `roles/TEST_ONLY.role${index}`, members: [MEMBER] }));
  return {
    service: {
      metadata: { name: TARGET.service, resourceVersion: "TEST_ONLY_service_v1" },
      spec: { traffic: [{ latestRevision: true, percent: 100 }], template: {
        metadata: { annotations: { ...networkAnnotations(), "autoscaling.knative.dev/maxScale": "1" } },
        spec: { containerConcurrency: 1, serviceAccountName: TARGET.serviceAccount, containers: [{ image: IMAGE, env: [
          { name: "WORKER_MODE", value: "live" }, { name: "WORKER_LIVE_ADAPTERS", value: "xometry" },
          { name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" }, { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
          { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "TEST_ONLY_private_bucket" },
          { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "profiles/TEST_ONLY.tgz" },
          { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "268435456" },
        ] }] },
      } },
      status: { latestCreatedRevisionName: "TEST_ONLY_ready", latestReadyRevisionName: "TEST_ONLY_ready",
        traffic: [{ latestRevision: true, percent: 100, revisionName: "TEST_ONLY_ready" }] },
    },
    job: {
      metadata: { name: TARGET.job, resourceVersion: "TEST_ONLY_job_v1", uid: "TEST_ONLY_uid", generation: 7 },
      spec: { template: { metadata: { annotations: networkAnnotations() }, spec: { taskCount: 1, parallelism: 1,
        template: { spec: { containers: [{ image: IMAGE, command: ["node"], args: ["dist/tools/probeXometryProfileAuth.js"], env: [
          { name: "WORKER_MODE", value: "simulate" }, { name: "WORKER_TEMP_DIR", value: "/root/.cache/overdrafter-worker" },
          { name: "XOMETRY_BROWSER_ENGINE", value: "camoufox" },
          { name: "XOMETRY_PROFILE_SNAPSHOT_BUCKET", value: "TEST_ONLY_private_bucket" },
          { name: "XOMETRY_PROFILE_SNAPSHOT_OBJECT", value: "profiles/TEST_ONLY.tgz" },
          { name: "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", value: "268435456" },
          { name: "PLAYWRIGHT_HEADLESS", value: "true" }, { name: "PLAYWRIGHT_BROWSER_TIMEOUT_MS", value: "45000" },
          { name: "PLAYWRIGHT_DISABLE_SANDBOX", value: "true" }, { name: "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", value: "true" },
        ] }], maxRetries: 0, serviceAccountName: TARGET.serviceAccount } },
      } } },
    },
    iamPolicy: { bindings: [] }, jobIamPolicy: { etag: "TEST_ONLY_empty" }, projectIamPolicy: { bindings },
    network: { name: TARGET.network, autoCreateSubnetworks: false, routingConfig: { routingMode: "REGIONAL" }, subnetworks: [resource(`regions/${TARGET.region}/subnetworks`, TARGET.subnet)], peerings: [] },
    subnet: { name: TARGET.subnet, network: resource("global/networks", TARGET.network), region: resource("regions", TARGET.region), ipCidrRange: TARGET.subnetRange, privateIpGoogleAccess: true, purpose: "PRIVATE", stackType: "IPV4_ONLY" },
    router: { name: TARGET.router, network: resource("global/networks", TARGET.network), region: resource("regions", TARGET.region), fingerprint: "TEST_ONLY_router_v1", bgpPeers: [] },
    nat: { name: TARGET.nat, natIpAllocateOption: "MANUAL_ONLY", natIps: [resource(`regions/${TARGET.region}/addresses`, TARGET.address)], drainNatIps: [], rules: [], sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS", subnetworks: [{ name: resource(`regions/${TARGET.region}/subnetworks`, TARGET.subnet), sourceIpRangesToNat: ["ALL_IP_RANGES"] }], logConfig: { enable: true, filter: "ERRORS_ONLY" }, tcpEstablishedIdleTimeoutSec: OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS },
    address: { id: TARGET.addressId, name: TARGET.address, addressType: "EXTERNAL", ipVersion: "IPV4", networkTier: "PREMIUM", status: "IN_USE", region: resource("regions", TARGET.region) },
    routes: [
      { name: "TEST_ONLY_default", network: resource("global/networks", TARGET.network), destRange: "0.0.0.0/0", priority: 1000, nextHopGateway: resource("global/gateways", "default-internet-gateway") },
      { name: "TEST_ONLY_subnet", network: resource("global/networks", TARGET.network), destRange: TARGET.subnetRange, priority: 0, nextHopNetwork: resource("global/networks", TARGET.network) },
    ],
    policyBasedRoutes: [], natMappings: [], jobExecutions: [],
  };
}

return { compliantEgress };
})();
