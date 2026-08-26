import { describe, expect, it } from "vitest";
import {
  buildWorkerEgressManifest,
  runCli,
} from "./configure-xometry-worker-egress.mjs";
import { OVD410_PRODUCTION_CONTRACT } from "./xometry-stable-egress-contract.mjs";

const EXPECTED = {
  project: OVD410_PRODUCTION_CONTRACT.project,
  region: OVD410_PRODUCTION_CONTRACT.region,
  service: OVD410_PRODUCTION_CONTRACT.service,
  serviceAccount: OVD410_PRODUCTION_CONTRACT.serviceAccount,
  network: OVD410_PRODUCTION_CONTRACT.network,
  subnet: OVD410_PRODUCTION_CONTRACT.subnet,
  vpcEgress: "all-traffic",
};

function currentService() {
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
      name: EXPECTED.service,
      namespace: "123456789012",
      resourceVersion: "secret-server-version",
      uid: "server-uid",
      annotations: {
        "run.googleapis.com/ingress": "all",
        "run.googleapis.com/ingress-status": "all",
        "run.googleapis.com/operation-id": "operation-id",
        "run.googleapis.com/urls": "[\"https://service.example\"]",
      },
      labels: { "cloud.googleapis.com/location": EXPECTED.region },
    },
    spec: {
      template: {
        metadata: {
          name: "old-revision",
          annotations: {
            "autoscaling.knative.dev/minScale": "0",
            "autoscaling.knative.dev/maxScale": "1",
            "run.googleapis.com/cpu-throttling": "false",
            "run.googleapis.com/execution-environment": "gen2",
          },
        },
        spec: {
          containerConcurrency: 1,
          serviceAccountName: EXPECTED.serviceAccount,
          containers: [
            {
              image: `us-west1-docker.pkg.dev/synthetic/image@sha256:${"b".repeat(64)}`,
              env: [
                { name: "SUPABASE_URL", value: "https://synthetic.supabase.co" },
                { name: "WORKER_MODE", value: "live" },
                { name: "WORKER_LIVE_ADAPTERS", value: "xometry" },
                { name: "PLAYWRIGHT_CAPTURE_TRACE", value: "false" },
              ],
            },
          ],
        },
      },
      traffic: [{ latestRevision: true, percent: 100 }],
    },
    status: { latestReadyRevisionName: "old-revision" },
  };
}

function envValue(manifest, name) {
  return manifest.spec.template.spec.containers[0].env.find(
    (entry) => entry.name === name,
  )?.value;
}

