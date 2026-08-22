// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendorAdapter } from "../adapters/base";
import type { WorkerConfig } from "../types";
import { VendorAutomationError } from "../types";
import { buildErrorRow, parseQuantities, parseSmokeArgs, runQuote } from "./vendorWorkflowSmoke";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, {
    recursive: true,
    force: true,
  })));
});

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

  it("accepts all runnable live evaluation vendors for batch validation", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "all",
      "--cad",
      "./part.step",
    ]);

    expect(args.vendors).toEqual([
      "xometry",
      "fictiv",
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

  it("accepts Xometry and Fictiv for direct live evaluation", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry,fictiv",
      "--cad",
      "./part.step",
    ]);

    expect(args.vendors).toEqual(["xometry", "fictiv"]);
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

  it("rejects live adapter stubs that cannot perform an evaluation", () => {
    expect(() =>
      parseSmokeArgs([
        "--vendor",
        "protolabs,sendcutsend",
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
          localPath: ".tmp/vendor-workflow-smoke/oshcut-login.png",
          contentType: "image/png",
        },
      ],
    );

    const row = buildErrorRow("oshcut", 1, "2026-05-14T00:00:00.000Z", Date.now(), error);

    expect(row.errorCode).toBe("login_required");
    expect(row.executionContext).toBe("live_evaluation");
    expect(row.errorPayload).toMatchObject({
      vendor: "oshcut",
      reason: "login_required",
    });
    expect(row.artifacts).toHaveLength(1);
  });
});

describe("runQuote", () => {
  it("passes uploaded files and the live evaluation context to the selected adapter", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-workflow-smoke-test-"));
    tempDirs.push(tempDir);
    const cadPath = path.join(tempDir, "part.step");
    const drawingPath = path.join(tempDir, "part.pdf");
    await Promise.all([
      fs.writeFile(cadPath, "cad-bytes"),
      fs.writeFile(drawingPath, "drawing-bytes"),
    ]);
    const args = parseSmokeArgs([
      "--vendor",
      "xometry",
      "--cad",
      cadPath,
      "--drawing",
      drawingPath,
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "xometry",
      status: "submitted",
      totalPriceUsd: null,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    });

    await runQuote({} as WorkerConfig, args, "xometry", 5, () => ({
      xometry: { quote },
    }));

    expect(quote).toHaveBeenCalledOnce();
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({
      executionContext: "live_evaluation",
      requestedQuantity: 5,
      stagedCadFile: expect.objectContaining({ localPath: expect.stringMatching(/cad\.step$/) }),
      stagedDrawingFile: expect.objectContaining({ localPath: expect.stringMatching(/drawing\.pdf$/) }),
      liveEvaluationAuthorization: expect.objectContaining({
        nonExportControlled: true,
        cadFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        drawingFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it("refuses an upload when non-export-controlled confirmation is missing", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry",
      "--cad",
      "./part.step",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>();

    const row = await runQuote({} as WorkerConfig, args, "xometry", 1, () => ({
      xometry: { quote },
    }));

    expect(row.error).toMatch(/confirm-non-export-controlled/);
    expect(quote).not.toHaveBeenCalled();
  });

  it("reports cleanup failure without masking a successful quote", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry",
      "--cad",
      "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "xometry",
      status: "submitted",
      totalPriceUsd: null,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    });
    const cleanup = vi.fn().mockRejectedValue(new Error("cleanup denied"));

    const row = await runQuote(
      {} as WorkerConfig,
      args,
      "xometry",
      1,
      () => ({ xometry: { quote } }),
      async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "b".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/cad.step",
        drawingPath: null,
        cleanup,
      }),
    );

    expect(row.error).toBeNull();
    expect(row.status).toBe("submitted");
    expect(row.cleanupError).toBe("cleanup denied");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
