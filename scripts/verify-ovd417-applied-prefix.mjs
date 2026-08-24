import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OVD417_PRODUCTION_HEAD = "20260817054500";
export const OVD417_PRODUCTION_LEDGER_COUNT = 100;
export const OVD417_SOURCE_SHA = "5c3b6864e63ada75561f4ff7019bde70962d6e39";
export const OVD417_BASELINE_LEDGER_FINGERPRINT = "5dabebda8a0fc1a3cf697e00de64418b";
export const OVD417_MIGRATION_VERSIONS = Object.freeze([
  "20260817133902",
  "20260821223849",
  "20260821223851",
  "20260822213330",
]);
export const OVD417_MIGRATION_HASHES = Object.freeze([
  Object.freeze({
    version: "20260817133902",
    sha256: "331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b",
  }),
  Object.freeze({
    version: "20260821223849",
    sha256: "0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0",
  }),
  Object.freeze({
    version: "20260821223851",
    sha256: "18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09",
  }),
  Object.freeze({
    version: "20260822213330",
    sha256: "65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86",
  }),
]);
export const OVD417_LEDGER_STATES = Object.freeze([
  Object.freeze({
    count: 100,
    head: "20260817054500",
    fingerprint: "5dabebda8a0fc1a3cf697e00de64418b",
  }),
  Object.freeze({
    count: 101,
    head: "20260817133902",
    fingerprint: "237b68dd5f9cbfaa353c8ee32e1133f1",
  }),
  Object.freeze({
    count: 102,
    head: "20260821223849",
    fingerprint: "984345d23b318111d43e7af57c1ff6e3",
  }),
  Object.freeze({
    count: 103,
    head: "20260821223851",
    fingerprint: "7119bdd3cd717b0f26ace2b5af0172af",
  }),
  Object.freeze({
    count: 104,
    head: "20260822213330",
    fingerprint: "6dd6911df342f253a303e837d8881f7a",
  }),
]);

const ALLOWED_STATES = new Set(["baseline", "partial-one", "recoverable", "final"]);

/**
 * Classifies an OVD-417 migration ledger without accepting gaps, reordering,
 * duplicate package rows, or drift in the frozen production-head prefix.
 *
 * @param {object} input Captured, aggregate-only ledger evidence.
 * @returns {{kind:"baseline"}|{kind:"prefix",versions:string[]}|{kind:"final"}|{kind:"invalid",violations:string[]}}
 */
export function classifyOvd417Ledger(input = {}) {
  const violations = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { kind: "invalid", violations: ["ledger evidence must be an object"] };
  }
  if (input.sourceSha !== OVD417_SOURCE_SHA) {
    violations.push("source SHA drifted");
  }
  if (JSON.stringify(input.migrationHashes) !== JSON.stringify(OVD417_MIGRATION_HASHES)) {
    violations.push("migration package hashes drifted");
  }
  if (input.baselineCount !== OVD417_PRODUCTION_LEDGER_COUNT) {
    violations.push(`baseline count must be ${OVD417_PRODUCTION_LEDGER_COUNT}`);
  }
  if (input.baselineHead !== OVD417_PRODUCTION_HEAD) {
    violations.push(`baseline head must be ${OVD417_PRODUCTION_HEAD}`);
  }
  if (input.baselineFingerprint !== OVD417_BASELINE_LEDGER_FINGERPRINT) {
    violations.push("baseline fingerprint drifted");
  }

  const packageVersionsProvided = Array.isArray(input.packageVersions);
  if (!packageVersionsProvided) {
    violations.push("package versions must be an array");
  }
  const versions = packageVersionsProvided ? input.packageVersions : [];
  if (!versions.every((version) => typeof version === "string")) {
    violations.push("package versions must be strings");
  }
  if (new Set(versions).size !== versions.length) {
    violations.push("package versions contain duplicates");
  }
  if (versions.length > OVD417_MIGRATION_VERSIONS.length) {
    violations.push("package versions contain an extra migration");
  }
  if (!versions.every((version, index) => version === OVD417_MIGRATION_VERSIONS[index])) {
    violations.push("package versions are not an exact ordered prefix");
  }
  if (input.unexpectedVersionCount !== 0) {
    violations.push("ledger contains an unexpected post-baseline migration");
  }

  if (packageVersionsProvided && versions.length <= OVD417_MIGRATION_VERSIONS.length) {
    const expectedLedger = OVD417_LEDGER_STATES[versions.length];
    if (input.ledgerCount !== expectedLedger.count) {
      violations.push(`ledger count must be ${expectedLedger.count}`);
    }
    if (input.ledgerHead !== expectedLedger.head) {
      violations.push(`ledger head must be ${expectedLedger.head}`);
    }
    if (input.ledgerFingerprint !== expectedLedger.fingerprint) {
      violations.push("ledger fingerprint drifted");
    }
  }

  if (violations.length > 0) {
    return { kind: "invalid", violations };
  }
  if (versions.length === 0) {
    return { kind: "baseline" };
  }
  if (versions.length === OVD417_MIGRATION_VERSIONS.length) {
    return { kind: "final" };
  }
  return { kind: "prefix", versions };
}

/**
 * Applies the state-specific admission rule used by qualification and recovery.
 * Partial state is always a worker-promotion block.
 *
 * @param {ReturnType<typeof classifyOvd417Ledger>} classification
 * @param {"baseline"|"partial-one"|"recoverable"|"final"} requiredState
 * @returns {string[]}
 */
export function validateOvd417LedgerState(classification, requiredState) {
  if (!ALLOWED_STATES.has(requiredState)) {
    return [`unknown required state: ${requiredState}`];
  }
  if (classification.kind === "invalid") {
    return classification.violations;
  }
  if (requiredState === "baseline" && classification.kind !== "baseline") {
    return ["expected the untouched production-head ledger"];
  }
  if (
    requiredState === "partial-one"
    && !(classification.kind === "prefix" && classification.versions.length === 1)
  ) {
    return ["expected failure containment immediately after the first migration"];
  }
  if (
    requiredState === "recoverable"
    && !(classification.kind === "baseline" || classification.kind === "prefix")
  ) {
    return ["expected a baseline or exact partial prefix for recovery"];
  }
  if (requiredState === "final" && classification.kind !== "final") {
    return ["worker promotion remains blocked until all four migrations are present"];
  }
  return [];
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--ledger-json") {
      options.ledgerPath = path.resolve(args[++index]);
    } else if (argument === "--require-state") {
      options.requiredState = args[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.ledgerPath || !options.requiredState) {
    throw new Error(
      "Usage: node scripts/verify-ovd417-applied-prefix.mjs --ledger-json <path> --require-state <baseline|partial-one|recoverable|final>",
    );
  }
  const input = JSON.parse(await readFile(options.ledgerPath, "utf8"));
  const classification = classifyOvd417Ledger(input);
  const violations = validateOvd417LedgerState(classification, options.requiredState);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`OVD-417 ledger verification passed: ${classification.kind}.`);
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(`OVD-417 ledger verification stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
