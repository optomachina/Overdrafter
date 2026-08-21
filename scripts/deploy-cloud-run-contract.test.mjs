import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DEPLOY_SCRIPT = path.resolve(process.cwd(), "worker/scripts/deploy-cloud-run.sh");
const TARGET_PROJECT_NUMBER = "123456789012";

const COMPLIANT_METADATA = {
  project_number: Number(TARGET_PROJECT_NUMBER),
  public_access_prevention: "enforced",
  uniform_bucket_level_access: true,
  versioning_enabled: true,
  lifecycle_config: {
    rule: [
      { action: { type: "Delete" }, condition: { age: 1 } },
      { action: { type: "Delete" }, condition: { isLive: true } },
    ],
  },
};

async function makeStubGcloud(
  dir,
  {
    describeSucceeds = true,
    metadataContent,
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
    "  echo 'synthetic project describe failure' >&2",
    "  exit 1",
    "fi",
    'if [[ "$1" == "storage" ]]; then',
    `  if [[ "${describeSucceeds}" == "true" ]]; then`,
    `    cat "${fixturePath}"`,
    "    exit 0",
    "  fi",
    "  echo 'synthetic describe failure' >&2",
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
  describeSucceeds = true,
  metadataContent,
  projectDescribeSucceeds = true,
  targetProjectNumber = TARGET_PROJECT_NUMBER,
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "overdrafter-deploy-contract-"));
  const stub = await makeStubGcloud(dir, {
    describeSucceeds,
    metadataContent,
    projectDescribeSucceeds,
    targetProjectNumber,
  });
  const env = {
    ...process.env,
    GOOGLE_CLOUD_PROJECT: "synthetic-project",
    SUPABASE_URL: "https://synthetic.supabase.co",
    GCLOUD_BIN: stub,
  };
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
  return Object.fromEntries(
    joined.split(",").map((pair) => {
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
    expect(optionValue(describeCall, "--format")).toBe(
      "json(project_number,public_access_prevention,uniform_bucket_level_access,versioning_enabled,lifecycle_config)",
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

  it("refuses to deploy when the bucket control preflight fails", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      describeSucceeds: false,
    });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });

  it("refuses to deploy when the bucket belongs to another project", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      metadataContent: JSON.stringify({
        ...COMPLIANT_METADATA,
        project_number: 999999999999,
      }),
    });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["storage", "buckets", "describe"])).toBeDefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
  });

  it("refuses to deploy when the target project number cannot be resolved", async () => {
    const { failure, calls } = await runDeployScript({
      snapshot: true,
      projectDescribeSucceeds: false,
    });
    expect(failure).not.toBeNull();
    expect(findCall(calls, ["projects", "describe"])).toBeDefined();
    expect(findCall(calls, ["storage", "buckets", "describe"])).toBeUndefined();
    expect(findCall(calls, ["run", "deploy"])).toBeUndefined();
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
