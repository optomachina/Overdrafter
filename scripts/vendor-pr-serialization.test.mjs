import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCli,
  MAX_FILE_PAGES,
  PER_PAGE,
  checkAll,
  checkSerialization,
  fetchAllPages,
  isVendorPath,
  parseMergeGroupHeadRef,
  listOpenPrs,
  main,
} from "./vendor-pr-serialization.mjs";

// Reuse the repository's Vitest globals, or run directly with node --test.
const { describe, it } = globalThis.describe && globalThis.it ? globalThis : await import("node:test");

const at = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const pr = (number, paths, isDraft = false, createdAt = at(number)) => ({
  number,
  isDraft,
  createdAt,
  files: paths.map((path) => ({ path })),
});

describe("vendor-pr-serialization", () => {
  it("matches vendor adapters and vendor-named files directly in tools or src", () => {
    assert.equal(isVendorPath("worker/src/adapters/index.ts"), true);
    assert.equal(isVendorPath("worker/src/tools/vendorAuth.ts"), true);
    assert.equal(isVendorPath("worker/src/tools/_vendorQuoteInputBuilders.ts"), true);
    assert.equal(isVendorPath("worker/src/tools/enabledPortalVendors.ts"), true);
    assert.equal(isVendorPath("worker/src/vendorTaskRetry.ts"), true);
    assert.equal(isVendorPath("worker/src/tools/EnabledPortalVENDORS.ts"), true);
    assert.equal(isVendorPath("worker/src/tools/other.ts"), false);
    assert.equal(isVendorPath("worker/src/other.ts"), false);
    assert.equal(isVendorPath("worker/src/tools/nested/vendor.ts"), false);
    assert.equal(isVendorPath("worker/src/vendor/nested.ts"), false);
    assert.equal(isVendorPath("src/features/quotes/vendor-colors.ts"), false);
  });

  it("passes a PR with no vendor files", () => {
    const r = checkSerialization(1, [pr(1, ["README.md"]), pr(2, ["worker/src/adapters/index.ts"])]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.vendorFiles, []);
  });

  it("fails when an older open PR, draft included, shares a vendor file", () => {
    const r = checkSerialization(2, [
      pr(1, ["worker/src/adapters/index.ts"], true),
      pr(2, ["worker/src/adapters/index.ts", "worker/src/adapters/xometry.ts"]),
    ]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.conflicts, [{ number: 1, isDraft: true, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("orders overlapping PRs by created_at: the older passes, the newer fails", () => {
    // #8 was opened before #5, so #8 goes first despite its higher number.
    const prs = [pr(5, ["worker/src/adapters/index.ts"], false, at(20)), pr(8, ["worker/src/adapters/index.ts"], true, at(10))];
    const older = checkSerialization(8, prs);
    assert.equal(older.ok, true);
    assert.deepEqual(older.warnings, [{ number: 5, isDraft: false, shared: ["worker/src/adapters/index.ts"] }]);
    const newer = checkSerialization(5, prs);
    assert.equal(newer.ok, false);
    assert.deepEqual(newer.conflicts, [{ number: 8, isDraft: true, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("breaks a created_at tie on the lower PR number", () => {
    const prs = [pr(3, ["worker/src/adapters/a.ts"], false, at(1)), pr(4, ["worker/src/adapters/a.ts"], false, at(1))];
    assert.equal(checkSerialization(3, prs).ok, true);
    assert.equal(checkSerialization(4, prs).ok, false);
  });

  it("fails when the PR itself is missing from the list", () => {
    assert.throws(() => checkSerialization(9, [pr(1, ["worker/src/adapters/index.ts"])]), /#9 is not in the open-PR list/);
  });

  it("fails when a PR number repeats", () => {
    assert.throws(() => checkSerialization(1, [pr(1, ["README.md"]), pr(2, ["x"]), pr(2, ["y"])]), /repeats PR #2/);
  });

  it("detects an overlap through a rename's previous path", () => {
    const moved = { ...pr(2, []), files: [{ path: "worker/src/moved.ts", previousPath: "worker/src/adapters/x.ts" }] };
    const r = checkSerialization(2, [pr(1, ["worker/src/adapters/x.ts"]), moved]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.conflicts, [{ number: 1, isDraft: false, shared: ["worker/src/adapters/x.ts"] }]);
  });

  it("only warns when another vendor PR touches different files", () => {
    const r = checkSerialization(1, [pr(1, ["worker/src/adapters/xometry.ts"]), pr(2, ["worker/src/adapters/geomiq.ts"])]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, [{ number: 2, isDraft: false }]);
  });
});

describe("parseMergeGroupHeadRef", () => {
  it("extracts the PR number from a merge queue head ref", () => {
    assert.equal(parseMergeGroupHeadRef("gh-readonly-queue/main/pr-929-abc123def"), 929);
  });

  it("rejects missing, malformed, or unsafe refs", () => {
    for (const ref of [
      undefined, "", "refs/heads/main",
      "gh-readonly-queue/main/pr-0-abc123",
      "gh-readonly-queue/main/pr-929-",
      "gh-readonly-queue/main/pr-929-notasha",
      "gh-readonly-queue/main/pr-929-abc123/extra",
      "gh-readonly-queue/other/pr-929-abc123",
      "gh-readonly-queue/main/pr-9007199254740992-abc123",
      "gh-readonly-queue/main/pr-929-abc123\n",
    ]) {
      assert.throws(() => parseMergeGroupHeadRef(ref), /Invalid merge_group head_ref/);
    }
  });
});

const pageOf = (url) => Number(new URL(url, "https://x").searchParams.get("page"));
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, json: async () => ({}) };
/** Mock GitHub: pulls = [{number, draft, created_at, changed_files, files: [...]}]. */
const github = (pulls, { list = pulls } = {}) => async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith("/pulls")) return ok(pageOf(url) === 1 ? list.map(({ number, draft }) => ({ number, draft })) : []);
  const m = path.match(/\/pulls\/(\d+)(\/files)?$/);
  const p = m && pulls.find((x) => x.number === Number(m[1]));
  if (!p) return notFound;
  if (m[2]) return ok(pageOf(url) === 1 ? p.files : []);
  const { files: _files, ...detail } = p;
  return ok(detail);
};
const page = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ filename: `f${start + i}`, number: start + i + 1 }));

describe("fetchAllPages / listOpenPrs (fail closed)", () => {
  it("fetches the target's details and files before listing other PRs", async () => {
    const calls = [];
    const shared = { filename: "worker/src/adapters/index.ts" };
    const mock = github([
      { number: 1, created_at: at(1), changed_files: 1, files: [shared] },
      { number: 2, created_at: at(2), changed_files: 1, files: [shared] },
    ]);
    await listOpenPrs({ repo: "o/r", token: "t", prNumber: 2, fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      return mock(url);
    } });
    assert.deepEqual(calls, [
      "/repos/o/r/pulls/2", "/repos/o/r/pulls/2/files", "/repos/o/r/pulls",
      "/repos/o/r/pulls/1", "/repos/o/r/pulls/1/files",
    ]);
  });

  it("passes a non-vendor PR without listing PRs or reaching another PR's failing files endpoint", async () => {
    const calls = [];
    const mock = github([
      { number: 1, created_at: at(1), changed_files: 1, files: [{ filename: "worker/src/adapters/a.ts" }] },
      { number: 2, created_at: at(2), changed_files: 1, files: [{ filename: "README.md" }] },
    ]);
    const code = await main(["--pr", "2"], { repo: "o/r", token: "t", log: () => {}, fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname.endsWith("/pulls/1/files")) return { ok: false, status: 500 };
      return mock(url);
    } });
    assert.equal(code, 0);
    assert.deepEqual(calls, ["/repos/o/r/pulls/2", "/repos/o/r/pulls/2/files"]);
  });

  it("fails closed for a vendor PR when another PR's files endpoint fails", async () => {
    const mock = github([
      { number: 1, created_at: at(1), changed_files: 1, files: [{ filename: "README.md" }] },
      { number: 2, created_at: at(2), changed_files: 1, files: [{ filename: "worker/src/vendorTaskRetry.ts" }] },
    ]);
    const code = await main(["--pr", "2"], { repo: "o/r", token: "t", log: () => {}, fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/pulls/1/files")) return { ok: false, status: 500 };
      return mock(url);
    } });
    assert.equal(code, 1);
  });

  it("follows pagination until a short page", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return ok(pageOf(url) === 1 ? page(PER_PAGE) : page(3, PER_PAGE));
    };
    const items = await fetchAllPages(fetchImpl, "https://api.github.com/x", "t", 5);
    assert.equal((items).length, PER_PAGE + 3);
    assert.equal((calls).length, 2);
    assert.ok((calls[1]).includes("page=2"));
  });

  it("throws when the page cap is hit", async () => {
    const fetchImpl = async () => ok(page(PER_PAGE));
    await assert.rejects(fetchAllPages(fetchImpl, "https://api.github.com/x", "t", 2), /page cap hit/);
  });

  it("throws on an API error or a non-list body", async () => {
    await assert.rejects(fetchAllPages(async () => ({ ok: false, status: 502 }), "u", "t", 2), /502/);
    await assert.rejects(fetchAllPages(async () => ok({ message: "x" }), "u", "t", 2), /non-list/);
  });

  it("caps PR files at MAX_FILE_PAGES and fails on a truncated file list", async () => {
    assert.equal(MAX_FILE_PAGES * PER_PAGE, 3000);
    const fetchImpl = github([{ number: 7, draft: true, created_at: at(1), changed_files: 2, files: [{ filename: "worker/src/adapters/a.ts" }] }]);
    await assert.rejects(listOpenPrs({ repo: "o/r", token: "t", fetchImpl }), /1 of 2 changed files/);
  });

  it("reads changed_files from GET /pulls/{n}, not the list, and fails when it is missing", async () => {
    // The list endpoint has no changed_files, so a truncated file list must be caught via the detail call.
    const fetchImpl = github([{ number: 7, draft: false, created_at: at(1), changed_files: 3, files: [{ filename: "a" }] }]);
    await assert.rejects(listOpenPrs({ repo: "o/r", token: "t", fetchImpl }), /1 of 3 changed files/);
    const noCount = github([{ number: 7, draft: false, created_at: at(1), files: [{ filename: "a" }] }]);
    await assert.rejects(listOpenPrs({ repo: "o/r", token: "t", fetchImpl: noCount }), /no integer changed_files/);
  });

  it("fails when the PR itself is not in the open list or the list repeats a PR", async () => {
    const one = { number: 1, draft: false, created_at: at(1), changed_files: 0, files: [] };
    const target = { ...one, number: 2, changed_files: 1, files: [{ filename: "worker/src/adapters/a.ts" }] };
    await assert.rejects(listOpenPrs({ repo: "o/r", token: "t", prNumber: 2, fetchImpl: github([one, target], { list: [one] }) }), /#2 is not in the open-PR list/);
    await assert.rejects(listOpenPrs({ repo: "o/r", token: "t", fetchImpl: github([one], { list: [one, one] }) }), /repeats PR #1/);
  });

  it("keeps previous_filename and createdAt, and fails on a file without a string filename", async () => {
    const renamed = { filename: "worker/src/moved.ts", previous_filename: "worker/src/adapters/x.ts" };
    const prs = await listOpenPrs({
      repo: "o/r",
      token: "t",
      prNumber: 4,
      fetchImpl: github([{ number: 4, draft: true, created_at: at(2), changed_files: 1, files: [renamed] }]),
    });
    assert.deepEqual(prs, [
      { number: 4, isDraft: true, createdAt: at(2), files: [{ path: "worker/src/moved.ts", previousPath: "worker/src/adapters/x.ts" }] },
    ]);
    const bad = github([{ number: 4, draft: false, created_at: at(2), changed_files: 1, files: [{ status: "added" }] }]);
    await assert.rejects(listOpenPrs({ repo: "o/r", token: "t", fetchImpl: bad }), /without a string filename/);
  });

  it("keeps isDraft per PR and still counts an older draft as a conflict", async () => {
    const shared = { filename: "worker/src/adapters/index.ts" };
    const fetchImpl = github([
      { number: 1, draft: true, created_at: at(1), changed_files: 1, files: [shared] },
      { number: 2, draft: false, created_at: at(2), changed_files: 1, files: [shared] },
    ]);
    const prs = await listOpenPrs({ repo: "o/r", token: "t", prNumber: 2, fetchImpl });
    assert.deepEqual(prs.map(({ number, isDraft }) => ({ number, isDraft })), [
      { number: 1, isDraft: true },
      { number: 2, isDraft: false },
    ]);
    const r = checkSerialization(2, prs);
    assert.equal(r.ok, false);
    assert.deepEqual(r.conflicts, [{ number: 1, isDraft: true, shared: ["worker/src/adapters/index.ts"] }]);
    assert.deepEqual(checkSerialization(1, prs).warnings, [{ number: 2, isDraft: false, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("requires a token and a valid repo", async () => {
    await assert.rejects(listOpenPrs({ repo: "o/r", token: "", fetchImpl: async () => ok([]) }), /GITHUB_TOKEN/);
    await assert.rejects(listOpenPrs({ repo: "bad", token: "t", fetchImpl: async () => ok([]) }), /repo/);
  });

  it("returns PRs with all files across pages", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/files")) return ok(pageOf(url) === 1 ? page(PER_PAGE) : page(1, PER_PAGE));
      if (new URL(url).pathname.endsWith("/pulls/9")) return ok({ number: 9, draft: false, created_at: at(1), changed_files: PER_PAGE + 1 });
      return ok([{ number: 9, draft: false }]);
    };
    const prs = await listOpenPrs({ repo: "o/r", token: "t", fetchImpl });
    assert.equal((prs[0].files).length, PER_PAGE + 1);
  });
});

describe("checkAll", () => {
  it("reports every overlapping pair with its older and newer PR", () => {
    const r = checkAll([
      pr(1, ["worker/src/adapters/index.ts"], false, at(15)),
      pr(2, ["worker/src/adapters/index.ts"], true, at(5)),
      pr(3, ["worker/src/adapters/other.ts"]),
    ]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.pairs, [{ older: 2, newer: 1, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("passes when no pair overlaps and fails on a repeated PR number", () => {
    assert.equal(checkAll([pr(1, ["worker/src/adapters/a.ts"]), pr(2, ["worker/src/adapters/b.ts"])]).ok, true);
    assert.throws(() => checkAll([pr(1, ["a"]), pr(1, ["b"])]), /repeats PR #1/);
  });
});

describe("main (CLI output)", () => {
  const ADAPTER = "worker/src/adapters/index.ts";
  const setup = (prs) => {
    const dir = mkdtempSync(path.join(tmpdir(), "vendor-ser-"));
    const prsJson = path.join(dir, "prs.json");
    writeFileSync(prsJson, JSON.stringify(prs));
    const summaryFile = path.join(dir, "summary.md");
    const lines = [];
    const log = (line) => lines.push(line);
    const summary = () => {
      try {
        return readFileSync(summaryFile, "utf8");
      } catch {
        return "";
      }
    };
    return { prsJson, summaryFile, lines, log, summary };
  };

  it("logs a --pr conflict with PR numbers and counts only; paths go to the step summary", async () => {
    const t = setup([pr(1, [ADAPTER, "worker/src/tools/vendorAuth.ts"], true), pr(2, [ADAPTER, "worker/src/tools/vendorAuth.ts"])]);
    const code = await main(["--pr", "2", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log });
    assert.equal(code, 1);
    const out = t.lines.join("\n");
    assert.ok((out).includes("::error::Older open PR #1 (draft) changes 2 of the same vendor-adapter files."));
    assert.doesNotMatch(out, /worker\/|adapters|vendorAuth|\.ts\b/);
    assert.ok((t.summary()).includes(ADAPTER));
    assert.ok((t.summary()).includes("worker/src/tools/vendorAuth.ts"));
  });

  it("logs no paths for a newer-PR warning", async () => {
    const t = setup([pr(1, [ADAPTER]), pr(2, [ADAPTER])]);
    assert.equal(await main(["--pr", "1", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log }), 0);
    assert.ok((t.lines.join("\n")).includes("::warning::Open PR #2 is newer and waits for this PR (1 shared vendor files)."));
    assert.doesNotMatch(t.lines.join("\n"), /worker\/|adapters/);
    assert.ok((t.summary()).includes(ADAPTER));
  });

  it("logs --all pairs with PR numbers and counts only", async () => {
    const t = setup([pr(1, [ADAPTER], false, at(15)), pr(2, [ADAPTER], true, at(5))]);
    assert.equal(await main(["--all", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log }), 1);
    assert.deepEqual(t.lines, [
      "::error::Open PR #1 is blocked by older PR #2 (1 shared vendor files).",
      "Vendor PR serialization failed: 1 overlapping PR pairs.",
    ]);
    assert.ok((t.summary()).includes(ADAPTER));
  });

  it("reports --all --report-only pairs as warnings and exits 0", async () => {
    const t = setup([pr(1, [ADAPTER], false, at(15)), pr(2, [ADAPTER], true, at(5))]);
    assert.equal(await main(["--all", "--report-only", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log }), 0);
    assert.deepEqual(t.lines, [
      "::warning::Open PR #1 is blocked by older PR #2 (1 shared vendor files).",
      "Vendor PR serialization found 1 overlapping PR pairs (report-only; each newer PR's own check blocks it).",
    ]);
    assert.doesNotMatch(t.lines.join("\n"), /::error::|worker\/|adapters/);
    assert.ok((t.summary()).includes(ADAPTER));
  });

  it("passes --all --report-only with no overlaps", async () => {
    const t = setup([pr(1, [ADAPTER]), pr(2, ["worker/src/adapters/other.ts"])]);
    assert.equal(await main(["--all", "--report-only", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log }), 0);
    assert.deepEqual(t.lines, ["Vendor PR serialization passed for all 2 open PRs."]);
  });

  it("still fails closed on API errors in --report-only mode", async () => {
    const t = setup([]);
    const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
    assert.equal(await main(["--all", "--report-only"], { repo: "o/r", token: "t", summaryFile: t.summaryFile, fetchImpl, log: t.log }), 1);
    assert.deepEqual(t.lines, ["::error::Vendor PR serialization could not complete (failing closed); see the job summary for details."]);
  });

  it("keeps --pr blocking and rejects --report-only without --all", async () => {
    const t = setup([pr(1, [ADAPTER]), pr(2, [ADAPTER])]);
    assert.equal(await main(["--pr", "2", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log }), 1);
    const lines = [];
    assert.equal(await main(["--pr", "2", "--report-only", "--prs-json", t.prsJson], { log: (l) => lines.push(l) }), 2);
    assert.match(lines[0], /^usage:/);
  });

  it("works without a step summary file", async () => {
    const lines = [];
    const t = setup([pr(1, [ADAPTER], true), pr(2, [ADAPTER])]);
    assert.equal(await main(["--pr", "2", "--prs-json", t.prsJson], { log: (l) => lines.push(l) }), 1);
    assert.ok(!(lines.join("\n")).includes(ADAPTER));
  });

  it("fails closed with a fixed message when the PR itself is missing (prs-json and API paths)", async () => {
    const t = setup([pr(1, [ADAPTER])]);
    assert.equal(await main(["--pr", "9", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log }), 1);
    const one = { number: 1, draft: false, created_at: at(1), changed_files: 1, files: [{ filename: ADAPTER }] };
    const target = { ...one, number: 9 };
    assert.equal(await main(["--pr", "9"], { repo: "o/r", token: "t", summaryFile: t.summaryFile, fetchImpl: github([one, target], { list: [one] }), log: t.log }), 1);
    const fixed = "::error::Vendor PR serialization could not complete (failing closed); see the job summary for details.";
    assert.deepEqual(t.lines, [fixed, fixed]);
    assert.ok((t.summary()).includes("#9 is not in the open-PR list"));
  });

  it("does not echo API-derived error text to the log", async () => {
    const t = setup([]);
    const fetchImpl = async () => {
      throw new Error("boom from worker/src/adapters/leak.ts");
    };
    assert.equal(await main(["--all"], { repo: "o/r", token: "t", summaryFile: t.summaryFile, fetchImpl, log: t.log }), 1);
    assert.doesNotMatch(t.lines.join("\n"), /boom|leak|adapters/);
    assert.ok((t.summary()).includes("boom from worker/src/adapters/leak.ts"));
  });

  it("rejects a missing --pr with usage and exit 2", async () => {
    const lines = [];
    assert.equal(await main([], { log: (l) => lines.push(l) }), 2);
    assert.match(lines[0], /^usage:/);
  });
});

describe("runCli", () => {
  it("sets exitCode 1 and logs only the fixed message when main rejects", async () => {
    const errors = [];
    const proc = {};
    await runCli(Promise.reject(new Error("worker/src/adapters/secret.ts detail")), { error: (m) => errors.push(m), proc });
    assert.equal(proc.exitCode, 1);
    assert.deepEqual(errors, ["vendor-pr-serialization failed"]);
  });

  it("passes main's exit code through", async () => {
    const proc = {};
    await runCli(Promise.resolve(2), { error: () => {}, proc });
    assert.equal(proc.exitCode, 2);
  });
});
