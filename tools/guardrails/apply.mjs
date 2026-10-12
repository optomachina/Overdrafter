#!/usr/bin/env node
/**
 * Copies the proposed guardrail from tools/guardrails/proposed/ into .claude/
 * after validating it, and swaps the AGENTS.md "Migration window" section.
 * A human runs this from a normal terminal; it refuses to run inside Claude
 * Code, because agents must not edit their own guardrails.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.CLAUDECODE) {
  console.error("apply.mjs: refusing to run inside Claude Code. Blaine runs this from a normal terminal.");
  process.exit(1);
}

const root = new URL("../../", import.meta.url);
const path = (rel) => fileURLToPath(new URL(rel, root));
const proposed = (name) => path(`tools/guardrails/proposed/${name}`);

execFileSync(process.execPath, ["--check", proposed("guard-migrations.mjs")], { stdio: "inherit" });
const settings = JSON.parse(readFileSync(proposed("settings.json"), "utf8"));
const testOutput = execFileSync(process.execPath, ["--test", proposed("guard-migrations.node-test.mjs")], { encoding: "utf8" });
const passed = /# pass (\d+)/.exec(testOutput)?.[1] ?? "?";

const install = (from, to) => {
  copyFileSync(from, `${to}.tmp`);
  renameSync(`${to}.tmp`, to);
};
install(proposed("guard-migrations.mjs"), path(".claude/hooks/guard-migrations.mjs"));
install(proposed("guard-migrations.node-test.mjs"), path(".claude/hooks/guard-migrations.node-test.mjs"));
install(proposed("settings.json"), path(".claude/settings.json"));

const agents = readFileSync(path("AGENTS.md"), "utf8");
const start = agents.indexOf("### Migration window");
const end = agents.indexOf("\n## ", start);
if (start < 0 || end < 0) throw new Error("AGENTS.md: Migration window section not found");
writeFileSync(path("AGENTS.md"), `${agents.slice(0, start)}${readFileSync(proposed("AGENTS-section.md"), "utf8")}${agents.slice(end)}`);

console.log(
  [
    "Guardrail applied.",
    `  hook tests: ${passed} passed against the proposed copy`,
    `  deny rules: ${settings.permissions.deny.length} in .claude/settings.json`,
    "  copied: .claude/hooks/guard-migrations.mjs, .claude/hooks/guard-migrations.node-test.mjs, .claude/settings.json",
    "  updated: AGENTS.md Migration window section",
    "Review with git diff, then commit and push. Restart Claude Code sessions so they load the new settings.",
  ].join("\n"),
);
