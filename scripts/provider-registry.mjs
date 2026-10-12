import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDER_REGISTRY_FILE = "provider-registry.v1.json";
export const PROVIDER_REGISTRY_SCHEMA_FILE = "provider-registry.v1.schema.json";
export const PROVIDER_REGISTRY_RELATIVE_PATH = `provider-integrations/${PROVIDER_REGISTRY_FILE}`;
export const PROVIDER_REGISTRY_SCHEMA_RELATIVE_PATH = `provider-integrations/${PROVIDER_REGISTRY_SCHEMA_FILE}`;
export const WORKER_REGISTRY_RELATIVE_PATH = "worker/src/generated/providerRegistry.ts";
export const WORKER_SECRETS_SCRIPT_RELATIVE_PATH = "worker/scripts/generated/provider-secrets.sh";

export const FORBIDDEN_REGISTRY_FIELD_NAMES = Object.freeze([
  "apiKey",
  "api_key",
  "credential",
  "default",
  "defaultSecretName",
  "password",
  "secret",
  "secretName",
  "secretValue",
  "token",
  "value",
]);

export const DEPLOY_CLOUD_RUN_RELATIVE_PATH = "worker/scripts/deploy-cloud-run.sh";
export const SECRET_NAME_ENV_PATTERN = /^[A-Z][A-Z0-9_]*_SECRET_NAME$/;
export const RESERVED_DEPLOY_ENV = Object.freeze([
  "HOME",
  "IFS",
  "PATH",
  "WORKER_LIVE_ADAPTERS",
  "WORKER_MODE",
]);
export const RESERVED_DEPLOY_ENV_PREFIXES = Object.freeze([
  "CLOUDSDK_",
  "GOOGLE_",
  "SUPABASE_",
]);
export const SECRET_VALUE_PATTERNS = Object.freeze([
  /xometry-storage-state/i,
  /-----BEGIN/,
  /supabase-service-role/i,
  /\beyJ[A-Za-z0-9_-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\b[0-9a-fA-F]{32}\b/,
]);
export const MANUAL_DEPLOY_ALLOWLIST = Object.freeze(["xometry"]);

const KEY_PATTERN = /^[a-z][a-z0-9]{1,49}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,80}$/;
const MOUNT_PATH_PATTERN = /^\/var\/secrets\/[a-z0-9-]+\/storage-state\.json$/;
const EGRESS_VALUES = new Set(["stable_nat", "none"]);
const FORBIDDEN_FIELD_SET = new Set(FORBIDDEN_REGISTRY_FIELD_NAMES);
const AUTHORITY_LANGUAGE = /certified|admission|dispatchEnabled|productionAuthorized/i;
const SESSIONLESS_JUSTIFICATION_MIN_LENGTH = 20;
const HIGH_ENTROPY_MIN_LENGTH = 32;
const HIGH_ENTROPY_THRESHOLD = 4.0;

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function scrapeAssignedDeployEnvNames(script) {
  const names = new Set();
  for (const match of String(script).matchAll(/^(?:export |local |readonly )?([A-Z][A-Z0-9_]*)=/gm)) {
    names.add(match[1]);
  }
  for (const match of String(script).matchAll(/"([A-Z][A-Z0-9_]*)=\$\{/g)) {
    names.add(match[1]);
  }
  for (const match of String(script).matchAll(/remove_secret_vars\+=\("([A-Z][A-Z0-9_]*)"\)/g)) {
    names.add(match[1]);
  }
  return names;
}

function reservedNamesFromDeployScript() {
  try {
    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      DEPLOY_CLOUD_RUN_RELATIVE_PATH,
    );
    return scrapeAssignedDeployEnvNames(fs.readFileSync(scriptPath, "utf8"));
  } catch {
    return new Set();
  }
}

const SCRAPED_RESERVED_DEPLOY_ENV = reservedNamesFromDeployScript();

