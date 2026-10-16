// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  CONFIG_PORTS,
  DEFAULT_CONFIG,
  FEATURE_SPECS,
  parseFeatures,
  specsFor,
} from "../.agents/skills/verify-overdrafter/scripts/feature-specs.mjs";
import { isolationProblems, KEY_VARS, URL_VARS } from "../.agents/skills/verify-overdrafter/scripts/isolation.mjs";
import { countResults, verdict } from "../.agents/skills/verify-overdrafter/scripts/verdict.mjs";
import { main as judgeMain } from "./verify-result-judge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, ".agents/skills/verify-overdrafter");
const read = (p) => readFileSync(path.join(skillDir, p), "utf8");

describe("verify-overdrafter skill structure", () => {
  it("has registering frontmatter", () => {
    const skill = read("SKILL.md");
    expect(skill).toMatch(/^---\nname: verify-overdrafter\ndescription: .+\n---/);
    for (const h of ["Launch", "Doctor", "Drive", "Evidence", "Cleanup", "Helpers"]) {
      expect(skill).toContain(`## ${h}`);
    }
  });

  it("indexes every feature file and each has the four H2s in order", () => {
    const index = read("features/README.md");
    const links = [...index.matchAll(/\]\(\.\/([\w-]+\.md)\)/g)].map((m) => m[1]);
    expect(links.sort()).toEqual(["auth.md", "provider.md", "quote.md"]);
    for (const f of links) {
      const h2 = [...read(`features/${f}`).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(h2).toEqual(["Sub-features", "How to get to it (user POV)", "Driving it with Playwright", "Gotchas"]);
    }
  });

  it("maps every index feature to existing e2e specs and shipped scripts", () => {
    expect(Object.keys(FEATURE_SPECS).sort()).toEqual(["auth", "provider", "quote"]);
    for (const entry of Object.values(FEATURE_SPECS)) {
      for (const { spec, config } of [...entry.fixture, ...entry.local]) {
        expect(existsSync(path.join(root, spec)), spec).toBe(true);
        expect(existsSync(path.join(root, config)), config).toBe(true);
        expect(CONFIG_PORTS[config], `${config} port`).toBeTypeOf("number");
      }
    }
    for (const s of ["scripts/verify.sh", "scripts/feature-specs.mjs", "scripts/verdict.mjs", "scripts/isolation.mjs", "run"]) {
      expect(existsSync(path.join(skillDir, s)), s).toBe(true);
      expect(read("SKILL.md")).toContain(s);
    }
    expect(() => specsFor(["nope"], "fixture")).toThrow(/unknown feature/);
  });

  it("fails closed when any requested feature has no specs in the mode", () => {
    expect(() => specsFor(["auth", "provider"], "local")).toThrow(/provider has no local specs/);
    expect(specsFor(["auth", "provider"], "fixture").length).toBeGreaterThan(0);
  });

  it("rejects empty feature tokens", () => {
    for (const list of ["", " ", "auth,", ",auth", "auth,,quote"]) {
      expect(() => parseFeatures(list), JSON.stringify(list)).toThrow(/feature/);
    }
    expect(parseFeatures("auth, quote")).toEqual(["auth", "quote"]);
  });

  it("keeps evidence gitignored and the skill listed in AGENTS.md", () => {
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("/artifacts/verify-overdrafter/");
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("`verify-overdrafter`");
  });

  it("drives another app root into a fixed evidence dir", () => {
    const out = execFileSync(path.join(skillDir, "scripts/verify.sh"), ["--features", "quote", "--dry-run", "--out", "/tmp/vo-out"], {
      env: { ...process.env, VERIFY_APP_ROOT: root },
      encoding: "utf8",
    });
    expect(out).toContain("PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/vo-out/playwright-report-0.json");
    expect(out).toContain("e2e/quote-comparison.spec.ts");
    // A relative --out is anchored at the app root, not at a config's directory.
    const rel = execFileSync(path.join(skillDir, "scripts/verify.sh"), ["--features", "quote", "--dry-run", "--out", "vo-rel"], {
      env: { ...process.env, VERIFY_APP_ROOT: root },
      encoding: "utf8",
    });
    expect(rel).toContain(`PLAYWRIGHT_JSON_OUTPUT_NAME=${root}/vo-rel/playwright-report-0.json`);
  });

  it("CI runs head code in one job and judges in a base-only job, read-only and without secrets", () => {
    const wf = readFileSync(path.join(root, ".github/workflows/verify.yml"), "utf8");
    const runJob = wf.slice(wf.indexOf("\n  verify-run:"), wf.indexOf("\n  verify-judge:"));
    const judgeJob = wf.slice(wf.indexOf("\n  verify-judge:"));
    expect(runJob).toContain("bash base/.agents/skills/verify-overdrafter/run --app-root head");
    expect(runJob).not.toContain("verify-result-judge");
    expect(judgeJob).toContain("needs: verify-run");
    expect(judgeJob).toContain("node base/scripts/verify-result-judge.mjs --expected-sha \"$HEAD_SHA\"");
    expect(judgeJob).toContain("--harness-recorded \"$HARNESS_RECORDED\"");
    // The judge job never checks out or runs the PR head.
    expect(judgeJob).not.toMatch(/path: head|ref: \$\{\{ env\.HEAD_SHA|--app-root|npm (ci|run)/);
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(wf).not.toMatch(/\$\{\{\s*secrets\.|pull_request_target|: write/);
    expect(wf).toContain("VERIFY_MODE: report");
  });
});

describe("verify-overdrafter driver behavior", () => {
  const verify = path.join(skillDir, "scripts/verify.sh");
  const cleanEnv = () => {
    const env = { ...process.env };
    for (const k of [...URL_VARS, ...KEY_VARS]) delete env[k];
    return env;
  };
  const run = (...args) => spawnSync("bash", [verify, ...args], { cwd: root, encoding: "utf8", env: cleanEnv() });
  const runEnv = (extra, ...args) =>
    spawnSync("bash", [verify, ...args], { cwd: root, encoding: "utf8", env: { ...cleanEnv(), ...extra } });

  it("rejects unknown, empty and spec-less feature selections", () => {
    for (const args of [
      ["--features", "bogus"],
      ["--features", ""],
      ["--features", "auth,"],
      ["--mode", "local", "--features", "provider"],
      ["--mode", "local", "--features", "auth,provider"],
    ]) {
      const r = run(...args, "--dry-run");
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).not.toContain("playwright test");
    }
    expect(run("--features", "auth,", "--dry-run").stderr).toContain("empty feature name");
    expect(run("--mode", "local", "--features", "auth,provider", "--dry-run").stderr).toContain("provider has no local specs");
  });

  it("runs admin-operations under its own config", () => {
    const r = run("--features", "provider", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--config e2e\/admin-operations\.config\.ts e2e\/admin-operations\.spec\.ts /);
    expect(r.stdout).not.toMatch(/--config playwright\.config\.ts [^\n]*admin-operations/);
  });

  it("doctor and --prepare refuse non-local targets without printing them", () => {
    const secret = "https://abcdefghijklmnop.supabase.co";
    for (const [name, value] of [
      ["VITE_SUPABASE_URL", secret],
      ["PLAYWRIGHT_BASE_URL", "https://app.overdrafter.example"],
      ["SUPABASE_URL", secret],
      ["SUPABASE_SERVICE_ROLE_KEY", "sb_secret_notlocal"],
    ]) {
      const doctor = runEnv({ [name]: value }, "--doctor");
      expect(doctor.status, name).not.toBe(0);
      expect(doctor.stdout).toContain(`FAIL ${name}`);
      expect(doctor.stdout + doctor.stderr).not.toContain(value);
      const prepare = runEnv({ [name]: value }, "--mode", "local", "--prepare", "--features", "auth");
      expect(prepare.status, name).toBe(1);
      expect(prepare.stdout).toContain(`FAIL ${name}`);
      expect(prepare.stdout + prepare.stderr).not.toContain(value);
      expect(prepare.stdout).not.toContain("e2e:prepare");
    }
  }, 60_000);

  it("doctor fails when any listener holds a config port", async () => {
    const server = net.createServer();
    const listening = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(CONFIG_PORTS["e2e/admin-operations.config.ts"], "127.0.0.1", () => resolve(true));
    });
    // Not an HTTP server: a bare TCP listener must still trip the guard.
    try {
      const r = run("--doctor", "--features", "provider");
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain("FAIL port 4174");
    } finally {
      if (listening) await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects --prepare in fixture mode and unknown modes", () => {
    expect(run("--prepare", "--dry-run").status).toBe(2);
    expect(run("--mode", "prod", "--dry-run").status).toBe(2);
  });

  it("dry-run prints the mapped specs and the lane filter", () => {
    const fixture = run("--features", "quote", "--dry-run");
    expect(fixture.status).toBe(0);
    expect(fixture.stdout).toContain("e2e/quote-comparison.spec.ts");
    expect(fixture.stdout).toContain("--grep @fixture");
    expect(fixture.stdout).toContain("--config playwright.config.ts");
    const local = run("--mode", "local", "--features", "auth", "--dry-run");
    expect(local.status).toBe(0);
    expect(local.stdout).toContain("e2e/access-scope.spec.ts");
    expect(local.stdout).toContain("--grep-invert @fixture");
  });
});

describe("verify-overdrafter lane mapping", () => {
  const spec = (p) => readFileSync(path.join(root, p), "utf8");

  it("fixture specs carry the @fixture tag and are not fixture-only in local lanes", () => {
    for (const [name, entry] of Object.entries(FEATURE_SPECS)) {
      for (const { spec: p } of entry.fixture) expect(spec(p), `${name} fixture ${p}`).toContain("@fixture");
      for (const { spec: p } of entry.local) {
        const src = spec(p);
        const tests = (src.match(/^\s*test(\.\w+)?\(/gm) ?? []).length;
        const tagged = (src.match(/@fixture"/g) ?? []).length;
        expect(tests, `${name} local ${p} must have a non-fixture test`).toBeGreaterThan(tagged);
        expect(src, `${name} local ${p}`).not.toMatch(/describe\([^)]*@fixture/);
      }
    }
  });

  it("does not list a spec in both lanes", () => {
    const all = Object.values(FEATURE_SPECS);
    const fx = new Set(all.flatMap((e) => e.fixture.map((s) => s.spec)));
    for (const { spec: p } of all.flatMap((e) => e.local)) expect(fx.has(p), p).toBe(false);
  });

  // A top-level test.skip() silently turns a whole spec into skips. Each one
  // must gate on a baseURL that the config the spec is mapped to actually serves.
  const skipMismatches = (entries) => {
    const bad = [];
    for (const { spec: p, config } of entries) {
      const configSrc = readFileSync(path.join(root, config), "utf8");
      if (config !== DEFAULT_CONFIG) {
        const match = configSrc.match(/testMatch:\s*"([^"]+)"/);
        if (!match || path.basename(p) !== match[1]) bad.push(`${p}: ${config} testMatch does not select it`);
      }
      for (const line of spec(p).split("\n").filter((l) => /^test\.skip\(/.test(l))) {
        const url = line.match(/baseURL !== "([^"]+)"/)?.[1];
        if (!url) bad.push(`${p}: unconditional or unrecognized top-level test.skip`);
        else if (!configSrc.includes(`"${url}"`)) bad.push(`${p}: skips unless ${url}, which ${config} does not serve`);
      }
    }
    return bad;
  };

  it("runs every mapped spec under a config where its top-level skips do not fire", () => {
    const entries = Object.values(FEATURE_SPECS).flatMap((e) => [...e.fixture, ...e.local]);
    expect(skipMismatches(entries)).toEqual([]);
  });

  it("catches a spec mapped to a config its top-level skip rejects", () => {
    expect(skipMismatches([{ spec: "e2e/admin-operations.spec.ts", config: DEFAULT_CONFIG }])).toHaveLength(1);
  });

  it("tracks the skill in git despite the ignored .agents directory", () => {
    const r = spawnSync("git", ["ls-files", ".agents/skills/verify-overdrafter"], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) return;
    for (const f of ["SKILL.md", "scripts/verify.sh", "scripts/feature-specs.mjs", "features/README.md"]) {
      expect(r.stdout, f).toContain(`.agents/skills/verify-overdrafter/${f}`);
    }
  });
});

describe("verify-overdrafter verdict", () => {
  const t = (status, expectedStatus = "passed") => ({ status, expectedStatus });
  const report = (...tests) => ({ suites: [{ specs: [{ tests: tests.slice(0, 1) }], suites: [{ specs: [{ tests: tests.slice(1) }] }] }] });
  const counts = (o) => ({ passed: 0, failed: 0, skipped: 0, expectedFail: 0, flaky: 0, ...o });

  it("counts nested results by status", () => {
    expect(countResults(report(t("expected"), t("skipped"), t("expected", "failed"), t("flaky"), t("unexpected")))).toEqual(
      counts({ passed: 1, skipped: 1, expectedFail: 1, flaky: 1, failed: 1 }),
    );
    expect(countResults({ suites: [] })).toEqual(counts({}));
    expect(() => countResults({})).toThrow(/Playwright/);
  });

  it("fails closed on failures, skips, zero passes and missing counts", () => {
    expect(verdict({ exitCodes: [0], counts: counts({ passed: 3, expectedFail: 1 }) })).toBe("PASS");
    expect(verdict({ exitCodes: [0, 1], counts: counts({ passed: 3 }) })).toBe("FAIL");
    expect(verdict({ exitCodes: [0], counts: counts({ passed: 3, failed: 1 }) })).toBe("FAIL");
    expect(verdict({ exitCodes: [1], counts: null })).toBe("FAIL");
    expect(verdict({ exitCodes: [0], counts: null })).toBe("INCOMPLETE");
    expect(verdict({ exitCodes: [0], counts: counts({ passed: 3, skipped: 1 }) })).toBe("INCOMPLETE");
    expect(verdict({ exitCodes: [0], counts: counts({ skipped: 6 }) })).toBe("INCOMPLETE");
    expect(verdict({ exitCodes: [0], counts: counts({}) })).toBe("INCOMPLETE");
    expect(verdict({ exitCodes: [0], counts: counts({ expectedFail: 2 }) })).toBe("INCOMPLETE");
    expect(verdict({ exitCodes: [0], counts: counts({ passed: 2, flaky: 1 }) })).toBe("INCOMPLETE");
  });

  it("the CLI sums runs and exits non-zero unless PASS", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-overdrafter-"));
    const ok = path.join(dir, "ok.json");
    const skipped = path.join(dir, "skipped.json");
    writeFileSync(ok, JSON.stringify(report(t("expected"), t("expected"))));
    writeFileSync(skipped, JSON.stringify(report(t("skipped"))));
    const cli = (...args) =>
      spawnSync("node", [path.join(skillDir, "scripts/verdict.mjs"), ...args], { encoding: "utf8" });
    const pass = cli(`0:${ok}`);
    expect(pass.status).toBe(0);
    expect(pass.stdout).toContain("tests: passed=2 failed=0 skipped=0");
    expect(pass.stdout).toContain("verdict: PASS");
    const partial = cli(`0:${ok}`, `0:${skipped}`);
    expect(partial.status).toBe(3);
    expect(partial.stdout).toContain("passed=2 failed=0 skipped=1");
    const missing = cli(`0:${ok}`, `0:${path.join(dir, "absent.json")}`);
    expect(missing.status).toBe(3);
    expect(missing.stdout).toContain("tests: unavailable");
    expect(cli().status).toBe(3);
  });
});

describe("verify-overdrafter isolation", () => {
  const demoJwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

  it("accepts unset and localhost targets", () => {
    expect(isolationProblems({})).toEqual([]);
    expect(
      isolationProblems({
        VITE_SUPABASE_URL: "http://127.0.0.1:54321",
        PLAYWRIGHT_BASE_URL: "http://localhost:4173",
        SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        SUPABASE_SERVICE_ROLE_KEY: demoJwt({ iss: "supabase-demo", role: "service_role" }),
      }),
    ).toEqual([]);
  });

  it("rejects hosted URLs, hosted or opaque keys and lookalike hosts", () => {
    expect(
      isolationProblems({
        VITE_SUPABASE_URL: "https://abc.supabase.co",
        SUPABASE_URL: "http://127.0.0.1.evil.example",
        PLAYWRIGHT_BASE_URL: "not a url",
        SUPABASE_ANON_KEY: demoJwt({ iss: "supabase", ref: "abc", role: "anon" }),
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc",
      }),
    ).toEqual(["VITE_SUPABASE_URL", "PLAYWRIGHT_BASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]);
  });
});

// Builds a throwaway app checkout with the mapped spec and config files and a
// fake @playwright/test, plus a fake npx that writes a Playwright JSON report for
// whatever specs verify.sh passes it, each journey ending in `status`.
function fakeApp({ pwExit = 0, status = "expected" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "verify-e2e-"));
  const app = path.join(dir, "app");
  const bin = path.join(dir, "bin");
  for (const { spec } of Object.values(FEATURE_SPECS).flatMap((e) => [...e.fixture, ...e.local])) {
    mkdirSync(path.dirname(path.join(app, spec)), { recursive: true });
    writeFileSync(path.join(app, spec), "// @fixture\n");
  }
  for (const config of Object.keys(CONFIG_PORTS)) {
    mkdirSync(path.dirname(path.join(app, config)), { recursive: true });
    writeFileSync(path.join(app, config), "export default {};\n");
  }
  const pw = path.join(app, "node_modules/@playwright/test");
  mkdirSync(pw, { recursive: true });
  writeFileSync(path.join(pw, "package.json"), '{"name":"@playwright/test","main":"index.js"}');
  writeFileSync(path.join(pw, "index.js"), "");
  const git = (...args) => execFileSync("git", ["-C", app, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture app");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npx"), `#!/usr/bin/env node
const fs = require("fs");
const specs = process.argv.slice(2).filter((a) => a.endsWith(".spec.ts"));
const suites = specs.map((s) => {
  const file = s.replace(/^e2e\\//, "");
  return { title: file, file, specs: [{ title: "journey", file, tests: [{ projectName: "", expectedStatus: "passed", status: "${status}", results: [{ status: "${status === "skipped" ? "skipped" : "passed"}" }] }] }] };
});
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites, errors: [] }));
process.exit(${pwExit});
`);
  chmodSync(path.join(bin, "npx"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const k of [...URL_VARS, ...KEY_VARS]) delete env[k];
  return { dir, app, sha: git("rev-parse", "HEAD").trim(), env };
}

describe("verify-overdrafter run entrypoint and judge, end to end", () => {
  const runScript = path.join(skillDir, "run");
  const judgeDir = (sha, dir, ...extra) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const out = path.join(dir, "verify-result.json");
    const code = judgeMain(["--expected-sha", sha, "--features", "quote", "--out", out, ...extra]);
    vi.restoreAllMocks();
    return { code, result: JSON.parse(readFileSync(out, "utf8")) };
  };

  it("a clean verify.sh run at the head SHA passes the judge; another SHA or a dirty tree fails", () => {
    const { dir, app, sha, env } = fakeApp();
    const out = path.join(dir, "out");
    const r = spawnSync("bash", [runScript, "--app-root", app, "--out", out, "--modes", "fixture", "--features", "quote"], { env, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(path.join(out, "fixture/manifest.txt"), "utf8")).toContain(`git head: ${sha} (clean tree)`);

    const pass = judgeDir(sha, dir, path.join(out, "fixture"));
    expect(pass.result.reasons).toEqual([]);
    expect(pass.code).toBe(0);
    expect(pass.result.headShas).toEqual([sha]);

    const other = judgeDir("b".repeat(40), dir, path.join(out, "fixture"));
    expect(other.code).toBe(1);
    expect(other.result.reasons[0]).toMatch(/SHA mismatch/);

    writeFileSync(path.join(app, "stray.txt"), "x");
    const dirtyOut = path.join(dir, "dirty");
    spawnSync("bash", [runScript, "--app-root", app, "--out", dirtyOut, "--modes", "fixture", "--features", "quote"], { env, encoding: "utf8" });
    expect(judgeDir(sha, dir, path.join(dirtyOut, "fixture")).result.reasons).toEqual(["fixture: tested tree was dirty, not clean at the head SHA"]);
  });

  it("aggregates a failing mode into a non-zero exit and the judge names the failure", () => {
    const { dir, app, sha, env } = fakeApp({ pwExit: 1 });
    const out = path.join(dir, "out");
    const r = spawnSync("bash", [runScript, "--app-root", app, "--out", out, "--modes", "fixture", "--features", "quote"], { env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(judgeDir(sha, dir, path.join(out, "fixture")).result.reasons).toEqual([
      "fixture: playwright exit codes 1",
      "fixture: verify.sh verdict FAIL",
    ]);
  });

  it("passes verify.sh's INCOMPLETE exit through and the judge fails it", () => {
    const { dir, app, sha, env } = fakeApp({ status: "skipped" });
    const out = path.join(dir, "out");
    const r = spawnSync("bash", [runScript, "--app-root", app, "--out", out, "--modes", "fixture", "--features", "quote"], { env, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(judgeDir(sha, dir, path.join(out, "fixture")).result.reasons).toEqual([
      "fixture: verify.sh verdict INCOMPLETE",
      "fixture: skipped: quote-comparison.spec.ts › journey",
    ]);
  });

  it("dry-run walks every mode with the base feature map and requires --app-root and --out", () => {
    const r = spawnSync("bash", [runScript, "--app-root", root, "--out", "/tmp/vo-run", "--features", "quote", "--dry-run"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "/tmp/vo-run/fixture/playwright-report-0.json npx playwright test --config playwright.config.ts e2e/quote-comparison.spec.ts --grep @fixture",
    );
    expect(r.stdout).toContain(
      "/tmp/vo-run/local/playwright-report-0.json npx playwright test --config playwright.config.ts e2e/intake.spec.ts e2e/sourcing-destination.spec.ts --grep-invert @fixture",
    );
    expect(spawnSync("bash", [runScript, "--out", "/tmp/vo-run"], { encoding: "utf8" }).status).toBe(2);
  });
});

describe("verify workflow Apply verdict step", () => {
  const SHA = "c".repeat(40);
  const wf = readFileSync(path.join(root, ".github/workflows/verify.yml"), "utf8");
  const block = wf.slice(wf.indexOf("- name: Apply verdict"));
  const script = block.slice(block.indexOf("run: |") + "run: |".length).split("\n").filter((l) => l.startsWith("          ") || l === "").map((l) => l.slice(10)).join("\n");

  const apply = (result, { mode = "report", present = "true" } = {}) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-apply-"));
    mkdirSync(path.join(dir, "result"));
    if (result) writeFileSync(path.join(dir, "result/verify-result.json"), JSON.stringify(result));
    const summary = path.join(dir, "summary.md");
    writeFileSync(summary, "");
    const r = spawnSync("bash", ["-e", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HEAD_SHA: SHA, BASE_SHA: "d".repeat(40), HARNESS_PRESENT: present, VERIFY_MODE: mode, GITHUB_STEP_SUMMARY: summary },
    });
    return { ...r, summary: readFileSync(summary, "utf8") };
  };
  const pass = { verdict: "PASS", expectedSha: SHA, headShas: [SHA], reasons: [] };

  it("passes only when the judge said PASS for evidence tested at the head SHA", () => {
    expect(apply(pass, { mode: "enforce" }).status).toBe(0);
    // expectedSha echoes the workflow input, so only headShas proves what was tested.
    const wrongSha = apply({ ...pass, headShas: ["e".repeat(40)] }, { mode: "enforce" });
    expect(wrongSha.status).toBe(1);
    expect(wrongSha.stdout).toContain("not tested at head");
    expect(apply({ ...pass, headShas: [SHA, "e".repeat(40)] }, { mode: "enforce" }).status).toBe(1);
    expect(apply(null, { mode: "enforce" }).stdout).toContain("verify-result.json missing");
    expect(apply(pass, { mode: "enforce", present: "false" }).status).toBe(1);
  });

  it("report mode warns instead of failing, and escapes journey names in workflow commands", () => {
    const result = { ...pass, verdict: "FAIL", reasons: ["local: failed: evil\n::add-mask::x 100%"] };
    const report = apply(result);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("::warning title=Verify::");
    expect(report.stdout).toContain("evil%0A::add-mask::x 100%25");
    expect(report.stdout).not.toMatch(/^::add-mask::/m);
    expect(apply(result, { mode: "enforce" }).status).toBe(1);
  });
});
