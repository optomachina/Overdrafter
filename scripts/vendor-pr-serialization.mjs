#!/usr/bin/env node
/**
 * vendor-pr-serialization: one open PR at a time per shared vendor-adapter file.
 *
 * Fails when a PR changes a vendor-adapter file (worker/src/adapters/** or vendor-named files
 * directly in worker/src/tools/ or worker/src/,
 * old or new path of a rename) that an OLDER open PR (draft or ready; earlier created_at, tie broken
 * by lower number) also changes, so the oldest PR can always merge. Overlaps with newer PRs and other
 * open PRs that touch the vendor tree without shared files are warnings only.
 * --all (schedule/push) reports every overlapping pair with its older and newer PR (the newer one is
 * blocked) and exits 1 while any pair exists, matching the failing --pr check on the newer PR.
 *
 * Read-only: GitHub REST API via fetch with GITHUB_TOKEN from the env (never logged). It never
 * comments, labels or merges. Console output carries only PR numbers and counts; shared file paths and
 * error details go to the file named by GITHUB_STEP_SUMMARY when it is set. Fails closed: an API error, a malformed response or a hit page cap
 * fails a vendor check, as does the PR itself missing from the open list, a repeated PR number, a PR
 * without an integer changed_files, or a file list shorter than changed_files.
 *
 *   node scripts/vendor-pr-serialization.mjs (--pr <number> | --all) [--repo owner/name] [--prs-json file]
 */
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";

import { isEntryPoint } from "./lib/entry-point.mjs";

export const VENDOR_PATTERNS = [
  /^worker\/src\/adapters\//,
  /^worker\/src\/tools\/[^/]*vendor[^/]*$/i,
  /^worker\/src\/[^/]*vendor[^/]*$/i,
];
export const isVendorPath = (path) => VENDOR_PATTERNS.some((re) => re.test(path));

/** Extract the queued PR number; reject unexpected refs rather than skipping the check. */
export function parseMergeGroupHeadRef(ref) {
  const match = typeof ref === "string" && /^gh-readonly-queue\/main\/pr-([1-9]\d*)-[a-f0-9]+$/.exec(ref);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(number) || match[0] !== ref) throw new Error("Invalid merge_group head_ref");
  return number;
}
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

const prPaths = (pr) => (pr.files ?? []).flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path]));
const vendorPaths = (pr) => [...new Set(prPaths(pr).filter(isVendorPath))];

function createdMs(pr) {
  const ms = Date.parse(pr.createdAt);
  if (!Number.isFinite(ms)) throw new Error(`PR #${pr.number} has no valid createdAt`);
  return ms;
}

/** True when a was opened before b (earlier createdAt, tie broken by lower number). */
export function isOlder(a, b) {
  const d = createdMs(a) - createdMs(b);
  return d !== 0 ? d < 0 : a.number < b.number;
}

/** Throws on a PR without a number or a PR number listed twice (e.g. pagination shifted mid-run). */
export function assertUniquePrs(prs) {
  const seen = new Set();
  for (const p of prs) {
    if (!Number.isInteger(p?.number)) throw new Error("GitHub API returned a PR without a number");
    if (seen.has(p.number)) throw new Error(`open-PR list repeats PR #${p.number}; refusing to pass on inconsistent data`);
    seen.add(p.number);
  }
}

function toFile(prNumber, f) {
  if (typeof f?.filename !== "string") throw new Error(`PR #${prNumber} lists a file without a string filename`);
  if (f.previous_filename != null && typeof f.previous_filename !== "string") {
    throw new Error(`PR #${prNumber} lists a file with a non-string previous_filename`);
  }
  return f.previous_filename ? { path: f.filename, previousPath: f.previous_filename } : { path: f.filename };
}

/**
 * All open PRs with all their changed files: [{number, isDraft, createdAt, files: [{path, previousPath?}]}].
 * Each PR is re-read with GET /pulls/{n} (the list endpoint has no changed_files) and its paginated file
 * list must cover changed_files. With prNumber, fetch that PR first and skip the open list entirely
 * when it has no vendor files. Vendor PRs require a complete open list and every other PR's files;
 * an individual fetch failure must fail closed because it may hide an overlap.
 */
