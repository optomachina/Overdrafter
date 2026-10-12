import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { scaffoldProvider } from "./provider-add.mjs";
import {
  PROVIDER_MANIFEST_FILE,
  deriveProviderKey,
  normalizeProviderUrl,
  readProviderManifests,
} from "./provider-manifest.mjs";
import {
  PROVIDER_REGISTRY_RELATIVE_PATH,
  readProviderRegistry,
  renderProviderRegistryDocument,
  withDefaultRegistryEntry,
} from "./provider-registry.mjs";
import { assertSafeGeneratedOutput, syncProviderIntegrations } from "./provider-sync.mjs";
import {
  GENERATOR_ISSUE,
  admissionRevisionSql,
  authorizationBindingTs,
  dispatchFixtureTs,
  envelopeFixtureJson,
  envelopeReviewSql,
  productionPortalBrowserTestTs,
  productionPortalTestTs,
  productionPortalTs,
  readinessDoc,
  rolloutRunbook,
  sessionSecretBlock,
  sessionSecretMarker,
  unauthorizedCadExtension,
} from "./fixture-onboard-templates.mjs";

/**
 * Fixture: `npm run fixture:onboard -- <key> --stage=envelope|live|admit` (OVD-687).
 *
 * One deterministic generator for the three provider stages in
 * docs/provider-integration.md. Every stage is idempotent: an existing file is
 * never overwritten (identical content is `unchanged`, edited content is
 * `kept`), so re-running a stage is a no-op. All output is disabled and
 * non-authoritative; nothing is applied, admitted, or deployed. The envelope
 * stage adds only a default-off provider-registry entry (never changing an
 * existing one) and runs provider:sync.
 */

export const FIXTURE_STAGES = ["envelope", "live", "admit"];
export const MIGRATIONS_RELATIVE_DIR = "supabase/migrations";
export const ENVELOPE_FIXTURE_RELATIVE_DIR = "test-fixtures/provider-dispatch-envelope";
const ADMIT_REVIEW_SUFFIX = "_reviewed_dispatch_envelope.sql.review";
const MIGRATION_TIMESTAMP = /^(\d{14})_/;
const KEY_PATTERN = /^[a-z][a-z0-9]{1,62}$/;
const ISSUE_PATTERN = /^OVD-[1-9]\d{0,9}$/;

export function livePaths(key) {
  return {
    envelopeFixture: `${ENVELOPE_FIXTURE_RELATIVE_DIR}/${key}-v1.json`,
    authorizationBinding: `worker/src/adapters/${key}DispatchAuthorization.ts`,
    productionPortal: `worker/src/adapters/${key}ProductionPortal.ts`,
    dispatchFixture: `worker/test-support/${key}DispatchFixture.ts`,
    productionPortalTest: `worker/src/adapters/${key}ProductionPortal.test.ts`,
    productionPortalBrowserTest: `worker/src/adapters/${key}ProductionPortal.browser.test.ts`,
    readinessDoc: `docs/workflows/${key}-live-readiness.md`,
    sessionSecret: "worker/.env.example",
  };
}

function admitDir(key) {
  return `provider-integrations/${key}/admit`;
}

/** Parses the worker's LIVE_AUTOMATION_VENDORS tuple; a live stub's provider type requires membership. */
export async function readLiveAutomationVendors(rootDir) {
  const source = await fs.readFile(path.join(rootDir, "worker/src/types.ts"), "utf8");
  const match = /export const LIVE_AUTOMATION_VENDORS\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!match) {
    throw new Error("could not locate worker LIVE_AUTOMATION_VENDORS");
  }
  return [...match[1].matchAll(/"([a-z][a-z0-9]+)"/g)].map((item) => item[1]);
}

