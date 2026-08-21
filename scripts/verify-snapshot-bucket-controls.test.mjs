import { spawnSync } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateSnapshotBucketControls,
  LIFECYCLE_DELETE_ACTION_TYPES,
  runCli,
} from "./verify-snapshot-bucket-controls.mjs";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/verify-snapshot-bucket-controls.mjs");
const EXPECTED_PROJECT_NUMBER = "123456789012";

function compliantMetadata(overrides = {}) {
  return {
    project_number: Number(EXPECTED_PROJECT_NUMBER),
    public_access_prevention: "enforced",
    uniform_bucket_level_access: true,
    versioning_enabled: true,
    lifecycle_config: {
      rule: [
        { action: { type: "Delete" }, condition: { age: 1 } },
        { action: { type: "Delete" }, condition: { isLive: true } },
      ],
    },
    ...overrides,
  };
}

describe("snapshot bucket control evaluation", () => {
  it("accepts the exact snake_case metadata shape emitted by gcloud storage", () => {
    const result = evaluateSnapshotBucketControls(
      compliantMetadata(),
      EXPECTED_PROJECT_NUMBER,
    );
    expect(result).toEqual({ ok: true, invalid: false, failures: [] });
  });

  it("ignores unrelated extra metadata fields", () => {
    const result = evaluateSnapshotBucketControls(
      {
        ...compliantMetadata(),
        name: "projects/p/buckets/synthetic-test-bucket",
        etag: "AAAA",
        storage_layout: "STANDARD",
      },
      EXPECTED_PROJECT_NUMBER,
    );
    expect(result.ok).toBe(true);
  });

  it("requires the bucket to belong to the target project", () => {
    expect(
      evaluateSnapshotBucketControls(compliantMetadata(), EXPECTED_PROJECT_NUMBER).ok,
    ).toBe(true);
    expect(
      evaluateSnapshotBucketControls(
        compliantMetadata({ project_number: "999999999999" }),
        EXPECTED_PROJECT_NUMBER,
      ).failures,
    ).toContain("bucket_project_mismatch");

    for (const project_number of [undefined, null, "", "not-a-number", 0, -1, 1.5]) {
      const metadata = compliantMetadata({ project_number });
      if (project_number === undefined) delete metadata.project_number;
      expect(
        evaluateSnapshotBucketControls(metadata, EXPECTED_PROJECT_NUMBER).failures,
      ).toContain("bucket_project_number_missing_or_invalid");
    }
  });

  it("fails closed when the expected target project number is invalid", () => {
    for (const expected of [undefined, null, "", "not-a-number", 0, -1, 1.5]) {
      expect(evaluateSnapshotBucketControls(compliantMetadata(), expected)).toEqual({
        ok: false,
        invalid: true,
        failures: ["invalid_target_project_number"],
      });
    }
  });

  it("rejects public access prevention that is absent or not the enforced string", () => {
    for (const value of ["inherited", "unspecified", "", null, true, 1, ["enforced"]]) {
      const result = evaluateSnapshotBucketControls(
        compliantMetadata({ public_access_prevention: value }),
        EXPECTED_PROJECT_NUMBER,
      );
      expect(result.ok).toBe(false);
      expect(result.failures).toContain("public_access_prevention_not_enforced");
    }

    const missing = compliantMetadata();
    delete missing.public_access_prevention;
    expect(evaluateSnapshotBucketControls(missing, EXPECTED_PROJECT_NUMBER).failures).toContain(
      "public_access_prevention_not_enforced",
    );
  });

  it("rejects uniform bucket-level access that is absent or not exactly boolean true", () => {
    for (const value of [false, "true", 1, null]) {
      const result = evaluateSnapshotBucketControls(
        compliantMetadata({ uniform_bucket_level_access: value }),
        EXPECTED_PROJECT_NUMBER,
      );
      expect(result.failures).toContain("uniform_bucket_level_access_disabled");
    }

    const missing = compliantMetadata();
    delete missing.uniform_bucket_level_access;
    expect(evaluateSnapshotBucketControls(missing, EXPECTED_PROJECT_NUMBER).failures).toContain(
      "uniform_bucket_level_access_disabled",
    );
  });

  it("rejects versioning that is absent or not exactly boolean true", () => {
    for (const value of [false, "true", 1, null]) {
      const result = evaluateSnapshotBucketControls(
        compliantMetadata({ versioning_enabled: value }),
        EXPECTED_PROJECT_NUMBER,
      );
      expect(result.failures).toContain("versioning_disabled");
    }

    const missing = compliantMetadata();
    delete missing.versioning_enabled;
    expect(evaluateSnapshotBucketControls(missing, EXPECTED_PROJECT_NUMBER).failures).toContain(
      "versioning_disabled",
    );
  });

  it("requires well-formed lifecycle rules with at least one cleanup deletion action", () => {
    for (const actionType of LIFECYCLE_DELETE_ACTION_TYPES) {
      const single = evaluateSnapshotBucketControls(
        compliantMetadata({ lifecycle_config: { rule: [{ action: { type: actionType } }] } }),
        EXPECTED_PROJECT_NUMBER,
      );
      expect(single.ok).toBe(true);
    }

    const supportedCleanup = evaluateSnapshotBucketControls(
      compliantMetadata({
        lifecycle_config: {
          rule: [
            { action: { type: "Delete" }, condition: { age: 1 } },
            { action: { type: "SetStorageClass", storageClass: "NEARLINE" } },
          ],
        },
      }),
      EXPECTED_PROJECT_NUMBER,
    );
    expect(supportedCleanup.ok).toBe(true);

    for (const lifecycle_config of [
      null,
      {},
      { rule: [] },
      { rule: "daily" },
      { rules: [{ action: { type: "Delete" } }] },
      { rule: [{ action: { type: "SetStorageClass", storageClass: "NEARLINE" } }] },
      { rule: [{ action: { type: "DeleteUnderlyingObjectAndUnspecifiedStorageClass" } }] },
      { rule: [{ action: {} }] },
      { rule: [{ action: { type: "Delete" } }, { action: {} }] },
      { rule: [{}] },
      { rule: ["Delete"] },
      { rule: [{ action: { type: 1 } }] },
    ]) {
      const result = evaluateSnapshotBucketControls(
        compliantMetadata({ lifecycle_config }),
        EXPECTED_PROJECT_NUMBER,
      );
      expect(result.failures).toContain("lifecycle_delete_action_missing");
    }

    const missing = compliantMetadata();
    delete missing.lifecycle_config;
    expect(evaluateSnapshotBucketControls(missing, EXPECTED_PROJECT_NUMBER).failures).toContain(
      "lifecycle_delete_action_missing",
    );
  });

  it("aggregates every missing control into one failure report", () => {
    const result = evaluateSnapshotBucketControls(
      {
        project_number: Number(EXPECTED_PROJECT_NUMBER),
        public_access_prevention: "inherited",
      },
      EXPECTED_PROJECT_NUMBER,
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "public_access_prevention_not_enforced",
      "uniform_bucket_level_access_disabled",
      "versioning_disabled",
      "lifecycle_delete_action_missing",
    ]);
  });

  it("treats non-object metadata as unreadable input", () => {
    for (const value of [null, [], "enforced", 42, true]) {
      const result = evaluateSnapshotBucketControls(value, EXPECTED_PROJECT_NUMBER);
      expect(result).toEqual({ ok: false, invalid: true, failures: ["invalid_bucket_metadata"] });
    }
  });
});

