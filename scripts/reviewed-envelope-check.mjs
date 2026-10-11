import fs from "node:fs/promises";
import path from "node:path";

export const PROVIDER_DISPATCH_ENVELOPE_DIR = "provider-dispatch-envelope";
export const PROVIDER_REGISTRY_RELATIVE_PATH = "provider-integrations/provider-registry.v1.json";
export const GENERATED_PROVIDER_REGISTRY_TS = "worker/src/generated/providerRegistry.ts";
export const GENERATED_PROVIDER_SECRETS_SH = "worker/scripts/generated/provider-secrets.sh";
export const REVIEWED_ENVELOPE_SOURCE = "worker/src/providerDispatchEnvelope.ts";
export const EGRESS_CONTRACT_RELATIVE_PATH = "scripts/xometry-stable-egress-contract.mjs";
export const DEPLOY_SCRIPT_RELATIVE_PATH = "worker/scripts/deploy-cloud-run.sh";
export const RUNTIME_SECRETS_RELATIVE_PATH = "worker/src/runtimeSecrets.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_KEY = /^[a-z][a-z0-9_]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const EGRESS_VALUES = new Set(["stable_nat", "none"]);
const SECRET_LIKE_KEY = /^(value|token|cookie|password|secret|storagestate|storage_state)$/i;

export const REVIEWED_ENVELOPE_ARTIFACTS = Object.freeze({
  readinessDoc: {
    artifact: "readiness doc",
    expectedPath: (key) => `docs/workflows/${key}-live-readiness.md`,
  },
  dispatchFixture: {
    artifact: "dispatch fixture",
    expectedPath: (key) => `worker/test-support/${key}DispatchFixture.ts`,
  },
  defaultDenyTest: {
    artifact: "productionPortalDefaultDeny test",
    expectedPath: (key) => `worker/src/adapters/${key}ProductionPortal.test.ts`,
  },
  deployWiring: {
    artifact: "deploy wiring",
    expectedPath: () => PROVIDER_REGISTRY_RELATIVE_PATH,
  },
});

/**
 * Temporary dated exceptions for hand-built providers that are already
 * reviewed on main but are not yet on the kit-shaped default-deny harness.
 * After expiresOn the gap fails. Do not extend without a tracking issue.
 */
export const REVIEWED_ENVELOPE_EXCEPTIONS = Object.freeze([
  {
    key: "fictiv",
    artifact: REVIEWED_ENVELOPE_ARTIFACTS.defaultDenyTest.artifact,
    issue: "OVD-673",
    expiresOn: "2026-12-31",
  },
]);

export function formatReviewedEnvelopeGap(key, artifact, expectedPath) {
  return `provider:check: ${key} reviewed envelope missing ${artifact} (expected ${expectedPath}); run npm run provider:onboard -- ${key} --stage=live`;
}

export function isReviewedEnvelopeDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return false;
  }
  const review = document.review && typeof document.review === "object" ? document.review : document;
  const reviewer = firstNonEmptyString(review.reviewer, review.reviewedBy, document.reviewer, document.reviewedBy);
  const reviewedAt = firstNonEmptyString(review.reviewedAt, review.date, document.reviewedAt);
  return Boolean(reviewer && ISO_DATE.test(reviewedAt));
}

export function providerKeyFromEnvelopeDocument(document, fallbackName = "") {
  if (document && typeof document === "object" && !Array.isArray(document)) {
    const nested = document.envelope && typeof document.envelope === "object" ? document.envelope : null;
    const key = firstNonEmptyString(document.provider, document.key, nested?.provider);
    if (key && PROVIDER_KEY.test(key)) {
      return key;
    }
  }
  const fromName = fallbackName.replace(/\.json$/i, "").replace(/-v\d+$/i, "");
  return PROVIDER_KEY.test(fromName) ? fromName : null;
}

export function isActiveReviewedEnvelopeException(exception, today) {
  return Boolean(
    exception
    && ISO_DATE.test(today)
    && ISO_DATE.test(exception.expiresOn)
    && today <= exception.expiresOn,
  );
}

export function parseCodeReviewedGenericProviders(source) {
  if (typeof source !== "string" || !source.includes("REVIEWED_PROVIDER_DISPATCH_ENVELOPES")) {
    return [];
  }
  const marker = "export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES";
  const start = source.indexOf(marker);
  const arrayStart = source.indexOf("[", start);
  const arrayEnd = source.indexOf("\n];", arrayStart);
  if (start < 0 || arrayStart < 0 || arrayEnd < 0) {
    throw new Error("unable to parse REVIEWED_PROVIDER_DISPATCH_ENVELOPES");
  }
  const keys = [];
  for (const objectText of source.slice(arrayStart, arrayEnd).split("{").slice(1)) {
    const provider = /provider:\s*"([a-z][a-z0-9_]*)"/.exec(objectText);
    const admission = /requiredAdmission:\s*"([^"]+)"/.exec(objectText);
    if (provider && admission?.[1] === "generic_dispatch" && !keys.includes(provider[1])) {
      keys.push(provider[1]);
    }
  }
  return keys;
}

