// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: launchMock,
  },
}));

import { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  FictivAdapter,
  detectBlockingStateSignal,
  isManualReviewText,
  parseFirstCurrency,
  parseLeadTime,
} from "./fictiv";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  FICTIV_LOCATORS,
  FICTIV_URLS,
} from "./fictivConstraints";

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "live",
    workerLiveAdapters: ["xometry", "fictiv"],
    workerName: "worker-1",
    pollIntervalMs: 5000,
    httpHost: "127.0.0.1",
    httpPort: 0,
    workerTempDir: path.join(os.tmpdir(), "overdrafter-fictiv-test"),
    artifactBucket: "quote-artifacts",
    playwrightHeadless: true,
    playwrightCaptureTrace: false,
    browserTimeoutMs: 30000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: null,
    xometryStorageStateJson: null,
    fictivStorageStatePath: path.join(os.tmpdir(), "fictiv-storage-state.json"),
    openAiApiKey: null,
    anthropicApiKey: null,
    openRouterApiKey: null,
    workerBuildVersion: "dev-local",
    drawingExtractionModel: "gpt-5.4",
    drawingExtractionEnableModelFallback: false,
    drawingExtractionDebugAllowedModels: ["gpt-5.4"],
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
      localPath: path.resolve(".tmp/part.step"),
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
      applicable_vendors: ["fictiv"],
    },
    ...overrides,
  };
}

type LocatorBehavior = {
  count?: number | (() => number);
  text?: string | (() => string);
  href?: string | null | (() => string | null);
  setInputFiles?: (files: string[]) => Promise<void> | void;
  click?: () => Promise<void> | void;
  fill?: (value: string) => Promise<void> | void;
  press?: (value: string) => Promise<void> | void;
};

type FakePageOptions = {
  bodyText?: string;
  bodyTextSequence?: string[];
  url?: string;
  selectorBehaviors?: Record<string, LocatorBehavior>;
  optionTexts?: string[];
  redirectUrl?: string;
  onWaitForTimeout?: (waitCount: number) => void;
};

function makeLocator(behavior: LocatorBehavior = {}) {
  const resolve = <T>(value: T | (() => T) | undefined, fallback: T) =>
    typeof value === "function" ? (value as () => T)() : (value ?? fallback);

  return {
    first() {
      return this;
    },
    async count() {
      return resolve(behavior.count, 0);
    },
    async innerText() {
      return resolve(behavior.text, "");
    },
    async getAttribute(name: string) {
      if (name === "href") {
        return resolve(behavior.href, null);
      }
      return null;
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

      const text = resolve(behavior.text, "");
      return options.hasText.test(text)
        ? makeLocator(behavior)
        : makeLocator({ count: 0, text: "" });
    },
  };
}

function createFakePage(options: FakePageOptions) {
  const selectorBehaviors = options.selectorBehaviors ?? {};
  let currentUrl = options.url ?? FICTIV_URLS.quotes;
  const bodyTextSequence =
    options.bodyTextSequence && options.bodyTextSequence.length > 0
      ? [...options.bodyTextSequence]
      : [options.bodyText ?? ""];
  let bodyTextIndex = 0;
  let waitCount = 0;
  const visitedUrls: string[] = [];

  const currentBodyText = () => bodyTextSequence[Math.min(bodyTextIndex, bodyTextSequence.length - 1)];

  return {
    visitedUrls,
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
          text: () => currentBodyText(),
        });
      }

      return makeLocator(selectorBehaviors[selector]);
    },
    getByRole(role: string, input: { name?: RegExp }) {
      if (role !== "option") {
        return makeLocator({ count: 0, text: "" });
      }

      const optionText =
        options.optionTexts?.find((candidate) => input.name?.test(candidate)) ?? "";

      return makeLocator({
        count: optionText ? 1 : 0,
        text: optionText,
      });
    },
    async waitForFunction() {
      return undefined;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      waitCount += 1;
      options.onWaitForTimeout?.(waitCount);
      if (bodyTextIndex < bodyTextSequence.length - 1) {
        bodyTextIndex += 1;
      }
      return undefined;
    },
    async goto(url: string) {
      visitedUrls.push(url);
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-fictiv-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  launchMock.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Fictiv helpers", () => {
  it("maps explicit materials and finishes, and rejects unknown ones", () => {
    expect(buildMaterialSearchTerms("6061 aluminum")).toEqual(["6061", "6061-T6"]);
    expect(buildMaterialSearchTerms("mystery alloy")).toBeNull();
    expect(buildFinishSearchTerms("Type II black anodize")).toEqual(["Type II", "Black"]);
    expect(buildFinishSearchTerms("as machined")).toEqual([]);
    expect(buildFinishSearchTerms("custom dipped coating")).toBeNull();
  });

  it("parses values and detects blocking/manual-review signals", () => {
    expect(parseFirstCurrency("Total price $1,250.75")).toBe(1250.75);
    expect(parseLeadTime("Ships in 7 business days")).toBe(7);
    expect(isManualReviewText("RFQ required for this part.")).toBe(true);
    expect(
      detectBlockingStateSignal({
        text: "Verify you are human",
        url: FICTIV_URLS.quotes,
      }),
    ).toBe("captcha");
    expect(
      detectBlockingStateSignal({
        text: "Log in to your account",
        url: FICTIV_URLS.login,
      }),
    ).toBe("login_required");
  });
});

