#!/usr/bin/env node
/**
 * vendor-pr-serialization: one open PR at a time per shared vendor-adapter file.
 *
 * Fails when this PR changes a vendor-adapter file (worker/src/adapters/**, worker/src/tools/vendor*)
 * that another open PR (draft or ready) also changes. Other open PRs that touch the vendor tree
 * but not the same files are reported as warnings only. Read-only: it lists open PRs with gh and
 * never comments, labels or merges.
 *
 *   node scripts/vendor-pr-serialization.mjs --pr <number> [--repo owner/name] [--prs-json file]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

import { isEntryPoint } from "./lib/entry-point.mjs";

export const VENDOR_PATTERNS = [/^worker\/src\/adapters\//, /^worker\/src\/tools\/vendor[^/]*$/];
export const isVendorPath = (path) => VENDOR_PATTERNS.some((re) => re.test(path));

/** prs: [{number, isDraft, files: [{path}]}]. Returns {ok, conflicts, warnings}. */
export function checkSerialization(prNumber, prs) {
  const self = prs.find((p) => p.number === prNumber);
  const mine = new Set((self?.files ?? []).map((f) => f.path).filter(isVendorPath));
  const conflicts = [];
  const warnings = [];
  if (mine.size === 0) return { ok: true, conflicts, warnings, vendorFiles: [] };
  for (const pr of prs) {
    if (pr.number === prNumber) continue;
    const theirs = (pr.files ?? []).map((f) => f.path).filter(isVendorPath);
    if (theirs.length === 0) continue;
    const shared = theirs.filter((p) => mine.has(p));
    if (shared.length) conflicts.push({ number: pr.number, isDraft: !!pr.isDraft, shared });
    else warnings.push({ number: pr.number, isDraft: !!pr.isDraft });
  }
  return { ok: conflicts.length === 0, conflicts, warnings, vendorFiles: [...mine] };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

if (isEntryPoint(import.meta.url)) {
  const pr = Number(arg("--pr"));
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error("usage: vendor-pr-serialization.mjs --pr <number> [--repo owner/name] [--prs-json file]");
    process.exit(2);
  }
  const file = arg("--prs-json");
  const prs = file
    ? JSON.parse(readFileSync(file, "utf8"))
    : JSON.parse(execFileSync("gh", ["pr", "list", "--repo", arg("--repo") ?? process.env.GITHUB_REPOSITORY,
        "--state", "open", "--limit", "200", "--json", "number,isDraft,files"], { encoding: "utf8" }));
  const r = checkSerialization(pr, prs);
  if (r.vendorFiles.length === 0) {
    console.log(`PR #${pr} changes no vendor-adapter files; nothing to serialize.`);
    process.exit(0);
  }
  for (const w of r.warnings) console.log(`::warning::Open PR #${w.number}${w.isDraft ? " (draft)" : ""} also touches vendor-adapter code (no shared files).`);
  for (const c of r.conflicts) {
    console.log(`::error::Open PR #${c.number}${c.isDraft ? " (draft)" : ""} changes the same vendor-adapter files: ${c.shared.join(", ")}`);
  }
  if (!r.ok) {
    console.log("Vendor PR serialization failed: land or rebase the other PR first, or move the shared change into one base PR.");
    process.exit(1);
  }
  console.log(`Vendor PR serialization passed for #${pr} (${r.vendorFiles.length} vendor files, ${r.warnings.length} non-overlapping vendor PRs).`);
}
