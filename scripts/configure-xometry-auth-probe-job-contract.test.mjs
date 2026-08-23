import { describe, expect, it } from "vitest";
import {
  buildAuthProbeJobManifest,
  runCli,
} from "./configure-xometry-auth-probe-job.mjs";
import { OVD410_PRODUCTION_CONTRACT } from "./xometry-stable-egress-contract.mjs";

const EXPECTED = {
  ...OVD410_PRODUCTION_CONTRACT,
  vpcEgress: "all-traffic",
  snapshotBucket: "synthetic-private-bucket",
  snapshotObject: "profiles/production.tgz",
  snapshotMaxBytes: "268435456",
};

function currentJob() {
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "Job",
    metadata: {
      name: EXPECTED.job,
      resourceVersion: "job-resource-version-1",
      uid: "server-uid",
      labels: { "cloud.googleapis.com/location": EXPECTED.region },
    },
    spec: {
      template: {
        metadata: {
          annotations: { "run.googleapis.com/execution-environment": "gen2" },
        },
        spec: {
          taskCount: 2,
          parallelism: 2,
          template: {
            spec: {
              maxRetries: 1,
              serviceAccountName: EXPECTED.serviceAccount,
              containers: [
                {
                  image: `us-west1-docker.pkg.dev/synthetic/job@sha256:${"a".repeat(64)}`,
                  command: ["node"],
                  args: ["dist/index.js"],
                  env: [{ name: "SUPABASE_SERVICE_ROLE_KEY", value: "legacy" }],
                },
              ],
            },
          },
        },
      },
    },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  };
}

function envValue(manifest, name) {
  return manifest.spec.template.spec.template.spec.containers[0].env.find(
    (entry) => entry.name === name,
  )?.value;
}

describe("configuration-only authentication Job manifest", () => {
  it("pins the bounded probe while retaining image and optimistic-concurrency version", () => {
    const manifest = buildAuthProbeJobManifest(currentJob(), EXPECTED);
    const template = manifest.spec.template;
    const executionSpec = template.spec.template.spec;
    const [container] = executionSpec.containers;

    expect(manifest.metadata.resourceVersion).toBe("job-resource-version-1");
    expect(manifest.metadata).not.toHaveProperty("uid");
    expect(manifest).not.toHaveProperty("status");
    expect(container.image).toContain("@sha256:");
    expect(container.command).toEqual(["node"]);
    expect(container.args).toEqual(["dist/tools/probeXometryProfileAuth.js"]);
    expect(template.spec.taskCount).toBe(1);
    expect(template.spec.parallelism).toBe(1);
    expect(executionSpec.maxRetries).toBe(0);
    expect(envValue(manifest, "XOMETRY_BROWSER_ENGINE")).toBe("camoufox");
    expect(envValue(manifest, "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES")).toBe(
      EXPECTED.snapshotMaxBytes,
    );
    expect(container.env.map((entry) => entry.name)).not.toContain(
      "SUPABASE_SERVICE_ROLE_KEY",
    );
    expect(
      JSON.parse(template.metadata.annotations["run.googleapis.com/network-interfaces"]),
    ).toEqual([{ network: EXPECTED.network, subnetwork: EXPECTED.subnet }]);
    expect(template.metadata.annotations["run.googleapis.com/vpc-access-egress"]).toBe(
      "all-traffic",
    );
  });

  it("allows emergency detachment without rewriting drifted execution settings", () => {
    const job = currentJob();
    job.spec.template.metadata.annotations[
      "run.googleapis.com/network-interfaces"
    ] = JSON.stringify([{ network: EXPECTED.network, subnetwork: EXPECTED.subnet }]);
    job.spec.template.metadata.annotations["run.googleapis.com/vpc-access-egress"] =
      "all-traffic";
    const manifest = buildAuthProbeJobManifest(job, EXPECTED, { clearNetwork: true });
    expect(manifest.spec.template.spec.taskCount).toBe(2);
    expect(manifest.spec.template.spec.template.spec.containers[0].args).toEqual([
      "dist/index.js",
    ]);
    expect(manifest.spec.template.metadata.annotations).not.toHaveProperty(
      "run.googleapis.com/network-interfaces",
    );
  });

  it("rejects mutable images and missing resource versions", () => {
    const mutable = currentJob();
    mutable.spec.template.spec.template.spec.containers[0].image = "image:latest";
    expect(() => buildAuthProbeJobManifest(mutable, EXPECTED)).toThrow(
      "current authentication Job container contract is invalid",
    );

    const stale = currentJob();
    delete stale.metadata.resourceVersion;
    expect(() => buildAuthProbeJobManifest(stale, EXPECTED)).toThrow(
      "current authentication Job metadata is invalid",
    );
  });
});

