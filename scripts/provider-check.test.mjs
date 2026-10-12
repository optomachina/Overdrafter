// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { assertCheckedInProviderIdentity, checkProviderIntegrations } from "./provider-check.mjs";
import { readProviderManifests } from "./provider-manifest.mjs";
import { syncProviderCatalogs, syncProviderIntegrations } from "./provider-sync.mjs";
import { PROVIDER_REGISTRY_RELATIVE_PATH, WORKER_REGISTRY_RELATIVE_PATH } from "./provider-registry.mjs";
import {
  NONE_ALLOWED_READINESS_HEADINGS,
  REQUIRED_READINESS_HEADINGS,
  validateReadinessDoc,
} from "./provider-readiness-doc.mjs";
import {
  REVIEWED_ENVELOPE_ARTIFACTS,
  assertReviewedEnvelopeCompleteness,
  collectReviewedEnvelopeGaps,
  formatReviewedEnvelopeGap,
  parseCodeReviewedEnvelopes,
} from "./reviewed-envelope-check.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];
const EMPTY_ENVELOPE_SOURCE = "export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = [];\n";

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
  await fs.writeFile(path.join(rootDir, "worker/src/providerDispatchEnvelope.ts"), EMPTY_ENVELOPE_SOURCE);
  await syncProviderIntegrations({ rootDir });
  return { temporaryRoot, rootDir };
}

