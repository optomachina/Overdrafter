import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
  deriveStableEgressOptionalAdapters,
  formatStableEgressRestrictionMessage,
  readProviderRegistry,
  renderProviderRegistryOutputs,
  validateProviderRegistry,
} from "./provider-registry.mjs";

const execFileAsync = promisify(execFile);
const DEPLOY_SCRIPT = path.resolve(process.cwd(), "worker/scripts/deploy-cloud-run.sh");
const TARGET_PROJECT_NUMBER = "123456789012";

// The complete bounded, all-traffic Direct VPC tuple for the Xometry worker.
const STABLE_EGRESS_ENV = {
  CLOUD_RUN_MIN_INSTANCES: "0",
  CLOUD_RUN_MAX_INSTANCES: "1",
  CLOUD_RUN_NETWORK: "synthetic-network",
  CLOUD_RUN_SUBNET: "synthetic-subnet",
  CLOUD_RUN_VPC_EGRESS: "all-traffic",
  CLOUD_RUN_SERVICE_ACCOUNT: "worker@synthetic-project.iam.gserviceaccount.com",
  XOMETRY_BROWSER_ENGINE: "camoufox",
};

const COMPLIANT_METADATA = {
  projectNumber: TARGET_PROJECT_NUMBER,
  iamConfiguration: {
    publicAccessPrevention: "enforced",
    uniformBucketLevelAccess: { enabled: true },
  },
  versioning: { enabled: true },
  lifecycle: {
    rule: [
      { action: { type: "Delete" }, condition: { age: 1 } },
      { action: { type: "Delete" }, condition: { isLive: true } },
    ],
  },
};

