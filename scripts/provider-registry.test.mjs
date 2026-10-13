// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { STABLE_EGRESS_OPTIONAL_ADAPTERS } from "./xometry-stable-egress-contract.mjs";
import {
  DEPLOY_CLOUD_RUN_RELATIVE_PATH,
  FORBIDDEN_REGISTRY_FIELD_NAMES,
  WORKER_REGISTRY_RELATIVE_PATH,
  WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
  assertRegistryCoversManifests,
  defaultRegistryEntry,
  deriveLiveAdapters,
  deriveStableEgressOptionalAdapters,
  formatLiveAdapterPhrase,
  formatStableEgressRestrictionMessage,
  isReservedDeployEnv,
  looksLikeSecretValue,
  parseProviderRegistry,
  readProviderRegistry,
  readProviderRegistrySchema,
  renderProviderRegistryDocument,
  renderProviderRegistryOutputs,
  scrapeAssignedDeployEnvNames,
  validateProviderRegistry,
  validateProviderRegistryEntry,
  validateSessionSecret,
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
    expect(byKey.xometry.sessionlessJustification).toMatch(/.{20,}/);
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
          sessionlessJustification: "Xometry session binding is applied by the deploy script snapshot-or-secret path, not the generated helper.",
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
    // RMFG declares its API key secret by name only; the adapter stays off until a reviewed edit.
    expect(byKey.rmfg).toEqual({
      ...defaultRegistryEntry("rmfg"),
      adapterKind: "api",
      sessionSecrets: [{
        secretNameEnv: "RMFG_API_KEY_SECRET_NAME",
        mountEnv: "RMFG_API_KEY",
        requiredWhenListed: true,
      }],
    });
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

const SECRET_VALUE_SHAPES = Object.freeze({
  jwt: "eyJhbGciOiJIUzI1NiJ9xx",
  akia: "AKIAIOSFODNN7EXAMPLE",
  ghp: "ghp_01234567890123456789",
  gho: "gho_01234567890123456789",
  openai: "sk-abcdefghijklmnopqrstuv",
  entropy: "n7Q2vL9xR4mP8wK3tY6bC1hF5jD0sA2u",
  hex32: "0123456789abcdef0123456789abcdef",
  hex40: "0123456789abcdef0123456789abcdef01234567",
  hex64: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  base32: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  lowerAlnum32: "abcd1234efgh5678ijkl9012mnop3456",
  lowerAlnum50: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5",
  awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  dotted: "Zm9vYmFyQmF6UXV4.Q29ycmVjdEhvcnNl.U3RhcGxlQmF0dGVyeQ",
  slackBot: "xoxb-123456789012-abcdefghijkl",
  slackUser: "xoxp-123456789012-abcdefghijkl",
});

function xometryManualEntry(overrides = {}) {
  return {
    key: "xometry",
    liveAdapter: true,
    sessionSecrets: [{
      secretNameEnv: "XOMETRY_STORAGE_STATE_SECRET_NAME",
      mountEnv: "XOMETRY_STORAGE_STATE_JSON",
      requiredWhenListed: false,
      manualDeploy: true,
    }],
    egress: "stable_nat",
    sessionlessJustification: "Xometry session binding is applied by the deploy script snapshot-or-secret path, not the generated helper.",
    ...overrides,
  };
}

function twoProviderRegistry(second) {
  return validateProviderRegistry({
    $schema: "./provider-registry.v1.schema.json",
    schemaVersion: 1,
    stableEgressRequiredKey: "xometry",
    providers: [second, xometryManualEntry()].sort((left, right) => (
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    )),
  });
}

describe("provider registry hardening (OVD-727)", () => {
  it("rejects secretNameEnv values that do not end in _SECRET_NAME", () => {
    expect(() => validateSessionSecret({
      secretNameEnv: "GEOMIQ_STATE",
      mountPath: "/var/secrets/geomiq-storage-state/storage-state.json",
      requiredWhenListed: true,
    }, "secret")).toThrow("secret.secretNameEnv is invalid");
    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [{
        secretNameEnv: "GEOMIQ_STATE",
        mountPath: "/var/secrets/geomiq-storage-state/storage-state.json",
        requiredWhenListed: true,
      }],
      egress: "none",
    })).toThrow("secretNameEnv is invalid");
  });

  it("rejects reserved deploy variables and cross-provider collisions", () => {
    expect(() => validateSessionSecret({
      secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
      mountEnv: "WORKER_MODE",
      requiredWhenListed: true,
    }, "secret")).toThrow("reserved deploy variable: WORKER_MODE");
    expect(() => validateSessionSecret({
      secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
      mountEnv: "PATH",
      requiredWhenListed: true,
    }, "secret")).toThrow("reserved deploy variable: PATH");
    expect(() => validateSessionSecret({
      secretNameEnv: "SUPABASE_URL_SECRET_NAME",
      mountEnv: "FICTIV_STORAGE_STATE_JSON",
      requiredWhenListed: true,
    }, "secret")).toThrow("reserved deploy variable: SUPABASE_URL_SECRET_NAME");
    expect(() => validateSessionSecret({
      secretNameEnv: "SERVICE_NAME_SECRET_NAME",
      mountEnv: "SERVICE_NAME",
      requiredWhenListed: true,
    }, "secret")).toThrow("reserved deploy variable: SERVICE_NAME");

    expect(() => validateProviderRegistry({
      $schema: "./provider-registry.v1.schema.json",
      schemaVersion: 1,
      stableEgressRequiredKey: "xometry",
      providers: [
        {
          key: "fictiv",
          liveAdapter: true,
          sessionSecrets: [{
            secretNameEnv: "SHARED_STORAGE_STATE_SECRET_NAME",
            mountEnv: "FICTIV_STORAGE_STATE_JSON",
            requiredWhenListed: true,
          }],
          egress: "stable_nat",
        },
        {
          key: "geomiq",
          liveAdapter: true,
          sessionSecrets: [{
            secretNameEnv: "SHARED_STORAGE_STATE_SECRET_NAME",
            mountEnv: "GEOMIQ_STORAGE_STATE_JSON",
            requiredWhenListed: true,
          }],
          egress: "none",
        },
        xometryManualEntry(),
      ],
    })).toThrow("collides with another provider variable: SHARED_STORAGE_STATE_SECRET_NAME");

    expect(() => validateProviderRegistryEntry(liveRegistry())).not.toThrow();
  });

  it("treats every variable assigned by deploy-cloud-run.sh as reserved", async () => {
    const script = await fs.readFile(path.join(repoRoot, DEPLOY_CLOUD_RUN_RELATIVE_PATH), "utf8");
    const assigned = scrapeAssignedDeployEnvNames(script);
    expect(assigned.has("WORKER_MODE")).toBe(true);
    expect(assigned.has("SERVICE_NAME")).toBe(true);
    expect(assigned.has("SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    for (const name of assigned) {
      expect({ name, reserved: isReservedDeployEnv(name) }).toEqual({ name, reserved: true });
    }
    expect(isReservedDeployEnv("HOME")).toBe(true);
    expect(isReservedDeployEnv("IFS")).toBe(true);
    expect(isReservedDeployEnv("GOOGLE_CLOUD_PROJECT")).toBe(true);
    expect(isReservedDeployEnv("CLOUDSDK_CORE_PROJECT")).toBe(true);
  });

  it("rejects flipping geomiq live without a required secret or justification", () => {
    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [],
      egress: "none",
    })).toThrow("liveAdapter:true requires a requiredWhenListed secret or sessionlessJustification");
    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [{
        secretNameEnv: "GEOMIQ_STORAGE_STATE_SECRET_NAME",
        mountEnv: "GEOMIQ_STORAGE_STATE_JSON",
        requiredWhenListed: false,
      }],
      egress: "none",
    })).toThrow("liveAdapter:true requires a requiredWhenListed secret or sessionlessJustification");
    expect(validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [],
      egress: "none",
      sessionlessJustification: "Sessionless live listing is reserved for adapters with manual deploy handling.",
    })).toMatchObject({
      key: "geomiq",
      liveAdapter: true,
      egress: "none",
    });
  });

  it("generates apply and stale-remove steps for optional secrets and leaves Xometry manual", () => {
    const registry = twoProviderRegistry({
      key: "fictiv",
      liveAdapter: true,
      sessionSecrets: [
        {
          secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
          mountEnv: "FICTIV_STORAGE_STATE_JSON",
          requiredWhenListed: true,
        },
        {
          secretNameEnv: "FICTIV_OPTIONAL_STATE_SECRET_NAME",
          mountEnv: "FICTIV_OPTIONAL_STATE_JSON",
          requiredWhenListed: false,
        },
      ],
      egress: "stable_nat",
    });
    const secrets = renderProviderRegistryOutputs(registry)
      .find((output) => output.relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH);
    expect(secrets.contents).toContain(
      'if [[ "$fictiv_live_enabled" == "true" && -n "$FICTIV_OPTIONAL_STATE_SECRET_NAME" ]]; then',
    );
    expect(secrets.contents).toContain('secret_vars+=("FICTIV_OPTIONAL_STATE_JSON=${FICTIV_OPTIONAL_STATE_SECRET_NAME}:latest")');
    expect(secrets.contents).toContain("remove_secret_vars+=('FICTIV_OPTIONAL_STATE_JSON')");
    expect(secrets.contents).toContain(
      'if [[ "$fictiv_live_enabled" == "true" && -z "$FICTIV_STORAGE_STATE_SECRET_NAME" ]]; then',
    );
    expect(secrets.contents).not.toContain("XOMETRY_STORAGE_STATE_JSON=${XOMETRY_STORAGE_STATE_SECRET_NAME}");
    expect(secrets.contents).not.toMatch(/xometry_live_enabled.*XOMETRY_STORAGE_STATE/);
  });

  it("rejects each secret-value shape in every string field and accepts the desk mount path", () => {
    const stringFields = [
      (token) => ({ ...liveRegistry(), key: token }),
      (token) => liveRegistry({
        sessionSecrets: [{
          secretNameEnv: token,
          mountEnv: "FICTIV_STORAGE_STATE_JSON",
          requiredWhenListed: true,
        }],
      }),
      (token) => liveRegistry({
        sessionSecrets: [{
          secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
          mountEnv: token,
          requiredWhenListed: true,
        }],
      }),
      (token) => liveRegistry({
        sessionSecrets: [{
          secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
          mountPath: token,
          requiredWhenListed: true,
        }],
      }),
      (token) => ({
        ...liveRegistry(),
        sessionSecrets: [],
        sessionlessJustification: token,
      }),
      (token) => ({
        $schema: token,
        schemaVersion: 1,
        stableEgressRequiredKey: "xometry",
        providers: [liveRegistry(), xometryManualEntry()],
      }),
    ];

    for (const [shape, token] of Object.entries(SECRET_VALUE_SHAPES)) {
      for (const apply of stringFields) {
        expect(() => {
          const candidate = apply(token);
          if (candidate.schemaVersion) {
            validateProviderRegistry(candidate);
          } else {
            validateProviderRegistryEntry(candidate);
          }
        }, shape).toThrow("secret-value-like string");
      }
    }

    expect(validateSessionSecret({
      secretNameEnv: "DESK_STORAGE_STATE_SECRET_NAME",
      mountPath: "/var/secrets/desk-x/storage-state.json",
      requiredWhenListed: true,
    }, "secret")).toEqual({
      secretNameEnv: "DESK_STORAGE_STATE_SECRET_NAME",
      mountPath: "/var/secrets/desk-x/storage-state.json",
      requiredWhenListed: true,
    });
  });

  it("keeps current checked-in providers valid after the stricter rules", async () => {
    const registry = await readProviderRegistry(repoRoot);
    expect(deriveLiveAdapters(registry)).toEqual(["xometry", "fictiv", "quickparts", "weerg"]);
    expect(() => validateProviderRegistry(registry)).not.toThrow();
    expect(formatStableEgressRestrictionMessage(
      registry.stableEgressRequiredKey,
      deriveStableEgressOptionalAdapters(registry),
    )).toBe(
      "Stable egress deployment is restricted to the live Xometry worker, optionally with Fictiv, Quickparts, and/or Weerg in that order.",
    );
  });

  it("rejects fictiv manualDeploy:true and still emits fictiv remove plus required checks", () => {
    expect(() => validateProviderRegistryEntry(liveRegistry({
      sessionSecrets: [{
        secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
        mountEnv: "FICTIV_STORAGE_STATE_JSON",
        requiredWhenListed: true,
        manualDeploy: true,
      }],
    }))).toThrow("manualDeploy is restricted to: xometry");
    expect(() => validateSessionSecret({
      secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
      mountEnv: "FICTIV_STORAGE_STATE_JSON",
      requiredWhenListed: true,
      manualDeploy: true,
    }, "secret", { providerKey: "fictiv" })).toThrow("manualDeploy is restricted to: xometry");
    expect(() => validateSessionSecret({
      secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
      mountEnv: "FICTIV_STORAGE_STATE_JSON",
      requiredWhenListed: true,
      manualDeploy: false,
    }, "secret", { providerKey: "fictiv" })).toThrow("manualDeploy is restricted to: xometry");

    const registry = twoProviderRegistry(liveRegistry());
    const secrets = renderProviderRegistryOutputs(registry)
      .find((output) => output.relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH);
    expect(secrets.contents).toContain(
      'if [[ "$fictiv_live_enabled" == "true" && -z "$FICTIV_STORAGE_STATE_SECRET_NAME" ]]; then',
    );
    expect(secrets.contents).toContain("remove_secret_vars+=('FICTIV_STORAGE_STATE_JSON')");
    expect(secrets.contents).not.toContain("XOMETRY_STORAGE_STATE_JSON=${XOMETRY_STORAGE_STATE_SECRET_NAME}");
  });

  it("trims sessionlessJustification before the length check", () => {
    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [],
      egress: "none",
      sessionlessJustification: " ".repeat(30),
    })).toThrow("sessionlessJustification must be at least 20 characters");
    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [],
      egress: "none",
      sessionlessJustification: `ok${" ".repeat(20)}`,
    })).toThrow("sessionlessJustification must be at least 20 characters");
  });

  it("detects high-entropy tokens inside whitespace, slashes, and 32-character hex", () => {
    const entropy = SECRET_VALUE_SHAPES.entropy;
    const hex32 = SECRET_VALUE_SHAPES.hex32;
    expect(looksLikeSecretValue(`justify ${entropy} here`)).toBe(true);
    expect(looksLikeSecretValue(`https://example.com/${entropy}`)).toBe(true);
    expect(looksLikeSecretValue(hex32)).toBe(true);
    expect(looksLikeSecretValue(`prefix ${hex32} suffix`)).toBe(true);
    expect(looksLikeSecretValue(`https://example.com/${hex32}`)).toBe(true);
    expect(looksLikeSecretValue("./provider-registry.v1.schema.json")).toBe(false);
    expect(looksLikeSecretValue("/var/secrets/desk-x/storage-state.json")).toBe(false);
    expect(looksLikeSecretValue("https://www.rmfg.com/")).toBe(false);
    expect(looksLikeSecretValue("https://www.fictiv.com/help/getting-a-quote/how-do-i-add-finishing-to-my-parts")).toBe(false);
    expect(looksLikeSecretValue("https://help.ponoko.com/en/articles/2688477-what-design-software-file-type-should-i-use")).toBe(false);
    expect(looksLikeSecretValue("FICTIV_STORAGE_STATE_SECRET_NAME")).toBe(false);
    expect(looksLikeSecretValue("support.quote-portal.example.co.uk")).toBe(false);
    expect(looksLikeSecretValue("storage-state.json")).toBe(false);
    expect(looksLikeSecretValue("https://www.xometry.com/capabilities/3d-printing-service/")).toBe(false);
    expect(looksLikeSecretValue("fictivstoragestatesecretname")).toBe(false);
    expect(looksLikeSecretValue("aluminum_6061_cnc_milling_maximum_559x356x95.3_mm")).toBe(false);
    expect(looksLikeSecretValue("a8f3k2_m9x7q1_z4c6v8_b2n5w0_p1o3i7")).toBe(true);

    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [],
      egress: "none",
      sessionlessJustification: `Sessionless adapter notes ${entropy} stay out of registry files.`,
    })).toThrow("secret-value-like string");
    expect(() => validateProviderRegistryEntry({
      key: "geomiq",
      liveAdapter: true,
      sessionSecrets: [],
      egress: "none",
      sessionlessJustification: `https://docs.example.com/${hex32}`,
    })).toThrow("secret-value-like string");
  });

  it("rejects two providers that share a mountPath under different variable names", () => {
    const sharedPath = "/var/secrets/shared-storage-state/storage-state.json";
    expect(() => validateProviderRegistry({
      $schema: "./provider-registry.v1.schema.json",
      schemaVersion: 1,
      stableEgressRequiredKey: "xometry",
      providers: [
        {
          key: "fictiv",
          liveAdapter: true,
          sessionSecrets: [{
            secretNameEnv: "FICTIV_STORAGE_STATE_SECRET_NAME",
            mountPath: sharedPath,
            requiredWhenListed: true,
          }],
          egress: "stable_nat",
        },
        {
          key: "geomiq",
          liveAdapter: true,
          sessionSecrets: [{
            secretNameEnv: "GEOMIQ_STORAGE_STATE_SECRET_NAME",
            mountPath: sharedPath,
            requiredWhenListed: true,
          }],
          egress: "none",
        },
        xometryManualEntry(),
      ],
    })).toThrow(`collides with another provider mountPath: ${sharedPath}`);
  });
});

