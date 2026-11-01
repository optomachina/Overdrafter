// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertSha, buildVerdict, computeDiffId, computePatchId, formatComment, main, parsePatchIdOutput, postComment, resolveBinary, resolveGhBin, resolveInputFile } from "./emit-verdict.mjs";
import { extractVerdictBlocks, parseVerdictComments, validateVerdict } from "./verdict-schema.mjs";

let repo;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (file, content, message) => {
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};
/** Resolve a ref in the fixture repo; the tool itself only accepts SHAs. */
const sha = (ref) => git("rev-parse", "--verify", `${ref}^{commit}`);
const patchId = (base, head) => computePatchId({ base: sha(base), head: sha(head), cwd: repo });
const diffId = (base, head) => computeDiffId({ base: sha(base), head: sha(head), cwd: repo });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ovd851-verdict-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  commit("base.txt", "base\n", "base");
  git("checkout", "-q", "-b", "feature");
  commit("feature.txt", "feature line\n", "feature");
  git("checkout", "-q", "main");
  commit("unrelated.txt", "main moved\n", "main moves");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const NOW = new Date("2026-10-16T12:34:56.789Z");
const ARGS = () => [
  "--verdict", "PASS",
  "--base", sha("main"),
  "--head", sha("feature"),
  "--verifier-id", "astra-verifier",
  "--model-family", "opus",
  "--github-login", "verifier-bot",
  "--evidence", "verify-run=https://github.com/o/r/actions/runs/42",
  "--checks", "green",
  "--conflicts", "0",
  "--open-threads", "0",
];
/** ARGS() without the given flags (and their values). */
const argsWithout = (...flags) => ARGS().filter((_, i, all) => !flags.includes(all[i]) && !flags.includes(all[i - 1]));

