// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  livePaths,
  nextMigrationTimestamp,
  parseFixtureOnboardArgs,
  readLiveAutomationVendors,
  runFixtureOnboard,
  runFixtureOnboardCli,
} from "./fixture-onboard.mjs";
import { scaffoldProvider } from "./provider-add.mjs";
import {
  PROVIDER_MANIFEST_FILE,
  WEB_CATALOG_RELATIVE_PATH,
  WORKER_CATALOG_RELATIVE_PATH,
  createProviderManifest,
  formatManifest,
} from "./provider-manifest.mjs";
import {
  PROVIDER_REGISTRY_RELATIVE_PATH,
  WORKER_REGISTRY_RELATIVE_PATH,
  WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
  defaultRegistryEntry,
} from "./provider-registry.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const XOMETRY_ENTRY = { key: "xometry", liveAdapter: true, sessionSecrets: [], egress: "stable_nat" };
const SYNCED_OUTPUTS = [
  WEB_CATALOG_RELATIVE_PATH,
  WORKER_CATALOG_RELATIVE_PATH,
  WORKER_REGISTRY_RELATIVE_PATH,
  WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
];

function registryDocument(providers) {
  const document = {
    $schema: "./provider-registry.v1.schema.json",
    schemaVersion: 1,
    stableEgressRequiredKey: "xometry",
    providers,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function writeRegistry(root, providers) {
  await fs.writeFile(path.join(root, PROVIDER_REGISTRY_RELATIVE_PATH), registryDocument(providers));
}

async function readRegistryFile(root) {
  return fs.readFile(path.join(root, PROVIDER_REGISTRY_RELATIVE_PATH), "utf8");
}

async function createRoot({ vendorKeys = ["xometry", "shopname"], liveKeys = vendorKeys } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-fixture-onboard-"));
  temporaryRoots.push(root);
  const union = vendorKeys.map((key) => `  | "${key}"`).join("\n");
  await fs.mkdir(path.join(root, "src/integrations/supabase"), { recursive: true });
  await fs.mkdir(path.join(root, "worker/src"), { recursive: true });
  await fs.mkdir(path.join(root, "provider-integrations"), { recursive: true });
  await fs.mkdir(path.join(root, "supabase/migrations"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src/integrations/supabase/types.ts"),
    `export type Database = { public: { Enums: { vendor_name:\n${union}\n} } };\n`,
  );
  await fs.writeFile(
    path.join(root, "worker/src/types.ts"),
    `export type VendorName =\n${union};\n\nexport const LIVE_AUTOMATION_VENDORS = [\n${liveKeys.map((key) => `  "${key}",`).join("\n")}\n] as const;\n`,
  );
  await fs.writeFile(path.join(root, "worker/.env.example"), "WORKER_MODE=simulate\n");
  await writeRegistry(root, [XOMETRY_ENTRY]);
  for (const name of ["20261011170000_fix_no_drawing_lifecycle.sql", "20261011180000_ovd673_fictiv.sql"]) {
    await fs.writeFile(path.join(root, "supabase/migrations", name), "-- applied\n");
  }
  return root;
}

async function addEnvelopeManifest(root, key = "shopname", files = ["step", "stp"]) {
  const manifest = createProviderManifest({
    key,
    displayName: "Shop Name",
    officialUrl: `https://www.${key}.com/quote`,
  });
  manifest.capabilityEnvelope.files = { status: "supported", values: files };
  manifest.evidence = { firstPartyUrls: [`https://www.${key}.com/files`], reviewedAt: "2026-10-01" };
  const directory = path.join(root, "provider-integrations", key);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, PROVIDER_MANIFEST_FILE), formatManifest(manifest));
  return manifest;
}

async function snapshot(root) {
  const files = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[path.relative(root, full)] = await fs.readFile(full, "utf8");
    }
  }
  await walk(root);
  return files;
}

const LIVE_OUTPUTS = Object.values(livePaths("shopname"));

