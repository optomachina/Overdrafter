import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("OVD-376 frozen-head retirement", () => {
  it("retires the temporary gate from root verification and required CI", async () => {
    const packageJson = JSON.parse(await readRepositoryFile("package.json"));
    const ciWorkflow = await readRepositoryFile(".github/workflows/ci.yml");

    for (const command of [
      "npm run verify:migration-lineage",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npm run verify:worker",
    ]) {
      expect(packageJson.scripts.verify).toContain(command);
    }
    expect(packageJson.scripts.verify).not.toContain("verify:ovd372-head");
    expect(packageJson.scripts["verify:ovd372-head"]).toBe(
      "node ./scripts/verify-ovd372-pending-head.mjs",
    );
    expect(ciWorkflow).not.toContain("Verify frozen OVD-372 migration head");
    expect(ciWorkflow).not.toMatch(
      /verify:ovd372-head|verify-ovd372-pending-head\.mjs/,
    );
  });

  it("preserves the frozen-head evidence and records the completed retirement", async () => {
    const [verifier, verifierTest, manifest, runbook] = await Promise.all([
      readRepositoryFile("scripts/verify-ovd372-pending-head.mjs"),
      readRepositoryFile("scripts/verify-ovd372-pending-head.test.mjs"),
      readRepositoryFile("docs/release/ovd-372-pending-head-manifest.json"),
      readRepositoryFile("docs/workflows/ovd361-production-deployment.md"),
    ]);

    expect(verifier).toContain("OVD-372 pending-head verification passed.");
    expect(verifierTest).toContain("OVD-372 pending-head manifest");
    expect(JSON.parse(manifest).schemaVersion).toBe(1);
    expect(runbook).toContain("Retirement was completed on August 17, 2026 under OVD-376");
    expect(runbook).toContain("Root verification and required CI");
    expect(runbook).toContain("standalone npm target, verifier");
  });
});
