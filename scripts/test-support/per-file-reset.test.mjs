// @vitest-environment node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// vite.config.ts runs the suite with isolate: false and per-file-reset.setup.mjs.
// Run two fixture files in one worker, the first leaving state behind, and
// check the second sees none of it.
test("per-file reset keeps state from crossing a file boundary with isolation off", () => {
  const config = resolve("scripts/test-support/fixtures/per-file-reset/vitest.config.mjs");
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", config, "--reporter=verbose"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", OVD_PER_FILE_RESET_WARNING_LISTENERS: String(process.listenerCount("warning")) },
    timeout: 60_000,
  });
  const output = result.stdout + result.stderr;
  expect(result.status, output).toBe(0);
  expect(output).toMatch(/Test Files\s+2 passed/);
  expect(output).toMatch(/Tests\s+3 passed/);
}, 90_000);
