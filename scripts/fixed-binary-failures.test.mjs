// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { assertSupportedPlatform, readGitFile, resolveFixedBinary } from "./lib/fixed-binaries.mjs";
import { gitIgnored } from "./verify-skill-drift.mjs";
import { resolveBinary as verdictBinary } from "./emit-verdict.mjs";
import { resolveBinary as driftBinary } from "./verify-skill-drift.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const oid = "a".repeat(40);
const blobEntry = `100644 blob ${oid}\\ta\\000`;
const dirs = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); Object.defineProperty(process, "platform", platformDescriptor); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovd1117-")); dirs.push(dir); return dir;
}

// Every consumer of the consolidated resolver retains the same failure contract.
describe.each([
  ["emit-verdict", verdictBinary], ["verify-skill-drift", driftBinary],
])("%s fixed resolution", (_name, resolve) => {
  it("refuses Windows with the binary name and WSL instruction", () => {
    expect(() => resolve("gh", { platform: "win32" })).toThrow(/gh.*Windows.*WSL/);
  });
  it("throws for an empty binary directory", () => {
    expect(() => resolve("gh", { dirs: [fixture()] })).toThrow(/gh not found/);
  });
  it("does not turn a failing executable into a result", () => {
    const dir = fixture(); fs.writeFileSync(path.join(dir, "gh"), "#!/bin/sh\necho broken-gh >&2\nexit 1\n", { mode: 0o755 });
    expect(() => execFileSync(resolve("gh", { dirs: [dir] }), [], { stdio: "pipe" })).toThrow(/broken-gh/);
  });
});

it("git check-ignore distinguishes its real no from missing/failing git", () => {
  const dir = fixture();
  expect(() => gitIgnored(dir, "x", { binary: path.join(dir, "git") })).toThrow(/git.*ENOENT/);
  const binary = path.join(dir, "git");
  for (const [body, expected] of [["exit 1", false], ["exit 0", true], ["echo harmless-warning >&2\nexit 0", true], ["echo harmless-warning >&2\nexit 1", false]]) {
    fs.writeFileSync(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    expect(gitIgnored(dir, "x", { binary })).toBe(expected);
  }
  for (const [body, detail] of [["exit 128", /failed: exit 128$/], ["echo xcrun-error >&2\nexit 128", /failed: xcrun-error$/]]) {
    fs.writeFileSync(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    expect(() => gitIgnored(dir, "x", { binary })).toThrow(detail);
  }
});

it("git file readers return null only for a successful absent tree entry", () => {
  const dir = fixture(); const binary = path.join(dir, "git");
  expect(() => readGitFile(binary, dir, "HEAD", "a")).toThrow(/ENOENT/);
  for (const status of [1, 128]) {
    fs.writeFileSync(binary, `#!/bin/sh\necho broken-git >&2\nexit ${status}\n`, { mode: 0o755 });
    expect(() => readGitFile(binary, dir, "HEAD", "a")).toThrow(/broken-git/);
  }
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  expect(readGitFile(binary, dir, "HEAD", "a")).toBeNull();
  fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = ls-tree ]; then printf '${blobEntry}'; else echo broken-cat-file >&2; exit 1; fi\n`, { mode: 0o755 });
  expect(() => readGitFile(binary, dir, "HEAD", "a")).toThrow(/broken-cat-file/);
});

it("the shared resolver keeps missing binary errors explicit", () => {
  expect(() => resolveFixedBinary("git", { dirs: [fixture()] })).toThrow(/git not found/);
  expect(() => assertSupportedPlatform("win32", "docker")).toThrow(/docker.*WSL/);
});

// Exercise each previously swallowing file reader, rather than just its helper.
import { readRefFile, runLintCli } from "./lint-security-definer.mjs";
import { gitShow as rlsGitShow, loadAllInputs } from "./check-rls-deny-coverage.mjs";
import { gitShow } from "./check-migration-immutability.mjs";
import { gitShowReader } from "./validate-pr-body.mjs";
import { readRefFile as secretReadRefFile, refExists, mergeBase } from "./check-secret-paths.mjs";
describe.each([
  ["lint-security-definer / lint-rls-new-tables", (dir, binary) => readRefFile(dir, "HEAD", "a", { binary })],
  ["rls-deny-coverage", (dir, binary) => rlsGitShow(dir, "HEAD", "a", { binary })],
  ["check-migration-immutability", (dir, binary) => gitShow(dir, "HEAD", "a", { binary })],
  ["validate-pr-body", (dir, binary) => gitShowReader("HEAD", "HEAD", { cwd: dir, binary })("base", "a")],
  ["check-secret-paths file", (dir, binary) => secretReadRefFile(dir, "HEAD", "a", { binary })],
  ["check-secret-paths ref", (dir, binary) => refExists(dir, "HEAD", { binary })],
  ["check-secret-paths merge-base", (dir, binary) => mergeBase(dir, "a", "b", { binary })],
])("%s command errors", (_name, read) => {
  it("throws for a missing binary", () => {
    const dir = fixture(); expect(() => read(dir, path.join(dir, "git"))).toThrow(/git.*ENOENT/);
  });
  it.each([1, 128])("throws for git exit %s with diagnostics", (status) => {
    const dir = fixture(); const binary = path.join(dir, "git");
    fs.writeFileSync(binary, `#!/bin/sh\necho broken-git >&2\nexit ${status}\n`, { mode: 0o755 });
    expect(() => read(dir, binary)).toThrow(/broken-git/);
  });
});

