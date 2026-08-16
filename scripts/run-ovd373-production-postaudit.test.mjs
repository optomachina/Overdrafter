import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/run-ovd373-production-postaudit.sh");
const source = readFileSync(scriptPath, "utf8");

describe("OVD-373 production post-audit runner", () => {
  it("is read-only with respect to schema and migration history", () => {
    expect(source).not.toContain("db push");
    expect(source).not.toContain("migration repair");
    expect(source).not.toContain("secrets set");
    expect(source).not.toMatch(/\b(insert|update|delete|alter|create|drop)\b/i);
  });

  it("pins the exact target, source, CLI, credentials, and fresh evidence path", () => {
    expect(source).toContain('OVD373_EXPECTED_PROJECT_REF="ozuatdcakezjtevztjlr"');
    expect(source).toContain('OVD373_EXPECTED_CLI_VERSION="2.78.1"');
    expect(source).toContain('[[ "$(git rev-parse HEAD)" == "$OVD361_DEPLOY_COMMIT" ]]');
    expect(source).toContain('[[ -z "$(git status --porcelain)" ]]');
    expect(source).toContain("require_private_file");
    expect(source).toContain("Refusing to replace existing post-audit schema evidence.");
  });

  it("holds rollout locks through every production proof", () => {
    expect(source).toContain("hold-ovd373-production-locks.sql");
    expect(source).toContain("run-ovd373-locked-command.sh");
    expect(source).toContain("verify-ovd373-rollout-preconditions.sql");
    expect(source).toContain("verify-ovd373-temporary-role.sql");
    expect(source).toContain("verify-ovd373-production-postconditions.sql");
    expect(source).toContain("verify-ovd373-schema-fingerprint.mjs");
    expect(source).toContain("verify-ovd373-billing-disabled.mjs");
    expect(source).toContain("require_lock_holder");
  });

  it("captures only schema metadata and never reads customer rows", () => {
    expect(source).toContain("--schema-only");
    expect(source).toContain("--schema public --schema private");
    expect(source).not.toContain("--data-only");
    expect(source).not.toMatch(/auth\.users|storage\.objects|public\.(jobs|job_files|quote_requests)/);
  });
});