describe("computePatchId", () => {
  it("is stable across a no-op rebase and changes when the diff changes", () => {
    const before = patchId("main", "feature");
    const oldHead = sha("feature");
    git("checkout", "-q", "feature");
    git("rebase", "-q", "main");
    const rebasedHead = git("rev-parse", "HEAD");
    expect(rebasedHead).not.toBe(oldHead);
    expect(patchId("main", "feature")).toBe(before);

    commit("feature.txt", "feature line changed\n", "amend diff");
    expect(patchId("main", "feature")).not.toBe(before);
    git("reset", "-q", "--hard", rebasedHead);
    git("checkout", "-q", "main");
  });

  it("changes when only indentation changes (--verbatim)", () => {
    git("checkout", "-q", "-b", "ws-a", "main");
    commit("ws.py", "if x:\n    y()\nz()\n", "dedented z");
    git("checkout", "-q", "-b", "ws-b", "main");
    commit("ws.py", "if x:\n    y()\n    z()\n", "indented z");
    git("checkout", "-q", "main");
    expect(patchId("main", "ws-a")).not.toBe(patchId("main", "ws-b"));
  });

  it("keeps the diff as bytes, so diffs differing only in invalid UTF-8 get different ids", () => {
    // 0x80 and 0xff are both invalid UTF-8 and both decode to U+FFFD, so a
    // string round trip would make these two diffs identical.
    git("checkout", "-q", "-b", "bytes-a", "main");
    commit("raw.dat", Buffer.from([0x70, 0x72, 0x65, 0x80, 0x73, 0x75, 0x66, 0x0a]), "invalid byte 0x80");
    git("checkout", "-q", "-b", "bytes-b", "main");
    commit("raw.dat", Buffer.from([0x70, 0x72, 0x65, 0xff, 0x73, 0x75, 0x66, 0x0a]), "invalid byte 0xff");
    git("checkout", "-q", "main");
    expect(git("rev-parse", "bytes-a:raw.dat")).not.toBe(git("rev-parse", "bytes-b:raw.dat"));
    expect(patchId("main", "bytes-a")).not.toBe(patchId("main", "bytes-b"));
  });

  it("is stable for the same invalid-UTF-8 diff on two different commits", () => {
    git("checkout", "-q", "-b", "bytes-c", "main");
    commit("raw.dat", Buffer.from([0x70, 0x72, 0x65, 0x80, 0x73, 0x75, 0x66, 0x0a]), "invalid byte 0x80 again");
    git("checkout", "-q", "main");
    expect(patchId("main", "bytes-c")).toBe(patchId("main", "bytes-a"));
  });

  it("does not depend on local diff config", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    git("checkout", "-q", "-b", "ctx-base", "main");
    commit("ctx.txt", `${lines.join("\n")}\n`, "ctx base");
    git("checkout", "-q", "-b", "ctx-head");
    commit("ctx.txt", `${lines.map((l, i) => (i === 4 || i === 12 ? `${l} changed` : l)).join("\n")}\n`, "ctx change");
    git("checkout", "-q", "main");
    const pinned = patchId("ctx-base", "ctx-head");
    const settings = [["diff.context", "1"], ["diff.interHunkContext", "10"], ["diff.algorithm", "patience"], ["diff.noprefix", "true"], ["diff.suppressBlankEmpty", "true"]];
    try {
      for (const [key, value] of settings) git("config", key, value);
      expect(patchId("ctx-base", "ctx-head")).toBe(pinned);
    } finally {
      for (const [key] of settings) git("config", "--unset", key);
    }
  });

  it("never lets base or head be read as a git option", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ovd851-inject-"));
    try {
      expect(() => computePatchId({ base: `--output=${join(outDir, "x")}`, head: sha("feature"), cwd: repo })).toThrow(/--base must be a full 40-character lowercase commit SHA/);
      expect(() => computePatchId({ base: sha("main"), head: `--output=${join(outDir, "y")}`, cwd: repo })).toThrow(/--head must be a full 40-character lowercase commit SHA/);
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("accepts only full lowercase 40-hex SHAs", () => {
    const valid = sha("feature");
    expect(assertSha(valid, "--base")).toBe(valid);
    const rejected = [
      "main", "origin/main", "HEAD", "HEAD~2", "main..feature",
      "a".repeat(39), "a".repeat(41), valid.slice(0, 39), `${valid}0`,
      "A".repeat(40), valid.toUpperCase().replace(/^./, "A"),
      "--output=/tmp/x", `--${"a".repeat(38)}`, `-${"a".repeat(39)}`,
      ` ${valid}`, `${valid}\n`, `${valid}^{commit}`, "", undefined, null, 7,
    ];
    for (const value of rejected) {
      expect(() => assertSha(value, "--base")).toThrow(/^--base must be a full 40-character lowercase commit SHA/);
    }
  });

  it("requires --base and --head as SHAs on the CLI and never resolves refs", () => {
    const run = (overrides) => () => main([...argsWithout("--base", "--head"), ...overrides], { cwd: repo, now: NOW });
    expect(run(["--head", sha("feature")])).toThrow(/--base must be a full 40-character lowercase commit SHA \(got null\)/);
    expect(run(["--base", sha("main")])).toThrow(/--head must be a full 40-character lowercase commit SHA \(got null\)/);
    for (const ref of ["main", "origin/main", "HEAD"]) {
      expect(run(["--base", ref, "--head", sha("feature")])).toThrow(/--base must be a full 40-character lowercase commit SHA/);
      expect(run(["--base", sha("main"), "--head", ref])).toThrow(/--head must be a full 40-character lowercase commit SHA/);
    }
    expect(run(["--base=--all", "--head", sha("feature")])).toThrow(/--base must be/);
    expect(run(["--base", sha("main"), "--head", "f".repeat(40)])).toThrow(/git could not verify --head f{40} as a commit/);
  });

  it("refuses an empty diff", () => {
    expect(() => patchId("main", "main")).toThrow(/empty diff/);
  });
});

describe("computePatchId ignores hunk positions", () => {
  // git patch-id drops the hunk headers and `index` lines, which is what keeps an
  // id stable across a rebase. The price, documented in docs/verdict-format.md:
  // the same edit at two positions with identical context shares an id, so a
  // patch_id only aids rebase reuse and never proves an identical change.
  /** Ten identical lines, with `text` inserted before line index `at` when given. */
  const lines = (at, text = "NEW") => {
    const out = Array.from({ length: 10 }, () => "x");
    if (at !== undefined) out.splice(at, 0, text);
    return `${out.join("\n")}\n`;
  };

  beforeAll(() => {
    git("checkout", "-q", "-b", "pos-base", "main");
    commit("pos.txt", lines(), "ten identical lines");
    git("checkout", "-q", "-b", "pos-4", "pos-base");
    commit("pos.txt", lines(3), "insert NEW at line 4");
    git("checkout", "-q", "-b", "pos-7", "pos-base");
    commit("pos.txt", lines(6), "insert NEW at line 7");
    git("checkout", "-q", "-b", "pos-other", "pos-base");
    commit("pos.txt", lines(3, "OTHER"), "insert OTHER at line 4");
    git("checkout", "-q", "main");
  });

  it("gives one id to the same edit at two positions with identical context", () => {
    expect(git("diff", "pos-base", "pos-4")).toContain("@@ -1,6 +1,7 @@");
    expect(git("diff", "pos-base", "pos-7")).toContain("@@ -4,6 +4,7 @@");
    expect(git("rev-parse", "pos-4^{tree}")).not.toBe(git("rev-parse", "pos-7^{tree}"));
    expect(patchId("pos-base", "pos-4")).toBe(patchId("pos-base", "pos-7"));
  });

  it("still gives a different id when the inserted text differs", () => {
    expect(patchId("pos-base", "pos-other")).not.toBe(patchId("pos-base", "pos-4"));
  });
});

describe("diff_id separates what patch_id cannot", () => {
  // git patch-id does not hash the `diff --git` line that follows a binary
  // patch, so a mode-only change after a binary file has no path in the id.
  const BIN = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]);
  beforeAll(() => {
    git("checkout", "-q", "-b", "bin-base", "main");
    writeFileSync(join(repo, "x.sh"), "echo x\n");
    writeFileSync(join(repo, "y.sh"), "echo y\n");
    git("add", "x.sh", "y.sh");
    git("commit", "-q", "-m", "scripts");
    for (const target of ["x.sh", "y.sh"]) {
      git("checkout", "-q", "-b", `bin-${target}`, "bin-base");
      writeFileSync(join(repo, "a.bin"), BIN);
      chmodSync(join(repo, target), 0o755);
      git("add", "a.bin", target);
      git("commit", "-q", "-m", `binary + chmod ${target}`);
    }
    git("checkout", "-q", "main");
  });

  it("gives different diff_ids where patch_id collides (binary, then chmod of a different file)", () => {
    expect(patchId("bin-base", "bin-x.sh")).toBe(patchId("bin-base", "bin-y.sh"));
    expect(diffId("bin-base", "bin-x.sh")).not.toBe(diffId("bin-base", "bin-y.sh"));
    expect(diffId("bin-base", "bin-x.sh")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the diff_id across a rebase onto a base that touched other paths", () => {
    expect(diffId("main", "feature")).toBe(diffId(git("merge-base", "main", "feature"), "feature"));
  });
});

