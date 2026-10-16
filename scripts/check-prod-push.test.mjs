// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  BASELINE_PATH,
  CHECKER_PATH,
  PATTERNS,
  SELF_EXEMPT,
  isInScope,
  scanText,
} from "./check-prod-push.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const checkerFile = join(repoRoot, CHECKER_PATH);
const wrapperFile = join(repoRoot, "scripts/check-prod-push.node-test.mjs");
// Joined so this file never holds either ref as one literal.
const PROD_REF = ["ozuatdcake", "zjtevztjlr"].join("");
const STAGING_REF = ["ldmambwtks", "fvqdufhaam"].join("");

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function git(root, args) {
  return execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeFiles(root, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

function commit(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", message]);
}

function fixtureRepo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "prod-push-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  writeFiles(root, files);
  commit(root, "base");
  return root;
}

function scan(root, args, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!("GITHUB_STEP_SUMMARY" in env)) delete childEnv.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [checkerFile, "--root", root, ...args], { encoding: "utf8", env: childEnv });
}

function scanJson(root, args) {
  const result = scan(root, [...args, "--json"]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function fresh(report) {
  return report.findings.filter((finding) => !finding.baselined);
}

describe("prod-push scan patterns", () => {
  const samples = {
    supabase_db_push: "npx supabase db push",
    linked_flag: "supabase link --linked",
    db_url_flag: 'supabase db dump --db-url "$URL"',
    migration_up: "supabase migration up",
    db_reset_linked: "supabase db reset --linked",
    prod_project_ref: `SUPABASE_PROJECT_REF=${PROD_REF}`,
  };

  it("has a sample for every pattern", () => {
    expect(Object.keys(samples).sort()).toEqual(PATTERNS.map((pattern) => pattern.id).sort());
  });

  it.each(Object.entries(samples))("flags %s", (id, line) => {
    const patterns = scanText("scripts/run.sh", `#!/bin/sh\n${line}\n`).map((finding) => finding.pattern);
    expect(patterns).toContain(id);
  });

  it("flags a .yml mention", () => {
    const findings = scanText(".github/workflows/deploy.yml", "      - run: supabase db push\n");
    expect(findings).toMatchObject([{ file: ".github/workflows/deploy.yml", line: 1, pattern: "supabase_db_push" }]);
  });

  it("flags a .mjs mention", () => {
    const findings = scanText("worker/src/target.mjs", `const ref = "${PROD_REF}";\n`);
    expect(findings).toMatchObject([{ file: "worker/src/target.mjs", line: 1, pattern: "prod_project_ref" }]);
  });

  it("exempts docs", () => {
    const text = `supabase db push --linked\n${PROD_REF}\n`;
    expect(scanText("scripts/README.md", text)).toEqual([]);
    expect(scanText(".github/notes.MD", text)).toEqual([]);
    expect(scanText("docs/runbooks/release.sh", text)).toEqual([]);
  });

  it("does not flag the staging ref", () => {
    expect(scanText("scripts/seed.mjs", `const ref = "${STAGING_REF}";\n`)).toEqual([]);
  });

  it("scans only package.json scripts entries", () => {
    const pkg = JSON.stringify(
      { description: "supabase db push", scripts: { "db:push": "supabase db push", build: "vite build" } },
      null,
      2,
    );
    expect(scanText("package.json", pkg)).toMatchObject([
      { file: "package.json", location: "scripts.db:push", pattern: "supabase_db_push", line: 4 },
    ]);
  });

  it("ignores files outside .github, scripts, worker and package.json", () => {
    expect(isInScope("src/lib/push.ts")).toBe(false);
    expect(isInScope("supabase/config.toml")).toBe(false);
    expect(scanText("src/lib/push.ts", "supabase db push\n")).toEqual([]);
  });
});

describe("prod-push scan self-exemption", () => {
  it("exempts the checker, its tests and its baseline by path", () => {
    expect([...SELF_EXEMPT].sort()).toEqual(
      [CHECKER_PATH, BASELINE_PATH, "scripts/check-prod-push.node-test.mjs", "scripts/check-prod-push.test.mjs"].sort(),
    );
    const source = readFileSync(checkerFile, "utf8");
    expect(scanText(CHECKER_PATH, source)).toEqual([]);
  });

  it("builds the production ref so the checker source does not match it elsewhere", () => {
    const source = readFileSync(checkerFile, "utf8");
    const patterns = scanText("scripts/copied-checker.mjs", source).map((finding) => finding.pattern);
    expect(patterns).not.toContain("prod_project_ref");
    expect(patterns.length).toBeGreaterThan(0);
  });

  it.each([CHECKER_PATH, "scripts/check-prod-push.node-test.mjs", "scripts/check-prod-push.test.mjs"])(
    "%s does not hold the production ref as one literal",
    (file) => {
      expect(readFileSync(join(repoRoot, file), "utf8")).not.toContain(PROD_REF);
    },
  );
});

describe("prod-push scan CLI", () => {
  it("report mode exits 0 with findings and writes the step summary", () => {
    const root = fixtureRepo({ ".github/workflows/deploy.yml": "      - run: supabase db push --linked\n" });
    const summary = join(root, "summary.md");
    const result = scan(root, ["--all", "--report"], { GITHUB_STEP_SUMMARY: summary });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".github/workflows/deploy.yml:1: [supabase_db_push]");
    expect(result.stdout).toContain("2 new finding(s)");
    const markdown = readFileSync(summary, "utf8");
    expect(markdown).toContain("### Prod-push scan (report mode)");
    expect(markdown).toContain("| .github/workflows/deploy.yml:1 | linked_flag |");
  });

  it("report mode is the default and --enforce exits 1 on new findings", () => {
    const root = fixtureRepo({ "scripts/push.sh": "supabase db push\n" });
    expect(scan(root, ["--all"]).status).toBe(0);
    expect(scan(root, ["--all", "--enforce"]).status).toBe(1);
  });

  it("report mode exits 0 on a scan error, --enforce exits 2", () => {
    const root = mkdtempSync(join(tmpdir(), "prod-push-nogit-"));
    roots.push(root);
    const report = scan(root, ["--base-ref", "main"]);
    expect(report.status).toBe(0);
    expect(report.stderr).toContain("report mode, not failing");
    expect(scan(root, ["--base-ref", "main", "--enforce"]).status).toBe(2);
  });

  it("rejects usage errors", () => {
    const root = fixtureRepo();
    expect(scan(root, []).status).toBe(2);
    expect(scan(root, ["--base-ref", "main", "--write-baseline"]).status).toBe(2);
  });

  it("baselines existing hits so only new ones count", () => {
    const root = fixtureRepo({ "scripts/push.sh": "supabase db push\n" });
    expect(scan(root, ["--all", "--write-baseline"]).status).toBe(0);
    expect(fresh(scanJson(root, ["--all"]))).toEqual([]);
    writeFiles(root, { "scripts/push.sh": "echo moved\nsupabase db push\nsupabase db push\n" });
    expect(fresh(scanJson(root, ["--all"]))).toMatchObject([{ file: "scripts/push.sh", line: 3 }]);
  });

  it("diff mode scans changed files against the merge-base baseline", () => {
    const root = fixtureRepo({ "scripts/old.sh": "supabase db push\n", "scripts/clean.sh": "echo ok\n" });
    scan(root, ["--all", "--write-baseline"]);
    commit(root, "baseline");
    git(root, ["checkout", "-q", "-b", "feature"]);
    writeFiles(root, {
      "scripts/old.sh": "supabase db push\necho edited\n",
      ".github/workflows/new.yml": "      - run: supabase migration up\n",
      "scripts/notes.md": "supabase db push\n",
    });
    // A head baseline that covers the new hit must not hide it.
    scan(root, ["--all", "--write-baseline"]);
    commit(root, "feature");
    const report = scanJson(root, ["--base-ref", "main"]);
    expect(report.mode).toBe("diff");
    expect(report.baseline).toMatch(/:scripts\/check-prod-push-baseline\.json$/);
    expect(report.findings.map((finding) => [finding.file, finding.baselined])).toEqual([
      [".github/workflows/new.yml", false],
      ["scripts/old.sh", true],
    ]);
  });

  it("regenerates the baseline byte-identically", () => {
    const root = fixtureRepo({
      "scripts/b.sh": "supabase db push --linked\nsupabase db push --linked\n",
      "scripts/a.mjs": `const ref = "${PROD_REF}";\n`,
      ".github/workflows/x.yml": "      - run: supabase db reset --linked\n",
      "package.json": JSON.stringify({ scripts: { "db:push": "supabase db push" } }, null, 2),
    });
    const baseline = join(root, BASELINE_PATH);
    expect(scan(root, ["--all", "--write-baseline"]).status).toBe(0);
    const first = readFileSync(baseline);
    expect(scan(root, ["--all", "--write-baseline"]).status).toBe(0);
    expect(readFileSync(baseline).equals(first)).toBe(true);
    const parsed = JSON.parse(first.toString("utf8"));
    expect(parsed.entries.find((entry) => entry.file === "scripts/b.sh" && entry.pattern === "linked_flag").count).toBe(2);
    expect(first.toString("utf8")).not.toContain(PROD_REF);
    expect(fresh(scanJson(root, ["--all"]))).toEqual([]);
  });

  it("parses the committed baseline", () => {
    const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), "utf8"));
    expect(baseline.schema).toBe("prod-push-baseline.v1");
    expect(baseline.entries.length).toBeGreaterThan(0);
  });
});