export function isReservedDeployEnv(name) {
  if (RESERVED_DEPLOY_ENV.includes(name) || SCRAPED_RESERVED_DEPLOY_ENV.has(name)) {
    return true;
  }
  return RESERVED_DEPLOY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  const length = value.length;
  for (const count of counts.values()) {
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

const TOKEN_SPLIT_PATTERN = /[\s/:?#&=]+/;
const KEBAB_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

function isKnownSafeLiteral(value) {
  return MOUNT_PATH_PATTERN.test(value)
    || ENV_NAME_PATTERN.test(value)
    || KEY_PATTERN.test(value);
}

function tokenLooksLikeSecret(token) {
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(token))) {
    return true;
  }
  if (
    token.length < HIGH_ENTROPY_MIN_LENGTH
    || isKnownSafeLiteral(token)
    || token.includes(".")
    || KEBAB_SLUG_PATTERN.test(token)
  ) {
    return false;
  }
  return shannonEntropy(token) >= HIGH_ENTROPY_THRESHOLD;
}

export function looksLikeSecretValue(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }
  if (isKnownSafeLiteral(value)) {
    return false;
  }
  return value.split(TOKEN_SPLIT_PATTERN).some((token) => token.length > 0 && tokenLooksLikeSecret(token));
}

export function assertStringHasNoSecretValue(value, label) {
  if (looksLikeSecretValue(value)) {
    throw new Error(`${label} rejects a secret-value-like string`);
  }
  return value;
}