describe("computePatchId with NUL bytes", () => {
  // git patch-id hashes each diff line with strlen(), so it ignores everything
  // after a line's first NUL. git decides text vs binary from the first 8000
  // bytes only, so a NUL at offset 9000 leaves the file text and --binary does
  // not encode it: the raw NUL reaches patch-id and the payload goes unhashed.
  const NUL_NAME = /diff contains a NUL byte, which git patch-id cannot hash/;
  const lateNul = (payload) => Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from(`\0${payload}\n`)]);
  const script = fileURLToPath(new URL("./emit-verdict.mjs", import.meta.url));

  beforeAll(() => {
    git("checkout", "-q", "-b", "nul-one", "main");
    commit("nul.txt", lateNul("PAYLOAD-ONE"), "text file with a late NUL, payload one");
    git("checkout", "-q", "-b", "nul-two", "main");
    commit("nul.txt", lateNul("PAYLOAD-TWO"), "text file with a late NUL, payload two");
    // NUL inside the first 8000 bytes: git classifies this as binary.
    git("checkout", "-q", "-b", "bin-one", "main");
    commit("early.bin", Buffer.concat([Buffer.from("head\0"), Buffer.alloc(100, 0x61), Buffer.from("ONE\n")]), "binary file, tail one");
    git("checkout", "-q", "-b", "bin-two", "main");
    commit("early.bin", Buffer.concat([Buffer.from("head\0"), Buffer.alloc(100, 0x61), Buffer.from("TWO\n")]), "binary file, tail two");
    git("checkout", "-q", "main");
  });

  it("builds a fixture where git sees different text files that differ only after the NUL", () => {
    expect(git("rev-parse", "nul-one:nul.txt")).not.toBe(git("rev-parse", "nul-two:nul.txt"));
    // numstat prints "-\t-" for binary files; "1\t0" means git treats this one as text.
    expect(git("diff", "--numstat", "--no-renames", "main", "nul-one")).toBe("1\t0\tnul.txt");
    expect(git("diff", "--numstat", "--no-renames", "main", "nul-two")).toBe("1\t0\tnul.txt");
  });

  it("refuses to compute a patch_id instead of returning one id for two different diffs", () => {
    expect(() => patchId("main", "nul-one")).toThrow(NUL_NAME);
    expect(() => patchId("main", "nul-two")).toThrow(NUL_NAME);
    expect(() => patchId("main", "nul-one")).toThrow(new RegExp(`${sha("main")}\\.\\.\\.${sha("nul-one")}`));
  });

  it("does not turn a NUL-free diff or a git-classified binary file into an error", () => {
    expect(patchId("main", "feature")).toMatch(/^[0-9a-f]{40}$/);
    expect(patchId("main", "bin-one")).toMatch(/^[0-9a-f]{40}$/);
    expect(patchId("main", "bin-two")).toMatch(/^[0-9a-f]{40}$/);
    expect(patchId("main", "bin-one")).not.toBe(patchId("main", "bin-two"));
  });

  it("fails buildVerdict and main() the same way, without a verdict", () => {
    const input = { role: "verifier", verdict: "PASS", base: sha("main"), head: sha("nul-one"), verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "log", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "green" } };
    expect(() => buildVerdict(input, { cwd: repo, now: NOW })).toThrow(NUL_NAME);
    const run = () => main([...argsWithout("--head"), "--head", sha("nul-two")], { cwd: repo, now: NOW });
    expect(run).toThrow(NUL_NAME);
  });

  it("exits 1 with the reason on stderr and nothing on stdout when run as a CLI", () => {
    let result;
    try {
      execFileSync(process.execPath, [script, ...argsWithout("--head"), "--head", sha("nul-one")], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      result = { status: 0, stdout: "", stderr: "" };
    } catch (error) {
      result = { status: error.status, stdout: error.stdout, stderr: error.stderr };
    }
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^emit-verdict: computePatchId: [0-9a-f]{40}\.\.\.[0-9a-f]{40} diff contains a NUL byte, which git patch-id cannot hash/);
  });
});

