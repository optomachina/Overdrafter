// @vitest-environment node
/**
 * OVD-872: .github/workflows/secret-scan.yml.
 *
 * The structure tests pin what Blaine approved (report mode, pull_request only,
 * contents: read, SHA-pinned actions and gitleaks binary, base copies only).
 * The step tests run each `run:` block the way GitHub does (`bash -e`) with a
 * stub gitleaks and stub curl, and check that clean, findings and crash cases
 * all write a step summary and exit as documented.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { GIT_BIN } from "./check-secret-paths.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = ".github/workflows/secret-scan.yml";
const workflowText = readFileSync(join(repoRoot, WORKFLOW_PATH), "utf8");
const workflow = parse(workflowText);
const job = workflow.jobs["secret-scan"];
const step = (id) => {
  const found = job.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step with id ${id}`);
  return found;
};

// Verified on 2026-10-16: each tag ref resolves to this commit, and the hash is
// the linux_x64 line of gitleaks_8.30.1_checksums.txt (it also matches the
// release asset digest GitHub reports).
const PINNED_ACTIONS = {
  "actions/checkout": { sha: "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09", tag: "v5.1.0" },
  "actions/upload-artifact": { sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", tag: "v4.6.2" },
};
const GITLEAKS_VERSION = "8.30.1";
const GITLEAKS_SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";
const CHECKER_PATH = "scripts/check-secret-paths.mjs";

// Synthetic secret-shaped value, assembled at runtime so no matching literal
// is ever committed to this repo.
const AWS_KEY = ["AK", "IA", "Q7Z3", "X9W2", "V5U4", "T6S8"].join("");

const temps = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const git = (cwd, ...args) => execFileSync(GIT_BIN, [
  "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args,
], { cwd, encoding: "utf8" });

function commit(dir, files, remove = []) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  for (const path of remove) git(dir, "rm", "-q", path);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "fixture");
  return git(dir, "rev-parse", "HEAD").trim();
}

/** A base commit and a PR head commit on top of it; the work tree is the head. */
function prRepo(baseFiles, headFiles, removeOnHead = []) {
  const dir = scratch("secret-scan-repo-");
  git(dir, "init", "-q");
  const base = commit(dir, { "README.md": "fixture\n", ...baseFiles });
  const head = commit(dir, headFiles, removeOnHead);
  return { dir, base, head };
}

let summaries = 0;

/** Run one step's `run:` block as GitHub does (`bash -e <file>`). */
function runStep(id, { cwd, runnerTemp, env = {} }) {
  const scripts = scratch("secret-scan-step-");
  const script = join(scripts, `${id}.sh`);
  writeFileSync(script, step(id).run);
  summaries += 1;
  const summary = join(scripts, `summary-${summaries}.md`);
  const result = spawnSync("bash", ["-e", script], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: summary,
      GITLEAKS_VERSION: job.env.GITLEAKS_VERSION,
      GITLEAKS_SHA256: job.env.GITLEAKS_SHA256,
      ...env,
    },
  });
  return { ...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
}

/** Text printed between ::stop-commands::<token> and ::<token>::, or null. */
function stoppedSection(stdout) {
  const start = stdout.match(/^::stop-commands::(\S+)$/m);
  if (!start) return null;
  const end = stdout.indexOf(`\n::${start[1]}::`);
  return end === -1 ? null : stdout.slice(start.index + start[0].length, end);
}

