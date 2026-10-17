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
  canonicalModel,
  changedSkills,
  changedSkillsFromPaths,
  main,
  parseFlags,
  readResults,
  renderReport,
  skillDirs,
  skillForPath,
  skillHash,
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
const initGit = (root) => {
  const git = (...a) => execFileSync(GIT_BIN, ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  return git;
};
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
    expect(r.skills).toEqual(r.specs);
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
  it("requires a spec for each present skill and a skill for each spec", () => {
    const root = tmp();
    write(root, ".agents/skills/has-spec/SKILL.md", "x");
    write(root, ".codex/skills/no-spec/SKILL.md", "x");
    write(root, "evals/skills/has-spec/spec.json", JSON.stringify(goodSpec("has-spec")));
    write(root, "evals/skills/orphan/spec.json", JSON.stringify(goodSpec("orphan")));
    const r = validateAll(root);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      ".codex/skills/no-spec: skill has no eval spec at evals/skills/no-spec/spec.json",
      "evals/skills/orphan: no skill directory for this spec; restore the skill or remove the spec",
    ]);
    expect(run(root, "validate").code).toBe(1);
  });
  it("rejects a skill name used in two roots, and hashes every copy", () => {
    const root = tmp();
    const git = initGit(root);
    write(root, ".agents/skills/dup/SKILL.md", "a");
    write(root, ".codex/skills/dup/SKILL.md", "b");
    write(root, "evals/skills/dup/spec.json", JSON.stringify(goodSpec("dup")));
    git("add", "-f", ".agents", ".codex", "evals");
    git("commit", "-qm", "base");
    expect(skillDirs(root).get("dup")).toEqual([".agents/skills/dup", ".codex/skills/dup"]);
    expect(validateAll(root).errors).toEqual([
      "dup: skill name is used in more than one root (.agents/skills/dup, .codex/skills/dup); keep one",
    ]);
    const before = skillHash(root, "dup");
    write(root, ".codex/skills/dup/SKILL.md", "edited");
    expect(skillHash(root, "dup")).not.toBe(before);
    const hash = run(root, "hash", "dup");
    expect(hash.code).toBe(2);
    expect(hash.text).toMatch(/more than one root/);
    write(root, "scores.json", JSON.stringify([{
      skill: "dup", case: "c1", skillHash: skillHash(root, "dup"), runner: "model-a", judge: "model-b",
      scores: [{ id: "r1", points: 6 }, { id: "r2", points: 4 }],
    }]));
    const report = run(root, "report", "--skill", "dup", path.join(root, "scores.json"));
    expect(report.code).toBe(1);
    expect(report.text).toMatch(/error: dup: skill name is used in more than one root/);
  });
  it("only counts git-tracked skills in a git checkout", () => {
    const root = tmp();
    const git = initGit(root);
    write(root, ".agents/skills/tracked/SKILL.md", "x");
    write(root, ".agents/skills/local-install/SKILL.md", "x");
    write(root, "evals/skills/tracked/spec.json", JSON.stringify(goodSpec("tracked")));
    git("add", "-f", ".agents/skills/tracked", "evals");
    git("commit", "-qm", "base");
    expect([...skillDirs(root).keys()]).toEqual(["tracked"]);
    expect(validateAll(root).errors).toEqual([]);
  });
  it("does not count a tracked skill whose files are gone from the working tree", () => {
    const root = tmp();
    const git = initGit(root);
    write(root, ".codex/skills/pull/SKILL.md", "x");
    write(root, ".codex/skills/keep/SKILL.md", "x");
    for (const n of ["pull", "keep"]) write(root, `evals/skills/${n}/spec.json`, JSON.stringify(goodSpec(n)));
    git("add", "-f", ".codex", "evals");
    git("commit", "-qm", "base");
    expect(validateAll(root).errors).toEqual([]);
    fs.rmSync(path.join(root, ".codex/skills/pull"), { recursive: true });
    // Still tracked by git (the deletion is unstaged), but no longer on disk.
    expect(git("ls-files", ".codex/skills/pull").trim()).toBe(".codex/skills/pull/SKILL.md");
    expect([...skillDirs(root).keys()]).toEqual(["keep"]);
    expect(validateAll(root).errors).toEqual([
      "evals/skills/pull: no skill directory for this spec; restore the skill or remove the spec",
    ]);
    expect(run(root, "validate").code).toBe(1);
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
    expect(skillForPath(".agents/skills/README.md")).toBeNull();
    expect(skillForPath("evals/skills/README.md")).toBeNull();
    expect(skillForPath(".codex/skills/")).toBeNull();
    expect(changedSkillsFromPaths([
      ".codex/skills/z/a", ".agents/skills/a/b", ".agents/skills/a/c", "README.md", ".agents/skills/README.md",
    ])).toEqual(["a", "z"]);
  });
  it("diffs two git refs", () => {
    const root = tmp();
    const git = initGit(root);
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
  it("lists both sides of a rename and a deleted skill", () => {
    const root = tmp();
    const git = initGit(root);
    write(root, ".agents/skills/old-name/SKILL.md", "same content");
    write(root, ".codex/skills/gone/SKILL.md", "1");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("mv", ".agents/skills/old-name", ".agents/skills/new-name");
    git("rm", "-q", "-r", ".codex/skills/gone");
    git("commit", "-qm", "rename+delete");
    expect(changedSkills(root, "HEAD~1", "HEAD")).toEqual(["gone", "new-name", "old-name"]);
  });
  it("lists skills whose changed files have non-ASCII or special names", () => {
    const root = tmp();
    const git = initGit(root);
    const files = [
      ".codex/skills/accent/caf\u00e9.md",
      ".agents/skills/tabbed/a\tb.md",
      ".agents/skills/newlined/a\nb.md",
      ".agents/skills/quoted/say \"hi\".md",
      ".agents/skills/r\u00e9sum\u00e9/SKILL.md",
      ".agents/skills/plain/SKILL.md",
    ];
    for (const f of files) write(root, f, "1");
    git("add", "-A");
    git("commit", "-qm", "base");
    for (const f of files) write(root, f, "2");
    git("add", "-A");
    git("commit", "-qm", "change");
    // Plain `git diff --name-only` quotes these paths, which is why the
    // script has to ask for NUL-separated output.
    expect(git("diff", "--name-only", "HEAD~1", "HEAD")).toMatch(/^"/m);
    const expected = ["accent", "newlined", "plain", "quoted", "r\u00e9sum\u00e9", "tabbed"];
    expect(changedSkills(root, "HEAD~1", "HEAD")).toEqual(expected);
    expect(run(root, "changed", "--base", "HEAD~1", "--head", "HEAD")).toEqual({ code: 0, text: `${expected.join("\n")}\n` });
  });
  it("lists a skill whose only changed file has a special name", () => {
    const root = tmp();
    const git = initGit(root);
    write(root, ".codex/skills/commit/caf\u00e9.md", "1");
    write(root, ".codex/skills/tabbed/a\tb.md", "1");
    write(root, ".agents/skills/push/SKILL.md", "1");
    git("add", "-A");
    git("commit", "-qm", "base");
    write(root, ".codex/skills/commit/caf\u00e9.md", "2");
    git("add", "-A");
    git("commit", "-qm", "accent only");
    expect(changedSkills(root, "HEAD~1", "HEAD")).toEqual(["commit"]);
    write(root, ".codex/skills/tabbed/a\tb.md", "2");
    write(root, ".agents/skills/push/SKILL.md", "2");
    git("add", "-A");
    git("commit", "-qm", "tab and plain");
    expect(changedSkills(root, "HEAD~1", "HEAD")).toEqual(["push", "tabbed"]);
  });
});

describe("judge != runner", () => {
  it("rejects equal or missing models", () => {
    expect(() => assertDistinctJudge("Claude-Opus", " claude-opus ")).toThrow(/different model/);
    expect(() => assertDistinctJudge("a", "")).toThrow(/required/);
    expect(() => assertDistinctJudge("model-a", "model-b")).not.toThrow();
  });
  it("rejects non-string model ids", () => {
    expect(() => assertDistinctJudge(true, "x")).toThrow(/required/);
    expect(() => assertDistinctJudge("x", undefined)).toThrow(/required/);
  });
  it("treats aliases, snapshots and provider prefixes of one model as the same model", () => {
    for (const alias of [
      "claude-opus-5-5-latest",
      "claude-opus-5-5-20260101",
      "us.anthropic.claude-opus-5-5-20260101-v1:0",
      "anthropic/claude-opus-5-5",
      "claude-opus-5-5@20260101",
    ]) {
      expect(canonicalModel(alias)).toBe("claude-opus-5-5");
      expect(() => assertDistinctJudge("claude-opus-5-5", alias)).toThrow(/different model/);
    }
    expect(canonicalModel("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(canonicalModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(() => assertDistinctJudge("claude-opus-5-5", "claude-sonnet-5-5")).not.toThrow();
  });
  it("cli exit codes", () => {
    expect(run(repoRoot, "check-judge", "--runner", "x", "--judge", "y").code).toBe(0);
    expect(run(repoRoot, "check-judge", "--runner", "x", "--judge", "x").code).toBe(2);
  });
  it.each([
    ["valueless --judge", ["--runner", "x", "--judge"]],
    ["valueless --runner", ["--runner", "--judge", "x"]],
    ["missing --judge", ["--runner", "x"]],
    ["missing both", []],
    ["empty --judge", ["--runner", "x", "--judge", ""]],
    ["whitespace --runner", ["--runner", "   ", "--judge", "x"]],
  ])("cli rejects %s with exit 2", (_label, args) => {
    const r = run(repoRoot, "check-judge", ...args);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/--runner and --judge both need a non-empty model id/);
    expect(r.text).not.toMatch(/^ok/);
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
  it("fails when nothing in scope was scored", () => {
    for (const r of [
      buildReport(new Map(), [result()]),
      buildReport(specs, [result()], { only: ["nope"] }),
      buildReport(new Map([["demo", { ...goodSpec(), cases: [] }]]), [result()]),
    ]) expect(r.ok).toBe(false);
    const empty = buildReport(new Map(), []);
    expect(empty.reason).toMatch(/nothing was scored/);
    expect(renderReport(empty)).toMatch(/Overall: NOT 10\/10\n\nReason: no eval case was in scope/);
  });
  it("fails a spec whose skill has no current skillHash", () => {
    const r = buildReport(specs, [result({ skillHash: "x" })], { hashes: new Map() });
    expect(r.ok).toBe(false);
    expect(r.skills[0]).toMatchObject({ skill: "demo", status: "fail", reason: "skill directory absent" });
    expect(renderReport(r)).toMatch(/\| demo \| - \| - \| fail \| skill directory absent \|/);
  });
  it("scopes to --only skills", () => {
    const specs2 = new Map([["demo", goodSpec()], ["other", goodSpec("other")]]);
    const r = buildReport(specs2, [result()], { only: ["demo"] });
    expect(r.ok).toBe(true);
    expect(r.skills.map((s) => s.skill)).toEqual(["demo"]);
  });
  it("ignores results judged against an older skillHash", () => {
    const hashes = new Map([["demo", "new"]]);
    const stale = buildReport(specs, [result({ skillHash: "old" })], { hashes }).skills[0].cases[0];
    expect(stale.status).toBe("stale");
    const low = result({ skillHash: "new", scores: [{ id: "r1", points: 0 }, { id: "r2", points: 4 }] });
    // An old passing file listed after a current failing one must not hide the failure.
    expect(buildReport(specs, [low, result({ skillHash: "old" })], { hashes }).ok).toBe(false);
    expect(buildReport(specs, [result({ skillHash: "new" })], { hashes }).ok).toBe(true);
  });
  it("escapes table cells", () => {
    const r = buildReport(specs, [result({ scores: [{ id: "a|b\nc", points: 1 }] })]);
    const row = renderReport(r).split("\n").find((l) => l.startsWith("| demo"));
    expect(row).toContain(String.raw`a\|b c`);
    expect(row.split(/(?<!\\)\|/).length).toBe(7);
  });
  it("rejects malformed score files with file and index", () => {
    const root = tmp();
    write(root, "null.json", JSON.stringify([result(), null]));
    expect(() => readResults([path.join(root, "null.json")])).toThrow(/null\.json\[1\]: result must be an object/);
    write(root, "num.json", "42");
    expect(() => readResults([path.join(root, "num.json")])).toThrow(/num\.json\[0\]/);
    write(root, "bad.json", "{");
    expect(() => readResults([path.join(root, "bad.json")])).toThrow(/bad\.json: cannot read score JSON/);
  });
  it("parses repeatable --skill flags", () => {
    expect(parseFlags(["--skill", "a", "--skill", "b,c", "x.json"])).toEqual({ _: ["x.json"], skill: ["a", "b,c"] });
    expect(parseFlags(["--runner", "--judge", "x"])).toEqual({ _: [], runner: true, judge: "x" });
  });
  it("cli: a spec without its skill fails every report, scoped or not", () => {
    const root = tmp();
    write(root, ".agents/skills/demo/SKILL.md", "x");
    for (const n of ["demo", "verify-overdrafter"]) write(root, `evals/skills/${n}/spec.json`, JSON.stringify(goodSpec(n)));
    write(root, "demo.json", JSON.stringify([result({ skillHash: skillHash(root, "demo") })]));
    for (const scope of [[], ["--skill", "demo"], ["--skill", "verify-overdrafter"]]) {
      const r = run(root, "report", ...scope, path.join(root, "demo.json"));
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/Overall: NOT 10\/10/);
      expect(r.text).toMatch(/error: evals\/skills\/verify-overdrafter: no skill directory for this spec/);
    }
    const json = JSON.parse(run(root, "report", "--json", path.join(root, "demo.json")).text);
    expect(json).toMatchObject({ ok: false, skills: [] });
    expect(json.errors).toHaveLength(1);
  });
  it("cli: a present skill without a spec fails the report even when every spec passes", () => {
    const root = tmp();
    write(root, ".agents/skills/demo/SKILL.md", "x");
    write(root, ".codex/skills/pull/SKILL.md", "x");
    write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec()));
    write(root, "demo.json", JSON.stringify([result({ skillHash: skillHash(root, "demo") })]));
    const r = run(root, "report", path.join(root, "demo.json"));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/error: \.codex\/skills\/pull: skill has no eval spec/);
    expect(run(root, "report", "--skill", "demo", path.join(root, "demo.json")).code).toBe(1);
  });
  it("cli: present-but-unscored fails, --skill scopes", () => {
    const root = tmp();
    write(root, ".agents/skills/demo/SKILL.md", "x");
    write(root, ".agents/skills/other/SKILL.md", "x");
    write(root, ".agents/skills/verify-overdrafter/SKILL.md", "x");
    for (const n of ["demo", "other", "verify-overdrafter"]) write(root, `evals/skills/${n}/spec.json`, JSON.stringify(goodSpec(n)));
    const scored = (n) => result({ skill: n, skillHash: skillHash(root, n) });
    write(root, "all.json", JSON.stringify([scored("demo"), scored("other")]));
    const present = run(root, "report", path.join(root, "all.json"));
    expect(present.code).toBe(1);
    expect(present.text).toMatch(/verify-overdrafter \| c1 \| -\/10 \| unscored/);
    write(root, "every.json", JSON.stringify(["demo", "other", "verify-overdrafter"].map(scored)));
    expect(run(root, "report", path.join(root, "every.json"))).toMatchObject({ code: 0 });

    write(root, "demo.json", JSON.stringify([scored("demo")]));
    expect(run(root, "report", path.join(root, "demo.json")).code).toBe(1);
    const scoped = run(root, "report", "--skill", "demo", path.join(root, "demo.json"));
    expect(scoped.code).toBe(0);
    expect(scoped.text).not.toMatch(/other/);
    expect(run(root, "report", "--skill", "demo,other", path.join(root, "demo.json")).code).toBe(1);
    expect(run(root, "report", "--skill", "demo", "--skill", "other", path.join(root, "all.json")).code).toBe(0);
    expect(run(root, "report", "--skill", "nope", path.join(root, "demo.json"))).toMatchObject({ code: 2 });
    expect(run(root, "report", path.join(root, "demo.json"), "--skill").code).toBe(2);

    write(root, ".agents/skills/demo/SKILL.md", "changed");
    expect(run(root, "report", "--skill", "demo", path.join(root, "demo.json")).text).toMatch(/stale/);
    expect(run(root, "hash", "demo").text).toBe(`demo ${skillHash(root, "demo")}\n`);
  });
  it("cli: report --skill \"\" (no skills changed) exits 0 without needing scores", () => {
    const root = tmp();
    write(root, ".agents/skills/demo/SKILL.md", "x");
    write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec()));
    const none = path.join(root, "no-such-scores.json");
    for (const args of [["--skill", "", none], ["--skill", "", "--json", none], ["--skill", ""], ["--skill", "", "--skill", ""]]) {
      const r = run(root, "report", ...args);
      expect(r.code).toBe(0);
      expect(r.text).toMatch(/no skills changed/);
    }
    // Nothing was scored, so the label never says PASS.
    const text = run(root, "report", "--skill", "", none).text;
    expect(text).toMatch(/Overall: nothing to re-score/);
    expect(text).not.toMatch(/PASS/);
    expect(JSON.parse(run(root, "report", "--skill", "", "--json", none).text)).toMatchObject({ ok: true, nothingToRescore: true, skills: [] });
    // Only the exact empty string means "none changed"; every other empty name is still an error.
    for (const args of [["--skill"], ["--skill", ","], ["--skill", "demo,,"], ["--skill", "", "--skill", "demo"]]) {
      expect(run(root, "report", ...args, none).code).toBe(2);
    }
    // The empty list still runs the validate checks: a broken repo never passes.
    write(root, "evals/skills/orphan/spec.json", JSON.stringify(goodSpec("orphan")));
    const broken = run(root, "report", "--skill", "", none);
    expect(broken.code).toBe(1);
    expect(broken.text).toMatch(/error: evals\/skills\/orphan: no skill directory for this spec/);
    expect(broken.text).not.toMatch(/no skills changed|nothing to re-score/);
  });
  it("cli: a blank --skill value (spaces, tab, newline) is an error, not \"no skills changed\"", () => {
    const root = tmp();
    write(root, ".agents/skills/demo/SKILL.md", "x");
    write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec()));
    const none = path.join(root, "no-such-scores.json");
    const blanks = [" ", "   ", "\t", "\n", " \t\n ", "\r\n"];
    for (const blank of blanks) {
      for (const args of [["--skill", blank, none], ["--skill", blank, "--json", none], ["--skill", "", "--skill", blank], ["--skill", blank, "--skill", "demo"]]) {
        const r = run(root, "report", ...args);
        expect(r.code).toBe(2);
        expect(r.text).toMatch(/^error: --skill value is blank/);
        expect(r.text).not.toMatch(/nothing to re-score|"ok"/);
      }
    }
  });
  describe("report --skill \"\" with uncommitted skill changes", () => {
    // `changed` only compares commits, so an empty list proves nothing while the
    // working tree holds an edit that no commit contains.
    const cleanRepo = () => {
      const root = tmp();
      const git = initGit(root);
      write(root, ".gitignore", ".claude/skills/\n");
      write(root, ".agents/skills/demo/SKILL.md", "1");
      write(root, ".agents/skills/demo/notes.md", "1");
      write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec()));
      write(root, "docs/x.md", "1");
      git("add", "-A");
      git("commit", "-qm", "base");
      return { root, git, none: path.join(root, "no-such-scores.json") };
    };
    const dirtyCases = [
      ["an unstaged edit", ({ root }) => write(root, ".agents/skills/demo/SKILL.md", "2"), [".agents/skills/demo/SKILL.md"]],
      ["a staged edit", ({ root, git }) => {
        write(root, ".agents/skills/demo/SKILL.md", "2");
        git("add", "-A");
      }, [".agents/skills/demo/SKILL.md"]],
      ["an edited spec", ({ root }) => write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec(), null, 2)), ["evals/skills/demo/spec.json"]],
      ["an untracked file in a skill", ({ root }) => write(root, ".agents/skills/demo/new.md", "1"), [".agents/skills/demo/new.md"]],
      ["an untracked new skill", ({ root }) => write(root, ".codex/skills/fresh/SKILL.md", "1"), [".codex/skills/fresh/SKILL.md"]],
      ["an unstaged delete", ({ root }) => fs.rmSync(path.join(root, ".agents/skills/demo/notes.md")), [".agents/skills/demo/notes.md"]],
      ["a staged rename", ({ root, git }) => {
        git("mv", ".agents/skills/demo/notes.md", ".agents/skills/demo/moved.md");
        expect(fs.existsSync(path.join(root, ".agents/skills/demo/moved.md"))).toBe(true);
      }, [".agents/skills/demo/notes.md", ".agents/skills/demo/moved.md"]],
      ["accented, tab and newline file names", ({ root }) => {
        for (const name of ["caf\u00e9.md", "a\tb.md", "c\nd.md"]) write(root, `.agents/skills/demo/${name}`, "1");
      }, [".agents/skills/demo/caf\u00e9.md", ".agents/skills/demo/a\tb.md", ".agents/skills/demo/c\nd.md"]],
    ];
    it.each(dirtyCases)("fails (exit 1, commit first) on %s", (_name, mutate, paths) => {
      const repo = cleanRepo();
      mutate(repo);
      const r = run(repo.root, "report", "--skill", "", repo.none);
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/Reason: uncommitted skill changes; commit first/);
      expect(r.text).not.toMatch(/no skills changed|nothing to re-score|PASS/);
      for (const p of paths) expect(r.text).toContain(`- error: uncommitted: ${p}`);
      const json = JSON.parse(run(repo.root, "report", "--skill", "", "--json", repo.none).text);
      expect(json).toMatchObject({ ok: false, reason: "uncommitted skill changes; commit first", skills: [] });
      expect(json.errors).toEqual(expect.arrayContaining(paths.map((p) => `uncommitted: ${p}`)));
    });
    it("shows the gap it closes: `changed` lists nothing while an edit is pending", () => {
      const repo = cleanRepo();
      write(repo.root, ".agents/skills/demo/SKILL.md", "2");
      expect(run(repo.root, "changed", "--base", "HEAD", "--head", "HEAD")).toEqual({ code: 0, text: "" });
      expect(run(repo.root, "report", "--skill", "", repo.none).code).toBe(1);
      repo.git("add", "-A");
      repo.git("commit", "-qm", "commit the edit");
      const after = run(repo.root, "report", "--skill", "", repo.none);
      expect(after.code).toBe(0);
      expect(after.text).toMatch(/Overall: nothing to re-score/);
    });
    it("ignores changes outside the skill and spec dirs, and ignored third-party skills", () => {
      const repo = cleanRepo();
      write(repo.root, "docs/x.md", "2");
      write(repo.root, "docs/new.md", "1");
      write(repo.root, ".claude/skills/third-party/SKILL.md", "1");
      const r = run(repo.root, "report", "--skill", "", repo.none);
      expect(r.code).toBe(0);
      expect(r.text).toMatch(/Overall: nothing to re-score/);
    });
    it("reports validation errors, not the uncommitted check, for a broken repo", () => {
      const repo = cleanRepo();
      write(repo.root, "evals/skills/orphan/spec.json", JSON.stringify(goodSpec("orphan")));
      const r = run(repo.root, "report", "--skill", "", repo.none);
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/Reason: validation failed/);
    });
  });
  it("cli: the documented changed | report pipeline handles no changed skills", () => {
    const root = tmp();
    const git = initGit(root);
    write(root, ".agents/skills/demo/SKILL.md", "1");
    write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec()));
    write(root, "docs/x.md", "1");
    git("add", "-f", "-A");
    git("commit", "-qm", "base");
    write(root, "docs/x.md", "2");
    git("add", "-A");
    git("commit", "-qm", "docs only");
    const changed = run(root, "changed", "--base", "HEAD~1", "--head", "HEAD");
    expect(changed).toEqual({ code: 0, text: "" });
    // `skills=$(... | paste -sd, -)` strips the trailing newline and joins lines.
    const skills = changed.text.split("\n").filter(Boolean).join(",");
    const pipeline = run(root, "report", "--skill", skills, path.join(root, "scores", "*.json"));
    expect(pipeline.code).toBe(0);
    expect(pipeline.text).toMatch(/Overall: nothing to re-score/);
  });
  it("cli aggregates score files", () => {
    const root = tmp();
    write(root, ".agents/skills/demo/SKILL.md", "x");
    write(root, "evals/skills/demo/spec.json", JSON.stringify(goodSpec()));
    write(root, "scores.json", JSON.stringify([result({ skillHash: skillHash(root, "demo") })]));
    const ok = run(root, "report", path.join(root, "scores.json"));
    expect(ok.code).toBe(0);
    expect(ok.text).toMatch(/\| demo \| c1 \| 10\/10 \| pass/);
    write(root, "scores.json", JSON.stringify([result({ judge: "model-a" })]));
    expect(run(root, "report", "--json", path.join(root, "scores.json")).code).toBe(1);
    expect(run(root, "report").code).toBe(2);
  });
});
