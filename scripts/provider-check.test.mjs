// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { assertCheckedInProviderIdentity, checkProviderIntegrations } from "./provider-check.mjs";
import { readProviderManifests } from "./provider-manifest.mjs";
import { syncProviderCatalogs } from "./provider-sync.mjs";
import {
  REVIEWED_ENVELOPE_ARTIFACTS,
  assertReviewedEnvelopeCompleteness,
  collectReviewedEnvelopeGaps,
  formatReviewedEnvelopeGap,
} from "./reviewed-envelope-check.mjs";

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
    ...[
      "src/features/quotes/vendor-colors.ts",
      "src/features/quotes/vendor-purchasing-links.ts",
      "src/features/quotes/utils.ts",
      "src/features/quotes/sourcing-result.ts",
    ].map(async (relativePath) => {
      const target = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(repoRoot, relativePath), target);
    }),
  ]);
  await syncProviderCatalogs({ rootDir });
  return { temporaryRoot, rootDir };
}

describe("checked-in provider manifests and projections", () => {
  it("covers every current vendor key with fail-closed safety and structurally truthful capability claims", async () => {
    const result = await checkProviderIntegrations({ rootDir: repoRoot, today: "2026-09-28" });
    const manifests = await readProviderManifests(repoRoot, { today: "2026-09-28" });

    expect(result.providerCount).toBe(18);
    expect(result.vendorKeys).toHaveLength(18);
    expect(result.vendorKeys).toContain("rmfg");
    expect(result.reviewedProviders).toEqual(["fictiv"]);
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
    const [{ manifest }] = await readProviderManifests(repoRoot, { today: "2026-09-28" });
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

  it("rejects a catalog consumer whose expected import exists only in a comment", async () => {
    const { rootDir } = await createCheckedFixture();
    const consumerPath = path.join(rootDir, "src/features/quotes/vendor-colors.ts");
    await fs.writeFile(consumerPath, `
      // import { PROVIDER_CATALOG } from "@/features/quotes/generated/provider-catalog";
      export const color = PROVIDER_CATALOG.xometry.color;
    `);

    await expect(checkProviderIntegrations({ rootDir, today: "2026-09-28" })).rejects.toThrow(
      "required catalog consumer is not wired: src/features/quotes/vendor-colors.ts",
    );
  });

  it("rejects a catalog consumer whose imported binding is only stale text", async () => {
    const { rootDir } = await createCheckedFixture();
    const consumerPath = path.join(rootDir, "src/features/quotes/vendor-colors.ts");
    await fs.writeFile(consumerPath, `
      import { PROVIDER_CATALOG } from "@/features/quotes/generated/provider-catalog";
      export const staleMarker = "PROVIDER_CATALOG";
    `);

    await expect(checkProviderIntegrations({ rootDir, today: "2026-09-28" })).rejects.toThrow(
      "required catalog consumer is not wired: src/features/quotes/vendor-colors.ts",
    );
  });

  it("uses the same explicit review date for validation and dry-run generation", async () => {
    const { rootDir } = await createCheckedFixture();
    const providerDirectories = await fs.readdir(path.join(rootDir, "provider-integrations"), {
      withFileTypes: true,
    });
    await Promise.all(providerDirectories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifestPath = path.join(
          rootDir,
          "provider-integrations",
          entry.name,
          "manifest.v1.json",
        );
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        manifest.evidence.reviewedAt = "2026-09-04";
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }));
    await syncProviderCatalogs({ rootDir, today: "2026-09-04" });

    await expect(checkProviderIntegrations({
      rootDir,
      today: "2026-09-04",
    })).resolves.toMatchObject({ providerCount: 18 });
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
      today: "2026-09-28",
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
      today: "2026-09-28",
      checkConsumers: false,
    })).rejects.toThrow("generated provider catalog output must be a regular file");
  });
});