export async function listOpenPrs({ repo, token, prNumber, fetchImpl = globalThis.fetch }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("missing or invalid --repo / GITHUB_REPOSITORY");
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const api = `https://api.github.com/repos/${repo}`;
  const fetchPr = async (number) => {
    const res = await fetchImpl(`${api}/pulls/${number}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${api}/pulls/${number}`);
    const detail = await res.json();
    if (detail?.number !== number) throw new Error(`GitHub API returned the wrong PR for #${number}`);
    if (!Number.isInteger(detail.changed_files)) throw new Error(`PR #${number} has no integer changed_files`);
    const files = await fetchAllPages(fetchImpl, `${api}/pulls/${number}/files`, token, MAX_FILE_PAGES);
    if (files.length < detail.changed_files) {
      throw new Error(`PR #${number} lists ${files.length} of ${detail.changed_files} changed files; refusing to pass on partial data`);
    }
    const pr = { number, isDraft: !!detail.draft, createdAt: detail.created_at, files: files.map((f) => toFile(number, f)) };
    createdMs(pr);
    return pr;
  };
  const self = prNumber === undefined ? undefined : await fetchPr(prNumber);
  if (self && vendorPaths(self).length === 0) return [self];

  const pulls = await fetchAllPages(fetchImpl, `${api}/pulls?state=open`, token, MAX_PR_PAGES);
  assertUniquePrs(pulls);
  if (self && !pulls.some((p) => p.number === prNumber)) {
    throw new Error(`PR #${prNumber} is not in the open-PR list; refusing to pass without its files`);
  }
  const out = [];
  for (const { number } of pulls) {
    // Sequential requests bound concurrency to one; reuse the already validated target PR.
    out.push(number === prNumber ? self : await fetchPr(number));
  }
  return out;
}

/**
 * prs: [{number, isDraft, createdAt, files: [{path, previousPath?}]}]. Returns {ok, conflicts, warnings, vendorFiles}.
 * conflicts: OLDER open PRs (draft included) sharing a vendor file; they go first, so this PR fails.
 * warnings: newer PRs sharing a file (they wait for this one; entry has `shared`) and vendor PRs with no shared file.
 * Throws when prNumber is missing from prs or a PR number repeats.
 */
export function checkSerialization(prNumber, prs) {
  assertUniquePrs(prs);
  const self = prs.find((p) => p.number === prNumber);
  if (!self) throw new Error(`PR #${prNumber} is not in the open-PR list; refusing to pass without its files`);
  const mine = new Set(vendorPaths(self));
  const conflicts = [];
  const warnings = [];
  if (mine.size === 0) return { ok: true, conflicts, warnings, vendorFiles: [] };
  for (const pr of prs) {
    if (pr.number === prNumber) continue;
    const theirs = vendorPaths(pr);
    if (theirs.length === 0) continue;
    const shared = theirs.filter((p) => mine.has(p));
    if (!shared.length) warnings.push({ number: pr.number, isDraft: !!pr.isDraft });
    else if (isOlder(pr, self)) conflicts.push({ number: pr.number, isDraft: !!pr.isDraft, shared });
    else warnings.push({ number: pr.number, isDraft: !!pr.isDraft, shared });
  }
  return { ok: conflicts.length === 0, conflicts, warnings, vendorFiles: [...mine] };
}

/**
 * Every pair of open PRs that share a vendor-adapter file, as {older, newer, shared}; the newer PR is the
 * one its own --pr check blocks. ok is false while any pair exists, so --all exits 1 until the pair clears.
 */
