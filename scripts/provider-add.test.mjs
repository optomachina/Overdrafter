// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { scaffoldProvider } from "./provider-add.mjs";
import {
  PROVIDER_MANIFEST_FILE,
  createProviderManifest,
  deriveProviderKey,
  formatManifest,
  normalizeProviderUrl,
} from "./provider-manifest.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createFixture(vendorKeys = ["xometry"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-provider-add-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "src/integrations/supabase"), { recursive: true });
  await fs.mkdir(path.join(root, "worker/src"), { recursive: true });
  const union = vendorKeys.map((key) => `  | "${key}"`).join("\n");
  await fs.writeFile(
    path.join(root, "src/integrations/supabase/types.ts"),
    `export type Database = { public: { Enums: { vendor_name:\n${union}\n} } };\n`,
  );
  await fs.writeFile(
    path.join(root, "worker/src/types.ts"),
    `export type VendorName =\n${union};\n`,
  );
  await fs.mkdir(path.join(root, "provider-integrations"), { recursive: true });
  return root;
}

async function addFixtureManifest(root, manifest) {
  const directory = path.join(root, "provider-integrations", manifest.key);
  await fs.mkdir(directory, { recursive: false });
  await fs.writeFile(path.join(directory, PROVIDER_MANIFEST_FILE), formatManifest(manifest));
}

describe("provider URL normalization", () => {
  it("requires HTTPS and normalizes www before deriving a stable key", () => {
    expect(normalizeProviderUrl("https://www.ShopName.com/some/path?ignored=yes")).toBe("https://shopname.com/");
    expect(deriveProviderKey("https://www.shopname.com/")).toBe("shopname");
  });

  it.each([
    "http://shopname.com",
    "https://user:password@shopname.com",
    "https://shopname.com:8443",
    "https://localhost",
    "https://127.0.0.1",
    "not-a-url",
  ])("refuses unsafe provider URL %s", (url) => {
    expect(() => normalizeProviderUrl(url)).toThrow();
  });
});

