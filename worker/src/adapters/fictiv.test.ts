// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
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
  createProviderMutationPhase,
  runInProviderMutationPhase,
} from "../providerMutationPhase";
import { isRetryableVendorTaskError } from "../vendorTaskRetry";
import { ProviderKillSwitchError } from "../providerKillSwitch";
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
  setFilesOnUpload,
} from "./fictiv";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  FICTIV_LOCATORS,
  FICTIV_URLS,
} from "./fictivConstraints";
import { evaluateProviderAdapterContract, evaluateProviderAdapterFailureContract } from "./providerAdapterContract";
import { fictivDispatchAuthorization, fictivDispatchEnvelope } from "../../test-support/fictivDispatchFixture";
import {
  describeFixtureElement,
  FictivFixturePage,
  fixtureText,
  type FixturePageEvent,
} from "../../test-support/fictivFixturePage";

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
    titleBlockApprovalEnabled: false,
    drawingExtractionEnableModelFallback: false,
    drawingExtractionDebugAllowedModels: ["gpt-5.4"],
    ...overrides,
  };
}

const STAGED_CAD_SHA256 = "e".repeat(64);

/**
 * Production-path inputs carry a synthetic Fictiv dispatch authorization bound
 * to the staged bytes and quantity, as the provider preflight would hand over.
 * Live-evaluation inputs and explicit overrides are left untouched.
 */
function makeInput(overrides: Partial<VendorQuoteAdapterInput> = {}): VendorQuoteAdapterInput {
  const input = makeUnauthorizedInput(overrides);
  if (input.executionContext === "live_evaluation" || "providerDispatchAuthorization" in overrides) {
    return input;
  }
  return {
    ...input,
    providerDispatchAuthorization: fictivDispatchAuthorization(fictivDispatchEnvelope({
      cadSha256: input.stagedCadFile?.trustedContentSha256 ?? STAGED_CAD_SHA256,
      drawingSha256: input.stagedDrawingFile?.trustedContentSha256 ?? null,
      requestedQuantity: input.requestedQuantity,
    })),
  };
}

function makeUnauthorizedInput(overrides: Partial<VendorQuoteAdapterInput> = {}): VendorQuoteAdapterInput {
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
      trustedContentSha256: STAGED_CAD_SHA256,
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
  waitFor?: () => Promise<void> | void;
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
      await behavior.waitFor?.();
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

function createFakeBrowser(page: ReturnType<typeof createFakePage> | FictivFixturePage) {
  const context = {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    tracing: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
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
    expect(
      detectBlockingStateSignal({
        text: "Email address\nPassword\nSign in",
        url: "https://app.fictiv.com/signin",
      }),
    ).toBe("login_required");
    expect(
      detectBlockingStateSignal({
        text: "To access advanced quoting, Update your account with a company email address",
        url: "https://app.fictiv.com/pages/quotes/sample-quote",
      }),
    ).toBeNull();
  });
});