async function writeCompleteReviewedProvider(rootDir, key, { reviewed = true } = {}) {
  const envelope = {
    provider: key,
    ...(reviewed ? { reviewer: "ovd-691-fixture", reviewedAt: "2026-10-11" } : {}),
    envelope: { schema: "provider-dispatch-envelope.v1", provider: key },
  };
  const secretNameEnv = `${key.toUpperCase()}_STORAGE_STATE_SECRET_NAME`;
  const mountEnv = `${key.toUpperCase()}_STORAGE_STATE_JSON`;
  await fs.mkdir(path.join(rootDir, "provider-dispatch-envelope"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "provider-dispatch-envelope", `${key}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  await fs.mkdir(path.join(rootDir, "docs/workflows"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "docs/workflows", `${key}-live-readiness.md`),
    `# ${key} live readiness\n\nGenerated output stays disabled by default. Secret names only.\n`,
  );
  await fs.mkdir(path.join(rootDir, "worker/test-support"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "worker/test-support", `${key}DispatchFixture.ts`),
    `import { providerDispatchFixtureAuthorization } from "./providerDispatchFixture.js";\nexport const provider = "${key}";\n`,
  );
  await fs.mkdir(path.join(rootDir, "worker/src/adapters"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "worker/src/adapters", `${key}ProductionPortal.test.ts`),
    `import { registerProductionPortalAuthorizationRefusals } from "../../test-support/productionPortalDefaultDeny";\nconst vendor = "${key}";\n`,
  );
  await fs.mkdir(path.join(rootDir, "provider-integrations"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH),
    `${JSON.stringify({
      providers: [{
        key,
        liveAdapter: false,
        sessionSecrets: [{ secretNameEnv, mountEnv, requiredWhenListed: true }],
        egress: "stable_nat",
      }],
    }, null, 2)}\n`,
  );
  await fs.mkdir(path.join(rootDir, "worker/src/generated"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "worker/src/generated/providerRegistry.ts"),
    `export const sessionSecretNames = ["${secretNameEnv}", "${mountEnv}"] as const;\n`,
  );
  await fs.mkdir(path.join(rootDir, "worker/scripts/generated"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "worker/scripts/generated/provider-secrets.sh"),
    `# ${secretNameEnv}\n# ${mountEnv}\n`,
  );
}

const PROVIDER_REGISTRY_RELATIVE_PATH = "provider-integrations/provider-registry.v1.json";

async function createEnvelopeRoot() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-reviewed-envelope-"));
  temporaryRoots.push(temporaryRoot);
  return temporaryRoot;
}

async function writeSimulatedOnboardLive(rootDir, key) {
  try {
    const onboard = await import("./provider-onboard.mjs");
    const runner = onboard.runProviderOnboard ?? onboard.scaffoldProviderStage;
    if (typeof runner === "function") {
      await runner({ rootDir, key, stage: "live", dryRun: false });
      return;
    }
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
  }
  await writeCompleteReviewedProvider(rootDir, key, { reviewed: false });
}