describe("computePatchId with a diff that git patch-id splits", () => {
  // git patch-id treats an input line that starts with 40 hex characters as the
  // next commit's id: it ends the current patch and prints one output line per
  // patch. Text hunk lines start with "+", "-" or " ", so only a base85 data
  // line of a "GIT binary patch" can do that (its length character is "c" to
  // "f" for 29 to 32 bytes, and those are hex digits). The fixture below is a
  // 73-byte file with a leading NUL (so git classes it as binary) whose
  // deflate stream is one stored block of 84 bytes; git cuts that into lines of
  // 52 and 32 bytes, and the 32-byte line (the last 28 file bytes plus the
  // adler32) is chosen to read as "f" followed by 39 hex characters.
  const SPLIT_NAME = /git patch-id returned 2 ids for [0-9a-f]{40}\.\.\.[0-9a-f]{40}, which is one diff/;
  const BASE85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
  const HEX = new Set("0123456789ABCDEFabcdef");
  const script = fileURLToPath(new URL("./emit-verdict.mjs", import.meta.url));

  const adler32 = (bytes) => {
    let a = 1;
    let b = 0;
    for (const byte of bytes) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  };
  /** Git's base85 for 4 bytes (5 characters). */
  const encode85 = (value) => {
    let rest = value;
    let out = "";
    for (let i = 0; i < 5; i++) {
      out = BASE85[rest % 85] + out;
      rest = Math.floor(rest / 85);
    }
    return out;
  };
  const decode85 = (text) => [...text].reduce((value, char) => value * 85 + BASE85.indexOf(char), 0);

  /** 73 bytes whose last base85 line in `git diff --binary` starts with 40 hex characters. */
  const craftedBinary = () => {
    const length = 73;
    const wantedHex = "abcdef0123456789abcdef0123456789abc"; // 7 groups of 5 characters = 28 bytes
    const tail = Buffer.alloc(28);
    for (let group = 0; group < 7; group++) tail.writeUInt32BE(decode85(wantedHex.slice(group * 5, group * 5 + 5)), group * 4);
    // The first 4 characters of the adler32's base85 form must be hex too; about 1 in 220 values is.
    for (let counter = 0; counter < 1e6; counter++) {
      const data = Buffer.alloc(length);
      data.writeUInt32BE(counter, 1); // data[0] stays 0: the NUL makes git treat the file as binary
      for (let i = 5; i < length - 28; i++) data[i] = ((i * 131 + counter * 7) & 0xff) | 0x80;
      tail.copy(data, length - 28);
      if ([...encode85(adler32(data)).slice(0, 4)].every((char) => HEX.has(char))) return data;
    }
    throw new Error("could not craft the binary fixture");
  };

  const commitFiles = (files, message) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(repo, name), content);
      git("add", name);
    }
    git("commit", "-q", "-m", message);
  };
  const rawPatchIdLines = (head) => {
    const diff = execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--full-index", "--binary", "--end-of-options", `${sha("main")}...${sha(head)}`, "--"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    expect(diff.includes(0)).toBe(false); // no NUL, so the NUL guard cannot be what stops it
    return execFileSync("git", ["patch-id", "--verbatim"], { cwd: repo, input: diff, encoding: "utf8" }).trim().split("\n");
  };

  beforeAll(() => {
    const blob = craftedBinary();
    // Both heads carry the same crafted blob; they differ only in the files git sorts after it.
    git("checkout", "-q", "-b", "split-one", "main");
    commitFiles({ "a.bin": blob, "z.txt": "first change\n" }, "crafted binary, first change after it");
    git("checkout", "-q", "-b", "split-two", "main");
    commitFiles({ "a.bin": blob, "z.txt": "second change\n", "z.sh": "echo hidden after the split\n" }, "crafted binary, a different change after it");
    // The same layout with ordinary bytes in the binary file: no data line reads as an object id.
    git("checkout", "-q", "-b", "split-plain", "main");
    commitFiles({ "a.bin": Buffer.concat([Buffer.from([0]), Buffer.alloc(72, 0x80)]), "z.txt": "first change\n" }, "ordinary binary, first change after it");
    git("checkout", "-q", "main");
  });

  it("builds a fixture where raw git patch-id prints two lines for each of two different diffs", () => {
    expect(git("diff", "--numstat", "--no-renames", "main", "split-one").split("\n")[0]).toBe("-\t-\ta.bin"); // binary
    expect(git("rev-parse", "split-one:a.bin")).toBe(git("rev-parse", "split-two:a.bin"));
    expect(git("rev-parse", "split-one:z.txt")).not.toBe(git("rev-parse", "split-two:z.txt"));
    for (const head of ["split-one", "split-two"]) {
      const lines = rawPatchIdLines(head);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^[0-9a-f]{40} 0{40}$/);
      expect(lines[1]).toMatch(/^[0-9a-f]{40} [0-9a-f]{40}$/);
    }
    // The first line is the same for both: it covers only what precedes the split.
    expect(rawPatchIdLines("split-one")[0]).toBe(rawPatchIdLines("split-two")[0]);
    expect(rawPatchIdLines("split-one")[1]).not.toBe(rawPatchIdLines("split-two")[1]);
  });

  it("refuses to compute a patch_id instead of returning the id of the part before the split", () => {
    expect(() => patchId("main", "split-one")).toThrow(SPLIT_NAME);
    expect(() => patchId("main", "split-two")).toThrow(SPLIT_NAME);
    expect(() => patchId("main", "split-two")).toThrow(new RegExp(`${sha("main")}\\.\\.\\.${sha("split-two")}`));
  });

  it("still returns one id for a normal diff and for an ordinary binary file", () => {
    expect(rawPatchIdLines("feature")).toHaveLength(1);
    expect(rawPatchIdLines("split-plain")).toHaveLength(1);
    expect(patchId("main", "feature")).toMatch(/^[0-9a-f]{40}$/);
    expect(patchId("main", "split-plain")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fails buildVerdict and main() the same way, without a verdict", () => {
    const input = { role: "verifier", verdict: "PASS", base: sha("main"), head: sha("split-two"), verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "log", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "green" } };
    expect(() => buildVerdict(input, { cwd: repo, now: NOW })).toThrow(SPLIT_NAME);
    expect(() => main([...argsWithout("--head"), "--head", sha("split-one")], { cwd: repo, now: NOW })).toThrow(SPLIT_NAME);
  });

  it("exits 1 with the reason on stderr and nothing on stdout when run as a CLI", () => {
    let result;
    try {
      execFileSync(process.execPath, [script, ...argsWithout("--head"), "--head", sha("split-two")], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      result = { status: 0, stdout: "", stderr: "" };
    } catch (error) {
      result = { status: error.status, stdout: error.stdout, stderr: error.stderr };
    }
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^emit-verdict: computePatchId: git patch-id returned 2 ids for [0-9a-f]{40}\.\.\.[0-9a-f]{40}, which is one diff/);
  });
});

describe("parsePatchIdOutput", () => {
  const ID = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const ZEROS = "0".repeat(40);

  it("returns the patch id of exactly one `<id> <commit id or zeros>` line", () => {
    expect(parsePatchIdOutput(`${ID} ${ZEROS}\n`)).toBe(ID);
    expect(parsePatchIdOutput(`${ID} ${OTHER}\n`)).toBe(ID);
    expect(parsePatchIdOutput(`${ID} ${ZEROS}`)).toBe(ID);
  });

  it("throws on no output or a bare newline", () => {
    expect(() => parsePatchIdOutput("", "x...y")).toThrow(/returned no id for x\.\.\.y/);
    expect(() => parsePatchIdOutput("\n")).toThrow(/returned an unexpected line/);
  });

  it("throws on more than one line, whatever the lines are", () => {
    expect(() => parsePatchIdOutput(`${ID} ${ZEROS}\n${OTHER} ${ID}\n`)).toThrow(/returned 2 ids for the diff, which is one diff/);
    expect(() => parsePatchIdOutput(`${ID} ${ZEROS}\n${OTHER} ${ID}\n${ID} ${OTHER}\n`)).toThrow(/returned 3 ids/);
    expect(() => parsePatchIdOutput(`${ID} ${ZEROS}\n\n`)).toThrow(/returned 2 ids/);
    expect(() => parsePatchIdOutput(`\n${ID} ${ZEROS}\n`)).toThrow(/returned 2 ids/);
  });

  it("throws when the single line is not `<40-hex> <40-hex>`", () => {
    for (const bad of [ID, `${ID} `, `${ID}  ${ZEROS}`, `${ID.toUpperCase()} ${ZEROS}`, `${ID.slice(1)} ${ZEROS}`, `${ID} ${ZEROS}x`, `${ID} ${ZEROS}\r`, `x ${ZEROS}`, `${ID} ${ZEROS} extra`]) {
      expect(() => parsePatchIdOutput(`${bad}\n`)).toThrow(/returned an unexpected line/);
    }
  });
});