export function checkAll(prs) {
  assertUniquePrs(prs);
  const pairs = [];
  for (let i = 0; i < prs.length; i++) {
    const a = new Set(vendorPaths(prs[i]));
    if (a.size === 0) continue;
    for (let j = i + 1; j < prs.length; j++) {
      const shared = vendorPaths(prs[j]).filter((p) => a.has(p));
      if (!shared.length) continue;
      const [older, newer] = isOlder(prs[i], prs[j]) ? [prs[i], prs[j]] : [prs[j], prs[i]];
      pairs.push({ older: older.number, newer: newer.number, shared });
    }
  }
  return { ok: pairs.length === 0, pairs };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

const draftTag = (pr) => (pr.isDraft ? " (draft)" : "");
const fileList = (paths) => paths.map((p) => `\`${p}\``).join(", ");

/**
 * Console lines for --all carry only PR numbers and counts (this process holds GITHUB_TOKEN, so no
 * API-derived text is logged); the shared file paths go to the step summary only.
 */
export function reportAll(prCount, r) {
  const lines = r.pairs.map((p) => `::error::Open PR #${p.newer} is blocked by older PR #${p.older} (${p.shared.length} shared vendor files).`);
  lines.push(r.ok ? `Vendor PR serialization passed for all ${prCount} open PRs.` : `Vendor PR serialization failed: ${r.pairs.length} overlapping PR pairs.`);
  const summary = r.pairs.map((p) => `- #${p.newer} is blocked by older #${p.older}; shared: ${fileList(p.shared)}`);
  return { code: r.ok ? 0 : 1, lines, summary };
}

/** Console lines for --pr: PR numbers and counts only; shared file paths go to the step summary. */
export function reportPr(prNumber, r) {
  if (r.vendorFiles.length === 0) {
    return { code: 0, lines: [`PR #${prNumber} changes no vendor-adapter files; nothing to serialize.`], summary: [] };
  }
  const lines = [];
  const summary = [];
  for (const w of r.warnings) {
    const what = w.shared ? `is newer and waits for this PR (${w.shared.length} shared vendor files)` : "also touches vendor-adapter code (no shared files)";
    lines.push(`::warning::Open PR #${w.number}${draftTag(w)} ${what}.`);
    if (w.shared) summary.push(`- newer #${w.number}${draftTag(w)} waits for this PR; shared: ${fileList(w.shared)}`);
  }
  for (const c of r.conflicts) {
    lines.push(`::error::Older open PR #${c.number}${draftTag(c)} changes ${c.shared.length} of the same vendor-adapter files.`);
    summary.push(`- older #${c.number}${draftTag(c)} blocks this PR; shared: ${fileList(c.shared)}`);
  }
  if (!r.ok) {
    lines.push("Vendor PR serialization failed: land the older PR first, or move the shared change into one base PR.");
    return { code: 1, lines, summary };
  }
  lines.push(`Vendor PR serialization passed for #${prNumber} (${r.vendorFiles.length} vendor files, ${r.warnings.length} other vendor PRs as warnings).`);
  return { code: 0, lines, summary };
}

/**
 * CLI body. deps: {repo, token, summaryFile, fetchImpl, log}. Never throws: any failure logs a fixed
 * fail-closed message (no API-derived text) and returns 1; the error detail goes to summaryFile only.
 */
export async function main(argv, { repo, token, summaryFile, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const writeSummary = (title, body) => {
    if (summaryFile && body.length) appendFileSync(summaryFile, `### ${title}\n\n${body.join("\n")}\n\n`);
  };
  const all = argv.includes("--all");
  const pr = Number(arg(argv, "--pr"));
  if (!all && (!Number.isInteger(pr) || pr <= 0)) {
    log("usage: vendor-pr-serialization.mjs (--pr <number> | --all) [--repo owner/name] [--prs-json file]");
    return 2;
  }
  try {
    const file = arg(argv, "--prs-json");
    const prs = file
      ? JSON.parse(readFileSync(file, "utf8"))
      : await listOpenPrs({ repo: arg(argv, "--repo") ?? repo, token, prNumber: all ? undefined : pr, fetchImpl });
    const out = all ? reportAll(prs.length, checkAll(prs)) : reportPr(pr, checkSerialization(pr, prs));
    for (const line of out.lines) log(line);
    writeSummary("Vendor PR serialization: shared vendor-adapter files", out.summary);
    return out.code;
  } catch (err) {
    log("::error::Vendor PR serialization could not complete (failing closed); see the job summary for details.");
    try {
      writeSummary("Vendor PR serialization error", [String(err?.message ?? err)]);
    } catch {
      // The fixed message above already fails the check.
    }
    return 1;
  }
}

/** Settles a main() promise into proc.exitCode; a rejection logs only a fixed message (no API data). */
export function runCli(mainPromise, { error = console.error, proc = process } = {}) {
  return mainPromise.then(
    (code) => {
      proc.exitCode = code;
    },
    () => {
      error("vendor-pr-serialization failed");
      proc.exitCode = 1;
    },
  );
}

if (isEntryPoint(import.meta.url)) {
  await runCli(
    main(process.argv.slice(2), {
      repo: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      summaryFile: process.env.GITHUB_STEP_SUMMARY,
    }),
  );
}