describe("configuration-only worker egress manifest", () => {
  it("preserves the retained image while attaching bounded Direct VPC egress", () => {
    const manifest = buildWorkerEgressManifest(currentService(), EXPECTED);
    const annotations = manifest.spec.template.metadata.annotations;

    expect(manifest.spec.template.spec.containers[0].image).toBe(
      `us-west1-docker.pkg.dev/synthetic/image@sha256:${"b".repeat(64)}`,
    );
    expect(JSON.parse(annotations["run.googleapis.com/network-interfaces"])).toEqual([
      { network: EXPECTED.network, subnetwork: EXPECTED.subnet },
    ]);
    expect(annotations["run.googleapis.com/vpc-access-egress"]).toBe("all-traffic");
    expect(annotations["autoscaling.knative.dev/minScale"]).toBe("0");
    expect(annotations["autoscaling.knative.dev/maxScale"]).toBe("1");
    expect(manifest.spec.template.spec.containerConcurrency).toBe(1);
    expect(envValue(manifest, "WORKER_MODE")).toBe("live");
    expect(envValue(manifest, "WORKER_LIVE_ADAPTERS")).toBe("xometry");
    expect(envValue(manifest, "PLAYWRIGHT_CAPTURE_TRACE")).toBe("false");
    expect(manifest.metadata.resourceVersion).toBe("secret-server-version");
    expect(manifest.metadata).not.toHaveProperty("uid");
    expect(manifest).not.toHaveProperty("status");
    expect(manifest.spec.template.metadata).not.toHaveProperty("name");
    expect(manifest.metadata.annotations).not.toHaveProperty("run.googleapis.com/urls");
    expect(manifest.metadata.annotations["run.googleapis.com/ingress"]).toBe("all");
  });

  it("accepts an omitted minScale annotation and preserves the omission", () => {
    const service = currentService();
    delete service.spec.template.metadata.annotations[
      "autoscaling.knative.dev/minScale"
    ];

    const manifest = buildWorkerEgressManifest(service, EXPECTED);

    expect(manifest.spec.template.metadata.annotations).not.toHaveProperty(
      "autoscaling.knative.dev/minScale",
    );
    expect(
      manifest.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"],
    ).toBe("1");
    expect(manifest.spec.template.spec.containerConcurrency).toBe(1);
  });

  it("rejects a nonzero minScale annotation", () => {
    const service = currentService();
    service.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] = "1";

    expect(() => buildWorkerEgressManifest(service, EXPECTED)).toThrow(
      "current service safety contract is invalid",
    );
  });

  it("accepts an explicit zero service-level minScale and preserves it", () => {
    const service = currentService();
    delete service.spec.template.metadata.annotations[
      "autoscaling.knative.dev/minScale"
    ];
    service.metadata.annotations["run.googleapis.com/minScale"] = "0";

    const manifest = buildWorkerEgressManifest(service, EXPECTED);

    expect(manifest.metadata.annotations["run.googleapis.com/minScale"]).toBe("0");
    expect(manifest.spec.template.metadata.annotations).not.toHaveProperty(
      "autoscaling.knative.dev/minScale",
    );
  });

  it("rejects a nonzero service-level minScale", () => {
    const service = currentService();
    delete service.spec.template.metadata.annotations[
      "autoscaling.knative.dev/minScale"
    ];
    service.metadata.annotations["run.googleapis.com/minScale"] = "1";

    expect(() => buildWorkerEgressManifest(service, EXPECTED)).toThrow(
      "current service safety contract is invalid",
    );
  });

  it("accepts automatic service-level scaling without a manual instance count", () => {
    const service = currentService();
    delete service.spec.template.metadata.annotations[
      "autoscaling.knative.dev/minScale"
    ];
    service.metadata.annotations["run.googleapis.com/scalingMode"] = "automatic";

    const manifest = buildWorkerEgressManifest(service, EXPECTED);

    expect(manifest.metadata.annotations["run.googleapis.com/scalingMode"]).toBe(
      "automatic",
    );
    expect(manifest.metadata.annotations).not.toHaveProperty(
      "run.googleapis.com/manualInstanceCount",
    );
  });

  it("rejects manual scaling when minScale is omitted", () => {
    const service = currentService();
    delete service.spec.template.metadata.annotations[
      "autoscaling.knative.dev/minScale"
    ];
    service.metadata.annotations["run.googleapis.com/scalingMode"] = "manual";
    service.metadata.annotations["run.googleapis.com/manualInstanceCount"] = "1";

    expect(() => buildWorkerEgressManifest(service, EXPECTED)).toThrow(
      "current service safety contract is invalid",
    );
  });

  it("rejects a stray manual instance count in automatic mode", () => {
    const service = currentService();
    service.metadata.annotations["run.googleapis.com/scalingMode"] = "automatic";
    service.metadata.annotations["run.googleapis.com/manualInstanceCount"] = "1";

    expect(() => buildWorkerEgressManifest(service, EXPECTED)).toThrow(
      "current service safety contract is invalid",
    );
  });

  it("clears both Direct VPC annotations while preserving the same safety controls", () => {
    const service = currentService();
    service.spec.template.metadata.annotations[
      "run.googleapis.com/network-interfaces"
    ] = JSON.stringify([{ network: EXPECTED.network, subnetwork: EXPECTED.subnet }]);
    service.spec.template.metadata.annotations[
      "run.googleapis.com/vpc-access-egress"
    ] = "all-traffic";
    const manifest = buildWorkerEgressManifest(service, EXPECTED, {
      clearNetwork: true,
    });
    const annotations = manifest.spec.template.metadata.annotations;
    expect(annotations).not.toHaveProperty("run.googleapis.com/network-interfaces");
    expect(annotations).not.toHaveProperty("run.googleapis.com/vpc-access-egress");
    expect(manifest.spec.template.spec.containers[0].image).toContain("sha256:");
    expect(envValue(manifest, "WORKER_LIVE_ADAPTERS")).toBe("xometry");
  });

  it("refuses to turn an unsafe retained service into a live provider worker", () => {
    const service = currentService();
    service.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "WORKER_MODE",
    ).value = "simulate";
    expect(() => buildWorkerEgressManifest(service, EXPECTED)).toThrow(
      "current service safety contract is invalid",
    );
  });

  it("refuses attachment when Cloud Run invoker IAM enforcement is disabled", () => {
    const service = currentService();
    service.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] = "true";
    expect(() => buildWorkerEgressManifest(service, EXPECTED)).toThrow(
      "current service safety contract is invalid",
    );
  });

  it("requires the optimistic-concurrency version from the live service", () => {
    const service = currentService();
    delete service.metadata.resourceVersion;
    expect(() => buildWorkerEgressManifest(service, EXPECTED)).toThrow(
      "current service metadata is invalid",
    );
  });

  it("allows emergency detachment while preserving an otherwise drifted service", () => {
    const service = currentService();
    service.spec.template.spec.containers[0].env.find(
      (entry) => entry.name === "WORKER_MODE",
    ).value = "simulate";
    service.spec.template.metadata.annotations[
      "run.googleapis.com/network-interfaces"
    ] = JSON.stringify([{ network: EXPECTED.network, subnetwork: EXPECTED.subnet }]);
    const manifest = buildWorkerEgressManifest(service, EXPECTED, {
      clearNetwork: true,
    });
    expect(envValue(manifest, "WORKER_MODE")).toBe("simulate");
    expect(manifest.spec.template.metadata.annotations).not.toHaveProperty(
      "run.googleapis.com/network-interfaces",
    );
  });
});