describe("fixture:onboard --stage=envelope", () => {
  it("scaffolds what provider:add does, adds a default-off registry entry, syncs, and is a no-op on rerun", async () => {
    const viaFixture = await createRoot({ vendorKeys: ["xometry"] });
    const viaProviderAdd = await createRoot({ vendorKeys: ["xometry"] });
    const fixtureResult = await runFixtureOnboard({
      rootDir: viaFixture, stage: "envelope", url: "https://www.shopname.com/path",
    });
    const providerAddResult = await scaffoldProvider({ rootDir: viaProviderAdd, url: "https://www.shopname.com/path" });

    expect(fixtureResult).toEqual({ ...providerAddResult, registryEntry: "added", synced: SYNCED_OUTPUTS });
    expect(fixtureResult.files).toEqual([
      "provider-integrations/shopname/manifest.v1.json",
      "provider-integrations/shopname/01-add-vendor-enum.sql.stub",
      "provider-integrations/shopname/02-add-disabled-admission-policy.sql.stub",
    ]);
    const scaffolded = await snapshot(viaFixture);
    const scaffoldOnly = await snapshot(viaProviderAdd);
    for (const file of fixtureResult.files) {
      expect(scaffolded[file]).toBe(scaffoldOnly[file]);
    }
    expect(await readRegistryFile(viaFixture)).toBe(registryDocument([defaultRegistryEntry("shopname"), XOMETRY_ENTRY]));
    expect(defaultRegistryEntry("shopname")).toEqual({ key: "shopname", liveAdapter: false, sessionSecrets: [], egress: "none" });
    const workerRegistry = scaffolded[WORKER_REGISTRY_RELATIVE_PATH];
    expect(workerRegistry).toContain('PRODUCTION_LIVE_ADAPTERS = ["xometry"]');
    expect(workerRegistry).toContain("shopname");
    expect(Object.keys(scaffolded)).toEqual(expect.arrayContaining(SYNCED_OUTPUTS));

    await expect(runFixtureOnboard({ rootDir: viaFixture, key: "shopname", stage: "envelope", url: "https://shopname.com/" }))
      .resolves.toMatchObject({ alreadyExists: true, files: [], registryEntry: "unchanged", synced: [] });
    await expect(runFixtureOnboard({ rootDir: viaFixture, key: "shopname", stage: "envelope" }))
      .resolves.toEqual({
        key: "shopname", stage: "envelope", dryRun: false, alreadyExists: true, files: [], registryEntry: "unchanged", synced: [],
      });
    expect(await snapshot(viaFixture)).toEqual(scaffolded);
  });

  it("never changes an existing registry entry", async () => {
    const root = await createRoot();
    await addEnvelopeManifest(root);
    const reviewed = {
      key: "shopname",
      liveAdapter: true,
      sessionSecrets: [{
        secretNameEnv: "SHOPNAME_STORAGE_STATE_SECRET_NAME",
        mountEnv: "SHOPNAME_STORAGE_STATE_JSON",
        requiredWhenListed: true,
      }],
      egress: "stable_nat",
    };
    await writeRegistry(root, [reviewed, XOMETRY_ENTRY]);
    const before = await snapshot(root);

    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "envelope" }))
      .resolves.toMatchObject({ alreadyExists: true, registryEntry: "unchanged", synced: [] });
    await expect(runFixtureOnboard({ rootDir: root, stage: "envelope", url: "https://www.shopname.com/quote" }))
      .resolves.toMatchObject({ alreadyExists: true, registryEntry: "unchanged", synced: [] });
    expect(await snapshot(root)).toEqual(before);
    expect(await readRegistryFile(root)).toBe(registryDocument([reviewed, XOMETRY_ENTRY]));
  });

  it("adds the missing entry for an existing manifest without touching other entries", async () => {
    const root = await createRoot();
    await addEnvelopeManifest(root);
    const result = await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "envelope" });
    expect(result).toMatchObject({ alreadyExists: true, files: [], registryEntry: "added", synced: SYNCED_OUTPUTS });
    expect(await readRegistryFile(root)).toBe(registryDocument([defaultRegistryEntry("shopname"), XOMETRY_ENTRY]));

    const before = await snapshot(root);
    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "envelope" }))
      .resolves.toMatchObject({ registryEntry: "unchanged", synced: [] });
    expect(await snapshot(root)).toEqual(before);
  });

  it("writes nothing during a dry-run and refuses an invalid registry before scaffolding", async () => {
    const root = await createRoot({ vendorKeys: ["xometry"] });
    const before = await snapshot(root);
    await expect(runFixtureOnboard({ rootDir: root, stage: "envelope", url: "https://shopname.com/", dryRun: true }))
      .resolves.toMatchObject({ alreadyExists: false, registryEntry: "added", synced: [] });
    expect(await snapshot(root)).toEqual(before);

    await fs.writeFile(path.join(root, PROVIDER_REGISTRY_RELATIVE_PATH), "{}\n");
    const invalid = await snapshot(root);
    await expect(runFixtureOnboard({ rootDir: root, stage: "envelope", url: "https://shopname.com/" }))
      .rejects.toThrow("registry");
    expect(await snapshot(root)).toEqual(invalid);
  });

  it("refuses a key that disagrees with the URL or has no manifest and no URL", async () => {
    const root = await createRoot();
    await expect(runFixtureOnboard({ rootDir: root, key: "othername", stage: "envelope", url: "https://shopname.com/" }))
      .rejects.toThrow("derives provider key shopname");
    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "envelope" }))
      .rejects.toThrow("pass --url");
  });
});