describe("secret-scan workflow structure", () => {
  it("triggers on pull_request only", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflowText).not.toMatch(/pull_request_target|workflow_run|merge_group/);
  });

  it("grants contents: read only and uses no secrets or token", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(workflowText).not.toMatch(/\bsecrets\.|github\.token|GITHUB_TOKEN/);
  });

  it("pins every action by full commit sha, with the tag as a comment", () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => s.uses);
    expect(uses.map((u) => u.split("@")[0]).sort()).toEqual(Object.keys(PINNED_ACTIONS).sort());
    for (const value of uses) {
      const [action, sha] = value.split("@");
      expect(sha).toBe(PINNED_ACTIONS[action].sha);
      expect(workflowText).toContain(`uses: ${value} # ${PINNED_ACTIONS[action].tag}`);
    }
  });

  it("checks out full history without persisting credentials", () => {
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
  });

  it("is report mode, and the ci aggregate does not need it", () => {
    expect(job["continue-on-error"]).toBe(true);
    expect(job.name).toBe("secret-scan");
    expect(step("paths").run).not.toContain("--enforce");
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toMatch(/secret-scan|check-secret-paths|gitleaks/);
  });

  it("passes every expression through env:, never into a run block", () => {
    for (const s of job.steps.filter((x) => x.run)) expect(s.run, s.name).not.toContain("${{");
    expect(job.env.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(job.env.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
  });

  it("pins the gitleaks release by version and SHA-256", () => {
    expect(job.env.GITLEAKS_VERSION).toBe(GITLEAKS_VERSION);
    expect(job.env.GITLEAKS_SHA256).toBe(GITLEAKS_SHA256);
    const install = step("install").run;
    expect(install).toContain('"https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${tarball}"');
    expect(install).toContain('echo "${GITLEAKS_SHA256}  $RUNNER_TEMP/$tarball" | sha256sum -c -');
  });

  it("scans the PR range only, redacted, with the base config and an empty ignore list", () => {
    const scan = step("scan").run;
    for (const flag of ["--redact", '--log-opts="${BASE_SHA}..${HEAD_SHA}"', '--config "$RUNNER_TEMP/gitleaks.toml"', '--gitleaks-ignore-path "$RUNNER_TEMP/gitleaksignore-empty"']) {
      expect(scan).toContain(flag);
    }
    expect(scan).not.toMatch(/\s(?:-v|--verbose)\b/);
    expect(step("base").run).toContain("rm -f .gitleaksignore");
  });

  it("still installs and runs gitleaks when the path block step fails", () => {
    expect(step("install").if).toBe("${{ !cancelled() && steps.base.outcome == 'success' }}");
    expect(step("scan").if).toBe("${{ !cancelled() && steps.install.outcome == 'success' }}");
    const upload = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.if).toBe("${{ !cancelled() }}");
    expect(upload.with.path).toBe("${{ runner.temp }}/gitleaks-report.json");
  });

  it("every run block is valid bash", () => {
    for (const s of job.steps.filter((x) => x.run)) {
      const result = spawnSync("bash", ["-n"], { input: s.run, encoding: "utf8" });
      expect(result.status, `${s.name}: ${result.stderr}`).toBe(0);
    }
  });
});

// These build real git repos; allow for a loaded runner.
describe("base step under bash -e", { timeout: 30_000 }, () => {
  const realChecker = readFileSync(join(repoRoot, CHECKER_PATH), "utf8");
  const baseConfig = "# BASE CONFIG\n[extend]\nuseDefault = true\n";

  it("loads the base config and path block, never the PR's copies", () => {
    const { dir, base, head } = prRepo(
      { ".gitleaks.toml": baseConfig, [CHECKER_PATH]: realChecker },
      {
        ".gitleaks.toml": `${baseConfig}[[allowlists]]\npaths = ['''.*''']\n`,
        [CHECKER_PATH]: 'console.log("HEAD COPY");\n',
        ".gitleaksignore": "abc:src/a.ts:generic-api-key:1\n",
      },
    );
    const runnerTemp = scratch("secret-scan-runner-");
    const { status, stdout, summary } = runStep("base", { cwd: dir, runnerTemp, env: { BASE_SHA: base, HEAD_SHA: head } });
    expect(status).toBe(0);
    expect(readFileSync(join(runnerTemp, "gitleaks.toml"), "utf8")).toBe(baseConfig);
    expect(readFileSync(join(runnerTemp, "check-secret-paths.mjs"), "utf8")).toBe(realChecker);
    expect(readFileSync(join(runnerTemp, "gitleaksignore-empty"), "utf8")).toBe("");
    expect(existsSync(join(dir, ".gitleaksignore"))).toBe(false);
    expect(stdout).toContain("gitleaks config: base .gitleaks.toml");
    expect(summary).toContain("- gitleaks config: base .gitleaks.toml");
    expect(summary).toContain("- path block: base scripts/check-secret-paths.mjs");
  });

  it("uses gitleaks default rules and skips the path block when the base has neither", () => {
    const { dir, base, head } = prRepo({}, { ".gitleaks.toml": "[[allowlists]]\npaths = ['''.*''']\n", [CHECKER_PATH]: realChecker });
    const runnerTemp = scratch("secret-scan-runner-");
    const { status, summary } = runStep("base", { cwd: dir, runnerTemp, env: { BASE_SHA: base, HEAD_SHA: head } });
    expect(status).toBe(0);
    expect(readFileSync(join(runnerTemp, "gitleaks.toml"), "utf8")).toBe("[extend]\nuseDefault = true\n");
    expect(existsSync(join(runnerTemp, "check-secret-paths.mjs"))).toBe(false);
    expect(summary).toContain("- gitleaks config: gitleaks default rules (the base has no .gitleaks.toml)");
    expect(summary).toContain("- path block: none (the base has no path block yet, so that step is skipped)");
  });

  it("refuses an empty or unknown sha before reading anything, with a summary", () => {
    const { dir, head } = prRepo({ ".gitleaks.toml": baseConfig }, { "src/a.ts": "x\n" });
    // An empty BASE_SHA would make "$BASE_SHA:.gitleaks.toml" read the index.
    const cases = [
      ["", "BASE_SHA or HEAD_SHA is not a full commit sha"],
      ["f".repeat(40), "the base or head commit is not in the checkout"],
    ];
    for (const [baseSha, reason] of cases) {
      const runnerTemp = scratch("secret-scan-runner-");
      const { status, summary } = runStep("base", { cwd: dir, runnerTemp, env: { BASE_SHA: baseSha, HEAD_SHA: head } });
      expect(status).toBe(1);
      expect(summary).toContain(`**ERROR: ${reason} (exit 2), so nothing was scanned.**`);
      expect(existsSync(join(runnerTemp, "gitleaks.toml"))).toBe(false);
    }
  });
});

