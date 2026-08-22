// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput } from "../types";
import { EXTENDED_VENDOR_WORKFLOWS, getExtendedVendorWorkflow } from "./extendedVendorWorkflows";
import {
  excerptText,
  extractQuoteSignal,
  isConfigurationRequiredPageSignal,
  isLoginRequiredPageSignal,
  resolvePortalCadUploadFile,
} from "./portalWorkflow";

describe("extended vendor workflows", () => {
  it("defines the hidden vendor workflow set requested for live automation", () => {
    expect(EXTENDED_VENDOR_WORKFLOWS.map((workflow) => workflow.vendor)).toEqual([
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

  it("keeps sheet-metal and multi-process vendors classified separately", () => {
    expect(getExtendedVendorWorkflow("oshcut")?.processFamily).toBe("sheet_metal");
    expect(getExtendedVendorWorkflow("fabworks")?.processFamily).toBe("sheet_metal");
    expect(getExtendedVendorWorkflow("ponoko")?.processFamily).toBe("sheet_metal");
    expect(getExtendedVendorWorkflow("quickparts")?.processFamily).toBe("multi_process");
    expect(getExtendedVendorWorkflow("rapiddirect")?.processFamily).toBe("multi_process");
    expect(getExtendedVendorWorkflow("geomiq")?.processFamily).toBe("multi_process");
    expect(getExtendedVendorWorkflow("weerg")?.processFamily).toBe("multi_process");
    expect(getExtendedVendorWorkflow("protolabsnetwork")?.processFamily).toBe("multi_process");
  });

  it("starts hidden vendor uploads on quote surfaces instead of login routes", () => {
    for (const workflow of EXTENDED_VENDOR_WORKFLOWS) {
      expect(
        isLoginRequiredPageSignal({
          url: workflow.uploadUrl,
          bodyText: "Upload part Get a quote Browse files",
          passwordInputCount: 0,
        }),
      ).toBe(false);
    }
  });
});

describe("extractQuoteSignal", () => {
  it("extracts simple total price and lead-time signals from portal text", () => {
    expect(extractQuoteSignal("Total $1,234.56 Lead time 7 business days")).toEqual({
      totalPriceUsd: 1234.56,
      leadTimeBusinessDays: 7,
    });
  });

  it("returns nulls when no quote-like signal is present", () => {
    expect(extractQuoteSignal("Upload your file to get started")).toEqual({
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
    });
  });

  it("does not treat zero-dollar placeholder text as a quote", () => {
    expect(extractQuoteSignal("Quote summary Total $0 Lead time 30 days")).toEqual({
      totalPriceUsd: null,
      leadTimeBusinessDays: 30,
    });
  });
});

describe("isLoginRequiredPageSignal", () => {
  it("does not reject guest quote pages only because sign-in links are present", () => {
    expect(
      isLoginRequiredPageSignal({
        url: "https://www.fabworks.com/quotes/qte_123",
        bodyText: "Quotes Orders Sign In Sign Up Upload Part Browse Files",
        passwordInputCount: 0,
      }),
    ).toBe(false);
  });

  it("detects login and registration routes", () => {
    expect(
      isLoginRequiredPageSignal({
        url: "https://quickquote.quickparts.com/#/registration",
        bodyText: "Create your account",
        passwordInputCount: 0,
      }),
    ).toBe(true);
  });
});

describe("isConfigurationRequiredPageSignal", () => {
  it("detects uploaded portal states that still require manual configuration", () => {
    expect(
      isConfigurationRequiredPageSignal(
        "Set units and material. To obtain pricing, click your parts below to set size and material.",
      ),
    ).toBe(true);
    expect(
      isConfigurationRequiredPageSignal(
        "Specify your parts configuration to get price and lead time.",
      ),
    ).toBe(true);
    expect(isConfigurationRequiredPageSignal("Upload completed. Enter your zip code to see delivery dates.")).toBe(true);
  });

  it("does not classify a priced quote as configuration-required", () => {
    expect(isConfigurationRequiredPageSignal("Total $123.45 Lead time 7 business days")).toBe(false);
  });
});

describe("excerptText", () => {
  it("normalizes whitespace and bounds portal text excerpts", () => {
    expect(excerptText("  Upload\n\nPart\tTotal $0  ", 11)).toBe("Upload Part");
  });
});

describe("resolvePortalCadUploadFile", () => {
  it("uses internally captured bytes for evaluation and paths for production", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portal-upload-test-"));
    const cadPath = path.join(tempDir, "part.step");
    await fs.writeFile(cadPath, "authorized-portal-cad");
    const cadFileSha256 = await sha256File(cadPath);
    const input = {
      executionContext: "live_evaluation",
      liveEvaluationAuthorization: {
        nonExportControlled: true,
        cadFileSha256,
        drawingFileSha256: null,
      },
      stagedCadFile: {
        originalName: "part.step",
        localPath: cadPath,
        storageBucket: "job-files",
        storagePath: "cad/part.step",
        trustedContentSha256: cadFileSha256,
      },
      stagedDrawingFile: null,
    } as VendorQuoteAdapterInput;

    try {
      const authorizedInput = await authorizeLiveEvaluationInput(input);
      expect(authorizedInput).not.toBeNull();
      await fs.writeFile(cadPath, "replacement-during-browser-wait");

      const uploadFile = resolvePortalCadUploadFile(authorizedInput!);
      expect(typeof uploadFile).not.toBe("string");
      if (typeof uploadFile !== "string") {
        expect(uploadFile.buffer.toString()).toBe("authorized-portal-cad");
      }
      expect(resolvePortalCadUploadFile(input)).toBe(cadPath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