describe("configuration-only worker egress CLI", () => {
  const env = {
    GOOGLE_CLOUD_PROJECT: EXPECTED.project,
    CLOUD_RUN_REGION: EXPECTED.region,
    SERVICE_NAME: EXPECTED.service,
    CLOUD_RUN_SERVICE_ACCOUNT: EXPECTED.serviceAccount,
    CLOUD_RUN_NETWORK: EXPECTED.network,
    CLOUD_RUN_SUBNET: EXPECTED.subnet,
    CLOUD_RUN_VPC_EGRESS: "all-traffic",
  };

  it("passes a retained-image manifest to the replace operation", async () => {
    let replaced = null;
    let output = "";
    const code = await runCli({
      args: [],
      env,
      output: { write: (value) => (output += value) },
      describeService: async () => currentService(),
      replaceService: async (manifest) => {
        replaced = manifest;
      },
    });
    expect(code).toBe(0);
    expect(replaced.spec.template.spec.containers[0].image).toContain("sha256:");
    expect(output).toBe(
      "Worker Direct VPC egress was configured with bounded controls preserved.\n",
    );
  });

  it("supports only the explicit clear-network rollback argument", async () => {
    let replaced = null;
    const code = await runCli({
      args: ["--clear-network"],
      env: {
        GOOGLE_CLOUD_PROJECT: EXPECTED.project,
        CLOUD_RUN_REGION: EXPECTED.region,
        SERVICE_NAME: EXPECTED.service,
        CLOUD_RUN_SERVICE_ACCOUNT: EXPECTED.serviceAccount,
      },
      output: { write: () => undefined },
      describeService: async () => currentService(),
      replaceService: async (manifest) => {
        replaced = manifest;
      },
    });
    expect(code).toBe(0);
    expect(replaced.spec.template.metadata.annotations).not.toHaveProperty(
      "run.googleapis.com/network-interfaces",
    );

    expect(
      await runCli({
        args: ["--unexpected"],
        env,
        output: { write: () => undefined },
      }),
    ).toBe(1);
  });

  it("fails closed without exposing cloud diagnostics", async () => {
    let output = "";
    const code = await runCli({
      args: [],
      env,
      output: { write: (value) => (output += value) },
      describeService: async () => {
        throw new Error("secret service metadata and 203.0.113.42");
      },
    });
    expect(code).toBe(1);
    expect(output).toBe(
      "Worker egress configuration failed; provider execution remains blocked.\n",
    );
  });

  it("reports an ambiguous outcome when replacement may have started", async () => {
    let output = "";
    const code = await runCli({
      args: [],
      env,
      output: { write: (value) => (output += value) },
      describeService: async () => currentService(),
      replaceService: async () => {
        throw new Error("client timeout after server acceptance");
      },
    });
    expect(code).toBe(1);
    expect(output).toBe(
      "Worker egress mutation outcome is unknown; run the stable-egress verifier before retrying.\n",
    );
  });
});