describe("path block step under bash -e", { timeout: 30_000 }, () => {
  const realChecker = readFileSync(join(repoRoot, CHECKER_PATH), "utf8");

  function runPaths(baseFiles, headFiles) {
    const { dir, base, head } = prRepo(baseFiles, headFiles);
    const runnerTemp = scratch("secret-scan-runner-");
    const env = { BASE_SHA: base, HEAD_SHA: head };
    expect(runStep("base", { cwd: dir, runnerTemp, env }).status).toBe(0);
    return runStep("paths", { cwd: dir, runnerTemp, env });
  }

  it("reports blocked paths and gate_loosening without failing (report mode)", () => {
    const { status, stdout, summary } = runPaths(
      { [CHECKER_PATH]: realChecker, ".gitleaks.toml": "[extend]\nuseDefault = true\n" },
      { ".env.local": `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`, ".gitleaks.toml": "[extend]\nuseDefault = true\n# edited\n" },
    );
    expect(status).toBe(0);
    expect(summary).toContain("**Blocked sensitive paths. Report mode: this does not block merging.**");
    expect(summary).toContain("**GATE LOOSENING: needs a Grok Bot countersign plus Blaine's card.**");
    expect(summary).toContain("BLOCKED .env.local [env]");
    expect(summary).not.toContain("ERROR");
    expect(stoppedSection(stdout)).toContain("BLOCKED .env.local [env]");
    expect(`${stdout}${summary}`).not.toContain(AWS_KEY);
  });

  it("passes a clean PR", () => {
    const { status, summary } = runPaths({ [CHECKER_PATH]: realChecker }, { "src/a.ts": "export {};\n" });
    expect(status).toBe(0);
    expect(summary).toContain("secret-paths: OK");
    expect(summary).not.toMatch(/ERROR|BLOCKED|GATE LOOSENING/);
  });

  it("skips, and says so, when the base has no path block", () => {
    const { status, summary } = runPaths({}, { [CHECKER_PATH]: realChecker, ".env.local": "X=1\n" });
    expect(status).toBe(0);
    expect(summary).toContain("Skipped: the base has no `scripts/check-secret-paths.mjs` yet, and the PR's own copy is never used.");
  });

  it("a checker that crashes or prints no result writes the summary and fails the step", () => {
    const { dir, base, head } = prRepo({}, { "src/a.ts": "x\n" });
    const cases = [
      ['process.stdout.write("::error::injected\\n");\nprocess.stderr.write("boom\\n");\nprocess.exit(2);\n', 2],
      ["process.exit(0);\n", 0],
    ];
    for (const [source, code] of cases) {
      const runnerTemp = scratch("secret-scan-runner-");
      writeFileSync(join(runnerTemp, "check-secret-paths.mjs"), source);
      const { status, stdout, summary } = runStep("paths", { cwd: dir, runnerTemp, env: { BASE_SHA: base, HEAD_SHA: head } });
      expect(status).toBe(1);
      expect(summary).toContain(`**ERROR: the path block exited ${code} without a result, so paths were not checked.**`);
      if (code === 2) {
        expect(summary).toContain("boom");
        // PR-controlled output cannot issue workflow commands.
        expect(stoppedSection(stdout)).toContain("::error::injected");
      }
    }
  });
});

