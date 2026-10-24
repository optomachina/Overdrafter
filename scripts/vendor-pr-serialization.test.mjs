import { describe, expect, it } from "vitest";

import {
  MAX_FILE_PAGES,
  PER_PAGE,
  checkAll,
  checkSerialization,
  fetchAllPages,
  isVendorPath,
  listOpenPrs,
} from "./vendor-pr-serialization.mjs";

const pr = (number, paths, isDraft = false) => ({ number, isDraft, files: paths.map((path) => ({ path })) });

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

  it("fails when another open PR, draft included, shares a vendor file", () => {
    const r = checkSerialization(1, [
      pr(1, ["worker/src/adapters/index.ts", "worker/src/adapters/xometry.ts"]),
      pr(2, ["worker/src/adapters/index.ts"], true),
    ]);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ number: 2, isDraft: true, shared: ["worker/src/adapters/index.ts"] }]);
  });

  it("only warns when another vendor PR touches different files", () => {
    const r = checkSerialization(1, [pr(1, ["worker/src/adapters/xometry.ts"]), pr(2, ["worker/src/adapters/geomiq.ts"])]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([{ number: 2, isDraft: false }]);
  });
});

const pageOf = (url) => Number(new URL(url, "https://x").searchParams.get("page"));
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
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
    const fetchImpl = async (url) =>
      ok(url.includes("/files") ? [{ filename: "worker/src/adapters/a.ts" }] : [{ number: 7, draft: true, changed_files: 2 }]);
    await expect(listOpenPrs({ repo: "o/r", token: "t", fetchImpl })).rejects.toThrow(/1 of 2 changed files/);
  });

  it("requires a token and a valid repo", async () => {
    await expect(listOpenPrs({ repo: "o/r", token: "", fetchImpl: async () => ok([]) })).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(listOpenPrs({ repo: "bad", token: "t", fetchImpl: async () => ok([]) })).rejects.toThrow(/repo/);
  });

  it("returns PRs with all files across pages", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/files")) return ok(pageOf(url) === 1 ? page(PER_PAGE) : page(1, PER_PAGE));
      return ok([{ number: 9, draft: false, changed_files: PER_PAGE + 1 }]);
    };
    const prs = await listOpenPrs({ repo: "o/r", token: "t", fetchImpl });
    expect(prs[0].files).toHaveLength(PER_PAGE + 1);
  });
});

describe("checkAll", () => {
  it("reports every overlapping pair", () => {
    const r = checkAll([
      pr(1, ["worker/src/adapters/index.ts"]),
      pr(2, ["worker/src/adapters/index.ts"], true),
      pr(3, ["worker/src/adapters/other.ts"]),
    ]);
    expect(r.ok).toBe(false);
    expect(r.pairs).toEqual([{ a: 1, b: 2, shared: ["worker/src/adapters/index.ts"] }]);
  });
});