describe("fixture:onboard --stage=live", () => {
  it("generates every live artifact deterministically and re-running is a no-op", async () => {
    const first = await createRoot();
    const second = await createRoot();
    await addEnvelopeManifest(first);
    await addEnvelopeManifest(second);

    const result = await runFixtureOnboard({ rootDir: first, key: "shopname", stage: "live" });
    await runFixtureOnboard({ rootDir: second, key: "shopname", stage: "live" });
    expect([...result.created, ...result.appended].sort()).toEqual([...LIVE_OUTPUTS].sort());
    expect(await snapshot(first)).toEqual(await snapshot(second));

    const before = await snapshot(first);
    const rerun = await runFixtureOnboard({ rootDir: first, key: "shopname", stage: "live" });
    expect(rerun).toMatchObject({ created: [], appended: [], kept: [] });
    expect(rerun.unchanged.sort()).toEqual([...LIVE_OUTPUTS].sort());
    expect(await snapshot(first)).toEqual(before);
    expect(await readRegistryFile(first)).toBe(registryDocument([XOMETRY_ENTRY]));
  });

  it("writes nothing during a dry-run", async () => {
    const root = await createRoot();
    await addEnvelopeManifest(root);
    const before = await snapshot(root);
    const result = await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "live", dryRun: true });
    expect(result.created).toHaveLength(LIVE_OUTPUTS.length - 1);
    expect(await snapshot(root)).toEqual(before);
  });

  it("never overwrites a file a human has edited", async () => {
    const root = await createRoot();
    await addEnvelopeManifest(root);
    await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "live" });
    const portal = path.join(root, livePaths("shopname").productionPortal);
    await fs.writeFile(portal, "// reviewed by a human\n");

    const rerun = await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "live" });
    expect(rerun.kept).toEqual([livePaths("shopname").productionPortal]);
    expect(await fs.readFile(portal, "utf8")).toBe("// reviewed by a human\n");
  });

  it("generates default-off, non-authoritative, secret-free output", async () => {
    const root = await createRoot();
    await addEnvelopeManifest(root);
    await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "live" });
    const paths = livePaths("shopname");
    const read = (relative) => fs.readFile(path.join(root, relative), "utf8");

    const fixture = JSON.parse(await read(paths.envelopeFixture));
    expect(fixture.envelope).toMatchObject({
      schema: "provider-dispatch-envelope.v1",
      provider: "shopname",
      envelope: { id: "shopname-quote-envelope", version: 1 },
      admission: { evidenceReference: "OVD-687" },
      purpose: "quote_only",
    });
    expect(fixture.envelope.outboundFiles).toEqual([
      { role: "cad", sourceSha256: "b".repeat(64), sha256: "b".repeat(64), derivation: "identity" },
    ]);

    const portal = await read(paths.productionPortal);
    expect(portal).toContain('assessEligibility: () => ({ state: "unavailable"');
    expect(portal).toContain("extractOffers: () => []");
    expect(portal).toContain('supportedFileExtensions: ["step", "stp"]');
    expect(portal).toContain('SHOPNAME_ALLOWED_HOSTS = ["shopname.com"]');
    expect(await read(paths.authorizationBinding)).toContain("providerDispatchAuthorizationDenial(");
    const test = await read(paths.productionPortalTest);
    expect(test).toContain("registerProductionPortalAuthorizationRefusals");
    expect(test).toContain('unauthorizedCadName: "part.sldprt"');
    expect(await read(paths.dispatchFixture)).toContain("buildProviderDispatchFixtureEnvelope");
    expect(await read(paths.productionPortalBrowserTest)).toContain("describe.skip(");

    const readiness = await read(paths.readinessDoc);
    expect(readiness).toContain("one reviewed edit to the `shopname` entry in\n   `provider-integrations/provider-registry.v1.json`");
    expect(readiness).toContain("Then run `npm run provider:sync`");
    expect(readiness).toContain("Do not\n   hand-edit `worker/src/runtimeSecrets.ts`, `worker/scripts/deploy-cloud-run.sh`");
    expect(readiness).toContain("never edit the generated");

    const env = await read(paths.sessionSecret);
    expect(env.startsWith("WORKER_MODE=simulate\n# fixture:onboard shopname session")).toBe(true);
    const generatedEnv = env.split("\n").slice(1).filter(Boolean);
    expect(generatedEnv.every((line) => line.startsWith("#"))).toBe(true);

    const everything = Object.values(await snapshot(root)).join("\n");
    expect(everything).not.toMatch(/REVIEWED_PROVIDER_DISPATCH_ENVELOPES\s*[:=]|PRODUCTION_LIVE_ADAPTERS\s*=/);
    expect(everything).not.toMatch(/sk-[A-Za-z0-9]{8}|BEGIN [A-Z ]*PRIVATE KEY|"value":\s*"[^"]+"/);
  });

  it("refuses before stage 1 is complete or the worker identity exists", async () => {
    const noFiles = await createRoot();
    const manifest = createProviderManifest({ key: "shopname", displayName: "Shop Name", officialUrl: "https://shopname.com/" });
    await fs.mkdir(path.join(noFiles, "provider-integrations/shopname"));
    await fs.writeFile(path.join(noFiles, "provider-integrations/shopname", PROVIDER_MANIFEST_FILE), formatManifest(manifest));
    await expect(runFixtureOnboard({ rootDir: noFiles, key: "shopname", stage: "live" }))
      .rejects.toThrow("no evidence-backed CAD file envelope");

    const noManifest = await createRoot();
    await expect(runFixtureOnboard({ rootDir: noManifest, key: "shopname", stage: "live" }))
      .rejects.toThrow("run --stage=envelope first");

    const notLive = await createRoot({ vendorKeys: ["xometry", "shopname"], liveKeys: ["xometry"] });
    await addEnvelopeManifest(notLive);
    await expect(runFixtureOnboard({ rootDir: notLive, key: "shopname", stage: "live" }))
      .rejects.toThrow("LIVE_AUTOMATION_VENDORS");
    expect(Object.keys(await snapshot(notLive))).not.toContain(livePaths("shopname").productionPortal);
  });
});

