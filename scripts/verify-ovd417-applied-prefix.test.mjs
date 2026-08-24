import { describe, expect, it } from "vitest";
import {
  OVD417_BASELINE_LEDGER_FINGERPRINT,
  OVD417_LEDGER_STATES,
  OVD417_MIGRATION_HASHES,
  classifyOvd417Ledger,
  OVD417_MIGRATION_VERSIONS,
  OVD417_SOURCE_SHA,
  validateOvd417LedgerState,
} from "./verify-ovd417-applied-prefix.mjs";

function ledger(packageVersions = []) {
  const ledgerState = OVD417_LEDGER_STATES[packageVersions.length];
  return {
    sourceSha: OVD417_SOURCE_SHA,
    migrationHashes: OVD417_MIGRATION_HASHES,
    baselineCount: 100,
    baselineHead: "20260817054500",
    baselineFingerprint: OVD417_BASELINE_LEDGER_FINGERPRINT,
    packageVersions,
    unexpectedVersionCount: 0,
    ledgerCount: ledgerState.count,
    ledgerHead: ledgerState.head,
    ledgerFingerprint: ledgerState.fingerprint,
  };
}

describe("OVD-417 applied-prefix verifier", () => {
  it("accepts baseline, exact prefixes, and the final package", () => {
    expect(classifyOvd417Ledger(ledger())).toEqual({ kind: "baseline" });
    expect(classifyOvd417Ledger(ledger(OVD417_MIGRATION_VERSIONS.slice(0, 1)))).toEqual({
      kind: "prefix",
      versions: OVD417_MIGRATION_VERSIONS.slice(0, 1),
    });
    expect(classifyOvd417Ledger(ledger(OVD417_MIGRATION_VERSIONS))).toEqual({
      kind: "final",
    });
  });

  it.each([
    ["baseline count", { ...ledger(), baselineCount: 99 }],
    ["baseline head", { ...ledger(), baselineHead: "20260816015500" }],
    ["source SHA", { ...ledger(), sourceSha: "f".repeat(40) }],
    ["migration hash", { ...ledger(), migrationHashes: [] }],
    ["baseline fingerprint", { ...ledger(), baselineFingerprint: "f".repeat(32) }],
    ["ledger count", { ...ledger(), ledgerCount: 99 }],
    ["ledger head", { ...ledger(), ledgerHead: "20260816015500" }],
    ["ledger fingerprint", { ...ledger(), ledgerFingerprint: "f".repeat(32) }],
    ["missing package evidence", { ...ledger(), packageVersions: undefined }],
    ["gap", ledger([OVD417_MIGRATION_VERSIONS[1]])],
    ["reordering", ledger([OVD417_MIGRATION_VERSIONS[1], OVD417_MIGRATION_VERSIONS[0]])],
    ["duplicate", ledger([OVD417_MIGRATION_VERSIONS[0], OVD417_MIGRATION_VERSIONS[0]])],
    ["extra", { ...ledger(OVD417_MIGRATION_VERSIONS), unexpectedVersionCount: 1 }],
  ])("rejects %s drift", (_label, input) => {
    expect(classifyOvd417Ledger(input).kind).toBe("invalid");
  });

  it("rejects non-object ledger evidence", () => {
    expect(classifyOvd417Ledger(null)).toEqual({
      kind: "invalid",
      violations: ["ledger evidence must be an object"],
    });
  });

  it("blocks promotion for every partial package state", () => {
    const partial = classifyOvd417Ledger(
      ledger(OVD417_MIGRATION_VERSIONS.slice(0, 1)),
    );
    expect(validateOvd417LedgerState(partial, "partial-one")).toEqual([]);
    expect(validateOvd417LedgerState(partial, "recoverable")).toEqual([]);
    expect(validateOvd417LedgerState(partial, "final")).toContain(
      "worker promotion remains blocked until all four migrations are present",
    );
  });

  it("requires exactly the first migration for the injected-failure checkpoint", () => {
    const secondPrefix = classifyOvd417Ledger(
      ledger(OVD417_MIGRATION_VERSIONS.slice(0, 2)),
    );
    expect(validateOvd417LedgerState(secondPrefix, "partial-one")).toEqual([
      "expected failure containment immediately after the first migration",
    ]);
  });
});
