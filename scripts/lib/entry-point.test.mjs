// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let scratch;
let probe;
let helperUrl;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovd950-entry-"));
  const real = join(scratch, "real");
  mkdirSync(join(real, "lib"), { recursive: true });
  copyFileSync(new URL("./entry-point.mjs", import.meta.url), join(real, "lib", "entry-point.mjs"));
  helperUrl = pathToFileURL(join(real, "lib", "entry-point.mjs")).href;
  probe = join(real, "probe.mjs");
  writeFileSync(probe, `import { unlinkSync } from "node:fs";
import { isEntryPoint } from "./lib/entry-point.mjs";
if (process.env.UNLINK_SELF === "1") unlinkSync(process.argv[1]);
if (isEntryPoint(import.meta.url)) console.log("MAIN_RAN");
`);
  symlinkSync(real, join(scratch, "link"), "dir");
  symlinkSync(probe, join(scratch, "probe.mjs"), "file");
  symlinkSync(join(scratch, "probe.mjs"), join(scratch, "chain.mjs"), "file");
  symlinkSync(join(scratch, "missing.mjs"), join(scratch, "dangling.mjs"), "file");
  mkdirSync(join(scratch, "other"));
  writeFileSync(join(scratch, "other", "probe.mjs"), "export {};\n");
  writeFileSync(join(scratch, "other.mjs"), "export {};\n");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args, env = {}) {
  return spawnSync(process.execPath, args, { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 30_000 });
}
function expectResult(result, mainRan) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.includes("MAIN_RAN")).toBe(mainRan);
}

describe("isEntryPoint", () => {
  it.each([
    ["absolute symlinked directory", () => join(scratch, "link", "probe.mjs")],
    ["symlinked file", () => join(scratch, "probe.mjs")],
    ["symlink chain", () => join(scratch, "chain.mjs")],
    ["relative symlinked directory", () => "link/probe.mjs"],
    ["normalized relative symlinked file", () => "link/../probe.mjs"],
    ["plain real path", () => probe],
  ])("runs main through %s", (_name, entry) => {
    expectResult(run([entry()]), true);
  });

  it("does not run main on dynamic import", () => {
    expectResult(run(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(scratch, "link", "probe.mjs")).href)})`]), false);
  });

  it.each([
    ["missing argv1", () => `isEntryPoint(${JSON.stringify(pathToFileURL(probe).href)})`],
    ["empty argv1", () => `isEntryPoint(${JSON.stringify(pathToFileURL(probe).href)}, "")`],
    ["bad URL", () => `isEntryPoint("not a url", ${JSON.stringify(probe)})`],
    ["missing module", () => `isEntryPoint(${JSON.stringify(pathToFileURL(join(scratch, "absent.mjs")).href)}, ${JSON.stringify(probe)})`],
    ["unresolvable argv1", () => `isEntryPoint(${JSON.stringify(pathToFileURL(probe).href)}, ${JSON.stringify(join(scratch, "missing.mjs"))})`],
    ["dangling link", () => `isEntryPoint(${JSON.stringify(pathToFileURL(probe).href)}, ${JSON.stringify(join(scratch, "dangling.mjs"))})`],
    ["different file with same basename", () => `isEntryPoint(${JSON.stringify(pathToFileURL(probe).href)}, ${JSON.stringify(join(scratch, "other", "probe.mjs"))})`],
    ["different file with different basename", () => `isEntryPoint(${JSON.stringify(pathToFileURL(probe).href)}, ${JSON.stringify(join(scratch, "other.mjs"))})`],
  ])("returns false for %s", (_name, expression) => {
    expectResult(run(["--input-type=module", "-e", `import { isEntryPoint } from ${JSON.stringify(helperUrl)}; if (${expression()}) console.log("MAIN_RAN");`]), false);
  });

  it("refuses silent success when the entry link disappears", () => {
    const result = run([join(scratch, "probe.mjs")], { UNLINK_SELF: "1" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(70);
    expect(result.stdout).not.toContain("MAIN_RAN");
    expect(result.stderr).toContain("ENTRY_POINT_MISMATCH");
  });
});
