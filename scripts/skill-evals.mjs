#!/usr/bin/env node
/**
 * Offline tooling for repo skill evals (OVD-860). Makes no model API calls:
 * it validates eval specs, lists skills changed between two git refs, enforces
 * judge != runner, and aggregates judge score JSON into a report.
 * See docs/skill-evals.md.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const GIT_BIN = "/usr/bin/git";
export const SKILL_ROOTS = [".agents/skills", ".codex/skills", ".claude/skills", ".cursor/skills"];
export const SPEC_ROOT = "evals/skills";
export const SPEC_FILE = "spec.json";
export const MAX_SCORE = 10;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeModel(id) {
  return String(id ?? "").trim().toLowerCase();
}

/** Throws unless a runner and judge model are both named and differ. */
export function assertDistinctJudge(runner, judge) {
  const r = normalizeModel(runner);
  const j = normalizeModel(judge);
  if (!r || !j) throw new Error("runner and judge model ids are both required");
  if (r === j) throw new Error(`judge must be a different model than the runner (both "${r}")`);
}

export function skillDirs(root) {
  const found = new Map();
  for (const base of SKILL_ROOTS) {
    const dir = path.join(root, base);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !found.has(entry.name)) found.set(entry.name, path.posix.join(base, entry.name));
    }
  }
  return found;
}

export function validateSpec(spec, expectedSkill) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["spec must be an object"];
  if (!SKILL_NAME.test(spec.skill ?? "")) err("skill must be a kebab-case name");
  else if (expectedSkill && spec.skill !== expectedSkill) err(`skill "${spec.skill}" does not match directory "${expectedSkill}"`);
  if (spec.passScore !== MAX_SCORE) err(`passScore must be ${MAX_SCORE}`);
  if (!Array.isArray(spec.cases) || spec.cases.length === 0) {
    err("cases must be a non-empty array");
    return errors;
  }
  const caseIds = new Set();
  spec.cases.forEach((c, i) => {
    const at = `cases[${i}]`;
    if (!c || typeof c !== "object") return err(`${at} must be an object`);
    if (!SKILL_NAME.test(c.id ?? "")) err(`${at}.id must be kebab-case`);
    else if (caseIds.has(c.id)) err(`${at}.id "${c.id}" is duplicated`);
    else caseIds.add(c.id);
    if (typeof c.task !== "string" || !c.task.trim()) err(`${at}.task must be a non-empty string`);
    if (!Array.isArray(c.expectedBehaviors) || c.expectedBehaviors.length === 0 || c.expectedBehaviors.some((b) => typeof b !== "string" || !b.trim())) {
      err(`${at}.expectedBehaviors must be a non-empty array of strings`);
    }
    if (!Array.isArray(c.rubric) || c.rubric.length === 0) return err(`${at}.rubric must be a non-empty array`);
    const ids = new Set();
    let total = 0;
    for (const r of c.rubric) {
      if (!r || typeof r.id !== "string" || !r.id || typeof r.criterion !== "string" || !r.criterion.trim()) {
        err(`${at}.rubric entries need id and criterion`);
        continue;
      }
      if (ids.has(r.id)) err(`${at}.rubric id "${r.id}" is duplicated`);
      ids.add(r.id);
      if (!Number.isInteger(r.points) || r.points < 1) err(`${at}.rubric "${r.id}" points must be a positive integer`);
      else total += r.points;
    }
    if (total !== MAX_SCORE) err(`${at}.rubric points must sum to ${MAX_SCORE} (got ${total})`);
  });
  return errors;
}