describe("checked-in provider manifests and projections", () => {
  it("covers every current vendor key with fail-closed safety and structurally truthful capability claims", { timeout: 180_000 }, async () => {
    const result = await checkProviderIntegrations({ rootDir: repoRoot, today: "2026-09-28" });
    const manifests = await readProviderManifests(repoRoot, { today: "2026-09-28" });

    expect(result.providerCount).toBe(18);
    expect(result.vendorKeys).toHaveLength(18);
    expect(result.vendorKeys).toContain("rmfg");
    expect(result.reviewedProviders).toEqual(["fictiv", "quickparts", "weerg"]);
    expect(result.defaultDenyExecuted).toEqual([
      { key: "quickparts", file: "worker/src/adapters/quickpartsProductionPortal.test.ts", passed: 10 },
      { key: "weerg", file: "worker/src/adapters/weergProductionPortal.test.ts", passed: 10 },
    ]);
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

  it("fails provider:check when a manifest has no registry entry", async () => {
    const { rootDir } = await createCheckedFixture();
    const registryPath = path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH);
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    registry.providers = registry.providers.filter((entry) => entry.key !== "rmfg");
    await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    await expect(checkProviderIntegrations({
      rootDir,
      today: "2026-09-28",
      checkConsumers: false,
    })).rejects.toThrow("provider manifest has no registry entry: rmfg");
  });

  it("fails provider:check when a generated registry file is hand-edited", async () => {
    const { rootDir } = await createCheckedFixture();
    const outputPath = path.join(rootDir, WORKER_REGISTRY_RELATIVE_PATH);
    await fs.appendFile(outputPath, "// hand edit\n");

    await expect(checkProviderIntegrations({
      rootDir,
      today: "2026-09-28",
      checkConsumers: false,
    })).rejects.toThrow(`generated provider registry is stale: ${WORKER_REGISTRY_RELATIVE_PATH}`);
  });
});

function readinessDocSource(key, { skip = null, emptyHeading = null } = {}) {
  const sections = REQUIRED_READINESS_HEADINGS
    .filter((heading) => heading !== skip)
    .map((heading) => `${heading}\n\n${heading === emptyHeading ? "" : `${key} content.\n`}`);
  return `# ${key} live readiness\n\n${sections.join("\n")}`;
}

function defaultDenyTestSource(key, envelopeId) {
  return `import { describe } from "vitest";
import {
  registerProductionPortalAuthorizationRefusals,
  type ProductionPortalDefaultDenyHarness,
} from "../../test-support/productionPortalDefaultDeny";

function defaultDenyHarness(): ProductionPortalDefaultDenyHarness {
  return {
    vendor: "${key}",
    envelopeId: "${envelopeId}",
  } as unknown as ProductionPortalDefaultDenyHarness;
}

describe("${key} production branch default-deny", () => {
  registerProductionPortalAuthorizationRefusals(defaultDenyHarness());
});
`;
}

function dispatchFixtureSource(key, version = 1) {
  return `import fixture from "../../test-fixtures/provider-dispatch-envelope/${key}-v${version}.json";
import { buildProviderDispatchFixtureEnvelope } from "./providerDispatchFixture.js";

export const ${key}DispatchEnvelope = (binding) => buildProviderDispatchFixtureEnvelope("${key}", fixture.envelope, binding);
`;
}

async function appendRegistryProvider(rootDir, entry) {
  const registryPath = path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH);
  let registry = { providers: [] };
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  registry.providers = [...registry.providers.filter((candidate) => candidate.key !== entry.key), entry];
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function writeCompleteReviewedProvider(rootDir, key, { reviewed = true, evidenceReference } = {}) {
  const envelopeId = `${key}-quote-envelope`;
  const envelope = {
    provider: key,
    ...(reviewed ? { reviewer: "ovd-691-fixture", reviewedAt: "2026-10-11" } : {}),
    envelope: { schema: "provider-dispatch-envelope.v1", provider: key, envelope: { id: envelopeId, version: 1 } },
  };
  const secretNameEnv = `${key.toUpperCase()}_STORAGE_STATE_SECRET_NAME`;
  const mountEnv = `${key.toUpperCase()}_STORAGE_STATE_JSON`;
  await fs.mkdir(path.join(rootDir, "provider-dispatch-envelope"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "provider-dispatch-envelope", `${key}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  await fs.mkdir(path.join(rootDir, "test-fixtures/provider-dispatch-envelope"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "test-fixtures/provider-dispatch-envelope", `${key}-v1.json`),
    `${JSON.stringify({
      description: `Synthetic ${key} envelope fixture.`,
      envelope: {
        schema: "provider-dispatch-envelope.v1",
        provider: key,
        envelope: { id: envelopeId, version: 1 },
        ...(evidenceReference ? { admission: { evidenceReference } } : {}),
      },
    }, null, 2)}\n`,
  );
  const docName = evidenceReference
    ? `${evidenceReference.toLowerCase().replace("-", "")}-${key}-live-readiness.md`
    : `${key}-live-readiness.md`;
  await fs.mkdir(path.join(rootDir, "docs/workflows"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "docs/workflows", docName),
    readinessDocSource(key),
  );
  await fs.mkdir(path.join(rootDir, "worker/test-support"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "worker/test-support", `${key}DispatchFixture.ts`),
    dispatchFixtureSource(key),
  );
  await fs.mkdir(path.join(rootDir, "worker/src/adapters"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "worker/src/adapters", `${key}ProductionPortal.test.ts`),
    defaultDenyTestSource(key, envelopeId),
  );
  await appendRegistryProvider(rootDir, {
    key,
    liveAdapter: false,
    sessionSecrets: [{ secretNameEnv, mountEnv, requiredWhenListed: true }],
    egress: "stable_nat",
  });
  await fs.mkdir(path.join(rootDir, "worker/src/generated"), { recursive: true });
  await fs.appendFile(
    path.join(rootDir, "worker/src/generated/providerRegistry.ts"),
    `export const ${key}SessionSecretNames = ["${secretNameEnv}", "${mountEnv}"] as const;\n`,
  );
  await fs.mkdir(path.join(rootDir, "worker/scripts/generated"), { recursive: true });
  await fs.appendFile(
    path.join(rootDir, "worker/scripts/generated/provider-secrets.sh"),
    `# ${secretNameEnv}\n# ${mountEnv}\n`,
  );
}

async function createEnvelopeRoot() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-reviewed-envelope-"));
  temporaryRoots.push(temporaryRoot);
  const envelopeSourcePath = path.join(temporaryRoot, "worker/src/providerDispatchEnvelope.ts");
  await fs.mkdir(path.dirname(envelopeSourcePath), { recursive: true });
  await fs.writeFile(envelopeSourcePath, EMPTY_ENVELOPE_SOURCE);
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
        envelope: {
          schema: "provider-dispatch-envelope.v1",
          provider: "acme",
          envelope: { id: "acme-quote-envelope", version: 1 },
        },
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

  it("passes current main providers or keeps only dated tracking exceptions", { timeout: 180_000 }, async () => {
    const result = await checkProviderIntegrations({ rootDir: repoRoot, today: "2026-10-11" });
    const gaps = await collectReviewedEnvelopeGaps({ rootDir: repoRoot, today: "2026-10-11" });

    expect(result.reviewedProviders).toEqual(["fictiv", "quickparts", "weerg"]);
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

  async function writeAcmeRegistry(rootDir, sessionSecrets) {
    await fs.writeFile(
      path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH),
      `${JSON.stringify({
        providers: [{
          key: "acme",
          liveAdapter: false,
          sessionSecrets,
          egress: "stable_nat",
        }],
      }, null, 2)}\n`,
    );
  }

  it("accepts OVD-688 registry mountPath declarations as names, not secret values", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await writeAcmeRegistry(rootDir, [{
      secretNameEnv: "ACME_STORAGE_STATE_SECRET_NAME",
      mountPath: "/var/secrets/acme-storage-state/storage-state.json",
      requiredWhenListed: true,
    }]);
    await fs.writeFile(
      path.join(rootDir, "worker/src/generated/providerRegistry.ts"),
      'export const acmeSessionSecretNames = ["ACME_STORAGE_STATE_SECRET_NAME"] as const;\n',
    );
    await fs.writeFile(
      path.join(rootDir, "worker/scripts/generated/provider-secrets.sh"),
      "# ACME_STORAGE_STATE_SECRET_NAME\n",
    );

    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).resolves.toEqual({ reviewedProviders: ["acme"] });
  });

  it.each([
    ["an invalid mountPath", [{
      secretNameEnv: "ACME_STORAGE_STATE_SECRET_NAME",
      mountPath: "/tmp/acme-storage-state.json",
      requiredWhenListed: true,
    }]],
    ["both mountEnv and mountPath", [{
      secretNameEnv: "ACME_STORAGE_STATE_SECRET_NAME",
      mountEnv: "ACME_STORAGE_STATE_JSON",
      mountPath: "/var/secrets/acme-storage-state/storage-state.json",
      requiredWhenListed: true,
    }]],
    ["neither mountEnv nor mountPath", [{
      secretNameEnv: "ACME_STORAGE_STATE_SECRET_NAME",
      requiredWhenListed: true,
    }]],
  ])("treats a registry secret with %s as missing deploy wiring", async (_label, sessionSecrets) => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await writeAcmeRegistry(rootDir, sessionSecrets);
    await expect(collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" })).resolves.toEqual([{
      key: "acme",
      artifact: "deploy wiring",
      expectedPath: PROVIDER_REGISTRY_RELATIVE_PATH,
    }]);
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

