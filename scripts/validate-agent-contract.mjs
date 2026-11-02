import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SENSITIVE_PATHS_FILE, checkAgentsParity, createMatcher, loadSensitivePaths, parseSensitivePaths } from "./lib/sensitive-paths.mjs";
import { gateEventMatrixErrors } from "./ovd-merge-gate-event-matrix.mjs";

export const NON_SENSITIVE_ALLOWLIST = "scripts/fixtures/sensitive-paths/non-sensitive-allowlist.json";
export const RISKY_ROOTS = Object.freeze(["scripts", ".github/workflows", ".github/actions", "supabase/migrations"]);
export const RISKY_ROOT_FILES = Object.freeze([".gitleaks.toml", ".gitleaksignore"]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DIGIT_LIKE = /like\s+'%\d{3,8}%'/i;
const REAL_SYNC = /\.sync\(|\.datasync\(|\bfsyncSync\b|\bfdatasyncSync\b/;
const MOCKED_SYNC = /spyOn\([\s\S]{0,180}["'](?:sync|datasync)["']/;

function walkFiles(repoRoot, relDir, acc, accept) {
  const abs = path.join(repoRoot, relDir);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(repoRoot, rel, acc, accept);
    else if (entry.isFile() && accept(rel)) acc.push(rel);
  }
}

function listRiskyFiles(repoRoot) {
  const files = [];
  for (const risky of RISKY_ROOTS) walkFiles(repoRoot, risky, files, () => true);
  for (const file of RISKY_ROOT_FILES) {
    if (fs.existsSync(path.join(repoRoot, file))) files.push(file);
  }
  return files.sort();
}

/**
 * Files under the risky roots must match a sensitive-path glob. scripts/ may
 * instead be named in the allow-list. Workflows, actions, migrations and the
 * gitleaks config cannot.
 */
export function riskyRootCoverageErrors(repoRoot = root, options = {}) {
  if (!fs.existsSync(path.join(repoRoot, "scripts"))) return [];
  const allowPath = path.join(repoRoot, NON_SENSITIVE_ALLOWLIST);
  if (!fs.existsSync(allowPath)) return [`${NON_SENSITIVE_ALLOWLIST} is missing`];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(allowPath, "utf8"));
  } catch (error) {
    return [`${NON_SENSITIVE_ALLOWLIST} is not valid JSON: ${error.message}`];
  }
  const errors = [];
  if (parsed.version !== 1 || !Array.isArray(parsed.paths)) {
    errors.push(`${NON_SENSITIVE_ALLOWLIST} must be {version: 1, paths: [...]}`);
  }
  const listed = Array.isArray(parsed.paths) ? parsed.paths : [];
  const sorted = [...listed].sort();
  if (listed.some((item, index) => item !== sorted[index]) || new Set(listed).size !== listed.length) {
    errors.push(`${NON_SENSITIVE_ALLOWLIST} paths must be unique and sorted`);
  }
  for (const item of listed) {
    if (typeof item !== "string" || !item.startsWith("scripts/") || item.includes("..")) {
      errors.push(`${NON_SENSITIVE_ALLOWLIST} may name only scripts/ files, not ${item}`);
    }
  }
  let classify = options.classify;
  if (!classify) {
    try {
      const matcher = createMatcher(loadSensitivePaths({ root: repoRoot }));
      classify = (file) => matcher.classify(file);
    } catch (error) {
      return [...errors, error.message];
    }
  }
  const allow = new Set(listed.filter((item) => typeof item === "string"));
  const present = new Set(listRiskyFiles(repoRoot));
  for (const file of present) {
    if (classify(file).length > 0) continue;
    if (file.startsWith("scripts/") && allow.has(file)) continue;
    const hint = file.startsWith("scripts/")
      ? `Classify it in docs/sensitive-paths.json and the AGENTS.md mirror, or add this non-gate scripts/ path to ${NON_SENSITIVE_ALLOWLIST}`
      : "Add a sensitive-path glob. This root has no allow-list";
    errors.push(`${file} matches no sensitive-path glob. ${hint}`);
  }
  for (const file of listed) {
    if (typeof file !== "string" || !present.has(file)) {
      if (typeof file === "string" && file.startsWith("scripts/")) errors.push(`${NON_SENSITIVE_ALLOWLIST} lists missing ${file}`);
      continue;
    }
    if (classify(file).length > 0) errors.push(`${file} is classified; remove it from ${NON_SENSITIVE_ALLOWLIST}`);
  }
  return errors;
}

/** Unanchored digit LIKE and real fsync in unit tests. Both flaked in the 2026-10-26 week. */
export function testDeterminismErrors(repoRoot = root) {
  const errors = [];
  const sql = [];
  const tests = [];
  walkFiles(repoRoot, "supabase/tests", sql, (rel) => rel.endsWith(".sql"));
  walkFiles(repoRoot, "scripts", sql, (rel) => rel.endsWith(".sql"));
  walkFiles(repoRoot, "scripts", tests, (rel) => /\.(?:test|node-test)\.mjs$/.test(rel));
  walkFiles(repoRoot, "src", tests, (rel) => /\.(?:test|spec)\.tsx?$/.test(rel));
  for (const file of sql) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    if (DIGIT_LIKE.test(text)) {
      errors.push(`${file} uses an unanchored digit LIKE (like '%7075%'). Anchor the token so it cannot match inside a hash or UUID`);
    }
  }
  for (const file of tests) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    if (DIGIT_LIKE.test(text)) {
      errors.push(`${file} uses an unanchored digit LIKE (like '%7075%'). Anchor the token so it cannot match inside a hash or UUID`);
    }
    if (REAL_SYNC.test(text) && !MOCKED_SYNC.test(text)) {
      errors.push(`${file} calls FileHandle sync or fsync without mocking it. Mock sync and datasync so the test does not wait on the disk journal`);
    }
  }
  return errors;
}