describe("prod-push node:test wrapper", () => {
  function runWrapper(root) {
    return spawnSync(process.execPath, ["--test", "scripts/check-prod-push.node-test.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
  }

  const stub = (label, code) =>
    `console.log("${label} COPY " + process.argv.slice(2).join(" "));\nprocess.exitCode = ${code};\n`;

  it("runs the base copy when a PR edits the checker", () => {
    const root = fixtureRepo({ [CHECKER_PATH]: stub("BASE", 0) });
    writeFiles(root, {
      [CHECKER_PATH]: stub("HEAD", 1),
      "scripts/check-prod-push.node-test.mjs": readFileSync(wrapperFile, "utf8"),
    });
    commit(root, "edit checker");
    const result = runWrapper(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("checker from HEAD^1");
    expect(result.stdout).toMatch(/BASE COPY --root \S+ --base-ref HEAD\^1 --report/);
    expect(result.stdout).not.toContain("HEAD COPY");
  });

  it("falls back to the head copy when the base has no checker", () => {
    const root = fixtureRepo();
    writeFiles(root, {
      [CHECKER_PATH]: stub("HEAD", 0),
      "scripts/check-prod-push.node-test.mjs": readFileSync(wrapperFile, "utf8"),
    });
    commit(root, "add checker");
    const result = runWrapper(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/checker from HEAD$/m);
    expect(result.stdout).toContain("HEAD COPY");
  });

  it("does not fail on findings", () => {
    const root = fixtureRepo({ [CHECKER_PATH]: readFileSync(checkerFile, "utf8") });
    writeFiles(root, {
      "scripts/check-prod-push.node-test.mjs": readFileSync(wrapperFile, "utf8"),
      "scripts/push.sh": "supabase db push --linked\n",
    });
    commit(root, "add a hit");
    const result = runWrapper(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("scripts/push.sh:1: [supabase_db_push]");
  });
});
