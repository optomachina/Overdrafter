#!/usr/bin/env node
/**
 * Offline tooling for repo skill evals (OVD-860). Makes no model API calls:
 * it validates eval specs, lists skills changed between two git refs, enforces
 * judge != runner, and aggregates judge score JSON into a report.
 * See docs/skill-evals.md.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Absolute path so git is not resolved through a writable PATH entry
// (SonarCloud S4036); fall back to PATH lookup where git lives elsewhere.
export const GIT_BIN = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
export const SKILL_ROOTS = [".agents/skills", ".codex/skills", ".claude/skills", ".cursor/skills"];
export const SPEC_ROOT = "evals/skills";
export const SPEC_FILE = "spec.json";
export const MAX_SCORE = 10;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeModel(id) {
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

/**
 * Reduce a model id to its base model so aliases of one model compare equal:
 * drops provider/region prefixes (`anthropic/`, `us.anthropic.`), Vertex
 * `@date` and Bedrock `-v1:0` suffixes, `-latest`, and dated snapshots.
 */
export function canonicalModel(id) {
  let m = normalizeModel(id);
  m = m.slice(m.lastIndexOf("/") + 1);
  m = m.replace(/^(?:[a-z]+\.)+/, "");
  m = m.replace(/@.*$/, "");
  m = m.replace(/-v\d+(?::\d+)?$/, "");
  m = m.replace(/-latest$/, "");
  m = m.replace(/-\d{8}$/, "");
  m = m.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return m;
}

/** Throws unless a runner and judge model are both named and are different base models. */
export function assertDistinctJudge(runner, judge) {
  const r = canonicalModel(runner);
  const j = canonicalModel(judge);
  if (!r || !j) throw new Error("runner and judge model ids are both required (non-empty strings)");
  if (r === j) throw new Error(`judge must be a different model than the runner (both "${r}")`);
}

function isGitCheckout(root) {
  return fs.existsSync(path.join(root, ".git"));
}

