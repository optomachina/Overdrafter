// Test helpers shared by the migration lint family CLI tests
// (lint-security-definer.test.mjs, lint-rls-new-tables.test.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway git repo with one legacy migration holding legacySql. */
export function makeLintRepo(prefix, legacySql) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "lint@example.invalid");
  git("config", "user.name", "lint");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "supabase/migrations/20200101000000_legacy.sql"), legacySql);
  return { root, git };
}

/** Run a lint main() capturing stdout and stderr; returns {code, out}. */
export function runLintMain(main, argv) {
  const out = [];
  const code = main(argv, { stdout: (line) => out.push(line), stderr: (line) => out.push(line), env: {} });
  return { code, out: out.join("\n") };
}
