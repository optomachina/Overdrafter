// Import boundary for the design graph: channel and UI code may reach the graph only
// through server/design-graph/index.ts, and never import worker modules directly.
//
// findBoundaryViolations is pure (file contents in, violations out); scanRepo adds the
// filesystem walk. Run directly to print a report: npx tsx server/design-graph/import-boundary.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/** is the UI, api/** the HTTP surface, server/chatgpt the ChatGPT channel.
export const DEFAULT_SCAN_DIRS = ["src", "api", "server/chatgpt"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".next", ".vercel", ".turbo"]);
const GRAPH_DIR = "server/design-graph";
const GRAPH_PUBLIC_ENTRIES = new Set([GRAPH_DIR, `${GRAPH_DIR}/index`, `${GRAPH_DIR}/index.ts`, `${GRAPH_DIR}/index.js`]);

export interface SourceFile {
  // Repo-relative POSIX path.
  path: string;
  content: string;
}

export interface BoundaryViolation {
  file: string;
  line: number;
  specifier: string;
  resolved: string;
  reason: "worker_import" | "design_graph_internal_import";
}

const IMPORT_PATTERNS = [
  // import x from "m"; import type { x } from "m"; export { x } from "m"; import "m";
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g,
  // import("m"), require("m")
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.posix.normalize(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return null;
}

function classify(resolved: string): BoundaryViolation["reason"] | null {
  if (resolved === "worker" || resolved.startsWith("worker/")) return "worker_import";
  if (resolved === GRAPH_DIR || resolved.startsWith(`${GRAPH_DIR}/`)) {
    return GRAPH_PUBLIC_ENTRIES.has(resolved) ? null : "design_graph_internal_import";
  }
  return null;
}

export function findBoundaryViolations(files: SourceFile[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of files) {
    const seen = new Set<number>();
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of file.content.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (seen.has(index)) continue;
        seen.add(index);
        const specifier = match[1];
        const resolved = resolveSpecifier(file.path, specifier);
        const reason = resolved ? classify(resolved) : null;
        if (!resolved || !reason) continue;
        const line = file.content.slice(0, index).split("\n").length;
        violations.push({ file: file.path, line, specifier, resolved, reason });
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function collectSourceFiles(repoRoot: string, scanDirs: string[] = DEFAULT_SCAN_DIRS): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (relDir: string) => {
    for (const entry of readdirSync(path.join(repoRoot, relDir), { withFileTypes: true })) {
      const rel = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(rel);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
        files.push({ path: rel, content: readFileSync(path.join(repoRoot, rel), "utf8") });
      }
    }
  };
  for (const dir of scanDirs) {
    const absolute = path.join(repoRoot, dir);
    let isDir = false;
    try {
      isDir = statSync(absolute).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) walk(dir.split(path.sep).join("/"));
  }
  return files;
}

export interface BoundaryReport {
  scannedDirs: string[];
  fileCount: number;
  violations: BoundaryViolation[];
}

export function scanRepo(repoRoot: string, scanDirs: string[] = DEFAULT_SCAN_DIRS): BoundaryReport {
  const files = collectSourceFiles(repoRoot, scanDirs);
  return { scannedDirs: scanDirs, fileCount: files.length, violations: findBoundaryViolations(files) };
}

export function formatReport(report: BoundaryReport): string {
  const header = `design-graph import boundary: scanned ${report.fileCount} files in ${report.scannedDirs.join(", ")}`;
  if (report.violations.length === 0) return `${header}\nOK: no worker or design-graph internal imports`;
  const lines = report.violations.map(
    (v) => `  ${v.file}:${v.line} imports "${v.specifier}" (${v.resolved}) [${v.reason}]`,
  );
  return `${header}\nFAIL: ${report.violations.length} violation(s)\n${lines.join("\n")}`;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const repoRoot = path.resolve(path.dirname(thisFile), "../..");
  const report = scanRepo(repoRoot);
  console.log(formatReport(report));
  process.exitCode = report.violations.length === 0 ? 0 : 1;
}
