// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock, launchPersistentContextMock, playwrightLaunchMock, playwrightLaunchPersistentContextMock } =
  vi.hoisted(() => ({
    launchMock: vi.fn(),
    launchPersistentContextMock: vi.fn(),
    playwrightLaunchMock: vi.fn(),
    playwrightLaunchPersistentContextMock: vi.fn(),
  }));

vi.mock("patchright", () => ({
  chromium: {
    launch: launchMock,
    launchPersistentContext: launchPersistentContextMock,
  },
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: playwrightLaunchMock,
    launchPersistentContext: playwrightLaunchPersistentContextMock,
  },
  firefox: {
    launch: launchMock,
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
  uploadInputAcceptsFile,
} from "./xometry";
import {
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  buildMaterialSummaryTerms,
} from "./xometryConstraints";

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
    xometryProfileSnapshotBucket: null,
    xometryProfileSnapshotObject: null,
    xometryProfileSnapshotGeneration: null,
    xometryProfileSnapshotMaxBytes: 268435456,
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
    xometryDispatchAuthorization: {
      permitId: "00000000-0000-4000-8000-000000003680",
      provider: "xometry",
      scopeFingerprint: "a".repeat(64),
      envelopeRevision: "xometry-controlled-beta-envelope.v1",
      nonExportControlled: true,
    },
    ...overrides,
  };
}

