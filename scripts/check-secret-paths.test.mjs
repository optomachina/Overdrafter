// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GIT_BIN,
  SENSITIVE_PATH_RULES,
  displayPath,
  envrcLoadsOnly,
  hasControlChars,
  isInvokedDirectly,
  matchSensitiveRules,
  run,
} from "./check-secret-paths.mjs";

// Synthetic secret-shaped values, assembled at runtime so no matching literal
// is ever committed to this repo.
const AWS_KEY = ["AK", "IA", "Q7Z3", "X9W2", "V5U4", "T6S8"].join("");
const STRIPE_KEY = ["sk", "_te", "st_", "51Hx", "Fake", "0000", "Synthetic", "Value"].join("");
const JWT = ["ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JyIjoic2VydmljZV9yb2xlIn0", ".", "c2lnbmF0dXJl"].join("");
const PEM = ["-----BEGIN ", "RSA PRIVATE ", "KEY-----\n", "MIIsynthetic\n", "-----END ", "RSA PRIVATE ", "KEY-----\n"].join("");
const SECRETS = [AWS_KEY, STRIPE_KEY, JWT, PEM.split("\n")[0]];

const temps = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const git = (cwd, ...args) => execFileSync(GIT_BIN, [
  "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args,
], { cwd, encoding: "utf8" });

function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function commit(dir, files, remove = []) {
  write(dir, files);
  for (const path of remove) git(dir, "rm", "-q", path);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
}

/** A repo with a README base commit, then one commit per entry in `commits`. */
function repo(...commits) {
  const dir = mkdtempSync(join(tmpdir(), "secret-paths-"));
  temps.push(dir);
  git(dir, "init", "-q");
  commit(dir, { "README.md": "fixture\n" });
  for (const files of commits) commit(dir, files);
  return dir;
}

function check(dir, argv = []) {
  let out = "";
  let err = "";
  const stdout = { write: (chunk) => { out += chunk; return true; } };
  const stderr = { write: (chunk) => { err += chunk; return true; } };
  const code = run(["--json", ...argv], { cwd: dir, stdout, stderr });
  return { code, out, err, report: out ? JSON.parse(out) : null };
}

const blockedPaths = (report) => report.findings.map((f) => f.path).sort();

describe("SENSITIVE_PATH_RULES", () => {
  it.each([
    ["certs/server.pem", "pem"],
    ["deploy/tls.KEY", "key"],
    ["signing/bundle.p12", "p12"],
    ["home/.ssh/id_rsa", "id_rsa"],
    ["id_rsa.pub", "id_rsa"],
    [".env", "env"],
    ["worker/.env.production", "env"],
    ["e2e/.auth/admin-storage-state.json", "storage_state"],
    ["storage-state.json", "storage_state"],
  ])("%s matches %s", (path, id) => {
    expect(matchSensitiveRules(path)).toContain(id);
  });

  it.each(["src/key.ts", "docs/env.md", "storage-state.ts", "pem/README.md", "monkey.json"])("%s is not sensitive", (path) => {
    expect(matchSensitiveRules(path)).toEqual([]);
  });

  // Without dotAll, `*` stopped at a line feed and "a<LF>.pem" matched nothing.
  it.each([
    ["a\n.pem", "pem"],
    ["x/.env\nfoo", "env"],
    ["keys/prod\n.key", "key"],
    ["id_rsa\r", "id_rsa"],
    ["e2e/admin\tstorage-state\u2028.json", "storage_state"],
  ])("%j matches %s across control characters", (path, id) => {
    expect(matchSensitiveRules(path)).toContain(id);
  });

  it("has one entry per documented pattern", () => {
    expect(SENSITIVE_PATH_RULES.map((rule) => rule.glob)).toEqual([
      "*.pem", "*.key", "*.p12", "id_rsa*", ".env*", "*storage-state*.json",
    ]);
  });
});