async function copyRepoReviewedEnvelopeInputs(rootDir) {
  const workflowDocs = (await fs.readdir(path.join(repoRoot, "docs/workflows")))
    .filter((name) => name.endsWith("-live-readiness.md"))
    .map((name) => `docs/workflows/${name}`);
  const fixtureJson = (await fs.readdir(path.join(repoRoot, "test-fixtures/provider-dispatch-envelope")))
    .map((name) => `test-fixtures/provider-dispatch-envelope/${name}`);
  const dispatchFixtures = (await fs.readdir(path.join(repoRoot, "worker/test-support")))
    .filter((name) => name.endsWith("DispatchFixture.ts"))
    .map((name) => `worker/test-support/${name}`);
  const defaultDenyTests = (await fs.readdir(path.join(repoRoot, "worker/src/adapters")))
    .filter((name) => name.endsWith("ProductionPortal.test.ts"))
    .map((name) => `worker/src/adapters/${name}`);
  const relativePaths = [
    "worker/src/providerDispatchEnvelope.ts",
    "worker/scripts/deploy-cloud-run.sh",
    "worker/src/runtimeSecrets.ts",
    "scripts/xometry-stable-egress-contract.mjs",
    "provider-integrations/provider-registry.v1.json",
    ...workflowDocs,
    ...fixtureJson,
    ...dispatchFixtures,
    ...defaultDenyTests,
  ];
  for (const relative of relativePaths) {
    await fs.mkdir(path.dirname(path.join(rootDir, relative)), { recursive: true });
    await fs.copyFile(path.join(repoRoot, relative), path.join(rootDir, relative));
  }
}

