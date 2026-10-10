// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const quoteSuite = "scripts/api-request-quote.test.mjs";
const liveSuite = "worker/src/adapters/fictiv.live.test.ts";
const portableSuites = [
  "scripts/catalog-parity-diff.node-test.mjs",
  "scripts/prepare-sourcing-schema-restore.node-test.mjs",
  "scripts/native/runner-containment/closed-journal.node-test.mjs",
];

function portableCommand() {
  const command = packageJson.scripts["test:portable-node"];
  const tokens = command.trim().split(/\s+/);
  expect(tokens.slice(0, 2)).toEqual(["node", "--test"]);
  // An explicit allowlist excludes globs, shell operators, and DB/native/provider runners.
  expect(tokens.slice(2).sort()).toEqual([...portableSuites].sort());
  return command;
}

// Listing files does not load test modules or initiate database/provider work.
function listTestFiles(flags = {}) {
  const env = { ...process.env };
  delete env.RUN_QUOTE_INTEGRATION_TESTS;
  delete env.RUN_FICTIV_LIVE_TEST;
  return execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "list", "--filesOnly"], {
    cwd: repoRoot,
    env: { ...env, ...flags },
    encoding: "utf8",
    timeout: 20_000,
  }).trim().split(/\r?\n/);
}

describe("explicit test execution lanes", () => {
  it("requires the portable Node allowlist in root verification and the CI test job", () => {
    portableCommand();
    expect(packageJson.scripts.verify.split("&&").map((step) => step.trim()))
      .toEqual(expect.arrayContaining(["npm run test:portable-node", "npm run test:agent-control-plane"]));
    const lines = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").split("\n");
    const start = lines.indexOf("  test:");
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:/.test(line));
    const testJob = lines.slice(start, end < 0 ? undefined : end).join("\n");
    expect(testJob).toMatch(/^        run: npm run test:portable-node\s*$/m);
    expect(testJob).toMatch(/^        run: npm run test:agent-control-plane\s*$/m);
    const portableStep = testJob.split(/^      - /m)
      .find((step) => /^        run: npm run test:portable-node\s*$/m.test(step));
    expect(portableStep).not.toMatch(/^        (?:continue-on-error|if):/m);
    expect(testJob).not.toMatch(/^    continue-on-error:/m);
  });

  it.each([null, ...portableSuites])("runs every portable suite and propagates failure from %s", (failedSuite) => {
    const command = portableCommand();
    const root = mkdtempSync(join(tmpdir(), "portable-node-gate-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        private: true, scripts: { "test:portable-node": command },
      }));
      for (const suite of portableSuites) {
        mkdirSync(dirname(join(root, suite)), { recursive: true });
        writeFileSync(join(root, suite), `import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
test('synthetic portable contract', () => {
  writeFileSync(${JSON.stringify(join(root, `${portableSuites.indexOf(suite)}.ran`))}, 'ran');
  assert.equal(${JSON.stringify(suite === failedSuite)}, false);
});\n`);
      }
      const result = spawnSync("npm", ["run", "test:portable-node"], {
        cwd: root, encoding: "utf8", timeout: 20_000,
        env: { ...process.env, npm_config_offline: "true", npm_config_update_notifier: "false" },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(failedSuite === null ? 0 : 1);
      for (const [index] of portableSuites.entries()) {
        expect(readFileSync(join(root, `${index}.ran`), "utf8")).toBe("ran");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps database and live-provider suites out of default discovery", () => {
    const files = listTestFiles();
    expect(files).toContain("scripts/ovd420-recovery-egress-contract.test.mjs");
    expect(files).toContain("scripts/provider-check.test.mjs");
    expect(files).not.toContain(quoteSuite);
    expect(files.some((file) => file.endsWith(".live.test.ts"))).toBe(false);
  }, 30_000);

  it("admits quote integration without admitting live-provider tests", () => {
    const files = listTestFiles({ RUN_QUOTE_INTEGRATION_TESTS: "1" });
    expect(files).toContain(quoteSuite);
    expect(files).not.toContain(liveSuite);
    expect(packageJson.scripts["test:integration:quote"]).toBe(
      "RUN_QUOTE_INTEGRATION_TESTS=1 vitest run " + quoteSuite,
    );
  }, 30_000);

  it("requires the live flag independently of quote integration", () => {
    const files = listTestFiles({ RUN_FICTIV_LIVE_TEST: "1" });
    expect(files).toContain(liveSuite);
    expect(files).not.toContain(quoteSuite);
    expect(packageJson.scripts["test:live:fictiv"]).toBe(
      "RUN_FICTIV_LIVE_TEST=1 vitest run " + liveSuite,
    );
  }, 30_000);

  it("retains the provider gate and includes the omitted payment safety suite", () => {
    expect(packageJson.scripts.verify).toContain("npm run provider:check");
    expect(packageJson.scripts["test:functions"]).toContain(
      "supabase/functions/create-payment-intent/index.test.ts",
    );
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).toContain("run: npm run test:integration:quote");
    expect(ci).toContain("ovd420-recovery-egress-network:");
    expect(ci).toContain('needs.ovd420-recovery-egress-network.result');
  });
});
