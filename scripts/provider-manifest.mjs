import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const PROVIDER_MANIFEST_VERSION = 1;
export const PROVIDER_MANIFEST_FILE = "manifest.v1.json";
export const PROVIDER_SCHEMA_FILE = "provider-manifest.v1.schema.json";
export const WEB_CATALOG_RELATIVE_PATH = "src/features/quotes/generated/provider-catalog.ts";
export const WORKER_CATALOG_RELATIVE_PATH = "worker/src/generated/provider-catalog.ts";
export const MAX_EVIDENCE_AGE_DAYS = 366;

const ADAPTER_KINDS = new Set([
  "api",
  "declarative_portal",
  "custom_portal",
  "guidance_only",
]);
const KNOWLEDGE_STATUSES = new Set(["unknown", "supported", "unsupported"]);
const LOCAL_USE_SUFFIXES = new Set([
  "example",
  "home",
  "internal",
  "invalid",
  "lan",
  "local",
  "localdomain",
  "localhost",
  "onion",
  "test",
]);
const COMMON_MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "ac.uk",
  "co.in",
  "co.jp",
  "co.nz",
  "co.uk",
  "co.za",
  "com.ar",
  "com.au",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tr",
  "com.tw",
  "gov.uk",
  "net.au",
  "org.au",
  "org.uk",
]);
const POSSIBLE_COUNTRY_SECOND_LEVEL_SUFFIXES = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "net",
  "org",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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

function requireNullableString(value, label) {
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must be null or a non-empty string`);
  }
}

function requireUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} contains duplicates`);
  }
  if (JSON.stringify(value) !== JSON.stringify([...value].sort(compareStrings))) {
    throw new Error(`${label} must be sorted`);
  }
  return value;
}

export function normalizeOfficialDomain(value) {
  if (typeof value !== "string") {
    throw new TypeError("provider domain must be a string");
  }
  const domain = value.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    !domain.includes(".") ||
    net.isIP(domain) !== 0 ||
    LOCAL_USE_SUFFIXES.has(labels.at(-1)) ||
    domain.endsWith(".home.arpa") ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`unsafe provider domain: ${value}`);
  }
  return domain;
}

/** Resolve a provider hostname to a conservative registrable domain. */
export function deriveRegistrableDomain(value) {
  const hostname = normalizeOfficialDomain(value);
  const labels = hostname.split(".");
  const lastTwo = labels.slice(-2).join(".");
  if (COMMON_MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo)) {
    if (labels.length < 3) {
      throw new Error(`provider hostname has no registrable label: ${value}`);
    }
    return labels.slice(-3).join(".");
  }
  const topLevel = labels.at(-1);
  const secondLevel = labels.at(-2);
  if (
    labels.length >= 3 &&
    topLevel.length === 2 &&
    POSSIBLE_COUNTRY_SECOND_LEVEL_SUFFIXES.has(secondLevel)
  ) {
    throw new Error(`ambiguous multi-label public suffix in provider hostname: ${value}`);
  }
  return lastTwo;
}

function isDomainOrSubdomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function parseSafeHttpsUrl(value, label = "provider URL") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hostname.endsWith(".")
  ) {
    throw new Error(`${label} must be credential-free HTTPS on the default port`);
  }
  normalizeOfficialDomain(parsed.hostname);
  return parsed;
}

export function normalizeProviderUrl(value) {
  const parsed = parseSafeHttpsUrl(value);
  const domain = deriveRegistrableDomain(parsed.hostname);
  return `https://${domain}/`;
}

export function deriveProviderKey(value) {
  const domain = deriveRegistrableDomain(parseSafeHttpsUrl(value).hostname);
  const key = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (!/^[a-z][a-z0-9]{1,49}$/.test(key)) {
    throw new Error(`cannot derive a safe provider key from ${domain}`);
  }
  return key;
}

