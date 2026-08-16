import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_PUSH_MIGRATION_VERSIONS,
  classifyAppliedMigrationPrefix,
} from "./verify-ovd373-applied-prefix.mjs";

const scriptPath = path.resolve(process.cwd(), "scripts/verify-ovd373-applied-prefix.mjs");

function runVerifier(input) {
  return execFileSync(process.execPath, [scriptPath], { encoding: "utf8", input });
}

describe("OVD-373 applied migration prefix", () => {
  it("classifies an empty result as zero committed migrations", () => {
    expect(classifyAppliedMigrationPrefix("\n")).toEqual({ kind: "zero" });
  });

  it("accepts only the exact ordered reviewed prefix", () => {
    const versions = EXPECTED_PUSH_MIGRATION_VERSIONS.slice(0, 3);
    expect(classifyAppliedMigrationPrefix(versions.join("\n"))).toEqual({
      kind: "prefix",
      versions,
    });
  });

  it.each([
    ["gap", [EXPECTED_PUSH_MIGRATION_VERSIONS[0], EXPECTED_PUSH_MIGRATION_VERSIONS[2]]],
    ["reordered", EXPECTED_PUSH_MIGRATION_VERSIONS.slice(0, 2).reverse()],
    ["duplicate", [EXPECTED_PUSH_MIGRATION_VERSIONS[0], EXPECTED_PUSH_MIGRATION_VERSIONS[0]]],
    ["unexpected", ["20260816020000"]],
  ])("rejects a %s result", (_label, versions) => {
    expect(classifyAppliedMigrationPrefix(versions)).toEqual({ kind: "invalid" });
  });

  it("reads an empty migration result from stdin", () => {
    expect(runVerifier("\n")).toBe("zero\n");
  });

  it("reads an exact migration prefix from stdin", () => {
    const versions = EXPECTED_PUSH_MIGRATION_VERSIONS.slice(0, 2);
    expect(runVerifier(versions.join("\n"))).toBe(`prefix:${versions.join(",")}\n`);
  });

  it("rejects a non-prefix supplied through stdin", () => {
    expect(() => runVerifier("20260816020000\n")).toThrow();
  });
});