async function makeStubGcloud(
  dir,
  {
    describeError =
      "network timeout reading gs://synthetic-bucket in synthetic-project",
    describeWarning = "",
    describeSucceeds = true,
    metadataContent,
    projectDescribeError = "PERMISSION_DENIED: synthetic-project credentials rejected",
    projectDescribeSucceeds = true,
    targetProjectNumber = TARGET_PROJECT_NUMBER,
  } = {},
) {
  const fixturePath = path.join(dir, "bucket-metadata.json");
  await writeFile(
    fixturePath,
    metadataContent ?? JSON.stringify(COMPLIANT_METADATA),
  );
  const stubPath = path.join(dir, "fake-gcloud");
  const recordAndDispatch = [
    "#!/usr/bin/env bash",
    `printf '%s\\x1f' "$@" >> "${dir}/calls.log"`,
    `printf "\\n" >> "${dir}/calls.log"`,
    'if [[ "$1" == "projects" ]]; then',
    `  if [[ "${projectDescribeSucceeds}" == "true" ]]; then`,
    `    printf '%s\\n' "${targetProjectNumber}"`,
    "    exit 0",
    "  fi",
    `  echo '${projectDescribeError}' >&2`,
    "  exit 1",
    "fi",
    'if [[ "$1" == "storage" ]]; then',
    `  if [[ "${describeSucceeds}" == "true" ]]; then`,
    `    [[ -z "${describeWarning}" ]] || echo '${describeWarning}' >&2`,
    `    cat "${fixturePath}"`,
    "    exit 0",
    "  fi",
    `  echo '${describeError}' >&2`,
    "  exit 1",
    "fi",
    'if [[ "$1" == "run" ]]; then',
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n");
  await writeFile(stubPath, recordAndDispatch);
  await chmod(stubPath, 0o700);
  return stubPath;
}

async function runDeployScript({
  snapshot,
  describeError =
    "network timeout reading gs://synthetic-bucket in synthetic-project",
  describeWarning = "",
  describeSucceeds = true,
  metadataContent,
  projectDescribeError = "PERMISSION_DENIED: synthetic-project credentials rejected",
  projectDescribeSucceeds = true,
  targetProjectNumber = TARGET_PROJECT_NUMBER,
  envOverrides = {},
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "overdrafter-deploy-contract-"));
  const stub = await makeStubGcloud(dir, {
    describeError,
    describeWarning,
    describeSucceeds,
    metadataContent,
    projectDescribeError,
    projectDescribeSucceeds,
    targetProjectNumber,
  });
  const env = { ...process.env };
  for (const name of [
    "SERVICE_NAME",
    "GOOGLE_CLOUD_PROJECT",
    "CLOUD_RUN_REGION",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_SECRET_NAME",
    "XOMETRY_STORAGE_STATE_SECRET_NAME",
    "FICTIV_STORAGE_STATE_SECRET_NAME",
    "QUICKPARTS_STORAGE_STATE_SECRET_NAME",
    "XOMETRY_PROFILE_SNAPSHOT_BUCKET",
    "XOMETRY_PROFILE_SNAPSHOT_OBJECT",
    "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES",
    "OPENAI_API_KEY_SECRET_NAME",
    "ANTHROPIC_API_KEY_SECRET_NAME",
    "WORKER_MODE",
    "WORKER_LIVE_ADAPTERS",
    "WORKER_POLL_INTERVAL_MS",
    "WORKER_BUILD_VERSION",
    "QUOTE_ARTIFACT_BUCKET",
    "PLAYWRIGHT_HEADLESS",
    "PLAYWRIGHT_CAPTURE_TRACE",
    "PLAYWRIGHT_BROWSER_TIMEOUT_MS",
    "PLAYWRIGHT_DISABLE_SANDBOX",
    "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE",
    "XOMETRY_BROWSER_ENGINE",
    "CLOUD_RUN_SERVICE_ACCOUNT",
    "CLOUD_RUN_MIN_INSTANCES",
    "CLOUD_RUN_MAX_INSTANCES",
    "CLOUD_RUN_NETWORK",
    "CLOUD_RUN_SUBNET",
    "CLOUD_RUN_VPC_EGRESS",
    "GCLOUD_BIN",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    GOOGLE_CLOUD_PROJECT: "synthetic-project",
    SUPABASE_URL: "https://synthetic.supabase.co",
    GCLOUD_BIN: stub,
    ...envOverrides,
  });
  if (snapshot) {
    env.XOMETRY_PROFILE_SNAPSHOT_BUCKET = "synthetic-bucket";
    env.XOMETRY_PROFILE_SNAPSHOT_OBJECT = "profiles/synthetic.tgz";
  }

  let failure = null;
  try {
    await execFileAsync("bash", [DEPLOY_SCRIPT], { env });
  } catch (error) {
    failure = error;
  }

  let calls = [];
  try {
    calls = (await readFile(path.join(dir, "calls.log"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\x1f"));
  } catch {
    calls = [];
  }
  return { failure, calls };
}

function findCall(calls, prefix) {
  return calls.find((call) => prefix.every((part, index) => call[index] === part));
}

function optionValue(call, flag) {
  const inline = call.find(
    (arg) => typeof arg === "string" && arg.startsWith(`${flag}=`),
  );
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const index = call.indexOf(flag);
  if (index === -1) return null;
  return call[index + 1] ?? null;
}

function parseAssignments(joined) {
  if (!joined) return {};
  // gcloud's alternate-delimiter form: ^<delimiter>^key=value<delimiter>...
  const alternate = /^\^(.)\^/.exec(joined);
  const delimiter = alternate ? alternate[1] : ",";
  const body = alternate ? joined.slice(alternate[0].length) : joined;
  return Object.fromEntries(
    body.split(delimiter).map((pair) => {
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
}

describe("deploy-cloud-run.sh snapshot command contract", () => {
  it("preflights bucket controls and deploys without legacy bindings or --remove-env-vars", async () => {
    const { failure, calls } = await runDeployScript({ snapshot: true });
    expect(failure).toBeNull();

    const projectDescribeCall = findCall(calls, ["projects", "describe"]);
    expect(projectDescribeCall).toBeDefined();
    expect(projectDescribeCall).toContain("synthetic-project");
    expect(optionValue(projectDescribeCall, "--format")).toBe("value(projectNumber)");

    const describeCall = findCall(calls, ["storage", "buckets", "describe"]);
    expect(describeCall).toBeDefined();
    expect(describeCall).toContain("gs://synthetic-bucket");
    expect(describeCall).toContain("--raw");
    expect(optionValue(describeCall, "--format")).toBe(
      "json(projectNumber,iamConfiguration.publicAccessPrevention,iamConfiguration.uniformBucketLevelAccess.enabled,versioning.enabled,lifecycle)",
    );

    const deployCall = findCall(calls, ["run", "deploy"]);
    expect(deployCall).toBeDefined();
    expect(deployCall).toContain("--concurrency");
    expect(deployCall[deployCall.indexOf("--concurrency") + 1]).toBe("1");
    expect(deployCall).toContain("--max-instances");
    expect(deployCall[deployCall.indexOf("--max-instances") + 1]).toBe("1");

    const envVars = parseAssignments(optionValue(deployCall, "--set-env-vars"));
    expect(envVars.WORKER_MODE).toBe("live");
    expect(envVars.XOMETRY_PROFILE_SNAPSHOT_BUCKET).toBe("synthetic-bucket");
    expect(envVars.XOMETRY_BROWSER_ENGINE).toBe("playwright");
    for (const legacyKey of [
      "XOMETRY_STORAGE_STATE_PATH",
      "XOMETRY_STORAGE_STATE_JSON",
      "XOMETRY_USER_DATA_DIR",
    ]) {
      expect(envVars).not.toHaveProperty(legacyKey);
    }

    // --set-env-vars already replaces the whole variable set; combining it
    // with --remove-env-vars is invalid gcloud usage.
    expect(deployCall).not.toContain("--remove-env-vars");

    const updateSecrets = parseAssignments(optionValue(deployCall, "--update-secrets"));
    expect(updateSecrets.SUPABASE_SERVICE_ROLE_KEY).toBe("supabase-service-role-key:latest");
    expect(updateSecrets).not.toHaveProperty("XOMETRY_STORAGE_STATE_JSON");

    const removeSecrets = (optionValue(deployCall, "--remove-secrets") ?? "").split(",");
    expect(removeSecrets).toContain("XOMETRY_STORAGE_STATE_JSON");
    expect(removeSecrets).toContain("OPENROUTER_API_KEY");
  });

  it("matches the pinned release-tuple sandbox default and honors an explicit sandbox opt-in", async () => {
    // TODO(OVD-610): flip with the pinned release-tuple contracts after a Cloud Run smoke.
    const defaultRun = await runDeployScript({ snapshot: false });
    expect(defaultRun.failure).toBeNull();
    const defaultEnv = parseAssignments(
      optionValue(findCall(defaultRun.calls, ["run", "deploy"]), "--set-env-vars"),
    );
    expect(defaultEnv.PLAYWRIGHT_DISABLE_SANDBOX).toBe("true");

    const sandboxRun = await runDeployScript({
      snapshot: false,
      envOverrides: { PLAYWRIGHT_DISABLE_SANDBOX: "false" },
    });
    expect(sandboxRun.failure).toBeNull();
    const sandboxEnv = parseAssignments(
      optionValue(findCall(sandboxRun.calls, ["run", "deploy"]), "--set-env-vars"),
    );
    expect(sandboxEnv.PLAYWRIGHT_DISABLE_SANDBOX).toBe("false");
  });

  it("keeps the storage-state secret binding when snapshot mode is off", async () => {
    const { failure, calls } = await runDeployScript({ snapshot: false });
    expect(failure).toBeNull();

    expect(findCall(calls, ["storage", "buckets", "describe"])).toBeUndefined();
    expect(findCall(calls, ["projects", "describe"])).toBeUndefined();

    const deployCall = findCall(calls, ["run", "deploy"]);
    expect(deployCall).toBeDefined();
    const envVars = parseAssignments(optionValue(deployCall, "--set-env-vars"));
    expect(envVars).not.toHaveProperty("XOMETRY_PROFILE_SNAPSHOT_BUCKET");

    const updateSecrets = parseAssignments(optionValue(deployCall, "--update-secrets"));
    expect(updateSecrets.XOMETRY_STORAGE_STATE_JSON).toBe("xometry-storage-state:latest");

    const removeSecrets = (optionValue(deployCall, "--remove-secrets") ?? "").split(",");
    expect(removeSecrets).toContain("OPENROUTER_API_KEY");
    expect(removeSecrets).not.toContain("XOMETRY_STORAGE_STATE_JSON");
  });

  it("adds the complete all-traffic Direct VPC contract for the bounded Xometry worker", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: STABLE_EGRESS_ENV,
    });
    expect(failure).toBeNull();

    const deployCall = findCall(calls, ["run", "deploy"]);
    expect(deployCall).toBeDefined();
    expect(optionValue(deployCall, "--network")).toBe("synthetic-network");
    expect(optionValue(deployCall, "--subnet")).toBe("synthetic-subnet");
    expect(optionValue(deployCall, "--vpc-egress")).toBe("all-traffic");
    expect(optionValue(deployCall, "--min-instances")).toBe("0");
    expect(optionValue(deployCall, "--max-instances")).toBe("1");
    expect(optionValue(deployCall, "--service-account")).toBe(
      "worker@synthetic-project.iam.gserviceaccount.com",
    );
  });

  it("rejects every partial stable-egress tuple before invoking gcloud", async () => {
    const cases = [
      { CLOUD_RUN_NETWORK: "synthetic-network" },
      { CLOUD_RUN_SUBNET: "synthetic-subnet" },
      { CLOUD_RUN_VPC_EGRESS: "all-traffic" },
      {
        CLOUD_RUN_NETWORK: "synthetic-network",
        CLOUD_RUN_SUBNET: "synthetic-subnet",
      },
      {
        CLOUD_RUN_NETWORK: "synthetic-network",
        CLOUD_RUN_VPC_EGRESS: "all-traffic",
      },
      {
        CLOUD_RUN_SUBNET: "synthetic-subnet",
        CLOUD_RUN_VPC_EGRESS: "all-traffic",
      },
    ];

    for (const envOverrides of cases) {
      const { failure, calls } = await runDeployScript({ envOverrides });
      expect(failure).not.toBeNull();
      expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
      expect(findCall(calls, ["projects", "describe"])).toBeUndefined();
    }
  });

  it("rejects unsafe stable-egress values before invoking gcloud", async () => {
    const base = STABLE_EGRESS_ENV;
    const cases = [
      { CLOUD_RUN_VPC_EGRESS: "private-ranges-only" },
      { CLOUD_RUN_MIN_INSTANCES: "1" },
      { CLOUD_RUN_MAX_INSTANCES: "2" },
      { WORKER_MODE: "mock" },
      { WORKER_LIVE_ADAPTERS: "fictiv", FICTIV_STORAGE_STATE_SECRET_NAME: "synthetic-fictiv-state" },
      { WORKER_LIVE_ADAPTERS: "fictiv,xometry", FICTIV_STORAGE_STATE_SECRET_NAME: "synthetic-fictiv-state" },
      { WORKER_LIVE_ADAPTERS: "xometry,fictiv" },
      { PLAYWRIGHT_CAPTURE_TRACE: "true" },
      { CLOUD_RUN_SERVICE_ACCOUNT: "" },
    ];

    for (const unsafe of cases) {
      const { failure, calls } = await runDeployScript({
        snapshot: true,
        envOverrides: { ...base, ...unsafe },
      });
      expect(failure).not.toBeNull();
      expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
      expect(findCall(calls, ["projects", "describe"])).toBeUndefined();
    }
  });

  it("refuses a production worker deploy that omits the governed network tuple", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: {
        GOOGLE_CLOUD_PROJECT: "overdrafter-worker-9133",
        XOMETRY_BROWSER_ENGINE: "camoufox",
      },
    });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });

  it("refuses to deploy when the bucket control preflight fails", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      describeSucceeds: false,
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain("Snapshot bucket control preflight failed");
    expect(output).toContain(
      "Cloud CLI failure category: network or service availability.",
    );
    expect(output).not.toContain("synthetic-bucket");
    expect(output).not.toContain("synthetic-project");
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });

  it("refuses to deploy when the bucket belongs to another project", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      metadataContent: JSON.stringify({
        ...COMPLIANT_METADATA,
        projectNumber: "999999999999",
      }),
    });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["storage", "buckets", "describe"])).toBeDefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });

  it("does not classify a successful bucket lookup warning as the preflight failure", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      describeWarning: "WARNING: using cached credentials for operator@example.com",
      metadataContent: JSON.stringify({
        ...COMPLIANT_METADATA,
        name: "projects/synthetic-project/buckets/raw-private-bucket",
        iamConfiguration: {
          ...COMPLIANT_METADATA.iamConfiguration,
          publicAccessPrevention: "inherited",
        },
      }),
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain("public_access_prevention_not_enforced");
    expect(output).not.toContain("Cloud CLI failure category:");
    expect(output).not.toContain("operator@example.com");
    expect(output).not.toContain("raw-private-bucket");
    expect(output).not.toContain("synthetic-project");
  });

  it("uses the uppercase cloud status before lowercase bucket-like text", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      describeSucceeds: false,
      describeError: "NOT_FOUND: gs://permission_denied does not exist",
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain("Cloud CLI failure category: resource or configuration.");
    expect(output).not.toContain("authentication or authorization");
    expect(output).not.toContain("permission_denied");
  });

  it("uses the first structured cloud status when later details contain another", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      projectDescribeSucceeds: false,
      projectDescribeError:
        "NOT_FOUND: project is absent; nested detail PERMISSION_DENIED: secondary context",
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain("Cloud CLI failure category: resource or configuration.");
    expect(output).not.toContain("authentication or authorization");
    expect(output).not.toContain("PERMISSION_DENIED");
  });

  it("refuses to deploy when the target project number cannot be resolved", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      projectDescribeSucceeds: false,
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain("Target project number could not be resolved");
    expect(output).toContain(
      "Cloud CLI failure category: authentication or authorization.",
    );
    expect(output).not.toContain("synthetic-project");
    expect(output).not.toContain("synthetic-bucket");
    expect(findCall(calls, ["projects", "describe"])).toBeDefined();
    expect(findCall(calls, ["storage", "buckets", "describe"])).toBeUndefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });

  it("keeps resource names from influencing cloud failure classification", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      projectDescribeSucceeds: false,
      projectDescribeError: "NOT_FOUND: project login-archive does not exist",
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain("Cloud CLI failure category: resource or configuration.");
    expect(output).not.toContain("authentication or authorization");
    expect(output).not.toContain("login-archive");
  });

  it("classifies the standard no-active-account cloud failure", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      projectDescribeSucceeds: false,
      projectDescribeError:
        "You do not currently have an active account selected. Please run gcloud auth login to obtain new credentials.",
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain(
      "Cloud CLI failure category: authentication or authorization.",
    );
    expect(output).not.toContain("active account");
    expect(output).not.toContain("auth login");
  });

  it("preserves diagnostic keywords that also appear as resource names", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      projectDescribeSucceeds: false,
      projectDescribeError: "network failure while describing project network",
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain(
      "Cloud CLI failure category: network or service availability.",
    );
    expect(output).not.toContain("project network");
  });

  it("classifies the standard uppercase service-unavailable status", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      projectDescribeSucceeds: false,
      projectDescribeError: "UNAVAILABLE: upstream closed the request",
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain(
      "Cloud CLI failure category: network or service availability.",
    );
    expect(output).not.toContain("UNAVAILABLE");
  });

  it("refuses to deploy when the preflight metadata is unreadable", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      metadataContent: "{not json",
    });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["storage", "buckets", "describe"])).toBeDefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });
});