export function assertNoSecretValues(value, label) {
  if (typeof value === "string") {
    assertStringHasNoSecretValue(value, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretValues(item, `${label}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertNoSecretValues(child, `${label}.${key}`);
    }
  }
}

function titleCaseAdapter(key) {
  return `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

export function formatStableEgressRestrictionMessage(requiredKey, optionalKeys) {
  const required = titleCaseAdapter(requiredKey);
  if (optionalKeys.length === 0) {
    return `Stable egress deployment is restricted to the live ${required} worker.`;
  }
  return `Stable egress deployment is restricted to the live ${required} worker, optionally with ${formatLiveAdapterPhrase(optionalKeys.map(titleCaseAdapter))} in that order.`;
}

function mountPathVarName(secret) {
  return secret.secretNameEnv.replace(/_SECRET_NAME$/, "_MOUNT_PATH");
}

function sessionSecretVarNames(secret) {
  const names = [secret.secretNameEnv];
  if (secret.mountEnv) {
    names.push(secret.mountEnv);
  }
  if (secret.mountPath) {
    names.push(mountPathVarName(secret));
  }
  return names;
}

function isProviderOwnedEnv(providerKey, name) {
  return typeof providerKey === "string" && providerKey.length > 0
    && name.startsWith(`${providerKey.toUpperCase()}_`);
}

function assertEnvNameAvailable(name, label, providerKey) {
  if (isProviderOwnedEnv(providerKey, name)) {
    return;
  }
  if (isReservedDeployEnv(name)) {
    throw new Error(`${label} collides with a reserved deploy variable: ${name}`);
  }
}

function assertAllowedKeys(value, required, optional, label) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}`);
  }
  const missing = required.filter((key) => !keys.includes(key));
  if (missing.length > 0) {
    throw new Error(`${label} must contain exactly: ${[...required].sort(compareStrings).join(", ")}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  collectForbiddenFields(value, label);
  assertNoSecretValues(value, label);
  return value;
}

function collectForbiddenFields(value, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELD_SET.has(key)) {
      throw new Error(`${label} rejects secret-value-like field: ${key}`);
    }
  }
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is invalid`);
  }
  assertStringHasNoSecretValue(value, label);
  if (pattern && !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

export function defaultRegistryEntry(key) {
  return {
    key,
    liveAdapter: false,
    sessionSecrets: [],
    egress: "none",
  };
}

/**
 * Adds a default-off entry for a new provider key. An existing entry is returned
 * unchanged, so a generator can call this on every run without enabling anything.
 */
export function withDefaultRegistryEntry(registry, key) {
  const validated = validateProviderRegistry(registry);
  if (validated.providers.some((entry) => entry.key === key)) {
    return validated;
  }
  return validateProviderRegistry({
    ...validated,
    providers: [...validated.providers, defaultRegistryEntry(key)]
      .sort((left, right) => compareStrings(left.key, right.key)),
  });
}

export function renderProviderRegistryDocument(registry) {
  return `${JSON.stringify(validateProviderRegistry(registry), null, 2)}\n`;
}

/** Every checked-in manifest has exactly one registry entry, and every entry has a manifest. */
export function assertRegistryCoversManifests(registry, manifestKeys) {
  const registryKeys = new Set(registry.providers.map((entry) => entry.key));
  const manifestKeySet = new Set(manifestKeys);
  for (const key of registryKeys) {
    if (!manifestKeySet.has(key)) {
      throw new Error(`provider registry key is not a checked-in manifest: ${key}`);
    }
  }
  for (const key of manifestKeySet) {
    if (!registryKeys.has(key)) {
      throw new Error(`provider manifest has no registry entry: ${key}; add a default-off entry`);
    }
  }
}

export function formatLiveAdapterPhrase(keys) {
  if (keys.length === 0) {
    return "";
  }
  if (keys.length === 1) {
    return keys[0];
  }
  if (keys.length === 2) {
    return `${keys[0]} and/or ${keys[1]}`;
  }
  return `${keys.slice(0, -1).join(", ")}, and/or ${keys[keys.length - 1]}`;
}

export function deriveLiveAdapters(registry) {
  const required = registry.stableEgressRequiredKey;
  const others = registry.providers
    .filter((entry) => entry.liveAdapter && entry.key !== required)
    .map((entry) => entry.key)
    .sort(compareStrings);
  if (!registry.providers.some((entry) => entry.liveAdapter && entry.key === required)) {
    throw new Error(`stableEgressRequiredKey ${required} must have liveAdapter:true`);
  }
  return [required, ...others];
}

export function deriveStableEgressOptionalAdapters(registry) {
  return registry.providers
    .filter((entry) => (
      entry.liveAdapter
      && entry.egress === "stable_nat"
      && entry.key !== registry.stableEgressRequiredKey
    ))
    .map((entry) => entry.key)
    .sort(compareStrings);
}

export function validateSessionSecret(secret, label, { providerKey } = {}) {
  const value = requireObject(secret, label);
  const keys = Object.keys(value);
  const allowed = new Set(["secretNameEnv", "mountEnv", "mountPath", "requiredWhenListed", "manualDeploy"]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}`);
  }
  if (!keys.includes("secretNameEnv") || !keys.includes("requiredWhenListed")) {
    throw new Error(`${label} requires secretNameEnv and requiredWhenListed`);
  }
  const hasMountEnv = keys.includes("mountEnv");
  const hasMountPath = keys.includes("mountPath");
  if (hasMountEnv === hasMountPath) {
    throw new Error(`${label} must set exactly one of mountEnv or mountPath`);
  }
  requireString(value.secretNameEnv, `${label}.secretNameEnv`, SECRET_NAME_ENV_PATTERN);
  requireBoolean(value.requiredWhenListed, `${label}.requiredWhenListed`);
  if (hasMountEnv) {
    requireString(value.mountEnv, `${label}.mountEnv`, ENV_NAME_PATTERN);
  }
  if (hasMountPath) {
    requireString(value.mountPath, `${label}.mountPath`, MOUNT_PATH_PATTERN);
  }
  const validated = {
    secretNameEnv: value.secretNameEnv,
    ...(hasMountEnv ? { mountEnv: value.mountEnv } : {}),
    ...(hasMountPath ? { mountPath: value.mountPath } : {}),
    requiredWhenListed: value.requiredWhenListed,
  };
  if (keys.includes("manualDeploy")) {
    if (!MANUAL_DEPLOY_ALLOWLIST.includes(providerKey)) {
      throw new Error(
        `${label}.manualDeploy is restricted to: ${MANUAL_DEPLOY_ALLOWLIST.join(", ")}`,
      );
    }
    validated.manualDeploy = requireBoolean(value.manualDeploy, `${label}.manualDeploy`);
  }
  for (const name of sessionSecretVarNames(validated)) {
    assertEnvNameAvailable(name, `${label} ${name}`, providerKey);
  }
  return validated;
}

