// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_BIN,
  assertDistinctJudge,
  buildReport,
  changedSkills,
  changedSkillsFromPaths,
  main,
  skillForPath,
  validateAll,
  validateSpec,
} from "./skill-evals.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skill-evals-"));
  tmpDirs.push(d);
  return d;
}
function write(root, rel, body) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
const goodSpec = (skill = "demo") => ({
  skill,
  passScore: 10,
  cases: [{
    id: "c1",
    task: "do it",
    expectedBehaviors: ["a", "b"],
    rubric: [{ id: "r1", criterion: "a", points: 6 }, { id: "r2", criterion: "b", points: 4 }],
  }],
});
const run = (root, ...argv) => {
  let text = "";
  const code = main(argv, { root, out: (s) => (text += s) });
  return { code, text };
};

describe("committed specs", () => {
  it("validate against the real repo", () => {
    const r = validateAll(repoRoot);
    expect(r.errors).toEqual([]);
    expect(r.specs).toContain("verify-overdrafter");
  });
});

describe("validateSpec", () => {
  it("accepts a good spec", () => expect(validateSpec(goodSpec(), "demo")).toEqual([]));
  it("rejects rubric not summing to 10", () => {
    const s = goodSpec();
    s.cases[0].rubric[0].points = 5;
    expect(validateSpec(s, "demo").join()).toMatch(/sum to 10 \(got 9\)/);
  });
  it("rejects name mismatch, duplicates and missing fields", () => {
    const s = goodSpec("other");
    s.cases.push({ ...s.cases[0], task: "", expectedBehaviors: [] });
    const msg = validateSpec(s, "demo").join("\n");
    expect(msg).toMatch(/does not match directory/);
    expect(msg).toMatch(/duplicated/);
    expect(msg).toMatch(/task must be/);
    expect(msg).toMatch(/expectedBehaviors/);
  });
});

describe("validateAll", () => {
  it("requires a spec for each present skill and tolerates absent skills", () => {
    const root = tmp();
    write(root, ".agents/skills/has-spec/SKILL.md", "x");
    write(root, ".codex/skills/no-spec/SKILL.md", "x");
    write(root, "evals/skills/has-spec/spec.json", JSON.stringify(goodSpec("has-spec")));
    write(root, "evals/skills/verify-overdrafter/spec.json", JSON.stringify(goodSpec("verify-overdrafter")));
    const r = validateAll(root);
    expect(r.errors).toEqual([".codex/skills/no-spec: skill has no eval spec at evals/skills/no-spec/spec.json"]);
    expect(r.absent).toEqual(["verify-overdrafter"]);
  });
  it("reports invalid JSON", () => {
    const root = tmp();
    write(root, "evals/skills/bad/spec.json", "{");
    expect(validateAll(root).errors[0]).toMatch(/invalid JSON/);
  });
});

describe("changed skills", () => {
  it("maps paths to skills", () => {
    expect(skillForPath(".agents/skills/a/SKILL.md")).toBe("a");
    expect(skillForPath(".cursor/skills/verify-overdrafter/x/y.md")).toBe("verify-overdrafter");
    expect(skillForPath("evals/skills/b/spec.json")).toBe("b");
    expect(skillForPath("src/index.ts")).toBeNull();
    expect(changedSkillsFromPaths([".codex/skills/z/a", ".agents/skills/a/b", ".agents/skills/a/c", "README.md"])).toEqual(["a", "z"]);
  });
  it("diffs two git refs", () => {
    const root = tmp();
    const git = (...a) => execFileSync(GIT_BIN, ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    write(root, ".agents/skills/a/SKILL.md", "1");
    write(root, ".agents/skills/b/SKILL.md", "1");
    git("add", "-A");
    git("commit", "-qm", "base");
    write(root, ".agents/skills/b/SKILL.md", "2");
    write(root, "docs/x.md", "x");
    git("add", "-A");
    git("commit", "-qm", "change");
    expect(changedSkills(root, "HEAD~1", "HEAD")).toEqual(["b"]);
    expect(() => changedSkills(root, "--output=x", "HEAD")).toThrow(/invalid git ref/);
    expect(run(root, "changed", "--base", "HEAD~1", "--head", "HEAD")).toEqual({ code: 0, text: "b\n" });
  });
});

describe("judge != runner", () => {
  it("rejects equal or missing models", () => {
    expect(() => assertDistinctJudge("Claude-Opus", " claude-opus ")).toThrow(/different model/);
    expect(() => assertDistinctJudge("a", "")).toThrow(/required/);
    expect(() => assertDistinctJudge("model-a", "model-b")).not.toThrow();
  });
  it("cli exit codes", () => {
    expect(run(repoRoot, "check-judge", "--runner", "x", "--judge", "y").code).toBe(0);
    expect(run(repoRoot, "check-judge", "--runner", "x", "--judge", "x").code).toBe(2);
  });
});

describe("report", () => {
  const specs = new Map([["demo", goodSpec()]]);
  const result = (over = {}) => ({
    skill: "demo", case: "c1", runner: "model-a", judge: "model-b",
    scores: [{ id: "r1", points: 6 }, { id: "r2", points: 4 }], ...over,
  });
  it("passes at 10/10", () => {
    const r = buildReport(specs, [result()]);
    expect(r.ok).toBe(true);
    expect(r.skills[0].cases[0]).toMatchObject({ status: "pass", total: 10 });
  });
  it("fails below 10 and uses the latest result per case", () => {
    const low = result({ scores: [{ id: "r1", points: 6 }, { id: "r2", points: 1 }] });
    expect(buildReport(specs, [low]).skills[0].cases[0]).toMatchObject({ status: "fail", total: 7 });
    expect(buildReport(specs, [low, result()]).ok).toBe(true);
  });
  it("flags same-model judging, out-of-range, unknown and missing scores", () => {
    expect(buildReport(specs, [result({ judge: "model-a" })]).skills[0].cases[0].status).toBe("invalid");
    const bad = buildReport(specs, [result({ scores: [{ id: "r1", points: 7 }, { id: "zz", points: 1 }] })]).skills[0].cases[0];
    expect(bad.status).toBe("invalid");
    expect(bad.problems.join()).toMatch(/0\.\.6/);
    expect(bad.problems.join()).toMatch(/unknown rubric id "zz"/);
    expect(bad.problems.join()).toMatch(/"r2" not scored/);
  });
  it("marks cases without results unscored", () => {
    const r = buildReport(specs, []);
    expect(r.ok).toBe(false);
    expect(r.skills[0].cases[0].status).toBe("unscored");
  });
  it("cli aggregates score files", () => {
    const root = tmp();
    write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec()));
    write(root, "scores.json", JSON.stringify([result()]));
    const ok = run(root, "report", path.join(root, "scores.json"));
    expect(ok.code).toBe(0);
    expect(ok.text).toMatch(/\| demo \| c1 \| 10\/10 \| pass/);
    write(root, "scores.json", JSON.stringify([result({ judge: "model-a" })]));
    expect(run(root, "report", "--json", path.join(root, "scores.json")).code).toBe(1);
    expect(run(root, "report").code).toBe(2);
  });
});