describe("provider scaffolder", () => {
  it("is deterministic and leaves no files during dry-run", async () => {
    const root = await createFixture();
    const first = await scaffoldProvider({ rootDir: root, url: "https://www.shopname.com/path", dryRun: true });
    const second = await scaffoldProvider({ rootDir: root, url: "https://shopname.com/", dryRun: true });

    expect(first).toEqual(second);
    await expect(fs.access(path.join(root, "provider-integrations/shopname"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a conservative manifest plus two disabled review stubs for a genuinely new key", async () => {
    const root = await createFixture();
    const result = await scaffoldProvider({ rootDir: root, url: "https://www.shopname.com/" });

    expect(result.existingVendorKey).toBe(false);
    expect(result.alreadyExists).toBe(false);
    expect(result.files).toEqual([
      "provider-integrations/shopname/manifest.v1.json",
      "provider-integrations/shopname/01-add-vendor-enum.sql.stub",
      "provider-integrations/shopname/02-add-disabled-admission-policy.sql.stub",
    ]);
    const manifest = JSON.parse(await fs.readFile(path.join(root, result.files[0]), "utf8"));
    expect(manifest.capabilityEnvelope).toMatchObject({
      processes: { status: "unknown", values: [] },
      materials: { status: "unknown", values: [] },
      files: { status: "unknown", values: [] },
      quantity: { status: "unknown", minimum: null, maximum: null },
    });
    expect(manifest.safety).toEqual({
      quoteOnly: true,
      orderingProhibited: true,
      sessionIsolationRequired: true,
    });
    expect(manifest.evidence).toEqual({ firstPartyUrls: [], reviewedAt: null });

    const enumStub = await fs.readFile(path.join(root, result.files[1]), "utf8");
    const policyStub = await fs.readFile(path.join(root, result.files[2]), "utf8");
    expect(enumStub).toContain("add value if not exists 'shopname'");
    expect(policyStub).toContain("'disabled'");
    expect(policyStub).toContain("false");
    expect(policyStub).not.toMatch(/'approved'|'controlled_beta_only'|\btrue\b/);
    expect(result.files.join("\n")).not.toMatch(/secret|token|cookie|credential/i);
  });

  it("removes an incomplete scaffold after a later write fails and permits a clean rerun", async () => {
    const root = await createFixture();
    const providerDir = path.join(root, "provider-integrations/shopname");
    const originalWriteFile = fs.writeFile;
    const writeFile = vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
      if (path.basename(file.toString()) === "01-add-vendor-enum.sql.stub") {
        throw Object.assign(new Error("simulated later scaffold write failure"), { code: "EIO" });
      }
      return originalWriteFile(file, ...args);
    });

    try {
      await expect(scaffoldProvider({ rootDir: root, url: "https://shopname.com/" })).rejects.toThrow(
        "simulated later scaffold write failure",
      );
    } finally {
      writeFile.mockRestore();
    }

    await expect(fs.access(providerDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(path.join(root, "provider-integrations")))
        .filter((entry) => entry.startsWith(".shopname-scaffold-")),
    ).toEqual([]);

    const result = await scaffoldProvider({ rootDir: root, url: "https://shopname.com/" });
    expect(result.alreadyExists).toBe(false);
    expect((await fs.readdir(providerDir)).sort()).toEqual([
      "01-add-vendor-enum.sql.stub",
      "02-add-disabled-admission-policy.sql.stub",
      "manifest.v1.json",
    ]);
  });

  it("does not create migration stubs when the key already exists in the enum", async () => {
    const root = await createFixture(["xometry"]);
    const result = await scaffoldProvider({ rootDir: root, url: "https://www.xometry.com/" });

    expect(result.existingVendorKey).toBe(true);
    expect(result.alreadyExists).toBe(false);
    expect(result.files).toEqual(["provider-integrations/xometry/manifest.v1.json"]);
  });

  it("returns deterministic dry-run and normal no-ops for an exact provider rerun", async () => {
    const root = await createFixture();
    await scaffoldProvider({ rootDir: root, url: "https://shopname.com/" });
    const providerDir = path.join(root, "provider-integrations/shopname");
    const beforeFiles = (await fs.readdir(providerDir)).sort();
    const beforeManifest = await fs.readFile(path.join(providerDir, PROVIDER_MANIFEST_FILE), "utf8");

    await expect(scaffoldProvider({
      rootDir: root,
      url: "https://www.shopname.com/some/path",
      dryRun: true,
    })).resolves.toEqual({
      key: "shopname",
      domain: "shopname.com",
      dryRun: true,
      existingVendorKey: false,
      alreadyExists: true,
      files: [],
    });
    await expect(scaffoldProvider({
      rootDir: root,
      url: "https://shopname.com/",
    })).resolves.toEqual({
      key: "shopname",
      domain: "shopname.com",
      dryRun: false,
      existingVendorKey: false,
      alreadyExists: true,
      files: [],
    });
    expect((await fs.readdir(providerDir)).sort()).toEqual(beforeFiles);
    expect(await fs.readFile(path.join(providerDir, PROVIDER_MANIFEST_FILE), "utf8")).toBe(beforeManifest);
  });

  it("refuses a true key collision with a different official domain", async () => {
    const root = await createFixture();
    await addFixtureManifest(root, createProviderManifest({
      key: "shopname",
      displayName: "Different Shopname",
      officialUrl: "https://shopname.io/",
    }));

    await expect(scaffoldProvider({ rootDir: root, url: "https://shopname.com/" })).rejects.toThrow(
      "provider key collision",
    );
  });

  it("refuses an overlapping domain registered under a different key", async () => {
    const root = await createFixture();
    await addFixtureManifest(root, createProviderManifest({
      key: "legacyname",
      displayName: "Legacy Name",
      officialUrl: "https://shopname.com/",
    }));
    await expect(scaffoldProvider({ rootDir: root, url: "https://portal.shopname.com/" })).rejects.toThrow(
      /domain .* already belongs/,
    );
  });

  it("refuses a symlinked provider-integrations tree", async () => {
    const root = await createFixture();
    const integrations = path.join(root, "provider-integrations");
    const target = path.join(root, "real-provider-integrations");
    await fs.rename(integrations, target);
    await fs.symlink(target, integrations, "dir");

    await expect(scaffoldProvider({ rootDir: root, url: "https://shopname.com/" })).rejects.toThrow(
      "must not be a symlink",
    );
  });
});
