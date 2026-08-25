import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  OVD417_MIGRATION_HASHES,
  OVD417_SOURCE_SHA,
  OVD418_PRODUCTION_CONTINUITY,
  OVD418_PRODUCTION_LEDGER_STATES,
  OVD418_SUFFIX_STATEMENT_HASHES,
} from "./ovd418-production-ledger-contract.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_CONTINUITY = OVD418_PRODUCTION_CONTINUITY;
const PRODUCTION_STATES = Object.freeze(
  ["baseline", "partial-one", "partial-two", "partial-three", "final"].map((name, index) =>
    Object.freeze({ name, packagePrefixLength: index, ...OVD418_PRODUCTION_LEDGER_STATES[index] }),
  ),
);
const MIGRATION_FILENAMES = Object.freeze([
  "20260817133902_add_quote_provider_admission_registry.sql",
  "20260821223849_add_emachineshop_manual_vendor.sql",
  "20260821223851_configure_emachineshop_manual_vendor.sql",
  "20260822213330_add_vendor_quote_offer_geographic_origin.sql",
]);
const MIGRATIONS = Object.freeze(OVD417_MIGRATION_HASHES.map((migration, index) => Object.freeze({
  ...migration,
  filename: MIGRATION_FILENAMES[index],
  statementHash: OVD418_SUFFIX_STATEMENT_HASHES[index].statementHash,
})));
const COMMANDS = Object.freeze({
  preaudit: "bash scripts/run-ovd418-production-release.sh preaudit",
  apply: "bash scripts/run-ovd418-production-release.sh apply",
  postaudit: "bash scripts/run-ovd418-production-release.sh postaudit",
});
const RECOVERY = Object.freeze({ baseline: "apply", partialOne: "resume", final: "postaudit", other: "incident-review" });
const EVIDENCE_BOUNDARY = Object.freeze({
  customerRows: "private-backup-only",
  customerIdentifiers: "private-backup-only",
  secrets: "private-only",
  aggregateCounts: "private-only",
});
const TOP_LEVEL_KEYS = Object.freeze(["schemaVersion", "issue", "repository", "projectRef", "deployCommit", "sourceCommit", "supabaseCliVersion", "productionLedger", "migrations", "commands", "recovery", "evidenceBoundary", "singleUse"]);

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

/** Validates the complete, fixed-shape private OVD-418 authorization envelope. */
export function validateAuthorization(authorization, expectedHead) {
  const violations = [];
  if (!hasExactKeys(authorization, TOP_LEVEL_KEYS)) {
    return ["authorization must have exactly the approved top-level keys"];
  }
  if (authorization.schemaVersion !== 2) violations.push("schemaVersion must be 2");
  if (authorization.issue !== "OVD-418") violations.push("issue must be OVD-418");
  if (authorization.repository !== "optomachina/Overdrafter") violations.push("repository drifted");
  if (authorization.projectRef !== "ozuatdcakezjtevztjlr") violations.push("projectRef drifted");
  if (!/^[0-9a-f]{40}$/.test(authorization.deployCommit) || authorization.deployCommit !== expectedHead) {
    violations.push("deployCommit must be the expected 40-character lowercase SHA-1 HEAD");
  }
  if (authorization.sourceCommit !== OVD417_SOURCE_SHA) violations.push("sourceCommit drifted");
  if (authorization.supabaseCliVersion !== "2.78.1") violations.push("supabaseCliVersion must be 2.78.1");
  if (!hasExactKeys(authorization.productionLedger, ["continuity", "states"]) || !hasExactKeys(authorization.productionLedger?.continuity, ["ovd373Prefix", "ovd373OriginalSubset", "row100"]) || !sameJson(authorization.productionLedger?.continuity, PRODUCTION_CONTINUITY) || !Array.isArray(authorization.productionLedger?.states) || !authorization.productionLedger.states.every((state) => hasExactKeys(state, ["name", "packagePrefixLength", "count", "head", "fingerprint"])) || !sameJson(authorization.productionLedger?.states, PRODUCTION_STATES)) violations.push("production ledger continuity or states drifted");
  if (!Array.isArray(authorization.migrations) || authorization.migrations.length !== MIGRATIONS.length || !authorization.migrations.every((migration) => hasExactKeys(migration, ["version", "filename", "sha256", "statementHash"])) || !sameJson(authorization.migrations, MIGRATIONS)) violations.push("migration package must be the exact ordered four-migration release with statement hashes");
  if (!hasExactKeys(authorization.commands, ["preaudit", "apply", "postaudit"]) || !sameJson(authorization.commands, COMMANDS)) violations.push("commands must be the exact OVD-418 production scripts");
  if (!hasExactKeys(authorization.recovery, ["baseline", "partialOne", "final", "other"]) || !sameJson(authorization.recovery, RECOVERY)) violations.push("recovery decisions drifted");
  if (!hasExactKeys(authorization.evidenceBoundary, ["customerRows", "customerIdentifiers", "secrets", "aggregateCounts"]) || !sameJson(authorization.evidenceBoundary, EVIDENCE_BOUNDARY)) violations.push("private evidence boundary drifted");
  if (authorization.singleUse !== true) violations.push("singleUse must be true");
  return violations;
}

