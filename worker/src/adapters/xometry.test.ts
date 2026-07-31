// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock, launchPersistentContextMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
  launchPersistentContextMock: vi.fn(),
}));

vi.mock("patchright", () => ({
  chromium: {
    launch: launchMock,
    launchPersistentContext: launchPersistentContextMock,
  },
}));

import { VendorAutomationError, type VendorQuoteAdapterInput, type WorkerConfig } from "../types";
import {
  XometryAdapter,
  detectBlockingStateSignal,
  hasVisibleFilename,
  isManualReviewText,
  parseFirstCurrency,
  parseLeadTime,
  selectToleranceTier,
  toleranceSummaryMatches,
} from "./xometry";
import { XOMETRY_LOCATORS, XOMETRY_URLS, buildFinishSearchTerms, buildMaterialSearchTerms } from "./xometryConstraints";

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "live",
    workerName: "worker-1",
    pollIntervalMs: 5000,
    pricingModelEnabled: false,
    pricingModelMinConfidence: 0.7,
    httpHost: "127.0.0.1",
    httpPort: 0,
    workerTempDir: path.join(os.tmpdir(), "overdrafter-xometry-test"),
    artifactBucket: "quote-artifacts",
    playwrightHeadless: true,
    playwrightCaptureTrace: false,
    browserTimeoutMs: 30000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: path.join(os.tmpdir(), "xometry-storage-state.json"),
    xometryStorageStateJson: null,
    xometryUserDataDir: null,
    xometryBrowserChannel: null,
    xometryProfileLockWaitMs: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<VendorQuoteAdapterInput> = {}): VendorQuoteAdapterInput {
  return {
    organizationId: "org-1",
    quoteRunId: "run-1",
    requestedQuantity: 2,
    part: {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: "cad-1",
      drawing_file_id: null,
      quantity: 2,
    },
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      storage_bucket: "job-files",
      storage_path: "cad/part.step",
      original_name: "part.step",
      file_kind: "cad",
    },
    drawingFile: null,
    stagedCadFile: {
      originalName: "part.step",
      localPath: "/tmp/part.step",
      storageBucket: "job-files",
      storagePath: "cad/part.step",
    },
    stagedDrawingFile: null,
    requirement: {
      id: "req-1",
      part_id: "part-1",
      description: "Bracket",
      part_number: "1093-00001",
      revision: "A",
      material: "6061 aluminum",
      finish: "Type II black anodize",
      tightest_tolerance_inch: 0.005,
      quantity: 2,
      quote_quantities: [2],
      requested_by_date: null,
      applicable_vendors: ["xometry"],
    },
    ...overrides,
  };
}

type LocatorBehavior = {
  count?: number;
  text?: string;
  setInputFiles?: (files: string[]) => Promise<void> | void;
  click?: () => Promise<void> | void;
  fill?: (value: string) => Promise<void> | void;
  press?: (value: string) => Promise<void> | void;
};

type FakePageOptions = {
  bodyText: string;
  postSaveBodyText?: string;
  url?: string;
  selectorBehaviors?: Record<string, LocatorBehavior>;
  optionTexts?: string[] | (() => string[]);
  redirectUrl?: string;
  saveRedirectUrl?: string;
  saveNavigationFails?: boolean;
  visibleFilenames?: string[];
};

function makeLocator(behavior: LocatorBehavior = {}) {
  return {
    first() {
      return this;
    },
    async count() {
      return behavior.count ?? 0;
    },
    async isVisible() {
      return (behavior.count ?? 0) > 0;
    },
    async innerText() {
      return behavior.text ?? "";
    },
    async setInputFiles(files: string[]) {
      await behavior.setInputFiles?.(files);
    },
    async click() {
      await behavior.click?.();
    },
    async fill(value: string) {
      await behavior.fill?.(value);
    },
    async press(value: string) {
      await behavior.press?.(value);
    },
    filter(options: { hasText?: RegExp }) {
      if (!options.hasText) {
        return makeLocator(behavior);
      }

      const text = behavior.text ?? "";
      return options.hasText.test(text)
        ? makeLocator(behavior)
        : makeLocator({ count: 0, text: "" });
    },
    locator() {
      return makeLocator({ count: 0 });
    },
  };
}