describe("snapshot bucket control CLI", () => {
  it("exits 0 and reports a pass for compliant metadata", async () => {
    const { code, stdout } = await runCliFor(compliantMetadata());
    expect(code).toBe(0);
    expect(stdout).toContain("preflight passed");
  });

  it("exits 1 and lists sanitized failure codes without echoing names", async () => {
    const { code, stdout } = await runCliFor(
      compliantMetadata({
        public_access_prevention: "inherited",
        versioning_enabled: false,
      }),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("public_access_prevention_not_enforced");
    expect(stdout).toContain("versioning_disabled");
    expect(stdout).not.toContain("synthetic-test-bucket");
  });

  it("exits 2 on malformed JSON input", async () => {
    const { code, stdout } = await runCliFor("{not json");
    expect(code).toBe(2);
    expect(stdout).toContain("failing closed");
  });

  it("exits 2 on empty input", async () => {
    const { code, stdout } = await runCliFor("");
    expect(code).toBe(2);
    expect(stdout).toContain("failing closed");
  });

  it("exits 2 on non-object JSON input", async () => {
    const { code } = await runCliFor('["enforced"]');
    expect(code).toBe(2);
  });

  it("exposes the same contract when spawned as a standalone process", () => {
    const passing = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--expected-project-number", EXPECTED_PROJECT_NUMBER],
      {
      input: JSON.stringify(compliantMetadata()),
      encoding: "utf8",
      },
    );
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("preflight passed");

    const failing = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--expected-project-number", EXPECTED_PROJECT_NUMBER],
      {
      input: JSON.stringify(
        compliantMetadata({ public_access_prevention: "inherited" }),
      ),
      encoding: "utf8",
      },
    );
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("public_access_prevention_not_enforced");

    const invalid = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--expected-project-number", EXPECTED_PROJECT_NUMBER],
      {
      input: "null",
      encoding: "utf8",
      },
    );
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toContain("failing closed");
  });

  it("detects direct invocation through symlinked paths instead of failing open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "overdrafter-preflight-symlink-"));
    const linkPath = path.join(dir, "preflight-link.mjs");
    await symlink(SCRIPT_PATH, linkPath);

    const invalid = spawnSync(
      process.execPath,
      [linkPath, "--expected-project-number", EXPECTED_PROJECT_NUMBER],
      {
      input: "null",
      encoding: "utf8",
      },
    );
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toContain("failing closed");

    const passing = spawnSync(
      process.execPath,
      [linkPath, "--expected-project-number", EXPECTED_PROJECT_NUMBER],
      {
      input: JSON.stringify(compliantMetadata()),
      encoding: "utf8",
      },
    );
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("preflight passed");
  });
});

async function runCliFor(stdin) {
  const chunks = [];
  const output = {
    write(text) {
      chunks.push(text);
    },
  };
  const code = await runCli({
    expectedProjectNumber: EXPECTED_PROJECT_NUMBER,
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    output,
  });
  return { code, stdout: chunks.join("") };
}
