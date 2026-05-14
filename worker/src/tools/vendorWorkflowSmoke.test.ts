// @vitest-environment node

import { describe, expect, it } from "vitest";
import { VendorAutomationError } from "../types";
import { buildErrorRow, parseQuantities, parseSmokeArgs } from "./vendorWorkflowSmoke";

describe("vendorWorkflowSmoke argument parsing", () => {
  it("parses the requested hidden vendor, CAD path, drawing path, and quantity list", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "OSHCut",
      "--cad",
      "./part.step",
      "--drawing",
      "./part.pdf",
      "--quantities",
      "1,5,25",
    ]);

    expect(args.vendors).toEqual(["oshcut"]);
    expect(args.cadPath).toMatch(/part\.step$/);
    expect(args.drawingPath).toMatch(/part\.pdf$/);
    expect(args.quantities).toEqual([1, 5, 25]);
  });

  it("falls back to env values and the default quantity", () => {
    const args = parseSmokeArgs([], {
      QUOTE_VENDOR_SMOKE_VENDOR: "weerg",
      QUOTE_VENDOR_LIVE_TEST_CAD_PATH: "./part.step",
    });

    expect(args.vendors).toEqual(["weerg"]);
    expect(args.quantities).toEqual([1]);
  });

  it("accepts all hidden vendors for batch validation", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "all",
      "--cad",
      "./part.step",
    ]);

    expect(args.vendors).toEqual([
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

  it("accepts a comma-separated hidden vendor subset", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "oshcut,fabworks",
      "--cad",
      "./part.step",
    ]);

    expect(args.vendors).toEqual(["oshcut", "fabworks"]);
  });

  it("rejects unsupported vendors", () => {
    expect(() =>
      parseSmokeArgs([
        "--vendor",
        "unknown",
        "--cad",
        "./part.step",
      ]),
    ).toThrow(/unsupported --vendor/i);
  });

  it("rejects partially unsupported vendor batches", () => {
    expect(() =>
      parseSmokeArgs([
        "--vendor",
        "oshcut,unknown",
        "--cad",
        "./part.step",
      ]),
    ).toThrow(/unsupported --vendor/i);
  });
});

describe("parseQuantities", () => {
  it("keeps only positive integer quantities", () => {
    expect(parseQuantities("1,0,nope,10")).toEqual([1, 10]);
  });

  it("uses the smoke-test default when the input is empty or invalid", () => {
    expect(parseQuantities(null)).toEqual([1]);
    expect(parseQuantities("0,nope")).toEqual([1]);
  });
});

describe("buildErrorRow", () => {
  it("preserves vendor automation failure details for live smoke repair", () => {
    const error = new VendorAutomationError(
      "OSH Cut session is not authenticated.",
      "login_required",
      {
        vendor: "oshcut",
        reason: "login_required",
      },
      [
        {
          kind: "screenshot",
          label: "OSH Cut login-required screenshot",
          localPath: "/tmp/oshcut-login.png",
          contentType: "image/png",
        },
      ],
    );

    const row = buildErrorRow("oshcut", 1, "2026-05-14T00:00:00.000Z", Date.now(), error);

    expect(row.errorCode).toBe("login_required");
    expect(row.errorPayload).toMatchObject({
      vendor: "oshcut",
      reason: "login_required",
    });
    expect(row.artifacts).toHaveLength(1);
  });
});