describe("deploy-cloud-run.sh Fictiv live-adapter contract (OVD-673)", () => {
  const FICTIV_SECRET = "synthetic-fictiv-storage-state";

  it("keeps Fictiv disabled by default and strips any stale Fictiv session binding", async () => {
    const { failure, calls } = await runDeployScript({ snapshot: true });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    expect(optionValue(deployCall, "--set-env-vars")?.startsWith("^")).toBe(false);
    expect(parseAssignments(optionValue(deployCall, "--set-env-vars")).WORKER_LIVE_ADAPTERS).toBe("xometry");
    expect(parseAssignments(optionValue(deployCall, "--update-secrets"))).not.toHaveProperty("FICTIV_STORAGE_STATE_JSON");
    expect((optionValue(deployCall, "--remove-secrets") ?? "").split(",")).toContain("FICTIV_STORAGE_STATE_JSON");
  });

  it("pins the xometry,fictiv deploy argv", async () => {
    const QUICKPARTS_MOUNT = "/var/secrets/quickparts-storage-state/storage-state.json";
    const WEERG_MOUNT = "/var/secrets/weerg-storage-state/storage-state.json";
    const envVars = [
      "SUPABASE_URL=https://synthetic.supabase.co",
      "WORKER_MODE=live",
      "WORKER_LIVE_ADAPTERS=xometry,fictiv",
      "WORKER_NAME=overdrafter-cad-worker",
      "WORKER_POLL_INTERVAL_MS=5000",
      "WORKER_BUILD_VERSION=pinned",
      "WORKER_HTTP_HOST=0.0.0.0",
      "WORKER_TEMP_DIR=/root/.cache/overdrafter-worker",
      "QUOTE_ARTIFACT_BUCKET=quote-artifacts",
      "PLAYWRIGHT_HEADLESS=true",
      "PLAYWRIGHT_CAPTURE_TRACE=false",
      "PLAYWRIGHT_BROWSER_TIMEOUT_MS=45000",
      "PLAYWRIGHT_DISABLE_SANDBOX=true",
      "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE=true",
      "XOMETRY_BROWSER_ENGINE=camoufox",
      "XOMETRY_PROFILE_SNAPSHOT_BUCKET=synthetic-bucket",
      "XOMETRY_PROFILE_SNAPSHOT_OBJECT=profiles/synthetic.tgz",
      "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES=268435456",
    ].join("@");
    const expectedArgv = [
      "run", "deploy", "overdrafter-cad-worker",
      "--project", "synthetic-project",
      "--region", "us-west1",
      "--source", ".",
      "--execution-environment", "gen2",
      "--min-instances", "0",
      "--max-instances", "1",
      "--concurrency", "1",
      "--cpu", "2",
      "--memory", "2Gi",
      "--timeout", "3600",
      "--no-cpu-throttling",
      "--no-allow-unauthenticated",
      "--set-env-vars", `^@^${envVars}`,
      "--update-secrets", `SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,FICTIV_STORAGE_STATE_JSON=${FICTIV_SECRET}:latest`,
      "--service-account", "worker@synthetic-project.iam.gserviceaccount.com",
      "--network", "synthetic-network",
      "--subnet", "synthetic-subnet",
      "--vpc-egress", "all-traffic",
      "--remove-secrets", [
        "XOMETRY_STORAGE_STATE_JSON",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        QUICKPARTS_MOUNT,
        WEERG_MOUNT,
        "OPENROUTER_API_KEY",
      ].join(","),
    ];

    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: {
        WORKER_BUILD_VERSION: "pinned",
        WORKER_LIVE_ADAPTERS: "xometry,fictiv",
        FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET,
        ...STABLE_EGRESS_ENV,
      },
    });
    expect(failure).toBeNull();
    expect(findCall(calls, ["run", "deploy"])).toEqual([...expectedArgv, ""]);
  });

  it("binds the named Fictiv secret and preserves the comma-separated adapter list", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: { WORKER_LIVE_ADAPTERS: "xometry,fictiv", FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET },
    });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    const rawEnv = optionValue(deployCall, "--set-env-vars");
    expect(rawEnv.startsWith("^@^")).toBe(true);
    const envVars = parseAssignments(rawEnv);
    expect(envVars.WORKER_LIVE_ADAPTERS).toBe("xometry,fictiv");
    expect(envVars.WORKER_MODE).toBe("live");
    expect(envVars.SUPABASE_URL).toBe("https://synthetic.supabase.co");
    expect(parseAssignments(optionValue(deployCall, "--update-secrets")).FICTIV_STORAGE_STATE_JSON).toBe(
      `${FICTIV_SECRET}:latest`,
    );
    expect((optionValue(deployCall, "--remove-secrets") ?? "").split(",")).not.toContain("FICTIV_STORAGE_STATE_JSON");
  });

  it("allows the stable-egress tuple to carry Fictiv alongside Xometry", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: {
        WORKER_LIVE_ADAPTERS: "xometry,fictiv",
        FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET,
        ...STABLE_EGRESS_ENV,
      },
    });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    expect(optionValue(deployCall, "--network")).toBe("synthetic-network");
    expect(parseAssignments(optionValue(deployCall, "--set-env-vars")).WORKER_LIVE_ADAPTERS).toBe("xometry,fictiv");
  });

  it.each([
    [{ WORKER_LIVE_ADAPTERS: "xometry,fictiv" }],
    [{ WORKER_LIVE_ADAPTERS: "fictiv" }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,oshcut", FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,fictiv,fictiv", FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry, fictiv", FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: ",", FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,", FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,,fictiv", FICTIV_STORAGE_STATE_SECRET_NAME: FICTIV_SECRET }],
  ])("refuses unsafe live adapter configuration %j before invoking gcloud", async (envOverrides) => {
    const { failure, calls } = await runDeployScript({ snapshot: true, envOverrides });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["projects", "describe"])).toBeUndefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });
});

