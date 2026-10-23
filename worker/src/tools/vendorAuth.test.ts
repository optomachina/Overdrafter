// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapVendor, parseAuthArgs } from "./vendorAuth";

afterEach(() => vi.restoreAllMocks());

describe("vendorAuth argument parsing", () => {
  it("parses a single hidden vendor", () => {
    expect(parseAuthArgs(["OSHCut"])).toMatchObject({
      vendors: ["oshcut"],
      explicitOutputPath: null,
    });
  });

  it("skips the disabled portal and logs a notice for all", () => {
    const notice = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(parseAuthArgs(["all"]).vendors).toEqual([
      "fabworks",
      "ponoko",
      "quickparts",
      "rapiddirect",
      "geomiq",
      "weerg",
      "protolabsnetwork",
    ]);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/Skipping oshcut:.*disabled/));
  });

  it("accepts SendCutSend for its own session bootstrap but keeps it out of all", () => {
    expect(parseAuthArgs(["sendcutsend", "./state/scs.json"])).toMatchObject({
      vendors: ["sendcutsend"],
      explicitOutputPath: expect.stringMatching(/state\/scs\.json$/),
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(parseAuthArgs(["all"]).vendors).not.toContain("sendcutsend");
  });

  it("parses a comma-separated hidden vendor subset", () => {
    expect(parseAuthArgs(["oshcut,quickparts,weerg"]).vendors).toEqual(["quickparts", "weerg"]);
  });

  it("refuses a single OSH Cut request before accessing session configuration", async () => {
    const args = parseAuthArgs(["oshcut"]);
    await expect(bootstrapVendor(args.vendors[0], args.explicitOutputPath))
      .rejects.toThrow(/OSH Cut portal automation is disabled.*OVD-1022/);
  });

  it("rejects unsupported vendors", () => {
    expect(() => parseAuthArgs(["oshcut,unknown"])).toThrow(/unsupported vendor/i);
  });

  it("rejects explicit output paths for batch auth", () => {
    expect(() => parseAuthArgs(["oshcut,quickparts,weerg", "./state.json"])).toThrow(/only supported for a single vendor/i);
  });
});
