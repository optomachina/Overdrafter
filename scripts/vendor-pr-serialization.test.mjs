import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  runCli,
  MAX_FILE_PAGES,
  PER_PAGE,
  checkAll,
  checkSerialization,
  fetchAllPages,
  isVendorPath,
  listOpenPrs,
  main,
} from "./vendor-pr-serialization.mjs";

const at = (day) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
const pr = (number, paths, isDraft = false, createdAt = at(number)) => ({
  number,
  isDraft,
  createdAt,
  files: paths.map((path) => ({ path })),
});

describe("vendor-pr-serialization", () => {
  it("matches vendor adapter and vendor tool paths only", () => {
    expect(isVendorPath("worker/src/adapters/index.ts")).toBe(true);
    expect(isVendorPath("worker/src/tools/vendorAuth.ts")).toBe(true);
    expect(isVendorPath("worker/src/tools/other.ts")).toBe(false);
    expect(isVendorPath("src/features/quotes/vendor-colors.ts")).toBe(false);
  });

  it("passes a PR with no vendor files", () => {
    const r = checkSerialization(1, [pr(1, ["README.md"]), pr(2, ["worker/src/adapters/index.ts"])]);
    expect(r.ok).toBe(true);
    expect(r.vendorFiles).toEqual([]);
  });

  it("fails when an older open PR, draft included, shares a vendor file", () => {
    const r = checkSerialization(2, [
      pr(1, ["worker/src/adapters/index.ts"], true),
      pr(2, ["worker/src/adapters/index.ts", "worker/src/adapters/xometry.ts"]),
    ]);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ number: 1, isDraft: true, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("orders overlapping PRs by created_at: the older passes, the newer fails", () => {
    // #8 was opened before #5, so #8 goes first despite its higher number.
    const prs = [pr(5, ["worker/src/adapters/index.ts"], false, at(20)), pr(8, ["worker/src/adapters/index.ts"], true, at(10))];
    const older = checkSerialization(8, prs);
    expect(older.ok).toBe(true);
    expect(older.warnings).toEqual([{ number: 5, isDraft: false, shared: ["worker/src/adapters/index.ts"] }]);
    const newer = checkSerialization(5, prs);
    expect(newer.ok).toBe(false);
    expect(newer.conflicts).toEqual([{ number: 8, isDraft: true, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("breaks a created_at tie on the lower PR number", () => {
    const prs = [pr(3, ["worker/src/adapters/a.ts"], false, at(1)), pr(4, ["worker/src/adapters/a.ts"], false, at(1))];
    expect(checkSerialization(3, prs).ok).toBe(true);
    expect(checkSerialization(4, prs).ok).toBe(false);
  });

  it("fails when the PR itself is missing from the list", () => {
    expect(() => checkSerialization(9, [pr(1, ["worker/src/adapters/index.ts"])])).toThrow(/#9 is not in the open-PR list/);
  });

  it("fails when a PR number repeats", () => {
    expect(() => checkSerialization(1, [pr(1, ["README.md"]), pr(2, ["x"]), pr(2, ["y"])])).toThrow(/repeats PR #2/);
  });

  it("detects an overlap through a rename's previous path", () => {
    const moved = { ...pr(2, []), files: [{ path: "worker/src/moved.ts", previousPath: "worker/src/adapters/x.ts" }] };
    const r = checkSerialization(2, [pr(1, ["worker/src/adapters/x.ts"]), moved]);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ number: 1, isDraft: false, shared: ["worker/src/adapters/x.ts"] }]);
  });

  it("only warns when another vendor PR touches different files", () => {
    const r = checkSerialization(1, [pr(1, ["worker/src/adapters/xometry.ts"]), pr(2, ["worker/src/adapters/geomiq.ts"])]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([{ number: 2, isDraft: false }]);
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
  it("follows pagination until a short page", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return ok(pageOf(url) === 1 ? page(PER_PAGE) : page(3, PER_PAGE));
    };
    const items = await fetchAllPages(fetchImpl, "https://api.github.com/x", "t", 5);
    expect(items).toHaveLength(PER_PAGE + 3);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("page=2");
  });

  it("throws when the page cap is hit", async () => {
    const fetchImpl = async () => ok(page(PER_PAGE));
    await expect(fetchAllPages(fetchImpl, "https://api.github.com/x", "t", 2)).rejects.toThrow(/page cap hit/);
  });

  it("throws on an API error or a non-list body", async () => {
    await expect(fetchAllPages(async () => ({ ok: false, status: 502 }), "u", "t", 2)).rejects.toThrow(/502/);
    await expect(fetchAllPages(async () => ok({ message: "x" }), "u", "t", 2)).rejects.toThrow(/non-list/);
  });

  it("caps PR files at MAX_FILE_PAGES and fails on a truncated file list", async () => {
    expect(MAX_FILE_PAGES * PER_PAGE).toBe(3000);
    const fetchImpl = github([{ number: 7, draft: true, created_at: at(1), changed_files: 2, files: [{ filename: "worker/src/adapters/a.ts" }] }]);
    await expect(listOpenPrs({ repo: "o/r", token: "t", fetchImpl })).rejects.toThrow(/1 of 2 changed files/);
  });

  it("reads changed_files from GET /pulls/{n}, not the list, and fails when it is missing", async () => {
    // The list endpoint has no changed_files, so a truncated file list must be caught via the detail call.
    const fetchImpl = github([{ number: 7, draft: false, created_at: at(1), changed_files: 3, files: [{ filename: "a" }] }]);
    await expect(listOpenPrs({ repo: "o/r", token: "t", fetchImpl })).rejects.toThrow(/1 of 3 changed files/);
    const noCount = github([{ number: 7, draft: false, created_at: at(1), files: [{ filename: "a" }] }]);
    await expect(listOpenPrs({ repo: "o/r", token: "t", fetchImpl: noCount })).rejects.toThrow(/no integer changed_files/);
  });

  it("fails when the PR itself is not in the open list or the list repeats a PR", async () => {
    const one = { number: 1, draft: false, created_at: at(1), changed_files: 0, files: [] };
    await expect(listOpenPrs({ repo: "o/r", token: "t", prNumber: 2, fetchImpl: github([one]) })).rejects.toThrow(/#2 is not in the open-PR list/);
    await expect(listOpenPrs({ repo: "o/r", token: "t", fetchImpl: github([one], { list: [one, one] }) })).rejects.toThrow(/repeats PR #1/);
  });

  it("keeps previous_filename and createdAt, and fails on a file without a string filename", async () => {
    const renamed = { filename: "worker/src/moved.ts", previous_filename: "worker/src/adapters/x.ts" };
    const prs = await listOpenPrs({
      repo: "o/r",
      token: "t",
      prNumber: 4,
      fetchImpl: github([{ number: 4, draft: true, created_at: at(2), changed_files: 1, files: [renamed] }]),
    });
    expect(prs).toEqual([
      { number: 4, isDraft: true, createdAt: at(2), files: [{ path: "worker/src/moved.ts", previousPath: "worker/src/adapters/x.ts" }] },
    ]);
    const bad = github([{ number: 4, draft: false, created_at: at(2), changed_files: 1, files: [{ status: "added" }] }]);
    await expect(listOpenPrs({ repo: "o/r", token: "t", fetchImpl: bad })).rejects.toThrow(/without a string filename/);
  });

  it("keeps isDraft per PR and still counts an older draft as a conflict", async () => {
    const shared = { filename: "worker/src/adapters/index.ts" };
    const fetchImpl = github([
      { number: 1, draft: true, created_at: at(1), changed_files: 1, files: [shared] },
      { number: 2, draft: false, created_at: at(2), changed_files: 1, files: [shared] },
    ]);
    const prs = await listOpenPrs({ repo: "o/r", token: "t", prNumber: 2, fetchImpl });
    expect(prs.map(({ number, isDraft }) => ({ number, isDraft }))).toEqual([
      { number: 1, isDraft: true },
      { number: 2, isDraft: false },
    ]);
    const r = checkSerialization(2, prs);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ number: 1, isDraft: true, shared: ["worker/src/adapters/index.ts"] }]);
    expect(checkSerialization(1, prs).warnings).toEqual([{ number: 2, isDraft: false, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("requires a token and a valid repo", async () => {
    await expect(listOpenPrs({ repo: "o/r", token: "", fetchImpl: async () => ok([]) })).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(listOpenPrs({ repo: "bad", token: "t", fetchImpl: async () => ok([]) })).rejects.toThrow(/repo/);
  });

  it("returns PRs with all files across pages", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/files")) return ok(pageOf(url) === 1 ? page(PER_PAGE) : page(1, PER_PAGE));
      if (new URL(url).pathname.endsWith("/pulls/9")) return ok({ number: 9, draft: false, created_at: at(1), changed_files: PER_PAGE + 1 });
      return ok([{ number: 9, draft: false }]);
    };
    const prs = await listOpenPrs({ repo: "o/r", token: "t", fetchImpl });
    expect(prs[0].files).toHaveLength(PER_PAGE + 1);
  });
});

describe("checkAll", () => {
  it("reports every overlapping pair with its older and newer PR", () => {
    const r = checkAll([
      pr(1, ["worker/src/adapters/index.ts"], false, at(15)),
      pr(2, ["worker/src/adapters/index.ts"], true, at(5)),
      pr(3, ["worker/src/adapters/other.ts"]),
    ]);
    expect(r.ok).toBe(false);
    expect(r.pairs).toEqual([{ older: 2, newer: 1, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("passes when no pair overlaps and fails on a repeated PR number", () => {
    expect(checkAll([pr(1, ["worker/src/adapters/a.ts"]), pr(2, ["worker/src/adapters/b.ts"])]).ok).toBe(true);
    expect(() => checkAll([pr(1, ["a"]), pr(1, ["b"])])).toThrow(/repeats PR #1/);
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
    expect(code).toBe(1);
    const out = t.lines.join("\n");
    expect(out).toContain("::error::Older open PR #1 (draft) changes 2 of the same vendor-adapter files.");
    expect(out).not.toMatch(/worker\/|adapters|vendorAuth|\.ts\b/);
    expect(t.summary()).toContain(ADAPTER);
    expect(t.summary()).toContain("worker/src/tools/vendorAuth.ts");
  });

  it("logs no paths for a newer-PR warning", async () => {
    const t = setup([pr(1, [ADAPTER]), pr(2, [ADAPTER])]);
    expect(await main(["--pr", "1", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log })).toBe(0);
    expect(t.lines.join("\n")).toContain("::warning::Open PR #2 is newer and waits for this PR (1 shared vendor files).");
    expect(t.lines.join("\n")).not.toMatch(/worker\/|adapters/);
    expect(t.summary()).toContain(ADAPTER);
  });

  it("logs --all pairs with PR numbers and counts only", async () => {
    const t = setup([pr(1, [ADAPTER], false, at(15)), pr(2, [ADAPTER], true, at(5))]);
    expect(await main(["--all", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log })).toBe(1);
    expect(t.lines).toEqual([
      "::error::Open PR #1 is blocked by older PR #2 (1 shared vendor files).",
      "Vendor PR serialization failed: 1 overlapping PR pairs.",
    ]);
    expect(t.summary()).toContain(ADAPTER);
  });

  it("works without a step summary file", async () => {
    const lines = [];
    const t = setup([pr(1, [ADAPTER], true), pr(2, [ADAPTER])]);
    expect(await main(["--pr", "2", "--prs-json", t.prsJson], { log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join("\n")).not.toContain(ADAPTER);
  });

  it("fails closed with a fixed message when the PR itself is missing (prs-json and API paths)", async () => {
    const t = setup([pr(1, [ADAPTER])]);
    expect(await main(["--pr", "9", "--prs-json", t.prsJson], { summaryFile: t.summaryFile, log: t.log })).toBe(1);
    const one = { number: 1, draft: false, created_at: at(1), changed_files: 1, files: [{ filename: ADAPTER }] };
    expect(await main(["--pr", "9"], { repo: "o/r", token: "t", summaryFile: t.summaryFile, fetchImpl: github([one]), log: t.log })).toBe(1);
    const fixed = "::error::Vendor PR serialization could not complete (failing closed); see the job summary for details.";
    expect(t.lines).toEqual([fixed, fixed]);
    expect(t.summary()).toContain("#9 is not in the open-PR list");
  });

  it("does not echo API-derived error text to the log", async () => {
    const t = setup([]);
    const fetchImpl = async () => {
      throw new Error("boom from worker/src/adapters/leak.ts");
    };
    expect(await main(["--all"], { repo: "o/r", token: "t", summaryFile: t.summaryFile, fetchImpl, log: t.log })).toBe(1);
    expect(t.lines.join("\n")).not.toMatch(/boom|leak|adapters/);
    expect(t.summary()).toContain("boom from worker/src/adapters/leak.ts");
  });

  it("rejects a missing --pr with usage and exit 2", async () => {
    const lines = [];
    expect(await main([], { log: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toMatch(/^usage:/);
  });
});

describe("runCli", () => {
  it("sets exitCode 1 and logs only the fixed message when main rejects", async () => {
    const errors = [];
    const proc = {};
    await runCli(Promise.reject(new Error("worker/src/adapters/secret.ts detail")), { error: (m) => errors.push(m), proc });
    expect(proc.exitCode).toBe(1);
    expect(errors).toEqual(["vendor-pr-serialization failed"]);
  });

  it("passes main's exit code through", async () => {
    const proc = {};
    await runCli(Promise.resolve(2), { error: () => {}, proc });
    expect(proc.exitCode).toBe(2);
  });
});
