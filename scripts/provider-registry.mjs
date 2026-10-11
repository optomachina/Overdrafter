import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

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

const KEY_PATTERN = /^[a-z][a-z0-9]{1,49}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,80}$/;
const MOUNT_PATH_PATTERN = /^\/var\/secrets\/[a-z0-9-]+\/storage-state\.json$/;
const EGRESS_VALUES = new Set(["stable_nat", "none"]);
const FORBIDDEN_FIELD_SET = new Set(FORBIDDEN_REGISTRY_FIELD_NAMES);
const AUTHORITY_LANGUAGE = /certified|admission|dispatchEnabled|productionAuthorized/i;
const SECRET_VALUE_LIKE = /xometry-storage-state|sk-|-----BEGIN|supabase-service-role/i;

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  collectForbiddenFields(value, label);
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
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
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

export function validateSessionSecret(secret, label) {
  const value = requireObject(secret, label);
  const keys = Object.keys(value);
  const allowed = new Set(["secretNameEnv", "mountEnv", "mountPath", "requiredWhenListed"]);
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
  requireString(value.secretNameEnv, `${label}.secretNameEnv`, ENV_NAME_PATTERN);
  requireBoolean(value.requiredWhenListed, `${label}.requiredWhenListed`);
  if (hasMountEnv) {
    requireString(value.mountEnv, `${label}.mountEnv`, ENV_NAME_PATTERN);
  }
  if (hasMountPath) {
    requireString(value.mountPath, `${label}.mountPath`, MOUNT_PATH_PATTERN);
  }
  return {
    secretNameEnv: value.secretNameEnv,
    ...(hasMountEnv ? { mountEnv: value.mountEnv } : {}),
    ...(hasMountPath ? { mountPath: value.mountPath } : {}),
    requiredWhenListed: value.requiredWhenListed,
  };
}

export function validateProviderRegistryEntry(entry, label = "providers[]") {
  const value = requireObject(entry, label);
  assertExactKeys(value, ["key", "liveAdapter", "sessionSecrets", "egress"], label);
  const key = requireString(value.key, `${label}.key`, KEY_PATTERN);
  const liveAdapter = requireBoolean(value.liveAdapter, `${label}.liveAdapter`);
  if (!Array.isArray(value.sessionSecrets)) {
    throw new Error(`${label}.sessionSecrets must be an array`);
  }
  const sessionSecrets = value.sessionSecrets.map((secret, index) => (
    validateSessionSecret(secret, `${label}.sessionSecrets[${index}]`)
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
  return {
    key,
    liveAdapter,
    sessionSecrets,
    egress: value.egress,
  };
}

export function validateProviderRegistry(document) {
  const value = requireObject(document, "registry");
  assertExactKeys(value, ["$schema", "schemaVersion", "stableEgressRequiredKey", "providers"], "registry");
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
  return {
    $schema: value.$schema,
    schemaVersion: 1,
    stableEgressRequiredKey,
    providers,
  };
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
  if (SECRET_VALUE_LIKE.test(contents)) {
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
    "};",
    "",
    "export type ProviderRegistryEntry = {",
    "  readonly key: string;",
    "  readonly liveAdapter: boolean;",
    "  readonly sessionSecrets: readonly ProviderRegistrySessionSecret[];",
    "  readonly egress: ProviderRegistryEgress;",
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

function bashQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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

function mountPathVarName(secret) {
  return secret.secretNameEnv.replace(/_SECRET_NAME$/, "_MOUNT_PATH");
}

function renderSecretApply(entry, secret) {
  const flag = `${entry.key}_live_enabled`;
  if (secret.mountEnv) {
    return [
      `  if [[ "$${flag}" == "true" ]]; then`,
      `    secret_vars+=("${secret.mountEnv}=\${${secret.secretNameEnv}}:latest")`,
      "  else",
      `    remove_secret_vars+=(${bashQuote(secret.mountEnv)})`,
      "  fi",
    ].join("\n");
  }
  const mountVar = mountPathVarName(secret);
  return [
    `  if [[ "$${flag}" == "true" ]]; then`,
    `    vendor_storage_state_paths+=("\\"${entry.key}\\":\\"\${${mountVar}}\\"")`,
    `    secret_vars+=("\${${mountVar}}=\${${secret.secretNameEnv}}:latest")`,
    "  else",
    `    remove_secret_vars+=("\${${mountVar}}")`,
    "  fi",
  ].join("\n");
}

function renderSecretsScript(registry) {
  const liveAdapters = deriveLiveAdapters(registry);
  const optionalEgress = deriveStableEgressOptionalAdapters(registry);
  const liveEntries = liveAdapters.map((key) => registry.providers.find((entry) => entry.key === key));
  const phrase = formatLiveAdapterPhrase(liveAdapters);
  const gatedSecrets = liveEntries.flatMap((entry) => (
    entry.sessionSecrets
      .filter((secret) => secret.requiredWhenListed)
      .map((secret) => ({ entry, secret }))
  ));
  const emptySecretInits = [...new Set(gatedSecrets.map(({ secret }) => secret.secretNameEnv))]
    .sort(compareStrings)
    .map((name) => `${name}="\${${name}:-}"`);
  const mountPathInits = gatedSecrets
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
    ...gatedSecrets.map(({ entry, secret }) => renderRequiredSecretCheck(entry, secret)),
    "}",
    "",
    "provider_registry_apply_session_secrets() {",
    "  vendor_storage_state_paths=()",
    ...gatedSecrets.map(({ entry, secret }) => renderSecretApply(entry, secret)),
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
      throw new Error("syncProviderRegistry requires assertSafeGeneratedOutput");
    }
    const outputPaths = [];
    for (const output of outputs) {
      outputPaths.push(await assertSafeGeneratedOutput(rootDir, output.relativePath));
    }
    for (let index = 0; index < outputs.length; index += 1) {
      const outputPath = outputPaths[index];
      await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
      await fsPromises.writeFile(outputPath, outputs[index].contents, "utf8");
    }
  }
  return {
    providerCount: resolved.providers.length,
    liveAdapters: deriveLiveAdapters(resolved),
    dryRun,
    outputs: outputs.map((output) => output.relativePath),
    rendered: outputs,
  };
}
