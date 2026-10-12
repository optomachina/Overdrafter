#!/usr/bin/env node
/**
 * Installs the proposed guardrail from tools/guardrails/proposed/ into
 * .claude/ and adds or replaces the AGENTS.md "Migration window" section.
 * Everything is validated before any file is written.
 *
 * After apply, tools/guardrails/proposed/ stays the one source of truth:
 * apply copies the hook and its test byte for byte, and the staged test
 * fails if .claude/hooks drifts from the proposed copy.
 *
 * The CLAUDECODE check below is a speed bump, not a security boundary: an
 * agent can unset the variable. The real control is that the result is a
 * diff to .claude/ and AGENTS.md that Blaine commits and reviews in a PR.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.CLAUDECODE) {
  console.error("apply.mjs: refusing to run inside Claude Code. Blaine runs this from a normal terminal.");
  process.exit(1);
}

const root = new URL("../../", import.meta.url);
const path = (rel) => fileURLToPath(new URL(rel, root));
const proposed = (name) => path(`tools/guardrails/proposed/${name}`);
const HOOK_COMMAND = "guard-migrations.mjs";
const fail = (message) => {
  console.error(`apply.mjs: ${message}. Nothing was changed.`);
  process.exit(1);
};

// 1. Validate everything before touching any file.
execFileSync(process.execPath, ["--check", proposed("guard-migrations.mjs")], { stdio: "inherit" });
const settings = JSON.parse(readFileSync(proposed("settings.json"), "utf8"));
const deny = settings.permissions?.deny;
if (!Array.isArray(deny) || deny.length === 0 || !deny.every((rule) => typeof rule === "string" && rule.trim() === rule && rule !== "")) {
  fail("proposed settings.json permissions.deny must be a non empty list of rule strings");
}
for (const rule of ["Edit(/supabase/migrations/**)", "Edit(//**/supabase/migrations/**)", "mcp__*__apply_migration"]) {
  if (!deny.includes(rule)) fail(`proposed permissions.deny is missing ${rule}`);
}
const tooBroad = deny.filter((rule) => /execute_sql|merge_pull_request|enable_pr_auto_merge/.test(rule));
if (tooBroad.length > 0) fail(`proposed permissions.deny must not deny ${tooBroad.join(", ")}; the hook decides those`);
const matchers = (settings.hooks?.PreToolUse ?? []).map((entry) => entry.matcher);
for (const matcher of ["Bash", "Edit|Write|MultiEdit|NotebookEdit", "mcp__.*"]) {
  if (!matchers.includes(matcher)) fail(`proposed settings.json has no PreToolUse hook for ${matcher}`);
}

const section = readFileSync(proposed("AGENTS-section.md"), "utf8");
if (!section.startsWith("### Migration window\n")) fail("AGENTS-section.md must start with the ### Migration window heading");
if (/\n#{1,3} /.test(section.slice(1))) fail("AGENTS-section.md must hold exactly one section");
for (const phrase of ["blaine-window", "retired", "--setting-sources user,local", "local CLI sessions", "workers never merge", "CLAUDE.md"]) {
  if (!section.includes(phrase)) fail(`AGENTS-section.md must mention "${phrase}"`);
}
const agents = readFileSync(path("AGENTS.md"), "utf8");
let start = agents.indexOf("### Migration window");
let end;
if (start >= 0) {
  const nextHeading = /\n#{2,3} /g;
  nextHeading.lastIndex = start + 1;
  end = nextHeading.exec(agents)?.index ?? -1;
  if (end < 0) fail("AGENTS.md: no heading follows the Migration window section");
  end += 1;
} else {
  start = agents.indexOf("## Standing approvals and the Blaine channel");
  if (start < 0) fail("AGENTS.md: neither a Migration window section nor the Standing approvals heading to insert before was found");
  end = start;
}

const testOutput = execFileSync(process.execPath, ["--test", proposed("guard-migrations.node-test.mjs")], { encoding: "utf8" });
const passed = /# pass (\d+)/.exec(testOutput)?.[1] ?? "?";

let merged = settings;
const settingsPath = path(".claude/settings.json");
if (existsSync(settingsPath)) {
  const current = JSON.parse(readFileSync(settingsPath, "utf8"));
  const keep = (current.hooks?.PreToolUse ?? []).filter((entry) => !(entry.hooks ?? []).some((h) => String(h.command ?? "").includes(HOOK_COMMAND)));
  merged = {
    ...current,
    permissions: { ...current.permissions, deny: [...new Set([...(current.permissions?.deny ?? []), ...deny])] },
    hooks: { ...current.hooks, PreToolUse: [...keep, ...settings.hooks.PreToolUse] },
  };
}

// 2. Install.
const install = (to, write) => {
  write(`${to}.tmp`);
  renameSync(`${to}.tmp`, to);
};
mkdirSync(path(".claude/hooks"), { recursive: true });
install(path(".claude/hooks/guard-migrations.mjs"), (tmp) => copyFileSync(proposed("guard-migrations.mjs"), tmp));
install(path(".claude/hooks/guard-migrations.node-test.mjs"), (tmp) => copyFileSync(proposed("guard-migrations.node-test.mjs"), tmp));
install(settingsPath, (tmp) => writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`));
const replacement = `${section.trimEnd()}\n\n`;
install(path("AGENTS.md"), (tmp) => writeFileSync(tmp, `${agents.slice(0, start)}${replacement}${agents.slice(end)}`));

const claudeMd = existsSync(path("CLAUDE.md")) ? readFileSync(path("CLAUDE.md"), "utf8") : "";
console.log(
  [
    "Guardrail applied.",
    `  hook tests: ${passed} passed against the proposed copy`,
    `  deny rules: ${merged.permissions.deny.length} in .claude/settings.json`,
    "  copied: .claude/hooks/guard-migrations.mjs, .claude/hooks/guard-migrations.node-test.mjs, .claude/settings.json",
    "  updated: AGENTS.md Migration window section",
    ...(claudeMd.includes("PreToolUse hook") ? ["  note: CLAUDE.md still has the PreToolUse paragraph from PR #664; remove it before committing."] : []),
    "Review with git diff, then commit and push. Restart Claude Code sessions so they load the new settings.",
  ].join("\n"),
);
