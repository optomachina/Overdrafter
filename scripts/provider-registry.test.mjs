// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { STABLE_EGRESS_OPTIONAL_ADAPTERS } from "./xometry-stable-egress-contract.mjs";
import {
  FORBIDDEN_REGISTRY_FIELD_NAMES,
  WORKER_REGISTRY_RELATIVE_PATH,
  WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
  defaultRegistryEntry,
  deriveLiveAdapters,
  deriveStableEgressOptionalAdapters,
  formatLiveAdapterPhrase,
  parseProviderRegistry,
  readProviderRegistry,
  readProviderRegistrySchema,
  renderProviderRegistryOutputs,
  validateProviderRegistry,
  validateProviderRegistryEntry,
} from "./provider-registry.mjs";
import { assertSafeGeneratedOutput, syncProviderIntegrations } from "./provider-sync.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function liveRegistry(overrides = {}) {
  return {
    key: "fictiv",
    liveAdapter: true,
    sessionSecrets: [{
      secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
      mountEnv: "FICTIV_STORAGE_STATE_JSON",
      requiredWhenListed: true,
    }],
    egress: "stable_nat",
    ...overrides,
  };
}

describe("provider registry contract", () => {
  it("keeps new entries disabled with no secrets and no egress", () => {
    expect(defaultRegistryEntry("sendcutsend")).toEqual({
      key: "sendcutsend",
      liveAdapter: false,
      sessionSecrets: [],
      egress: "none",
    });
  });

  it("rejects secret-value-like fields on the schema and on entries", async () => {
    const schema = await readProviderRegistrySchema(repoRoot);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.providerEntry.additionalProperties).toBe(false);
    expect(schema.$defs.sessionSecret.additionalProperties).toBe(false);
    for (const field of FORBIDDEN_REGISTRY_FIELD_NAMES) {
      expect(schema.properties).not.toHaveProperty(field);
      expect(schema.$defs.providerEntry.properties).not.toHaveProperty(field);
      expect(schema.$defs.sessionSecret.properties).not.toHaveProperty(field);
      expect(() => validateProviderRegistryEntry({
        ...liveRegistry(),
        [field]: "super-secret-value",
      })).toThrow(`rejects secret-value-like field: ${field}`);
    }
  });

  it("rejects a session secret that carries a value-shaped field", () => {
    expect(() => validateProviderRegistryEntry(liveRegistry({
      sessionSecrets: [{
        secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
        mountEnv: "FICTIV_STORAGE_STATE_JSON",
        requiredWhenListed: true,
        secretValue: "c2VjcmV0",
      }],
    }))).toThrow("rejects secret-value-like field: secretValue");
  });

  it("migrates existing providers without changing live, secret, or egress behavior", async () => {
    const registry = await readProviderRegistry(repoRoot);
    expect(deriveLiveAdapters(registry)).toEqual(["xometry", "fictiv", "quickparts", "weerg"]);
    expect(deriveStableEgressOptionalAdapters(registry)).toEqual(["fictiv", "quickparts", "weerg"]);
    expect([...STABLE_EGRESS_OPTIONAL_ADAPTERS]).toEqual(["fictiv", "quickparts", "weerg"]);
    expect(formatLiveAdapterPhrase(deriveLiveAdapters(registry))).toBe(
      "xometry, fictiv, quickparts, and/or weerg",
    );

    const byKey = Object.fromEntries(registry.providers.map((entry) => [entry.key, entry]));
    expect(byKey.sendcutsend).toEqual(defaultRegistryEntry("sendcutsend"));
    expect(byKey.fabworks.liveAdapter).toBe(false);
    expect(byKey.geomiq.liveAdapter).toBe(false);
    expect(byKey.xometry.sessionSecrets).toEqual([{
      secretNameEnv: "XOMETRY_STORAGE_STATE_SECRET_NAME",
      mountEnv: "XOMETRY_STORAGE_STATE_JSON",
      requiredWhenListed: false,
    }]);
    expect(byKey.fictiv.sessionSecrets[0].secretNameEnv).toBe("FICTIV_STORAGE_STATE_SECRET_NAME");
    expect(byKey.quickparts.sessionSecrets[0].mountPath).toBe(
      "/var/secrets/quickparts-storage-state/storage-state.json",
    );
    expect(byKey.weerg.sessionSecrets[0].mountPath).toBe(
      "/var/secrets/weerg-storage-state/storage-state.json",
    );
  });

  it("renders generated outputs without secret values or production authority", async () => {
    const first = renderProviderRegistryOutputs(await readProviderRegistry(repoRoot));
    const second = renderProviderRegistryOutputs(await readProviderRegistry(repoRoot));
    expect(second).toEqual(first);
    for (const output of first) {
      expect(output.contents).not.toMatch(/certified|admission|dispatchEnabled|productionAuthorized/i);
      expect(output.contents).not.toMatch(/xometry-storage-state|sk-|-----BEGIN/);
      expect(output.contents).not.toContain("super-secret");
    }
    const secrets = first.find((output) => output.relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH);
    expect(secrets.contents).toContain("FICTIV_STORAGE_STATE_SECRET_NAME");
    expect(secrets.contents).toContain("FICTIV_STORAGE_STATE_JSON");
    expect(secrets.contents).not.toContain("synthetic-fictiv");
    expect(secrets.contents).not.toMatch(/sendcutsend_live_enabled=true/);
  });

  it("does not enable a default-off entry in generated allow-lists", () => {
    const registry = validateProviderRegistry({
      $schema: "./provider-registry.v1.schema.json",
      schemaVersion: 1,
      stableEgressRequiredKey: "xometry",
      providers: [
        defaultRegistryEntry("sendcutsend"),
        {
          key: "xometry",
          liveAdapter: true,
          sessionSecrets: [{
            secretNameEnv: "XOMETRY_STORAGE_STATE_SECRET_NAME",
            mountEnv: "XOMETRY_STORAGE_STATE_JSON",
            requiredWhenListed: false,
          }],
          egress: "stable_nat",
        },
      ],
    });
    expect(deriveLiveAdapters(registry)).toEqual(["xometry"]);
    const secrets = renderProviderRegistryOutputs(registry)
      .find((output) => output.relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH);
    expect(secrets.contents).not.toContain("sendcutsend_live_enabled=true");
    expect(secrets.contents).not.toContain("SENDCUTSEND_");
  });

  it("refuses to parse a registry document with a secret-value field", () => {
    expect(() => parseProviderRegistry(JSON.stringify({
      $schema: "./provider-registry.v1.schema.json",
      schemaVersion: 1,
      stableEgressRequiredKey: "xometry",
      providers: [liveRegistry()],
      secret: "do-not-store-me",
    }))).toThrow("rejects secret-value-like field: secret");
  });
});