export function validateProviderRegistryEntry(entry, label = "providers[]") {
  const value = requireObject(entry, label);
  assertAllowedKeys(
    value,
    ["key", "liveAdapter", "sessionSecrets", "egress"],
    ["sessionlessJustification"],
    label,
  );
  const key = requireString(value.key, `${label}.key`, KEY_PATTERN);
  const liveAdapter = requireBoolean(value.liveAdapter, `${label}.liveAdapter`);
  if (!Array.isArray(value.sessionSecrets)) {
    throw new TypeError(`${label}.sessionSecrets must be an array`);
  }
  const sessionSecrets = value.sessionSecrets.map((secret, index) => (
    validateSessionSecret(secret, `${label}.sessionSecrets[${index}]`, { providerKey: key })
  ));
  if (!EGRESS_VALUES.has(value.egress)) {
    throw new Error(`${label}.egress is invalid`);
  }
  if (value.egress === "stable_nat" && !liveAdapter) {
    throw new Error(`${label} cannot require stable NAT while liveAdapter is false`);
  }
  if (!liveAdapter && sessionSecrets.length > 0) {
    throw new Error(`${label} must keep sessionSecrets empty while liveAdapter is false`);
  }
  const hasJustification = Object.hasOwn(value, "sessionlessJustification");
  let sessionlessJustification;
  if (hasJustification) {
    if (!liveAdapter) {
      throw new Error(`${label} sessionlessJustification is only valid when liveAdapter is true`);
    }
    sessionlessJustification = requireString(
      value.sessionlessJustification,
      `${label}.sessionlessJustification`,
    ).trim();
    if (sessionlessJustification.length < SESSIONLESS_JUSTIFICATION_MIN_LENGTH) {
      throw new Error(`${label}.sessionlessJustification must be at least ${SESSIONLESS_JUSTIFICATION_MIN_LENGTH} characters`);
    }
  }
  const hasRequiredSecret = sessionSecrets.some((secret) => secret.requiredWhenListed);
  if (liveAdapter && !hasRequiredSecret && !hasJustification) {
    throw new Error(
      `${label} liveAdapter:true requires a requiredWhenListed secret or sessionlessJustification`,
    );
  }
  return {
    key,
    liveAdapter,
    sessionSecrets,
    egress: value.egress,
    ...(hasJustification ? { sessionlessJustification } : {}),
  };
}

/** Reviewed 1.0 scope list. The permissions lint derives its required providers from this. */
function validateOneDotZero(list, providerKeys) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("registry.oneDotZero must be a non-empty array");
  }
  list.forEach((key, index) => requireString(key, `registry.oneDotZero[${index}]`, KEY_PATTERN));
  if (new Set(list).size !== list.length) {
    throw new Error("registry.oneDotZero contains duplicate keys");
  }
  if (JSON.stringify(list) !== JSON.stringify([...list].sort(compareStrings))) {
    throw new Error("registry.oneDotZero must be sorted");
  }
  const unknown = list.filter((key) => !providerKeys.includes(key));
  if (unknown.length > 0) {
    throw new Error(`registry.oneDotZero names keys missing from providers: ${unknown.join(", ")}`);
  }
  return [...list];
}

export function validateProviderRegistry(document) {
  const value = requireObject(document, "registry");
  assertExactKeys(
    value,
    ["$schema", "schemaVersion", "stableEgressRequiredKey", "providers", ...("oneDotZero" in value ? ["oneDotZero"] : [])],
    "registry",
  );
  if (value.$schema !== `./${PROVIDER_REGISTRY_SCHEMA_FILE}` || value.schemaVersion !== 1) {
    throw new Error("registry schema reference or version is invalid");
  }
  const stableEgressRequiredKey = requireString(
    value.stableEgressRequiredKey,
    "registry.stableEgressRequiredKey",
    KEY_PATTERN,
  );
  if (!Array.isArray(value.providers) || value.providers.length === 0) {
    throw new Error("registry.providers must be a non-empty array");
  }
  const providers = value.providers.map((entry, index) => (
    validateProviderRegistryEntry(entry, `registry.providers[${index}]`)
  ));
  const keys = providers.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length) {
    throw new Error("registry.providers contains duplicate keys");
  }
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort(compareStrings))) {
    throw new Error("registry.providers must be sorted by key");
  }
  const required = providers.find((entry) => entry.key === stableEgressRequiredKey);
  if (!required) {
    throw new Error(`stableEgressRequiredKey ${stableEgressRequiredKey} is missing from providers`);
  }
  if (!required.liveAdapter || required.egress !== "stable_nat") {
    throw new Error(`stableEgressRequiredKey ${stableEgressRequiredKey} must be a live stable-NAT adapter`);
  }
  assertNoCrossProviderEnvCollisions(providers);
  const oneDotZero = "oneDotZero" in value ? validateOneDotZero(value.oneDotZero, keys) : undefined;
  return {
    $schema: value.$schema,
    schemaVersion: 1,
    stableEgressRequiredKey,
    ...(oneDotZero ? { oneDotZero } : {}),
    providers,
  };
}

