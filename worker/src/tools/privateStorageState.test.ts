// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePrivateStorageState } from "./privateStorageState";

const STATE = { cookies: [{ name: "session", value: "secret" }], origins: [] };
let dir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "private-storage-state-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("writePrivateStorageState", () => {
  it("writes a new storage state readable only by the owner", async () => {
    const outputPath = path.join(dir, "state.json");
    const previousUmask = process.umask(0o000);
    try {
      await writePrivateStorageState({ storageState: async () => STATE }, outputPath);
    } finally {
      process.umask(previousUmask);
    }
    expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(outputPath, "utf8"))).toEqual(STATE);
  });

  it("replaces an existing world-readable file instead of inheriting its mode", async () => {
    const outputPath = path.join(dir, "state.json");
    await fs.writeFile(outputPath, "{}", { mode: 0o644 });
    await fs.chmod(outputPath, 0o644);

    await writePrivateStorageState({ storageState: async () => STATE }, outputPath);

    expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(["state.json"]);
  });

  it("leaves no partial file when the browser cannot export its state", async () => {
    const outputPath = path.join(dir, "state.json");
    await expect(writePrivateStorageState({
      storageState: async () => { throw new Error("context closed"); },
    }, outputPath)).rejects.toThrow("context closed");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("is the only way the vendor auth tools persist sessions", async () => {
    for (const tool of ["vendorAuth.ts", "xometryAuth.ts", "fictivAuth.ts"]) {
      const source = await fs.readFile(path.join(import.meta.dirname, tool), "utf8");
      expect(source).not.toMatch(/\.storageState\(\s*\{/);
      expect(source).toContain("writePrivateStorageState(context, outputPath)");
    }
  });
});
