// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  WEB_CATALOG_RELATIVE_PATH,
  WORKER_CATALOG_RELATIVE_PATH,
  buildCatalog,
  projectCatalog,
  readProviderManifests,
} from "./provider-manifest.mjs";
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
  it("forwards an explicit review date while reading manifests", async () => {
    const { rootDir } = await createFixture();

    await expect(syncProviderCatalogs({
      rootDir,
      dryRun: true,
      today: "2026-09-01",
    })).rejects.toThrow("must be current and not in the future");
  });

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
describe("provider catalog authority boundary", () => {
  it("projects the canonical envelope only into the worker catalog", async () => {
    const result = await syncProviderCatalogs({ rootDir: repoRoot, dryRun: true });
    const catalog = buildCatalog(await readProviderManifests(repoRoot, {
      today: new Date().toISOString().slice(0, 10),
    }));
    const webProjection = projectCatalog(catalog, "web");
    const workerProjection = projectCatalog(catalog, "worker");
    const web = result.rendered.find((output) => output.relativePath === WEB_CATALOG_RELATIVE_PATH);
    const worker = result.rendered.find((output) => output.relativePath === WORKER_CATALOG_RELATIVE_PATH);

    expect(Object.values(webProjection).every((entry) => !("capabilityEnvelope" in entry))).toBe(true);
    expect(Object.values(workerProjection).every((entry) => "capabilityEnvelope" in entry)).toBe(true);
    expect(web?.contents).not.toContain("capabilityEnvelope");
    expect(worker?.contents).toContain("capabilityEnvelope");
    expect(worker?.contents).toContain('processFamily:"multi_process"');
    expect(worker?.contents).toContain('"cnc_machining"');
    expect(worker?.contents).not.toContain("productionCertified");
    expect(worker?.contents).not.toContain("routingEnabled");
  });

  it("renders deterministically", async () => {
    const first = await syncProviderCatalogs({ rootDir: repoRoot, dryRun: true });
    const second = await syncProviderCatalogs({ rootDir: repoRoot, dryRun: true });

    expect(second.rendered).toEqual(first.rendered);
  });
});