function assertNoCrossProviderEnvCollisions(providers) {
  const seenVars = new Map();
  const seenMountPaths = new Map();
  for (const entry of providers) {
    for (const [index, secret] of entry.sessionSecrets.entries()) {
      const owner = `${entry.key}.sessionSecrets[${index}]`;
      for (const name of sessionSecretVarNames(secret)) {
        const existing = seenVars.get(name);
        if (existing) {
          throw new Error(
            `registry.providers ${entry.key} collides with another provider variable: ${name} (${existing})`,
          );
        }
        seenVars.set(name, owner);
      }
      if (!secret.mountPath) {
        continue;
      }
      const existingPath = seenMountPaths.get(secret.mountPath);
      if (existingPath) {
        throw new Error(
          `registry.providers ${entry.key} collides with another provider mountPath: ${secret.mountPath} (${existingPath})`,
        );
      }
      seenMountPaths.set(secret.mountPath, owner);
    }
  }
}

export function assertProviderRegistrySchema(schema) {
  const value = requireObject(schema, "provider registry JSON schema");
  if (value.title !== "ProviderRegistryV1" || value.additionalProperties !== false) {
    throw new Error("provider registry JSON schema does not define the closed V1 contract");
  }
  collectForbiddenFields(value.properties ?? {}, "provider registry JSON schema.properties");
  const entryProperties = value.$defs?.providerEntry?.properties ?? {};
  const secretProperties = value.$defs?.sessionSecret?.properties ?? {};
  collectForbiddenFields(entryProperties, "provider registry JSON schema.providerEntry");
  collectForbiddenFields(secretProperties, "provider registry JSON schema.sessionSecret");
  if (value.$defs?.providerEntry?.additionalProperties !== false) {
    throw new Error("provider registry entry schema must reject additional properties");
  }
  if (value.$defs?.sessionSecret?.additionalProperties !== false) {
    throw new Error("provider registry session-secret schema must reject additional properties");
  }
}

export function assertGeneratedRegistryOutput(contents, relativePath) {
  if (AUTHORITY_LANGUAGE.test(contents)) {
    throw new Error(`generated provider registry contains production authority language: ${relativePath}`);
  }
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(contents))) {
    throw new Error(`generated provider registry contains a secret value: ${relativePath}`);
  }
}

function registryJsonPath(rootDir) {
  return path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH);
}