describe("reviewed envelope artifacts are bound to their own provider", () => {
  it("does not let provider A's readiness doc satisfy provider B by mentioning B", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "alpha");
    await writeCompleteReviewedProvider(rootDir, "beta");
    await fs.rm(path.join(rootDir, "docs/workflows/beta-live-readiness.md"));
    await fs.appendFile(
      path.join(rootDir, "docs/workflows/alpha-live-readiness.md"),
      `\nCompare with "beta" and 'beta' (beta-live-readiness).\n`,
    );
    await fs.writeFile(
      path.join(rootDir, "docs/workflows/alpha-beta-live-readiness.md"),
      `# alpha vs "beta" readiness\n`,
    );

    const gaps = await collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" });
    expect(gaps).toEqual([{
      key: "beta",
      artifact: "readiness doc",
      expectedPath: "docs/workflows/beta-live-readiness.md",
    }]);
  });

  it("does not let provider A's dispatch fixture satisfy provider B by mentioning B", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "alpha");
    await writeCompleteReviewedProvider(rootDir, "beta");
    await fs.rm(path.join(rootDir, "worker/test-support/betaDispatchFixture.ts"));
    await fs.appendFile(
      path.join(rootDir, "worker/test-support/alphaDispatchFixture.ts"),
      `export const alsoCovers = "beta"; // providerDispatchFixture for 'beta'\n`,
    );
    await fs.writeFile(
      path.join(rootDir, "worker/test-support/sharedDispatchFixture.ts"),
      `import fixture from "../../test-fixtures/provider-dispatch-envelope/beta-v1.json";\n`
        + `import { buildProviderDispatchFixtureEnvelope } from "./providerDispatchFixture.js";\n`,
    );

    const gaps = await collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" });
    expect(gaps).toEqual([{
      key: "beta",
      artifact: "dispatch fixture",
      expectedPath: "worker/test-support/betaDispatchFixture.ts",
    }]);
  });

  it("rejects a provider's own fixture module that imports another provider's envelope JSON", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "alpha");
    await writeCompleteReviewedProvider(rootDir, "beta");
    await fs.writeFile(
      path.join(rootDir, "worker/test-support/betaDispatchFixture.ts"),
      `import fixture from "../../test-fixtures/provider-dispatch-envelope/alpha-v1.json";\n`
        + `import { buildProviderDispatchFixtureEnvelope } from "./providerDispatchFixture.js";\n`
        + `export const provider = "beta";\n`,
    );

    const gaps = await collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" });
    expect(gaps.map((gap) => `${gap.key}:${gap.artifact}`)).toEqual(["beta:dispatch fixture"]);
  });

  it("does not let provider A's default-deny test satisfy provider B by mentioning B", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "alpha");
    await writeCompleteReviewedProvider(rootDir, "beta");
    await fs.rm(path.join(rootDir, "worker/src/adapters/betaProductionPortal.test.ts"));
    await fs.appendFile(
      path.join(rootDir, "worker/src/adapters/alphaProductionPortal.test.ts"),
      `const alsoCovers = "beta"; // productionPortalDefaultDeny for 'beta'\n`,
    );

    const gaps = await collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" });
    expect(gaps).toEqual([{
      key: "beta",
      artifact: "productionPortalDefaultDeny test",
      expectedPath: "worker/src/adapters/betaProductionPortal.test.ts",
    }]);
  });

  it.each([
    ["registers a harness for another vendor", (source) => source.replace('vendor: "beta"', 'vendor: "alpha"')],
    [
      "registers a harness for another envelope",
      (source) => source.replace('envelopeId: "beta-quote-envelope"', 'envelopeId: "alpha-quote-envelope"'),
    ],
    [
      "never calls the default-deny registrar",
      (source) => source.replace("  registerProductionPortalAuthorizationRefusals(defaultDenyHarness());\n", ""),
    ],
    [
      "imports the registrar from somewhere else",
      (source) => source.replace("test-support/productionPortalDefaultDeny", "test-support/somethingElse"),
    ],
  ])("rejects a provider's own default-deny test that %s", async (_label, mutate) => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "alpha");
    await writeCompleteReviewedProvider(rootDir, "beta");
    const testPath = path.join(rootDir, "worker/src/adapters/betaProductionPortal.test.ts");
    const original = await fs.readFile(testPath, "utf8");
    const mutated = mutate(original);
    expect(mutated).not.toBe(original);
    await fs.writeFile(testPath, `${mutated}\n// productionPortalDefaultDeny "beta" 'beta'\n`);

    const gaps = await collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" });
    expect(gaps.map((gap) => `${gap.key}:${gap.artifact}`)).toEqual(["beta:productionPortalDefaultDeny test"]);
  });

  it("fails when the Quickparts readiness doc is deleted even though the Weerg doc remains", async () => {
    const rootDir = await createEnvelopeRoot();
    await copyRepoReviewedEnvelopeInputs(rootDir);
    await expect(collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" })).resolves.toEqual([]);

    await fs.rm(path.join(rootDir, "docs/workflows/ovd674-quickparts-live-readiness.md"));

    await expect(assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" })).rejects.toThrow(
      formatReviewedEnvelopeGap("quickparts", "readiness doc", "docs/workflows/ovd674-quickparts-live-readiness.md"),
    );
  });

  it("detects a differently formatted reviewed envelope registry", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "gamma", { reviewed: false });
    await fs.writeFile(
      path.join(rootDir, "worker/src/providerDispatchEnvelope.ts"),
      `export const GAMMA_DISPATCH_ENVELOPE = Object.freeze({ 'id': 'gamma-quote-envelope', version: 1 } as const);

export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES: readonly ReviewedProviderDispatchEnvelope[] = ([
  { requiredAdmission: 'xometry_controlled_beta', provider: 'xometry', id: 'xometry-controlled-beta-envelope', version: 1 },
  {
    // reordered, single-quoted, and indirect
    'requiredAdmission'  :   \`generic_dispatch\`,
    version: GAMMA_DISPATCH_ENVELOPE.version,
    id: GAMMA_DISPATCH_ENVELOPE.id,
    "provider":
      'gamma'
  }] as const) satisfies readonly ReviewedProviderDispatchEnvelope[];
`,
    );

    await expect(assertReviewedEnvelopeCompleteness({
      rootDir,
      today: "2026-10-11",
    })).resolves.toEqual({ reviewedProviders: ["gamma"] });
    await fs.rm(path.join(rootDir, "docs/workflows/gamma-live-readiness.md"));
    await expect(assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" })).rejects.toThrow(
      formatReviewedEnvelopeGap("gamma", "readiness doc", "docs/workflows/gamma-live-readiness.md"),
    );
  });

  it("fails closed when a reviewed envelope entry is not statically resolvable", () => {
    expect(() => parseCodeReviewedEnvelopes(
      `export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = [{ ...other, requiredAdmission: "generic_dispatch" }];\n`,
    )).toThrow("is not statically resolvable");
    expect(() => parseCodeReviewedEnvelopes(
      `export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = [buildEnvelope("gamma")];\n`,
    )).toThrow("must be an object literal");
    expect(() => parseCodeReviewedEnvelopes(`export const SOMETHING_ELSE = [];\n`))
      .toThrow("does not declare REVIEWED_PROVIDER_DISPATCH_ENVELOPES");
  });

  it("derives the readiness doc path from the provider's own fixture evidence reference", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "delta", { evidenceReference: "OVD-9001" });
    await expect(collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" })).resolves.toEqual([]);

    await fs.rename(
      path.join(rootDir, "docs/workflows/ovd9001-delta-live-readiness.md"),
      path.join(rootDir, "docs/workflows/ovd9002-delta-live-readiness.md"),
    );
    await expect(collectReviewedEnvelopeGaps({ rootDir, today: "2026-10-11" })).resolves.toEqual([{
      key: "delta",
      artifact: "readiness doc",
      expectedPath: "docs/workflows/ovd9001-delta-live-readiness.md",
    }]);
  });
});

