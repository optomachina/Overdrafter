// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseAuthArgs } from "./vendorAuth";

describe("vendorAuth argument parsing", () => {
  it("parses a single hidden vendor", () => {
    expect(parseAuthArgs(["OSHCut"])).toMatchObject({
      vendors: ["oshcut"],
      explicitOutputPath: null,
    });
  });

  it("parses all hidden vendors for sequential session bootstrap", () => {
    expect(parseAuthArgs(["all"]).vendors).toEqual([
      "oshcut",
      "fabworks",
      "ponoko",
      "quickparts",
      "rapiddirect",
      "geomiq",
      "weerg",
      "protolabsnetwork",
    ]);
  });

  it("parses a comma-separated hidden vendor subset", () => {
    expect(parseAuthArgs(["oshcut,fabworks"]).vendors).toEqual(["oshcut", "fabworks"]);
  });

  it("rejects unsupported vendors", () => {
    expect(() => parseAuthArgs(["oshcut,unknown"])).toThrow(/unsupported vendor/i);
  });

  it("rejects explicit output paths for batch auth", () => {
    expect(() => parseAuthArgs(["oshcut,fabworks", "./state.json"])).toThrow(/only supported for a single vendor/i);
  });
});