describe("fixture:onboard --stage=admit", () => {
  it("refuses before the live stage", async () => {
    const root = await createRoot();
    await addEnvelopeManifest(root);
    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "admit" }))
      .rejects.toThrow("run --stage=live first");
  });

  it("writes review-only SQL at the next free timestamp, never into supabase/migrations, and is stable on rerun", async () => {
    const root = await createRoot();
    await addEnvelopeManifest(root);
    await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "live" });
    const migrationsBefore = await fs.readdir(path.join(root, "supabase/migrations"));

    const result = await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "admit", issue: "OVD-999" });
    expect(result).toMatchObject({ migrationTimestamp: "20261011190000", reviewOnly: true, kept: [] });
    expect(result.created).toEqual([
      "provider-integrations/shopname/admit/20261011190000_shopname_reviewed_dispatch_envelope.sql.review",
      "provider-integrations/shopname/admit/shopname_admission_revision.sql.review",
      "provider-integrations/shopname/admit/rollout-runbook.md",
    ]);
    expect(await fs.readdir(path.join(root, "supabase/migrations"))).toEqual(migrationsBefore);

    const read = (relative) => fs.readFile(path.join(root, relative), "utf8");
    const envelopeSql = await read(result.created[0]);
    expect(envelopeSql.startsWith("-- REVIEW-ONLY. NOT A MIGRATION. NOT APPLIED.")).toBe(true);
    expect(envelopeSql).toContain("insert into private.provider_dispatch_envelope_reviews");
    expect(envelopeSql).toContain("'shopname-quote-envelope'");
    expect(envelopeSql).toContain("'OVD-999'");
    const admissionSql = await read(result.created[1]);
    expect(admissionSql).toContain("generic_dispatch_enabled = true");
    expect(admissionSql).toContain("admission_state = 'approved'");
    expect(admissionSql).toContain("accepted_file_extensions = array['step', 'stp']");
    expect(admissionSql).toMatch(/<reviewer user uuid>/);
    const runbook = await read(result.created[2]);
    for (const step of ["automatic_quote_collection", "Organization enablement", "WORKER_LIVE_ADAPTERS", "SHOPNAME_STORAGE_STATE_SECRET_NAME", "Certification run"]) {
      expect(runbook).toContain(step);
    }

    // A later migration does not move an already generated review file.
    await fs.writeFile(path.join(root, "supabase/migrations/20261012000000_later.sql"), "-- applied\n");
    const rerun = await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "admit", issue: "OVD-999" });
    expect(rerun).toMatchObject({ migrationTimestamp: "20261011190000", created: [], kept: [] });
    expect(rerun.unchanged).toEqual(result.created);
  });

  it("skips timestamps already claimed by another provider's pending review", async () => {
    const root = await createRoot({ vendorKeys: ["xometry", "shopname", "othershop"] });
    await addEnvelopeManifest(root);
    await addEnvelopeManifest(root, "othershop");
    for (const key of ["othershop", "shopname"]) {
      await runFixtureOnboard({ rootDir: root, key, stage: "live" });
    }
    const other = await runFixtureOnboard({ rootDir: root, key: "othershop", stage: "admit" });
    const mine = await runFixtureOnboard({ rootDir: root, key: "shopname", stage: "admit" });
    expect(other.migrationTimestamp).toBe("20261011190000");
    expect(mine.migrationTimestamp).toBe("20261011200000");
  });
});