const hasSha256sum = spawnSync("sh", ["-c", "command -v sha256sum"], { encoding: "utf8" }).status === 0;

describe("install step under bash -e", { timeout: 30_000 }, () => {
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;

  /** A stub gitleaks in a tarball, and a curl stub that serves it (or fails). */
  function fixtures(curlExit = 0) {
    const stubDir = scratch("secret-scan-stub-");
    writeFileSync(join(stubDir, "gitleaks"), '#!/bin/sh\necho "8.30.1"\n');
    chmodSync(join(stubDir, "gitleaks"), 0o755);
    const tarball = join(scratch("secret-scan-tar-"), "gitleaks.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", stubDir, "gitleaks"]);
    const bin = scratch("secret-scan-bin-");
    const urls = join(bin, "urls");
    writeFileSync(join(bin, "curl"), [
      "#!/bin/sh",
      `[ ${curlExit} -eq 0 ] || exit ${curlExit}`,
      'out=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      `    https://*) echo "$1" >> "${urls}"; shift ;;`,
      "    *) shift ;;",
      "  esac",
      "done",
      `cp "${tarball}" "$out"`,
      "",
    ].join("\n"));
    chmodSync(join(bin, "curl"), 0o755);
    const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    return { bin, urls, sha256 };
  }

  function install({ bin, sha256 }) {
    const runnerTemp = scratch("secret-scan-runner-");
    const result = runStep("install", { cwd: runnerTemp, runnerTemp, env: { PATH: `${bin}:${process.env.PATH}`, GITLEAKS_SHA256: sha256 } });
    return { ...result, installed: existsSync(join(runnerTemp, "gitleaks", "gitleaks")) };
  }

  it.skipIf(!hasSha256sum)("installs a tarball that matches the pinned SHA-256", () => {
    const f = fixtures();
    const { status, stdout, summary, installed } = install(f);
    expect(status).toBe(0);
    expect(installed).toBe(true);
    expect(stdout).toContain("8.30.1");
    expect(readFileSync(f.urls, "utf8").trim()).toBe(url);
    expect(summary).toBe("");
  });

  it.skipIf(!hasSha256sum)("refuses a tarball that does not match, with a summary", () => {
    const f = fixtures();
    const { status, summary, installed } = install({ ...f, sha256: GITLEAKS_SHA256 });
    expect(status).toBe(1);
    expect(installed).toBe(false);
    expect(summary).toMatch(/\*\*ERROR: gitleaks 8\.30\.1 could not be downloaded, matched to its pinned SHA-256, or started \(exit 1\), so this PR's commits were not scanned\.\*\*/);
  });

  it("a failed download writes the summary and fails the step", () => {
    const f = fixtures(22);
    const { status, summary, installed } = install(f);
    expect(status).toBe(1);
    expect(installed).toBe(false);
    expect(summary).toContain("could not be downloaded, matched to its pinned SHA-256, or started (exit 22)");
  });
});