// All readers must preserve the same absence, blob and platform contract.
const readers = [
  ["fixed-binaries", (dir, binary, ref = "HEAD", file = "absent") => readGitFile(binary, dir, ref, file)],
  ["rls-deny-coverage", (dir, binary, ref = "HEAD", file = "absent") => rlsGitShow(dir, ref, file, { binary })],
  ["security-definer", (dir, binary, ref = "HEAD", file = "absent") => readRefFile(dir, ref, file, { binary })],
  ["migration-immutability", (dir, binary, ref = "HEAD", file = "absent") => gitShow(dir, ref, file, { binary })],
  ["pr-body", (dir, binary, ref = "HEAD", file = "absent") => gitShowReader(ref, ref, { cwd: dir, binary })("base", file)],
  ["secret-paths", (dir, binary, ref = "HEAD", file = "absent") => secretReadRefFile(dir, ref, file, { binary })],
];
describe.each(readers)("%s absence and platform", (_name, read) => {
  it("returns null for a genuinely absent file in an existing commit", () => {
    expect(read(repoRoot, "/usr/bin/git")).toBeNull();
  });
  it("throws when cat-file fails after a successful tree probe", () => {
    const dir = fixture(); const binary = path.join(dir, "git");
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$1" = ls-tree ]; then printf '${blobEntry}'; else echo broken-cat-file >&2; exit 128; fi\n`, { mode: 0o755 });
    expect(() => read(dir, binary)).toThrow(/broken-cat-file/);
  });
  it("reads a tracked root file through real git from a subdirectory", () => {
    const expected = execFileSync("/usr/bin/git", ["show", "HEAD:AGENTS.md"], { cwd: repoRoot, encoding: "utf8" });
    expect(expected.length).toBeGreaterThan(0);
    expect(read(path.join(repoRoot, "docs"), "/usr/bin/git", "HEAD", "AGENTS.md")).toBe(expected);
  });
  it("rejects a real tree entry", () => {
    expect(() => read(path.join(repoRoot, "docs"), "/usr/bin/git", "HEAD", "scripts")).toThrow(/single blob/);
  });
  it.each(["tree", "commit", "malformed"])("rejects a %s entry before reading content", (type) => {
    const dir = fixture(); const binary = path.join(dir, "git");
    fs.writeFileSync(binary, `#!/bin/sh
if [ "$1" = ls-tree ]; then printf '160000 ${type} ${oid}\\tabsent\\000'; else echo unexpected-cat-file >&2; exit 128; fi
`, { mode: 0o755 });
    expect(() => read(dir, binary)).toThrow(/single blob/);
  });
  it("guards option-like refs and reads the OID returned by ls-tree", () => {
    const dir = fixture(); const binary = path.join(dir, "git");
    fs.writeFileSync(binary, `#!/bin/sh
if [ "$1" = ls-tree ]; then
  [ "$2" = --full-tree ] && [ "$3" = -z ] && [ "$4" = --end-of-options ] && [ "$5" = --ref ] && [ "$6" = -- ] && [ "$7" = ':(top,literal)a' ] || exit 128
  printf '${blobEntry}'
elif [ "$1" = cat-file ]; then
  [ "$2" = blob ] && [ "$3" = --end-of-options ] && [ "$4" = '${oid}' ] || exit 128
  printf 'blob content'
else exit 128
fi
`, { mode: 0o755 });
    expect(read(dir, binary, "--ref", "a")).toBe("blob content");
  });
  it("fails closed on a clean tree-probe exit 1", () => {
    const dir = fixture(); const binary = path.join(dir, "git");
    fs.writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(() => read(dir, binary)).toThrow();
  });
  it("throws on Windows when called", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(() => read(repoRoot, "/usr/bin/git")).toThrow(/git.*WSL/);
  });
});

it.each(["check-rls-deny-coverage", "merge-readback", "emit-verdict", "verify-skill-drift", "check-secret-paths", "check-migration-immutability", "lint-security-definer", "validate-pr-body", "lib/fixed-binaries"])("%s imports safely on Windows", (name) => {
  const url = new URL(`./${name}.mjs`, import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `Object.defineProperty(process, 'platform', { value: 'win32' }); await import(${JSON.stringify(url)});`], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
it.each([refExists, (cwd, ref, options) => mergeBase(cwd, ref, ref, options)])("ref probes reject Windows", (read) => {
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(() => read(repoRoot, "HEAD")).toThrow(/git.*WSL/);
});

it("ref probes treat a clean exit 1 as a missing ref or shared history", () => {
  const dir = fixture(); const binary = path.join(dir, "git");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(refExists(dir, "HEAD", { binary })).toBe(false);
  expect(mergeBase(dir, "base", "head", { binary })).toBeNull();
});

it("RLS listTree failures throw instead of returning an empty list", () => {
  expect(() => loadAllInputs(repoRoot, "refs/heads/ovd1117-nonexistent-ref")).toThrow(/Not a valid object name/);
});

it("security-definer base lookup failures stop linting", () => {
  const lintFiles = vi.fn(); const stderr = vi.fn();
  const rule = { name: "test-lint", baselinePath: "baseline.json", parseBaseline: JSON.parse, lintFiles };
  expect(runLintCli(rule, ["--root", fixture(), "--base-ref", "HEAD", "unused.sql"], { stderr })).toBe(2);
  expect(lintFiles).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("not a git repository"));
});