describe("readLiveAutomationVendors", () => {
  it("ignores line- and block-commented vendors and rejects live onboarding of them", async () => {
    const root = await createRoot({ vendorKeys: ["xometry", "foo", "bar"], liveKeys: ["xometry"] });
    const typesPath = path.join(root, "worker/src/types.ts");
    const source = await fs.readFile(typesPath, "utf8");
    await fs.writeFile(
      typesPath,
      source.replace('  "xometry",\n', '  "xometry",\n  // "foo",\n  /* "bar", */\n'),
    );
    expect(await fs.readFile(typesPath, "utf8")).toContain('// "foo",');

    await expect(readLiveAutomationVendors(root)).resolves.toEqual(["xometry"]);
    for (const key of ["foo", "bar"]) {
      await addEnvelopeManifest(root, key);
      await expect(runFixtureOnboard({ rootDir: root, key, stage: "live" }))
        .rejects.toThrow("LIVE_AUTOMATION_VENDORS");
    }
  });

  it("unwraps satisfies and parentheses, and throws when absent, not an array, or unparsable", async () => {
    const root = await createRoot();
    const typesPath = path.join(root, "worker/src/types.ts");
    await fs.writeFile(typesPath, 'export const LIVE_AUTOMATION_VENDORS = (["a1", "b2"] as const) satisfies readonly string[];\n');
    await expect(readLiveAutomationVendors(root)).resolves.toEqual(["a1", "b2"]);

    await fs.writeFile(typesPath, 'const LIVE_AUTOMATION_VENDORS = ["a1"] as const;\n');
    await expect(readLiveAutomationVendors(root)).rejects.toThrow("could not locate worker LIVE_AUTOMATION_VENDORS");
    await fs.writeFile(typesPath, 'export const LIVE_AUTOMATION_VENDORS = "a1";\n');
    await expect(readLiveAutomationVendors(root)).rejects.toThrow("could not locate worker LIVE_AUTOMATION_VENDORS");
    await fs.writeFile(typesPath, 'export const LIVE_AUTOMATION_VENDORS = [ "a1" ;\n');
    await expect(readLiveAutomationVendors(root)).rejects.toThrow("could not parse");
  });

  it("returns the real worker list unchanged", async () => {
    await expect(readLiveAutomationVendors(process.cwd())).resolves.toEqual([
      "xometry", "fictiv", "protolabs", "sendcutsend", "oshcut", "fabworks",
      "ponoko", "quickparts", "rapiddirect", "geomiq", "weerg", "protolabsnetwork",
    ]);
  });
});

