import { isDeepStrictEqual } from "node:util";
import {
  OVD417_MIGRATION_HASHES,
  OVD417_MIGRATION_VERSIONS,
  OVD417_SOURCE_SHA,
} from "./verify-ovd417-applied-prefix.mjs";

export const OVD418_PRODUCTION_CONTINUITY = Object.freeze({
  ovd373Prefix: Object.freeze({ count: 99, head: "20260816015500", fingerprint: "003aabeb74c993bd942f5d59b29855ac" }),
  ovd373OriginalSubset: Object.freeze({ count: 74, fingerprint: "7aeeca99fe188de2b537f14dd9c068fa" }),
  row100: Object.freeze({ version: "20260817054500", statementHash: "6529bf2c47a30ea1fe72a710cb279246" }),
});

export const OVD418_SUFFIX_STATEMENT_HASHES = Object.freeze([
  Object.freeze({ version: "20260817133902", statementHash: "a677a4b306432cd85c225d98636c94ff" }),
  Object.freeze({ version: "20260821223849", statementHash: "81623dd84a77346330a2d19bf7ebaef7" }),
  Object.freeze({ version: "20260821223851", statementHash: "0672fc05ac550161f3d8e38456733dd2" }),
  Object.freeze({ version: "20260822213330", statementHash: "0106d03b4a0f9df99d670294d7c3d405" }),
]);

export const OVD418_PRODUCTION_LEDGER_STATES = Object.freeze([
  Object.freeze({ count: 100, head: "20260817054500", fingerprint: "cbfe91f6f12e00e514b12a22f9fd65fc" }),
  Object.freeze({ count: 101, head: "20260817133902", fingerprint: "afd38476b7e3e36d482511dda800697b" }),
  Object.freeze({ count: 102, head: "20260821223849", fingerprint: "426163fe8a2018efdcb2f68d2313cd5c" }),
  Object.freeze({ count: 103, head: "20260821223851", fingerprint: "890880853621b1fb13672ccb53ac4848" }),
  Object.freeze({ count: 104, head: "20260822213330", fingerprint: "28b8ae8752e5beb8e91505a2becfde86" }),
]);

const sameJson = (left, right) => isDeepStrictEqual(left, right);

function inspectExactPrefix(value, expected, label, violations) {
  if (!Array.isArray(value)) {
    violations.push(`${label} must be an array`);
    return [];
  }
  if (value.length > expected.length) violations.push(`${label} contain an extra migration`);
  if (!value.every((entry, index) => sameJson(entry, expected[index]))) {
    violations.push(`${label} are not an exact ordered prefix`);
  }
  return value;
}

/** Appends exact baseline and observed-state mismatches without changing violation order. */
function inspectLedgerState(evidence, versions, violations) {
  const baseline = OVD418_PRODUCTION_LEDGER_STATES[0];
  const expectedState = OVD418_PRODUCTION_LEDGER_STATES[versions.length];
  if (evidence.baselineCount !== baseline.count) violations.push(`baseline count must be ${baseline.count}`);
  if (evidence.baselineHead !== baseline.head) violations.push(`baseline head must be ${baseline.head}`);
  if (evidence.baselineFingerprint !== baseline.fingerprint) violations.push("production baseline fingerprint drifted");
  if (!expectedState || evidence.ledgerCount !== expectedState.count) violations.push(`ledger count must be ${expectedState?.count ?? "a supported value"}`);
  if (!expectedState || evidence.ledgerHead !== expectedState.head) violations.push(`ledger head must be ${expectedState?.head ?? "a supported value"}`);
  if (!expectedState || evidence.ledgerFingerprint !== expectedState.fingerprint) violations.push("production ledger fingerprint drifted");
}

/** Classifies aggregate-only evidence against the production-derived OVD-418 ledger contract. */
export function classifyOvd418ProductionLedger(evidence = {}) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { kind: "invalid", violations: ["ledger evidence must be an object"] };
  }
  const violations = [];
  if (evidence.sourceSha !== OVD417_SOURCE_SHA) violations.push("source SHA drifted");
  if (!sameJson(evidence.migrationHashes, OVD417_MIGRATION_HASHES)) violations.push("migration package hashes drifted");
  if (!sameJson(evidence.productionContinuity, OVD418_PRODUCTION_CONTINUITY)) violations.push("production continuity drifted");
  const versions = inspectExactPrefix(evidence.packageVersions, OVD417_MIGRATION_VERSIONS, "package versions", violations);
  inspectExactPrefix(evidence.packageStatementHashes, OVD418_SUFFIX_STATEMENT_HASHES, "package statement hashes", violations);
  if (Array.isArray(evidence.packageVersions) && Array.isArray(evidence.packageStatementHashes)
      && evidence.packageVersions.length !== evidence.packageStatementHashes.length) {
    violations.push("package versions and statement hashes have different lengths");
  }
  if (evidence.unexpectedVersionCount !== 0) violations.push("ledger contains an unexpected post-baseline migration");

  inspectLedgerState(evidence, versions, violations);

  if (violations.length > 0) return { kind: "invalid", violations };
  if (versions.length === 0) return { kind: "baseline" };
  if (versions.length === OVD417_MIGRATION_VERSIONS.length) return { kind: "final" };
  return { kind: "prefix", versions };
}

export { OVD417_MIGRATION_HASHES, OVD417_MIGRATION_VERSIONS, OVD417_SOURCE_SHA };
