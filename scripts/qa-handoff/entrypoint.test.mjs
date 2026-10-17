// @vitest-environment node
// OVD-865: the CLI entry guard must run main() however node was pointed at the
// file. Node resolves symlinks in import.meta.url but not in process.argv[1], so
// a plain URL compare skipped main() through any symlinked path and the gate
// printed nothing and exited 0, which reads as a pass.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInvokedDirectly } from "./run.mjs";

const qaHandoffDir = fileURLToPath(new URL(".", import.meta.url));
const runPath = fileURLToPath(new URL("./run.mjs", import.meta.url));
const runUrl = new URL("./run.mjs", import.meta.url).href;

let scratch;
let linkedDir;
let linkedFile;
let danglingLink;

beforeAll(() => {
  // tmpdir() is itself a symlink on macOS (/var -> /private/var), so the
  // scratch paths below are symlinked even before the explicit links.
  scratch = mkdtempSync(join(tmpdir(), "qa-handoff-entry-"));
  linkedDir = join(scratch, "linked-dir");
  linkedFile = join(scratch, "linked-run.mjs");
  danglingLink = join(scratch, "dangling.mjs");
  symlinkSync(qaHandoffDir, linkedDir, "dir");
  symlinkSync(runPath, linkedFile, "file");
  symlinkSync(join(scratch, "does-not-exist.mjs"), danglingLink, "file");
  writeFileSync(join(scratch, "other.mjs"), "export {};\n");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("isInvokedDirectly", () => {
  it("is true for the module's own path", () => {
    expect(isInvokedDirectly(runPath, runUrl)).toBe(true);
    expect(isInvokedDirectly(realpathSync(runPath), runUrl)).toBe(true);
  });

  it("is true through a symlinked directory, a symlinked file and a relative path", () => {
    expect(isInvokedDirectly(join(linkedDir, "run.mjs"), runUrl)).toBe(true);
    expect(isInvokedDirectly(linkedFile, runUrl)).toBe(true);
    expect(isInvokedDirectly(join(scratch, "linked-dir", "..", "linked-run.mjs"), runUrl)).toBe(true);
  });

  it("is false when argv[1] is missing", () => {
    expect(isInvokedDirectly(undefined, runUrl)).toBe(false);
    expect(isInvokedDirectly("", runUrl)).toBe(false);
  });

  it("is false when argv[1] cannot be resolved", () => {
    expect(isInvokedDirectly(join(scratch, "does-not-exist.mjs"), runUrl)).toBe(false);
    expect(isInvokedDirectly(danglingLink, runUrl)).toBe(false);
  });

  it("is false when the module url cannot be resolved", () => {
    expect(isInvokedDirectly(runPath, "not a url")).toBe(false);
    expect(isInvokedDirectly(runPath, new URL("./missing.mjs", import.meta.url).href)).toBe(false);
  });

  it("is false for a different file", () => {
    expect(isInvokedDirectly(join(scratch, "other.mjs"), runUrl)).toBe(false);
  });
});

// Run the real CLI as a child process. No token and no network are involved:
// both probes fail in argument handling, which is what makes the output
// distinguishable from a skipped main().
function runCli({ script, cwd }, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("CLI entry point", () => {
  // The relative form is how the workflow and macmini-backstop.sh start the CLI.
  const repoRoot = join(qaHandoffDir, "..", "..");
  const invocations = [
    ["a relative path", () => ({ script: "scripts/qa-handoff/run.mjs", cwd: repoRoot })],
    ["an absolute path", () => ({ script: runPath, cwd: scratch })],
    ["a symlinked directory", () => ({ script: join(linkedDir, "run.mjs"), cwd: scratch })],
    ["a relative path through a symlinked directory", () => ({ script: "linked-dir/run.mjs", cwd: scratch })],
    ["a symlinked file", () => ({ script: linkedFile, cwd: scratch })],
  ];

  describe.each(invocations)("through %s", (_label, target) => {
    it("reports a usage error and exits 2", () => {
      const result = runCli(target(), ["--mode", "report"]);
      expect(result.stderr).toContain("qa-handoff: --repo owner/name is required");
      expect(result.status).toBe(2);
    });

    it("reports a missing token and exits 2", () => {
      const result = runCli(target(), ["--repo", "owner/name", "--mode", "report"]);
      expect(result.stderr).toContain("qa-handoff: GITHUB_TOKEN or GH_TOKEN is required");
      expect(result.status).toBe(2);
    });
  });
});