function makeInputWithDrawing() {
  const baseInput = makeInput();
  return makeInput({
    part: {
      ...baseInput.part,
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
  });
}

type LocatorBehavior = {
  count?: number | (() => number);
  text?: string | (() => string);
  setInputFiles?: (files: string[]) => Promise<void> | void;
  click?: () => Promise<void> | void;
  fill?: (value: string) => Promise<void> | void;
  press?: (value: string) => Promise<void> | void;
  inputValue?: () => Promise<string> | string;
  waitFor?: () => Promise<void> | void;
  getAttribute?: (name: string) => Promise<string | null> | string | null;
};

type FakePageOptions = {
  bodyText: string | (() => string);
  postSaveBodyText?: string | (() => string);
  url?: string;
  selectorBehaviors?: Record<string, LocatorBehavior>;
  optionTexts?: string[] | (() => string[]);
  onOptionWait?: (name?: RegExp) => Promise<void> | void;
  redirectUrl?: string;
  dashboardRedirectUrl?: string;
  uploadRedirectUrl?: string;
  delayedUploadRedirectUrl?: string;
  delayedUploadRedirectAfterTimeouts?: number;
  saveRedirectUrl?: string;
  quoteNavigationFails?: boolean;
  saveNavigationFails?: boolean;
  reloadFails?: boolean;
  responseWaitDelayMs?: number;
  visibleFilenames?: string[];
  responses?: Array<{
    method: string;
    url: string;
    status: number;
    body?: unknown;
  }>;
};

function makeLocator(behavior: LocatorBehavior = {}) {
  const currentCount = () =>
    typeof behavior.count === "function" ? behavior.count() : (behavior.count ?? 0);
  const currentText = () =>
    typeof behavior.text === "function" ? behavior.text() : (behavior.text ?? "");

  return {
    first() {
      return this;
    },
    async count() {
      return currentCount();
    },
    async isVisible() {
      return currentCount() > 0;
    },
    async waitFor() {
      await behavior.waitFor?.();
      if (currentCount() < 1) {
        throw new Error("locator did not become visible");
      }
    },
    async innerText() {
      return currentText();
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
    async inputValue() {
      return (await behavior.inputValue?.()) ?? "";
    },
    async getAttribute(name: string) {
      return (await behavior.getAttribute?.(name)) ?? null;
    },
    filter(options: { hasText?: RegExp }) {
      if (!options.hasText) {
        return makeLocator(behavior);
      }

      const text = currentText();
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
  const responseQueue = [...(options.responses ?? [])];
  let currentUrl = options.url ?? XOMETRY_URLS.quoteHome;
  let saved = false;
  let waitForTimeoutCount = 0;
  const currentBodyText = () => {
    if (!saved) {
      return typeof options.bodyText === "function"
        ? options.bodyText()
        : options.bodyText;
    }
    if (typeof options.postSaveBodyText === "function") {
      return options.postSaveBodyText();
    }
    return options.postSaveBodyText ?? options.bodyText;
  };
  const waitForURL = vi.fn(async (target: unknown) => {
    if (target instanceof RegExp) {
      if (options.quoteNavigationFails) {
        throw new Error("quote navigation timed out");
      }
      return undefined;
    }
    if (
      typeof target === "function" &&
      options.dashboardRedirectUrl &&
      !saved
    ) {
      currentUrl = options.dashboardRedirectUrl;
      if ((target as (url: URL) => boolean)(new URL(currentUrl))) {
        return undefined;
      }
      throw new Error("dashboard navigation timed out");
    }
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

      const normalizedSelector = selector.endsWith(":visible")
        ? selector.slice(0, -":visible".length)
        : selector;
      const behavior =
        selectorBehaviors[selector] ?? selectorBehaviors[normalizedSelector];
      if (
        XOMETRY_LOCATORS.startNewQuoteButtons.includes(selector) &&
        options.dashboardRedirectUrl
      ) {
        return makeLocator({
          ...behavior,
          click: async () => {
            await behavior?.click?.();
            currentUrl = options.dashboardRedirectUrl ?? currentUrl;
          },
        });
      }
      if (
        [
          ...XOMETRY_LOCATORS.uploadInputs,
          ...XOMETRY_LOCATORS.standaloneUploadInputs,
        ].includes(selector) &&
        options.uploadRedirectUrl
      ) {
        return makeLocator({
          ...behavior,
          setInputFiles: async (files) => {
            await behavior?.setInputFiles?.(files);
            currentUrl = options.uploadRedirectUrl ?? currentUrl;
          },
        });
      }
      return makeLocator(behavior);
    },
    getByRole(role: string, input: { name?: RegExp }) {
      if (role !== "option") {
        return makeLocator({ count: 0, text: "" });
      }

      const findOptionText = () => {
        const availableOptionTexts =
          typeof options.optionTexts === "function" ? options.optionTexts() : options.optionTexts;
        return availableOptionTexts?.find((candidate) => input.name?.test(candidate)) ?? "";
      };

      return makeLocator({
        count: () => (findOptionText() ? 1 : 0),
        waitFor: async () => {
          await options.onOptionWait?.(input.name);
        },
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
    async reload() {
      if (options.reloadFails) {
        throw new Error("reload failed");
      }
      return undefined;
    },
    async waitForTimeout() {
      waitForTimeoutCount += 1;
      if (
        options.delayedUploadRedirectUrl &&
        options.delayedUploadRedirectAfterTimeouts &&
        waitForTimeoutCount >= options.delayedUploadRedirectAfterTimeouts
      ) {
        currentUrl = options.delayedUploadRedirectUrl;
      }
      return undefined;
    },
    waitForURL,
    async waitForEvent() {
      return undefined;
    },
    async waitForResponse(
      predicate: (response: {
        request: () => { method: () => string };
        status: () => number;
        url: () => string;
      }) => boolean,
    ) {
      for (let index = 0; index < responseQueue.length; index += 1) {
        const candidate = responseQueue[index];
        const response = {
          request: () => ({ method: () => candidate.method }),
          status: () => candidate.status,
          url: () => candidate.url,
          json: async () => candidate.body,
        };
        if (predicate(response)) {
          responseQueue.splice(index, 1);
          return response;
        }
      }
      if (options.responseWaitDelayMs) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.responseWaitDelayMs);
        });
      }
      throw new Error("response timed out");
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
  const context = createFakeContext(page);

  return {
    async newContext() {
      return context;
    },
    async close() {
      return undefined;
    },
  };
}

function createFakeContext(page: ReturnType<typeof createFakePage>) {
  return {
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
}

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-xometry-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  launchMock.mockReset();
  launchPersistentContextMock.mockReset();
  playwrightLaunchMock.mockReset();
  playwrightLaunchPersistentContextMock.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Xometry helpers", () => {
  it("prefers the current searchable material and finish comboboxes", () => {
    expect(XOMETRY_LOCATORS.uploadInputs[0]).toContain("Start A New Instant Quote");
    expect(XOMETRY_LOCATORS.uploadInputs).not.toContain('input[type="file"]');
    expect(XOMETRY_LOCATORS.dashboardUploadButtons).toEqual([
      'button:text-is("Upload a CAD File")',
    ]);
    expect(XOMETRY_LOCATORS.dashboardUploadButtons).not.toContain(
      'button:has-text("Upload 3D Files")',
    );
    expect(XOMETRY_LOCATORS.dashboardUploadPanels).toEqual([
      'div:has(> input[type="file"]):has(button:has-text("Start A New Instant Quote"))',
      'div:has(> input[type="file"]):has(button:has-text("Upload 3D Files"))',
    ]);
    expect(XOMETRY_LOCATORS.uploadInputs[1]).toBe(
      'div:has(> input[type="file"]):has(button:has-text("Upload 3D Files")) > input[type="file"]',
    );
    expect(XOMETRY_LOCATORS.materialButtons[0]).toBe(
      'input[role="combobox"][placeholder="Search Material"]',
    );
    expect(XOMETRY_LOCATORS.finishButtons[0]).toBe(
      'input[role="combobox"][placeholder="Search Finish"]',
    );
  });

  it("matches staged CAD extensions against Xometry's loaded accept list", () => {
    expect(
      uploadInputAcceptsFile(".step,.stp,.sldprt", "/tmp/part.step"),
    ).toBe(true);
    expect(
      uploadInputAcceptsFile(".step,.stp,.sldprt", "/tmp/part.iges"),
    ).toBe(false);
    expect(uploadInputAcceptsFile(null, "/tmp/part.step")).toBe(false);
  });

  it("maps explicit materials and finishes, and rejects unknown ones", () => {
    expect(buildMaterialSearchTerms("6061 aluminum")).toEqual(["6061-T6", "6061"]);
    expect(buildMaterialSummaryTerms("6061 aluminum")).toEqual([
      "6061-T6x",
      "6061-T6",
    ]);
    expect(buildMaterialSearchTerms("Copper 101")).toEqual([
      "Copper 101",
      "Copper",
    ]);
    expect(buildMaterialSummaryTerms("Copper 101")).toEqual(["Copper 101"]);
    expect(buildMaterialSummaryTerms("Nylon 6/6")).toEqual(["Nylon 6/6"]);
    expect(buildMaterialSummaryTerms("303 stainless")).toEqual([
      "Stainless Steel 303",
    ]);
    expect(buildMaterialSummaryTerms("brass")).toEqual([
      "Copper C360 (Brass)",
    ]);
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
  it("refuses live browser launch without explicit exact-scope authorization", async () => {
    const adapter = new XometryAdapter("xometry", makeConfig());

    await expect(
      adapter.quote(makeInput({ xometryDispatchAuthorization: undefined })),
    ).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        reason: "dispatch_authorization_missing",
      },
    });
    expect(launchMock).not.toHaveBeenCalled();
    expect(playwrightLaunchMock).not.toHaveBeenCalled();
    expect(launchPersistentContextMock).not.toHaveBeenCalled();
    expect(playwrightLaunchPersistentContextMock).not.toHaveBeenCalled();
  });

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
    expect(playwrightLaunchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("manual_vendor_followup");
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "manual_vendor_followup",
      unmappedField: "material",
      selectedMaterial: null,
    });
  });

  it.each([
    ["playwright", playwrightLaunchPersistentContextMock],
    ["patchright", launchPersistentContextMock],
  ] as const)("uses the %s engine for persistent contexts", async (engine, persistentContextMock) => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({ bodyText: "Configure part" });
    persistentContextMock.mockResolvedValue(createFakeContext(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryBrowserEngine: engine,
        xometryUserDataDir: path.join(workerTempDir, "profile"),
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
    });

    expect(persistentContextMock).toHaveBeenCalledTimes(1);
  });

  it("captures a live instant quote with stable raw payload fields", async () => {
    const workerTempDir = await makeTempDir();
    const saveConfiguration = vi.fn();
    const setTolerance = vi.fn();
    let materialControlRendered = false;
    let finishControlRendered = false;
    let materialOptionsOpen = true;
    let finishOptionsOpen = false;
    let materialOptionsRendered = false;
    let finishOptionsRendered = false;
    const openMaterialOptions = vi.fn(() => {
      materialOptionsOpen = true;
    });
    const openFinishOptions = vi.fn(() => {
      finishOptionsOpen = true;
    });
    const clickMaterialControl = vi.fn();
    const clickFinishControl = vi.fn();
    const hiddenMaterialControl = vi.fn();
    const hiddenFinishControl = vi.fn();
    const startNewQuote = vi.fn();
    const instantQuoteUpload = vi.fn();
    const toolLibraryUpload = vi.fn();
    let instantQuoteUploadReady = false;
    startNewQuote.mockImplementation(() => {
      instantQuoteUploadReady = true;
    });
    const page = createFakePage({
      bodyText: "Upload a CAD File Start from Recent Configure part",
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
        [XOMETRY_LOCATORS.startNewQuoteButtons[0]]: {
          count: 1,
          click: startNewQuote,
        },
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => (instantQuoteUploadReady ? 1 : 0),
          setInputFiles: instantQuoteUpload,
        },
        'input[type="file"]': {
          count: 1,
          setInputFiles: toolLibraryUpload,
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [XOMETRY_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: hiddenMaterialControl,
        },
        [`${XOMETRY_LOCATORS.materialButtons[0]}:visible`]: {
          count: () => (materialControlRendered ? 1 : 0),
          waitFor: () => {
            materialControlRendered = true;
          },
          getAttribute: (name) => {
            if (name === "role") return "combobox";
            return name === "aria-expanded" ? "true" : null;
          },
          press: openMaterialOptions,
          click: clickMaterialControl,
        },
        [XOMETRY_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: hiddenFinishControl,
        },
        [`${XOMETRY_LOCATORS.finishButtons[0]}:visible`]: {
          count: () => (finishControlRendered ? 1 : 0),
          waitFor: () => {
            finishControlRendered = true;
          },
          getAttribute: (name) => (name === "role" ? "combobox" : null),
          press: openFinishOptions,
          click: clickFinishControl,
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
        if (finishOptionsOpen && finishOptionsRendered) return ["Black Anodize"];
        if (materialOptionsOpen && materialOptionsRendered) return ["6061-T6"];
        return [];
      },
      onOptionWait: (name) => {
        if (name?.test("6061-T6")) materialOptionsRendered = true;
        if (name?.test("Black Anodize")) finishOptionsRendered = true;
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("instant_quote_received");
    expect(result.totalPriceUsd).toBe(120);
    expect(result.leadTimeBusinessDays).toBe(5);
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "instant_quote",
      uploadSelector: XOMETRY_LOCATORS.uploadInputs[0],
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
    expect(startNewQuote).toHaveBeenCalledTimes(1);
    expect(instantQuoteUpload).toHaveBeenCalledTimes(1);
    expect(toolLibraryUpload).not.toHaveBeenCalled();
    expect(setTolerance).toHaveBeenCalledTimes(1);
    expect(openMaterialOptions).toHaveBeenCalledTimes(1);
    expect(openFinishOptions).toHaveBeenCalledTimes(1);
    expect(openMaterialOptions).toHaveBeenCalledWith("ArrowDown");
    expect(openFinishOptions).toHaveBeenCalledWith("ArrowDown");
    expect(playwrightLaunchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).not.toHaveBeenCalled();
    expect(clickMaterialControl).not.toHaveBeenCalled();
    expect(clickFinishControl).not.toHaveBeenCalled();
    expect(hiddenMaterialControl).not.toHaveBeenCalled();
    expect(hiddenFinishControl).not.toHaveBeenCalled();
    expect(page.waitForURL).toHaveBeenCalled();
    expect(result.artifacts).toHaveLength(10);
  });

  it("uses a verified auto-configured quote summary without reopening material options", async () => {
    const workerTempDir = await makeTempDir();
    const uploadCad = vi.fn();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-SUMMARY-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: uploadCad,
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: summaryText,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(uploadCad).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("instant_quote_received");
    expect(result.totalPriceUsd).toBe(120);
    expect(result.rawPayload).toMatchObject({
      selectedMaterial: "6061-T6x",
      selectedFinish: "Black Anodize",
      selectedTolerance: "standard",
      toleranceSelector: null,
      requirementsVerified: true,
      saveConfigurationSelector: null,
    });
  });

  it("uses only the approved standalone uploader after dashboard navigation", async () => {
    const workerTempDir = await makeTempDir();
    const standaloneUpload = vi.fn();
    const genericUpload = vi.fn();
    const summaryText = [
      "Welcome back",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      dashboardRedirectUrl: "https://www.xometry.com/quoting/new",
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-STANDALONE-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.startNewQuoteButtons[0]]: {
          count: 1,
        },
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 0,
        },
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: 1,
          setInputFiles: standaloneUpload,
        },
        'input[type="file"]': {
          count: 1,
          setInputFiles: genericUpload,
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: summaryText,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("instant_quote_received");
    expect(result.rawPayload).toMatchObject({
      uploadSelector: XOMETRY_LOCATORS.standaloneUploadInputs[0],
      requirementsVerified: true,
    });
    expect(standaloneUpload).toHaveBeenCalledTimes(1);
    expect(genericUpload).not.toHaveBeenCalled();
  });

  it("opens the authenticated dashboard CAD uploader without touching the Tool Library input", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardUploadClick = vi.fn();
    const dashboardCadUpload = vi.fn();
    const toolLibraryUpload = vi.fn();
    let dashboardInputReady = false;
    dashboardUploadClick.mockImplementation(() => {
      dashboardInputReady = true;
    });
    const summaryText = [
      "Pick Up Where You Left Off",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-FILECHOOSER-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          getAttribute: (name) =>
            name === "accept" ? ".step,.stp,.sldprt" : null,
          setInputFiles: async (files) => {
            await dashboardCadUpload(files);
          },
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: dashboardUploadClick,
        },
        'input[type="file"]': {
          count: 1,
          setInputFiles: toolLibraryUpload,
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: summaryText,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("instant_quote_received");
    expect(result.rawPayload).toMatchObject({
      uploadSelector: XOMETRY_LOCATORS.uploadInputs[0],
      requirementsVerified: true,
    });
    expect(dashboardUploadClick).toHaveBeenCalledTimes(1);
    expect(dashboardCadUpload).toHaveBeenCalledWith([
      "/tmp/part.step",
    ]);
    expect(toolLibraryUpload).not.toHaveBeenCalled();
  });

  it("uses the current Upload 3D Files surface without touching the Tool Library input", async () => {
    const workerTempDir = await makeTempDir();
    const currentQuoteHomeUpload = vi.fn();
    const toolLibraryUpload = vi.fn();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: `${summaryText} Upload 3D Files`,
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-UPLOAD-3D-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 0,
        },
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          getAttribute: (name) =>
            name === "accept" ? ".step,.stp,.sldprt" : null,
          setInputFiles: currentQuoteHomeUpload,
        },
        'input[type="file"]': {
          count: 1,
          setInputFiles: toolLibraryUpload,
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: summaryText,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("instant_quote_received");
    expect(result.rawPayload).toMatchObject({
      uploadSelector: XOMETRY_LOCATORS.uploadInputs[1],
      requirementsVerified: true,
    });
    expect(currentQuoteHomeUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
    expect(toolLibraryUpload).not.toHaveBeenCalled();
  });

  it("waits for the dashboard uploader's supported file types before selecting CAD", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardCadUpload = vi.fn();
    let dashboardInputReady = false;
    let acceptReads = 0;
    const page = createFakePage({
      bodyText: "Pick Up Where You Left Off",
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-READY-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          getAttribute: (name) => {
            if (name !== "accept") return null;
            acceptReads += 1;
            return acceptReads >= 3 ? ".step,.stp" : null;
          },
          setInputFiles: dashboardCadUpload,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: () => {
            dashboardInputReady = true;
          },
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: [
            "Quantity: 2",
            "Material: Aluminum 6061-T6x (Best Available)",
            "Finish: Black Anodize",
            "Precision Tolerance: ±.005",
            "Least Expensive 5 business days $120.00",
          ].join(" "),
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        url: "https://www.xometry.com/quoting/quote/Q00-READY-0001",
      },
    });
    expect(acceptReads).toBe(3);
    expect(dashboardCadUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
  });

  it("applies readiness checks when the dashboard upload panel is already mounted", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardCadUpload = vi.fn();
    const dashboardUploadClick = vi.fn();
    let acceptReads = 0;
    const page = createFakePage({
      bodyText: "Start A New Instant Quote",
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-MOUNTED-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => {
            if (name !== "accept") return null;
            acceptReads += 1;
            return acceptReads >= 3 ? ".step,.stp" : null;
          },
          setInputFiles: dashboardCadUpload,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: dashboardUploadClick,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        url: "https://www.xometry.com/quoting/quote/Q00-MOUNTED-0001",
      },
    });
    expect(acceptReads).toBe(3);
    expect(dashboardCadUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
    expect(dashboardUploadClick).not.toHaveBeenCalled();
  });

  it("fails fast when the dashboard upload input mounts before file types are ready", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardCadUpload = vi.fn();
    let dashboardInputReady = false;
    const page = createFakePage({
      bodyText:
        "Supported file types are still loading. Wait a moment and try again.",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          getAttribute: () => null,
          setInputFiles: dashboardCadUpload,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: () => {
            dashboardInputReady = true;
          },
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "upload_failure",
      payload: {
        reason: "supported_file_types_not_ready",
        accept: null,
        loadingErrorVisible: true,
        requestedExtensions: [".step"],
      },
    });
    expect(dashboardCadUpload).not.toHaveBeenCalled();
  });

  it("fails without retrying when Xometry's loaded list excludes the CAD type", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardCadUpload = vi.fn();
    let dashboardInputReady = false;
    const page = createFakePage({
      bodyText: "Start A New Instant Quote",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: dashboardCadUpload,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: () => {
            dashboardInputReady = true;
          },
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );
    const input = makeInput();

    await expect(
      adapter.quote(
        makeInput({
          stagedCadFile: {
            ...input.stagedCadFile!,
            originalName: "part.iges",
            localPath: "/tmp/part.iges",
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "upload_failure",
      payload: {
        reason: "unsupported_file_type",
        accept: ".step,.stp",
        requestedExtensions: [".iges"],
      },
    });
    expect(dashboardCadUpload).not.toHaveBeenCalled();
  });

  it("allows a slow dashboard upload to continue into quote navigation", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardCadUpload = vi.fn();
    let dashboardInputReady = false;
    const page = createFakePage({
      bodyText: "Upload at least 1 CAD file to get started.",
      delayedUploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-SLOW-0001",
      delayedUploadRedirectAfterTimeouts: 25,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.dashboardUploadPanels[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          text: "Upload at least 1 CAD file to get started.",
        },
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: dashboardCadUpload,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: () => {
            dashboardInputReady = true;
          },
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        url: "https://www.xometry.com/quoting/quote/Q00-SLOW-0001",
      },
    });
    expect(dashboardCadUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
  });

  it("does not use a matching filename in dashboard history as upload progress", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardCadUpload = vi.fn();
    let dashboardInputReady = false;
    let uploadPanelReads = 0;
    const page = createFakePage({
      bodyText: "Recent CAD Files part.step",
      delayedUploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-HISTORY-0001",
      delayedUploadRedirectAfterTimeouts: 25,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.dashboardUploadPanels[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          text: () => {
            uploadPanelReads += 1;
            return "Upload at least 1 CAD file to get started.";
          },
        },
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => (dashboardInputReady ? 1 : 0),
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: dashboardCadUpload,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: () => {
            dashboardInputReady = true;
          },
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        url: "https://www.xometry.com/quoting/quote/Q00-HISTORY-0001",
      },
    });
    expect(uploadPanelReads).toBe(20);
    expect(dashboardCadUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
  });

  it("fails closed when the dashboard button does not mount the approved uploader", async () => {
    const workerTempDir = await makeTempDir();
    const dashboardUploadClick = vi.fn();
    const toolLibraryUpload = vi.fn();
    const page = createFakePage({
      bodyText: "Pick Up Where You Left Off Upload a CAD File",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 0,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
          click: dashboardUploadClick,
        },
        'input[type="file"]': {
          count: 1,
          setInputFiles: toolLibraryUpload,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "selector_failure",
      payload: {
        failedSelector: XOMETRY_LOCATORS.uploadInputs[0],
        attemptedSelectors: [
          ...XOMETRY_LOCATORS.uploadInputs,
          ...XOMETRY_LOCATORS.dashboardUploadButtons,
        ],
        setInputErrorCount: 0,
      },
    });
    expect(dashboardUploadClick).toHaveBeenCalledTimes(1);
    expect(toolLibraryUpload).not.toHaveBeenCalled();
  });

  it("does not let a visible quantity input override a contradictory summary", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 1",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-QUANTITY-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
          fill: vi.fn(),
          press: vi.fn(),
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        field: "material",
      },
    });
  });

  it("fails closed when an upload never reaches the new quote URL", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Upload a CAD File",
      redirectUrl: XOMETRY_URLS.quoteHome,
      quoteNavigationFails: true,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.exportControlContinue[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [XOMETRY_LOCATORS.exportControlNo[0]]: {
          count: 1,
          click: vi.fn(),
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    try {
      await adapter.quote(makeInput());
      throw new Error("expected navigation failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "navigation_failure",
        payload: {
          reason: "modal_no_redirect",
          url: XOMETRY_URLS.quoteHome,
        },
      });
      expect((error as VendorAutomationError).artifacts.map((artifact) => artifact.label)).toEqual([
        "landing-screenshot",
        "landing-dom",
        "post-modal-poll-screenshot",
        "post-modal-poll-dom",
        "wait-for-url-timeout-screenshot",
        "wait-for-url-timeout-dom",
      ]);
    }
  });

  it("fails closed on the anonymous email gate revealed after upload", async () => {
    const workerTempDir = await makeTempDir();
    let emailGateVisible = false;
    const page = createFakePage({
      bodyText: () =>
        emailGateVisible
          ? [
              "Enter Your Email",
              "Business Email",
              "View My Quote",
              "OVD-VALIDATION-002.STEP",
            ].join(" ")
          : "Upload a 3D model to see instant pricing, lead time, and DFM feedback.",
      quoteNavigationFails: true,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: () => {
            emailGateVisible = true;
          },
          text: () => (emailGateVisible ? "OVD-VALIDATION-002.STEP" : ""),
        },
        [XOMETRY_LOCATORS.dashboardUploadPanels[0]]: {
          count: 1,
          text: () => (emailGateVisible ? "OVD-VALIDATION-002.STEP" : ""),
        },
      },
    });
    playwrightLaunchPersistentContextMock.mockResolvedValue(createFakeContext(page));

    const config = makeConfig({
      workerTempDir,
      xometryStorageStatePath: null,
      xometryUserDataDir: path.join(workerTempDir, "profile"),
      xometryProfileSnapshotBucket: "private-profile-bucket",
      xometryProfileSnapshotObject: "xometry/profile.tgz",
      xometryProfileSnapshotGeneration: "41",
      xometryBrowserEngine: "playwright",
    });
    const adapter = new XometryAdapter(
      "xometry",
      config,
    );

    try {
      await adapter.quote(makeInput());
      throw new Error("expected the anonymous email gate to require login");
    } catch (error) {
      expect(error).toMatchObject({
        code: "login_required",
        payload: {
          reason: "anonymous_email_gate",
          url: XOMETRY_URLS.quoteHome,
        },
      });
      expect(
        (error as VendorAutomationError).artifacts.map((artifact) => artifact.label),
      ).toEqual([
        "landing-screenshot",
        "landing-dom",
        "login-required-screenshot",
        "login-required-dom",
      ]);
    }
    expect(page.waitForURL).not.toHaveBeenCalled();
    expect(config.xometryProfileSnapshotGeneration).toBeNull();
    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "login_required",
      payload: { reason: "profile_snapshot_unavailable" },
    });
    expect(playwrightLaunchPersistentContextMock).toHaveBeenCalledTimes(1);
  });

  it("blocks browser launch after snapshot ownership is quarantined", async () => {
    const workerTempDir = await makeTempDir();
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: null,
        xometryUserDataDir: path.join(workerTempDir, "profile"),
        xometryProfileSnapshotBucket: "private-profile-bucket",
        xometryProfileSnapshotObject: "xometry/profile.tgz",
        xometryProfileSnapshotGeneration: null,
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "login_required",
      payload: { reason: "profile_snapshot_unavailable" },
    });
    expect(playwrightLaunchPersistentContextMock).not.toHaveBeenCalled();
  });

  it("quarantines snapshot ownership when the browser cannot close", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Upload a 3D model to see instant pricing, lead time, and DFM feedback.",
    });
    const context = createFakeContext(page);
    context.close = vi.fn().mockRejectedValue(new Error("close failed"));
    playwrightLaunchPersistentContextMock.mockResolvedValue(context);
    const config = makeConfig({
      workerTempDir,
      xometryStorageStatePath: null,
      xometryUserDataDir: path.join(workerTempDir, "profile"),
      xometryProfileSnapshotBucket: "private-profile-bucket",
      xometryProfileSnapshotObject: "xometry/profile.tgz",
      xometryProfileSnapshotGeneration: "41",
      xometryBrowserEngine: "playwright",
    });
    const adapter = new XometryAdapter("xometry", config);

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "persistence_failure",
      payload: { reason: "browser_close_failed", providerMutationPossible: true },
    });
    expect(config.xometryProfileSnapshotGeneration).toBeNull();
    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "login_required",
      payload: { reason: "profile_snapshot_unavailable" },
    });
    expect(playwrightLaunchPersistentContextMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Xometry asks about export control without an explicit No option", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Are any parts subject to export control?",
      redirectUrl: XOMETRY_URLS.quoteHome,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.exportControlContinue[0]]: {
          count: 1,
          click: vi.fn(),
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        reason: "export_control_state_ambiguous",
      },
    });
  });

  it("does not accept lookalike values outside their exact summary fields", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Type III Hard Anodize",
      "Precision Tolerance: ±.005",
      "Unrelated note: Black Anodize",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-FIELD-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        field: "material",
      },
    });
  });

  it("does not accept a material token that appears outside the material field", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Unrelated note: supplier code 303",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-FIELD-0002",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );
    const baseInput = makeInput();

    await expect(
      adapter.quote(
        makeInput({
          requirement: {
            ...baseInput.requirement,
            material: "303 stainless",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        field: "material",
      },
    });
  });

  it("does not accept a sibling aluminum temper from the saved summary", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T651",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEMPER-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        field: "material",
      },
    });
  });

  it("accepts a verified summary only after the drawing upload is acknowledged and refreshed", async () => {
    const workerTempDir = await makeTempDir();
    const uploadDrawing = vi.fn();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-0001",
      responses: [
        {
          method: "POST",
          url: "https://api.xometry.com/v2/quotes/parts/PART-1/upload_drawings",
          status: 200,
        },
        {
          method: "GET",
          url: "https://api.xometry.com/v2/quotes/Q00-DRAWING-0001",
          status: 200,
          body: {
            parts: {
              "quote-part-1": {
                part: {
                  _id: "PART-1",
                  revisions: [
                    {
                      drawings: [
                        {
                          original_filename: "part.pdf",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.drawingInputs[0]]: {
          count: 1,
          setInputFiles: uploadDrawing,
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: summaryText,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const input = makeInput({
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
    });
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(input);

    expect(uploadDrawing).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("instant_quote_received");
    expect(result.totalPriceUsd).toBe(120);
    expect(result.rawPayload).toMatchObject({
      drawingUploadMode: "fallback",
      drawingUploadSelector: XOMETRY_LOCATORS.drawingInputs[0],
      drawingUploadVerification: "upload_acknowledged_and_drawing_confirmed",
      requirementsVerified: true,
    });
  });

  it("polls a successful drawing upload until the exact quote part contains it", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-ASYNC",
      responses: [
        {
          method: "POST",
          url: "https://api.xometry.com/v2/quotes/parts/PART-1/upload_drawings",
          status: 200,
        },
        {
          method: "GET",
          url: "https://api.xometry.com/v2/quotes/Q00-DRAWING-ASYNC",
          status: 200,
          body: {
            parts: {
              stale: {
                part: {
                  _id: "PART-1",
                  revisions: [
                    {
                      drawings: [{ original_filename: "part.pdf" }],
                    },
                    { drawings: [] },
                  ],
                },
              },
            },
          },
        },
        {
          method: "GET",
          url: "https://api.xometry.com/v2/quotes/Q00-DRAWING-ASYNC",
          status: 200,
          body: {
            parts: {
              refreshed: {
                part: {
                  _id: "PART-1",
                  revisions: [
                    {
                      drawings: [{ original_filename: "part.pdf" }],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.drawingInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: summaryText,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(makeInputWithDrawing());

    expect(result.status).toBe("instant_quote_received");
    expect(result.rawPayload).toMatchObject({
      drawingUploadVerification:
        "upload_acknowledged_and_drawing_confirmed",
      requirementsVerified: true,
    });
  });

  it("rejects an explicit drawing upload failure despite a visible filename", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-FAILED",
      visibleFilenames: ["part.pdf"],
      responses: [
        {
          method: "POST",
          url: "https://api.xometry.com/v2/quotes/parts/PART-1/upload_drawings",
          status: 422,
        },
      ],
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.drawingInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(makeInputWithDrawing())).rejects.toMatchObject({
      code: "upload_failure",
      payload: {
        reason: "drawing_attachment_missing",
      },
    });
  });

  it("does not retry a weaker drawing selector after an acknowledged upload cannot be confirmed", async () => {
    const workerTempDir = await makeTempDir();
    const weakerUpload = vi.fn();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-RELOAD",
      reloadFails: true,
      visibleFilenames: ["part.pdf"],
      responses: [
        {
          method: "POST",
          url: "https://api.xometry.com/v2/quotes/parts/PART-1/upload_drawings",
          status: 200,
        },
      ],
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.drawingInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.drawingInputs[1]]: {
          count: 1,
          setInputFiles: weakerUpload,
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
        browserTimeoutMs: 25,
      }),
    );

    await expect(adapter.quote(makeInputWithDrawing())).rejects.toMatchObject({
      code: "upload_failure",
      payload: {
        reason: "drawing_attachment_missing",
      },
    });
    expect(weakerUpload).not.toHaveBeenCalled();
  });

  it("rejects a drawing upload that is absent from the refreshed quote payload", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-0002",
      visibleFilenames: ["part.pdf"],
      responses: [
        {
          method: "POST",
          url: "https://api.xometry.com/v2/quotes/parts/PART-1/upload_drawings",
          status: 202,
        },
        {
          method: "GET",
          url: "https://api.xometry.com/v2/quotes/Q00-DRAWING-0002",
          status: 200,
          body: {
            parts: {
              "quote-part-1": {
                part: {
                  _id: "PART-1",
                  revisions: [{ drawings: [] }],
                },
              },
              "quote-part-2": {
                part: {
                  _id: "PART-2",
                  revisions: [
                    {
                      drawings: [
                        {
                          original_filename: "part.pdf",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        [XOMETRY_LOCATORS.drawingInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

    const baseInput = makeInput();
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
        browserTimeoutMs: 25,
      }),
    );

    await expect(
      adapter.quote(
        makeInput({
          part: {
            ...baseInput.part,
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
      ),
    ).rejects.toMatchObject({
      code: "upload_failure",
      payload: {
        reason: "drawing_attachment_missing",
      },
    });
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
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
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
    let drawingVisible = false;
    const uploadFilesMock = vi.fn(async (files: string[]) => {
      if (files.length > 1) {
        throw new Error("drawing must be uploaded separately");
      }
    });
    const fallbackUploadMock = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      drawingVisible = true;
    });
    const page = createFakePage({
      bodyText: "Manual review required. Drawing required for this quote.",
      postSaveBodyText: () =>
        [
          drawingVisible ? "part.pdf" : "",
          "Quantity 2",
          "Material: Aluminum 7075-T6",
          "Finish: Standard",
          "Precision Tolerance: ±.005",
          "Manual review required. Drawing required for this quote.",
        ].join(" "),
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002/part-1",
      saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002#part-part-1",
      visibleFilenames: ["part.pdf"],
      responseWaitDelayMs: 20,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
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
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        browserTimeoutMs: 200,
      }),
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
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
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
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
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
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
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
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
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
        makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
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
        attemptedSelectors: [
          ...XOMETRY_LOCATORS.uploadInputs,
          ...XOMETRY_LOCATORS.dashboardUploadButtons,
        ],
      },
    });
  });

  it("fails closed when the requested quantity cannot be configured", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      redirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
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