describe("deploy-cloud-run.sh Quickparts live-adapter contract (OVD-674)", () => {
  const QUICKPARTS_SECRET = "synthetic-quickparts-storage-state";
  const QUICKPARTS_MOUNT = "/var/secrets/quickparts-storage-state/storage-state.json";
  const PRE_OVD674_ENV_VARS = [
    "SUPABASE_URL=https://synthetic.supabase.co",
    "WORKER_MODE=live",
    "WORKER_LIVE_ADAPTERS=xometry",
    "WORKER_NAME=overdrafter-cad-worker",
    "WORKER_POLL_INTERVAL_MS=5000",
    "WORKER_BUILD_VERSION=pinned",
    "WORKER_HTTP_HOST=0.0.0.0",
    "WORKER_TEMP_DIR=/root/.cache/overdrafter-worker",
    "QUOTE_ARTIFACT_BUCKET=quote-artifacts",
    "PLAYWRIGHT_HEADLESS=true",
    "PLAYWRIGHT_CAPTURE_TRACE=false",
    "PLAYWRIGHT_BROWSER_TIMEOUT_MS=45000",
    "PLAYWRIGHT_DISABLE_SANDBOX=true",
    "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE=true",
    "XOMETRY_BROWSER_ENGINE=camoufox",
    "XOMETRY_PROFILE_SNAPSHOT_BUCKET=synthetic-bucket",
    "XOMETRY_PROFILE_SNAPSHOT_OBJECT=profiles/synthetic.tgz",
    "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES=268435456",
  ].join(",");

  // The governed Xometry-only stable-egress deploy exactly as the
  // pre-OVD-674 script issued it, with the only additions being removal of
  // any stale Quickparts (OVD-674) and Weerg (OVD-675) session mounts.
  const XOMETRY_ONLY_ARGV = [
    "run", "deploy", "overdrafter-cad-worker",
    "--project", "synthetic-project",
    "--region", "us-west1",
    "--source", ".",
    "--execution-environment", "gen2",
    "--min-instances", "0",
    "--max-instances", "1",
    "--concurrency", "1",
    "--cpu", "2",
    "--memory", "2Gi",
    "--timeout", "3600",
    "--no-cpu-throttling",
    "--no-allow-unauthenticated",
    "--set-env-vars", PRE_OVD674_ENV_VARS,
    "--update-secrets", "SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest",
    "--service-account", "worker@synthetic-project.iam.gserviceaccount.com",
    "--network", "synthetic-network",
    "--subnet", "synthetic-subnet",
    "--vpc-egress", "all-traffic",
    "--remove-secrets",
    [
      "XOMETRY_STORAGE_STATE_JSON",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "FICTIV_STORAGE_STATE_JSON",
      QUICKPARTS_MOUNT,
      "/var/secrets/weerg-storage-state/storage-state.json",
      "OPENROUTER_API_KEY",
    ].join(","),
  ];

  it("leaves the Xometry-only deploy unchanged except for stripping stale Quickparts and Weerg mounts", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: { WORKER_BUILD_VERSION: "pinned", ...STABLE_EGRESS_ENV },
    });
    expect(failure).toBeNull();
    // The stub terminates every recorded argument, leaving one empty trailing field.
    expect(findCall(calls, ["run", "deploy"])).toEqual([...XOMETRY_ONLY_ARGV, ""]);
  });

  it("keeps Quickparts disabled by default with no session binding or path map", async () => {
    const { failure, calls } = await runDeployScript({ snapshot: true });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    const envVars = parseAssignments(optionValue(deployCall, "--set-env-vars"));
    expect(envVars.WORKER_LIVE_ADAPTERS).toBe("xometry");
    expect(envVars).not.toHaveProperty("QUOTE_VENDOR_STORAGE_STATE_PATHS");
    expect(parseAssignments(optionValue(deployCall, "--update-secrets"))).not.toHaveProperty(QUICKPARTS_MOUNT);
    expect((optionValue(deployCall, "--remove-secrets") ?? "").split(",")).toContain(QUICKPARTS_MOUNT);
  });

  it("mounts the named Quickparts secret and points the vendor path map at it", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: { WORKER_LIVE_ADAPTERS: "xometry,quickparts", QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET },
    });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    const rawEnv = optionValue(deployCall, "--set-env-vars");
    expect(rawEnv.startsWith("^@^")).toBe(true);
    const envVars = parseAssignments(rawEnv);
    expect(envVars.WORKER_LIVE_ADAPTERS).toBe("xometry,quickparts");
    expect(JSON.parse(envVars.QUOTE_VENDOR_STORAGE_STATE_PATHS)).toEqual({ quickparts: QUICKPARTS_MOUNT });
    expect(parseAssignments(optionValue(deployCall, "--update-secrets"))[QUICKPARTS_MOUNT]).toBe(`${QUICKPARTS_SECRET}:latest`);
    const removed = (optionValue(deployCall, "--remove-secrets") ?? "").split(",");
    expect(removed).not.toContain(QUICKPARTS_MOUNT);
    // Fictiv stays independently off.
    expect(removed).toContain("FICTIV_STORAGE_STATE_JSON");
  });

  it("keeps a single-adapter path map in gcloud's plain comma form", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: { WORKER_LIVE_ADAPTERS: "quickparts", QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET },
    });
    expect(failure).toBeNull();
    const rawEnv = optionValue(findCall(calls, ["run", "deploy"]), "--set-env-vars");
    expect(rawEnv.startsWith("^")).toBe(false);
    expect(JSON.parse(parseAssignments(rawEnv).QUOTE_VENDOR_STORAGE_STATE_PATHS)).toEqual({ quickparts: QUICKPARTS_MOUNT });
  });

  it("accepts on the stable egress exactly the adapter values the egress contract allows", async () => {
    const { STABLE_EGRESS_LIVE_ADAPTER_VALUES } = await import("./xometry-stable-egress-contract.mjs");
    expect(STABLE_EGRESS_LIVE_ADAPTER_VALUES).toEqual(
      expect.arrayContaining(["xometry,quickparts", "xometry,fictiv,quickparts"]),
    );
    for (const adapters of [...STABLE_EGRESS_LIVE_ADAPTER_VALUES, "quickparts", "quickparts,xometry", "fictiv,quickparts"]) {
      const { failure, calls } = await runDeployScript({
        snapshot: true,
        envOverrides: {
          WORKER_LIVE_ADAPTERS: adapters,
          FICTIV_STORAGE_STATE_SECRET_NAME: "synthetic-fictiv-storage-state",
          QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET,
          WEERG_STORAGE_STATE_SECRET_NAME: "synthetic-weerg-storage-state",
          ...STABLE_EGRESS_ENV,
        },
      });
      const allowed = STABLE_EGRESS_LIVE_ADAPTER_VALUES.includes(adapters);
      expect({ adapters, deployed: failure === null }).toEqual({ adapters, deployed: allowed });
      if (allowed) {
        expect(optionValue(findCall(calls, ["run", "deploy"]), "--network")).toBe("synthetic-network");
      }
    }
  });

  it.each([
    [{ WORKER_LIVE_ADAPTERS: "xometry,quickparts" }],
    [{ WORKER_LIVE_ADAPTERS: "quickparts" }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,quickparts,quickparts", QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry, quickparts", QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,quickparts,", QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,weerg", QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET }],
  ])("refuses unsafe Quickparts configuration %j before invoking gcloud", async (envOverrides) => {
    const { failure, calls } = await runDeployScript({ snapshot: true, envOverrides });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["projects", "describe"])).toBeUndefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });
});