describe("reviewed envelope completeness", () => {
  it("passes a reviewed envelope that has every required artifact", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");

    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).resolves.toEqual({ reviewedProviders: ["acme"] });
  });

  it.each([
    ["readinessDoc", "docs/workflows/acme-live-readiness.md"],
    ["dispatchFixture", "worker/test-support/acmeDispatchFixture.ts"],
    ["defaultDenyTest", "worker/src/adapters/acmeProductionPortal.test.ts"],
    ["deployWiring", PROVIDER_REGISTRY_RELATIVE_PATH],
  ])("fails when the %s artifact is missing", async (artifactId, relativePath) => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await fs.rm(path.join(rootDir, relativePath), { recursive: true, force: true });
    if (artifactId === "deployWiring") {
      await fs.rm(path.join(rootDir, "worker/src/generated"), { recursive: true, force: true });
      await fs.rm(path.join(rootDir, "worker/scripts/generated"), { recursive: true, force: true });
    }

    const spec = REVIEWED_ENVELOPE_ARTIFACTS[artifactId];
    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).rejects.toThrow(formatReviewedEnvelopeGap("acme", spec.artifact, spec.expectedPath("acme")));
  });

  it("passes an unreviewed envelope that has no live artifacts", async () => {
    const rootDir = await createEnvelopeRoot();
    await fs.mkdir(path.join(rootDir, "provider-dispatch-envelope"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "provider-dispatch-envelope/acme.json"),
      `${JSON.stringify({
        provider: "acme",
        envelope: { schema: "provider-dispatch-envelope.v1", provider: "acme" },
      }, null, 2)}\n`,
    );

    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).resolves.toEqual({ reviewedProviders: [] });
  });

  it("collects every missing artifact before failing", async () => {
    const rootDir = await createEnvelopeRoot();
    await fs.mkdir(path.join(rootDir, "provider-dispatch-envelope"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "provider-dispatch-envelope/acme.json"),
      `${JSON.stringify({
        provider: "acme",
        reviewer: "ovd-691-fixture",
        reviewedAt: "2026-10-11",
        envelope: { schema: "provider-dispatch-envelope.v1", provider: "acme" },
      }, null, 2)}\n`,
    );

    const gaps = await collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" });
    expect(gaps.map((gap) => gap.artifact)).toEqual([
      "readiness doc",
      "dispatch fixture",
      "productionPortalDefaultDeny test",
      "deploy wiring",
    ]);
  });

  it("passes current main providers or keeps only dated tracking exceptions", async () => {
    const result = await checkProviderIntegrations({ rootDir: repoRoot, today: "2026-10-11" });
    const gaps = await collectReviewedEnvelopeGaps({ rootDir: repoRoot, today: "2026-10-11" });

    expect(result.reviewedProviders).toEqual(["fictiv"]);
    expect(gaps).toEqual([]);
    expect(result.vendorKeys).toEqual(expect.arrayContaining(["fictiv", "quickparts", "weerg"]));
  });

  it("accepts simulated provider:onboard --stage=live output once the envelope is marked reviewed", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeSimulatedOnboardLive(rootDir, "tempkey");
    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).resolves.toEqual({ reviewedProviders: [] });

    const envelopePath = path.join(rootDir, "provider-dispatch-envelope/tempkey.json");
    const envelope = JSON.parse(await fs.readFile(envelopePath, "utf8"));
    envelope.reviewer = "ovd-691-fixture";
    envelope.reviewedAt = "2026-10-11";
    await fs.writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);

    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).resolves.toEqual({ reviewedProviders: ["tempkey"] });
    const registry = JSON.parse(
      await fs.readFile(path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH), "utf8"),
    );
    expect(registry.providers[0].liveAdapter).toBe(false);
  });

  it("fails an expired exception instead of letting it rot", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await fs.rm(path.join(rootDir, "worker/src/adapters/acmeProductionPortal.test.ts"));

    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2027-01-01",
      exceptions: [{
        key: "acme",
        artifact: "productionPortalDefaultDeny test",
        issue: "OVD-691",
        expiresOn: "2026-12-31",
      }],
    })).rejects.toThrow(formatReviewedEnvelopeGap(
      "acme",
      "productionPortalDefaultDeny test",
      "worker/src/adapters/acmeProductionPortal.test.ts",
    ));
  });

  it("refuses registry entries that carry secret values", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await fs.writeFile(
      path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH),
      `${JSON.stringify({
        providers: [{
          key: "acme",
          liveAdapter: false,
          sessionSecrets: [{
            secretNameEnv: "ACME_STORAGE_STATE_SECRET_NAME",
            mountEnv: "ACME_STORAGE_STATE_JSON",
            value: "not-a-secret-placeholder-xxxxxxxxxxxxxxxxxxxxxxxx",
          }],
          egress: "stable_nat",
        }],
      }, null, 2)}\n`,
    );

    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).rejects.toThrow("acme registry entry must declare secret names only");
  });

  it("never reads process env secret values while checking names", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    const previous = process.env.ACME_STORAGE_STATE_JSON;
    process.env.ACME_STORAGE_STATE_JSON = "env-secret-must-not-be-read";
    try {
      await expect(assertReviewedEnvelopeCompleteness({
        rootDir,
        today: "2026-10-11",
      })).resolves.toEqual({ reviewedProviders: ["acme"] });
    } finally {
      if (previous === undefined) {
        delete process.env.ACME_STORAGE_STATE_JSON;
      } else {
        process.env.ACME_STORAGE_STATE_JSON = previous;
      }
    }
  });
});
