// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { WEB_CATALOG_RELATIVE_PATH } from "./provider-manifest.mjs";
import { syncProviderCatalogs } from "./provider-sync.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-provider-sync-"));
  temporaryRoots.push(temporaryRoot);
  const rootDir = path.join(temporaryRoot, "repo");
  await fs.mkdir(rootDir);
  await fs.cp(
    path.join(repoRoot, "provider-integrations"),
    path.join(rootDir, "provider-integrations"),
    { recursive: true },
  );
  return { temporaryRoot, rootDir };
}

describe("provider catalog output safety", () => {
  it("refuses a generated-output symlink without changing its external target", async () => {
    const { temporaryRoot, rootDir } = await createFixture();
    const externalTarget = path.join(temporaryRoot, "external-provider-catalog.ts");
    const outputPath = path.join(rootDir, WEB_CATALOG_RELATIVE_PATH);
    await fs.writeFile(externalTarget, "external sentinel\n");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.symlink(externalTarget, outputPath);

    await expect(syncProviderCatalogs({ rootDir })).rejects.toThrow(
      "generated provider catalog output must be a regular file",
    );
    expect(await fs.readFile(externalTarget, "utf8")).toBe("external sentinel\n");
    expect((await fs.lstat(outputPath)).isSymbolicLink()).toBe(true);
  });

  it("refuses a non-regular generated output", async () => {
    const { rootDir } = await createFixture();
    const outputPath = path.join(rootDir, WEB_CATALOG_RELATIVE_PATH);
    await fs.mkdir(outputPath, { recursive: true });

    await expect(syncProviderCatalogs({ rootDir })).rejects.toThrow(
      "generated provider catalog output must be a regular file",
    );
  });
});