describe("deploy-cloud-run.sh Weerg live-adapter contract (OVD-675)", () => {
  const WEERG_SECRET = "synthetic-weerg-storage-state";
  const WEERG_MOUNT = "/var/secrets/weerg-storage-state/storage-state.json";
  const QUICKPARTS_SECRET = "synthetic-quickparts-storage-state";
  const QUICKPARTS_MOUNT = "/var/secrets/quickparts-storage-state/storage-state.json";

  it("keeps Weerg disabled by default with no session binding or path map", async () => {
    const { failure, calls } = await runDeployScript({ snapshot: true });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    const envVars = parseAssignments(optionValue(deployCall, "--set-env-vars"));
    expect(envVars.WORKER_LIVE_ADAPTERS).toBe("xometry");
    expect(envVars).not.toHaveProperty("QUOTE_VENDOR_STORAGE_STATE_PATHS");
    expect(parseAssignments(optionValue(deployCall, "--update-secrets"))).not.toHaveProperty(WEERG_MOUNT);
    expect((optionValue(deployCall, "--remove-secrets") ?? "").split(",")).toContain(WEERG_MOUNT);
  });

  it("mounts the named Weerg secret and points the vendor path map at it", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: { WORKER_LIVE_ADAPTERS: "xometry,weerg", WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET },
    });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    const rawEnv = optionValue(deployCall, "--set-env-vars");
    expect(rawEnv.startsWith("^@^")).toBe(true);
    const envVars = parseAssignments(rawEnv);
    expect(envVars.WORKER_LIVE_ADAPTERS).toBe("xometry,weerg");
    expect(JSON.parse(envVars.QUOTE_VENDOR_STORAGE_STATE_PATHS)).toEqual({ weerg: WEERG_MOUNT });
    expect(parseAssignments(optionValue(deployCall, "--update-secrets"))[WEERG_MOUNT]).toBe(`${WEERG_SECRET}:latest`);
    const removed = (optionValue(deployCall, "--remove-secrets") ?? "").split(",");
    expect(removed).not.toContain(WEERG_MOUNT);
    // Fictiv and Quickparts stay independently off.
    expect(removed).toEqual(expect.arrayContaining(["FICTIV_STORAGE_STATE_JSON", QUICKPARTS_MOUNT]));
  });

  it("merges Quickparts and Weerg sessions into one vendor path map", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: {
        WORKER_LIVE_ADAPTERS: "xometry,quickparts,weerg",
        QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET,
        WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET,
      },
    });
    expect(failure).toBeNull();
    const deployCall = findCall(calls, ["run", "deploy"]);
    const envVars = parseAssignments(optionValue(deployCall, "--set-env-vars"));
    expect(JSON.parse(envVars.QUOTE_VENDOR_STORAGE_STATE_PATHS)).toEqual({
      quickparts: QUICKPARTS_MOUNT,
      weerg: WEERG_MOUNT,
    });
    const secrets = parseAssignments(optionValue(deployCall, "--update-secrets"));
    expect(secrets[QUICKPARTS_MOUNT]).toBe(`${QUICKPARTS_SECRET}:latest`);
    expect(secrets[WEERG_MOUNT]).toBe(`${WEERG_SECRET}:latest`);
    const removed = (optionValue(deployCall, "--remove-secrets") ?? "").split(",");
    expect(removed).not.toContain(QUICKPARTS_MOUNT);
    expect(removed).not.toContain(WEERG_MOUNT);
  });

  it("keeps a Quickparts-only path map byte-identical to OVD-674", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      envOverrides: { WORKER_LIVE_ADAPTERS: "xometry,quickparts", QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET },
    });
    expect(failure).toBeNull();
    const envVars = parseAssignments(optionValue(findCall(calls, ["run", "deploy"]), "--set-env-vars"));
    expect(envVars.QUOTE_VENDOR_STORAGE_STATE_PATHS).toBe(`{"quickparts":"${QUICKPARTS_MOUNT}"}`);
  });

  it("accepts on the stable egress exactly the adapter values the egress contract allows", async () => {
    const { STABLE_EGRESS_LIVE_ADAPTER_VALUES } = await import("./xometry-stable-egress-contract.mjs");
    expect([...STABLE_EGRESS_LIVE_ADAPTER_VALUES]).toEqual([
      "xometry",
      "xometry,fictiv",
      "xometry,quickparts",
      "xometry,fictiv,quickparts",
      "xometry,weerg",
      "xometry,fictiv,weerg",
      "xometry,quickparts,weerg",
      "xometry,fictiv,quickparts,weerg",
    ]);
    for (const adapters of [
      ...STABLE_EGRESS_LIVE_ADAPTER_VALUES,
      "weerg",
      "weerg,xometry",
      "xometry,weerg,quickparts",
      "xometry,weerg,fictiv",
      "quickparts,weerg",
    ]) {
      const { failure, calls } = await runDeployScript({
        snapshot: true,
        envOverrides: {
          WORKER_LIVE_ADAPTERS: adapters,
          FICTIV_STORAGE_STATE_SECRET_NAME: "synthetic-fictiv-storage-state",
          QUICKPARTS_STORAGE_STATE_SECRET_NAME: QUICKPARTS_SECRET,
          WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET,
          ...STABLE_EGRESS_ENV,
        },
      });
      const allowed = STABLE_EGRESS_LIVE_ADAPTER_VALUES.includes(adapters);
      expect({ adapters, deployed: failure === null }).toEqual({ adapters, deployed: allowed });
      if (allowed) {
        expect(optionValue(findCall(calls, ["run", "deploy"]), "--network")).toBe("synthetic-network");
      }
    }
  });

  it.each([
    [{ WORKER_LIVE_ADAPTERS: "xometry,weerg" }],
    [{ WORKER_LIVE_ADAPTERS: "weerg" }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,quickparts,weerg", WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,weerg,weerg", WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry, weerg", WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,weerg,", WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET }],
    [{ WORKER_LIVE_ADAPTERS: "xometry,geomiq", WEERG_STORAGE_STATE_SECRET_NAME: WEERG_SECRET }],
  ])("refuses unsafe Weerg configuration %j before invoking gcloud", async (envOverrides) => {
    const { failure, calls } = await runDeployScript({ snapshot: true, envOverrides });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["projects", "describe"])).toBeUndefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });
});