export function validateAgentContract(repoRoot = root) {
  const read = (name) => fs.readFileSync(path.join(repoRoot, name), "utf8");
  const agents = read("AGENTS.md");
  const claude = read("CLAUDE.md");
  const workflow = read("WORKFLOW.md");
  const errors = [];

  if (Buffer.byteLength(agents) > 24 * 1024) {
    errors.push("AGENTS.md exceeds the 24 KiB repository budget");
  }
  if (Buffer.byteLength(claude) > 2 * 1024) {
    errors.push("CLAUDE.md is no longer a thin adapter");
  }
  for (const required of [
    "Synthetic-fixture lane",
    "Complexity alone never requires human approval",
    "durable run store are authoritative",
    "governor observes liveness",
  ]) {
    if (!agents.includes(required)) errors.push(`AGENTS.md missing: ${required}`);
  }
  for (const prohibited of [
    "High-complexity override",
    "one attempt, zero retries",
    "internal plan state is the execution source of truth",
  ]) {
    if (agents.toLowerCase().includes(prohibited.toLowerCase())) {
      errors.push(`AGENTS.md retains obsolete gate: ${prohibited}`);
    }
  }
  if (/gpt-5\.3|shell_environment_policy\.inherit=all/.test(workflow)) {
    errors.push("WORKFLOW.md retains an obsolete model or inherited-all environment setting");
  }
  // OVD-873: the AGENTS.md sensitive-paths list mirrors the JSON in both directions.
  let sensitivePaths = null;
  try {
    sensitivePaths = parseSensitivePaths(read(SENSITIVE_PATHS_FILE));
  } catch (error) {
    errors.push(error.code === "ENOENT" ? `${SENSITIVE_PATHS_FILE} is missing` : error.message);
  }
  if (sensitivePaths) errors.push(...checkAgentsParity(agents, sensitivePaths));
  errors.push(...riskyRootCoverageErrors(repoRoot));
  errors.push(...testDeterminismErrors(repoRoot));
  errors.push(...gateEventMatrixErrors(repoRoot));
  const turns = Number(workflow.match(/max_turns:\s*(\d+)/)?.[1] ?? 0);
  if (turns < 10) errors.push("WORKFLOW.md does not allow sustained continuation");
  if (!workflow.includes("command: bash ./scripts/symphony-agent.sh")) {
    errors.push("WORKFLOW.md must start Codex through the guarded Symphony launcher");
  }
  return errors;
}

/**
 * True when node was asked to run this file. Realpaths are compared because
 * node runs a script given through a symlinked path (macOS /tmp, for example)
 * from its real path, so comparing the given path skipped the CLI silently.
 */
function invokedAsScript(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  const errors = validateAgentContract(root);
  if (errors.length) {
    for (const error of errors) console.error(`agent-contract: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("agent-contract: valid");
  }
}
