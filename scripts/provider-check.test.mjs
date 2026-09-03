// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { assertCheckedInProviderIdentity, checkProviderIntegrations } from "./provider-check.mjs";
import { readProviderManifests } from "./provider-manifest.mjs";
import { syncProviderCatalogs } from "./provider-sync.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createCheckedFixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-provider-check-"));
  temporaryRoots.push(temporaryRoot);
  const rootDir = path.join(temporaryRoot, "repo");
  await fs.mkdir(path.join(rootDir, "src/integrations/supabase"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "worker/src"), { recursive: true });
  await Promise.all([
    fs.cp(
      path.join(repoRoot, "provider-integrations"),
      path.join(rootDir, "provider-integrations"),
      { recursive: true },
    ),
    fs.copyFile(
      path.join(repoRoot, "src/integrations/supabase/types.ts"),
      path.join(rootDir, "src/integrations/supabase/types.ts"),
    ),
    fs.copyFile(
      path.join(repoRoot, "worker/src/types.ts"),
      path.join(rootDir, "worker/src/types.ts"),
    ),
  ]);
  await syncProviderCatalogs({ rootDir });
  return { temporaryRoot, rootDir };
}

describe("checked-in provider manifests and projections", () => {
  it("covers every current vendor key with fail-closed safety and structurally truthful capability claims", async () => {
    const result = await checkProviderIntegrations({ rootDir: repoRoot, today: "2026-09-02" });
    const manifests = await readProviderManifests(repoRoot, { today: "2026-09-02" });

    expect(result.providerCount).toBe(17);
    expect(result.vendorKeys).toHaveLength(17);
    for (const { manifest } of manifests) {
      expect(manifest.official.urls.length).toBeGreaterThan(0);
      expect(manifest.official.domains.length).toBeGreaterThan(0);
      expect(manifest.evidence.firstPartyUrls.length).toBeGreaterThan(0);
      expect(manifest.evidence.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(manifest.safety).toEqual({
        quoteOnly: true,
        orderingProhibited: true,
        sessionIsolationRequired: true,
      });
      for (const field of ["processes", "materials", "files", "geometry", "drawings", "accountModes"]) {
        const capability = manifest.capabilityEnvelope[field];
        const values = field === "geometry" ? capability.constraints : capability.values;
        expect(["unknown", "supported", "unsupported"]).toContain(capability.status);
        if (capability.status !== "supported") {
          expect(values).toEqual([]);
        }
      }
      expect(["unknown", "supported", "unsupported"]).toContain(manifest.capabilityEnvelope.quantity.status);
      expect(["unknown", "supported", "unsupported"]).toContain(manifest.capabilityEnvelope.tolerance.status);
      if (manifest.capabilityEnvelope.quantity.status !== "supported") {
        expect(manifest.capabilityEnvelope.quantity).toMatchObject({ minimum: null, maximum: null });
      }
      if (manifest.capabilityEnvelope.tolerance.status !== "supported") {
        expect(manifest.capabilityEnvelope.tolerance).toMatchObject({ minimumMm: null, maximumMm: null });
      }
    }
  });

  it("rejects a checked-in manifest without canonical first-party identity evidence", async () => {
    const [{ manifest }] = await readProviderManifests(repoRoot, { today: "2026-09-02" });
    const incompleteManifest = {
      ...manifest,
      official: { urls: [], domains: [] },
      evidence: { firstPartyUrls: [], reviewedAt: null },
    };

    expect(() => assertCheckedInProviderIdentity(incompleteManifest)).toThrow(
      "requires current first-party identity evidence",
    );
  });

  it("renders deterministic generated catalogs without production authority", async () => {
    const first = await syncProviderCatalogs({ rootDir: repoRoot, dryRun: true });
    const second = await syncProviderCatalogs({ rootDir: repoRoot, dryRun: true });

    expect(first.rendered).toEqual(second.rendered);
    for (const output of first.rendered) {
      expect(await fs.readFile(path.join(repoRoot, output.relativePath), "utf8")).toBe(output.contents);
      expect(output.contents).not.toMatch(/certified|admission|dispatchEnabled|productionAuthorized/i);
    }
  });

  it("rejects a byte-identical catalog symlink without touching its external target", async () => {
    const { temporaryRoot, rootDir } = await createCheckedFixture();
    const outputPath = path.join(rootDir, "src/features/quotes/generated/provider-catalog.ts");
    const expectedContents = await fs.readFile(outputPath, "utf8");
    const externalTarget = path.join(temporaryRoot, "external-identical-catalog.ts");
    await fs.writeFile(externalTarget, expectedContents);
    await fs.rm(outputPath);
    await fs.symlink(externalTarget, outputPath);

    await expect(checkProviderIntegrations({
      rootDir,
      today: "2026-09-02",
      checkConsumers: false,
    })).rejects.toThrow("generated provider catalog output must be a regular file");
    expect(await fs.readFile(externalTarget, "utf8")).toBe(expectedContents);
    expect((await fs.lstat(outputPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects a non-regular catalog output during provider check", async () => {
    const { rootDir } = await createCheckedFixture();
    const outputPath = path.join(rootDir, "src/features/quotes/generated/provider-catalog.ts");
    await fs.rm(outputPath);
    await fs.mkdir(outputPath);

    await expect(checkProviderIntegrations({
      rootDir,
      today: "2026-09-02",
      checkConsumers: false,
    })).rejects.toThrow("generated provider catalog output must be a regular file");
  });
});
