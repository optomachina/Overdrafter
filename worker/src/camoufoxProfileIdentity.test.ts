// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  invalidateCamoufoxLaunchIdentity,
  loadCamoufoxLaunchIdentity,
  loadCamoufoxLaunchIdentityForRecovery,
  saveCamoufoxLaunchIdentity,
} from "./camoufoxProfileIdentity";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "camoufox-identity-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Camoufox profile launch identity", () => {
  it("round-trips a private versioned identity", async () => {
    const profileDir = await makeTempDir();
    const config = {
      "navigator.userAgent": "stable-firefox",
      "fonts:spacing_seed": 41,
      "canvas:aaOffset": -3,
    };

    await saveCamoufoxLaunchIdentity(profileDir, config);

    await expect(
      loadCamoufoxLaunchIdentity(profileDir, { required: true }),
    ).resolves.toEqual({
      schema: "overdrafter-camoufox-launch-identity.v1",
      config,
    });
    const stat = await fs.stat(path.join(profileDir, ".overdrafter-camoufox-identity.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("fails closed when a required identity is missing or malformed", async () => {
    const profileDir = await makeTempDir();
    await expect(loadCamoufoxLaunchIdentity(profileDir)).resolves.toBeNull();
    await expect(
      loadCamoufoxLaunchIdentity(profileDir, { required: true }),
    ).rejects.toThrow("missing or invalid");

    await fs.writeFile(
      path.join(profileDir, ".overdrafter-camoufox-identity.json"),
      JSON.stringify({ schema: "overdrafter-camoufox-launch-identity.v1", config: {} }),
    );
    await expect(
      loadCamoufoxLaunchIdentity(profileDir, { required: true }),
    ).rejects.toThrow("missing or invalid");
  });

  it("invalidates export eligibility while preserving recovery identity", async () => {
    const profileDir = await makeTempDir();
    const unrelatedPath = path.join(profileDir, "cookies.sqlite");
    await fs.writeFile(unrelatedPath, "preserve-me");
    await saveCamoufoxLaunchIdentity(profileDir, {
      "navigator.userAgent": "stable-firefox",
    });

    await invalidateCamoufoxLaunchIdentity(profileDir);
    await invalidateCamoufoxLaunchIdentity(profileDir);

    await expect(loadCamoufoxLaunchIdentity(profileDir)).resolves.toBeNull();
    await expect(
      loadCamoufoxLaunchIdentityForRecovery(profileDir),
    ).resolves.toMatchObject({
      config: { "navigator.userAgent": "stable-firefox" },
    });
    await expect(fs.readFile(unrelatedPath, "utf8")).resolves.toBe(
      "preserve-me",
    );

    await saveCamoufoxLaunchIdentity(profileDir, {
      "navigator.userAgent": "stable-firefox",
    });
    await expect(loadCamoufoxLaunchIdentity(profileDir)).resolves.toMatchObject({
      config: { "navigator.userAgent": "stable-firefox" },
    });
    await expect(
      fs.access(
        path.join(
          profileDir,
          ".overdrafter-camoufox-identity.pending.json",
        ),
      ),
    ).rejects.toThrow();
  });

  it("does not promote a verified identity when pending cleanup fails", async () => {
    const profileDir = await makeTempDir();
    await saveCamoufoxLaunchIdentity(profileDir, {
      "navigator.userAgent": "stable-firefox",
    });
    await invalidateCamoufoxLaunchIdentity(profileDir);
    const pendingPath = path.join(
      profileDir,
      ".overdrafter-camoufox-identity.pending.json",
    );
    await fs.rm(pendingPath);
    await fs.mkdir(pendingPath);
    await fs.writeFile(path.join(pendingPath, "cannot-remove"), "fail closed");

    await expect(
      saveCamoufoxLaunchIdentity(profileDir, {
        "navigator.userAgent": "replacement-firefox",
      }),
    ).rejects.toThrow();
    await expect(loadCamoufoxLaunchIdentity(profileDir)).resolves.toBeNull();
  });

  it("keeps the promoted identity unavailable when invalid-marker cleanup fails", async () => {
    const profileDir = await makeTempDir();
    await saveCamoufoxLaunchIdentity(profileDir, {
      "navigator.userAgent": "stable-firefox",
    });
    await invalidateCamoufoxLaunchIdentity(profileDir);
    const invalidPath = path.join(
      profileDir,
      ".overdrafter-camoufox-identity.invalid",
    );
    await fs.rm(invalidPath);
    await fs.mkdir(invalidPath);
    await fs.writeFile(path.join(invalidPath, "cannot-remove"), "fail closed");

    await expect(
      saveCamoufoxLaunchIdentity(profileDir, {
        "navigator.userAgent": "replacement-firefox",
      }),
    ).rejects.toThrow();
    await expect(loadCamoufoxLaunchIdentity(profileDir)).rejects.toThrow(
      "missing or invalid",
    );
    await expect(
      loadCamoufoxLaunchIdentityForRecovery(profileDir),
    ).resolves.toMatchObject({
      config: { "navigator.userAgent": "replacement-firefox" },
    });
  });

  it("keeps export eligibility revoked when pending identity move is obstructed", async () => {
    const profileDir = await makeTempDir();
    await saveCamoufoxLaunchIdentity(profileDir, {
      "navigator.userAgent": "stable-firefox",
    });
    const pendingPath = path.join(
      profileDir,
      ".overdrafter-camoufox-identity.pending.json",
    );
    await fs.mkdir(pendingPath);
    await fs.writeFile(path.join(pendingPath, "obstruction"), "fail closed");

    await expect(
      invalidateCamoufoxLaunchIdentity(profileDir),
    ).rejects.toThrow();
    await expect(loadCamoufoxLaunchIdentity(profileDir)).resolves.toBeNull();
    await expect(
      loadCamoufoxLaunchIdentityForRecovery(profileDir),
    ).resolves.toMatchObject({
      config: { "navigator.userAgent": "stable-firefox" },
    });
  });

});