export async function collectReviewedEnvelopeGaps({
  rootDir,
  today = new Date().toISOString().slice(0, 10),
  exceptions = REVIEWED_ENVELOPE_EXCEPTIONS,
}) {
  const reviewedKeys = await readReviewedProviderKeys(rootDir);
  const missingByProvider = await Promise.all(
    reviewedKeys.map((key) => missingArtifactsForProvider(rootDir, key)),
  );
  return missingByProvider.flat().filter((item) => !isExcepted(exceptions, item.key, item.artifact, today));
}

export async function assertReviewedEnvelopeCompleteness(options) {
  const gaps = await collectReviewedEnvelopeGaps(options);
  if (gaps.length > 0) {
    throw new Error(gaps.map((gap) => formatReviewedEnvelopeGap(gap.key, gap.artifact, gap.expectedPath)).join("\n"));
  }
  const reviewedKeys = await readReviewedProviderKeys(options.rootDir);
  return { reviewedProviders: reviewedKeys };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function mentionsProviderKey(source, key) {
  return source.includes(`"${key}"`) || source.includes(`'${key}'`);
}

function sortProviderKeys(keys) {
  return [...keys].sort((left, right) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function isExcepted(exceptions, key, artifact, today) {
  return exceptions.some((exception) => (
    exception.key === key
    && exception.artifact === artifact
    && isActiveReviewedEnvelopeException(exception, today)
  ));
}

async function lstatIfPresent(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readTextIfPresent(targetPath) {
  const stat = await lstatIfPresent(targetPath);
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`reviewed-envelope input must be a regular file: ${targetPath}`);
  }
  return fs.readFile(targetPath, "utf8");
}

async function readJsonIfPresent(targetPath) {
  const text = await readTextIfPresent(targetPath);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`reviewed-envelope JSON is invalid: ${targetPath}`);
  }
}

async function readReviewedProviderKeys(rootDir) {
  const keys = new Set();
  const envelopeSource = await readTextIfPresent(path.join(rootDir, REVIEWED_ENVELOPE_SOURCE));
  if (envelopeSource !== null) {
    for (const key of parseCodeReviewedGenericProviders(envelopeSource)) {
      keys.add(key);
    }
  }

  const envelopeDir = path.join(rootDir, PROVIDER_DISPATCH_ENVELOPE_DIR);
  const dirStat = await lstatIfPresent(envelopeDir);
  if (!dirStat) {
    return sortProviderKeys(keys);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`${PROVIDER_DISPATCH_ENVELOPE_DIR} must be a real directory`);
  }
  const entries = await fs.readdir(envelopeDir, { withFileTypes: true });
  const documents = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => ({
      name: entry.name,
      document: await readJsonIfPresent(path.join(envelopeDir, entry.name)),
    })));
  for (const { name, document } of documents) {
    if (!isReviewedEnvelopeDocument(document)) {
      continue;
    }
    const key = providerKeyFromEnvelopeDocument(document, name);
    if (!key) {
      throw new Error(`reviewed envelope ${name} does not name a provider key`);
    }
    keys.add(key);
  }
  return sortProviderKeys(keys);
}

async function missingArtifactsForProvider(rootDir, key) {
  const missing = [];
  if (!await hasReadinessDoc(rootDir, key)) {
    missing.push(gap(key, "readinessDoc"));
  }
  if (!await hasDispatchFixture(rootDir, key)) {
    missing.push(gap(key, "dispatchFixture"));
  }
  if (!await hasDefaultDenyTest(rootDir, key)) {
    missing.push(gap(key, "defaultDenyTest"));
  }
  if (!await hasDeployWiring(rootDir, key)) {
    missing.push(gap(key, "deployWiring"));
  }
  return missing;
}

function gap(key, artifactId) {
  const spec = REVIEWED_ENVELOPE_ARTIFACTS[artifactId];
  return {
    key,
    artifact: spec.artifact,
    expectedPath: spec.expectedPath(key),
  };
}

async function hasReadinessDoc(rootDir, key) {
  const entries = await listFiles(path.join(rootDir, "docs/workflows"), (name) => name.endsWith("-live-readiness.md"));
  if (entries.some((filePath) => {
    const base = path.basename(filePath, ".md");
    return base === `${key}-live-readiness` || base.endsWith(`-${key}-live-readiness`);
  })) {
    return true;
  }
  const contents = await Promise.all(entries.map((filePath) => fs.readFile(filePath, "utf8")));
  return contents.some((content) => mentionsProviderKey(content, key));
}

async function hasDispatchFixture(rootDir, key) {
  const conventional = path.join(rootDir, REVIEWED_ENVELOPE_ARTIFACTS.dispatchFixture.expectedPath(key));
  const conventionalText = await readTextIfPresent(conventional);
  if (conventionalText !== null && conventionalText.includes("providerDispatchFixture")) {
    return true;
  }
  const files = await listFiles(
    path.join(rootDir, "worker/test-support"),
    (name) => name.endsWith(".ts") || name.endsWith(".js"),
  );
  const contents = await Promise.all(files.map((filePath) => fs.readFile(filePath, "utf8")));
  return contents.some((text) => text.includes("providerDispatchFixture") && mentionsProviderKey(text, key));
}

