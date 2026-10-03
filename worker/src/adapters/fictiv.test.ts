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

import { VendorAutomationError, VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  annotateProviderMutationFailure,
  createProviderMutationPhase,
  runInProviderMutationPhase,
} from "../providerMutationPhase";
import { isRetryableVendorTaskError } from "../vendorTaskRetry";
import {
  authorizeLiveEvaluationInput,
  sha256File,
} from "../liveEvaluationFiles";
import { buildLiveEvaluationAdapterRegistry } from "./index";
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
import { evaluateProviderAdapterContract, evaluateProviderAdapterFailureContract } from "./providerAdapterContract";

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "live",
    workerLiveAdapters: ["xometry", "fictiv"],
    workerName: "worker-1",
    pollIntervalMs: 5000,
    pricingModelEnabled: false,
    pricingModelMinConfidence: 0.7,
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
    xometryUserDataDir: null,
    xometryBrowserChannel: null,
    xometryProfileLockWaitMs: 0,
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
  setInputFiles?: (files: unknown) => Promise<void> | void;
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
    nth(_index: number) {
      return this;
    },
    async waitFor() {
      return undefined;
    },
    async isVisible() {
      return resolve(behavior.count, 0) > 0;
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
    async setInputFiles(files: unknown) {
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
  it("rejects an unbound local evaluation before session launch", async () => {
    const adapter = new FictivAdapter("fictiv", makeConfig());
    await expect(adapter.quote(makeInput({ executionContext: "live_evaluation" }))).rejects.toMatchObject({
      payload: { reason: "evaluation_export_control_authorization_missing" },
    });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("rejects changed staged bytes at the local evaluation entry point", async () => {
    const dir = await makeTempDir();
    const cadPath = path.join(dir, "part.step");
    await fs.writeFile(cadPath, "synthetic authorized bytes");
    const cadFileSha256 = await sha256File(cadPath);
    await fs.writeFile(cadPath, "synthetic changed bytes");
    const input = makeInput({
      executionContext: "live_evaluation",
      liveEvaluationAuthorization: {
        nonExportControlled: true,
        cadFileSha256,
        drawingFileSha256: null,
      },
      stagedCadFile: {
        ...makeInput().stagedCadFile!,
        localPath: cadPath,
        trustedContentSha256: cadFileSha256,
      },
    });
    const adapter = buildLiveEvaluationAdapterRegistry(makeConfig()).fictiv!;
    await expect(adapter.quote(input)).rejects.toMatchObject({
      payload: { reason: "evaluation_export_control_authorization_missing" },
    });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("closes a launched browser if isolated context creation fails", async () => {
    const close = vi.fn();
    const newContext = vi.fn().mockRejectedValue(new Error("session unavailable"));
    launchMock.mockResolvedValue({ newContext, close });
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    let failure: unknown;
    try {
      await adapter.quote(makeInput());
    } catch (error) {
      failure = error;
    }
    expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
      ok: true,
      terminalState: "unavailable",
    });
    expect(newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: expect.any(String) }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops on an unexpected origin before uploading", async () => {
    const upload = vi.fn();
    const page = createFakePage({
      redirectUrl: "https://untrusted.invalid/quotes/upload",
      bodyText: "Upload your parts",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: upload },
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
      },
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      payload: { terminalState: "unexpected_origin" },
    });
    expect(upload).not.toHaveBeenCalled();
  });

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
    const cadPath = path.join(workerTempDir, "evaluation-part.step");
    await fs.writeFile(cadPath, "authorized-fictiv-cad");
    const cadFileSha256 = await sha256File(cadPath);
    const authorizedInput = await authorizeLiveEvaluationInput(makeInput({
      requestedQuantity: 1000,
      part: { ...makeInput().part, quantity: 1000 },
      executionContext: "live_evaluation",
      liveEvaluationAuthorization: {
        nonExportControlled: true,
        cadFileSha256,
        drawingFileSha256: null,
      },
      stagedCadFile: {
        ...makeInput().stagedCadFile!,
        localPath: cadPath,
        trustedContentSha256: cadFileSha256,
      },
    }));
    expect(authorizedInput).not.toBeNull();
    const interactionLog: string[] = [];
    let cncSelected = false;
    const uploadFiles = vi.fn((files: unknown) => {
      interactionLog.push("set-upload-files");
      return files;
    });
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
          setInputFiles: uploadFiles,
        },
        [FICTIV_LOCATORS.processButtons[0]]: {
          count: 1,
          text: () => (cncSelected ? "CNC" : "Process"),
          click: vi.fn(async () => {
            await fs.writeFile(cadPath, "replacement-after-browser-launch");
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
          text: "Domestic standard 5 business days USD $120.00 total price,",
        },
        [FICTIV_LOCATORS.leadTimeOptionTargets[0].selector]: {
          count: 1,
          text: "Domestic fastest 5 production days USD $120.00 total for 1,000 parts",
        },
        [FICTIV_LOCATORS.leadTimeOptionTargets[1].selector]: {
          count: 1,
          text: "Domestic standard 5 production days Price—Total USD $120.00",
        },
        [FICTIV_LOCATORS.leadTimeOptionTargets[2].selector]: {
          count: 1,
          text: "Domestic economy 8 production days Total CAD $95.00",
        },
        [FICTIV_LOCATORS.leadTimeOptionTargets[3].selector]: {
          count: 1,
          text: "Overseas fastest Total USD $90.00",
        },
        [FICTIV_LOCATORS.leadTimeOptionTargets[4].selector]: {
          count: 1,
          text: "Overseas standard 7 days Total USD $45.00\nper part",
        },
        [FICTIV_LOCATORS.leadTimeOptionTargets[5].selector]: {
          count: 1,
          text: "Total discount USD $10.00\nTotal price USD $115.00",
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

    const result = await adapter.quote(authorizedInput!);

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
      selectedEndUseSource: "selector",
      openedConfigurationDrawer: true,
      resultClassification: "instant_quote",
      priceSource: "selector",
      priceCurrency: "USD",
      leadTimeSource: "selector",
      source: "fictiv-live-adapter",
    });
    expect(page.visitedUrls[0]).toBe(FICTIV_URLS.upload);
    expect(interactionLog.indexOf("open-process")).toBeGreaterThanOrEqual(0);
    expect(interactionLog.indexOf("open-process")).toBeLessThan(interactionLog.indexOf("set-upload-files"));
    const capturedUpload = uploadFiles.mock.calls[0]?.[0] as Array<{ buffer: Buffer }>;
    expect(capturedUpload[0]?.buffer.toString()).toBe("authorized-fictiv-cad");
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.offers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerOptionId: "domestic:fastest",
        totalPriceUsd: 120,
        leadTimeBusinessDays: 5,
        provenance: expect.objectContaining({
          containerSelector: FICTIV_LOCATORS.leadTimeOptionTargets[0].selector,
          priceSource: "selector",
          leadTimeSource: "selector",
        }),
      }),
      expect.objectContaining({
        providerOptionId: "domestic:standard",
        totalPriceUsd: 120,
        leadTimeBusinessDays: 5,
      }),
      expect.objectContaining({
        providerOptionId: "overseas:fastest",
        totalPriceUsd: 90,
        leadTimeBusinessDays: null,
        geographicOrigin: "unknown",
        provenance: expect.objectContaining({ leadTimeSource: "none", geographicOriginSource: "none" }),
      }),
    ]));
    expect(result.offers).toHaveLength(3);
    expect(result.offers?.[0]).toMatchObject({
      providerOptionId: "domestic:standard",
      totalPriceUsd: 120,
      leadTimeBusinessDays: 5,
    });
    expect(result.rawPayload).toMatchObject({
      leadTimeOptions: expect.arrayContaining([
        expect.objectContaining({
          tier: "cost_effective",
          totalPriceUsd: null,
          observedPrice: 95,
          priceBasis: "total",
          currency: null,
          selector: FICTIV_LOCATORS.leadTimeOptionTargets[2].selector,
        }),
      ]),
    });
    expect(result.rawPayload).toMatchObject({
      leadTimeOptions: expect.arrayContaining([
        expect.objectContaining({
          tier: "standard",
          region: "overseas",
          totalPriceUsd: null,
          observedPrice: 45,
          priceBasis: "unit",
        }),
        expect.objectContaining({
          region: "overseas",
          tier: "cost_effective",
          totalPriceUsd: null,
          observedPrice: 10,
          priceBasis: "unknown",
        }),
      ]),
    });
    expect(evaluateProviderAdapterContract({
      definition: {
        provider: "fictiv",
        allowedHosts: ["app.fictiv.com"],
        selectors: { cadUpload: "input[type='file']" },
        requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
      },
      adapterInput: authorizedInput!,
      output: result,
    }).violations).toEqual([]);
  });

  it("withholds a price when every declared price locator misses", async () => {
    const workerTempDir = await makeTempDir();
    let cncSelected = false;
    const page = createFakePage({
      bodyTextSequence: [
        "Select process to continue",
        "Uploading your parts. Active quotes",
        "Analyzing your geometry",
        // No price locator matches below, so the only currency the whole-page
        // scan can find is an unrelated promotional banner.
        "Active quotes Refer a friend and get $50.00 credit Lead time 5 business days",
      ],
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[1]]: {
          count: () => (cncSelected ? 1 : 0),
          setInputFiles: vi.fn(),
        },
        [FICTIV_LOCATORS.processButtons[0]]: {
          count: 1,
          text: () => (cncSelected ? "CNC" : "Process"),
          click: vi.fn(() => {
            cncSelected = true;
          }),
        },
        [FICTIV_LOCATORS.configurationDrawerButtons[0]]: {
          count: 1,
          click: vi.fn(),
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

    expect(result.status).toBe("manual_review_pending");
    expect(result.totalPriceUsd).toBeNull();
    expect(result.unitPriceUsd).toBeNull();
    expect(result.leadTimeBusinessDays).toBeNull();
    expect(result.rawPayload).toMatchObject({
      priceSource: "body_text",
      priceTrusted: false,
      priceGateReason: "unanchored_price",
      locatorDriftDetected: true,
      unanchoredPriceObservedUsd: 50,
    });
  });

  it("retains a selected priced option without promoting a unit price from another field", async () => {
    const page = createFakePage({
      bodyText: "Active quotes Total price USD $120.00 Lead time 5 business days",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
        [FICTIV_LOCATORS.endUseButtons[0]]: { count: 1, text: "Prototype" },
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
        [FICTIV_LOCATORS.materialButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.finishButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "Total USD $120.00" },
        [FICTIV_LOCATORS.leadTimeText[0]]: { count: 1, text: "5 business days" },
        [FICTIV_LOCATORS.leadTimeOptionTargets[0].selector]: {
          count: 1,
          text: "Domestic fastest 3 days Total USD $150.00",
        },
        [FICTIV_LOCATORS.leadTimeOptionTargets[1].selector]: {
          count: 1,
          text: "Domestic standard Price per part USD $45.00\nTotal lead time: 7 days",
        },
      },
      optionTexts: ["CNC", "6061", "Type II", "Prototype"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    const result = await adapter.quote(makeInput());
    expect(result.offers).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerOptionId: "domestic:fastest", totalPriceUsd: 150 }),
      expect.objectContaining({ providerOptionId: "selected-option", totalPriceUsd: 120 }),
    ]));
    expect(result.offers).toHaveLength(2);
    expect(result.offers?.[0]).toMatchObject({
      providerOptionId: "selected-option",
      totalPriceUsd: 120,
      leadTimeBusinessDays: 5,
    });
    expect(result.rawPayload).toMatchObject({
      leadTimeOptions: expect.arrayContaining([
        expect.objectContaining({
          tier: "standard",
          totalPriceUsd: null,
          priceBasis: "unknown",
        }),
      ]),
    });
  });

  it("does not combine selected lead time with another option's generic price", async () => {
    const page = createFakePage({
      bodyText: "Active quotes Total price USD $90.00 Lead time 5 business days",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
        [FICTIV_LOCATORS.endUseButtons[0]]: { count: 1, text: "Prototype" },
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
        [FICTIV_LOCATORS.materialButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.finishButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "$120.00" },
        [FICTIV_LOCATORS.priceText[2]]: { count: 1, text: "Total USD $90.00" },
        [FICTIV_LOCATORS.leadTimeText[0]]: { count: 1, text: "5 business days" },
        [FICTIV_LOCATORS.leadTimeOptionTargets[0].selector]: {
          count: 1,
          text: "Domestic fastest 3 days Total USD $90.00",
        },
      },
      optionTexts: ["CNC", "6061", "Type II", "Prototype"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      payload: { terminalState: "selector_drift" },
    });
  });

  it("rejects an off-origin quote link before returning priced offers", async () => {
    const page = createFakePage({
      bodyText: "Active quotes Total price USD $120.00 Lead time 5 business days",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
        [FICTIV_LOCATORS.endUseButtons[0]]: { count: 1, text: "Prototype" },
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
        [FICTIV_LOCATORS.materialButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.finishButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "Total USD $120.00" },
        [FICTIV_LOCATORS.leadTimeText[0]]: { count: 1, text: "5 business days" },
        [FICTIV_LOCATORS.quoteLinkAnchors[0]]: {
          count: 1,
          href: "https://untrusted.invalid/quotes/other",
        },
      },
      optionTexts: ["CNC", "6061", "Type II", "Prototype"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      payload: { terminalState: "unexpected_origin" },
    });
  });

  it("rejects a selected dollar amount without verified USD currency as a finite failure", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Active quotes Total price $88.00 Lead time 4 business days",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
        [FICTIV_LOCATORS.endUseButtons[0]]: { count: 1, text: "Prototype" },
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
        [FICTIV_LOCATORS.materialButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.finishButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "$88.00" },
        [FICTIV_LOCATORS.leadTimeText[0]]: { count: 1, text: "4 business days" },
      },
      optionTexts: ["CNC", "6061", "Type II", "Prototype"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir }));
    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      payload: {
        terminalState: "selector_drift",
        reason: "price_currency_unverified",
      },
    });
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
    const interactionLog: string[] = [];
    const uploadSpy = vi.fn(() => {
      interactionLog.push(`set-upload-files:${cncSelected ? "cnc" : "no-cnc"}`);
    });
    const page = createFakePage({
      bodyTextSequence: [
        "Upload your parts",
        "Upload your parts",
        "Select process to continue",
        "Uploading your parts",
        "Analyzing your geometry",
        "Active quotes Total price USD $88.00 Lead time 4 business days",
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
            interactionLog.push("select-cnc");
            cncSelected = true;
          }),
        },
        [FICTIV_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: uploadSpy,
        },
        [FICTIV_LOCATORS.priceText[0]]: {
          count: 1,
          text: "Total USD $88.00",
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
      selectedEndUse: "Prototype",
      selectedEndUseSource: "assumed_default",
      uploadSelector: FICTIV_LOCATORS.uploadInputs[0],
      resultClassification: "instant_quote",
    });
    expect(page.visitedUrls[0]).toBe(FICTIV_URLS.upload);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const uploadStepIndex = interactionLog.findIndex((entry) => entry.startsWith("set-upload-files:"));
    expect(uploadStepIndex).toBeGreaterThan(-1);
    expect(interactionLog.indexOf("select-cnc")).toBeLessThan(uploadStepIndex);
    expect(interactionLog[uploadStepIndex]).toBe("set-upload-files:cnc");
  });

  it("treats a plain failure after upload as a possible provider mutation and redacts captured DOM", async () => {
    const workerTempDir = await makeTempDir();
    let uploaded = false;
    const page = createFakePage({
      bodyTextSequence: [
        "Select process to continue jane@customer.example token=fictiv-session-secret",
        "Uploading your parts",
      ],
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: {
          count: 1,
          text: "CNC",
          click: vi.fn(),
        },
        [FICTIV_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(() => {
            uploaded = true;
          }),
        },
      },
      optionTexts: ["CNC"],
    });
    const captureScreenshot = page.screenshot.bind(page);
    page.screenshot = async (options: { path: string }) => {
      if (uploaded) {
        throw new Error("Target page, context or browser has been closed");
      }
      await captureScreenshot(options);
    };
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
      }),
    );
    const phase = createProviderMutationPhase();

    const failure = await runInProviderMutationPhase(phase, () => adapter.quote(makeInput()))
      .catch((error: unknown) => error);

    expect(uploaded).toBe(true);
    expect(failure).toMatchObject({ code: "navigation_failure" });
    // Without the phase the transport-flavored code alone would be retried.
    expect(isRetryableVendorTaskError(failure, createProviderMutationPhase())).toBe(true);
    expect(phase.started).toBe(true);
    expect(isRetryableVendorTaskError(failure, phase)).toBe(false);
    annotateProviderMutationFailure(failure, phase);
    expect(failure).toMatchObject({ payload: { providerMutationPossible: true } });

    const htmlArtifacts = (failure as VendorAutomationError).artifacts
      .filter((artifact) => artifact.kind === "html_snapshot");
    expect(htmlArtifacts.length).toBeGreaterThan(0);
    for (const artifact of htmlArtifacts) {
      const html = await fs.readFile(artifact.localPath, "utf8");
      expect(html).not.toContain("jane@customer.example");
      expect(html).not.toContain("fictiv-session-secret");
      expect((await fs.stat(artifact.localPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("continues quote flow when optional configuration and end-use controls throw", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Active quotes Total price USD $88.00 Lead time 4 business days",
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: {
          count: 1,
          text: "Process",
          click: vi.fn(),
        },
        [FICTIV_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [FICTIV_LOCATORS.configurationDrawerButtons[0]]: {
          count: 1,
          click: vi.fn(() => {
            throw new Error("drawer unavailable");
          }),
        },
        [FICTIV_LOCATORS.endUseButtons[0]]: {
          count: 1,
          click: vi.fn(() => {
            throw new Error("end-use unavailable");
          }),
        },
        [FICTIV_LOCATORS.priceText[0]]: {
          count: 1,
          text: "Total USD $88.00",
        },
        [FICTIV_LOCATORS.leadTimeText[0]]: {
          count: 1,
          text: "4 business days",
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
    expect(result.rawPayload).toMatchObject({
      selectedEndUse: "Prototype",
      selectedEndUseSource: "assumed_default",
      openedConfigurationDrawer: false,
    });
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

  it("maps generic manual review states to manual_review classification", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "RFQ required for this part.",
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
      resultClassification: "manual_review",
    });
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });
});