describe("emit -> validate round trip", () => {
  it("fills sha, patch_id and a UTC timestamp and validates", () => {
    const body = main(ARGS(), { cwd: repo, now: NOW });
    const [block] = extractVerdictBlocks(body);
    const verdict = JSON.parse(block);
    expect(validateVerdict(verdict)).toEqual({ ok: true, errors: [] });
    expect(verdict).toMatchObject({
      role: "verifier",
      sha: sha("feature"),
      patch_id: patchId("main", "feature"),
      timestamp: "2026-10-16T12:34:56Z",
    });
    const comments = [{ id: 7, user: { login: "verifier-bot" }, created_at: "2026-10-16T12:35:00Z", updated_at: "2026-10-16T12:35:00Z", body }];
    expect(parseVerdictComments(comments, { sha: verdict.sha }).verdict).toEqual(verdict);
  });

  it("binds patch_id to the given sha rather than head", () => {
    const wsA = sha("ws-a");
    const verdict = buildVerdict(
      { role: "verifier", verdict: "PASS", sha: wsA, base: sha("main"), head: sha("feature"), verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "verify-run", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "green" } },
      { cwd: repo, now: NOW },
    );
    expect(verdict.sha).toBe(wsA);
    expect(verdict.patch_id).toBe(patchId("main", "ws-a"));
  });

  it("rejects a --findings file that is not an array", () => {
    const findingsFile = join(repo, "findings-object.json");
    writeFileSync(findingsFile, JSON.stringify({ severity: "high" }));
    expect(() => main([...ARGS(), "--role", "reviewer", "--findings", findingsFile], { cwd: repo, now: NOW })).toThrow(/must contain a JSON array/);
  });

  it("refuses to emit an invalid verdict with every error listed", () => {
    expect(() => main([...ARGS().slice(0, -6), "--evidence", "log=http://x.test/", "--checks", "maybe", "--conflicts", "0", "--open-threads", "0"], { cwd: repo, now: NOW }))
      .toThrow(/evidence\[1\]\.url: must use https[\s\S]*readiness\.checks: must be one of/);
    expect(() => main([...ARGS(), "--conflicts=-1"], { cwd: repo })).toThrow(/--conflicts must be a non-negative integer/);
    expect(() => main(ARGS().filter((a) => !a.startsWith("verify-run") && a !== "--evidence"), { cwd: repo })).toThrow(/at least 1 item/);
  });

  describe("--findings resolution", () => {
    let outside;
    const env = {};
    beforeAll(() => {
      outside = mkdtempSync(join(tmpdir(), "ovd851-outside-"));
      writeFileSync(join(outside, "f.json"), "[]");
      mkdirSync(join(repo, "sub"), { recursive: true });
      writeFileSync(join(repo, "sub", "..ok.json"), "[]");
    });
    afterAll(() => rmSync(outside, { recursive: true, force: true }));

    it("accepts files inside the repository root, relative to the root", () => {
      expect(resolveInputFile("sub/..ok.json", { cwd: repo, env })).toBe(realpathSync(join(repo, "sub", "..ok.json")));
      expect(resolveInputFile("sub/..ok.json", { cwd: join(repo, "sub"), env })).toBe(realpathSync(join(repo, "sub", "..ok.json")));
      expect(resolveInputFile(join(repo, "sub", "..ok.json"), { cwd: repo, env })).toMatch(/\.\.ok\.json$/);
    });

    it("rejects ../ traversal", () => {
      expect(() => resolveInputFile("../../../../../../etc/hostname", { cwd: join(repo, "sub"), env })).toThrow(/must be inside|does not exist/);
      expect(() => resolveInputFile(`../${outside.split("/").pop()}/f.json`, { cwd: repo, env })).toThrow(/must be inside the repository root/);
      expect(() => resolveInputFile(".", { cwd: "/etc", env })).toThrow(/must be inside/);
    });

    it("rejects an absolute path outside the base, including the OS temp directory", () => {
      expect(() => resolveInputFile("/etc/passwd", { cwd: repo, env })).toThrow(/must be inside the repository root/);
      expect(() => resolveInputFile(join(outside, "f.json"), { cwd: repo, env })).toThrow(/must be inside the repository root/);
      expect(() => main([...ARGS(), "--role", "reviewer", "--findings", "/etc/passwd"], { cwd: repo, now: NOW, env })).toThrow(/must be inside/);
    });

    it("rejects symlinks, including one inside the base that points outside", () => {
      symlinkSync(join(outside, "f.json"), join(repo, "sub", "escape.json"));
      symlinkSync(join(repo, "sub", "..ok.json"), join(repo, "sub", "inner-link.json"));
      symlinkSync(outside, join(repo, "sub", "outdir"));
      expect(() => resolveInputFile("sub/escape.json", { cwd: repo, env })).toThrow(/must not be a symlink/);
      expect(() => resolveInputFile("sub/inner-link.json", { cwd: repo, env })).toThrow(/must not be a symlink/);
      expect(() => resolveInputFile("sub/outdir/f.json", { cwd: repo, env })).toThrow(/must be inside the repository root/);
    });

    it("rejects non-regular files: a FIFO and a directory", () => {
      const fifo = join(repo, "sub", "pipe.json");
      execFileSync("mkfifo", [fifo]);
      mkdirSync(join(repo, "sub", "dir.json"));
      expect(() => resolveInputFile("sub/pipe.json", { cwd: repo, env })).toThrow(/must be a regular file/);
      expect(() => resolveInputFile("sub/dir.json", { cwd: repo, env })).toThrow(/must be a regular file/);
      expect(() => main([...ARGS(), "--role", "reviewer", "--findings", fifo], { cwd: repo, now: NOW, env })).toThrow(/must be a regular file/);
      const runnerEnv = { RUNNER_TEMP: outside };
      execFileSync("mkfifo", [join(outside, "pipe.json")]);
      expect(() => resolveInputFile(join(outside, "pipe.json"), { cwd: repo, env: runnerEnv })).toThrow(/must be a regular file/);
    });

    it("rejects missing files", () => {
      expect(() => resolveInputFile("missing.json", { cwd: repo, env })).toThrow(/does not exist/);
    });

    it("accepts files under RUNNER_TEMP when it is set", () => {
      const runnerEnv = { RUNNER_TEMP: outside };
      expect(resolveInputFile(join(outside, "f.json"), { cwd: repo, env: runnerEnv })).toBe(realpathSync(join(outside, "f.json")));
      expect(resolveInputFile("f.json", { cwd: repo, env: runnerEnv })).toBe(realpathSync(join(outside, "f.json")));
      expect(() => resolveInputFile("/etc/passwd", { cwd: repo, env: runnerEnv })).toThrow(/must be inside the repository root or \$RUNNER_TEMP/);
      writeFileSync(join(outside, "findings.json"), JSON.stringify([{ severity: "low", file: "feature.txt", line: null, model: "opus" }]));
      const body = main([...ARGS(), "--role", "reviewer", "--findings", join(outside, "findings.json")], { cwd: repo, now: NOW, env: runnerEnv });
      expect(JSON.parse(extractVerdictBlocks(body)[0]).findings).toHaveLength(1);
    });
  });

  it("emits the same comment when no new fields are given", () => {
    const body = main(ARGS(), { cwd: repo, now: NOW });
    const verdict = JSON.parse(extractVerdictBlocks(body)[0]);
    const expected = {
      schema: "overdrafter.verdict/v1",
      role: "verifier",
      verdict: "PASS",
      sha: sha("feature"),
      patch_id: patchId("main", "feature"),
      diff_id: diffId("main", "feature"),
      verifier: { id: "astra-verifier", model_family: "claude", github_login: "verifier-bot" },
      evidence: [{ kind: "verify-run", url: "https://github.com/o/r/actions/runs/42" }],
      notes: [],
      readiness: { conflicts: 0, open_threads: 0, checks: "green" },
      timestamp: "2026-10-16T12:34:56Z",
    };
    expect(JSON.stringify(verdict, null, 2)).toBe(JSON.stringify(expected, null, 2));
    expect(body).toBe(formatComment(expected));
    expect(verdict).not.toHaveProperty("base_sha");
    expect(verdict).not.toHaveProperty("findings");
    expect(verdict).not.toHaveProperty("supersedes");
    expect(verdict).not.toHaveProperty("reason");
  });

  it("emits base_sha, supersedes, reason and gate findings when they are given", () => {
    const findingsFile = join(repo, "gate-findings.json");
    writeFileSync(findingsFile, JSON.stringify([
      { severity: "high", file: "feature.txt", line: 1, summary: "null deref" },
      { severity: "low", file: "src/feature.txt", summary: "name is unclear" },
    ]));
    const base = sha("main");
    const body = main([
      ...ARGS(),
      "--base-sha", base,
      "--supersedes", "4242",
      "--reason", "infra",
      "--findings", findingsFile,
    ], { cwd: repo, now: NOW });
    const verdict = JSON.parse(extractVerdictBlocks(body)[0]);
    expect(verdict.base_sha).toBe(base);
    expect(verdict.supersedes).toBe(4242);
    expect(verdict.reason).toBe("infra");
    expect(verdict.findings).toEqual([
      { severity: "high", file: "feature.txt", line: 1, summary: "null deref" },
      { severity: "low", file: "src/feature.txt", summary: "name is unclear" },
    ]);
    expect(verdict.findings.some((finding) => "corroborated" in finding)).toBe(false);
    expect(validateVerdict(verdict)).toEqual({ ok: true, errors: [] });
  });

  // Architect CHANGES_REQUIRED 6236206625, finding 2: corroboration is decided
  // per legacy finding even when gate findings sit next to them.
  it("tags corroboration on legacy findings mixed with gate findings, keeping gate findings and order unchanged", () => {
    const findingsFile = join(repo, "mixed-findings.json");
    writeFileSync(findingsFile, JSON.stringify([
      { severity: "high", file: "feature.txt", line: 1, model: "grok", corroborated: false },
      { severity: "medium", file: "feature.txt", line: 1, summary: "gate note" },
      { severity: "medium", file: "feature.txt", line: 1, model: "codex" },
      { severity: "low", file: "other.txt", line: 2, model: "grok", corroborated: true },
    ]));
    const body = main([...ARGS(), "--role", "reviewer", "--findings", findingsFile], { cwd: repo, now: NOW });
    const verdict = JSON.parse(extractVerdictBlocks(body)[0]);
    expect(verdict.findings).toEqual([
      { severity: "high", file: "feature.txt", line: 1, model: "grok", corroborated: true },
      { severity: "medium", file: "feature.txt", line: 1, summary: "gate note" },
      { severity: "medium", file: "feature.txt", line: 1, model: "codex", corroborated: true },
      { severity: "low", file: "other.txt", line: 2, model: "grok", corroborated: false },
    ]);
    expect(validateVerdict(verdict)).toEqual({ ok: true, errors: [] });
  });

  it("does not count a gate finding as corroboration for a lone legacy finding", () => {
    const findingsFile = join(repo, "mixed-lone-findings.json");
    writeFileSync(findingsFile, JSON.stringify([
      { severity: "high", file: "feature.txt", line: 1, summary: "gate note" },
      { severity: "high", file: "feature.txt", line: 1, model: "grok", corroborated: true },
    ]));
    const body = main([...ARGS(), "--role", "reviewer", "--findings", findingsFile], { cwd: repo, now: NOW });
    const verdict = JSON.parse(extractVerdictBlocks(body)[0]);
    expect(verdict.findings).toEqual([
      { severity: "high", file: "feature.txt", line: 1, summary: "gate note" },
      { severity: "high", file: "feature.txt", line: 1, model: "grok", corroborated: false },
    ]);
  });

  it("rejects a pass that is not carried by an https ci-run or verify-run", () => {
    expect(() => main([...argsWithout("--evidence"), "--evidence", "log=https://x.test/"], { cwd: repo, now: NOW }))
      .toThrow(/https ci-run or verify-run/);
    expect(() => main([...argsWithout("--evidence"), "--evidence", "probe=box:/workspace/probe.log"], { cwd: repo, now: NOW }))
      .toThrow(/https ci-run or verify-run/);
    const failBody = main([
      ...argsWithout("--verdict", "--evidence"),
      "--verdict", "FAIL",
      "--evidence", "probe=box:/workspace/probe.log",
    ], { cwd: repo, now: NOW });
    expect(JSON.parse(extractVerdictBlocks(failBody)[0]).evidence).toEqual([
      { kind: "probe", url: "box:/workspace/probe.log" },
    ]);
  });

  it("rejects supersedes without reason, and a reason other than infra", () => {
    expect(() => main([...ARGS(), "--supersedes", "9"], { cwd: repo, now: NOW })).toThrow(/reason: is required when supersedes is present/);
    expect(() => main([...ARGS(), "--reason", "infra"], { cwd: repo, now: NOW })).toThrow(/supersedes: is required when reason is present/);
    expect(() => main([...ARGS(), "--supersedes", "9", "--reason", "flake"], { cwd: repo, now: NOW })).toThrow(/must be "infra"/);
    expect(() => main([...ARGS(), "--supersedes", "0", "--reason", "infra"], { cwd: repo, now: NOW })).toThrow(/--supersedes must be a positive integer/);
    expect(() => main([...ARGS(), "--base-sha", "HEAD"], { cwd: repo, now: NOW })).toThrow(/--base-sha must be a full 40-character lowercase commit SHA/);
  });

  it("emits reviewer verdicts with corroborated findings and marks them advisory", () => {
    const findingsFile = join(repo, "findings.json");
    writeFileSync(findingsFile, JSON.stringify([
      { severity: "high", file: "feature.txt", line: 1, model: "grok" },
      { severity: "medium", file: "feature.txt", line: 1, model: "codex" },
    ]));
    const body = main([...ARGS(), "--role", "reviewer", "--findings", findingsFile], { cwd: repo, now: NOW });
    expect(body).toContain("advisory reviewer verdict, not gate input");
    const verdict = JSON.parse(extractVerdictBlocks(body)[0]);
    expect(verdict.findings.every((f) => f.corroborated)).toBe(true);
  });
});

