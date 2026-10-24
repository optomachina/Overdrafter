// Usage: node sp-report-oct17.mjs <worktree-root> <base> <head> ; runs main's sensitive-paths lib on base...head (report mode, read-only)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const [root, base, head] = process.argv.slice(2);
const { main } = await import("/workspace/qa-batch/wt-verdict/scripts/lib/sensitive-paths.mjs");
const dir = mkdtempSync(join(tmpdir(), "sp-")); const changed = join(dir, "changed.txt");
writeFileSync(changed, execFileSync("/usr/bin/git", ["-C", root, "diff", "--name-status", "-z", "--no-renames", `${base}...${head}`]));
const code = main(["report", "--root", root, "--changed-files-from", changed, "--base-ref", base], { stdout: (l) => console.log(l), stderr: (l) => console.error(l) });
console.log(`exit=${code}`);