describe("reviewed envelope source fails closed", () => {
  const sourcePath = "worker/src/providerDispatchEnvelope.ts";

  it("throws when the envelope source file is missing", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await fs.rm(path.join(rootDir, sourcePath));
    await expect(assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" }))
      .rejects.toThrow(`provider:check: cannot read reviewed envelopes from ${sourcePath}: `);
  });

  it("throws when the envelope source has a syntax error", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await fs.writeFile(path.join(rootDir, sourcePath), "export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = [{ ;\n");
    await expect(assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" }))
      .rejects.toThrow(`provider:check: cannot read reviewed envelopes from ${sourcePath}: `);
  });

  it("still fails with the existing message when the source parses but has no export", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    await fs.writeFile(path.join(rootDir, sourcePath), "export const SOMETHING_ELSE = [];\n");
    await expect(assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" }))
      .rejects.toThrow("does not declare REVIEWED_PROVIDER_DISPATCH_ENVELOPES");
  });
});

describe("default-deny registrar call placement", () => {
  async function checkWithBody(body) {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    const header = defaultDenyTestSource("acme", "acme-quote-envelope").split("describe(")[0];
    await fs.writeFile(
      path.join(rootDir, "worker/src/adapters/acmeProductionPortal.test.ts"),
      `${header}${body}\n`,
    );
    return assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" });
  }
  const call = "registerProductionPortalAuthorizationRefusals(defaultDenyHarness())";

  it.each([
    ["top level", `${call};`],
    ["describe", `describe("a", () => { ${call}; });`],
    ["nested describe", `describe("a", () => { describe("b", function () { ${call}; }); });`],
  ])("accepts a call at %s", async (_name, body) => {
    await expect(checkWithBody(body)).resolves.toEqual({ reviewedProviders: ["acme"] });
  });

  it.each([
    ["if (false)", `if (false) { ${call}; }`, "IfStatement"],
    ["if without block", `if (false) ${call};`, "IfStatement"],
    ["ternary", `true ? ${call} : undefined;`, "ConditionalExpression"],
    ["try", `try { ${call}; } catch {}`, "TryStatement"],
    ["for", `for (let i = 0; i < 1; i += 1) { ${call}; }`, "ForStatement"],
    ["while", `while (false) { ${call}; }`, "WhileStatement"],
    ["helper function", `function helper() { ${call}; }`, "FunctionDeclaration"],
    ["arrow helper", `const helper = () => { ${call}; };`, "ArrowFunction"],
    ["it callback", `it("a", () => { ${call}; });`, "ArrowFunction"],
    ["&& expression", `(globalThis as any).x && ${call};`, "BinaryExpression"],
    ["|| expression", `(globalThis as any).x || ${call};`, "BinaryExpression"],
    ["if inside describe", `describe("a", () => { if (false) { ${call}; } });`, "IfStatement"],
    ["describe.skip", `describe.skip("a", () => { ${call}; });`, "ArrowFunction"],
    ["describe.todo", `describe.todo("a", () => { ${call}; });`, "ArrowFunction"],
    ["describe.skipIf", `describe.skipIf(true)("a", () => { ${call}; });`, "ArrowFunction"],
    ["describe.only", `describe.only("a", () => { ${call}; });`, "ArrowFunction"],
    ["describe.each with items", `describe.each([1])("a", () => { ${call}; });`, "ArrowFunction"],
    ["describe.each empty", `describe.each([])("a", () => { ${call}; });`, "ArrowFunction"],
    ["describe { skip: true }", `describe("a", { skip: true }, () => { ${call}; });`, "describe options argument"],
    ["describe { todo: true }", `describe("a", { todo: true }, () => { ${call}; });`, "describe options argument"],
    ["describe third-argument options", `describe("a", () => { ${call}; }, { skip: true });`, "describe options argument"],
    ["nested describe options", `describe("a", () => { describe("b", { skip: true }, () => { ${call}; }); });`, "describe options argument"],
  ])("rejects a call under %s and names %s", async (_name, body, kind) => {
    await expect(checkWithBody(body)).rejects.toThrow(`(inside ${kind})`);
  });
});