function gitLsFiles(root, paths) {
  const out = execFileSync(GIT_BIN, ["ls-files", "-z", "--", ...paths], { cwd: root, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/**
 * Skill name -> every repo-relative dir carrying that name, in SKILL_ROOTS
 * order. A name must live in exactly one root (validateAll rejects the rest).
 * In a git checkout only tracked skills count, so locally installed
 * (gitignored) third-party skills are not picked up.
 */
export function skillDirs(root) {
  const found = new Map();
  const tracked = isGitCheckout(root) ? gitLsFiles(root, SKILL_ROOTS) : null;
  for (const base of SKILL_ROOTS) {
    for (const name of skillNamesUnder(root, base, tracked)) {
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(path.posix.join(base, name));
    }
  }
  return found;
}

function skillNamesUnder(root, base, tracked) {
  if (tracked) {
    const prefix = `${base}/`;
    // A tracked file deleted from the working tree (not yet staged) does not
    // keep its skill present; the skill must really be on disk.
    const names = tracked.filter((f) => f.startsWith(prefix) && f.indexOf("/", prefix.length) > 0 && fs.existsSync(path.join(root, f)))
      .map((f) => f.slice(prefix.length).split("/")[0]);
    return [...new Set(names)].sort(compareCodeUnits);
  }
  const dir = path.join(root, base);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(compareCodeUnits);
}

function walkFiles(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs).flatMap((name) => walkFiles(root, path.posix.join(rel, name)));
}

/**
 * Content hash of a skill (every dir carrying its name, plus its eval spec). A
 * judge result records it as `skillHash` so a score cannot outlive the skill
 * it judged, whichever copy was edited.
 */
export function skillHash(root, name, dirs = skillDirs(root)) {
  const rels = [...(dirs.get(name) ?? []), path.posix.join(SPEC_ROOT, name)];
  const files = isGitCheckout(root) ? gitLsFiles(root, rels) : rels.flatMap((r) => walkFiles(root, r));
  const hash = crypto.createHash("sha256");
  for (const file of [...new Set(files)].sort(compareCodeUnits)) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    hash.update(`${file}\0`).update(fs.readFileSync(abs)).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
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
  spec.cases.forEach((c, i) => validateCase(c, `cases[${i}]`, caseIds, err));
  return errors;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validateCase(c, at, caseIds, err) {
  if (!c || typeof c !== "object") return err(`${at} must be an object`);
  if (!SKILL_NAME.test(c.id ?? "")) err(`${at}.id must be kebab-case`);
  else if (caseIds.has(c.id)) err(`${at}.id "${c.id}" is duplicated`);
  else caseIds.add(c.id);
  if (!isNonEmptyString(c.task)) err(`${at}.task must be a non-empty string`);
  const behaviors = c.expectedBehaviors;
  if (!Array.isArray(behaviors) || behaviors.length === 0 || !behaviors.every(isNonEmptyString)) {
    err(`${at}.expectedBehaviors must be a non-empty array of strings`);
  }
  if (!Array.isArray(c.rubric) || c.rubric.length === 0) return err(`${at}.rubric must be a non-empty array`);
  validateRubric(c.rubric, at, err);
}

function validateRubric(rubric, at, err) {
  const ids = new Set();
  let total = 0;
  for (const r of rubric) {
    if (!r || typeof r.id !== "string" || !r.id || !isNonEmptyString(r.criterion)) {
      err(`${at}.rubric entries need id and criterion`);
      continue;
    }
    if (ids.has(r.id)) err(`${at}.rubric id "${r.id}" is duplicated`);
    ids.add(r.id);
    if (!Number.isInteger(r.points) || r.points < 1) err(`${at}.rubric "${r.id}" points must be a positive integer`);
    else total += r.points;
  }
  if (total !== MAX_SCORE) err(`${at}.rubric points must sum to ${MAX_SCORE} (got ${total})`);
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
 * Specs, skill dirs and every coverage error: each present skill needs exactly
 * one dir and a spec, and each spec needs its skill dir. A spec left behind by
 * a deleted or moved skill would otherwise drop out of the report unnoticed.
 */
function inspectRepo(root) {
  const { specs, errors } = loadSpecs(root);
  const dirs = skillDirs(root);
  for (const [name, rels] of dirs) {
    if (rels.length > 1) errors.push(`${name}: skill name is used in more than one root (${rels.join(", ")}); keep one`);
    if (!specs.has(name)) errors.push(`${rels[0]}: skill has no eval spec at ${SPEC_ROOT}/${name}/${SPEC_FILE}`);
  }
  for (const name of [...specs.keys()].sort(compareCodeUnits)) {
    if (!dirs.has(name)) errors.push(`${SPEC_ROOT}/${name}: no skill directory for this spec; restore the skill or remove the spec`);
  }
  return { specs, dirs, errors };
}

export function validateAll(root) {
  const { specs, dirs, errors } = inspectRepo(root);
  return {
    ok: errors.length === 0,
    errors,
    specs: [...specs.keys()].sort(compareCodeUnits),
    skills: [...dirs.keys()].sort(compareCodeUnits),
  };
}

/** Default Array#sort ordering (UTF-16 code units), made explicit. */
function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Map a repo-relative path to the skill it belongs to, or null. Only paths
 * inside a skill or spec dir count; a loose file such as
 * `.agents/skills/README.md` belongs to no skill.
 */
export function skillForPath(file) {
  const p = file.replaceAll("\\", "/");
  const base = [...SKILL_ROOTS, SPEC_ROOT].find((b) => p.startsWith(`${b}/`));
  if (!base) return null;
  const rest = p.slice(base.length + 1);
  const cut = rest.indexOf("/");
  return cut > 0 ? rest.slice(0, cut) : null;
}

export function changedSkillsFromPaths(paths) {
  return [...new Set(paths.map(skillForPath).filter(Boolean))].sort(compareCodeUnits);
}

export function changedSkills(root, base, head) {
  for (const ref of [base, head]) {
    if (!ref || ref.startsWith("-")) throw new Error(`invalid git ref: ${ref}`);
  }
  // -z: NUL-separated, unquoted paths. Without it git quotes non-ASCII and
  // special names ("caf\303\251.md"), which would match no skill dir and drop
  // the skill from the list.
  const out = execFileSync(GIT_BIN, ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`], { cwd: root, encoding: "utf8" });
  return changedSkillsFromPaths(out.split("\0").filter(Boolean));
}

/**
 * Paths with uncommitted changes under the skill roots or the spec root:
 * staged, unstaged, deleted or untracked, ignored or not. `changed` only
 * compares commits, so an empty list cannot be trusted while any of these
 * exist. Outside a git checkout there is no git state to ask, so it returns [].
 *
 * `git status` never lists an untracked file inside a gitignored directory, and
 * this repo ignores `.agents/`, `.codex/` and `skills/` (its skills are tracked
 * only because they were force-added). So a new file in a skill, or a new skill
 * dir, would pass unseen. For every root that already holds a tracked skill
 * (the repo's own skill location), the untracked files are listed directly,
 * ignored or not; a wholly untracked dir is one `dir/` entry. A root with no
 * tracked skill (`.claude/skills`, `.cursor/skills`) is where third-party
 * skills are installed locally, so what git ignores there stays ignored.
 * `.DS_Store` is never skill work and is skipped.
 */
export function uncommittedSkillChanges(root) {
  if (!isGitCheckout(root)) return [];
  // -z: NUL-separated, unquoted `XY path` entries; --no-renames keeps one path per entry.
  const args = ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", ...SKILL_ROOTS, SPEC_ROOT];
  const out = execFileSync(GIT_BIN, args, { cwd: root, encoding: "utf8" });
  const paths = out.split("\0").filter(Boolean).map((entry) => entry.slice(3));
  const tracked = gitLsFiles(root, SKILL_ROOTS);
  const holdsSkills = SKILL_ROOTS.filter((base) => tracked.some((f) => f.startsWith(`${base}/`)));
  if (holdsSkills.length) {
    // No --exclude-standard: only --exclude=.DS_Store applies, so ignored files are listed.
    const others = ["ls-files", "-z", "--others", "--directory", "--no-empty-directory", "--exclude=.DS_Store", "--", ...holdsSkills];
    paths.push(...execFileSync(GIT_BIN, others, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean));
  }
  return [...new Set(paths)];
}

/**
 * Judge result shape: { skill, case, skillHash, runner, judge, scores: [{ id, points }] }.
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

function caseStatus(problems, total, passScore) {
  if (problems.length) return "invalid";
  return total >= passScore ? "pass" : "fail";
}

function reportCase(c, spec, mine, currentHash) {
  if (mine.length === 0) return { id: c.id, status: "unscored", total: null, problems: ["no judge result"] };
  // Only results for the current skill content count; among those the last
  // one wins so a re-run replaces earlier attempts.
  const current = currentHash ? mine.filter((r) => r.skillHash === currentHash) : mine;
  if (current.length === 0) {
    const problems = [`no judge result for current skillHash ${currentHash} (re-run and re-judge)`];
    return { id: c.id, status: "stale", total: null, problems };
  }
  const latest = current.at(-1);
  const { total, problems } = scoreResult(latest, spec);
  const status = caseStatus(problems, total, spec.passScore);
  return { id: c.id, status, total, problems, runner: latest.runner, judge: latest.judge };
}

/**
 * Options: `hashes` (skill -> current skillHash; when given, results must
 * carry a matching skillHash and a skill missing from it fails), `only` (skill
 * names in scope). Fails closed: a report passes only when at least one skill
 * was in scope and every in-scope case scored 10/10.
 */
export function buildReport(specs, results, { hashes = null, only = null } = {}) {
  const skills = [];
  for (const [name, spec] of [...specs].sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (only && !only.includes(name)) continue;
    if (hashes && !hashes.has(name)) {
      skills.push({ skill: name, status: "fail", reason: "skill directory absent", cases: [] });
      continue;
    }
    const hash = hashes?.get(name) ?? null;
    const cases = spec.cases.map((c) =>
      reportCase(c, spec, results.filter((r) => r.skill === name && r.case === c.id), hash));
    const passed = cases.length > 0 && cases.every((c) => c.status === "pass");
    skills.push({ skill: name, status: passed ? "pass" : "fail", cases });
  }
  const report = { ok: skills.length > 0 && skills.every((s) => s.status === "pass"), skills };
  if (skills.length === 0) report.reason = "no eval case was in scope, so nothing was scored";
  return report;
}

function cell(value) {
  return String(value).replaceAll("|", String.raw`\|`).replaceAll(/\r?\n/g, " ");
}

// "PASS" is reserved for a report that scored something; an empty scope says so.
function overallLabel(report) {
  if (report.nothingToRescore) return "nothing to re-score";
  return report.ok ? "PASS" : "NOT 10/10";
}

function summaryLines(report) {
  const lines = ["# Skill eval report", "", `Overall: ${overallLabel(report)}`, ""];
  if (report.reason) lines.push(`Reason: ${report.reason}`, "");
  const errors = report.errors ?? [];
  if (errors.length) lines.push(...errors.map((e) => `- error: ${e}`), "");
  return lines;
}

export function renderReport(report) {
  const lines = summaryLines(report);
  if (report.skills.length === 0) return `${lines.join("\n").trimEnd()}\n`;
  lines.push("| Skill | Case | Score | Status | Notes |", "| --- | --- | --- | --- | --- |");
  for (const s of report.skills) {
    if (s.reason) lines.push(`| ${cell(s.skill)} | - | - | ${s.status} | ${cell(s.reason)} |`);
    for (const c of s.cases) {
      lines.push(`| ${cell(s.skill)} | ${cell(c.id)} | ${c.total ?? "-"}/${MAX_SCORE} | ${c.status} | ${cell(c.problems.join("; "))} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function readResults(files) {
  const results = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file}: cannot read score JSON (${e.message})`);
    }
    const list = Array.isArray(data) ? data : [data];
    list.forEach((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.skill !== "string" || typeof r.case !== "string") {
        throw new Error(`${file}[${i}]: result must be an object with string "skill" and "case"`);
      }
    });
    results.push(...list);
  }
  return results;
}

const BOOLEAN_FLAGS = new Set(["json"]);
const REPEATABLE_FLAGS = new Set(["skill"]);

export function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      flags._.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    let value = true;
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      value = next;
      i += 1;
    }
    if (REPEATABLE_FLAGS.has(name)) (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return flags;
}

/**
 * `--skill a --skill b,c` -> ["a", "b", "c"], or null when absent. Only the
 * exact empty string (what `changed | paste -sd, -` yields when no skill
 * changed) means an empty scope, []. A blank value (spaces, tab, newline) is
 * an error, as is any other empty name, such as a bare `--skill` or `a,,b`.
 */
function skillScope(values, specs) {
  if (values === undefined) return null;
  if (values.every((v) => v === "")) return [];
  if (values.some((v) => typeof v === "string" && v !== "" && v.trim() === "")) {
    throw new Error('--skill value is blank; pass exactly "" for "no skills changed", or name a skill');
  }
  const names = values.flatMap((v) => (typeof v === "string" ? v.split(",") : [""])).map((v) => v.trim());
  if (names.some((n) => !n)) throw new Error("--skill needs a skill name");
  const unknown = names.filter((n) => !specs.has(n));
  if (unknown.length) throw new Error(`--skill: no eval spec for ${unknown.join(", ")}`);
  return [...new Set(names)];
}

const USAGE = `Usage: node scripts/skill-evals.mjs <command>
  validate                          validate all eval specs and skill coverage
  changed --base <ref> --head <ref> list skills whose dir or eval spec changed
  check-judge --runner <m> --judge <m>   fail unless the judge is a different base model
  hash <skill>...                   print the skillHash a judge result must carry
  report [--json] [--skill <name>]... <scores.json>...
                                    aggregate judge results (exit 1 unless validate
                                    passes and every in-scope case is 10/10; the one
                                    exception is --skill "", meaning nothing changed)`;

function runValidate(f, root, out) {
  const r = validateAll(root);
  for (const e of r.errors) out(`error: ${e}\n`);
  out(r.ok ? `ok: ${r.specs.length} specs, ${r.skills.length} skills present\n` : "validation failed\n");
  return r.ok ? 0 : 1;
}

function runChanged(f, root, out) {
  if (typeof f.base !== "string" || typeof f.head !== "string") throw new Error("--base and --head are required");
  const names = changedSkills(root, f.base, f.head);
  out(names.length ? `${names.join("\n")}\n` : "");
  return 0;
}

function runCheckJudge(f, _root, out) {
  if (!isNonEmptyString(f.runner) || !isNonEmptyString(f.judge)) {
    throw new Error("--runner and --judge both need a non-empty model id");
  }
  assertDistinctJudge(f.runner, f.judge);
  out(`ok: judge ${normalizeModel(f.judge)} differs from runner ${normalizeModel(f.runner)}\n`);
  return 0;
}

function runHash(f, root, out) {
  if (f._.length === 0) throw new Error("at least one skill name is required");
  const dirs = skillDirs(root);
  for (const name of f._) {
    const rels = dirs.get(name);
    if (!rels) throw new Error(`skill "${name}" is not present in this checkout`);
    if (rels.length > 1) throw new Error(`skill "${name}" is in more than one root (${rels.join(", ")}); run validate`);
    out(`${name} ${skillHash(root, name, dirs)}\n`);
  }
  return 0;
}

/**
 * `report --skill ""` is the documented pipeline's "no skills changed" case.
 * Nothing needs scoring, so it is the one report that may pass with no case
 * scored. `changed` only compares commits, so it refuses (exit 1) while a skill
 * or spec dir has uncommitted changes, and it labels the result "nothing to
 * re-score" rather than PASS.
 */
function nothingChangedReport(root) {
  const dirty = uncommittedSkillChanges(root);
  if (dirty.length) {
    return { ok: false, reason: "uncommitted skill changes; commit first", errors: dirty.map((p) => `uncommitted: ${p}`), skills: [] };
  }
  return { ok: true, nothingToRescore: true, reason: "no skills changed, so there is nothing to re-score", skills: [] };
}

function runReport(f, root, out) {
  const { specs, dirs, errors } = inspectRepo(root);
  const only = skillScope(f.skill, specs);
  // No scores file is required or read when nothing changed.
  const noneChanged = only?.length === 0;
  if (!noneChanged && f._.length === 0) throw new Error("at least one scores file is required");
  const results = noneChanged ? [] : readResults(f._);
  let report;
  // Scoped or not, a report cannot pass while `validate` fails: a skill with
  // no spec, a spec with no skill, or a name in two roots is never scored.
  if (errors.length) {
    report = { ok: false, reason: "validation failed (see node scripts/skill-evals.mjs validate)", errors, skills: [] };
  } else if (noneChanged) {
    report = nothingChangedReport(root);
  } else {
    const hashes = new Map([...dirs.keys()].map((n) => [n, skillHash(root, n, dirs)]));
    report = buildReport(specs, results, { hashes, only });
  }
  out(f.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  return report.ok ? 0 : 1;
}

const COMMANDS = new Map([
  ["validate", runValidate],
  ["changed", runChanged],
  ["check-judge", runCheckJudge],
  ["hash", runHash],
  ["report", runReport],
]);

export function main(argv, { root = process.cwd(), out = (s) => process.stdout.write(s) } = {}) {
  const [cmd, ...rest] = argv;
  const f = parseFlags(rest);
  try {
    const run = COMMANDS.get(cmd);
    if (run) return run(f, root, out);
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
