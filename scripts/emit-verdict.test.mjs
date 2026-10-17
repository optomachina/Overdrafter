// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertSha, buildVerdict, computePatchId, formatComment, isEntryPoint, main, postComment, resolveBinary, resolveGhBin, resolveInputFile } from "./emit-verdict.mjs";
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
    expect(run(["--base", sha("main"), "--head", "f".repeat(40)])).toThrow(/--head f{40} is not a commit in this repository/);
  });

  it("refuses an empty diff", () => {
    expect(() => patchId("main", "main")).toThrow(/empty diff/);
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
      { role: "verifier", verdict: "PASS", sha: wsA, base: sha("main"), head: sha("feature"), verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "log", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "green" } },
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
  const other = fileURLToPath(new URL("./emit-verdict.test.mjs", import.meta.url));
  const moduleUrl = new URL("./emit-verdict.mjs", import.meta.url).href;
  let dir;
  let link;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ovd851-entry-"));
    link = join(dir, "emit-verdict-link.mjs");
    symlinkSync(script, link);
    symlinkSync(link, join(dir, "link-to-link.mjs"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("recognises the module as the entry point by realpath, including through symlinks", () => {
    expect(isEntryPoint(moduleUrl, script)).toBe(true);
    expect(isEntryPoint(moduleUrl, link)).toBe(true);
    expect(isEntryPoint(moduleUrl, join(dir, "link-to-link.mjs"))).toBe(true);
  });

  it("is false when argv[1] is missing, unresolvable or another file", () => {
    expect(isEntryPoint(moduleUrl, undefined)).toBe(false);
    expect(isEntryPoint(moduleUrl, "")).toBe(false);
    expect(isEntryPoint(moduleUrl, join(dir, "missing.mjs"))).toBe(false);
    expect(isEntryPoint(moduleUrl, other)).toBe(false);
    expect(isEntryPoint("not a url", script)).toBe(false);
  });

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
    const body = main([...ARGS(), "--pr", "12", "--post"], { cwd: repo, now: NOW, run });
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
      { role: "verifier", verdict: "FAIL", sha: "a".repeat(40), patchId: "b".repeat(40), verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "log", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "red" } },
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