describe("readiness doc structure", () => {
  const docPath = "docs/workflows/acme-live-readiness.md";

  async function checkWithDoc(contents) {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "acme");
    if (contents === null) {
      await fs.rm(path.join(rootDir, docPath));
    } else {
      await fs.writeFile(path.join(rootDir, docPath), contents);
    }
    return assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" });
  }

  it("passes a conforming doc and does not require the recommended permissions heading", () => {
    expect(validateReadinessDoc(readinessDocSource("acme"))).toEqual([]);
  });

  it.each(REQUIRED_READINESS_HEADINGS)("fails when %s is missing", async (heading) => {
    await expect(checkWithDoc(readinessDocSource("acme", { skip: heading })))
      .rejects.toThrow(`missing heading: ${heading}`);
  });

  it.each(REQUIRED_READINESS_HEADINGS)("fails when the body under %s is empty", async (heading) => {
    await expect(checkWithDoc(readinessDocSource("acme", { emptyHeading: heading })))
      .rejects.toThrow(`empty section: ${heading}`);
  });

  it("fails when required headings are out of order", () => {
    const [first, second, ...rest] = REQUIRED_READINESS_HEADINGS;
    const swapped = [second, first, ...rest].map((heading) => `${heading}\n\nbody\n`).join("\n");
    expect(validateReadinessDoc(swapped).join(";")).toContain("out of order");
  });

  it("ignores headings inside fenced code blocks", () => {
    const fenced = `${REQUIRED_READINESS_HEADINGS.map((heading) => `\`\`\`\n${heading}\n\`\`\`\n`).join("")}`;
    expect(validateReadinessDoc(fenced)).toHaveLength(REQUIRED_READINESS_HEADINGS.length);
  });

  it("reports a missing doc through the existing gap message", async () => {
    await expect(checkWithDoc(null)).rejects.toThrow(
      formatReviewedEnvelopeGap("acme", "readiness doc", docPath),
    );
  });

  it("fails a one-character doc as malformed", async () => {
    await expect(checkWithDoc("x\n")).rejects.toThrow(`readiness doc ${docPath} is malformed`);
  });

  it("treats HTML comments and whitespace as empty section content", async () => {
    const commented = REQUIRED_READINESS_HEADINGS
      .map((heading) => `${heading}\n\n<!-- todo -->\n\n`)
      .join("");
    expect(validateReadinessDoc(commented)).toEqual(
      REQUIRED_READINESS_HEADINGS.map((heading) => `empty section: ${heading}`),
    );
    await expect(checkWithDoc(commented)).rejects.toThrow("empty section:");
  });

  it.each(["TBD", "todo", "N/A", "tbd.", "n.a.", "(TODO)"])(
    "treats a %s-only body as empty section content",
    async (placeholder) => {
      const doc = REQUIRED_READINESS_HEADINGS
        .map((heading) => `${heading}\n\n${placeholder}\n`)
        .join("");
      expect(validateReadinessDoc(doc)).toEqual(
        REQUIRED_READINESS_HEADINGS.map((heading) => `empty section: ${heading}`),
      );
      await expect(checkWithDoc(doc)).rejects.toThrow("empty section:");
    },
  );

  it.each([
    "TBD - later", "Coming soon", "TBD TODO", "WIP", "TBC",
    "TBD: fill in later.", "To be determined.", "FIXME", "XXX", "Lorem ipsum.", "- TODO: list gaps", "&nbsp;",
  ])(
    "treats a %s-only body as empty section content",
    async (placeholder) => {
      const doc = REQUIRED_READINESS_HEADINGS
        .map((heading) => `${heading}\n\n${placeholder}\n`)
        .join("");
      expect(validateReadinessDoc(doc)).toEqual(
        REQUIRED_READINESS_HEADINGS.map((heading) => `empty section: ${heading}`),
      );
      await expect(checkWithDoc(doc)).rejects.toThrow("empty section:");
    },
  );

  it("accepts an honest None. only where no gaps or inputs is a real answer", () => {
    const doc = REQUIRED_READINESS_HEADINGS
      .map((heading) => `${heading}\n\n${NONE_ALLOWED_READINESS_HEADINGS.includes(heading) ? "None." : "Real content."}\n`)
      .join("");
    expect(validateReadinessDoc(doc)).toEqual([]);
    const allNone = REQUIRED_READINESS_HEADINGS.map((heading) => `${heading}\n\nNone.\n`).join("");
    expect(validateReadinessDoc(allNone)).toEqual(
      REQUIRED_READINESS_HEADINGS
        .filter((heading) => !NONE_ALLOWED_READINESS_HEADINGS.includes(heading))
        .map((heading) => `empty section: ${heading}`),
    );
  });

  it("treats a whole section wrapped in an HTML comment as missing", async () => {
    const [, second] = REQUIRED_READINESS_HEADINGS;
    const doc = REQUIRED_READINESS_HEADINGS
      .map((heading) => {
        const section = `${heading}\n\nacme content.\n`;
        return heading === second ? `<!--\n${section}-->\n` : section;
      })
      .join("\n");
    expect(validateReadinessDoc(doc)).toEqual([`missing heading: ${second}`]);
    await expect(checkWithDoc(doc)).rejects.toThrow(`missing heading: ${second}`);
  });

  it("checks every readiness doc path that exists, not only the first", async () => {
    const rootDir = await createEnvelopeRoot();
    await writeCompleteReviewedProvider(rootDir, "delta", { evidenceReference: "OVD-9001" });
    await fs.writeFile(path.join(rootDir, "docs/workflows/delta-live-readiness.md"), "TBD\n");
    await expect(assertReviewedEnvelopeCompleteness({ rootDir, today: "2026-10-11" }))
      .rejects.toThrow("readiness doc docs/workflows/delta-live-readiness.md is malformed");
  });

  it.each([
    "docs/workflows/ovd673-fictiv-live-readiness.md",
    "docs/workflows/ovd674-quickparts-live-readiness.md",
    "docs/workflows/ovd675-weerg-live-readiness.md",
  ])("passes the checked-in readiness doc %s", async (relative) => {
    expect(validateReadinessDoc(await fs.readFile(path.join(repoRoot, relative), "utf8"))).toEqual([]);
  });

  it("treats a ###-only body as empty section content", async () => {
    const headed = REQUIRED_READINESS_HEADINGS
      .map((heading) => `${heading}\n\n### Details\n`)
      .join("");
    expect(validateReadinessDoc(headed)).toEqual(
      REQUIRED_READINESS_HEADINGS.map((heading) => `empty section: ${heading}`),
    );
    await expect(checkWithDoc(headed)).rejects.toThrow("empty section:");
  });

  it("keeps a section that has a sub-heading plus real body", () => {
    const doc = REQUIRED_READINESS_HEADINGS
      .map((heading) => `${heading}\n\n### Details\n\nReal content.\n`)
      .join("");
    expect(validateReadinessDoc(doc)).toEqual([]);
  });

  it("keeps a section that mentions TBD among real content", () => {
    const doc = REQUIRED_READINESS_HEADINGS
      .map((heading) => `${heading}\n\nTBD pending a live login capture.\n`)
      .join("");
    expect(validateReadinessDoc(doc)).toEqual([]);
  });
});