describe("control characters in paths", () => {
  it.each(["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b"])("%j has a control character", (path) => {
    expect(hasControlChars(path)).toBe(true);
  });

  it.each(["src/app.ts", "a b.pem", "café/naïve.txt", "emoji-🔑.txt"])("%j has none", (path) => {
    expect(hasControlChars(path)).toBe(false);
    expect(displayPath(path)).toBe(path);
  });

  it("escapes each one as \\uXXXX", () => {
    expect(displayPath("a\n\r\t\u2028b")).toBe(String.raw`a\u000a\u000d\u0009\u2028b`);
  });
});

describe("envrcLoadsOnly", () => {
  it.each([
    "",
    "# comment only\n",
    "source_env ../.envrc\ndotenv .env.local\n\nsource scripts/dev-env.sh\n",
    "  dotenv\n",
  ])("accepts %j", (text) => expect(envrcLoadsOnly(text)).toBe(true));

  it.each([
    "export STRIPE_KEY=value\n",
    "dotenv .env\nFOO=bar\n",
    "source .env; export FOO=bar\n",
    "source $(pass show token)\n",
    "dotenv `cat x`\n",
    "use nix\n",
  ])("rejects %j", (text) => expect(envrcLoadsOnly(text)).toBe(false));
});

describe("check-secret-paths diff mode", () => {
  it("blocks .env.local and allows .env.example", () => {
    const dir = repo({ ".env.local": `STRIPE_SECRET_KEY=${STRIPE_KEY}\n`, ".env.example": "STRIPE_SECRET_KEY=replace-me\n" });
    const { code, report } = check(dir);
    expect(code).toBe(0);
    expect(blockedPaths(report)).toEqual([".env.local"]);
    expect(report.findings[0].rules).toEqual(["env"]);
  });

  it("blocks .envrc with values and allows .envrc that only sources or dotenvs", () => {
    const withValues = check(repo({ ".envrc": `dotenv\nexport AWS_ACCESS_KEY_ID=${AWS_KEY}\n` })).report;
    expect(blockedPaths(withValues)).toEqual([".envrc"]);
    const loadsOnly = check(repo({ ".envrc": "# local env\nsource_env ..\ndotenv .env.local\n" })).report;
    expect(loadsOnly.findings).toEqual([]);
  });

  it.each([
    ["config/server.pem", PEM],
    ["config/server.key", PEM],
    ["config/client.p12", "binary-ish"],
    ["keys/id_rsa", PEM],
    [".env", `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`],
    ["e2e/.auth/storage-state.json", JSON.stringify({ token: JWT })],
  ])("blocks added %s", (path, content) => {
    const { report } = check(repo({ [path]: content }));
    expect(blockedPaths(report)).toEqual([path]);
    expect(report.ok).toBe(false);
  });

  it("blocks any added name with a line feed, carriage return or tab (git -z), and escapes it", () => {
    const names = ["lf\n.txt", "cr\r.txt", "tab\t.txt", "a\n.pem", "dir\nx/plain.ts"];
    const dir = repo(Object.fromEntries(names.map((name) => [name, "x\n"])));
    const { report } = check(dir);
    expect(blockedPaths(report)).toEqual([...names].sort());
    for (const finding of report.findings) {
      expect(finding.rules[0]).toBe("control_char");
      expect(finding.reason).toBe("path contains a control character or line separator");
    }
    expect(report.findings.find((f) => f.path === "a\n.pem").rules).toEqual(["control_char", "pem"]);
    let human = "";
    run([], { cwd: dir, stdout: { write: (c) => { human += c; return true; } }, stderr: { write: () => true } });
    expect(human.trimEnd().split("\n")).toHaveLength(names.length + 2);
    expect(human).toContain(String.raw`  BLOCKED a\u000a.pem [control_char,pem]`);
    expect(human).toContain(String.raw`  BLOCKED cr\u000d.txt [control_char]`);
    expect(human).toContain(String.raw`  BLOCKED tab\u0009.txt [control_char]`);
    expect(human.trimEnd().split("\n").at(-1)).toBe(`secret-paths: ${names.length} blocked path(s)`);
  });

  it("does not block deleting a file with a control character in its name", () => {
    const dir = repo({ "old\n.txt": "x\n" });
    commit(dir, {}, ["old\n.txt"]);
    expect(check(dir).report.findings).toEqual([]);
  });

  it("blocks a sensitive path whose type changed (file to symlink)", () => {
    const dir = repo({ "deploy/server.key": PEM });
    unlinkSync(join(dir, "deploy/server.key"));
    symlinkSync("../README.md", join(dir, "deploy/server.key"));
    commit(dir, {});
    const { report } = check(dir);
    expect(git(dir, "diff", "--name-status", "HEAD^1", "HEAD").trim()).toBe("T\tdeploy/server.key");
    expect(blockedPaths(report)).toEqual(["deploy/server.key"]);
    expect(report.checked_paths).toBe(1);
  });

  it("blocks a modified sensitive file and ignores a deleted one", () => {
    const dir = repo({ "a.pem": "one", "b.pem": "two" });
    commit(dir, { "a.pem": "changed" }, ["b.pem"]);
    expect(blockedPaths(check(dir).report)).toEqual(["a.pem"]);
  });

  it("is diff-only: sensitive files from older history are ignored", () => {
    const dir = repo({ ".env.local": `KEY=${STRIPE_KEY}\n`, "old/id_rsa": PEM }, { "src/app.ts": "export {};\n" });
    const { report } = check(dir);
    expect(report.findings).toEqual([]);
    expect(report.checked_paths).toBe(1);
    expect(blockedPaths(check(dir, ["--base-ref", "HEAD~2"]).report)).toEqual([".env.local", "old/id_rsa"]);
  });

  it("flags .gitleaks.toml add, edit and delete as gate_loosening without failing", () => {
    const dir = repo({ ".gitleaks.toml": "[extend]\nuseDefault = true\n" });
    const added = check(dir, ["--enforce"]);
    expect(added.code).toBe(0);
    expect(added.report.gate_loosening).toEqual([
      { path: ".gitleaks.toml", status: "A", reason: "allowlist config edited", requires: ["grokbot_countersign", "blaine_card"] },
    ]);
    commit(dir, { ".gitleaks.toml": "[extend]\nuseDefault = true\n# edited\n" });
    expect(check(dir).report.gate_loosening.map((g) => g.status)).toEqual(["M"]);
    commit(dir, {}, [".gitleaks.toml"]);
    expect(check(dir).report.gate_loosening.map((g) => g.status)).toEqual(["D"]);
  });

  it.each([".gitleaksignore", "nested/dir/.gitleaksignore"])("flags %s add, edit and delete as gate_loosening without failing", (path) => {
    const dir = repo({ [path]: "abc123:src/app.ts:generic-api-key:1\n" });
    const added = check(dir, ["--enforce"]);
    expect(added.code).toBe(0);
    expect(added.report.gate_loosening).toEqual([
      { path, status: "A", reason: "fingerprint ignore list edited", requires: ["grokbot_countersign", "blaine_card"] },
    ]);
    commit(dir, { [path]: "abc123:src/app.ts:generic-api-key:1\ndef456:src/b.ts:generic-api-key:2\n" });
    expect(check(dir).report.gate_loosening.map((g) => g.status)).toEqual(["M"]);
    commit(dir, {}, [path]);
    expect(check(dir).report.gate_loosening.map((g) => g.status)).toEqual(["D"]);
  });

  it("diffs against the merge-base, so base commits after the branch point are ignored", () => {
    const dir = repo();
    git(dir, "branch", "-M", "main");
    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, { "feature/server.pem": PEM });
    git(dir, "checkout", "-q", "main");
    commit(dir, { "main-only/.env.production": `KEY=${STRIPE_KEY}\n`, ".gitleaks.toml": "[extend]\nuseDefault = true\n" });
    const branchPoint = git(dir, "merge-base", "main", "feature").trim();
    const { report } = check(dir, ["--base-ref", "main", "--head-ref", "feature"]);
    expect(report.merge_base).toBe(branchPoint);
    expect(blockedPaths(report)).toEqual(["feature/server.pem"]);
    expect(report.gate_loosening).toEqual([]);
    expect(report.checked_paths).toBe(1);
  });

  it("skips refs with no merge-base in report mode and fails them with --enforce", () => {
    const dir = repo();
    git(dir, "branch", "-M", "main");
    git(dir, "checkout", "-q", "--orphan", "unrelated");
    commit(dir, { "other.txt": "x" });
    const skipped = check(dir, ["--base-ref", "unrelated", "--head-ref", "main"]);
    expect(skipped.code).toBe(0);
    expect(skipped.err).toContain("no merge-base");
    expect(check(dir, ["--base-ref", "unrelated", "--head-ref", "main", "--enforce"]).code).toBe(2);
  });

  it("exits 0 in report mode and 1 with --enforce when blocked", () => {
    const dir = repo({ "server.pem": PEM });
    expect(check(dir).code).toBe(0);
    expect(check(dir, ["--enforce"]).code).toBe(1);
    expect(check(repo({ "src/ok.ts": "x" }), ["--enforce"]).code).toBe(0);
  });

  it("skips a missing base ref in report mode and fails it with --enforce", () => {
    const dir = repo();
    const skipped = check(dir, ["--base-ref", "does-not-exist"]);
    expect(skipped.code).toBe(0);
    expect(skipped.err).toContain("ref not found: does-not-exist");
    expect(check(dir, ["--base-ref", "does-not-exist", "--enforce"]).code).toBe(2);
  });

  it("never prints file contents, in JSON or human output", () => {
    const dir = repo({
      ".env.local": `AWS_ACCESS_KEY_ID=${AWS_KEY}\nSTRIPE=${STRIPE_KEY}\n`,
      ".envrc": `export SUPABASE_SERVICE_ROLE_KEY=${JWT}\n`,
      "server.pem": PEM,
      ".gitleaks.toml": `# ${AWS_KEY}\n`,
    });
    const json = check(dir);
    let human = "";
    run([], { cwd: dir, stdout: { write: (c) => { human += c; return true; } }, stderr: { write: (c) => { human += c; return true; } } });
    expect(json.report.findings).toHaveLength(3);
    expect(human).toContain("BLOCKED .envrc");
    for (const output of [json.out + json.err, human]) {
      for (const secret of SECRETS) expect(output).not.toContain(secret);
    }
  });
});

