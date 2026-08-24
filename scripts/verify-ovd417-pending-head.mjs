import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MANIFEST_PATH = "docs/release/ovd-417-four-migration-manifest.json";
export const EXPECTED_SOURCE_COMMIT = "5c3b6864e63ada75561f4ff7019bde70962d6e39";
export const EXPECTED_MIGRATION_ROOT = "supabase/migrations";
export const FROZEN_PENDING_HEAD_FILENAMES = Object.freeze([
  "20260817133902_add_quote_provider_admission_registry.sql",
  "20260821223849_add_emachineshop_manual_vendor.sql",
  "20260821223851_configure_emachineshop_manual_vendor.sql",
  "20260822213330_add_vendor_quote_offer_geographic_origin.sql",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

function addViolation(violations, message) {
  if (!violations.includes(message)) violations.push(message);
}

function compareOrderedNames(expected, actual, label, violations) {
  if (expected.length === actual.length && expected.every((name, index) => name === actual[index])) return;
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length) addViolation(violations, `${label}: missing ${missing.join(", ")}`);
  if (extra.length) addViolation(violations, `${label}: extra ${extra.join(", ")}`);
  if (!missing.length && !extra.length) addViolation(violations, `${label}: files are reordered`);
}

/** Validates the immutable OVD-417 four-migration manifest without throwing. */
export function validateManifestShape(manifest) {
  const violations = [];
  if (manifest?.schemaVersion !== 1) addViolation(violations, "manifest: unsupported schema version");
  if (manifest?.sourceCommit !== EXPECTED_SOURCE_COMMIT) {
    addViolation(violations, "manifest: source commit does not match the frozen OVD-417 commit");
  }
  if (manifest?.migrationRoot !== EXPECTED_MIGRATION_ROOT) {
    addViolation(violations, "manifest: migration root does not match the canonical root");
  }
  const entries = Array.isArray(manifest?.pendingHead) ? manifest.pendingHead : [];
  compareOrderedNames(FROZEN_PENDING_HEAD_FILENAMES, entries.map((entry) => entry?.filename), "manifest pending-head", violations);
  if (entries.length !== FROZEN_PENDING_HEAD_FILENAMES.length) {
    addViolation(violations, "manifest pending-head: expected exactly 4 entries");
  }
  for (const entry of entries) {
    if (!entry || typeof entry.filename !== "string") {
      addViolation(violations, "manifest pending-head: every entry needs a filename");
      continue;
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) addViolation(violations, `${entry.filename}: manifest byte length is invalid`);
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) addViolation(violations, `${entry.filename}: manifest SHA-256 is invalid`);
  }
  return violations;
}

async function listMigrationNames(migrationRoot) {
  return (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function inspectFile(migrationRoot, entry, violations) {
  if (!entry || typeof entry.filename !== "string") return;
  const filePath = path.join(migrationRoot, entry.filename);
  let stats;
  try { stats = await lstat(filePath); } catch (error) {
    if (error?.code === "ENOENT") { addViolation(violations, `${entry.filename}: migration is missing`); return; }
    throw error;
  }
  if (!stats.isFile()) { addViolation(violations, `${entry.filename}: migration must be a regular file`); return; }
  const contents = await readFile(filePath);
  if (contents.byteLength !== entry.bytes) addViolation(violations, `${entry.filename}: expected ${entry.bytes} bytes, found ${contents.byteLength}`);
  if (sha256(contents) !== entry.sha256) addViolation(violations, `${entry.filename}: SHA-256 does not match manifest`);
}

/** Verifies an on-disk migration tree against an exact source-tree filename list. */
export async function inspectPendingHead(migrationRoot, manifest, { sourceMigrationFilenames } = {}) {
  const violations = validateManifestShape(manifest);
  const actualNames = await listMigrationNames(migrationRoot);
  if (sourceMigrationFilenames) compareOrderedNames(sourceMigrationFilenames, actualNames, "migration directory", violations);
  for (const entry of Array.isArray(manifest?.pendingHead) ? manifest.pendingHead : []) await inspectFile(migrationRoot, entry, violations);
  return violations.sort((left, right) => left.localeCompare(right));
}

async function gitOutput(repositoryRoot, args, encoding = "utf8") {
  const { stdout } = await execFileAsync("git", args, { cwd: repositoryRoot, encoding, maxBuffer: 1024 * 1024 });
  return encoding === "utf8" ? stdout.trim() : stdout;
}

async function sourceMigrationNames(repositoryRoot) {
  const output = await gitOutput(repositoryRoot, ["ls-tree", "-r", "--name-only", EXPECTED_SOURCE_COMMIT, "--", EXPECTED_MIGRATION_ROOT]);
  return output.split("\n").filter(Boolean).map((name) => name.slice(`${EXPECTED_MIGRATION_ROOT}/`.length)).sort((left, right) => left.localeCompare(right));
}

async function verifySourceBlobs(repositoryRoot, manifest, violations) {
  for (const entry of Array.isArray(manifest?.pendingHead) ? manifest.pendingHead : []) {
    if (!entry || typeof entry.filename !== "string") continue;
    try {
      const blob = await gitOutput(repositoryRoot, ["show", `${EXPECTED_SOURCE_COMMIT}:${EXPECTED_MIGRATION_ROOT}/${entry.filename}`], "buffer");
      if (blob.byteLength !== entry.bytes || sha256(blob) !== entry.sha256) addViolation(violations, `${entry.filename}: manifest does not match the pinned source blob`);
    } catch { addViolation(violations, `${entry.filename}: migration is absent from the pinned source commit`); }
  }
}

/** Offline, fail-closed verification of ancestry, source blobs, and the exact migration tree. */
export async function verifyPendingHead({ repositoryRoot = process.cwd(), manifestPath = path.resolve(repositoryRoot, MANIFEST_PATH), migrationRoot = path.resolve(repositoryRoot, EXPECTED_MIGRATION_ROOT) } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const violations = validateManifestShape(manifest);
  const head = await gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
  try { await gitOutput(repositoryRoot, ["merge-base", "--is-ancestor", EXPECTED_SOURCE_COMMIT, head]); }
  catch { addViolation(violations, `repository HEAD ${head} does not descend from frozen source commit ${EXPECTED_SOURCE_COMMIT}`); }
  violations.push(...await inspectPendingHead(migrationRoot, manifest, { sourceMigrationFilenames: await sourceMigrationNames(repositoryRoot) }));
  await verifySourceBlobs(repositoryRoot, manifest, violations);
  return [...new Set(violations)].sort((left, right) => left.localeCompare(right));
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  const violations = await verifyPendingHead();
  if (violations.length) { console.error("OVD-417 pending-head verification failed:"); violations.forEach((violation) => console.error(`- ${violation}`)); process.exitCode = 1; }
  else console.log("OVD-417 pending-head verification passed.");
}
