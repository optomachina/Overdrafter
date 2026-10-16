// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GIT_BIN,
  INLINE_ALLOW_MARKER,
  SENSITIVE_PATH_RULES,
  envrcLoadsOnly,
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
// Matches gitleaks' default aws-access-token rule (AKIA + 16 base32 chars).
const AWS_KEY_GITLEAKS = ["AK", "IA", "QYLP", "MN5H", "HHFP", "ZAM2"].join("");
const INLINE_ALLOWED_LINE = `const id = "${AWS_KEY_GITLEAKS}"; // ${INLINE_ALLOW_MARKER}\n`;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// gitleaks is not a dependency. The real-binary test runs only when one is
// already available: $GITLEAKS_BIN, or `gitleaks` on PATH.
const GITLEAKS_BIN = process.env.GITLEAKS_BIN || "gitleaks";
const HAS_GITLEAKS = spawnSync(GITLEAKS_BIN, ["version"], { stdio: "ignore" }).status === 0;

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

  it("has one entry per documented pattern", () => {
    expect(SENSITIVE_PATH_RULES.map((rule) => rule.glob)).toEqual([
      "*.pem", "*.key", "*.p12", "id_rsa*", ".env*", "*storage-state*.json",
    ]);
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

  it("flags a line added to an existing .gitleaksignore as gate_loosening", () => {
    const dir = repo({ ".gitleaksignore": "abc123:src/app.ts:generic-api-key:1\n" });
    commit(dir, { ".gitleaksignore": "abc123:src/app.ts:generic-api-key:1\ndef456:src/b.ts:aws-access-token:3\n" });
    const { code, report } = check(dir, ["--enforce"]);
    expect(code).toBe(0);
    expect(report.gate_loosening).toEqual([
      { path: ".gitleaksignore", status: "M", reason: "fingerprint ignore list edited", requires: ["grokbot_countersign", "blaine_card"] },
    ]);
  });

  it("flags an added inline allow marker as a finding, by file:line only", () => {
    const dir = repo({ "src/a.ts": "export const a = 1;\n" });
    commit(dir, { "src/a.ts": `export const a = 1;\n// ok\n${INLINE_ALLOWED_LINE}`, "docs/n.md": `x ${INLINE_ALLOW_MARKER}\n` });
    const { code, out, err, report } = check(dir, ["--enforce"]);
    expect(code).toBe(1);
    expect(report.findings).toEqual([
      { path: "docs/n.md", line: 1, rules: ["inline_allow"], reason: "inline gitleaks allow comment added (forbidden)" },
      { path: "src/a.ts", line: 3, rules: ["inline_allow"], reason: "inline gitleaks allow comment added (forbidden)" },
    ]);
    let human = "";
    run([], { cwd: dir, stdout: { write: (c) => { human += c; return true; } }, stderr: { write: () => true } });
    expect(human).toContain("BLOCKED src/a.ts:3 [inline_allow]");
    for (const output of [out + err, human]) {
      expect(output).not.toContain(AWS_KEY_GITLEAKS);
      expect(output).not.toContain("const id");
    }
  });

  it("does not flag an inline allow marker that was already on the base", () => {
    const dir = repo({ "src/a.ts": INLINE_ALLOWED_LINE }, { "src/a.ts": `${INLINE_ALLOWED_LINE}export {};\n` });
    expect(check(dir).report.findings).toEqual([]);
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

const SKIP_REASON = HAS_GITLEAKS ? "" : " (skipped: no gitleaks binary; set GITLEAKS_BIN or put gitleaks on PATH)";

describe(`real gitleaks with --ignore-gitleaks-allow${SKIP_REASON}`, () => {
  it.skipIf(!HAS_GITLEAKS)(
    "still flags an inline-allowed synthetic secret",
    () => {
      const dir = repo({ "src/id.ts": INLINE_ALLOWED_LINE });
      // Untracked and not named .gitleaksignore, so gitleaks only sees it via the flag.
      const ignore = join(dir, "empty-ignore");
      writeFileSync(ignore, "");
      const scan = (...extra) => spawnSync(GITLEAKS_BIN, [
        "git", "--no-banner", "--redact", ...extra,
        "--config", join(REPO_ROOT, ".gitleaks.toml"),
        "--gitleaks-ignore-path", ignore,
        "--log-opts=HEAD^1..HEAD",
        "--exit-code", "1",
      ], { cwd: dir, encoding: "utf8" });
      const enforced = scan("--ignore-gitleaks-allow");
      expect(enforced.status).toBe(1);
      expect(enforced.stdout + enforced.stderr).not.toContain(AWS_KEY_GITLEAKS);
      // Control: without the flag the marker hides the same secret.
      expect(scan().status).toBe(0);
    },
  );
});