describe("deploy-cloud-run.sh stable-egress restriction message (OVD-727)", () => {
  async function restrictionMessageFromScript(script) {
    const dir = await mkdtemp(path.join(tmpdir(), "overdrafter-stable-egress-message-"));
    const scriptPath = path.join(dir, "provider-secrets.sh");
    await writeFile(scriptPath, `${script}\nprovider_registry_stable_egress_restriction_message\n`);
    const { stdout } = await execFileAsync("bash", [scriptPath]);
    return stdout.trim();
  }

  it("prints the current registry-built message and lists a temporary fourth adapter", async () => {
    const repoRoot = path.resolve(process.cwd());
    const registry = await readProviderRegistry(repoRoot);
    const currentScript = renderProviderRegistryOutputs(registry)
      .find((output) => output.relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH)
      .contents;
    const currentMessage = await restrictionMessageFromScript(currentScript);
    expect(currentMessage).toBe(
      "Stable egress deployment is restricted to the live Xometry worker, optionally with Fictiv, Quickparts, and/or Weerg in that order.",
    );
    expect(currentMessage).toBe(formatStableEgressRestrictionMessage(
      registry.stableEgressRequiredKey,
      deriveStableEgressOptionalAdapters(registry),
    ));

    const withFourth = validateProviderRegistry({
      ...registry,
      providers: registry.providers.map((entry) => (
        entry.key === "geomiq"
          ? {
            key: "geomiq",
            liveAdapter: true,
            sessionSecrets: [{
              secretNameEnv: "GEOMIQ_STORAGE_STATE_SECRET_NAME",
              mountEnv: "GEOMIQ_STORAGE_STATE_JSON",
              requiredWhenListed: true,
            }],
            egress: "stable_nat",
          }
          : entry
      )),
    });
    expect(deriveStableEgressOptionalAdapters(withFourth)).toEqual([
      "fictiv",
      "geomiq",
      "quickparts",
      "weerg",
    ]);
    const fourthScript = renderProviderRegistryOutputs(withFourth)
      .find((output) => output.relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH)
      .contents;
    const fourthMessage = await restrictionMessageFromScript(fourthScript);
    expect(fourthMessage).toBe(
      "Stable egress deployment is restricted to the live Xometry worker, optionally with Fictiv, Geomiq, Quickparts, and/or Weerg in that order.",
    );
    expect(fourthMessage).toContain("Geomiq");
  });

  it("uses the generated helper when a stable-egress deploy is rejected", async () => {
    const { failure } = await runDeployScript({
      snapshot: true,
      envOverrides: {
        ...STABLE_EGRESS_ENV,
        WORKER_LIVE_ADAPTERS: "fictiv,xometry",
        FICTIV_STORAGE_STATE_SECRET_NAME: "synthetic-fictiv-storage-state",
      },
    });
    expect(failure).not.toBeNull();
    const output = `${String(failure?.stdout ?? "")}${String(failure?.stderr ?? "")}`;
    expect(output).toContain(
      "Stable egress deployment is restricted to the live Xometry worker, optionally with Fictiv, Quickparts, and/or Weerg in that order.",
    );
  });
});
