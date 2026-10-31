import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "run.sh");

// The launchd plist runs /bin/bash (3.2 on macOS), so test with it.
function printArgv(state, env = {}) {
  const wt = path.join(state, "pr-1");
  const files = path.join(state, "files-1");
  const res = spawnSync("/bin/bash", [SCRIPT, "--print-argv", wt, files], {
    encoding: "utf8",
    env: { ...process.env, OVD_REVIEW_STATE: state, ...env },
  });
  return { res, wt, files };
}

const REQUIRED_DENIES = [
  "~/.npmrc",
  "~/.docker/**",
  "~/.gnupg/**",
  "~/.kube/**",
  "~/.ssh/**",
  "~/.aws/**",
  "~/.config/**",
  "~/Library/Keychains/**",
  "**/*.keychain*",
  "~/.netrc",
  "**/.env*",
];

describe("claude-auto-review run.sh argv", () => {
  let state;
  beforeEach(() => {
    state = mkdtempSync(path.join(tmpdir(), "ovd-review-test-"));
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  it("adds only the PR checkout and per-PR dir, never the shared state dir", () => {
    const { res, wt, files } = printArgv(state);
    expect(res.status, res.stderr).toBe(0);
    const argv = res.stdout.trimEnd().split("\n");
    expect(argv[0]).toBe("claude");
    const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));
    expect(addDirs).toEqual([wt, files]);
    expect(addDirs).not.toContain(state);
    for (const flag of ["--restricted", "--safe-mode", "--strict-mcp-config"]) expect(argv).toContain(flag);
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toContain("Bash");
  });

  it("scopes allows to the two dirs and denies every credential path for Read/Grep/Glob/Bash", () => {
    const { res, wt, files } = printArgv(state);
    expect(res.status, res.stderr).toBe(0);
    const { permissions } = JSON.parse(readFileSync(path.join(state, "settings.json"), "utf8"));
    expect(permissions.allow.sort()).toEqual(
      [wt, files].flatMap((d) => ["Read", "Grep", "Glob"].map((t) => `${t}(/${d}/**)`)).sort(),
    );
    for (const p of REQUIRED_DENIES) {
      for (const t of ["Read", "Grep", "Glob"]) expect(permissions.deny).toContain(`${t}(${p})`);
    }
    for (const stem of [".npmrc", ".docker", ".gnupg", ".kube", ".ssh", ".aws", ".config", "Library/Keychains", ".keychain", ".netrc", ".env"]) {
      expect(permissions.deny).toContain(`Bash(*${stem}*)`);
    }
    expect(permissions.deny.some((r) => r.includes(state))).toBe(false);
  });

  it("refuses a state dir under a denied home path", () => {
    for (const root of ["Documents", ".ssh", ".aws", ".gnupg", ".kube", ".docker"]) {
      const { res } = printArgv(path.join(state, root, "x"), { HOME: state });
      expect(res.status, root).toBe(2);
    }
  });

  it("checks out the PR head with core.symlinks=false", () => {
    const lines = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => /\bgit -C "\$(SRC|wt)".*\b(worktree add|checkout)\b.*\$(wt|sha)\b/.test(l));
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).toContain("-c core.symlinks=false");
  });

  it("picks the risky tier fail-closed", () => {
    const tier = (body) => {
      const f = path.join(state, "class.json");
      if (body === null) rmSync(f, { force: true });
      else writeFileSync(f, body);
      const res = spawnSync("/bin/bash", [SCRIPT, "--risky", f], { encoding: "utf8", env: { ...process.env, OVD_REVIEW_STATE: state } });
      expect(res.status, res.stderr).toBe(0);
      return res.stdout.trim();
    };
    expect(tier(JSON.stringify({ door: null, gate_loosening: { detected: false } }))).toBe("no");
    expect(tier(JSON.stringify({ door: "revertable", gate_loosening: [] }))).toBe("no");
    expect(tier(JSON.stringify({ door: "one-way" }))).toBe("yes");
    expect(tier(JSON.stringify({ status: "error" }))).toBe("yes");
    expect(tier(JSON.stringify({ gate_loosening: { detected: true } }))).toBe("yes");
    expect(tier("not json")).toBe("yes");
    expect(tier(null)).toBe("yes");
  });

  it("accepts the verdict only on the first line", () => {
    const check = (text) => {
      const f = path.join(state, "review.md");
      writeFileSync(f, text);
      return spawnSync("/bin/bash", [SCRIPT, "--check-verdict", f], { env: { ...process.env, OVD_REVIEW_STATE: state } }).status;
    };
    expect(check("VERDICT: PASS\nok\n")).toBe(0);
    expect(check("VERDICT: CHANGES_REQUIRED\n")).toBe(0);
    expect(check("Intro\nVERDICT: PASS\n")).toBe(1);
    expect(check("VERDICT: PASSED\n")).toBe(1);
  });
});