function createFakePage(options: FakePageOptions) {
  const selectorBehaviors = options.selectorBehaviors ?? {};
  let currentUrl = options.url ?? XOMETRY_URLS.quoteHome;
  let saved = false;
  const currentBodyText = () =>
    saved ? (options.postSaveBodyText ?? options.bodyText) : options.bodyText;
  const waitForURL = vi.fn(async (target: unknown) => {
    if (typeof target !== "function") return undefined;
    if (options.saveNavigationFails) {
      throw new Error("save navigation timed out");
    }
    saved = true;
    currentUrl =
      options.saveRedirectUrl ??
      "https://www.xometry.com/quoting/quote/Q00-TEST-0001#part-part-1";
    return undefined;
  });

  return {
    async screenshot(input: { path: string }) {
      await fs.writeFile(input.path, "");
    },
    async content() {
      return `<html><body>${currentBodyText()}</body></html>`;
    },
    locator(selector: string) {
      if (selector === "body") {
        return makeLocator({
          count: 1,
          text: currentBodyText(),
        });
      }

      return makeLocator(selectorBehaviors[selector]);
    },
    getByRole(role: string, input: { name?: RegExp }) {
      if (role !== "option") {
        return makeLocator({ count: 0, text: "" });
      }

      const availableOptionTexts =
        typeof options.optionTexts === "function" ? options.optionTexts() : options.optionTexts;
      const optionText =
        availableOptionTexts?.find((candidate) => input.name?.test(candidate)) ?? "";

      return makeLocator({
        count: optionText ? 1 : 0,
        text: optionText,
      });
    },
    async waitForFunction(callback: unknown, argument?: unknown) {
      if (typeof callback !== "function") {
        throw new Error("expected a wait predicate");
      }

      const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
      const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
      const visibleText = [currentBodyText(), ...(options.visibleFilenames ?? [])].join(" ");
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          body: { innerText: visibleText },
          querySelectorAll: () => [],
        },
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { href: currentUrl } },
      });

      try {
        const result = (callback as (value?: unknown) => unknown)(argument);
        if (!result) {
          throw new Error("wait predicate did not match");
        }
        return undefined;
      } finally {
        if (documentDescriptor) {
          Object.defineProperty(globalThis, "document", documentDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "document");
        }
        if (windowDescriptor) {
          Object.defineProperty(globalThis, "window", windowDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "window");
        }
      }
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    waitForURL,
    async waitForEvent() {
      return undefined;
    },
    on() {
      return undefined;
    },
    async goto(url: string) {
      currentUrl = options.redirectUrl ?? url;
    },
    url() {
      return currentUrl;
    },
  };
}