describe("CLI entry guard", () => {
  const script = fileURLToPath(new URL("./emit-verdict.mjs", import.meta.url));
  let dir;
  let link;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ovd851-entry-"));
    link = join(dir, "emit-verdict-link.mjs");
    symlinkSync(script, link);
    symlinkSync(link, join(dir, "link-to-link.mjs"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (entry, args) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [entry, ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    } catch (error) {
      return { status: error.status, stdout: error.stdout, stderr: error.stderr };
    }
  };

  it("runs main() when launched through a symlinked path", () => {
    for (const entry of [script, link, join(dir, "link-to-link.mjs")]) {
      const result = cli(entry, ARGS());
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("OverDrafter verdict: PASS");
      expect(JSON.parse(extractVerdictBlocks(result.stdout)[0])).toMatchObject({ sha: sha("feature"), patch_id: patchId("main", "feature") });
    }
  });

  it("reports errors and exits non-zero through a symlinked path instead of exiting 0 silently", () => {
    const result = cli(link, argsWithout("--base"));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^emit-verdict: --base must be a full 40-character lowercase commit SHA/);
  });
});

describe("posting", () => {
  it("prints by default and never calls gh without --post", () => {
    const run = vi.fn();
    main([...ARGS(), "--pr", "12"], { cwd: repo, now: NOW, run });
    expect(run).not.toHaveBeenCalled();
  });

  it("posts through a fixed argv with the body in a temp file that is removed afterwards", () => {
    let seen;
    const run = vi.fn((_bin, args) => {
      const bodyFile = args[4];
      seen = { bodyFile, exists: existsSync(bodyFile), contents: readFileSync(bodyFile, "utf8") };
      return { status: 0 };
    });
    // The injected runner never executes gh; supply an owned executable fixture
    // so this test does not depend on a host installation in a fixed directory.
    const gh = join(repo, "gh");
    writeFileSync(gh, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    vi.stubEnv("GH_BIN", gh);
    let body;
    try { body = main([...ARGS(), "--pr", "12", "--post"], { cwd: repo, now: NOW, run }); }
    finally { vi.unstubAllEnvs(); }

    expect(run).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = run.mock.calls[0];
    expect(bin).toMatch(/^\/.*\/gh$/);
    expect(args).toEqual(["pr", "comment", "12", "--body-file", seen.bodyFile]);
    expect(dirname(seen.bodyFile)).toMatch(new RegExp(`^${tmpdir().replaceAll("/", "\\/")}\\/ovd851-verdict-`));
    expect(seen).toMatchObject({ exists: true, contents: body });
    expect(opts).toMatchObject({ cwd: repo, shell: false });
    expect(opts.input).toBeUndefined();
    expect(opts.env.PATH).toBe("/usr/bin:/bin:/usr/local/bin");
    expect(existsSync(dirname(seen.bodyFile))).toBe(false);
  });

  it("removes the temp dir even when gh fails or throws", () => {
    const dirs = [];
    const capture = (result) => (_bin, args) => {
      dirs.push(dirname(args[4]));
      if (result instanceof Error) throw result;
      return result;
    };
    expect(() => postComment({ pr: "5", body: "x", gh: "/usr/bin/gh", run: capture({ status: 2 }) })).toThrow(/exit 2/);
    expect(() => postComment({ pr: "5", body: "x", gh: "/usr/bin/gh", run: capture(new Error("boom")) })).toThrow(/boom/);
    expect(() => postComment({ pr: "5", body: "x", gh: "/usr/bin/gh", run: capture({ error: new Error("ENOENT") }) })).toThrow(/ENOENT/);
    expect(dirs).toHaveLength(3);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("requires a PR number and surfaces gh failures", () => {
    const verdict = buildVerdict(
      { role: "verifier", verdict: "FAIL", sha: "a".repeat(40), patchId: "b".repeat(40), diffId: "c".repeat(64), verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "log", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "red" } },
      { now: NOW },
    );
    const body = formatComment(verdict);
    expect(() => postComment({ body, run: vi.fn() })).toThrow(/--pr/);
    expect(() => postComment({ pr: 3, body, gh: "/usr/bin/gh", run: () => ({ status: 1 }) })).toThrow(/exit 1/);
    const run = vi.fn();
    for (const pr of ["0", "012", "-1", "1.5", "12 --repo evil/x", "--help", "--repo=x", "1; rm -rf /", "12\n", "12345678", "99999999999", ""]) {
      expect(() => postComment({ pr, body, gh: "/usr/bin/gh", run })).toThrow(/--pr <positive integer>/);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("only runs git and gh from fixed system directories", () => {
    const exists = (p) => p === "/usr/local/bin/gh";
    expect(resolveBinary("gh", { exists })).toBe("/usr/local/bin/gh");
    expect(() => resolveBinary("gh", { exists: () => false })).toThrow(/gh not found in \/usr\/bin, \/bin, \/usr\/local\/bin/);
  });
});

describe("GH_BIN override", () => {
  let dir;
  const fakeGh = (name, mode) => {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, mode);
    return file;
  };
  const lookup = vi.fn(() => "/usr/bin/gh");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ovd851-ghbin-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the strict PATH lookup when GH_BIN is unset or empty", () => {
    expect(resolveGhBin({}, { lookup })).toBe("/usr/bin/gh");
    expect(resolveGhBin({ GH_BIN: "" }, { lookup })).toBe("/usr/bin/gh");
    expect(lookup).toHaveBeenCalledWith("gh");
    const exists = (p) => p === "/bin/gh";
    expect(resolveGhBin({}, { lookup: (name) => resolveBinary(name, { exists }) })).toBe("/bin/gh");
  });

  it("accepts an absolute, owner-only-writable executable and returns its realpath", () => {
    const file = fakeGh("gh", 0o755);
    const link = join(dir, "gh-link");
    symlinkSync(file, link);
    expect(resolveGhBin({ GH_BIN: file }, { lookup })).toBe(realpathSync(file));
    expect(resolveGhBin({ GH_BIN: link }, { lookup })).toBe(realpathSync(file));
  });

  it("fails closed on a bad override and never falls back to PATH", () => {
    const strict = vi.fn(() => "/usr/bin/gh");
    expect(() => resolveGhBin({ GH_BIN: "bin/gh" }, { lookup: strict })).toThrow(/GH_BIN must be an absolute path/);
    expect(() => resolveGhBin({ GH_BIN: join(dir, "missing") }, { lookup: strict })).toThrow(/GH_BIN does not exist/);
    expect(() => resolveGhBin({ GH_BIN: fakeGh("gh-777", 0o777) }, { lookup: strict })).toThrow(/GH_BIN is group- or world-writable/);
    expect(() => resolveGhBin({ GH_BIN: fakeGh("gh-775", 0o775) }, { lookup: strict })).toThrow(/GH_BIN is group- or world-writable/);
    expect(() => resolveGhBin({ GH_BIN: fakeGh("gh-644", 0o644) }, { lookup: strict })).toThrow(/GH_BIN is not executable/);
    expect(() => resolveGhBin({ GH_BIN: dir }, { lookup: strict })).toThrow(/GH_BIN is not a regular file/);
    expect(strict).not.toHaveBeenCalled();
  });
});

describe("R2 canonical model families", () => {
  const input = { role: "verifier", verdict: "PASS", sha: "a".repeat(40), patchId: "b".repeat(40), diffId: "c".repeat(64), verifierId: "v", githubLogin: "bot", evidence: [{ kind: "ci-run", url: "https://github.com/o/r/actions/runs/1" }], readiness: { conflicts: 0, open_threads: 0, checks: "green" } };
  it.each(["opus", "sonnet"])("emits %s as claude", (modelFamily) => {
    expect(buildVerdict({ ...input, modelFamily }, { now: NOW }).verifier.model_family).toBe("claude");
  });
  it.each(["", "Opus", "claude-opus", "gpt-6"])("rejects %s", (modelFamily) => {
    expect(() => buildVerdict({ ...input, modelFamily }, { now: NOW })).toThrow("verdict_schema_error");
  });
});