function addOneHour(timestamp) {
  const [year, month, day, hour, minute, second] = [
    timestamp.slice(0, 4), timestamp.slice(4, 6), timestamp.slice(6, 8),
    timestamp.slice(8, 10), timestamp.slice(10, 12), timestamp.slice(12, 14),
  ].map(Number);
  const next = new Date(Date.UTC(year, month - 1, day, hour + 1, minute, second));
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(next.getUTCFullYear(), 4)}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`
    + `${pad(next.getUTCHours())}${pad(next.getUTCMinutes())}${pad(next.getUTCSeconds())}`;
}

async function listOrEmpty(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Next free migration timestamp: one hour after the latest applied migration
 * or pending admit review file, whichever is later. Pure function of the tree
 * (no clock), so the same checkout always yields the same answer.
 */
export async function nextMigrationTimestamp(rootDir) {
  const stampsIn = (names, suffix) => names
    .filter((name) => name.endsWith(suffix))
    .map((name) => MIGRATION_TIMESTAMP.exec(name)?.[1])
    .filter(Boolean);
  const providers = await listOrEmpty(path.join(rootDir, "provider-integrations"));
  const admitListings = await Promise.all(
    providers.map((provider) => listOrEmpty(path.join(rootDir, admitDir(provider)))),
  );
  const stamps = [
    ...stampsIn(await listOrEmpty(path.join(rootDir, MIGRATIONS_RELATIVE_DIR)), ".sql"),
    ...admitListings.flatMap((names) => stampsIn(names, ADMIT_REVIEW_SUFFIX)),
  ];
  if (stamps.length === 0) {
    throw new Error(`no migrations found under ${MIGRATIONS_RELATIVE_DIR}`);
  }
  // 14-digit YYYYMMDDHHMMSS values are exact as numbers (< 2^53), so the numeric max is the latest.
  return addOneHour(String(Math.max(...stamps.map(Number))));
}

async function existingAdmitTimestamp(rootDir, key) {
  const suffix = `_${key}${ADMIT_REVIEW_SUFFIX}`;
  const names = (await listOrEmpty(path.join(rootDir, admitDir(key))))
    .filter((name) => name.endsWith(suffix) && MIGRATION_TIMESTAMP.test(name));
  if (names.length > 1) {
    throw new Error(`more than one admit review file exists for ${key}; resolve manually`);
  }
  return names.length === 1 ? MIGRATION_TIMESTAMP.exec(names[0])[1] : null;
}

async function exists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requireManifest(rootDir, key) {
  const manifests = await readProviderManifests(rootDir, { allowUnreviewedEvidence: true });
  const entry = manifests.find(({ manifest }) => manifest.key === key);
  if (!entry) {
    throw new Error(`no manifest for ${key}; run --stage=envelope first`);
  }
  return entry.manifest;
}

async function planLive(rootDir, key, issue) {
  const manifest = await requireManifest(rootDir, key);
  const files = manifest.capabilityEnvelope.files;
  if (files.status !== "supported" || files.values.length === 0) {
    throw new Error(`${key} manifest has no evidence-backed CAD file envelope; complete stage 1 first`);
  }
  if (!unauthorizedCadExtension(manifest)) {
    throw new Error(`${key} manifest lists every candidate CAD extension; the default-deny test needs one outside it`);
  }
  if (!(await readLiveAutomationVendors(rootDir)).includes(key)) {
    throw new Error(`${key} is not in worker LIVE_AUTOMATION_VENDORS; apply the reviewed enum change first`);
  }
  const context = { key, displayName: manifest.displayName, manifest, issue };
  const paths = livePaths(key);
  return [
    { path: paths.envelopeFixture, contents: envelopeFixtureJson(context) },
    { path: paths.authorizationBinding, contents: authorizationBindingTs(context) },
    { path: paths.productionPortal, contents: productionPortalTs(context) },
    { path: paths.dispatchFixture, contents: dispatchFixtureTs(context) },
    { path: paths.productionPortalTest, contents: productionPortalTestTs(context) },
    { path: paths.productionPortalBrowserTest, contents: productionPortalBrowserTestTs(context) },
    { path: paths.readinessDoc, contents: readinessDoc(context) },
    {
      path: paths.sessionSecret,
      append: true,
      marker: sessionSecretMarker(key),
      contents: sessionSecretBlock(context),
    },
  ];
}

async function planAdmit(rootDir, key, issue) {
  const manifest = await requireManifest(rootDir, key);
  const paths = livePaths(key);
  const required = [paths.envelopeFixture, paths.authorizationBinding];
  const present = await Promise.all(required.map((file) => exists(path.join(rootDir, file))));
  const missing = required.find((_, index) => !present[index]);
  if (missing) {
    throw new Error(`${missing} is missing; run --stage=live first`);
  }
  const timestamp = (await existingAdmitTimestamp(rootDir, key)) ?? (await nextMigrationTimestamp(rootDir));
  const context = { key, displayName: manifest.displayName, manifest, issue, timestamp };
  const dir = admitDir(key);
  return {
    timestamp,
    files: [
      { path: `${dir}/${timestamp}_${key}${ADMIT_REVIEW_SUFFIX}`, contents: envelopeReviewSql(context) },
      { path: `${dir}/${key}_admission_revision.sql.review`, contents: admissionRevisionSql(context) },
      { path: `${dir}/rollout-runbook.md`, contents: rolloutRunbook(context) },
    ],
  };
}

async function assertNoSymlinkedAncestor(rootDir, relativePath) {
  let current = rootDir;
  for (const segment of path.dirname(relativePath).split("/").filter((part) => part && part !== ".")) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`refusing to write through symlinked directory: ${path.relative(rootDir, current)}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

