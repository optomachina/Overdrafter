// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCamoufoxLaunchIdentity,
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

});