describe("provider registry generation safety", () => {
  it("refuses a generated registry symlink without changing its external target", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-provider-registry-"));
    temporaryRoots.push(temporaryRoot);
    const rootDir = path.join(temporaryRoot, "repo");
    await fs.cp(
      path.join(repoRoot, "provider-integrations"),
      path.join(rootDir, "provider-integrations"),
      { recursive: true },
    );
    const externalTarget = path.join(temporaryRoot, "external-provider-registry.ts");
    const outputPath = path.join(rootDir, WORKER_REGISTRY_RELATIVE_PATH);
    await fs.writeFile(externalTarget, "external sentinel\n");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.symlink(externalTarget, outputPath);

    await expect(syncProviderIntegrations({ rootDir, dryRun: false })).rejects.toThrow(
      "output must be a regular file",
    );
    expect(await fs.readFile(externalTarget, "utf8")).toBe("external sentinel\n");
    expect((await fs.lstat(outputPath)).isSymbolicLink()).toBe(true);
  });

  it("writes generated registry files as regular files", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-provider-registry-"));
    temporaryRoots.push(temporaryRoot);
    const rootDir = path.join(temporaryRoot, "repo");
    await fs.cp(
      path.join(repoRoot, "provider-integrations"),
      path.join(rootDir, "provider-integrations"),
      { recursive: true },
    );
    await syncProviderIntegrations({ rootDir });
    const generated = path.join(rootDir, WORKER_REGISTRY_RELATIVE_PATH);
    expect((await fs.lstat(generated)).isFile()).toBe(true);
    expect(await assertSafeGeneratedOutput(rootDir, WORKER_REGISTRY_RELATIVE_PATH)).toBe(generated);
  });
});
