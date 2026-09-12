import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAgentContract } from "./validate-agent-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("current agent contract is internally consistent", () => {
  assert.deepEqual(validateAgentContract(repoRoot), []);
});

test("obsolete complexity approval and workflow settings are rejected", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-contract-"));
  try {
    for (const file of ["AGENTS.md", "CLAUDE.md", "WORKFLOW.md"]) {
      fs.copyFileSync(path.join(repoRoot, file), path.join(temp, file));
    }
    fs.appendFileSync(path.join(temp, "AGENTS.md"), "\nHigh-complexity override\n");
    fs.appendFileSync(path.join(temp, "WORKFLOW.md"), "\ngpt-5.3-codex\n");
    const errors = validateAgentContract(temp);
    assert.ok(errors.some((error) => error.includes("obsolete gate")));
    assert.ok(errors.some((error) => error.includes("obsolete model")));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