describe("invoked directly through a symlink", () => {
  // The secret-scan workflow runs a copy of the checker from $RUNNER_TEMP. Node
  // resolves symlinks in import.meta.url but not in process.argv[1], so a copy
  // reached through a symlinked directory used to print nothing and exit 0.
  const checker = readFileSync(fileURLToPath(new URL("./check-secret-paths.mjs", import.meta.url)), "utf8");

  it("runs and reports when the checker's directory is reached through a symlink", () => {
    const realDir = mkdtempSync(join(tmpdir(), "secret-paths-real-"));
    temps.push(realDir);
    writeFileSync(join(realDir, "check-secret-paths.mjs"), checker);
    const linkDir = join(mkdtempSync(join(tmpdir(), "secret-paths-link-")), "link");
    temps.push(dirname(linkDir));
    symlinkSync(realDir, linkDir, "dir");
    const dir = repo({ ".env.local": "X=1\n" });
    const result = spawnSync(process.execPath, [join(linkDir, "check-secret-paths.mjs")], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BLOCKED .env.local [env]");
    expect(result.stdout).toContain("secret-paths: 1 blocked path(s)");
  });

  it("is false for another file or no argv[1]", () => {
    const self = fileURLToPath(new URL("./check-secret-paths.mjs", import.meta.url));
    expect(isInvokedDirectly(self, pathToFileURL(self).href)).toBe(true);
    expect(isInvokedDirectly(fileURLToPath(import.meta.url), pathToFileURL(self).href)).toBe(false);
    expect(isInvokedDirectly(undefined, pathToFileURL(self).href)).toBe(false);
  });
});