async function hasDefaultDenyTest(rootDir, key) {
  const searchRoots = [
    path.join(rootDir, "worker/src"),
    path.join(rootDir, "worker/test-support"),
  ];
  const fileGroups = await Promise.all(searchRoots.map((searchRoot) => (
    listFiles(searchRoot, (name) => name.endsWith(".test.ts") || name.endsWith(".test.mjs"))
  )));
  const contents = await Promise.all(fileGroups.flat().map((filePath) => fs.readFile(filePath, "utf8")));
  return contents.some((text) => text.includes("productionPortalDefaultDeny") && mentionsProviderKey(text, key));
}

async function hasDeployWiring(rootDir, key) {
  const registry = await readJsonIfPresent(path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH));
  if (registry !== null) {
    return registryDeclaresProvider(registry, key, rootDir);
  }
  return fallbackDeployWiringDeclaresProvider(rootDir, key);
}

async function registryDeclaresProvider(registry, key, rootDir) {
  const entries = Array.isArray(registry) ? registry : registry.providers;
  if (!Array.isArray(entries)) {
    return false;
  }
  const entry = entries.find((candidate) => candidate && candidate.key === key);
  if (!entry || typeof entry !== "object") {
    return false;
  }
  assertRegistryNamesOnly(entry, key);
  if (!Array.isArray(entry.sessionSecrets) || !EGRESS_VALUES.has(entry.egress)) {
    return false;
  }
  const secretNames = [];
  for (const secret of entry.sessionSecrets) {
    if (!secret || typeof secret !== "object" || Array.isArray(secret)) {
      return false;
    }
    assertRegistryNamesOnly(secret, key);
    if (!ENV_NAME.test(secret.secretNameEnv ?? "")) {
      return false;
    }
    secretNames.push(secret.secretNameEnv);
    if (secret.mountEnv !== undefined && !ENV_NAME.test(secret.mountEnv)) {
      return false;
    }
    if (typeof secret.mountEnv === "string") {
      secretNames.push(secret.mountEnv);
    }
  }
  return generatedMappingsContainNames(rootDir, secretNames);
}

async function generatedMappingsContainNames(rootDir, secretNames) {
  if (secretNames.length === 0) {
    return true;
  }
  const generated = [
    await readTextIfPresent(path.join(rootDir, GENERATED_PROVIDER_REGISTRY_TS)),
    await readTextIfPresent(path.join(rootDir, GENERATED_PROVIDER_SECRETS_SH)),
  ];
  const present = generated.filter((text) => text !== null);
  if (present.length === 0) {
    return true;
  }
  return present.every((text) => secretNames.every((name) => text.includes(name)));
}

async function fallbackDeployWiringDeclaresProvider(rootDir, key) {
  const envPrefix = key.toUpperCase();
  const secretName = `${envPrefix}_STORAGE_STATE_SECRET_NAME`;
  const mountNames = [
    `${envPrefix}_STORAGE_STATE_JSON`,
    `${envPrefix}_STORAGE_STATE_MOUNT_PATH`,
  ];
  const deploy = await readTextIfPresent(path.join(rootDir, DEPLOY_SCRIPT_RELATIVE_PATH));
  const runtime = await readTextIfPresent(path.join(rootDir, RUNTIME_SECRETS_RELATIVE_PATH));
  const egress = await readTextIfPresent(path.join(rootDir, EGRESS_CONTRACT_RELATIVE_PATH));
  const sources = [deploy, runtime].filter((text) => text !== null);
  if (sources.length === 0 || !egress) {
    return false;
  }
  const secretDeclared = sources.some((text) => text.includes(secretName));
  const mountDeclared = sources.some((text) => mountNames.some((name) => text.includes(name)));
  const egressDeclared = mentionsProviderKey(egress, key);
  return secretDeclared && mountDeclared && egressDeclared;
}

function assertRegistryNamesOnly(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (SECRET_LIKE_KEY.test(field) || (typeof fieldValue === "string" && looksLikeSecretValue(fieldValue))) {
      throw new Error(`provider:check: ${key} registry entry must declare secret names only`);
    }
    if (fieldValue && typeof fieldValue === "object") {
      assertRegistryNamesOnly(fieldValue, key);
    }
  }
}

function looksLikeSecretValue(value) {
  if (ENV_NAME.test(value) || EGRESS_VALUES.has(value) || PROVIDER_KEY.test(value)) {
    return false;
  }
  return value.length >= 40;
}

async function listFiles(root, predicate) {
  const stat = await lstatIfPresent(root);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
      return [];
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listFiles(fullPath, predicate);
    }
    return entry.isFile() && predicate(entry.name) ? [fullPath] : [];
  }));
  return nested.flat();
}