describe("FictivAdapter", () => {
  it("returns manual vendor follow-up for unmapped requirements without launching Playwright", async () => {
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerMode: "live" }));

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

  it("captures a live instant quote after CNC/process setup and upload-analysis progression", async () => {
    const workerTempDir = await makeTempDir();
    const interactionLog: string[] = [];
    let cncSelected = false;
    const page = createFakePage({
      bodyTextSequence: [
        "Select process to continue",
        "Uploading your parts. Active quotes",
        "Analyzing your geometry",
        "Active quotes Total price $120.00 Lead time 5 business days",
      ],
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[1]]: {
          count: () => (cncSelected ? 1 : 0),
          setInputFiles: vi.fn(() => {
            interactionLog.push("set-upload-files");
          }),
        },
        [FICTIV_LOCATORS.processButtons[0]]: {
          count: 1,
          text: () => (cncSelected ? "CNC" : "Process"),
          click: vi.fn(() => {
            cncSelected = true;
            interactionLog.push("open-process");
          }),
        },
        [FICTIV_LOCATORS.configurationDrawerButtons[0]]: {
          count: 1,
          click: vi.fn(() => {
            interactionLog.push("open-configuration");
          }),
        },
        [FICTIV_LOCATORS.endUseButtons[0]]: {
          count: 1,
          text: "End use",
          click: vi.fn(),
        },
        [FICTIV_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: vi.fn(),
          press: vi.fn(),
        },
        [FICTIV_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [FICTIV_LOCATORS.finishButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
        [FICTIV_LOCATORS.priceText[0]]: {
          count: 1,
          text: "$120.00",
        },
        [FICTIV_LOCATORS.leadTimeText[0]]: {
          count: 1,
          text: "5 business days",
        },
        [FICTIV_LOCATORS.quoteLinkAnchors[0]]: {
          count: 1,
          href: "/quotes/abc123",
        },
      },
      optionTexts: ["CNC", "6061", "Type II", "Prototype"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("instant_quote_received");
    expect(result.totalPriceUsd).toBe(120);
    expect(result.leadTimeBusinessDays).toBe(5);
    expect(result.quoteUrl).toBe("https://app.fictiv.com/quotes/abc123");
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "instant_quote",
      uploadSelector: FICTIV_LOCATORS.uploadInputs[1],
      selectedProcess: "CNC",
      selectedMaterial: "6061",
      selectedFinish: "Type II",
      selectedEndUse: "Prototype",
      openedConfigurationDrawer: true,
      resultClassification: "instant_quote",
      priceSource: "selector",
      leadTimeSource: "selector",
      source: "fictiv-live-adapter",
    });
    expect(page.visitedUrls[0]).toBe(FICTIV_URLS.upload);
    expect(interactionLog.indexOf("open-process")).toBeGreaterThanOrEqual(0);
    expect(interactionLog.indexOf("open-process")).toBeLessThan(interactionLog.indexOf("set-upload-files"));
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it("returns manual_review_pending with configuration_required classification when configuration is incomplete", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Complete configuration to continue. Select material to price this part.",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [FICTIV_LOCATORS.configurationDrawerButtons[0]]: {
          count: 1,
          click: vi.fn(),
        },
      },
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("manual_review_pending");
    expect(result.totalPriceUsd).toBeNull();
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "configuration_required",
      resultClassification: "configuration_required",
    });
    expect(result.notes[0]).toMatch(/requires additional configuration/i);
  });

  it("waits for delayed process-picker render before attempting upload", async () => {
    const workerTempDir = await makeTempDir();
    let processPickerVisible = false;
    let cncSelected = false;
    const page = createFakePage({
      bodyTextSequence: [
        "Upload your parts",
        "Upload your parts",
        "Select process to continue",
        "Uploading your parts",
        "Analyzing your geometry",
        "Active quotes Total price $88.00 Lead time 4 business days",
      ],
      onWaitForTimeout(waitCount) {
        if (waitCount >= 2) {
          processPickerVisible = true;
        }
      },
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: {
          count: () => (processPickerVisible ? 1 : 0),
          text: () => (cncSelected ? "CNC" : "Process"),
          click: vi.fn(() => {
            cncSelected = true;
          }),
        },
        [FICTIV_LOCATORS.uploadInputs[0]]: {
          count: () => (cncSelected ? 1 : 0),
          setInputFiles: vi.fn(),
        },
        [FICTIV_LOCATORS.priceText[0]]: {
          count: 1,
          text: "$88.00",
        },
        [FICTIV_LOCATORS.leadTimeText[0]]: {
          count: 1,
          text: "4 business days",
        },
        [FICTIV_LOCATORS.quoteLinkAnchors[0]]: {
          count: 1,
          href: "/quotes/upload-race-safe",
        },
      },
      optionTexts: ["CNC"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("instant_quote_received");
    expect(result.totalPriceUsd).toBe(88);
    expect(result.rawPayload).toMatchObject({
      selectedProcess: "CNC",
      uploadSelector: FICTIV_LOCATORS.uploadInputs[0],
      resultClassification: "instant_quote",
    });
    expect(page.visitedUrls[0]).toBe(FICTIV_URLS.upload);
  });

  it("maps account capability limitations to manual_review_pending with explicit classification", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "CNC machining is not available for your account. Contact your account manager.",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
      },
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
      }),
    );

    const result = await adapter.quote(makeInput());

    expect(result.status).toBe("manual_review_pending");
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "manual_review",
      resultClassification: "capability_limited",
    });
    expect(result.notes[0]).toMatch(/capability limitations/i);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });
});