export function deriveDisplayName(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function createUnknownCapabilityEnvelope() {
  return {
    version: 1,
    processes: { status: "unknown", values: [] },
    materials: { status: "unknown", values: [] },
    files: { status: "unknown", values: [] },
    quantity: { status: "unknown", minimum: null, maximum: null },
    tolerance: { status: "unknown", minimumMm: null, maximumMm: null },
    geometry: { status: "unknown", constraints: [] },
    drawings: { status: "unknown", values: [] },
    accountModes: { status: "unknown", values: [] },
  };
}

export function createProviderManifest({ key, displayName, officialUrl, color = "#6b738f" }) {
  const canonicalUrl = normalizeProviderUrl(officialUrl);
  const domain = normalizeOfficialDomain(new URL(canonicalUrl).hostname);
  return {
    $schema: `../${PROVIDER_SCHEMA_FILE}`,
    schemaVersion: PROVIDER_MANIFEST_VERSION,
    key,
    displayName,
    official: { urls: [canonicalUrl], domains: [domain] },
    presentation: { color, officialRfqUrl: null, purchasingDomains: [] },
    integration: {
      adapterKind: "guidance_only",
      processFamily: "unknown",
      implementationStage: "scaffolded",
    },
    capabilityEnvelope: createUnknownCapabilityEnvelope(),
    evidence: { firstPartyUrls: [], reviewedAt: null },
    safety: {
      quoteOnly: true,
      orderingProhibited: true,
      sessionIsolationRequired: true,
    },
  };
}

function validateKnowledgeList(value, label, property = "values") {
  const object = requireObject(value, label);
  assertExactKeys(object, ["status", property], label);
  if (!KNOWLEDGE_STATUSES.has(object.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  requireUniqueStrings(object[property], `${label}.${property}`);
  if (object.status !== "supported" && object[property].length > 0) {
    throw new Error(`${label} may only contain values when status is supported`);
  }
}

function validateBound(value, label, minimumKey, maximumKey) {
  const object = requireObject(value, label);
  assertExactKeys(object, ["status", minimumKey, maximumKey], label);
  if (!KNOWLEDGE_STATUSES.has(object.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  for (const key of [minimumKey, maximumKey]) {
    if (object[key] !== null && (!Number.isFinite(object[key]) || object[key] < 0)) {
      throw new Error(`${label}.${key} must be null or a non-negative number`);
    }
  }
  if (object.status !== "supported" && (object[minimumKey] !== null || object[maximumKey] !== null)) {
    throw new Error(`${label} bounds require supported status`);
  }
  if (
    object[minimumKey] !== null &&
    object[maximumKey] !== null &&
    object[minimumKey] > object[maximumKey]
  ) {
    throw new Error(`${label}.${minimumKey} must not exceed ${label}.${maximumKey}`);
  }
}

function parseReviewDate(value, label, today) {
  if (value === null) {
    return null;
  }
  requireString(value, label, /^\d{4}-\d{2}-\d{2}$/);
  const reviewed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(reviewed.getTime()) || reviewed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real calendar date`);
  }
  if (today) {
    const now = new Date(`${today}T00:00:00.000Z`);
    const ageDays = (now.getTime() - reviewed.getTime()) / 86_400_000;
    if (ageDays < 0 || ageDays > MAX_EVIDENCE_AGE_DAYS) {
      throw new Error(`${label} must be current and not in the future`);
    }
  }
  return value;
}

/**
 * Validate the complete ProviderManifestV1 contract without adding a runtime
 * schema dependency. Unknown capability claims must remain structurally empty.
 */
export function validateProviderManifest(manifest, options = {}) {
  const value = requireObject(manifest, "manifest");
  assertExactKeys(value, [
    "$schema",
    "schemaVersion",
    "key",
    "displayName",
    "official",
    "presentation",
    "integration",
    "capabilityEnvelope",
    "evidence",
    "safety",
  ], "manifest");
  if (value.$schema !== `../${PROVIDER_SCHEMA_FILE}` || value.schemaVersion !== 1) {
    throw new Error("manifest schema reference or version is invalid");
  }
  requireString(value.key, "manifest.key", /^[a-z][a-z0-9]{1,49}$/);
  requireString(value.displayName, "manifest.displayName");
  if (options.directoryName && value.key !== options.directoryName) {
    throw new Error(`manifest key ${value.key} does not match directory ${options.directoryName}`);
  }

  const official = requireObject(value.official, "manifest.official");
  assertExactKeys(official, ["urls", "domains"], "manifest.official");
  const domains = requireUniqueStrings(official.domains, "manifest.official.domains");
  domains.forEach((domain) => {
    if (normalizeOfficialDomain(domain) !== domain) {
      throw new Error(`manifest official domain is not normalized: ${domain}`);
    }
  });
  const urls = requireUniqueStrings(official.urls, "manifest.official.urls");
  urls.forEach((url, index) => {
    const hostname = normalizeOfficialDomain(parseSafeHttpsUrl(url, `manifest.official.urls[${index}]`).hostname);
    if (!domains.some((domain) => isDomainOrSubdomain(hostname, domain))) {
      throw new Error(`manifest official URL is outside declared domains: ${url}`);
    }
  });

  const presentation = requireObject(value.presentation, "manifest.presentation");
  assertExactKeys(presentation, ["color", "officialRfqUrl", "purchasingDomains"], "manifest.presentation");
  requireString(presentation.color, "manifest.presentation.color", /^#[0-9a-f]{6}$/);
  requireNullableString(presentation.officialRfqUrl, "manifest.presentation.officialRfqUrl");
  if (presentation.officialRfqUrl !== null) {
    const hostname = normalizeOfficialDomain(parseSafeHttpsUrl(presentation.officialRfqUrl, "manifest.presentation.officialRfqUrl").hostname);
    if (!domains.some((domain) => isDomainOrSubdomain(hostname, domain))) {
      throw new Error("manifest RFQ URL is outside declared domains");
    }
  }
  const purchasingDomains = requireUniqueStrings(presentation.purchasingDomains, "manifest.presentation.purchasingDomains");
  purchasingDomains.forEach((domain) => {
    if (normalizeOfficialDomain(domain) !== domain || !domains.includes(domain)) {
      throw new Error(`purchasing domain is not an exact official domain: ${domain}`);
    }
  });

  const integration = requireObject(value.integration, "manifest.integration");
  assertExactKeys(integration, ["adapterKind", "processFamily", "implementationStage"], "manifest.integration");
  if (!ADAPTER_KINDS.has(integration.adapterKind)) {
    throw new Error("manifest.integration.adapterKind is invalid");
  }
  requireString(integration.processFamily, "manifest.integration.processFamily", /^[a-z][a-z0-9_]{1,49}$/);
  requireString(integration.implementationStage, "manifest.integration.implementationStage", /^[a-z][a-z0-9_]{1,49}$/);

  const envelope = requireObject(value.capabilityEnvelope, "manifest.capabilityEnvelope");
  assertExactKeys(envelope, [
    "version", "processes", "materials", "files", "quantity", "tolerance",
    "geometry", "drawings", "accountModes",
  ], "manifest.capabilityEnvelope");
  if (envelope.version !== 1) {
    throw new Error("manifest.capabilityEnvelope.version must be 1");
  }
  validateKnowledgeList(envelope.processes, "manifest.capabilityEnvelope.processes");
  validateKnowledgeList(envelope.materials, "manifest.capabilityEnvelope.materials");
  validateKnowledgeList(envelope.files, "manifest.capabilityEnvelope.files");
  validateBound(envelope.quantity, "manifest.capabilityEnvelope.quantity", "minimum", "maximum");
  validateBound(envelope.tolerance, "manifest.capabilityEnvelope.tolerance", "minimumMm", "maximumMm");
  validateKnowledgeList(envelope.geometry, "manifest.capabilityEnvelope.geometry", "constraints");
  validateKnowledgeList(envelope.drawings, "manifest.capabilityEnvelope.drawings");
  validateKnowledgeList(envelope.accountModes, "manifest.capabilityEnvelope.accountModes");

  const evidence = requireObject(value.evidence, "manifest.evidence");
  assertExactKeys(evidence, ["firstPartyUrls", "reviewedAt"], "manifest.evidence");
  const evidenceUrls = requireUniqueStrings(evidence.firstPartyUrls, "manifest.evidence.firstPartyUrls");
  evidenceUrls.forEach((url, index) => {
    const hostname = normalizeOfficialDomain(parseSafeHttpsUrl(url, `manifest.evidence.firstPartyUrls[${index}]`).hostname);
    if (!domains.some((domain) => isDomainOrSubdomain(hostname, domain))) {
      throw new Error(`first-party evidence URL is outside declared domains: ${url}`);
    }
  });
  parseReviewDate(evidence.reviewedAt, "manifest.evidence.reviewedAt", options.today);
  if (evidenceUrls.length > 0 && evidence.reviewedAt === null && !options.allowUnreviewedEvidence) {
    throw new Error("first-party evidence URLs require a review date");
  }
  if (evidenceUrls.length === 0 && evidence.reviewedAt !== null) {
    throw new Error("an evidence review date requires at least one first-party URL");
  }

  const safety = requireObject(value.safety, "manifest.safety");
  assertExactKeys(safety, ["quoteOnly", "orderingProhibited", "sessionIsolationRequired"], "manifest.safety");
  if (safety.quoteOnly !== true || safety.orderingProhibited !== true || safety.sessionIsolationRequired !== true) {
    throw new Error("provider safety requirements must all remain true");
  }
  return value;
}

async function assertNoSymlink(targetPath, label) {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  return stat;
}

async function readDirectoryIfPresent(targetPath) {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function assertTreeHasNoSymlinks(rootDir) {
  const entries = await readDirectoryIfPresent(rootDir);
  if (!entries) {
    return;
  }
  await assertNoSymlink(rootDir, "provider-integrations");
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    const stat = await assertNoSymlink(entryPath, entryPath);
    if (stat.isDirectory()) {
      await assertTreeHasNoSymlinks(entryPath);
    }
  }
}

async function readProviderManifest(integrationsDir, entry, options) {
  const manifestPath = path.join(integrationsDir, entry.name, PROVIDER_MANIFEST_FILE);
  let source;
  try {
    source = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`provider directory ${entry.name} is missing ${PROVIDER_MANIFEST_FILE}`);
    }
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error(`${manifestPath} is not valid JSON`);
  }
  validateProviderManifest(manifest, { ...options, directoryName: entry.name });
  return { manifest, manifestPath };
}

function assertDistinctProviderIdentities(manifests) {
  const keys = new Set();
  const domains = new Map();
  for (const { manifest } of manifests) {
    if (keys.has(manifest.key)) {
      throw new Error(`duplicate provider key: ${manifest.key}`);
    }
    keys.add(manifest.key);
    for (const domain of manifest.official.domains) {
      const overlapping = [...domains.entries()].find(([knownDomain]) =>
        isDomainOrSubdomain(domain, knownDomain) || isDomainOrSubdomain(knownDomain, domain));
      if (overlapping && overlapping[1] !== manifest.key) {
        throw new Error(`overlapping provider domain ${domain}: ${overlapping[1]} and ${manifest.key}`);
      }
      domains.set(domain, manifest.key);
    }
  }
}

export async function readProviderManifests(rootDir, options = {}) {
  const integrationsDir = path.join(rootDir, "provider-integrations");
  await assertTreeHasNoSymlinks(integrationsDir);
  let entries;
  try {
    entries = await fs.readdir(integrationsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const manifests = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    manifests.push(await readProviderManifest(integrationsDir, entry, options));
  }
  assertDistinctProviderIdentities(manifests);
  return manifests;
}

function extractUnionKeys(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`could not locate ${label}`);
  }
  return [...match[1].matchAll(/\|\s*"([a-z][a-z0-9]+)"/g)].map((item) => item[1]);
}

export async function readCurrentVendorKeys(rootDir) {
  const [webSource, workerSource] = await Promise.all([
    fs.readFile(path.join(rootDir, "src/integrations/supabase/types.ts"), "utf8"),
    fs.readFile(path.join(rootDir, "worker/src/types.ts"), "utf8"),
  ]);
  const webKeys = extractUnionKeys(
    webSource,
    /vendor_name:\s*((?:\|\s*"[a-z][a-z0-9]+"\s*)+)/,
    "web vendor_name enum",
  );
  const workerKeys = extractUnionKeys(
    workerSource,
    /export type VendorName\s*=\s*((?:\|\s*"[a-z][a-z0-9]+"\s*;?)+)/,
    "worker VendorName union",
  );
  const web = [...new Set(webKeys)].sort(compareStrings);
  const worker = [...new Set(workerKeys)].sort(compareStrings);
  if (JSON.stringify(web) !== JSON.stringify(worker)) {
    throw new Error("web and worker vendor key definitions are out of sync");
  }
  return web;
}

export function buildCatalog(manifests) {
  return Object.fromEntries(
    manifests
      .map(({ manifest }) => manifest)
      .sort((left, right) => compareStrings(left.key, right.key))
      .map((manifest) => [manifest.key, {
        displayName: manifest.displayName,
        color: manifest.presentation.color,
        officialUrls: manifest.official.urls,
        officialDomains: manifest.official.domains,
        officialRfqUrl: manifest.presentation.officialRfqUrl,
        purchasingDomains: manifest.presentation.purchasingDomains,
        adapterKind: manifest.integration.adapterKind,
        processFamily: manifest.integration.processFamily,
        implementationStage: manifest.integration.implementationStage,
        capabilityEnvelope: manifest.capabilityEnvelope,
      }]),
  );
}

export function renderCatalog(catalog, target) {
  const importPath = target === "web"
    ? "@/integrations/supabase/types"
    : "../types.js";
  const propertyOrder = target === "web"
    ? [
        "displayName",
        "color",
        "officialUrls",
        "officialDomains",
        "officialRfqUrl",
        "purchasingDomains",
        "adapterKind",
        "processFamily",
        "implementationStage",
      ]
    : [
        "adapterKind",
        "processFamily",
        "implementationStage",
        "displayName",
        "color",
        "officialUrls",
        "officialDomains",
        "officialRfqUrl",
        "purchasingDomains",
        "capabilityEnvelope",
      ];
  const generatedEntries = Object.entries(catalog).map(([key, entry]) => {
    const orderedEntry = Object.fromEntries(
      propertyOrder
        .filter((property) => Object.hasOwn(entry, property))
        .map((property) => [property, entry[property]]),
    );
    const renderedEntry = JSON.stringify(orderedEntry).replace(/"([^"\n]+)":/g, "$1:");
    return `  ${key}: ${renderedEntry},`;
  });
  const generated = `{\n${generatedEntries.join("\n")}\n}`;
  const envelopeTypes = target === "worker"
    ? `\nexport type ProviderCapabilityStatus = "unknown" | "supported" | "unsupported";\n\nexport type ProviderCapabilityEnvelope = {\n  version: 1;\n  processes: { status: ProviderCapabilityStatus; values: readonly string[] };\n  materials: { status: ProviderCapabilityStatus; values: readonly string[] };\n  files: { status: ProviderCapabilityStatus; values: readonly string[] };\n  quantity: { status: ProviderCapabilityStatus; minimum: number | null; maximum: number | null };\n  tolerance: { status: ProviderCapabilityStatus; minimumMm: number | null; maximumMm: number | null };\n  geometry: { status: ProviderCapabilityStatus; constraints: readonly string[] };\n  drawings: { status: ProviderCapabilityStatus; values: readonly string[] };\n  accountModes: { status: ProviderCapabilityStatus; values: readonly string[] };\n};\n`
    : "";
  const envelopeField = target === "worker"
    ? "\n  capabilityEnvelope: ProviderCapabilityEnvelope;"
    : "";
  return `// Generated by npm run provider:sync. Do not edit directly.\nimport type { VendorName } from "${importPath}";\n${envelopeTypes}\nexport type ProviderCatalogEntry = {\n  displayName: string;\n  color: string;\n  officialUrls: readonly string[];\n  officialDomains: readonly string[];\n  officialRfqUrl: string | null;\n  purchasingDomains: readonly string[];\n  adapterKind: "api" | "declarative_portal" | "custom_portal" | "guidance_only";\n  processFamily: string;\n  implementationStage: string;${envelopeField}\n};\n\nexport const PROVIDER_CATALOG = ${generated} as const satisfies Record<VendorName, ProviderCatalogEntry>;\n`;
}

export function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