function createFakeBrowser(page: ReturnType<typeof createFakePage>) {
  const context = {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    tracing: {
      start: vi.fn(),
      stop: vi.fn(),
    },
    async newPage() {
      return page;
    },
    async close() {
      return undefined;
    },
  };

  return {
    async newContext() {
      return context;
    },
    async close() {
      return undefined;
    },
  };
}

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-xometry-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  launchMock.mockReset();
  launchPersistentContextMock.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Xometry helpers", () => {
  it("prefers the current searchable material and finish comboboxes", () => {
    expect(XOMETRY_LOCATORS.materialButtons[0]).toBe(
      'input[role="combobox"][placeholder="Search Material"]',
    );
    expect(XOMETRY_LOCATORS.finishButtons[0]).toBe(
      'input[role="combobox"][placeholder="Search Finish"]',
    );
  });

  it("maps explicit materials and finishes, and rejects unknown ones", () => {
    expect(buildMaterialSearchTerms("6061 aluminum")).toEqual(["6061-T6", "6061"]);
    expect(buildMaterialSearchTerms("mystery alloy")).toBeNull();
    expect(buildFinishSearchTerms("Type II black anodize")).toEqual(["Black Anodize"]);
    expect(buildFinishSearchTerms("as machined")).toEqual([]);
    expect(buildFinishSearchTerms("custom dipped coating")).toBeNull();
  });

  it("parses values and detects blocking/manual-review signals", () => {
    expect(parseFirstCurrency("Total price $1,250.75")).toBe(1250.75);
    expect(parseLeadTime("Ships in 7 business days")).toBe(7);
    expect(
      parseLeadTime("Least Expensive Arrives by Aug 18 $428.12", new Date("2026-07-25T00:00:00Z")),
    ).toBe(17);
    expect(
      parseLeadTime("Least Expensive Arrives by Jul 25 $428.12", new Date("2026-07-25T00:00:00Z")),
    ).toBe(0);
    expect(
      parseLeadTime(
        "Least Expensive Arrives by Jul 20, 2026 $428.12",
        new Date("2026-07-25T00:00:00Z"),
      ),
    ).toBeNull();
    expect(
      parseLeadTime("Least Expensive Arrives by Jul 20 $428.12", new Date("2026-07-25T00:00:00Z")),
    ).toBeNull();
    expect(
      parseLeadTime("Least Expensive Arrives by Jan 5 $428.12", new Date("2026-12-30T00:00:00Z")),
    ).toBe(3);
    expect(
      parseLeadTime(
        "Least Expensive Arrives by Sep 8, 2026 $428.12",
        new Date("2026-09-04T00:00:00Z"),
      ),
    ).toBe(1);
    expect(
      parseLeadTime(
        "Least Expensive Arrives by Jan 3, 2022 $428.12",
        new Date("2021-12-30T00:00:00Z"),
      ),
    ).toBe(1);
    expect(
      parseLeadTime(
        "Least Expensive Arrives by Jan 1, 2999 $428.12",
        new Date("2026-07-25T00:00:00Z"),
      ),
    ).toBeNull();
    expect(selectToleranceTier(0.01).tier).toBe("looser");
    expect(selectToleranceTier(0.006).tier).toBe("standard");
    expect(selectToleranceTier(0.005).tier).toBe("standard");
    expect(selectToleranceTier(0.004).tier).toBe("tighter");
    expect(selectToleranceTier(null).tier).toBeNull();
    expect(hasVisibleFilename("Attached: PART.PDF", "part.pdf")).toBe(true);
    expect(
      toleranceSummaryMatches(
        "Precision Tolerance:\nTighter than ±.005",
        "tighter",
      ),
    ).toBe(true);
    expect(isManualReviewText("Manual review required after upload.")).toBe(true);
    expect(
      detectBlockingStateSignal({
        text: "Verify you are human",
        url: XOMETRY_URLS.quoteHome,
      }),
    ).toBe("captcha");
    expect(
      detectBlockingStateSignal({
        text: "Continue with email",
        url: XOMETRY_URLS.login,
      }),
    ).toBe("login_required");
    expect(
      detectBlockingStateSignal({
        text: "Upload a 3D model to see instant pricing, lead time, and DFM feedback.",
        url: XOMETRY_URLS.quoteHome,
      }),
    ).toBeNull();
    expect(
      detectBlockingStateSignal({
        text: [
          "Upload a 3D model to see instant pricing, lead time, and DFM feedback.",
          "Already have an account?",
        ].join(" "),
        url: XOMETRY_URLS.quoteHome,
      }),
    ).toBe("login_required");
    expect(
      detectBlockingStateSignal({
        text: [
          "Upload a 3D model to see instant pricing, lead time, and DFM feedback.",
          "Already have an account?",
        ].join(" "),
        url: "https://www.xometry.com/resources/",
      }),
    ).toBeNull();
  });
});

