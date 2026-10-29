import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const { res } = printArgv(path.join(state, "Documents", "x"), { HOME: state });
    expect(res.status).toBe(2);
  });
});
