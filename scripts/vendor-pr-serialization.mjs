#!/usr/bin/env node
/**
 * vendor-pr-serialization: one open PR at a time per shared vendor-adapter file.
 *
 * Fails when a PR changes a vendor-adapter file (worker/src/adapters/**, worker/src/tools/vendor*)
 * that another open PR (draft or ready) also changes. Other open PRs that touch the vendor tree
 * but not the same files are warnings only. --all re-checks every open vendor PR (schedule/push).
 *
 * Read-only: GitHub REST API via fetch with GITHUB_TOKEN from the env (never logged). It never
 * comments, labels or merges. Fails closed: an API error, a malformed response or a hit page cap
 * fails the check instead of passing on partial data.
 *
 *   node scripts/vendor-pr-serialization.mjs (--pr <number> | --all) [--repo owner/name] [--prs-json file]
 */
import { readFileSync } from "node:fs";
import process from "node:process";

import { isEntryPoint } from "./lib/entry-point.mjs";

export const VENDOR_PATTERNS = [/^worker\/src\/adapters\//, /^worker\/src\/tools\/vendor[^/]*$/];
export const isVendorPath = (path) => VENDOR_PATTERNS.some((re) => re.test(path));
export const PER_PAGE = 100;
export const MAX_PR_PAGES = 10; // 1000 open PRs
export const MAX_FILE_PAGES = 30; // GitHub lists at most 3000 files per PR

/** Fetch every page of a list endpoint; throws on HTTP error, non-array body or a hit page cap. */
export async function fetchAllPages(fetchImpl, url, token, maxPages) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetchImpl(`${url}${sep}per_page=${PER_PAGE}&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url} page ${page}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`GitHub API returned a non-list body for ${url} page ${page}`);
    items.push(...body);
    if (body.length < PER_PAGE) return items;
  }
  throw new Error(`page cap hit: ${url} has more than ${maxPages * PER_PAGE} items; refusing to pass on partial data`);
}

/** All open PRs with all their changed files: [{number, isDraft, files: [{path}]}]. */
export async function listOpenPrs({ repo, token, fetchImpl = globalThis.fetch }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("missing or invalid --repo / GITHUB_REPOSITORY");
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const api = `https://api.github.com/repos/${repo}`;
  const pulls = await fetchAllPages(fetchImpl, `${api}/pulls?state=open`, token, MAX_PR_PAGES);
  const out = [];
  for (const p of pulls) {
    if (!Number.isInteger(p?.number)) throw new Error("GitHub API returned a PR without a number");
    const files = await fetchAllPages(fetchImpl, `${api}/pulls/${p.number}/files`, token, MAX_FILE_PAGES);
    if (Number.isInteger(p.changed_files) && files.length < p.changed_files) {
      throw new Error(`PR #${p.number} lists ${files.length} of ${p.changed_files} changed files; refusing to pass on partial data`);
    }
    out.push({ number: p.number, isDraft: !!p.draft, files: files.map((f) => ({ path: f.filename })) });
  }
  return out;
}

/** prs: [{number, isDraft, files: [{path}]}]. Returns {ok, conflicts, warnings, vendorFiles}. */
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

/** Every pair of open PRs that share a vendor-adapter file. */
export function checkAll(prs) {
  const pairs = [];
  for (let i = 0; i < prs.length; i++) {
    const a = new Set((prs[i].files ?? []).map((f) => f.path).filter(isVendorPath));
    if (a.size === 0) continue;
    for (let j = i + 1; j < prs.length; j++) {
      const shared = (prs[j].files ?? []).map((f) => f.path).filter((p) => isVendorPath(p) && a.has(p));
      if (shared.length) pairs.push({ a: prs[i].number, b: prs[j].number, shared });
    }
  }
  return { ok: pairs.length === 0, pairs };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const all = process.argv.includes("--all");
  const pr = Number(arg("--pr"));
  if (!all && (!Number.isInteger(pr) || pr <= 0)) {
    console.error("usage: vendor-pr-serialization.mjs (--pr <number> | --all) [--repo owner/name] [--prs-json file]");
    return 2;
  }
  const file = arg("--prs-json");
  const prs = file
    ? JSON.parse(readFileSync(file, "utf8"))
    : await listOpenPrs({ repo: arg("--repo") ?? process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
  if (all) {
    const r = checkAll(prs);
    for (const p of r.pairs) console.log(`::error::Open PRs #${p.a} and #${p.b} change the same vendor-adapter files: ${p.shared.join(", ")}`);
    console.log(r.ok ? `Vendor PR serialization passed for all ${prs.length} open PRs.` : `Vendor PR serialization failed: ${r.pairs.length} overlapping PR pairs.`);
    return r.ok ? 0 : 1;
  }
  const r = checkSerialization(pr, prs);
  if (r.vendorFiles.length === 0) {
    console.log(`PR #${pr} changes no vendor-adapter files; nothing to serialize.`);
    return 0;
  }
  for (const w of r.warnings) console.log(`::warning::Open PR #${w.number}${w.isDraft ? " (draft)" : ""} also touches vendor-adapter code (no shared files).`);
  for (const c of r.conflicts) {
    console.log(`::error::Open PR #${c.number}${c.isDraft ? " (draft)" : ""} changes the same vendor-adapter files: ${c.shared.join(", ")}`);
  }
  if (!r.ok) {
    console.log("Vendor PR serialization failed: land or rebase the other PR first, or move the shared change into one base PR.");
    return 1;
  }
  console.log(`Vendor PR serialization passed for #${pr} (${r.vendorFiles.length} vendor files, ${r.warnings.length} non-overlapping vendor PRs).`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::error::Vendor PR serialization could not complete (failing closed): ${err.message}`);
      process.exit(1);
    },
  );
}