describe("XometryAdapter", () => {
  it("returns manual vendor follow-up for unmapped requirements without launching Playwright", async () => {
    const adapter = new XometryAdapter("xometry", makeConfig({ workerMode: "live" }));

    const result = await adapter.quote(
      makeInput({
        requirement: {
          ...makeInput().requirement,
          material: "mystery alloy",
        },
      }),
    );

    expect(launchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("manual_vendor_followup");
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "manual_vendor_followup",
      unmappedField: "material",
      selectedMaterial: null,
    });
  });

  it("captures a live instant quote with stable raw payload fields", async () => {
    const workerTempDir = await makeTempDir();
    const saveConfiguration = vi.fn();
    const setTolerance = vi.fn();
    let materialOptionsOpen = false;
    let finishOptionsOpen = false;
    const page = createFakePage({
      bodyText: "Configure part",
      postSaveBodyText: [
        "Quantity 2",
        "Material: Aluminum 6061-T6x",
        "Finish: Black Anodize",
        "Precision Tolerance: ±.005",
        "Least Expensive $120.00 Lead time 5 business days",
      ].join(" "),
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0001/part-1",
      saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0001#part-part-1",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(() => {
            materialOptionsOpen = true;
          }),
        },
        [XOMETRY_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: vi.fn(() => {
            finishOptionsOpen = true;
          }),
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: "Least Expensive 5 business days $120.00",
        },
        [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: {
          count: 1,
          click: saveConfiguration,
        },
        [XOMETRY_LOCATORS.toleranceOptions.standard]: {
          count: 1,
          click: setTolerance,
        },
      },
      optionTexts: () => {
        if (finishOptionsOpen) return ["Black Anodize"];
        if (materialOptionsOpen) return ["6061-T6"];
        return [];
      },
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("instant_quote_received");
    expect(result.totalPriceUsd).toBe(120);
    expect(result.leadTimeBusinessDays).toBe(5);
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "instant_quote",
      uploadSelector: XOMETRY_LOCATORS.uploadInputs[1],
      drawingUploadMode: "not_provided",
      selectedMaterial: "6061-T6",
      selectedFinish: "Black Anodize",
      selectedTolerance: "standard",
      toleranceSelector: XOMETRY_LOCATORS.toleranceOptions.standard,
      requirementsVerified: true,
      saveConfigurationSelector: XOMETRY_LOCATORS.saveConfigurationButtons[0],
      priceSource: "selector",
      leadTimeSource: "selector",
      url: "https://www.xometry.com/quoting/quote/Q00-TEST-0001#part-part-1",
    });
    expect(saveConfiguration).toHaveBeenCalledTimes(1);
    expect(setTolerance).toHaveBeenCalledTimes(1);
    expect(page.waitForURL).toHaveBeenCalled();
    expect(result.artifacts).toHaveLength(8);
  });

  it("withholds a price when every declared price locator misses", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      // No priceText/leadTimeText selector behavior: every declared locator
      // misses, so the body-level tier currency remains untrusted.
      bodyText: "Configure part",
      postSaveBodyText: [
        "Quantity 2",
        "Material: Aluminum 6061-T6x",
        "Finish: Black Anodize",
        "Precision Tolerance: ±.005",
        "Least Expensive Spring sale! Orders over $19.99 ship free. Lead time 5 business days",
      ].join(" "),
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002/part-1",
      saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002#part-part-1",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.toleranceOptions.standard]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
      },
      optionTexts: ["6061-T6", "Black Anodize"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    const result = await adapter.quote(makeInput());

    // The banner price must not reach the customer in any field.
    expect(result.status).toBe("manual_review_pending");
    expect(result.totalPriceUsd).toBeNull();
    expect(result.unitPriceUsd).toBeNull();
    expect(result.leadTimeBusinessDays).toBeNull();
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "locator_drift",
      priceSource: "body_text",
      priceTrusted: false,
      priceGateReason: "unanchored_price",
      locatorDriftDetected: true,
      // Retained as evidence for re-anchoring, under a non-quote key.
      unanchoredPriceObservedUsd: 19.99,
    });
  });

  it("falls back to a separate drawing upload and reports manual review", { timeout: 30_000 }, async () => {
    const workerTempDir = await makeTempDir();
    const saveConfiguration = vi.fn();
    const uploadFilesMock = vi.fn(async (files: string[]) => {
      if (files.length > 1) {
        throw new Error("drawing must be uploaded separately");
      }
    });
    const fallbackUploadMock = vi.fn();
    const page = createFakePage({
      bodyText: "Manual review required. Drawing required for this quote.",
      postSaveBodyText: [
        "part.pdf",
        "Quantity 2",
        "Material: Aluminum 7075-T6",
        "Finish: Standard",
        "Precision Tolerance: ±.005",
        "Manual review required. Drawing required for this quote.",
      ].join(" "),
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002/part-1",
      saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002#part-part-1",
      visibleFilenames: ["part.pdf"],
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: uploadFilesMock,
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.toleranceOptions.standard]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: {
          count: 1,
          click: saveConfiguration,
        },
        [XOMETRY_LOCATORS.drawingInputs[0]]: {
          count: 1,
          setInputFiles: fallbackUploadMock,
        },
        [XOMETRY_LOCATORS.manualReviewText[0]]: {
          count: 1,
          text: "Manual review required",
        },
      },
      optionTexts: ["7075-T6"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    const result = await adapter.quote(
      makeInput({
        requirement: {
          ...makeInput().requirement,
          material: "7075 aluminum",
          finish: null,
        },
        part: {
          ...makeInput().part,
          drawing_file_id: "drawing-1",
        },
        drawingFile: {
          id: "drawing-1",
          job_id: "job-1",
          storage_bucket: "job-files",
          storage_path: "drawings/part.pdf",
          original_name: "part.pdf",
          file_kind: "drawing",
        },
        stagedDrawingFile: {
          originalName: "part.pdf",
          localPath: "/tmp/part.pdf",
          storageBucket: "job-files",
          storagePath: "drawings/part.pdf",
        },
      }),
    );

    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    expect(fallbackUploadMock).toHaveBeenCalledTimes(1);
    expect(saveConfiguration).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("manual_review_pending");
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "manual_review",
      drawingUploadMode: "fallback",
      selectedMaterial: "7075-T6",
      selectedFinish: null,
      selectedTolerance: "standard",
      requirementsVerified: true,
      priceSource: "none",
    });
  });

  it("routes a summary-less saved page to manual review", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      postSaveBodyText: "Manual review required. A Xometry engineer will confirm this quote.",
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003/part-1",
      saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003#part-part-1",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.toleranceOptions.standard]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.manualReviewText[0]]: {
          count: 1,
          text: "Manual review required",
        },
      },
      optionTexts: ["6061-T6", "Black Anodize"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("manual_review_pending");
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "manual_review",
      requirementsVerified: false,
    });
  });

  it("fails closed when the saved page never renders a quote signal", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      postSaveBodyText: "Your configuration was saved.",
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0004/part-1",
      saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0004#part-part-1",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.toleranceOptions.standard]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
      },
      optionTexts: ["6061-T6", "Black Anodize"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        field: "save_configuration",
      },
    });
  });

  it("fails closed when Save Configuration is absent", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003/part-1",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.toleranceOptions.standard]: {
          count: 1,
          click: vi.fn(),
        },
      },
      optionTexts: ["6061-T6", "Black Anodize"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        field: "save_configuration",
      },
    });
  });

  it("fails closed when the saved summary does not match requested requirements", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      postSaveBodyText: [
        "Quantity 1",
        "Material: Aluminum 6061-T6x",
        "Finish: Standard",
        "Precision Tolerance: ±.010",
        "Least Expensive $25.00 Lead time 5 business days",
      ].join(" "),
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0004/part-1",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.toleranceOptions.standard]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
      },
      optionTexts: ["6061-T6", "Black Anodize"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        reason: "saved_requirement_mismatch",
        requirementMismatches: expect.arrayContaining(["quantity", "finish", "tolerance"]),
      },
    });
  });

  it("fails closed on login and captcha barriers", async () => {
    const workerTempDir = await makeTempDir();

    for (const [bodyText, redirectUrl, expectedCode] of [
      ["Sign in to continue", XOMETRY_URLS.login, "login_required"],
      ["Verify you are human", XOMETRY_URLS.quoteHome, "captcha"],
    ] as const) {
      const page = createFakePage({
        bodyText,
        redirectUrl,
      });
      launchMock.mockResolvedValue(createFakeBrowser(page));

      const adapter = new XometryAdapter(
        "xometry",
        makeConfig({
          workerTempDir,
          xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        }),
      );

      await expect(adapter.quote(makeInput())).rejects.toMatchObject({
        name: "VendorAutomationError",
        code: expectedCode,
      });
    }
  });

  it("raises selector failures when the upload input is missing", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part Total price $120.00 5 business days",
      selectorBehaviors: {},
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "selector_failure",
      payload: {
        failedSelector: XOMETRY_LOCATORS.uploadInputs[0],
        attemptedSelectors: XOMETRY_LOCATORS.uploadInputs,
      },
    });
  });

  it("fails closed when the requested quantity cannot be configured", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
      },
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "selector_failure",
      payload: {
        failedSelector: XOMETRY_LOCATORS.quantityInputs[0],
      },
    });
  });
});