/** Classifies each planned file without writing: create, append, unchanged, or kept (edited by a human). */
async function classify(rootDir, file) {
  await assertNoSymlinkedAncestor(rootDir, file.path);
  const target = path.join(rootDir, file.path);
  let current;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) {
      throw new Error(`refusing to write over non-regular file: ${file.path}`);
    }
    current = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return file.append ? "append" : "create";
  }
  if (file.append) {
    return current.includes(file.marker) ? "unchanged" : "append";
  }
  return current === file.contents ? "unchanged" : "kept";
}

const OUTCOME_BUCKETS = { create: "created", append: "appended", unchanged: "unchanged", kept: "kept" };

async function writePlannedFile(rootDir, file, action) {
  const target = path.join(rootDir, file.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (action === "create") {
    await fs.writeFile(target, file.contents, { flag: "wx", mode: 0o644 });
    return;
  }
  let prefix = "";
  try {
    const current = await fs.readFile(target, "utf8");
    prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.appendFile(target, `${prefix}${file.contents}`);
}

async function applyPlan(rootDir, files, dryRun) {
  const outcome = { created: [], appended: [], unchanged: [], kept: [] };
  // Classify every file before writing any, so a refusal leaves the tree untouched.
  const actions = await Promise.all(files.map((file) => classify(rootDir, file)));
  const writes = [];
  files.forEach((file, index) => {
    const action = actions[index];
    outcome[OUTCOME_BUCKETS[action]].push(file.path);
    if (!dryRun && (action === "create" || action === "append")) {
      writes.push([file, action]);
    }
  });
  // Planned paths are distinct, so the writes are independent.
  await Promise.all(writes.map(([file, action]) => writePlannedFile(rootDir, file, action)));
  return outcome;
}

function validateKey(key) {
  if (!KEY_PATTERN.test(key ?? "")) {
    throw new Error(`invalid provider key: ${key}`);
  }
  return key;
}

async function scaffoldEnvelope({ rootDir, key, url, dryRun }) {
  if (url) {
    return scaffoldProvider({ rootDir, url, dryRun });
  }
  const manifests = await readProviderManifests(rootDir, { allowUnreviewedEvidence: true });
  if (!manifests.some(({ manifest }) => manifest.key === key)) {
    throw new Error(`no manifest for ${key}; pass --url <official-https-url> to scaffold it`);
  }
  return { key, stage: "envelope", dryRun, alreadyExists: true, files: [] };
}

/**
 * Adds the default-off registry entry (`liveAdapter: false`, no session
 * secrets, `egress: "none"`) for a new key. An existing entry is never changed;
 * enabling it stays one reviewed edit to the registry file plus provider:sync.
 */
async function writeDefaultRegistryEntry(rootDir, registry, key, dryRun) {
  const next = withDefaultRegistryEntry(registry, key);
  if (next.providers.length === registry.providers.length) {
    return "unchanged";
  }
  if (!dryRun) {
    const target = await assertSafeGeneratedOutput(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH, "provider registry");
    await fs.writeFile(target, renderProviderRegistryDocument(next));
  }
  return "added";
}

async function runEnvelope({ rootDir, key, url, dryRun }) {
  const providerKey = url ? deriveProviderKey(normalizeProviderUrl(url)) : key;
  if (url && key && providerKey !== key) {
    throw new Error(`--url derives provider key ${providerKey}, not ${key}`);
  }
  // Read and validate the registry before scaffolding, so a bad registry refuses with the tree untouched.
  const registry = await readProviderRegistry(rootDir);
  const scaffold = await scaffoldEnvelope({ rootDir, key: providerKey, url, dryRun });
  // A URL can match an existing provider under another key; only a key with a manifest gets an entry.
  const ownsManifest = !scaffold.alreadyExists
    || await exists(path.join(rootDir, "provider-integrations", providerKey, PROVIDER_MANIFEST_FILE));
  const registryEntry = ownsManifest
    ? await writeDefaultRegistryEntry(rootDir, registry, providerKey, dryRun)
    : "unchanged";
  const changed = !scaffold.alreadyExists || registryEntry === "added";
  const synced = changed && !dryRun ? (await syncProviderIntegrations({ rootDir })).outputs : [];
  return { ...scaffold, registryEntry, synced };
}

export async function runFixtureOnboard({ rootDir, key, stage, url, dryRun = false, issue = GENERATOR_ISSUE }) {
  if (!FIXTURE_STAGES.includes(stage)) {
    throw new Error(`unknown stage: ${stage} (expected ${FIXTURE_STAGES.join("|")})`);
  }
  if (!ISSUE_PATTERN.test(issue)) {
    throw new Error(`invalid --issue: ${issue} (expected OVD-<n>)`);
  }
  if (stage === "envelope") {
    return runEnvelope({ rootDir, key: key ? validateKey(key) : undefined, url, dryRun });
  }
  validateKey(key);
  if (url) {
    throw new Error(`--url applies only to --stage=envelope`);
  }
  if (stage === "live") {
    const outcome = await applyPlan(rootDir, await planLive(rootDir, key, issue), dryRun);
    return { key, stage, dryRun, ...outcome };
  }
  const { timestamp, files } = await planAdmit(rootDir, key, issue);
  const outcome = await applyPlan(rootDir, files, dryRun);
  return { key, stage, dryRun, migrationTimestamp: timestamp, reviewOnly: true, ...outcome };
}

const USAGE = "Usage: npm run fixture:onboard -- <key> --stage=envelope|live|admit [--url <https-url>] [--issue OVD-<n>] [--dry-run]";

export function parseFixtureOnboardArgs(argv) {
  const options = { dryRun: false };
  const takeValue = (arg, next, name) => {
    if (arg.includes("=")) return { value: arg.slice(arg.indexOf("=") + 1), skip: 0 };
    if (next === undefined) throw new Error(`${name} needs a value\n${USAGE}`);
    return { value: next, skip: 1 };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const flag = arg.split("=")[0];
    if (flag === "--stage" || flag === "--url" || flag === "--issue") {
      const { value, skip } = takeValue(arg, argv[index + 1], flag);
      options[flag.slice(2)] = value;
      index += skip;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (!arg.startsWith("-") && options.key === undefined) {
      options.key = arg;
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (!options.stage || (!options.key && !(options.stage === "envelope" && options.url))) {
    throw new Error(USAGE);
  }
  return options;
}

export async function runFixtureOnboardCli(argv = process.argv.slice(2), rootDir = process.cwd()) {
  const result = await runFixtureOnboard({ rootDir, ...parseFixtureOnboardArgs(argv) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    await runFixtureOnboardCli();
  } catch (error) {
    process.stderr.write(`fixture:onboard refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
