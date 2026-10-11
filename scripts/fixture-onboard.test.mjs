// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  livePaths,
  nextMigrationTimestamp,
  parseFixtureOnboardArgs,
  runFixtureOnboard,
} from "./fixture-onboard.mjs";
import { scaffoldProvider } from "./provider-add.mjs";
import { PROVIDER_MANIFEST_FILE, createProviderManifest, formatManifest } from "./provider-manifest.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

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
  it("reproduces provider:add output exactly and is a no-op on rerun", async () => {
    const viaFixture = await createRoot({ vendorKeys: ["xometry"] });
    const viaProviderAdd = await createRoot({ vendorKeys: ["xometry"] });
    const fixtureResult = await runFixtureOnboard({
      rootDir: viaFixture, stage: "envelope", url: "https://www.shopname.com/path",
    });
    const providerAddResult = await scaffoldProvider({ rootDir: viaProviderAdd, url: "https://www.shopname.com/path" });

    expect(fixtureResult).toEqual(providerAddResult);
    expect(fixtureResult.files).toEqual([
      "provider-integrations/shopname/manifest.v1.json",
      "provider-integrations/shopname/01-add-vendor-enum.sql.stub",
      "provider-integrations/shopname/02-add-disabled-admission-policy.sql.stub",
    ]);
    expect(await snapshot(viaFixture)).toEqual(await snapshot(viaProviderAdd));

    const before = await snapshot(viaFixture);
    await expect(runFixtureOnboard({ rootDir: viaFixture, key: "shopname", stage: "envelope", url: "https://shopname.com/" }))
      .resolves.toMatchObject({ alreadyExists: true, files: [] });
    await expect(runFixtureOnboard({ rootDir: viaFixture, key: "shopname", stage: "envelope" }))
      .resolves.toEqual({ key: "shopname", stage: "envelope", dryRun: false, alreadyExists: true, files: [] });
    expect(await snapshot(viaFixture)).toEqual(before);
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

  it("rejects unknown stages and malformed issues", async () => {
    const root = await createRoot();
    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "deploy" })).rejects.toThrow("unknown stage");
    await expect(runFixtureOnboard({ rootDir: root, key: "shopname", stage: "live", issue: "ovd-1" })).rejects.toThrow("invalid --issue");
  });
});