describe("fixture:onboard helpers", () => {
  it("carries the migration timestamp across day and year boundaries", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "supabase/migrations/20261231233000_last.sql"), "");
    await expect(nextMigrationTimestamp(root)).resolves.toBe("20270101003000");
  });

  it("parses stage, key, and the provider:add alias form", () => {
    expect(parseFixtureOnboardArgs(["shopname", "--stage=live"])).toEqual({ key: "shopname", stage: "live", dryRun: false });
    expect(parseFixtureOnboardArgs(["shopname", "--stage", "admit", "--issue", "OVD-12", "--dry-run"]))
      .toEqual({ key: "shopname", stage: "admit", issue: "OVD-12", dryRun: true });
    expect(parseFixtureOnboardArgs(["--stage=envelope", "--url", "https://shopname.com/"]))
      .toEqual({ stage: "envelope", url: "https://shopname.com/", dryRun: false });
    expect(() => parseFixtureOnboardArgs(["--stage=live"])).toThrow("Usage");
    expect(() => parseFixtureOnboardArgs(["shopname", "--stage=live", "--force"])).toThrow("unknown argument");
  });

  it("keeps provider:add as an alias of --stage=envelope", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["provider:add"]).toBe("node scripts/fixture-onboard.mjs --stage=envelope");
    expect(pkg.scripts["fixture:onboard"]).toBe("node scripts/fixture-onboard.mjs");
  });

  it("adds the default-off registry entry through the provider:add CLI alias and is a no-op on rerun", async () => {
    const root = await createRoot({ vendorKeys: ["xometry"] });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const aliasArgv = ["--stage=envelope", "--url", "https://shopname.com/"];
      await runFixtureOnboardCli(aliasArgv, root);
      expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ key: "shopname", registryEntry: "added", synced: SYNCED_OUTPUTS });
      const before = await snapshot(root);
      await runFixtureOnboardCli(aliasArgv, root);
      expect(JSON.parse(write.mock.calls[1][0])).toMatchObject({ alreadyExists: true, registryEntry: "unchanged", synced: [] });
      expect(await snapshot(root)).toEqual(before);
    } finally {
      write.mockRestore();
    }
    expect(await readRegistryFile(root)).toBe(registryDocument([defaultRegistryEntry("shopname"), XOMETRY_ENTRY]));
  });

  it("rejects unknown stages and malformed issues", async () => {
    const root = await createRoot();
    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "deploy" })).rejects.toThrow("unknown stage");
    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "live", issue: "ovd-1" })).rejects.toThrow("invalid --issue");
  });
});
