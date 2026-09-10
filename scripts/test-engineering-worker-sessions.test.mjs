// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const runner = path.resolve("scripts/test-engineering-worker-sessions.mjs");

describe("worker session test runner admission", () => {
  it("refuses an output-path argument before accessing Docker or overwriting a file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ovd498-cli-"));
    const destination = path.join(directory, "preserve.json");
    try {
      await writeFile(destination, "preserve this fixture");
      // Empty PATH ensures this regression never reaches a real Docker daemon.
      const result = await exec(process.execPath,
        [runner, "supabase_db_ovd498-worker-sessions", destination],
        { env: { ...process.env, PATH: directory } }).catch((error) => error);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Pass exactly one disposable local OVD-498 container");
      expect(result.stderr).not.toContain("spawn docker");
      expect(await readFile(destination, "utf8")).toBe("preserve this fixture");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a hosted connection string before accessing Docker", async () => {
    const result = await exec(process.execPath, [runner, "postgres://example.test/database"],
      { env: { ...process.env, PATH: "" } }).catch((error) => error);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Pass exactly one disposable local OVD-498 container");
    expect(result.stderr).not.toContain("spawn docker");
  });
});