/** Parses only the three required command-line arguments, rejecting duplicates and unknown options. */
export function parseArguments(args) {
  const options = {};
  const optionNames = new Set(["--authorization-file", "--expected-sha256", "--expected-head"]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (!optionNames.has(name) || !value || Object.hasOwn(options, name)) {
      throw new Error(`Unknown, duplicate, or incomplete argument: ${name}`);
    }
    options[name] = value;
    index += 1;
  }
  if (!options["--authorization-file"] || !options["--expected-sha256"] || !options["--expected-head"]) {
    throw new Error("Usage: node scripts/verify-ovd418-production-authorization.mjs --authorization-file <absolute-private-json> --expected-sha256 <sha256> --expected-head <40-lowercase-hex-head>");
  }
  if (!path.isAbsolute(options["--authorization-file"])) throw new Error("authorization file path must be absolute");
  if (!/^[0-9a-f]{64}$/.test(options["--expected-sha256"])) throw new Error("expected SHA-256 must be 64 lowercase hex characters");
  if (!/^[0-9a-f]{40}$/.test(options["--expected-head"])) throw new Error("expected HEAD must be 40 lowercase hex characters");
  return { authorizationFile: options["--authorization-file"], expectedSha256: options["--expected-sha256"], expectedHead: options["--expected-head"] };
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function repositoryRoots() {
  const roots = [await realpath(REPOSITORY_ROOT)];
  const dotGitPath = path.join(REPOSITORY_ROOT, ".git");
  const dotGitStats = await lstat(dotGitPath);
  if (!dotGitStats.isFile()) return roots;
  const match = /^gitdir: (.+)$/m.exec(await readFile(dotGitPath, "utf8"));
  if (!match) throw new Error("worktree gitdir metadata is malformed");
  const gitDirectory = path.resolve(REPOSITORY_ROOT, match[1]);
  let commonDirectory = gitDirectory;
  try {
    commonDirectory = path.resolve(gitDirectory, (await readFile(path.join(gitDirectory, "commondir"), "utf8")).trim());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const resolvedCommonDirectory = await realpath(commonDirectory);
  if (path.basename(resolvedCommonDirectory) === ".git") {
    roots.push(await realpath(path.dirname(resolvedCommonDirectory)));
  }
  return [...new Set(roots)];
}

/** Reads exact bytes from a private regular file, rejecting symlinks, repository files, and unsafe modes. */
export async function readPrivateAuthorizationFile(authorizationFile) {
  if (!path.isAbsolute(authorizationFile)) throw new Error("authorization file path must be absolute");
  const initial = await lstat(authorizationFile);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("authorization file must be a regular non-symlink file");
  if ((initial.mode & 0o777) !== 0o600) throw new Error("authorization file mode must be exactly 0600");
  const [resolvedFile, repositoryRootPaths] = await Promise.all([realpath(authorizationFile), repositoryRoots()]);
  if (repositoryRootPaths.some((repositoryRoot) => isWithin(resolvedFile, repositoryRoot))) {
    throw new Error("authorization file must be outside the repository and every linked worktree root");
  }

  const handle = await open(authorizationFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new Error("authorization file changed or failed private regular-file checks");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyProductionAuthorization(options) {
  const bytes = await readPrivateAuthorizationFile(options.authorizationFile);
  if (sha256(bytes) !== options.expectedSha256) throw new Error("authorization file SHA-256 does not match expected exact bytes");
  let authorization;
  try {
    authorization = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("authorization file must contain valid UTF-8 JSON");
  }
  const violations = validateAuthorization(authorization, options.expectedHead);
  if (violations.length > 0) throw new Error(`authorization rejected: ${violations.join("; ")}`);
  return authorization;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await verifyProductionAuthorization(options);
  console.log("OVD-418 production authorization verification passed.");
}

const direct = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (direct) {
  try {
    await main();
  } catch (error) {
    console.error(`OVD-418 production authorization verification stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
