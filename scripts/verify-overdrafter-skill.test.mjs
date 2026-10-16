// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FEATURE_SPECS, specsFor } from "../.agents/skills/verify-overdrafter/scripts/feature-specs.mjs";

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
    for (const mode of ["fixture", "local"]) {
      for (const spec of specsFor(Object.keys(FEATURE_SPECS), mode)) {
        expect(existsSync(path.join(root, spec)), spec).toBe(true);
      }
    }
    for (const s of ["scripts/verify.sh", "scripts/feature-specs.mjs", "run"]) {
      expect(existsSync(path.join(skillDir, s)), s).toBe(true);
      expect(read("SKILL.md")).toContain(s);
    }
    expect(() => specsFor(["nope"], "fixture")).toThrow(/unknown feature/);
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
    expect(out).toContain("PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/vo-out/playwright-report.json");
    expect(out).toContain("e2e/quote-comparison.spec.ts");
  });

  it("CI judges the PR head with the base harness, read-only and without secrets", () => {
    const wf = readFileSync(path.join(root, ".github/workflows/verify.yml"), "utf8");
    expect(wf).toContain("bash base/.agents/skills/verify-overdrafter/run --app-root head");
    expect(wf).toContain("node base/scripts/verify-result-judge.mjs --expected-sha \"$HEAD_SHA\"");
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(wf).not.toMatch(/\$\{\{\s*secrets\.|pull_request_target|: write/);
    expect(wf).toContain("VERIFY_MODE: report");
  });
});

describe("verify-overdrafter driver behavior", () => {
  const verify = path.join(skillDir, "scripts/verify.sh");
  const run = (...args) => spawnSync("bash", [verify, ...args], { cwd: root, encoding: "utf8" });

  it("rejects unknown, empty and spec-less feature selections", () => {
    for (const args of [["--features", "bogus"], ["--features", ""], ["--mode", "local", "--features", "provider"]]) {
      const r = run(...args, "--dry-run");
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).not.toContain("playwright test");
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
      for (const p of entry.fixture) expect(spec(p), `${name} fixture ${p}`).toContain("@fixture");
      for (const p of entry.local) {
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
    const fx = new Set(all.flatMap((e) => e.fixture));
    for (const p of all.flatMap((e) => e.local)) expect(fx.has(p), p).toBe(false);
  });

  it("tracks the skill in git despite the ignored .agents directory", () => {
    const r = spawnSync("git", ["ls-files", ".agents/skills/verify-overdrafter"], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) return;
    for (const f of ["SKILL.md", "scripts/verify.sh", "scripts/feature-specs.mjs", "features/README.md"]) {
      expect(r.stdout, f).toContain(`.agents/skills/verify-overdrafter/${f}`);
    }
  });
});