describe("API providers and adopted adapters", () => {
  const apiEntry = (overrides = {}) => ({
    key: "apishop",
    liveAdapter: false,
    adapterKind: "api",
    sessionSecrets: [{
      secretNameEnv: "APISHOP_API_KEY_SECRET_NAME",
      mountEnv: "APISHOP_API_KEY",
      requiredWhenListed: true,
    }],
    egress: "none",
    ...overrides,
  });

  it("lets an api provider declare its key secret by name before the adapter is live", () => {
    expect(validateProviderRegistryEntry(apiEntry())).toMatchObject({
      adapterKind: "api",
      sessionSecrets: [{ mountEnv: "APISHOP_API_KEY" }],
    });
    expect(() => validateProviderRegistryEntry(apiEntry({ adapterKind: undefined }))).toThrow(
      "must keep sessionSecrets empty while liveAdapter is false",
    );
    expect(() => validateProviderRegistryEntry(apiEntry({ adapterKind: "browser" }))).toThrow(
      "adapterKind is invalid",
    );
  });

  it("accepts an adopted adapter only for a live adapter and only under worker/src/adapters", () => {
    const adopted = { module: "worker/src/adapters/fictiv.ts", defaultDenyTest: "worker/src/adapters/fictiv.test.ts" };
    expect(validateProviderRegistryEntry(liveRegistry({ adoptedAdapter: adopted })).adoptedAdapter).toEqual(adopted);
    expect(() => validateProviderRegistryEntry(liveRegistry({
      liveAdapter: false,
      sessionSecrets: [],
      egress: "none",
      adoptedAdapter: adopted,
    }))).toThrow("only valid when liveAdapter is true");
    for (const module of ["scripts/evil.ts", "worker/src/adapters/../x.ts", "worker/src/adapters/fictiv.test.ts"]) {
      expect(() => validateProviderRegistryEntry(liveRegistry({ adoptedAdapter: { module } }))).toThrow();
    }
    expect(() => validateProviderRegistryEntry(liveRegistry({
      adoptedAdapter: { module: adopted.module, defaultDenyTest: "worker/src/adapters/fictiv.ts" },
    }))).toThrow("defaultDenyTest is invalid");
  });
});
