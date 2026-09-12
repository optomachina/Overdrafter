import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSyntheticFullService } from "./ovd419-acquisition-service.mjs";
import { packet } from "./ovd419-diagnostic-test-fixtures.mjs";
import { digest, TARGET } from "./ovd419-job-diagnostic.mjs";
import { OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";

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

describe("synthetic full Service acquisition contract", () => {
  it("returns exact bytes and a deeply frozen credential-free projection", () => {
    const { p, value, raw, options } = fixture();
    const result = validateSyntheticFullService(raw, options);
    expect(result).toEqual({
      schema: "OVD419-SYNTHETIC-FULL-SERVICE-NOT-AUTHORITY-v1",
      kind: "service",
      raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      projection: {
        identity: { name: TARGET.service, uid: value.metadata.uid, generation: 8,
          resourceVersion: value.metadata.resourceVersion, projectNumber: PROJECT_NUMBER },
        image: p.baselineImage,
        workerBuild: p.baselineBuild,
        snapshotScope,
        secretReference: { name: "supabase-service-role-key", key: "latest" },
        resources: { cpu: "2", memory: "2Gi", timeoutSeconds: 3600, containerConcurrency: 1, port: 8080 },
        startupProbeFingerprint: digest(value.spec.template.spec.containers[0].startupProbe),
        configurationFingerprint: digest({ name: TARGET.service, spec: value.spec }),
        statusFingerprint: digest(value.status),
        readyRevision: "overdrafter-cad-worker-test-only",
        url: SERVICE_URL,
      },
      transportQualified: false,
      fullAcquisitionQualified: false,
      privateBindingReady: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projection)).toBe(true);
    expect(Object.isFrozen(result.projection.snapshotScope)).toBe(true);
    expect(JSON.stringify(result.projection)).not.toContain("TEST_ONLY_operator");
  });

  it("accepts representation reordering while retaining its exact configuration fingerprint", () => {
    const first = fixture(), second = fixture();
    second.value.spec.template.spec.containers[0].env.reverse();
    const one = validateSyntheticFullService(JSON.stringify(first.value), first.options);
    const two = validateSyntheticFullService(JSON.stringify(second.value), second.options);
    expect(two.projection.snapshotScope).toEqual(one.projection.snapshotScope);
    expect(two.projection.configurationFingerprint).not.toBe(one.projection.configurationFingerprint);
  });

  it.each([
    ["root", value => { value.unknown = true; }],
    ["metadata", value => { value.metadata.unknown = true; }],
    ["root annotation", value => { value.metadata.annotations.TEST_ONLY = "TEST_ONLY"; }],
    ["root label", value => { value.metadata.labels.TEST_ONLY = "TEST_ONLY"; }],
    ["spec", value => { value.spec.unknown = true; }],
    ["template", value => { value.spec.template.unknown = true; }],
    ["template metadata name absent from observed shape", value => { value.spec.template.metadata.name = "TEST_ONLY"; }],
    ["template annotation", value => { value.spec.template.metadata.annotations.TEST_ONLY = "TEST_ONLY"; }],
    ["template label", value => { value.spec.template.metadata.labels.TEST_ONLY = "TEST_ONLY"; }],
    ["template spec", value => { value.spec.template.spec.unknown = true; }],
    ["container", value => { value.spec.template.spec.containers[0].unknown = true; }],
    ["environment", value => { value.spec.template.spec.containers[0].env[0].unknown = true; }],
    ["port", value => { value.spec.template.spec.containers[0].ports[0].unknown = true; }],
    ["resources", value => { value.spec.template.spec.containers[0].resources.unknown = true; }],
    ["resource limit", value => { value.spec.template.spec.containers[0].resources.limits.gpu = "1"; }],
    ["startup probe", value => { value.spec.template.spec.containers[0].startupProbe.unknown = true; }],
    ["status", value => { value.status.unknown = true; }],
    ["condition", value => { value.status.conditions[0].unknown = true; }],
    ["status traffic", value => { value.status.traffic[0].unknown = true; }],
  ])("rejects an unsupported %s field", (_, mutate) => {
    const { value, options } = fixture(); mutate(value);
    expect(() => validateSyntheticFullService(JSON.stringify(value), options)).toThrow(/^acquisition_full_service_rejected$/);
  });

  it.each([
    ["api version", value => { value.apiVersion = "run.googleapis.com/v1"; }],
    ["kind", value => { value.kind = "Job"; }],
    ["name", value => { value.metadata.name = "TEST_ONLY"; }],
    ["namespace", value => { value.metadata.namespace = "987654321"; }],
    ["self link", value => { value.metadata.selfLink += "-other"; }],
    ["generation", value => { value.metadata.generation = 0; }],
    ["observed generation", value => { value.status.observedGeneration = 7; }],
    ["ingress", value => { value.metadata.annotations["run.googleapis.com/ingress"] = "internal"; }],
    ["invoker IAM", value => { value.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] = "true"; }],
    ["root URL", value => { value.metadata.annotations["run.googleapis.com/urls"] = JSON.stringify(["https://other.run.app"]); }],
    ["root URL annotation type", value => { value.metadata.annotations["run.googleapis.com/urls"] = [JSON.stringify([SERVICE_URL])]; }],
    ["operation ID annotation type", value => { value.metadata.annotations["run.googleapis.com/operation-id"] = ["12345678-1234-1234-1234-123456789abc"]; }],
    ["network", value => { value.spec.template.metadata.annotations["run.googleapis.com/network-interfaces"] = "[]"; }],
    ["max scale", value => { value.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"] = "2"; }],
    ["CPU throttling", value => { value.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"] = "true"; }],
    ["containers", value => { value.spec.template.spec.containers.push(structuredClone(value.spec.template.spec.containers[0])); }],
    ["concurrency", value => { value.spec.template.spec.containerConcurrency = 2; }],
    ["service account", value => { value.spec.template.spec.serviceAccountName = "TEST_ONLY@example.invalid"; }],
    ["timeout", value => { value.spec.template.spec.timeoutSeconds = 3599; }],
    ["image", value => { value.spec.template.spec.containers[0].image = "TEST_ONLY"; }],
    ["ports", value => { value.spec.template.spec.containers[0].ports.push({ containerPort: 8081, name: "http2" }); }],
    ["resource", value => { value.spec.template.spec.containers[0].resources.limits.cpu = "4"; }],
    ["probe port", value => { value.spec.template.spec.containers[0].startupProbe.tcpSocket.port = 8081; }],
    ["environment name", value => { value.spec.template.spec.containers[0].env.push({ name: "TEST_ONLY", value: "TEST_ONLY" }); }],
    ["duplicate environment", value => { value.spec.template.spec.containers[0].env.push({ ...value.spec.template.spec.containers[0].env[0] }); }],
    ["runtime mode", value => { value.spec.template.spec.containers[0].env.find(x => x.name === "WORKER_MODE").value = "simulate"; }],
    ["worker build", value => { value.spec.template.spec.containers[0].env.find(x => x.name === "WORKER_BUILD_VERSION").value = "a".repeat(40); }],
    ["snapshot bucket type", value => { value.spec.template.spec.containers[0].env.find(x => x.name === "XOMETRY_PROFILE_SNAPSHOT_BUCKET").value = 123; }],
    ["snapshot max-bytes type", value => { value.spec.template.spec.containers[0].env.find(x => x.name === "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES").value = [268435456]; }],
    ["direct secret", value => { value.spec.template.spec.containers[0].env.find(x => x.name === "SUPABASE_SERVICE_ROLE_KEY").value = "TEST_ONLY"; }],
    ["secret name", value => { value.spec.template.spec.containers[0].env.find(x => x.name === "SUPABASE_SERVICE_ROLE_KEY").valueFrom.secretKeyRef.name = "other"; }],
    ["spec traffic", value => { value.spec.traffic[0].percent = 99; }],
    ["missing Ready", value => { value.status.conditions = value.status.conditions.filter(x => x.type !== "Ready"); }],
    ["False Ready", value => { value.status.conditions.find(x => x.type === "Ready").status = "False"; }],
    ["Unknown Ready", value => { value.status.conditions.find(x => x.type === "Ready").status = "Unknown"; }],
    ["duplicate condition", value => { value.status.conditions.push({ ...value.status.conditions[0] }); }],
    ["latest revision mismatch", value => { value.status.latestCreatedRevisionName = "other-revision"; }],
    ["status traffic", value => { value.status.traffic[0].latestRevision = false; }],
    ["address URL", value => { value.status.address.url = "https://other.run.app"; }],
    ["status URL", value => { value.status.url = "http://overdrafter.invalid"; }],
    ["startup probe timing", value => { value.spec.template.spec.containers[0].startupProbe.periodSeconds = 1; }],
  ])("rejects inconsistent %s", (_, mutate) => {
    const { value, options } = fixture(); mutate(value);
    expect(() => validateSyntheticFullService(JSON.stringify(value), options)).toThrow(/^acquisition_full_service_rejected$/);
  });

  it("rejects an invalid packet build even when the environment matches it", () => {
    const { value, options } = fixture();
    options.packet.baselineBuild = "not-a-commit";
    value.spec.template.spec.containers[0].env.find(x => x.name === "WORKER_BUILD_VERSION").value = "not-a-commit";
    expect(() => validateSyntheticFullService(JSON.stringify(value), options)).toThrow(/^acquisition_full_service_rejected$/);
  });

  it("rejects a numeric secret-version binding even when the reference matches it", () => {
    const { value, options } = fixture();
    options.packet.baseline.secretVersion = 123;
    value.spec.template.spec.containers[0].env.find(x => x.name === "SUPABASE_SERVICE_ROLE_KEY")
      .valueFrom.secretKeyRef.key = 123;
    expect(() => validateSyntheticFullService(JSON.stringify(value), options)).toThrow(/^acquisition_full_service_rejected$/);
  });

  it("rejects parser-normalized noncanonical Service URLs", () => {
    const { value, options } = fixture();
    const noncanonical = `\n${SERVICE_URL}`;
    value.status.url = noncanonical;
    value.status.address.url = noncanonical;
    value.metadata.annotations["run.googleapis.com/urls"] = JSON.stringify([noncanonical]);
    expect(() => validateSyntheticFullService(JSON.stringify(value), options)).toThrow(/^acquisition_full_service_rejected$/);
  });

  it("rejects duplicate decoded JSON fields, malformed input and excess bytes", () => {
    const { value, options } = fixture(); const ordinary = JSON.stringify(value);
    for (const raw of [ordinary.replace('"kind":"Service"', '"kind":"Service","k\\u0069nd":"Service"'),
      "not-json", "null", `${ordinary}${" ".repeat(4194304)}`]) {
      expect(() => validateSyntheticFullService(raw, options)).toThrow(/^acquisition_full_service_rejected$/);
    }
  });

  it("rejects unknown options, production mode and invalid project-number binding", () => {
    const { raw, options } = fixture();
    for (const invalid of [undefined, {}, { ...options, mode: "PRODUCTION" },
      { ...options, trusted: true }, { ...options, projectNumber: TARGET.project }]) {
      expect(() => validateSyntheticFullService(raw, invalid)).toThrow(/^acquisition_full_service_rejected$/);
    }
  });
});
