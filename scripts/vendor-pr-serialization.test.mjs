import { describe, expect, it } from "vitest";

import { checkSerialization, isVendorPath } from "./vendor-pr-serialization.mjs";

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