export function parseProviderRegistry(raw, sourceLabel = PROVIDER_REGISTRY_RELATIVE_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${sourceLabel} is missing or invalid`);
  }
  return validateProviderRegistry(parsed);
}

export function readProviderRegistrySync(rootDir) {
  let raw;
  try {
    raw = fs.readFileSync(registryJsonPath(rootDir), "utf8");
  } catch {
    throw new Error(`${PROVIDER_REGISTRY_RELATIVE_PATH} is missing or invalid`);
  }
  return parseProviderRegistry(raw);
}

export async function readProviderRegistry(rootDir) {
  let raw;
  try {
    raw = await fsPromises.readFile(registryJsonPath(rootDir), "utf8");
  } catch {
    throw new Error(`${PROVIDER_REGISTRY_RELATIVE_PATH} is missing or invalid`);
  }
  return parseProviderRegistry(raw);
}

export async function readProviderRegistrySchema(rootDir) {
  let schema;
  try {
    schema = JSON.parse(await fsPromises.readFile(
      path.join(rootDir, PROVIDER_REGISTRY_SCHEMA_RELATIVE_PATH),
      "utf8",
    ));
  } catch {
    throw new Error("provider registry JSON schema is missing or invalid");
  }
  assertProviderRegistrySchema(schema);
  return schema;
}

function renderTypeScript(registry) {
  const liveAdapters = deriveLiveAdapters(registry);
  const optionalEgress = deriveStableEgressOptionalAdapters(registry);
  const projected = Object.fromEntries(registry.providers.map((entry) => [entry.key, {
    key: entry.key,
    liveAdapter: entry.liveAdapter,
    sessionSecrets: entry.sessionSecrets,
    egress: entry.egress,
    ...(entry.sessionlessJustification ? { sessionlessJustification: entry.sessionlessJustification } : {}),
  }]));
  return [
    "// Generated by npm run provider:sync. Do not edit directly.",
    "// liveAdapter only allows a deploy to list the adapter. It does not grant production authority.",
    "",
    "export type ProviderRegistryEgress = \"stable_nat\" | \"none\";",
    "",
    "export type ProviderRegistrySessionSecret = {",
    "  readonly secretNameEnv: string;",
    "  readonly mountEnv?: string;",
    "  readonly mountPath?: string;",
    "  readonly requiredWhenListed: boolean;",
    "  readonly manualDeploy?: boolean;",
    "};",
    "",
    "export type ProviderRegistryEntry = {",
    "  readonly key: string;",
    "  readonly liveAdapter: boolean;",
    "  readonly sessionSecrets: readonly ProviderRegistrySessionSecret[];",
    "  readonly egress: ProviderRegistryEgress;",
    "  readonly sessionlessJustification?: string;",
    "};",
    "",
    `export const PROVIDER_REGISTRY = ${JSON.stringify(projected, null, 2)} as const;`,
    "",
    "/** Live-deploy allow-list. Presence here does not grant production authority. */",
    `export const PRODUCTION_LIVE_ADAPTERS = ${JSON.stringify(liveAdapters)} as const;`,
    "",
    `export const STABLE_EGRESS_REQUIRED_ADAPTER = ${JSON.stringify(registry.stableEgressRequiredKey)};`,
    "",
    `export const STABLE_EGRESS_OPTIONAL_ADAPTERS = ${JSON.stringify(optionalEgress)} as const;`,
    "",
  ].join("\n");
}

const BASH_SINGLE_QUOTE_ESCAPE = String.raw`'\''`;

function bashQuote(value) {
  return ["'", String(value).replaceAll("'", BASH_SINGLE_QUOTE_ESCAPE), "'"].join("");
}

function renderBashCase(entry) {
  const flag = `${entry.key}_live_enabled`;
  return [
    `      ${bashQuote(entry.key)})`,
    `        if [[ "$${flag}" == "true" ]]; then`,
    `          echo "WORKER_LIVE_ADAPTERS lists ${entry.key} more than once."`,
    "          exit 1",
    "        fi",
    `        ${flag}=true`,
    "        ;;",
  ].join("\n");
}

function renderRequiredSecretCheck(entry, secret) {
  return [
    `  if [[ "$${entry.key}_live_enabled" == "true" && -z "$${secret.secretNameEnv}" ]]; then`,
    `    echo "${secret.secretNameEnv} is required when WORKER_LIVE_ADAPTERS includes ${entry.key}."`,
    "    exit 1",
    "  fi",
  ].join("\n");
}

function renderSecretApplyBody(entry, secret) {
  if (secret.mountEnv) {
    return [
      `    secret_vars+=("${secret.mountEnv}=\${${secret.secretNameEnv}}:latest")`,
    ];
  }
  const mountVar = mountPathVarName(secret);
  return [
    `    vendor_storage_state_paths+=("\\"${entry.key}\\":\\"\${${mountVar}}\\"")`,
    `    secret_vars+=("\${${mountVar}}=\${${secret.secretNameEnv}}:latest")`,
  ];
}

function renderSecretRemove(secret) {
  if (secret.mountEnv) {
    return `    remove_secret_vars+=(${bashQuote(secret.mountEnv)})`;
  }
  return `    remove_secret_vars+=("\${${mountPathVarName(secret)}}")`;
}

function renderSecretApply(entry, secret) {
  const flag = `${entry.key}_live_enabled`;
  if (secret.requiredWhenListed) {
    return [
      `  if [[ "$${flag}" == "true" ]]; then`,
      ...renderSecretApplyBody(entry, secret),
      "  else",
      renderSecretRemove(secret),
      "  fi",
    ].join("\n");
  }
  return [
    `  if [[ "$${flag}" == "true" && -n "$${secret.secretNameEnv}" ]]; then`,
    ...renderSecretApplyBody(entry, secret),
    `  elif [[ "$${flag}" != "true" ]]; then`,
    renderSecretRemove(secret),
    "  fi",
  ].join("\n");
}

function renderStableEgressRestrictionMessageFn() {
  return [
    "provider_registry_stable_egress_restriction_message() {",
    "  local required=\"${PROVIDER_REGISTRY_STABLE_EGRESS_REQUIRED^}\"",
    "  local -a optional_names=()",
    "  local adapter",
    "  for adapter in \"${PROVIDER_REGISTRY_STABLE_EGRESS_OPTIONAL_ADAPTERS[@]}\"; do",
    "    optional_names+=(\"${adapter^}\")",
    "  done",
    "  local count=\"${#optional_names[@]}\"",
    "  if (( count == 0 )); then",
    "    printf '%s\\n' \"Stable egress deployment is restricted to the live ${required} worker.\"",
    "    return 0",
    "  fi",
    "  local phrase",
    "  if (( count == 1 )); then",
    "    phrase=\"${optional_names[0]}\"",
    "  elif (( count == 2 )); then",
    "    phrase=\"${optional_names[0]} and/or ${optional_names[1]}\"",
    "  else",
    "    local i",
    "    phrase=\"\"",
    "    for (( i=0; i<count-1; i++ )); do",
    "      phrase+=\"${optional_names[i]}, \"",
    "    done",
    "    phrase+=\"and/or ${optional_names[count-1]}\"",
    "  fi",
    "  printf '%s\\n' \"Stable egress deployment is restricted to the live ${required} worker, optionally with ${phrase} in that order.\"",
    "}",
  ].join("\n");
}

function skipsGeneratedSecretBinding(entry, secret) {
  return secret.manualDeploy === true && MANUAL_DEPLOY_ALLOWLIST.includes(entry.key);
}

function renderSecretsScript(registry) {
  const liveAdapters = deriveLiveAdapters(registry);
  const optionalEgress = deriveStableEgressOptionalAdapters(registry);
  const liveEntries = liveAdapters.map((key) => registry.providers.find((entry) => entry.key === key));
  const phrase = formatLiveAdapterPhrase(liveAdapters);
  const generatedSecrets = liveEntries.flatMap((entry) => (
    entry.sessionSecrets
      .filter((secret) => !skipsGeneratedSecretBinding(entry, secret))
      .map((secret) => ({ entry, secret }))
  ));
  const requiredSecrets = liveEntries.flatMap((entry) => (
    entry.sessionSecrets
      .filter((secret) => secret.requiredWhenListed)
      .map((secret) => ({ entry, secret }))
  ));
  const emptySecretInits = [...new Set(generatedSecrets.map(({ secret }) => secret.secretNameEnv))]
    .sort(compareStrings)
    .map((name) => `${name}="\${${name}:-}"`);
  const mountPathInits = generatedSecrets
    .filter(({ secret }) => secret.mountPath)
    .map(({ secret }) => `${mountPathVarName(secret)}="${secret.mountPath}"`);

  return [
    "#!/usr/bin/env bash",
    "# Generated by npm run provider:sync. Do not edit directly.",
    "# Names only. liveAdapter does not grant production authority.",
    "",
    `PROVIDER_REGISTRY_LIVE_ADAPTERS=(${liveAdapters.join(" ")})`,
    `PROVIDER_REGISTRY_LIVE_ADAPTERS_PHRASE=${bashQuote(phrase)}`,
    `PROVIDER_REGISTRY_STABLE_EGRESS_REQUIRED=${bashQuote(registry.stableEgressRequiredKey)}`,
    `PROVIDER_REGISTRY_STABLE_EGRESS_OPTIONAL_ADAPTERS=(${optionalEgress.join(" ")})`,
    ...emptySecretInits,
    ...mountPathInits,
    "",
    "provider_registry_parse_live_adapters() {",
    ...liveEntries.map((entry) => `  ${entry.key}_live_enabled=false`),
    "  if [[ \"$WORKER_MODE\" != \"live\" ]]; then",
    "    return 0",
    "  fi",
    "  if [[ -z \"$WORKER_LIVE_ADAPTERS\" || \"$WORKER_LIVE_ADAPTERS\" == ,* || \"$WORKER_LIVE_ADAPTERS\" == *, || \"$WORKER_LIVE_ADAPTERS\" == *,,* ]]; then",
    "    echo \"WORKER_LIVE_ADAPTERS must list $PROVIDER_REGISTRY_LIVE_ADAPTERS_PHRASE for a live deploy.\"",
    "    exit 1",
    "  fi",
    "  local adapter",
    "  IFS=',' read -r -a requested_live_adapters <<< \"$WORKER_LIVE_ADAPTERS\"",
    "  for adapter in \"${requested_live_adapters[@]}\"; do",
    "    case \"$adapter\" in",
    ...liveEntries.map((entry) => renderBashCase(entry)),
    "      *)",
    "        echo \"WORKER_LIVE_ADAPTERS may only list $PROVIDER_REGISTRY_LIVE_ADAPTERS_PHRASE for a live deploy.\"",
    "        exit 1",
    "        ;;",
    "    esac",
    "  done",
    "}",
    "",
    "provider_registry_require_session_secrets() {",
    ...requiredSecrets.map(({ entry, secret }) => renderRequiredSecretCheck(entry, secret)),
    "}",
    "",
    "provider_registry_apply_session_secrets() {",
    "  vendor_storage_state_paths=()",
    ...generatedSecrets.map(({ entry, secret }) => renderSecretApply(entry, secret)),
    "}",
    "",
    "provider_registry_stable_egress_canonical_adapters() {",
    "  local canonical=\"$PROVIDER_REGISTRY_STABLE_EGRESS_REQUIRED\"",
    "  local optional_adapter",
    "  for optional_adapter in \"${PROVIDER_REGISTRY_STABLE_EGRESS_OPTIONAL_ADAPTERS[@]}\"; do",
    "    local enabled_var=\"${optional_adapter}_live_enabled\"",
    "    if [[ \"${!enabled_var}\" == \"true\" ]]; then",
    "      canonical+=\",${optional_adapter}\"",
    "    fi",
    "  done",
    "  printf '%s' \"$canonical\"",
    "}",
    "",
    renderStableEgressRestrictionMessageFn(),
    "",
  ].join("\n");
}

export function renderProviderRegistryOutputs(registry) {
  const typescript = renderTypeScript(registry);
  const secretsScript = renderSecretsScript(registry);
  assertGeneratedRegistryOutput(typescript, WORKER_REGISTRY_RELATIVE_PATH);
  assertGeneratedRegistryOutput(secretsScript, WORKER_SECRETS_SCRIPT_RELATIVE_PATH);
  return [
    { relativePath: WORKER_REGISTRY_RELATIVE_PATH, contents: typescript },
    { relativePath: WORKER_SECRETS_SCRIPT_RELATIVE_PATH, contents: secretsScript },
  ];
}

export async function syncProviderRegistry({
  rootDir,
  dryRun = false,
  registry = null,
  assertSafeGeneratedOutput,
}) {
  const resolved = registry ?? await readProviderRegistry(rootDir);
  const outputs = renderProviderRegistryOutputs(resolved);
  if (!dryRun) {
    if (typeof assertSafeGeneratedOutput !== "function") {
      throw new TypeError("syncProviderRegistry requires assertSafeGeneratedOutput");
    }
    const outputPaths = await Promise.all(
      outputs.map((output) => assertSafeGeneratedOutput(rootDir, output.relativePath)),
    );
    await Promise.all(outputs.map(async (output, index) => {
      const outputPath = outputPaths[index];
      await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
      await fsPromises.writeFile(outputPath, output.contents, "utf8");
    }));
  }
  return {
    providerCount: resolved.providers.length,
    liveAdapters: deriveLiveAdapters(resolved),
    dryRun,
    outputs: outputs.map((output) => output.relativePath),
    rendered: outputs,
  };
}