describe("gitleaks step under bash -e (stub gitleaks)", { timeout: 30_000 }, () => {
  const BASE = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const STUB = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    "fs.writeFileSync(process.env.STUB_ARGS, JSON.stringify(args));",
    "const value = (flag) => args[args.indexOf(flag) + 1];",
    'const report = value("--report-path");',
    'const exitCode = Number(value("--exit-code"));',
    "const marker = process.env.STUB_MARKER;",
    "const finding = (rule, file, line) => ({ RuleID: rule, File: file, StartLine: line, Commit: \"abcdef1234567890\", Secret: marker, Match: marker, Line: marker });",
    "switch (process.env.STUB_MODE) {",
    '  case "clean": fs.writeFileSync(report, "[]"); console.log("INF no leaks found\\n::error::injected"); process.exit(0);',
    '  case "findings": fs.writeFileSync(report, JSON.stringify([finding("aws-access-token", "src/config.ts", 3), finding("stripe-access-token", "worker/pay.ts", 9)])); console.log("WRN leaks found: 2"); process.exit(exitCode);',
    '  case "panic": process.stderr.write("panic: boom\\n"); process.exit(2);',
    '  case "fatal": process.stderr.write("FTL failed to load config\\n"); process.exit(1);',
    '  case "silent": process.exit(0);',
    '  case "mismatch": fs.writeFileSync(report, "[]"); process.exit(exitCode);',
    "}",
    "",
  ].join("\n");

  function scan(mode, { staleReport = false } = {}) {
    const runnerTemp = scratch("secret-scan-runner-");
    mkdirSync(join(runnerTemp, "gitleaks"));
    writeFileSync(join(runnerTemp, "gitleaks", "gitleaks"), STUB);
    chmodSync(join(runnerTemp, "gitleaks", "gitleaks"), 0o755);
    if (staleReport) writeFileSync(join(runnerTemp, "gitleaks-report.json"), JSON.stringify([{ RuleID: "stale" }]));
    const argsFile = join(scratch("secret-scan-args-"), "args.json");
    const result = runStep("scan", {
      cwd: runnerTemp,
      runnerTemp,
      env: { BASE_SHA: BASE, HEAD_SHA: HEAD, STUB_MODE: mode, STUB_ARGS: argsFile, STUB_MARKER: AWS_KEY },
    });
    return { ...result, runnerTemp, args: JSON.parse(readFileSync(argsFile, "utf8")) };
  }

  it("calls gitleaks on the PR range with redaction, the base config and an empty ignore list", () => {
    const { args, runnerTemp } = scan("clean");
    expect(args).toEqual([
      "git",
      "--no-banner",
      "--redact",
      "--config", join(runnerTemp, "gitleaks.toml"),
      "--gitleaks-ignore-path", join(runnerTemp, "gitleaksignore-empty"),
      `--log-opts=${BASE}..${HEAD}`,
      "--report-format", "json",
      "--report-path", join(runnerTemp, "gitleaks-report.json"),
      "--exit-code", "3",
      ".",
    ]);
  });

  it("clean: writes the summary and passes", () => {
    const { status, stdout, summary } = scan("clean");
    expect(status).toBe(0);
    expect(summary).toContain("No secrets found in this PR's commits (gitleaks 8.30.1, redacted).");
    expect(summary).not.toContain("ERROR");
    // PR-controlled scanner output cannot issue workflow commands.
    expect(stoppedSection(stdout)).toContain("::error::injected");
  });

  it("findings: lists rule, file and line only, warns, and does not fail (report mode)", () => {
    const { status, stdout, summary } = scan("findings");
    expect(status).toBe(0);
    expect(summary).toContain("**2 possible secret(s) in this PR's commits. Report mode: this does not block merging.**");
    expect(summary).toContain("- aws-access-token in src/config.ts:3 (commit abcdef123456)");
    expect(summary).toContain("- stripe-access-token in worker/pay.ts:9 (commit abcdef123456)");
    expect(stdout).toMatch(/^::warning title=secret-scan::gitleaks found 2 possible secret\(s\)/m);
    // Even an unredacted Secret, Match or Line field is never printed.
    expect(`${stdout}${summary}`).not.toContain(AWS_KEY);
  });

  it.each([
    ["panic", 2, "panic: boom"],
    ["fatal", 1, "FTL failed to load config"],
    ["silent", 0, ""],
    ["mismatch", 3, ""],
  ])("%s: writes an ERROR summary and fails the step (exit %i)", (mode, code, log) => {
    const { status, summary } = scan(mode, { staleReport: true });
    expect(status).toBe(1);
    expect(summary).toContain(`**ERROR: gitleaks did not produce a usable report (exit ${code}), so this PR's commits were not scanned.**`);
    expect(summary).toContain(log);
    expect(summary).not.toContain("stale");
  });
});
