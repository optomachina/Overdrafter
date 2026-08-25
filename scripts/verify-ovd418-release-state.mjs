import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyOvd417Ledger,
  validateOvd417LedgerState,
} from "./verify-ovd417-applied-prefix.mjs";

const ADMITTED_REQUIRED_STATES = new Set(["baseline", "partial-one", "final"]);

function promotionBlock(message) {
  return `OVD-418 promotion remains blocked; incident review required: ${message}`;
}

/**
 * Applies the OVD-418 release gate to OVD-417's frozen ledger classification.
 * It deliberately does not admit OVD-417's broader recoverable state.
 *
 * @param {unknown} evidence Aggregate-only OVD-417 ledger evidence.
 * @param {string} requiredState Exact OVD-418 checkpoint expected by the caller.
 * @returns {{ok:true,kind:"baseline"|"prefix"|"final"}|{ok:false,violations:string[]}}
 */
export function verifyOvd418ReleaseState(evidence, requiredState) {
  if (!ADMITTED_REQUIRED_STATES.has(requiredState)) {
    return {
      ok: false,
      violations: [promotionBlock(`unknown required state: ${String(requiredState)}`)],
    };
  }

  const classification = classifyOvd417Ledger(evidence);
  if (classification.kind === "invalid") {
    return {
      ok: false,
      violations: classification.violations.map((violation) => promotionBlock(violation)),
    };
  }

  if (classification.kind === "prefix" && classification.versions.length > 1) {
    const state = classification.versions.length === 2 ? "partial-two" : "partial-three";
    return {
      ok: false,
      violations: [promotionBlock(`observed exact ${state} ledger state`)],
    };
  }

  const violations = validateOvd417LedgerState(classification, requiredState);
  if (violations.length > 0) {
    return { ok: false, violations: violations.map(promotionBlock) };
  }
  return { ok: true, kind: classification.kind };
}

/** Reads one local regular-file JSON evidence payload and rejects symlinks/devices. */
export async function readRegularJsonEvidence(evidencePath) {
  const stats = await lstat(evidencePath);
  if (!stats.isFile()) {
    throw new Error("ledger evidence must be a local regular file");
  }
  return JSON.parse(await readFile(evidencePath, "utf8"));
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--ledger-json" && value) {
      options.ledgerPath = path.resolve(value);
      index += 1;
    } else if (argument === "--require-state" && value) {
      options.requiredState = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.ledgerPath || !options.requiredState) {
    throw new Error(
      "Usage: node scripts/verify-ovd418-release-state.mjs --ledger-json <local-regular-json-file> --require-state <baseline|partial-one|final>",
    );
  }

  const evidence = await readRegularJsonEvidence(options.ledgerPath);
  const result = verifyOvd418ReleaseState(evidence, options.requiredState);
  if (!result.ok) {
    result.violations.forEach((violation) => console.error(`- ${violation}`));
    process.exitCode = 1;
    return;
  }
  console.log(`OVD-418 release-state verification passed: ${result.kind}.`);
}

const direct = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (direct) {
  try {
    await main();
  } catch (error) {
    console.error(`OVD-418 release-state verification stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