describe("configuration-only authentication Job CLI", () => {
  const env = {
    GOOGLE_CLOUD_PROJECT: EXPECTED.project,
    CLOUD_RUN_REGION: EXPECTED.region,
    XOMETRY_AUTH_PROBE_JOB_NAME: EXPECTED.job,
    CLOUD_RUN_SERVICE_ACCOUNT: EXPECTED.serviceAccount,
    CLOUD_RUN_NETWORK: EXPECTED.network,
    CLOUD_RUN_SUBNET: EXPECTED.subnet,
    CLOUD_RUN_VPC_EGRESS: EXPECTED.vpcEgress,
    XOMETRY_PROFILE_SNAPSHOT_BUCKET: EXPECTED.snapshotBucket,
    XOMETRY_PROFILE_SNAPSHOT_OBJECT: EXPECTED.snapshotObject,
    XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES: EXPECTED.snapshotMaxBytes,
  };

  it("replaces but never executes the Job", async () => {
    let replaced = null;
    let output = "";
    const code = await runCli({
      env,
      output: { write: (value) => (output += value) },
      describeJob: async () => currentJob(),
      replaceJob: async (manifest) => {
        replaced = manifest;
      },
    });
    expect(code).toBe(0);
    expect(replaced.spec.template.spec.template.spec.containers[0].args).toEqual([
      "dist/tools/probeXometryProfileAuth.js",
    ]);
    expect(output).toContain("bounded probe contract were configured");
  });

  it("rejects any target outside the checked-in production contract", async () => {
    let described = false;
    const code = await runCli({
      env: { ...env, XOMETRY_AUTH_PROBE_JOB_NAME: "wrong-job" },
      output: { write: () => undefined },
      describeJob: async () => {
        described = true;
        return currentJob();
      },
    });
    expect(code).toBe(1);
    expect(described).toBe(false);
  });

  it("reports an ambiguous post-dispatch failure and requires verification", async () => {
    let output = "";
    const code = await runCli({
      env,
      output: { write: (value) => (output += value) },
      describeJob: async () => currentJob(),
      replaceJob: async () => {
        throw new Error("client timeout after server acceptance");
      },
    });
    expect(code).toBe(1);
    expect(output).toBe(
      "Authentication Job mutation outcome is unknown; run the stable-egress verifier before retrying.\n",
    );
  });

  it("supports only the explicit clear-network rollback argument", async () => {
    let replaced = null;
    const code = await runCli({
      args: ["--clear-network"],
      env: {
        GOOGLE_CLOUD_PROJECT: EXPECTED.project,
        CLOUD_RUN_REGION: EXPECTED.region,
        XOMETRY_AUTH_PROBE_JOB_NAME: EXPECTED.job,
        CLOUD_RUN_SERVICE_ACCOUNT: EXPECTED.serviceAccount,
      },
      output: { write: () => undefined },
      describeJob: async () => currentJob(),
      replaceJob: async (manifest) => {
        replaced = manifest;
      },
    });
    expect(code).toBe(0);
    expect(replaced.spec.template.metadata.annotations).not.toHaveProperty(
      "run.googleapis.com/network-interfaces",
    );
    expect(
      await runCli({ args: ["--execute-now"], env, output: { write: () => undefined } }),
    ).toBe(1);
  });
});