export function loadSpecs(root) {
  const base = path.join(root, SPEC_ROOT);
  const specs = new Map();
  const errors = [];
  if (!fs.existsSync(base)) return { specs, errors: [`${SPEC_ROOT} does not exist`] };
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(base, entry.name, SPEC_FILE);
    if (!fs.existsSync(file)) {
      errors.push(`${SPEC_ROOT}/${entry.name}: missing ${SPEC_FILE}`);
      continue;
    }
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${SPEC_ROOT}/${entry.name}: invalid JSON (${e.message})`);
      continue;
    }
    for (const m of validateSpec(spec, entry.name)) errors.push(`${SPEC_ROOT}/${entry.name}: ${m}`);
    specs.set(entry.name, spec);
  }
  return { specs, errors };
}

/**
 * Every present skill needs a spec. A spec whose skill dir is absent (for
 * example verify-overdrafter before its PR lands) is tolerated and reported.
 */
export function validateAll(root) {
  const { specs, errors } = loadSpecs(root);
  const dirs = skillDirs(root);
  for (const name of dirs.keys()) {
    if (!specs.has(name)) errors.push(`${dirs.get(name)}: skill has no eval spec at ${SPEC_ROOT}/${name}/${SPEC_FILE}`);
  }
  const absent = [...specs.keys()].filter((n) => !dirs.has(n)).sort();
  return { ok: errors.length === 0, errors, absent, specs: [...specs.keys()].sort(), skills: [...dirs.keys()].sort() };
}

/** Map a repo-relative path to the skill it belongs to, or null. */
export function skillForPath(file) {
  const p = file.replace(/\\/g, "/");
  for (const base of SKILL_ROOTS) {
    if (p.startsWith(`${base}/`)) return p.slice(base.length + 1).split("/")[0] || null;
  }
  if (p.startsWith(`${SPEC_ROOT}/`)) return p.slice(SPEC_ROOT.length + 1).split("/")[0] || null;
  return null;
}

export function changedSkillsFromPaths(paths) {
  return [...new Set(paths.map(skillForPath).filter(Boolean))].sort();
}

export function changedSkills(root, base, head) {
  for (const ref of [base, head]) {
    if (!ref || ref.startsWith("-")) throw new Error(`invalid git ref: ${ref}`);
  }
  const out = execFileSync(GIT_BIN, ["diff", "--name-only", `${base}...${head}`], { cwd: root, encoding: "utf8" });
  return changedSkillsFromPaths(out.split("\n").filter(Boolean));
}

/**
 * Judge result shape: { skill, case, runner, judge, scores: [{ id, points }] }.
 * Returns a per-case result with a validated total.
 */
export function scoreResult(result, spec) {
  const problems = [];
  const c = spec?.cases?.find((x) => x.id === result.case);
  if (!c) return { total: 0, problems: [`unknown case "${result.case}"`], caseDef: null };
  try {
    assertDistinctJudge(result.runner, result.judge);
  } catch (e) {
    problems.push(e.message);
  }
  const byId = new Map(c.rubric.map((r) => [r.id, r]));
  const seen = new Set();
  let total = 0;
  for (const s of Array.isArray(result.scores) ? result.scores : []) {
    const r = byId.get(s?.id);
    if (!r) {
      problems.push(`unknown rubric id "${s?.id}"`);
      continue;
    }
    if (seen.has(s.id)) {
      problems.push(`rubric id "${s.id}" scored twice`);
      continue;
    }
    seen.add(s.id);
    if (!Number.isInteger(s.points) || s.points < 0 || s.points > r.points) {
      problems.push(`rubric "${s.id}" points must be an integer 0..${r.points}`);
      continue;
    }
    total += s.points;
  }
  for (const r of c.rubric) if (!seen.has(r.id)) problems.push(`rubric "${r.id}" not scored`);
  return { total, problems, caseDef: c };
}

export function buildReport(specs, results) {
  const skills = [];
  for (const [name, spec] of [...specs].sort(([a], [b]) => a.localeCompare(b))) {
    const cases = spec.cases.map((c) => {
      const mine = results.filter((r) => r.skill === name && r.case === c.id);
      if (mine.length === 0) return { id: c.id, status: "unscored", total: null, problems: ["no judge result"] };
      // Latest result wins so a re-run replaces earlier attempts.
      const { total, problems } = scoreResult(mine[mine.length - 1], spec);
      const status = problems.length ? "invalid" : total >= spec.passScore ? "pass" : "fail";
      return { id: c.id, status, total, problems, runner: mine[mine.length - 1].runner, judge: mine[mine.length - 1].judge };
    });
    skills.push({ skill: name, status: cases.every((c) => c.status === "pass") ? "pass" : "fail", cases });
  }
  return { ok: skills.every((s) => s.status === "pass"), skills };
}

export function renderReport(report) {
  const lines = ["# Skill eval report", "", `Overall: ${report.ok ? "PASS" : "NOT 10/10"}`, ""];
  lines.push("| Skill | Case | Score | Status | Notes |", "| --- | --- | --- | --- | --- |");
  for (const s of report.skills) {
    for (const c of s.cases) {
      lines.push(`| ${s.skill} | ${c.id} | ${c.total ?? "-"}/${MAX_SCORE} | ${c.status} | ${c.problems.join("; ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function readResults(files) {
  const results = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    results.push(...(Array.isArray(data) ? data : [data]));
  }
  return results;
}

const BOOLEAN_FLAGS = new Set(["json"]);

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(a.slice(2)) || next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
      else {
        flags[a.slice(2)] = next;
        i += 1;
      }
    } else flags._.push(a);
  }
  return flags;
}

const USAGE = `Usage: node scripts/skill-evals.mjs <command>
  validate                          validate all eval specs and skill coverage
  changed --base <ref> --head <ref> list skills whose dir or eval spec changed
  check-judge --runner <m> --judge <m>   fail unless the judge model differs
  report [--json] <scores.json>...  aggregate judge results (exit 1 unless all 10/10)`;

export function main(argv, { root = process.cwd(), out = (s) => process.stdout.write(s) } = {}) {
  const [cmd, ...rest] = argv;
  const f = parseFlags(rest);
  try {
    if (cmd === "validate") {
      const r = validateAll(root);
      for (const e of r.errors) out(`error: ${e}\n`);
      for (const n of r.absent) out(`note: skill "${n}" is not present in this checkout; spec kept\n`);
      out(r.ok ? `ok: ${r.specs.length} specs, ${r.skills.length} skills present\n` : "validation failed\n");
      return r.ok ? 0 : 1;
    }
    if (cmd === "changed") {
      if (typeof f.base !== "string" || typeof f.head !== "string") throw new Error("--base and --head are required");
      const names = changedSkills(root, f.base, f.head);
      out(names.length ? `${names.join("\n")}\n` : "");
      return 0;
    }
    if (cmd === "check-judge") {
      assertDistinctJudge(f.runner, f.judge);
      out(`ok: judge ${normalizeModel(f.judge)} differs from runner ${normalizeModel(f.runner)}\n`);
      return 0;
    }
    if (cmd === "report") {
      if (f._.length === 0) throw new Error("at least one scores file is required");
      const { specs, errors } = loadSpecs(root);
      if (errors.length) throw new Error(`invalid specs: ${errors.join("; ")}`);
      const report = buildReport(specs, readResults(f._));
      out(f.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
      return report.ok ? 0 : 1;
    }
    out(`${USAGE}\n`);
    return cmd ? 2 : 0;
  } catch (e) {
    out(`error: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  process.exitCode = main(process.argv.slice(2), { root });
}