describe("FictivAdapter production dispatch authorization (OVD-673)", () => {
  const authorizedFor = (binding: { cadSha256?: string; drawingSha256?: string | null; requestedQuantity?: number }) =>
    fictivDispatchAuthorization(fictivDispatchEnvelope({
      cadSha256: binding.cadSha256 ?? STAGED_CAD_SHA256,
      drawingSha256: binding.drawingSha256 ?? null,
      requestedQuantity: binding.requestedQuantity ?? 2,
    }));
  const stagedDrawing = {
    originalName: "part.pdf",
    localPath: path.resolve(".tmp/part.pdf"),
    storageBucket: "job-files",
    storagePath: "drawings/part.pdf",
    trustedContentSha256: "f".repeat(64),
  };
  const xometryEnvelope = () => {
    const authorization = authorizedFor({});
    return { ...authorization, provider: "xometry" as const };
  };
  const otherRevision = () => {
    const authorization = authorizedFor({});
    return { ...authorization, envelope: { ...authorization.envelope, envelope: { id: "fictiv-quote-envelope", version: 2 } } };
  };
  const expired = () => {
    const authorization = authorizedFor({});
    const past = "2020-01-01T00:00:00.000Z";
    return { ...authorization, expiresAt: past, envelope: { ...authorization.envelope, expiresAt: past } };
  };

  it.each([
    ["missing", () => makeInput({ providerDispatchAuthorization: undefined }), "dispatch_authorization_missing"],
    ["for another provider", () => makeInput({ providerDispatchAuthorization: xometryEnvelope() }), "dispatch_authorization_provider_mismatch"],
    ["for an unreviewed envelope revision", () => makeInput({ providerDispatchAuthorization: otherRevision() }), "dispatch_authorization_envelope_unreviewed"],
    ["expired", () => makeInput({ providerDispatchAuthorization: expired() }), "dispatch_authorization_expired"],
    ["for another quantity", () => makeInput({ providerDispatchAuthorization: authorizedFor({ requestedQuantity: 3 }) }), "dispatch_authorization_quantity_mismatch"],
    ["for other CAD bytes", () => makeInput({ providerDispatchAuthorization: authorizedFor({ cadSha256: "a".repeat(64) }) }), "dispatch_authorization_file_mismatch"],
    [
      "without the staged drawing",
      () => makeInput({ stagedDrawingFile: stagedDrawing, providerDispatchAuthorization: authorizedFor({}) }),
      "dispatch_authorization_file_mismatch",
    ],
    [
      "naming a drawing that is not staged",
      () => makeInput({ providerDispatchAuthorization: authorizedFor({ drawingSha256: "f".repeat(64) }) }),
      "dispatch_authorization_file_mismatch",
    ],
    [
      "against staged bytes without a trusted digest",
      () => makeInput({
        stagedCadFile: { ...makeUnauthorizedInput().stagedCadFile!, trustedContentSha256: undefined },
        providerDispatchAuthorization: authorizedFor({}),
      }),
      "dispatch_authorization_file_mismatch",
    ],
  ])("refuses a production launch with an authorization %s before any browser launch", async (_label, input, reason) => {
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    const failure = await adapter.quote(input()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VendorAutomationError);
    expect(failure).toMatchObject({
      payload: { vendor: "fictiv", reason, terminalState: "unsupported", providerInteractionAttempted: false },
    });
    expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "unsupported" });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("refuses an unauthorized production launch even for requirements it would route to manual follow-up", async () => {
    const adapter = new FictivAdapter("fictiv", makeConfig());
    await expect(adapter.quote(makeInput({
      providerDispatchAuthorization: undefined,
      requirement: { ...makeUnauthorizedInput().requirement, material: "mystery alloy" },
    }))).rejects.toMatchObject({ payload: { reason: "dispatch_authorization_missing" } });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("accepts an authorization bound to both staged files and proceeds to the session", async () => {
    const close = vi.fn();
    launchMock.mockResolvedValue({ newContext: vi.fn().mockRejectedValue(new Error("session unavailable")), close });
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    const failure = await adapter.quote(makeInput({
      stagedDrawingFile: stagedDrawing,
      providerDispatchAuthorization: authorizedFor({ drawingSha256: stagedDrawing.trustedContentSha256 }),
    })).catch((error: unknown) => error);
    expect(launchMock).toHaveBeenCalledOnce();
    expect(failure).not.toMatchObject({ payload: { reason: expect.stringMatching(/^dispatch_authorization_/) } });
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps simulate mode free of any dispatch authorization", async () => {
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerMode: "simulate" }));
    await expect(adapter.quote(makeUnauthorizedInput())).resolves.toMatchObject({ vendor: "fictiv" });
    expect(launchMock).not.toHaveBeenCalled();
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

  it.each([false, true])("captures a live instant quote after CNC/process setup and upload-analysis progression (trace capture: %s)", async (captureTrace) => {
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
    const browser = createFakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
        playwrightCaptureTrace: captureTrace,
      }),
    );

    const result = await adapter.quote(authorizedInput!);

    // OVD-611: a trace may be recorded, but it is never uploaded or left on disk.
    const context = await browser.newContext();
    if (captureTrace) {
      expect(context.tracing.start).toHaveBeenCalledTimes(1);
      expect(context.tracing.stop).toHaveBeenCalledTimes(1);
      expect(context.tracing.stop).toHaveBeenCalledWith();
    } else {
      expect(context.tracing.start).not.toHaveBeenCalled();
    }
    expect(
      result.artifacts.filter(
        (artifact) => artifact.kind === "trace" || artifact.localPath.endsWith("trace.zip"),
      ),
    ).toEqual([]);
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("screenshot");
    const runDir = path.dirname(result.artifacts[0]!.localPath);
    await expect(fs.access(path.join(runDir, "trace.zip"))).rejects.toThrow();

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

  describe("OVD-722 kill switch checkpoints right before each provider mutation", () => {
    type Checkpoint = "before_navigation" | "before_upload" | "before_configure" | "before_save";
    /** A switch the test flips; `engageAfter` engages it right after the first read of that checkpoint passes. */
    const killSwitch = (engageAfter?: Checkpoint) => {
      const state = { engaged: false, reads: [] as Checkpoint[] };
      const providerKillSwitchCheckpoint = async (checkpoint: Checkpoint) => {
        state.reads.push(checkpoint);
        if (state.engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "fictiv", checkpoint);
        if (checkpoint === engageAfter) state.engaged = true;
      };
      return { state, providerKillSwitchCheckpoint };
    };
    const flowPage = (
      spies: { upload?: () => void; process?: () => void; material?: () => void; finish?: () => void },
      extraSelectors: Record<string, LocatorBehavior> = {},
    ) => {
      let cncSelected = false;
      return createFakePage({
        bodyTextSequence: [
          "Select process to continue",
          "Uploading your parts",
          "Analyzing your geometry",
          "Active quotes Total price USD $88.00 Lead time 4 business days",
        ],
        selectorBehaviors: {
          [FICTIV_LOCATORS.processButtons[0]]: {
            count: 1,
            text: () => (cncSelected ? "CNC" : "Process"),
            click: vi.fn(() => {
              spies.process?.();
              cncSelected = true;
            }),
          },
          [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn(() => spies.upload?.()) },
          [FICTIV_LOCATORS.materialButtons[0]]: { count: 1, click: vi.fn(() => spies.material?.()) },
          [FICTIV_LOCATORS.finishButtons[0]]: { count: 1, click: vi.fn(() => spies.finish?.()) },
          [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "Total USD $88.00" },
          [FICTIV_LOCATORS.leadTimeText[0]]: { count: 1, text: "4 business days" },
          [FICTIV_LOCATORS.quoteLinkAnchors[0]]: { count: 1, href: "/quotes/kill-switch" },
          ...extraSelectors,
        },
        optionTexts: ["CNC", "6061-T6", "Type II Anodize Black"],
      });
    };
    const adapterFor = async () => {
      const workerTempDir = await makeTempDir();
      return new FictivAdapter("fictiv", makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
      }));
    };

    it("engaged after the pre upload check while the upload input is polled: setInputFiles never runs", async () => {
      const { providerKillSwitchCheckpoint } = killSwitch("before_upload");
      const upload = vi.fn();
      const page = flowPage({ upload });
      launchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint })).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_upload" });
      expect(upload).not.toHaveBeenCalled();
    });

    it("engaged while a navigation attempt fails: the fallback route is never opened", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const page = flowPage({});
      page.goto = vi.fn(async (url: string) => {
        page.visitedUrls.push(url);
        state.engaged = true;
        throw new Error("net::ERR_CONNECTION_RESET");
      });
      launchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint })).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_navigation" });
      expect(page.visitedUrls).toEqual([FICTIV_URLS.upload]);
    });

    it("engaged after navigation: the pre upload CNC selection is never clicked", async () => {
      const { providerKillSwitchCheckpoint } = killSwitch("before_navigation");
      const process = vi.fn();
      const upload = vi.fn();
      launchMock.mockResolvedValue(createFakeBrowser(flowPage({ process, upload })));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint })).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
      expect(process).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    });

    /** Records which dropdown options get clicked, by the option name the adapter asks for. */
    const trackOptionClicks = (page: ReturnType<typeof flowPage>) => {
      const clicked: string[] = [];
      const getByRole = page.getByRole.bind(page);
      page.getByRole = ((role: string, input: { name?: RegExp }) => {
        const locator = getByRole(role, input);
        const click = locator.click.bind(locator);
        locator.click = async () => {
          clicked.push(String(input.name));
          await click();
        };
        return locator;
      }) as typeof page.getByRole;
      return clicked;
    };
    const runExpectingKillSwitch = async (page: ReturnType<typeof flowPage>, providerKillSwitchCheckpoint: Parameters<typeof makeInput>[0] extends infer T ? NonNullable<T> extends { providerKillSwitchCheckpoint?: infer C } ? C : never : never) => {
      launchMock.mockResolvedValue(createFakeBrowser(page));
      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint })).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
    };

    it("engaged between the quantity fill and Enter: Enter is never pressed", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const press = vi.fn();
      const page = flowPage({}, {
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(() => { state.engaged = true; }), press },
      });

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(press).not.toHaveBeenCalled();
    });

    it("engaged while the material is selected: the material option and the finish are never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const finish = vi.fn();
      const page = flowPage({ material: () => { state.engaged = true; }, finish });
      const clicked = trackOptionClicks(page);

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(clicked.some((name) => /6061/.test(name))).toBe(false);
      expect(finish).not.toHaveBeenCalled();
    });

    it("engaged while the finish dropdown opens: the finish option is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const page = flowPage({ finish: () => { state.engaged = true; } });
      const clicked = trackOptionClicks(page);

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(clicked.some((name) => /Type II|Black/.test(name))).toBe(false);
    });

    it("engaged while the end use dropdown opens: the end use option is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const page = createFakePage({
        bodyText: "Active quotes Total price USD $88.00 Lead time 4 business days",
        selectorBehaviors: {
          [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC", click: vi.fn() },
          [FICTIV_LOCATORS.endUseButtons[0]]: { count: 1, text: "Select", click: vi.fn(() => { state.engaged = true; }) },
        },
        optionTexts: ["CNC", "6061-T6", "Type II Anodize Black", "Prototype"],
      });
      const clicked = trackOptionClicks(page);

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(clicked.some((name) => /Prototype/.test(name))).toBe(false);
    });

    it("engaged while the configuration drawer opens: the CNC radio card is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const radio = vi.fn();
      const page = flowPage({}, {
        [FICTIV_LOCATORS.configurationDrawerButtons[0]]: { count: 1, click: vi.fn(() => { state.engaged = true; }) },
        [FICTIV_LOCATORS.processRadioCards[0]]: { count: 1, text: "CNC Machining", click: radio },
      });

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      // One click is the pre upload selection; none may follow the drawer open.
      expect(radio).toHaveBeenCalledTimes(1);
    });

    it("engaged while the process dropdown opens: the process option is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const page = createFakePage({
        bodyText: "Select process to continue",
        selectorBehaviors: {
          [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "Process", click: vi.fn(() => { state.engaged = true; }) },
        },
        optionTexts: ["CNC"],
      });
      const clicked = trackOptionClicks(page);

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(clicked.some((name) => /CNC/.test(name))).toBe(false);
    });

    it("engaged during the post upload poll: the overlay close click is never made", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const close = vi.fn();
      const page = flowPage({ upload: () => { state.engaged = true; } }, {
        [FICTIV_LOCATORS.modalCloseButtons[0]]: { count: 1, click: close },
      });

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(close).not.toHaveBeenCalled();
    });

    it("engaged between upload analysis and the auto configuration Continue: Continue is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      let uploaded = false;
      const continueClick = vi.fn();
      const page = flowPage({ upload: () => { uploaded = true; state.engaged = true; } }, {
        [FICTIV_LOCATORS.autoConfigModalContinue[0]]: { count: () => (uploaded ? 1 : 0), click: continueClick },
      });

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(continueClick).not.toHaveBeenCalled();
    });

    /** A Continue modal that shows for exactly one visibility check once `show` is called. */
    const oneShotContinue = () => {
      let pending = false;
      const click = vi.fn();
      return {
        show: () => { pending = true; },
        click,
        behavior: {
          count: () => {
            if (!pending) return 0;
            pending = false;
            return 1;
          },
          click,
        } satisfies LocatorBehavior,
      };
    };

    it("engaged after the last configuration checkpoint, before the final blocking state check: the refusal is rethrown", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const modal = oneShotContinue();
      const page = flowPage({}, { [FICTIV_LOCATORS.autoConfigModalContinue[0]]: modal.behavior });
      page.waitForLoadState = vi.fn(async () => {
        state.engaged = true;
        modal.show();
      });

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(modal.click).not.toHaveBeenCalled();
    });

    it("engaged while extractQuoteData waits for the quote: the refusal is rethrown, not swallowed", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const modal = oneShotContinue();
      const page = flowPage({}, {
        [FICTIV_LOCATORS.autoConfigModalContinue[0]]: modal.behavior,
        [[
          '[data-test-target="quote-level-lead-time-price-selected"]',
          '[data-test-target="quote-level-lead-time-selected-option"]',
        ].join(", ")]: {
          waitFor: () => {
            state.engaged = true;
            modal.show();
          },
        },
      });

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(modal.click).not.toHaveBeenCalled();
    });

    it("engaged during the failed radio click wait: the process dropdown fallback is never opened", async () => {
      const { state, providerKillSwitchCheckpoint } = killSwitch();
      const process = vi.fn();
      const page = createFakePage({
        bodyText: "Select process to continue",
        selectorBehaviors: {
          [FICTIV_LOCATORS.processRadioCards[0]]: {
            count: 1,
            text: "CNC Machining",
            click: vi.fn(() => {
              state.engaged = true;
              throw new Error("radio card click timed out");
            }),
          },
          [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "Process", click: process },
        },
        optionTexts: ["CNC"],
      });

      await runExpectingKillSwitch(page, providerKillSwitchCheckpoint);

      expect(process).not.toHaveBeenCalled();
    });
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
    // Screenshots are no longer captured (OVD-611), so fail the post-upload DOM capture instead.
    const captureContent = page.content.bind(page);
    page.content = async () => {
      if (uploaded) {
        throw new Error("Target page, context or browser has been closed");
      }
      return captureContent();
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

  it("treats configuring a landing quote page without an upload as a provider mutation", async () => {
    const workerTempDir = await makeTempDir();
    const upload = vi.fn();
    const fillQuantity = vi.fn();
    const page = createFakePage({
      bodyText: "Active quotes Total price USD $120.00 Lead time 5 business days",
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: upload },
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: fillQuantity, press: vi.fn() },
        [FICTIV_LOCATORS.materialButtons[0]]: {
          count: 1,
          click: vi.fn(() => {
            throw new Error("Target page, context or browser has been closed");
          }),
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
    const phase = createProviderMutationPhase();

    const failure = await runInProviderMutationPhase(phase, () => adapter.quote(makeInput()))
      .catch((error: unknown) => error);

    expect(upload).not.toHaveBeenCalled();
    expect(fillQuantity).toHaveBeenCalledWith("2");
    expect(failure).toMatchObject({ code: "navigation_failure" });
    // Without the phase the transport-flavored code alone would be retried.
    expect(isRetryableVendorTaskError(failure, createProviderMutationPhase())).toBe(true);
    expect(phase.started).toBe(true);
    expect(isRetryableVendorTaskError(failure, phase)).toBe(false);
  });

  it.each([
    { playwrightDisableSandbox: false, chromiumSandbox: true, args: ["--disable-dev-shm-usage"] },
    {
      playwrightDisableSandbox: true,
      chromiumSandbox: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  ])("passes the Chromium sandbox decision explicitly (disable=$playwrightDisableSandbox)", async (
    { playwrightDisableSandbox, chromiumSandbox, args },
  ) => {
    launchMock.mockResolvedValue({
      newContext: vi.fn().mockRejectedValue(new Error("session unavailable")),
      close: vi.fn(),
    });
    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({ workerTempDir: await makeTempDir(), playwrightDisableSandbox }),
    );
    await adapter.quote(makeInput()).catch(() => undefined);
    expect(launchMock).toHaveBeenCalledWith({ headless: true, chromiumSandbox, args });
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

  describe("create-a-quote page states observed live on 2026-10-15", () => {
    const LANDING = "1 Select a process How to configure for multiple processes 2 Upload your parts";
    const UPLOADING = "Create a quote Uploading files (0/0) 0% Creating new quote...";
    const AWAITING_CLASSIFICATION =
      "Please configure all parts and select if these parts are for prototype or commercial use to receive a quote and lead times.";
    const ANALYZING = `Analyzing parts (0/1) 50% 1093-SAMPLE.step Analyzing geometry... ${AWAITING_CLASSIFICATION} Hang tight! Your parts are being analyzed & configured...`;
    const CONFIGURED_FROM_DRAWING = `Parts have been configured based on your drawings! CNC 6061 Aluminum Edit configuration Please request a quote ${AWAITING_CLASSIFICATION}`;

    async function runQuote(bodyTextSequence: string[], extraSelectors: Record<string, LocatorBehavior> = {}) {
      const workerTempDir = await makeTempDir();
      const uploadSpy = vi.fn();
      const page = createFakePage({
        bodyTextSequence,
        selectorBehaviors: {
          [FICTIV_LOCATORS.selectedProcessRadios[0]]: { count: 1, text: "CNC Machining" },
          [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: uploadSpy },
          ...extraSelectors,
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
      return { result, uploadSpy };
    }

    it("waits through upload, analysis, and the transient classification prompt to the priced quote", async () => {
      const { result, uploadSpy } = await runQuote(
        [
          LANDING,
          UPLOADING,
          ANALYZING,
          CONFIGURED_FROM_DRAWING,
          CONFIGURED_FROM_DRAWING,
          CONFIGURED_FROM_DRAWING,
          "Select regional preference Prototype 4 production days (USA or Mexico) $412.30 Fastest",
        ],
        {
          [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "Total USD $412.30" },
          [FICTIV_LOCATORS.leadTimeText[0]]: { count: 1, text: "4 production days (USA or Mexico)" },
          [FICTIV_LOCATORS.quoteLinkAnchors[0]]: { count: 1, href: "/pages/quotes/sample-quote" },
        },
      );

      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("instant_quote_received");
      expect(result.totalPriceUsd).toBe(412.3);
      expect(result.leadTimeBusinessDays).toBe(4);
      expect(result.rawPayload).toMatchObject({ resultClassification: "instant_quote" });
    });

    it("classifies the account-gated instant quote refusal as capability limited instead of timing out", async () => {
      const { result } = await runQuote([
        LANDING,
        UPLOADING,
        ANALYZING,
        CONFIGURED_FROM_DRAWING,
        "Prototype 4 production days (USA or Mexico) $ -- Fastest Summary We\u2019re unable to provide an instant quote based on your current specifications. To access advanced quoting, Update your account with a company email address Request quote",
      ]);

      expect(result.status).toBe("manual_review_pending");
      expect(result.totalPriceUsd).toBeNull();
      expect(result.rawPayload).toMatchObject({
        detectedFlow: "manual_review",
        resultClassification: "capability_limited",
        portalStateSignal: "to access advanced quoting",
      });
    });

    it("returns configuration_required once the unconfigured-part prompt persists", async () => {
      const { result } = await runQuote([
        LANDING,
        UPLOADING,
        ANALYZING,
        "1093-SAMPLE.step Configure Summary Please configure all parts in order to receive a quote and lead time options. Request quote",
      ]);

      expect(result.status).toBe("manual_review_pending");
      expect(result.rawPayload).toMatchObject({
        detectedFlow: "configuration_required",
        resultClassification: "configuration_required",
        portalStateSignal: "configure all parts",
      });
    });
  });

  describe("process-first upload page captured live on 2026-10-23 (OVD-1053)", () => {
    // Structure-only fixture; the capture itself stays local (see the fixture's header).
    const fixtureHtml = () => fs.readFile(
      fileURLToPath(new URL("../../test-support/fixtures/fictiv-process-first-upload.html", import.meta.url)),
      "utf8",
    );
    // The live landing capture was Fictiv's loading shell: the app renders after navigation.
    const LOADING_SHELL = '<html><body><div data-role="react-content"></div><div>loading</div></body></html>';
    const QUOTE_URL = "https://app.fictiv.com/pages/quotes/synthetic-quote";
    // The 2026-10-23 capture ends before the quote page, so the quote page is
    // modeled on the text states recorded live on 2026-10-15 (block above) and
    // the adapter's existing price and lead-time hooks. The Checkout and Place
    // order buttons are guards, not observed structure.
    const AWAITING_CLASSIFICATION =
      "Please configure all parts and select if these parts are for prototype or commercial use to receive a quote and lead times.";
    const GUARD_BUTTONS = '<button type="button">Checkout</button><button type="button">Place order</button>';
    const quotePage = (main: string) => `<html><body><main>${main}${GUARD_BUTTONS}</main></body></html>`;
    const ANALYZING_PAGE = quotePage(
      `<div>Analyzing parts (0/1)</div><div>50%</div><div>synthetic-part.step</div><div>Analyzing geometry...</div><div>${AWAITING_CLASSIFICATION}</div><div>Hang tight! Your parts are being analyzed &amp; configured...</div>`,
    );
    const AWAITING_PAGE = quotePage(
      `<div>Parts have been configured based on your drawings!</div><div>CNC 6061 Aluminum</div><button type="button">Edit configuration</button><div>${AWAITING_CLASSIFICATION}</div>`,
    );
    // Modeled, not observed: the prompt and the configuration control are
    // already shown while Fictiv is still applying the drawing-based auto
    // configuration, which re-renders the quote when it lands.
    const AUTO_CONFIGURING_PAGE = quotePage(
      `<div>CNC</div><button type="button">Edit configuration</button><div>${AWAITING_CLASSIFICATION}</div>`,
    );
    const PRICED_PAGE = quotePage(
      '<div>Select regional preference</div><div>Prototype</div>'
      + '<div data-test-target="quote-level-lead-time-selected-option">Fastest<br>4 production days (USA or Mexico)</div>'
      + '<div data-test-target="quote-level-lead-time-price-selected">Total USD $412.30</div>',
    );
    const UNRECOGNIZED_PAGE = quotePage("<div>synthetic-part.step</div>");

    type Scenario = {
      /** Simulated live cost of one poll beyond its 500 ms wait. */
      pollOverheadMs?: number;
      uploadingMs?: number;
      analyzingMs?: number;
      /** Show the prompt this long after analysis while auto configuration is still pending. */
      autoConfiguringMs?: number;
      /** Reprice this long after the adapter's first configuration click; null never reprices. */
      repriceAfterMs?: number | null;
      /** The page Fictiv shows once analysis ends. */
      afterAnalysisPage?: string;
      failFirstCncClick?: boolean;
    };
    type Stage =
      | "loading" | "upload" | "uploading" | "analyzing" | "auto_configuring" | "awaiting" | "repricing" | "done";
    type ClickRecord = { target: string; stage: Stage; at: number };

    async function runProcessFirstQuote(scenario: Scenario = {}) {
      const workerTempDir = await makeTempDir();
      const clock = { now: 1_800_000_000_000 };
      vi.spyOn(Date, "now").mockImplementation(() => clock.now);
      const events: FixturePageEvent[] = [];
      const html = await fixtureHtml();
      let stage: Stage = "loading";
      let stageEndsAt = Number.POSITIVE_INFINITY;
      let cncClicks = 0;
      let checkedAtUpload: string | null = null;
      let uploadedAt = Number.NaN;
      const clickLog: ClickRecord[] = [];
      /** Polls (and other page waits) that saw the reprice still running. */
      let repricingTicks = 0;

      const page = new FictivFixturePage({
        html: LOADING_SHELL,
        url: "about:blank",
        clock,
        pollOverheadMs: scenario.pollOverheadMs ?? 100,
        events,
        onClick(element, fixturePage) {
          clickLog.push({ target: describeFixtureElement(element), stage, at: clock.now });
          const card = element.closest("label.ant-radio-wrapper")?.getAttribute("data-fixture-process");
          if (card === "cnc") {
            cncClicks += 1;
            if (scenario.failFirstCncClick && cncClicks === 1) {
              throw new Error("element click intercepted");
            }
          }
          if (stage === "upload" && card) {
            // Choosing a process completes step 1 and shows the upload panel.
            const panel = fixturePage.document.querySelector('[data-fixture-panel="upload"]')!;
            if (!panel.querySelector('input[type="file"]')) fixturePage.showTemplate("dropzone", panel);
          }
          if (stage === "awaiting" && scenario.repriceAfterMs !== null) {
            stage = "repricing";
            stageEndsAt = clock.now + (scenario.repriceAfterMs ?? 6_000);
          }
        },
        onSetInputFiles(_element, _files, fixturePage) {
          checkedAtUpload = fixturePage.document
            .querySelector("label.ant-radio-wrapper-checked")
            ?.getAttribute("data-fixture-process") ?? null;
          fixturePage.showTemplate("progress", fixturePage.document.querySelector('[data-fixture-panel="upload"]')!);
          stage = "uploading";
          uploadedAt = clock.now;
          stageEndsAt = clock.now + (scenario.uploadingMs ?? 2_000);
        },
        onTick(fixturePage) {
          if (stage === "loading") {
            fixturePage.render(html);
            stage = "upload";
          } else if (stage === "uploading" && clock.now >= stageEndsAt) {
            fixturePage.render(ANALYZING_PAGE, QUOTE_URL);
            stage = "analyzing";
            stageEndsAt = clock.now + (scenario.analyzingMs ?? 15_000);
          } else if (stage === "analyzing" && clock.now >= stageEndsAt && scenario.autoConfiguringMs) {
            fixturePage.render(AUTO_CONFIGURING_PAGE);
            stage = "auto_configuring";
            stageEndsAt = clock.now + scenario.autoConfiguringMs;
          } else if (
            (stage === "analyzing" || stage === "auto_configuring") && clock.now >= stageEndsAt
          ) {
            // Auto configuration landing re-renders the quote, dropping anything set meanwhile.
            fixturePage.render(scenario.afterAnalysisPage ?? AWAITING_PAGE);
            stage = "awaiting";
          } else if (stage === "repricing" && clock.now >= stageEndsAt) {
            fixturePage.render(PRICED_PAGE);
            stage = "done";
          } else if (stage === "repricing") {
            repricingTicks += 1;
          }
        },
      });
      launchMock.mockResolvedValue(createFakeBrowser(page));
      const providerKillSwitchCheckpoint = async (checkpoint: string) => {
        events.push({ kind: "checkpoint", detail: checkpoint });
      };
      const adapter = new FictivAdapter("fictiv", makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
      }));
      const stagedDrawingFile = {
        originalName: "part.pdf",
        localPath: path.resolve(".tmp/part.pdf"),
        storageBucket: "job-files",
        storagePath: "drawings/part.pdf",
        trustedContentSha256: "f".repeat(64),
      };
      const outcome = await adapter.quote(makeInput({
        requestedQuantity: 1,
        stagedDrawingFile,
        requirement: {
          ...makeUnauthorizedInput().requirement,
          material: "6061-T6 aluminum",
          finish: "as machined",
          quantity: 1,
          quote_quantities: [1],
        },
        providerKillSwitchCheckpoint,
      })).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      return {
        ...outcome,
        events,
        page,
        clickLog,
        checkedAtUpload: () => checkedAtUpload,
        uploadedAt: () => uploadedAt,
        repricingTicks: () => repricingTicks,
      };
    }

    const MUTATIONS = new Set(["click", "set_input_files", "fill", "press"]);
    /** Every provider-side action follows a kill switch read made after the previous action. */
    function expectCheckpointBeforeEveryMutation(events: FixturePageEvent[]) {
      let checkpointSinceLastMutation = false;
      for (const event of events) {
        if (event.kind === "checkpoint") {
          checkpointSinceLastMutation = true;
        } else if (MUTATIONS.has(event.kind)) {
          expect(checkpointSinceLastMutation, `${event.kind} ${event.detail}`).toBe(true);
          checkpointSinceLastMutation = false;
        }
      }
    }
    const clicked = (events: FixturePageEvent[]) =>
      events.filter((event) => event.kind === "click").map((event) => event.detail);

    it("keeps the adapter's process, lock and upload-step hooks pointed at the right elements", async () => {
      const document = new JSDOM(await fixtureHtml(), { url: "https://fixture.invalid/" }).window.document;
      const cards = [...document.querySelectorAll(FICTIV_LOCATORS.processRadioCards[0])];
      expect(cards.filter((card) => /CNC\s*Machining/i.test(fixtureText(card)))
        .map((card) => card.getAttribute("data-fixture-process"))).toEqual(["cnc"]);
      // A process button hook must never resolve inside a process card: the
      // first lock icon sits inside the Urethane Casting card's label.
      for (const selector of FICTIV_LOCATORS.processButtons) {
        let matches: Element[] = [];
        try {
          matches = [...document.querySelectorAll(selector)];
        } catch {
          continue; // Playwright-only syntax; no button carries "Process" here.
        }
        expect(matches.filter((element) => element.closest("label.ant-radio-wrapper")).map(describeFixtureElement), selector)
          .toEqual([]);
      }
      const bodyText = fixtureText(document.body);
      expect(FICTIV_LOCATORS.uploadSurfaceSignals.filter((signal) => signal.test(bodyText)).map((signal) => signal.source))
        .toEqual(["upload your (?:parts|files)", "select (?:a )?process"]);
    });

    it("selects CNC, uploads the STEP and drawing, configures after analysis and returns the priced quote", async () => {
      const { result, error, events, page, checkedAtUpload } = await runProcessFirstQuote();

      // Before OVD-1053 upload, analysis and the 40-poll settle of the
      // configure-all-parts prompt shared the 30 s browser timeout and ran out
      // of time as selector drift (live: 36 s).
      expect(error).toBeNull();
      expect(result).toMatchObject({
        status: "instant_quote_received",
        totalPriceUsd: 412.3,
        leadTimeBusinessDays: 4,
        quoteUrl: QUOTE_URL,
        rawPayload: {
          selectedProcess: "CNC Machining",
          uploadSelector: 'input[type="file"]',
          resultClassification: "instant_quote",
        },
      });
      expect(checkedAtUpload()).toBe("cnc");
      expect(events.filter((event) => event.kind === "set_input_files")).toEqual([
        { kind: "set_input_files", detail: "part.step,part.pdf" },
      ]);
      expect(clicked(events)).toEqual(["process-card:cnc", "button:Edit configuration"]);
      expect(events.slice(0, 2)).toEqual([
        { kind: "checkpoint", detail: "before_navigation" },
        { kind: "goto", detail: FICTIV_URLS.upload },
      ]);
      const uploadIndex = events.findIndex((event) => event.kind === "set_input_files");
      expect(events[uploadIndex - 1]).toEqual({ kind: "checkpoint", detail: "before_upload" });
      expectCheckpointBeforeEveryMutation(events);
      expect(page.visitedUrls).toEqual([FICTIV_URLS.upload]);

      const labels = result!.artifacts.map((artifact) => artifact.label);
      expect(labels).toEqual(["landing-dom", "uploaded-dom", "analysis-complete-dom", "configured-dom", "result-dom"]);
      // The live "uploaded" capture had no file input and "Uploading files (0/0)":
      // it is taken right after the files are set, while Fictiv creates the quote.
      const uploadedHtml = await fs.readFile(result!.artifacts[1].localPath, "utf8");
      expect(uploadedHtml).toContain("Uploading files (0/0)");
      expect(uploadedHtml).toContain("Creating new quote...");
      expect(new JSDOM(uploadedHtml).window.document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    });

    it("waits out a post-upload timeline longer than the 30 s browser timeout before configuring", async () => {
      // 6 s upload and quote creation, 20 s analysis, then the prompt for the
      // full 40-poll settle: about 50 s, which only the post-upload budget fits.
      const { result, error, events, clickLog, uploadedAt } = await runProcessFirstQuote({
        uploadingMs: 6_000,
        analyzingMs: 20_000,
      });

      expect(error).toBeNull();
      expect(result).toMatchObject({
        status: "instant_quote_received",
        totalPriceUsd: 412.3,
        leadTimeBusinessDays: 4,
        rawPayload: { resultClassification: "instant_quote" },
      });
      const configureClick = clickLog.find((click) => click.target === "button:Edit configuration");
      expect(configureClick?.stage).toBe("awaiting");
      expect(configureClick!.at - uploadedAt()).toBeGreaterThan(30_000);
      expect(clicked(events)).toEqual(["process-card:cnc", "button:Edit configuration"]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("does not start configuring while drawing-based auto configuration is still pending", async () => {
      // The prompt shows for about 13 polls before the auto configuration
      // lands: past a short settle, inside the 40-poll one.
      const { result, error, events, clickLog } = await runProcessFirstQuote({ autoConfiguringMs: 8_000 });

      expect(error).toBeNull();
      expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 412.3 });
      expect(clickLog.filter((click) => !click.target.startsWith("process-card:")))
        .toEqual([expect.objectContaining({ target: "button:Edit configuration", stage: "awaiting" })]);
      expect(clickLog.some((click) => click.stage === "auto_configuring")).toBe(false);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("does not report a post-configuration reprice that outlasts the budget as configuration_required", async () => {
      // Slow polls (900 ms) fit about 34 polls in the 30 s post-configuration
      // budget; the reprice outlasts it while staying under the 40-poll settle.
      const { result, error, events, repricingTicks } = await runProcessFirstQuote({
        pollOverheadMs: 400,
        repriceAfterMs: 34_000,
      });

      expect(repricingTicks()).toBeGreaterThan(4);
      expect(repricingTicks()).toBeLessThan(40);
      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          detectedFlow: "configuration_complete",
          reason: "post_configuration_wait_ended_configuration_required",
          url: QUOTE_URL,
        },
      });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("post_configuration-timeout-dom");
      expect(clicked(events)).toEqual(["process-card:cnc", "button:Edit configuration"]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("returns configuration_required when the prompt holds for the full settle after configuration", async () => {
      const { result, error, events } = await runProcessFirstQuote({ repriceAfterMs: null });

      expect(error).toBeNull();
      expect(result).toMatchObject({
        status: "manual_review_pending",
        totalPriceUsd: null,
        offers: [],
        rawPayload: {
          detectedFlow: "configuration_required",
          resultClassification: "configuration_required",
          portalStateSignal: "configure all parts",
        },
      });
      expect(clicked(events)).toEqual(["process-card:cnc", "button:Edit configuration"]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("never clicks a locked process card's lock icon when the CNC card click fails once", async () => {
      const { result, error, events, checkedAtUpload } = await runProcessFirstQuote({ failFirstCncClick: true });

      expect(error).toBeNull();
      expect(result?.status).toBe("instant_quote_received");
      expect(checkedAtUpload()).toBe("cnc");
      expect(clicked(events).filter((target) => target.startsWith("process-card:")))
        .toEqual(["process-card:cnc", "process-card:cnc"]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("keeps the page and a non-sensitive reason when the post-upload wait runs out", async () => {
      const { result, error, events } = await runProcessFirstQuote({ afterAnalysisPage: UNRECOGNIZED_PAGE });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure.message).toBe("Fictiv quote did not reach a terminal state after upload.");
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          detectedFlow: "upload_complete",
          reason: "post_upload_wait_ended_unknown",
          url: QUOTE_URL,
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label))
        .toEqual(["landing-dom", "uploaded-dom", "post_upload-timeout-dom"]);
      expect(await fs.readFile(failure.artifacts[2].localPath, "utf8")).toContain("synthetic-part.step");
      // Nothing is configured on a page no signal recognizes.
      expect(clicked(events)).toEqual(["process-card:cnc"]);
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

  // OVD-611: Verify no screenshots or traces are captured
  it("does not capture screenshots per OVD-611 evidence masking policy", async () => {
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
    
    // Verify no screenshot artifacts
    const screenshotArtifacts = result.artifacts.filter(a => a.kind === "screenshot");
    expect(screenshotArtifacts).toHaveLength(0);
    
    // Verify HTML snapshots are still captured
    const htmlArtifacts = result.artifacts.filter(a => a.kind === "html_snapshot");
    expect(htmlArtifacts.length).toBeGreaterThan(0);
  });

  it("discards the trace instead of writing or uploading it when trace capture is enabled (OVD-611)", async () => {
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
    const browser = createFakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const adapter = new FictivAdapter(
      "fictiv",
      makeConfig({
        workerTempDir,
        fictivStorageStatePath: path.join(workerTempDir, "fictiv-state.json"),
        playwrightCaptureTrace: true,
      }),
    );

    const result = await adapter.quote(makeInput());

    const context = await browser.newContext();
    expect(context.tracing.start).toHaveBeenCalledTimes(1);
    expect(context.tracing.stop).toHaveBeenCalledTimes(1);
    expect(context.tracing.stop).toHaveBeenCalledWith();
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(
      result.artifacts.filter(
        (artifact) => artifact.kind === "trace" || artifact.localPath.endsWith("trace.zip"),
      ),
    ).toEqual([]);
  });
});

describe("setFilesOnUpload export-control gate (OVD-723)", () => {
  function fakeUploadPage(options: { appearsAfterWaits: number }) {
    let waits = 0;
    const setInputFiles = vi.fn(async () => undefined);
    const page = {
      locator: () => ({
        first: () => ({
          count: async () => (waits >= options.appearsAfterWaits ? 1 : 0),
          setInputFiles,
        }),
      }),
      waitForTimeout: vi.fn(async () => {
        waits += 1;
      }),
      url: () => "https://www.fictiv.com/quote",
    };
    return { page, setInputFiles };
  }

  it("asks the gate right before the upload, after the locator wait", async () => {
    const { page, setInputFiles } = fakeUploadPage({ appearsAfterWaits: 2 });
    const order: string[] = [];
    const gate = vi.fn(async () => {
      order.push("gate");
    });
    setInputFiles.mockImplementation(async () => {
      order.push("upload");
    });

    await setFilesOnUpload(page as never, ["/tmp/part.step"], gate);

    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["gate", "upload"]);
  });

  it("stops the upload when a hold lands while the locator loop waits", async () => {
    const { page, setInputFiles } = fakeUploadPage({ appearsAfterWaits: 1 });
    const hold = new Error("export_review_pending");
    const gate = vi.fn(async () => {
      throw hold;
    });

    await expect(setFilesOnUpload(page as never, ["/tmp/part.step"], gate)).rejects.toBe(hold);
    expect(setInputFiles).not.toHaveBeenCalled();
  });
});
