// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { STABLE_EGRESS_OPTIONAL_ADAPTERS } from "./xometry-stable-egress-contract.mjs";
import {
  FORBIDDEN_REGISTRY_FIELD_NAMES,
  RESERVED_DEPLOY_ENV,
  isReservedDeployEnv,
  looksLikeSecretValue,
  WORKER_REGISTRY_RELATIVE_PATH,
  WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
  assertRegistryCoversManifests,
  defaultRegistryEntry,
  deriveLiveAdapters,
  deriveStableEgressOptionalAdapters,
  formatLiveAdapterPhrase,
  parseProviderRegistry,
  readProviderRegistry,
  readProviderRegistrySchema,
  renderProviderRegistryDocument,
  renderProviderRegistryOutputs,
  validateProviderRegistry,
  validateProviderRegistryEntry,
  withDefaultRegistryEntry,
} from "./provider-registry.mjs";
import { readProviderManifests } from "./provider-manifest.mjs";
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
      manualDeploy: true,
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
            manualDeploy: true,
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

  it("covers every checked-in manifest, including Fictiv, Quickparts and Weerg secret names", async () => {
    const registry = await readProviderRegistry(repoRoot);
    const manifests = await readProviderManifests(repoRoot, { today: "2026-09-28" });
    expect(() => assertRegistryCoversManifests(
      registry,
      manifests.map(({ manifest }) => manifest.key),
    )).not.toThrow();
    const byKey = Object.fromEntries(registry.providers.map((entry) => [entry.key, entry]));
    for (const key of ["fictiv", "quickparts", "weerg"]) {
      expect(byKey[key]).toMatchObject({ liveAdapter: true, egress: "stable_nat" });
      expect(byKey[key].sessionSecrets.map((secret) => secret.secretNameEnv)).toEqual([
        `${key.toUpperCase()}_STORAGE_STATE_SECRET_NAME`,
      ]);
    }
    expect(byKey.rmfg).toEqual(defaultRegistryEntry("rmfg"));
  });

  it("rejects a manifest without a registry entry and a registry entry without a manifest", async () => {
    const registry = await readProviderRegistry(repoRoot);
    const keys = registry.providers.map((entry) => entry.key);
    expect(() => assertRegistryCoversManifests(registry, [...keys, "newshop"])).toThrow(
      "provider manifest has no registry entry: newshop; add a default-off entry",
    );
    expect(() => assertRegistryCoversManifests(registry, keys.filter((key) => key !== "rmfg"))).toThrow(
      "provider registry key is not a checked-in manifest: rmfg",
    );
  });

  it("adds a new provider default-off and never changes an existing entry", async () => {
    const registry = await readProviderRegistry(repoRoot);
    const added = withDefaultRegistryEntry(registry, "newshop");
    expect(added.providers.find((entry) => entry.key === "newshop")).toEqual(defaultRegistryEntry("newshop"));
    expect(added.providers.map((entry) => entry.key)).toEqual(
      [...registry.providers.map((entry) => entry.key), "newshop"].sort(),
    );
    expect(deriveLiveAdapters(added)).toEqual(deriveLiveAdapters(registry));
    expect(withDefaultRegistryEntry(added, "newshop")).toEqual(added);
    expect(withDefaultRegistryEntry(registry, "weerg")).toEqual(registry);
    expect(renderProviderRegistryDocument(registry)).toBe(
      await fs.readFile(path.join(repoRoot, "provider-integrations/provider-registry.v1.json"), "utf8"),
    );
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

function registryWith(...providers) {
  return {
    $schema: "./provider-registry.v1.schema.json",
    schemaVersion: 1,
    stableEgressRequiredKey: "xometry",
    providers: [
      {
        key: "xometry",
        liveAdapter: true,
        sessionSecrets: [{
          secretNameEnv: "XOMETRY_STORAGE_STATE_SECRET_NAME",
          mountEnv: "XOMETRY_STORAGE_STATE_JSON",
          requiredWhenListed: false,
          manualDeploy: true,
        }],
        egress: "stable_nat",
      },
      ...providers,
    ].sort((left, right) => (left.key < right.key ? -1 : 1)),
  };
}

function secretEntry(key, secret, extra = {}) {
  return liveRegistry({ key, sessionSecrets: [secret], ...extra });
}

describe("provider registry hardening (OVD-727)", () => {
  const mountEnvSecret = {
    secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
    mountEnv: "FICTIV_STORAGE_STATE_JSON",
    requiredWhenListed: true,
  };

  it("validates the current providers", async () => {
    await expect(readProviderRegistry(repoRoot)).resolves.toBeTruthy();
  });

  it("requires secretNameEnv to end in _SECRET_NAME", () => {
    expect(() => validateProviderRegistryEntry(liveRegistry({
      key: "geomiq",
      sessionSecrets: [{
        secretNameEnv: "GEOMIQ_STATE",
        mountPath: "/var/secrets/geomiq-storage-state/storage-state.json",
        requiredWhenListed: true,
      }],
    }))).toThrow("secretNameEnv is invalid");
    expect(() => validateProviderRegistryEntry(liveRegistry({
      sessionSecrets: [{ ...mountEnvSecret, secretNameEnv: "FICTIV_STATE" }],
    }))).toThrow("secretNameEnv is invalid");
  });

  it("rejects reserved deploy variables as secret, mount, or derived mount variables", () => {
    for (const name of ["WORKER_MODE", "WORKER_LIVE_ADAPTERS", "PATH", "HOME", "IFS", "SUPABASE_URL", "GOOGLE_CLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT"]) {
      expect(isReservedDeployEnv(name)).toBe(true);
      expect(() => validateProviderRegistryEntry(liveRegistry({
        sessionSecrets: [{ ...mountEnvSecret, mountEnv: name }],
      }))).toThrow(`reserved deploy variable: ${name}`);
    }
    expect(() => validateProviderRegistryEntry(liveRegistry({
      sessionSecrets: [{ ...mountEnvSecret, secretNameEnv: "SUPABASE_SERVICE_ROLE_SECRET_NAME" }],
    }))).toThrow("reserved deploy variable: SUPABASE_SERVICE_ROLE_SECRET_NAME");
    expect(() => validateProviderRegistryEntry(liveRegistry({
      sessionSecrets: [{ ...mountEnvSecret, secretNameEnv: "OPENAI_API_KEY_SECRET_NAME" }],
    }))).toThrow("reserved deploy variable: OPENAI_API_KEY_SECRET_NAME");
    expect(() => validateProviderRegistryEntry(liveRegistry({
      key: "gcloud",
      sessionSecrets: [{
        secretNameEnv: "GOOGLE_MOUNT_SECRET_NAME",
        mountPath: "/var/secrets/gcloud-storage-state/storage-state.json",
        requiredWhenListed: true,
      }],
    }))).toThrow("reserved deploy variable: GOOGLE_MOUNT_SECRET_NAME");
    expect(RESERVED_DEPLOY_ENV).toContain("WORKER_MODE");
  });

  it("rejects variable collisions within and across providers", () => {
    const other = secretEntry("quickparts", {
      secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
      mountEnv: "QUICKPARTS_STORAGE_STATE_JSON",
      requiredWhenListed: true,
    });
    expect(() => validateProviderRegistry(registryWith(liveRegistry(), other))).toThrow(
      "FICTIV_STORAGE_STATE_SECRET_NAME collides between fictiv and quickparts",
    );
    const sameMount = secretEntry("quickparts", {
      secretNameEnv: "QUICKPARTS_STORAGE_STATE_SECRET_NAME",
      mountEnv: "FICTIV_STORAGE_STATE_JSON",
      requiredWhenListed: true,
    });
    expect(() => validateProviderRegistry(registryWith(liveRegistry(), sameMount))).toThrow("collides");
    const derived = secretEntry("quickparts", {
      secretNameEnv: "QUICKPARTS_STORAGE_STATE_SECRET_NAME",
      mountPath: "/var/secrets/quickparts-storage-state/storage-state.json",
      requiredWhenListed: true,
    });
    const clash = secretEntry("weerg", {
      secretNameEnv: "WEERG_STORAGE_STATE_SECRET_NAME",
      mountEnv: "QUICKPARTS_STORAGE_STATE_MOUNT_PATH",
      requiredWhenListed: true,
    });
    expect(() => validateProviderRegistry(registryWith(derived, clash))).toThrow(
      "QUICKPARTS_STORAGE_STATE_MOUNT_PATH collides between quickparts and weerg",
    );
    expect(() => validateProviderRegistry(registryWith(secretEntry("quickparts", {
      secretNameEnv: "QUICKPARTS_STORAGE_STATE_SECRET_NAME",
      mountEnv: "QUICKPARTS_STORAGE_STATE_SECRET_NAME",
      requiredWhenListed: true,
    })))).toThrow("declared twice for quickparts");
  });

  it("requires a live adapter to have a required secret or a sessionless justification", () => {
    const geomiq = { key: "geomiq", liveAdapter: true, sessionSecrets: [], egress: "none" };
    expect(() => validateProviderRegistryEntry(geomiq)).toThrow("needs a requiredWhenListed session secret");
    expect(() => validateProviderRegistryEntry({
      ...geomiq,
      sessionSecrets: [{ ...mountEnvSecret, secretNameEnv: "GEOMIQ_STORAGE_STATE_SECRET_NAME", mountEnv: "GEOMIQ_STORAGE_STATE_JSON", requiredWhenListed: false }],
    })).toThrow("needs a requiredWhenListed session secret");
    expect(() => validateProviderRegistryEntry({ ...geomiq, sessionlessJustification: "too short" })).toThrow(
      "at least 20 characters",
    );
    expect(validateProviderRegistryEntry({
      ...geomiq,
      sessionlessJustification: "Public instant-quote API; no portal session exists.",
    }).sessionlessJustification).toContain("Public instant-quote");
    const { egress: _egress, ...withoutEgress } = geomiq;
    expect(() => validateProviderRegistryEntry({
      ...withoutEgress,
      sessionlessJustification: "Public instant-quote API; no portal session exists.",
    })).toThrow("must contain exactly");
    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: false,
      sessionSecrets: [],
      egress: "none",
      sessionlessJustification: "Public instant-quote API; no portal session exists.",
    })).toThrow("liveAdapter is false");
  });

  it("keeps manualDeploy secrets optional-only", () => {
    expect(() => validateProviderRegistryEntry(liveRegistry({
      sessionSecrets: [{ ...mountEnvSecret, manualDeploy: true }],
    }))).toThrow("manualDeploy secrets must set requiredWhenListed to false");
  });

  it("generates apply and remove steps for an optional secret and nothing for manualDeploy", () => {
    const optional = secretEntry("fictiv", { ...mountEnvSecret, requiredWhenListed: false }, {
      sessionlessJustification: "Optional session reuse only; adapter also runs sessionless.",
    });
    const registry = validateProviderRegistry(registryWith(optional));
    const script = renderProviderRegistryOutputs(registry)
      .find((output) => output.relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH).contents;
    expect(script).toContain('FICTIV_STORAGE_STATE_SECRET_NAME="${FICTIV_STORAGE_STATE_SECRET_NAME:-}"');
    expect(script).not.toContain("is required when WORKER_LIVE_ADAPTERS includes fictiv");
    expect(script).toContain([
      '  if [[ "$fictiv_live_enabled" == "true" && -n "$FICTIV_STORAGE_STATE_SECRET_NAME" ]]; then',
      '    secret_vars+=("FICTIV_STORAGE_STATE_JSON=${FICTIV_STORAGE_STATE_SECRET_NAME}:latest")',
      "  else",
      "    remove_secret_vars+=('FICTIV_STORAGE_STATE_JSON')",
      "  fi",
    ].join("\n"));
    expect(script).not.toContain("XOMETRY_STORAGE_STATE");
    expect(script).not.toContain("xometry_live_enabled\" == \"true\" &&");
  });

  it("rejects every credential token shape in every string field", () => {
    const tokens = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "gho_abcdefghijklmnopqrstuvwxyz0123",
      "sk-abcdefghijklmnopqrstuvwxyz0123",
      "qZ8vK3mP9xT2rL7wB5nH1cD6fG4jS0aE9uYtRiOp",
    ];
    const fields = [
      (token) => liveRegistry({ key: token }),
      (token) => liveRegistry({ egress: token }),
      (token) => liveRegistry({ sessionlessJustification: `Public API ${token} no session` }),
      (token) => liveRegistry({ sessionSecrets: [{ ...mountEnvSecret, secretNameEnv: token }] }),
      (token) => liveRegistry({ sessionSecrets: [{ ...mountEnvSecret, mountEnv: token }] }),
      (token) => liveRegistry({
        sessionSecrets: [{ secretNameEnv: mountEnvSecret.secretNameEnv, mountPath: token, requiredWhenListed: true }],
      }),
    ];
    for (const token of tokens) {
      expect(looksLikeSecretValue(token)).toBe(true);
      for (const build of fields) {
        expect(() => validateProviderRegistryEntry(build(token))).toThrow();
      }
      expect(() => validateProviderRegistry({
        ...registryWith(),
        stableEgressRequiredKey: token,
      })).toThrow("looks like a secret value");
    }
    expect(() => validateProviderRegistryEntry(liveRegistry({ key: "AKIAIOSFODNN7EXAMPLE" }))).toThrow(
      "looks like a secret value",
    );
  });

  it("accepts allowed mount-path shapes, including ones that contain sk-", () => {
    expect(looksLikeSecretValue("/var/secrets/desk-x/storage-state.json")).toBe(false);
    expect(looksLikeSecretValue("/var/secrets/quickparts-storage-state/storage-state.json")).toBe(false);
    expect(validateProviderRegistryEntry(liveRegistry({
      key: "deskx",
      sessionSecrets: [{
        secretNameEnv: "DESKX_STORAGE_STATE_SECRET_NAME",
        mountPath: "/var/secrets/desk-x/storage-state.json",
        requiredWhenListed: true,
      }],
    })).sessionSecrets[0].mountPath).toBe("/var/secrets/desk-x/storage-state.json");
    const rendered = renderProviderRegistryOutputs(validateProviderRegistry(registryWith(liveRegistry({
      key: "deskx",
      sessionSecrets: [{
        secretNameEnv: "DESKX_STORAGE_STATE_SECRET_NAME",
        mountPath: "/var/secrets/desk-x/storage-state.json",
        requiredWhenListed: true,
      }],
    }))));
    expect(rendered.length).toBe(2);
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
