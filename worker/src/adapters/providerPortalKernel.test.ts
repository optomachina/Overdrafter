import { OSHCUT_PORTAL_DISABLED_MESSAGE } from "./oshcutPortalDisabled";
// @vitest-environment node

import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { reportOshcutCartCleanup, OSHCUT_CART_CLEANUP_SELECTORS, OSHCUT_CART_FILE_NAME, OSHCUT_CART_ROW } from "./oshcutCartCleanup";
import { buildOshcutProductionPortalDefinition, OSHCUT_PRODUCTION_LOCATORS } from "./oshcutProductionPortal";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, CDPSession, ElementHandle, Locator, Page } from "playwright";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { supplierCartCleanupFromPayload } from "../tools/liveHarnessSupplierCleanup";
import { OperationalJevSession, OperationalJevObservations, type OperationalJevScope } from "../jev/operationalSession";
import { createProviderMutationPhase, runInProviderMutationPhase } from "../providerMutationPhase";
import { exportControlHoldReason, withExportControlDispatchRecheck } from "../dispatchRouting";
import { ProviderDispatchAuthorizationError } from "../providerDispatchPreflight";
import { ProviderKillSwitchError } from "../providerKillSwitch";
import {
  captureScrubbedProviderEvidence,
  checkSendCutSendCurrentUser,
  PROVIDER_PORTAL_SESSION_CHECK_TIMEOUT_MS,
  buildExpectedProviderPortalApproval,
  classifyPortalBoundaryOutcome,
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  normalizeAnchoredProviderOffers,
  parseProviderPortalApprovalDescriptor,
  resolveIsolatedProviderStorageState,
  runIntentionalPortalRetry,
  runProviderPortalKernel,
  scrubProviderEvidenceText,
  type ProviderPortalDefinition,
  type ProviderPortalOfferCandidate,
  type RunProviderPortalKernelDependencies,
} from "./providerPortalKernel";

import { buildSendCutSendSheetPortalDefinition, SENDCUTSEND_SHEET_LOCATORS } from "./sendcutsendPortal";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function config(storageStateJson: string | null = JSON.stringify({ cookies: [], origins: [] })): WorkerConfig {
  return {
    workerMode: "live",
    workerTempDir: os.tmpdir(),
    browserTimeoutMs: 100,
    playwrightHeadless: true,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: false,
    vendorStorageStateJson: storageStateJson ? { quickparts: storageStateJson } : {},
    vendorStorageStatePaths: {},
    vendorStorageStateDir: null,
  } as WorkerConfig;
}

function candidate(overrides: Partial<ProviderPortalOfferCandidate> = {}): ProviderPortalOfferCandidate {
  return {
    providerOptionId: "economy-7d",
    providerLabel: "Economy",
    quoteRef: "QP-123",
    quoteUrl: "https://quickquote.quickparts.com/quotes/QP-123",
    quantity: 5,
    unitPriceUsd: { value: 20, source: "selector", selector: "[data-unit-price]" },
    totalPriceUsd: { value: 100, source: "selector", selector: "[data-total-price]" },
    leadTimeBusinessDays: { value: 7, source: "selector", selector: "[data-lead-days]" },
    shipReceiveBy: null,
    tier: "economy",
    sourcing: null,
    geographicOrigin: null,
    geographicOriginSource: "none",
    containerSelector: "[data-option-id='economy-7d']",
    providerOptionIdSource: "attribute",
    validUntil: null,
    validityDurationDays: null,
    validitySource: null,
    validityTerms: null,
    rawPayload: { anchor: "quote-card" },
    ...overrides,
  };
}

function definition(
  overrides: Partial<ProviderPortalDefinition> = {},
): ProviderPortalDefinition {
  return {
    provider: "quickparts",
    displayName: "Quickparts",
    manifestRevision: "quickparts-manifest.v1",
    envelopeRevision: "quickparts-envelope.v1",
    adapterRevision: "quickparts-adapter.v1",
    accountMode: "company_controlled",
    routes: {
      publicUrl: "https://quickparts.com/",
      loginUrl: "https://quickquote.quickparts.com/#/login",
      uploadUrl: "https://quickquote.quickparts.com/",
    },
    allowedHosts: ["quickparts.com", "quickquote.quickparts.com"],
    selectors: {
      cadUpload: "input[type='file']",
      quantity: "input[name='quantity']",
    },
    supportedFileExtensions: ["step", "stp"],
    terminalSignals: {
      login: [/login/i],
      captcha: [/captcha/i],
      manualReview: [/manual review/i],
      configurationRequired: [/select material/i],
      unavailable: [/unavailable/i],
    },
    requirements: {
      quoteOnly: true,
      orderProhibited: true,
      isolatedSession: true,
    },
    hooks: {
      assessEligibility: () => ({ state: "eligible", reason: "eligible" }),
      configure: () => undefined,
      classifyPortalState: (snapshot) => classifyProviderPortalSnapshot(snapshot),
      extractOffers: () => [candidate()],
    },
    ...overrides,
  };
}

async function input(extension = "step"): Promise<VendorQuoteAdapterInput> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-kernel-test-"));
  tempDirs.push(tempDir);
  const cadPath = path.join(tempDir, `part.${extension}`);
  await fs.writeFile(cadPath, "authorized-cad-bytes");
  const digest = await sha256File(cadPath);
  const rawInput = {
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: {
      nonExportControlled: true,
      cadFileSha256: digest,
      drawingFileSha256: null,
    },
    providerPortalExecutionScope: {
      cadPath,
      drawingPath: null,
      requestedQuantities: [5],
    },
    organizationId: "org-1",
    quoteRunId: "run-1",
    part: { id: "part-1", quantity: 5 },
    stagedCadFile: {
      originalName: `part.${extension}`,
      localPath: cadPath,
      trustedContentSha256: digest,
    },
    stagedDrawingFile: null,
    requestedQuantity: 5,
    requirement: { quantity: 5, material: "6061 aluminum" },
  } as VendorQuoteAdapterInput;
  const authorized = await authorizeLiveEvaluationInput(rawInput);
  if (!authorized) {
    throw new Error("test fixture authorization failed");
  }
  authorized.providerPortalApproval = buildExpectedProviderPortalApproval(
    definition(),
    authorized,
  )!;
  return authorized;
}

type FakeRequest = {
  url: string;
  headers?: Record<string, string>;
  body?: string;
  navigation?: boolean;
  resourceType?: string;
  headersUnavailable?: boolean;
};

function fakeRoute(spec: FakeRequest, mainFrame: { parentFrame: () => null }) {
  return {
    request: () => ({
      url: () => spec.url,
      isNavigationRequest: () => spec.navigation === true,
      frame: () => mainFrame,
      allHeaders: async () => {
        if (spec.headersUnavailable) throw new Error("target closed");
        return spec.headers ?? {};
      },
      postDataBuffer: () => (spec.body === undefined ? null : Buffer.from(spec.body)),
      resourceType: () => spec.resourceType ?? (spec.navigation ? "document" : "fetch"),
    }),
    abort: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined),
  };
}

function fakeBrowser(options: {
  redirectedUrl?: string;
  bodyText?: string;
  uploadCount?: number;
  missingSelector?: string;
  missingSelectors?: string[];
  uploadFailure?: Error;
  popupDuringRead?: boolean;
  navigateDuringRead?: string;
  popupDuringCountAt?: number;
  navigateDuringCountAt?: number;
  requestDuringUpload?: string | FakeRequest;
  requestsDuringUpload?: FakeRequest[];
  webSocketDuringUpload?: string;
  navigateDuringFill?: string[];
  fillFailure?: Error;
} = {}) {
  let currentUrl = "about:blank";
  const pageListeners = new Map<string, Array<(value: unknown) => void>>();
  const contextListeners = new Map<string, Array<(value: unknown) => void>>();
  const emit = (listeners: Map<string, Array<(value: unknown) => void>>, event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(value);
    }
  };
  let requestRouteHandler: ((route: ReturnType<typeof fakeRoute>) => Promise<void>) | null = null;
  let webSocketRouteHandler: ((route: {
    url: () => string;
    close: (options: { code: number; reason: string }) => Promise<void>;
    connectToServer: () => unknown;
  }) => Promise<void>) | null = null;
  const frameForRequests = { parentFrame: () => null };
  const single = typeof options.requestDuringUpload === "string"
    ? { url: options.requestDuringUpload }
    : options.requestDuringUpload;
  const requestSpecs = options.requestsDuringUpload ?? (single ? [single] : []);
  const requestRoutes = requestSpecs.map((spec) => fakeRoute(spec, frameForRequests));
  const requestRoute = requestRoutes[0] ?? fakeRoute({ url: "https://quickquote.quickparts.com/upload" }, frameForRequests);
  const webSocketRoute = {
    url: () => options.webSocketDuringUpload ?? "wss://quickquote.quickparts.com/socket",
    close: vi.fn(async () => undefined),
    connectToServer: vi.fn(() => undefined),
  };
  const setInputFiles = vi.fn(async () => {
    if (options.uploadFailure) {
      throw options.uploadFailure;
    }
    for (const route of requestRoutes) {
      await requestRouteHandler?.(route);
    }
    if (options.webSocketDuringUpload && webSocketRouteHandler) {
      await webSocketRouteHandler(webSocketRoute);
    }
  });
  const fill = vi.fn(async () => {
    for (const url of options.navigateDuringFill ?? []) {
      currentUrl = url;
      emit(pageListeners, "framenavigated", mainFrame);
    }
    if (options.fillFailure) {
      throw options.fillFailure;
    }
  });
  const selectOption = vi.fn(async () => undefined);
  const click = vi.fn(async () => undefined);
  const filter = vi.fn();
  const popup = {
    url: vi.fn(() => "https://malicious.example/popup"),
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  const triggerReadBoundaryChange = () => {
    if (options.navigateDuringRead) {
      currentUrl = options.navigateDuringRead;
    }
    if (options.popupDuringRead) {
      emit(pageListeners, "popup", popup);
      emit(contextListeners, "page", popup);
    }
  };
  let mutationLocatorCountCalls = 0;
  const bodyLocator = {
    innerText: vi.fn(async () => options.bodyText ?? "quote portal"),
  };
  const passwordLocator = { count: vi.fn(async () => 0) };
  const uploadLocator = {
    first: () => uploadLocator,
    count: vi.fn(async () => {
      mutationLocatorCountCalls += 1;
      if (options.navigateDuringCountAt === mutationLocatorCountCalls) {
        currentUrl = "https://malicious.example/count-navigation";
      }
      if (options.popupDuringCountAt === mutationLocatorCountCalls) {
        emit(pageListeners, "popup", popup);
        emit(contextListeners, "page", popup);
      }
      return options.uploadCount ?? 1;
    }),
    setInputFiles,
    fill,
    selectOption,
    click,
    filter,
    locator: vi.fn(),
    allInnerTexts: vi.fn(async () => {
      triggerReadBoundaryChange();
      return ["offer"];
    }),
    innerText: vi.fn(async () => {
      triggerReadBoundaryChange();
      return "offer";
    }),
    getAttribute: vi.fn(async () => {
      triggerReadBoundaryChange();
      return "offer-id";
    }),
  };
  const cleanupNode = { isConnected: true };
  const cleanupRow = {
    evaluate: async (fn: (node: object, selected: object[]) => unknown, selected: object[]) =>
      fn(cleanupNode, selected.map(() => cleanupNode)),
    $$: async () => [{ click, evaluate: async () => true }],
  };
  const cleanupLocator = {
    ...uploadLocator,
    elementHandles: async () => [cleanupRow],
    filter: (options: unknown) => { filter(options); return cleanupLocator; },
  };
  filter.mockImplementation(() => uploadLocator);
  (uploadLocator.locator as ReturnType<typeof vi.fn>).mockImplementation(() => uploadLocator);
  const mainFrame = { url: vi.fn(() => currentUrl) };
  const page = {
    addInitScript: vi.fn(async () => undefined),
    goto: vi.fn(async (url: string) => {
      currentUrl = options.redirectedUrl ?? url;
      return null;
    }),
    url: vi.fn(() => currentUrl),
    locator: vi.fn((selector: string) => {
      if (selector === options.missingSelector || options.missingSelectors?.includes(selector)) return { first: () => ({ count: async () => 0 }) } as unknown as Locator;
      if (selector === ".row") return cleanupLocator as unknown as Locator;
      if (selector === "body") {
        return bodyLocator as unknown as Locator;
      }
      if (selector === "input[type='password']") {
        return passwordLocator as unknown as Locator;
      }
      return uploadLocator as unknown as Locator;
    }),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    mainFrame: vi.fn(() => mainFrame),
    frames: vi.fn(() => [mainFrame]),
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      pageListeners.set(event, [...(pageListeners.get(event) ?? []), listener]);
      return page;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  const context = {
    newCDPSession: vi.fn(async () => ({ send: async () => ({ root: {} }), detach: async () => undefined })),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    newPage: vi.fn(async () => page),
    route: vi.fn(async (_pattern: string, handler: typeof requestRouteHandler) => {
      requestRouteHandler = handler;
    }),
    routeWebSocket: vi.fn(async (_pattern: string, handler: typeof webSocketRouteHandler) => {
      webSocketRouteHandler = handler;
    }),
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      contextListeners.set(event, [...(contextListeners.get(event) ?? []), listener]);
      return context;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  return {
    browser,
    context,
    page,
    popup,
    requestRoute,
    requestRoutes,
    webSocketRoute,
    setInputFiles,
    fill,
    selectOption,
    click,
    filter,
  };
}

describe("provider portal kernel admission", () => {
  // OVD-723 review round 4: the export-control gate is asked again after
  // navigation and classification, right before the first upload.
  it("holds the lane when the export-control gate flips during navigation", async () => {
    let denied = false;
    const rpc = vi.fn(async () => ({
      data: denied ? { allowed: false, reasonCode: "export_review_pending" } : { allowed: true },
      error: null,
    }));
    const fake = fakeBrowser();
    const goto = fake.page.goto as unknown as ReturnType<typeof vi.fn>;
    const originalGoto = goto.getMockImplementation()!;
    goto.mockImplementation(async (url: string) => {
      denied = true;
      return originalGoto(url);
    });
    const adapter = {
      quote: (quoteInput: VendorQuoteAdapterInput) => runProviderPortalKernel(definition(), config(), quoteInput, {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      }) as never,
    };
    const wrapped = withExportControlDispatchRecheck(adapter, { rpc } as never, { taskId: "task-1", vendor: "quickparts" });

    const error = await wrapped.quote(await input()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderDispatchAuthorizationError);
    expect(exportControlHoldReason(error)).toBe("export_review_pending");
    expect(goto).toHaveBeenCalled();
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  // OVD-723 review round 5: the drawing is a separate disclosure, so the gate
  // is asked again right before the drawing upload (as in Xometry).
  it("asks the export-control gate again before the drawing upload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-kernel-drawing-"));
    tempDirs.push(tempDir);
    const cadPath = path.join(tempDir, "part.step");
    const drawingPath = path.join(tempDir, "part.pdf");
    await fs.writeFile(cadPath, "authorized-cad-bytes");
    await fs.writeFile(drawingPath, "authorized-drawing-bytes");
    const [cadDigest, drawingDigest] = await Promise.all([sha256File(cadPath), sha256File(drawingPath)]);
    const withDrawing = definition({
      selectors: { cadUpload: "input.cad", drawingUpload: "input.drawing", quantity: "input[name='quantity']" },
    });
    const authorized = (await authorizeLiveEvaluationInput({
      executionContext: "live_evaluation",
      liveEvaluationAuthorization: {
        nonExportControlled: true,
        cadFileSha256: cadDigest,
        drawingFileSha256: drawingDigest,
      },
      providerPortalExecutionScope: { cadPath, drawingPath, requestedQuantities: [5] },
      organizationId: "org-1",
      quoteRunId: "run-1",
      part: { id: "part-1", quantity: 5 },
      stagedCadFile: { originalName: "part.step", localPath: cadPath, trustedContentSha256: cadDigest },
      stagedDrawingFile: { originalName: "part.pdf", localPath: drawingPath, trustedContentSha256: drawingDigest },
      requestedQuantity: 5,
      requirement: { quantity: 5, material: "6061 aluminum" },
    } as VendorQuoteAdapterInput))!;
    authorized.providerPortalApproval = buildExpectedProviderPortalApproval(withDrawing, authorized)!;
    const hold = new ProviderDispatchAuthorizationError("export_review_pending");
    let gateCalls = 0;
    authorized.beforeProviderDisclosure = vi.fn(async () => {
      gateCalls += 1;
      if (gateCalls > 1) throw hold;
    });
    const fake = fakeBrowser();

    const error = await runProviderPortalKernel(withDrawing, config(), authorized, {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    }).catch((caught: unknown) => caught);

    expect(error).toBe(hold);
    expect(gateCalls).toBe(2);
    expect(fake.setInputFiles).toHaveBeenCalledTimes(1);
  });

  it("does not launch without internally captured exact-file authorization", async () => {
    const launchBrowser = vi.fn();
    const unauthorized = { ...(await input()) } as VendorQuoteAdapterInput;

    await expect(runProviderPortalKernel(
      definition(),
      config(),
      unauthorized,
      { launchBrowser },
    )).rejects.toMatchObject({
      payload: { terminalState: "unsupported", providerInteractionAttempted: false },
    });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("checks exact-file authorization before eligibility hooks or session access", async () => {
    const assessEligibility = vi.fn();
    const unauthorized = { ...(await input()) } as VendorQuoteAdapterInput;
    let sessionAccessed = false;
    const guardedConfig = config();
    Object.defineProperty(guardedConfig, "vendorStorageStateJson", {
      get: () => {
        sessionAccessed = true;
        return { quickparts: JSON.stringify({ cookies: [], origins: [] }) };
      },
    });

    await expect(runProviderPortalKernel(
      definition({ hooks: { ...definition().hooks, assessEligibility } }),
      guardedConfig,
      unauthorized,
    )).rejects.toMatchObject({ payload: { reason: "exact_file_authorization_missing" } });
    expect(assessEligibility).not.toHaveBeenCalled();
    expect(sessionAccessed).toBe(false);
  });

  it.each([
    ["digest", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.cadFileSha256 = "f".repeat(64);
    }],
    ["account", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.accountMode = "personal";
    }],
    ["origin", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.allowedOrigins = ["https://malicious.example"];
    }],
    ["action", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.intendedAction = "place_order" as "quote_only";
    }],
    ["artifact scope", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.artifactScope = ["cad_upload"];
    }],
    ["CAD path", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.cadPath = path.join(path.dirname(approval.cadPath), "same-bytes-other-name.step");
    }],
    ["drawing path", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.drawingPath = path.join(path.dirname(approval.cadPath), "drawing.pdf");
    }],
    ["quantities", (approval: NonNullable<VendorQuoteAdapterInput["providerPortalApproval"]>) => {
      approval.requestedQuantities = [10, 5];
    }],
  ])("rejects changed approval %s before eligibility, session, or browser work", async (_label, mutate) => {
    const authorized = await input();
    mutate(authorized.providerPortalApproval!);
    const assessEligibility = vi.fn();
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(
      definition({ hooks: { ...definition().hooks, assessEligibility } }),
      config(),
      authorized,
      { launchBrowser },
    )).rejects.toMatchObject({
      payload: {
        reason: "exact_provider_approval_mismatch",
        providerInteractionAttempted: false,
      },
    });
    expect(assessEligibility).not.toHaveBeenCalled();
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("rejects hash-shaped objects instead of stringifying them into approval digests", async () => {
    const authorized = await input();
    const approval = authorized.providerPortalApproval!;
    const hashShapedObject = { toString: () => "f".repeat(64) };

    expect(parseProviderPortalApprovalDescriptor({
      ...approval,
      cadFileSha256: hashShapedObject,
    })).toBeNull();
    expect(parseProviderPortalApprovalDescriptor({
      ...approval,
      drawingFileSha256: hashShapedObject,
    })).toBeNull();
  });

  it("rejects a missing approval before eligibility, session, or browser work", async () => {
    const authorized = await input();
    delete authorized.providerPortalApproval;
    const assessEligibility = vi.fn();
    const launchBrowser = vi.fn();
    let sessionAccessed = false;
    const guardedConfig = config();
    Object.defineProperty(guardedConfig, "vendorStorageStateJson", {
      get: () => {
        sessionAccessed = true;
        return { quickparts: JSON.stringify({ cookies: [], origins: [] }) };
      },
    });

    await expect(runProviderPortalKernel(
      definition({ hooks: { ...definition().hooks, assessEligibility } }),
      guardedConfig,
      authorized,
      { launchBrowser },
    )).rejects.toMatchObject({
      payload: {
        reason: "exact_provider_approval_mismatch",
        providerInteractionAttempted: false,
      },
    });
    expect(assessEligibility).not.toHaveBeenCalled();
    expect(sessionAccessed).toBe(false);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("rejects out-of-envelope files and packages before session resolution or launch", async () => {
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input("stl"),
      { launchBrowser },
    )).rejects.toMatchObject({ payload: { reason: "cad_file_type_outside_envelope" } });
    expect(launchBrowser).not.toHaveBeenCalled();

    const result = await runProviderPortalKernel(
      definition({
        hooks: {
          ...definition().hooks,
          assessEligibility: () => ({ state: "unsupported", reason: "material_outside_envelope" }),
        },
      }),
      config(),
      await input(),
      { launchBrowser },
    );
    expect(result).toMatchObject({ state: "unsupported", reason: "material_outside_envelope" });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("fails closed on a missing or malformed isolated session before launch", async () => {
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(
      definition(),
      config(null),
      await input(),
      { launchBrowser },
    )).rejects.toMatchObject({
      code: "login_required",
      payload: { terminalState: "missing_session", providerInteractionAttempted: false },
    });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("allows only exact HTTPS hosts and stops before upload after an unexpected redirect", async () => {
    expect(isAllowedProviderUrl("https://quickquote.quickparts.com/quote", ["quickquote.quickparts.com"])).toBe(true);
    expect(isAllowedProviderUrl("https://evil.quickquote.quickparts.com/", ["quickquote.quickparts.com"])).toBe(false);
    expect(isAllowedProviderUrl("http://quickquote.quickparts.com/", ["quickquote.quickparts.com"])).toBe(false);

    const fake = fakeBrowser({ redirectedUrl: "https://malicious.example/collect" });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).rejects.toMatchObject({
      payload: { terminalState: "unexpected_origin", providerMutationPossible: false },
    });
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(fake.context.close).toHaveBeenCalledOnce();
    expect(fake.browser.close).toHaveBeenCalledOnce();
  });

  it("blocks an upload request to an origin outside the exact approval boundary", async () => {
    const fake = fakeBrowser({ requestDuringUpload: {
      url: "https://malicious.example/collect",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"part.step\"\r\n\r\nauthorized-cad-bytes\r\n--x--",
    } });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).rejects.toMatchObject({
      payload: {
        terminalState: "unexpected_origin",
        providerMutationPossible: true,
      },
    });
    expect(fake.requestRoute.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(fake.requestRoute.continue).not.toHaveBeenCalled();
  });

  it("allows only reviewed-host requests and blocks service workers", async () => {
    const fake = fakeBrowser({ requestDuringUpload: "https://quickquote.quickparts.com/upload" });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).resolves.toMatchObject({ state: "offers_extracted", portalBoundary: { blockedOffhostCount: 0 } });
    expect(fake.requestRoute.continue).toHaveBeenCalledOnce();
    expect(fake.requestRoute.abort).not.toHaveBeenCalled();
    expect(fake.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      serviceWorkers: "block",
    }));
  });

  // OVD-773: real provider pages always load telemetry. Off-host page
  // subresources are blocked so nothing leaves, but the run is not failed.
  it("quietly blocks a Datadog CSP report and completes the run", async () => {
    const fake = fakeBrowser({ requestDuringUpload: {
      url: "https://csp-report.browser-intake-datadoghq.com/api/v2/logs?dd-api-key=pub123&ddsource=csp-report",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "blocked-uri": "inline", "document-uri": "https://quickquote.quickparts.com/" } }),
      resourceType: "csp_report",
    } });
    const captureEvidence = vi.fn(async () => []);
    const result = await runProviderPortalKernel(definition(), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence,
    });
    expect(result).toMatchObject({
      state: "offers_extracted",
      portalBoundary: {
        blockedOffhostCount: 1,
        blockedOffhostByHost: { "csp-report.browser-intake-datadoghq.com": 1 },
        blockedOffhostEvents: [{
          event: "boundary.blocked_offhost",
          host: "csp-report.browser-intake-datadoghq.com",
          resourceType: "csp_report",
        }],
      },
    });
    expect(fake.requestRoute.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(fake.requestRoute.continue).not.toHaveBeenCalled();
    // Host and resource type only: no path, query string, or API key.
    expect(JSON.stringify(result.portalBoundary)).not.toMatch(/dd-api-key|pub123|\/api\/v2/);
    expect(captureEvidence).toHaveBeenCalledWith(expect.anything(), expect.anything(), "offers_extracted",
      expect.anything(), expect.objectContaining({ blockedOffhostCount: 1 }));
  });

  it("quietly blocks analytics, font, and CDN subresources without a violation", async () => {
    const fake = fakeBrowser({ requestsDuringUpload: [
      { url: "https://www.googletagmanager.com/gtag/js?id=G-1", resourceType: "script" },
      { url: "https://fonts.gstatic.com/s/inter/v1.woff2", resourceType: "font" },
      { url: "https://fonts.gstatic.com/s/inter/v2.woff2", resourceType: "font" },
      { url: "https://www.google-analytics.com/g/collect?v=2", resourceType: "image" },
    ] });
    const result = await runProviderPortalKernel(definition(), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    });
    expect(result).toMatchObject({
      state: "offers_extracted",
      portalBoundary: {
        blockedOffhostCount: 4,
        blockedOffhostByHost: {
          "www.googletagmanager.com": 1,
          "fonts.gstatic.com": 2,
          "www.google-analytics.com": 1,
        },
      },
    });
    for (const route of fake.requestRoutes) {
      expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
      expect(route.continue).not.toHaveBeenCalled();
    }
  });

  it("treats an off-host main-frame navigation as a violation", async () => {
    const fake = fakeBrowser({ requestDuringUpload: {
      url: "https://malicious.example/landing",
      navigation: true,
    } });
    await expect(runProviderPortalKernel(definition(), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    })).rejects.toMatchObject({
      payload: {
        terminalState: "unexpected_origin",
        reason: "unexpected_navigation:malicious.example",
        portalBoundary: { blockedOffhostCount: 0 },
      },
    });
    expect(fake.requestRoute.abort).toHaveBeenCalledWith("blockedbyclient");
  });

  it("reports the first off-host navigation when a later step times out on the blocked error page", async () => {
    // The browser race behind the off-host fixture flake: the page navigates
    // off-host mid-fill, the blocked navigation commits Chromium's error page,
    // and the fill then times out with a plain Playwright error.
    const fake = fakeBrowser();
    const frame = fake.page.mainFrame();
    let frameUrl: string | null = null;
    vi.mocked(frame.url).mockImplementation(() => frameUrl ?? fake.page.url());
    const navigateMainFrame = (url: string) => {
      frameUrl = url;
      const calls = vi.mocked(fake.page.on).mock.calls as unknown as Array<[string, (value: unknown) => void]>;
      for (const [event, listener] of calls) if (event === "framenavigated") listener(frame);
    };
    fake.fill.mockImplementationOnce(async () => {
      navigateMainFrame("https://login.example-sso.com/authorize");
      navigateMainFrame("chrome-error://chromewebdata/");
      throw new Error("locator.fill: Timeout 5000ms exceeded.");
    });
    await expect(runProviderPortalKernel(definition(), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    })).rejects.toMatchObject({
      payload: {
        terminalState: "unexpected_origin",
        reason: "unexpected_navigation:login.example-sso.com",
        providerMutationPossible: true,
      },
    });
    expect(fake.fill).toHaveBeenCalledOnce();
  });

  it.each([
    ["a form POST body", { "content-type": "application/x-www-form-urlencoded" }, "quantity=5&material=6061"],
    ["a JSON body", { "content-type": "application/json" }, "{\"quantity\":5}"],
    ["a text/plain beacon", { "content-type": "text/plain" }, "authorized-cad-bytes"],
    ["an oversized CSP report", { "content-type": "application/csp-report" }, "x".repeat(64 * 1024 + 1)],
    ["an Authorization header", { authorization: "Bearer token" }, undefined],
    ["a Cookie header", { cookie: "session=1" }, undefined],
  ])("treats an off-host request carrying %s as a violation", async (_label, headers, body) => {
    const fake = fakeBrowser({ requestDuringUpload: { url: "https://collector.example/ingest", headers, body } });
    await expect(runProviderPortalKernel(definition(), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    })).rejects.toMatchObject({
      payload: { terminalState: "unexpected_origin", reason: "unexpected_request:collector.example" },
    });
    expect(fake.requestRoute.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(fake.requestRoute.continue).not.toHaveBeenCalled();
  });

  it("fails closed when an off-host request cannot be classified", async () => {
    const fake = fakeBrowser({ requestDuringUpload: { url: "https://collector.example/x", headersUnavailable: true } });
    await expect(runProviderPortalKernel(definition(), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    })).rejects.toMatchObject({ payload: { reason: "unexpected_request:collector.example" } });
    expect(fake.requestRoute.abort).toHaveBeenCalledWith("blockedbyclient");
  });

  it("continues subresource GETs to an allowlisted off-host host but keeps payloads to it a violation", async () => {
    const allowlisted = definition({ offHostAllowlist: ["cdn.jsdelivr.net"] });
    const passes = fakeBrowser({ requestDuringUpload: {
      url: "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      resourceType: "script",
    } });
    await expect(runProviderPortalKernel(allowlisted, config(), await input(), {
      launchBrowser: vi.fn(async () => passes.browser),
      captureEvidence: async () => [],
    })).resolves.toMatchObject({ state: "offers_extracted", portalBoundary: { blockedOffhostCount: 0 } });
    expect(passes.requestRoute.continue).toHaveBeenCalledOnce();
    expect(passes.requestRoute.abort).not.toHaveBeenCalled();

    const payload = fakeBrowser({ requestDuringUpload: {
      url: "https://cdn.jsdelivr.net/upload",
      headers: { "content-type": "application/octet-stream" },
      body: "authorized-cad-bytes",
    } });
    await expect(runProviderPortalKernel(allowlisted, config(), await input(), {
      launchBrowser: vi.fn(async () => payload.browser),
      captureEvidence: async () => [],
    })).rejects.toMatchObject({ payload: { reason: "unexpected_request:cdn.jsdelivr.net" } });
    expect(payload.requestRoute.continue).not.toHaveBeenCalled();
  });

  it.each([["application/csp-report"], ["application/reports+json"]])(
    "never continues a %s POST with a body to an allowlisted off-host host",
    async (contentType) => {
      const fake = fakeBrowser({ requestDuringUpload: {
        url: "https://cdn.jsdelivr.net/report",
        headers: { "content-type": contentType },
        body: "authorized-cad-bytes",
        resourceType: "csp_report",
      } });
      await expect(runProviderPortalKernel(definition({ offHostAllowlist: ["cdn.jsdelivr.net"] }), config(),
        await input(), {
          launchBrowser: vi.fn(async () => fake.browser),
          captureEvidence: async () => [],
        })).resolves.toMatchObject({
        state: "offers_extracted",
        portalBoundary: { blockedOffhostCount: 1, blockedOffhostByHost: { "cdn.jsdelivr.net": 1 } },
      });
      expect(fake.requestRoute.continue).not.toHaveBeenCalled();
      expect(fake.requestRoute.abort).toHaveBeenCalledWith("blockedbyclient");
    },
  );

  it.each([["*.jsdelivr.net"], ["CDN.example.com"], ["cdn.example.com:443"], ["localhost"]])(
    "rejects an inexact off-host allowlist entry %s before launch",
    async (host) => {
      const launchBrowser = vi.fn();
      await expect(runProviderPortalKernel(definition({ offHostAllowlist: [host] }), config(), await input(), {
        launchBrowser,
      })).rejects.toThrow(/inexact off-host allowlist/);
      expect(launchBrowser).not.toHaveBeenCalled();
    },
  );

  it("blocks an upload WebSocket outside the exact approval boundary", async () => {
    const fake = fakeBrowser({ webSocketDuringUpload: "wss://malicious.example/collect" });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).rejects.toMatchObject({
      payload: {
        terminalState: "unexpected_origin",
        providerMutationPossible: true,
      },
    });
    expect(fake.webSocketRoute.close).toHaveBeenCalledWith({
      code: 1008,
      reason: "unexpected_origin",
    });
    expect(fake.webSocketRoute.connectToServer).not.toHaveBeenCalled();
  });

  it("allows secure WebSockets only on an exact reviewed host", async () => {
    const fake = fakeBrowser({
      webSocketDuringUpload: "wss://quickquote.quickparts.com/socket",
    });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).resolves.toMatchObject({ state: "offers_extracted" });
    expect(fake.webSocketRoute.connectToServer).toHaveBeenCalledOnce();
    expect(fake.webSocketRoute.close).not.toHaveBeenCalled();
  });

  it("isolates inline and file-backed session state to exact provider hosts", async () => {
    const exactState = {
      cookies: [
        { name: "root", value: "x", domain: ".quickparts.com", path: "/" },
        { name: "app", value: "y", domain: "quickquote.quickparts.com", path: "/" },
      ],
      origins: [
        { origin: "https://quickparts.com", localStorage: [] },
        { origin: "https://quickquote.quickparts.com", localStorage: [] },
      ],
    };
    await expect(resolveIsolatedProviderStorageState(
      definition(),
      config(JSON.stringify(exactState)),
    )).resolves.toEqual(exactState);

    for (const changed of [
      { ...exactState, cookies: [{ name: "bad", value: "x", domain: ".fictiv.com", path: "/" }] },
      { ...exactState, cookies: [{ name: "wide", value: "x", domain: ".evil.quickparts.com", path: "/" }] },
      { ...exactState, origins: [{ origin: "https://fictiv.com", localStorage: [] }] },
      { ...exactState, origins: [{ origin: "https://quickparts.com:444", localStorage: [] }] },
    ]) {
      await expect(resolveIsolatedProviderStorageState(
        definition(),
        config(JSON.stringify(changed)),
      )).resolves.toBeNull();
    }
  });

  it("rejects symlinked storage-state files and ancestors while accepting an opened exact file", async () => {
    const createdTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-session-test-"));
    tempDirs.push(createdTempDir);
    const tempDir = await fs.realpath(createdTempDir);
    const realDir = path.join(tempDir, "real");
    const linkedDir = path.join(tempDir, "linked");
    await fs.mkdir(realDir);
    const statePath = path.join(realDir, "state.json");
    const state = { cookies: [], origins: [] };
    await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    await fs.symlink(realDir, linkedDir);
    const fileLink = path.join(tempDir, "state-link.json");
    await fs.symlink(statePath, fileLink);
    const fileConfig = (storagePath: string) => ({
      ...config(null),
      vendorStorageStatePaths: { quickparts: storagePath },
    });

    await expect(resolveIsolatedProviderStorageState(
      definition(),
      fileConfig(statePath),
    )).resolves.toEqual(state);
    await expect(resolveIsolatedProviderStorageState(
      definition(),
      fileConfig(path.join(linkedDir, "state.json")),
    )).resolves.toBeNull();
    await expect(resolveIsolatedProviderStorageState(
      definition(),
      fileConfig(fileLink),
    )).resolves.toBeNull();
  });
});

describe("portal boundary outcome precedence (OVD-826)", () => {
  const allowedHosts = ["quickparts.com", "quickquote.quickparts.com"];
  const driftStep = { terminalState: "selector_drift" as const, reason: "bounded_recovery_stopped" };

  it("reports unexpected_origin when off-host, mutation, and drift signals arrive together", () => {
    expect(classifyPortalBoundaryOutcome({
      violation: "unexpected_navigation:login.example-sso.com",
      currentUrl: "https://login.example-sso.com/authorize",
      allowedHosts,
      providerMutationPossible: true,
      stepOutcome: driftStep,
    })).toEqual({ terminalState: "unexpected_origin", reason: "unexpected_navigation:login.example-sso.com" });
  });

  it("lets an off-host signal that arrives after a pending drift win", () => {
    const signals = {
      violation: null as string | null,
      currentUrl: "https://quickquote.quickparts.com/",
      allowedHosts,
      providerMutationPossible: true,
      stepOutcome: driftStep,
    };
    expect(classifyPortalBoundaryOutcome(signals)).toEqual(driftStep);
    signals.violation = "unexpected_navigation:login.example-sso.com";
    signals.currentUrl = "chrome-error://chromewebdata/";
    expect(classifyPortalBoundaryOutcome(signals)).toEqual({
      terminalState: "unexpected_origin",
      reason: "unexpected_navigation:login.example-sso.com",
    });
  });

  it("keeps selector_drift for a same-origin drift", () => {
    expect(classifyPortalBoundaryOutcome({
      violation: null,
      currentUrl: "https://quickquote.quickparts.com/",
      allowedHosts,
      providerMutationPossible: false,
      stepOutcome: driftStep,
    })).toEqual(driftStep);
  });
});

describe("provider portal finite states and offers", () => {
  it("exposes only restricted read and declared configuration capabilities to hooks", async () => {
    const fake = fakeBrowser();
    const seenCapabilities: string[][] = [];
    const safeDefinition = definition({
      selectors: {
        ...definition().selectors,
        configuration: {
          material: { selector: "select[name='material']", operation: "select" },
        },
      },
      hooks: {
        ...definition().hooks,
        configure: async (configuration) => {
          seenCapabilities.push(Object.keys(configuration).sort());
          expect((configuration as unknown as { goto?: unknown }).goto).toBeUndefined();
          expect((configuration as unknown as { evaluate?: unknown }).evaluate).toBeUndefined();
          await configuration.select("material", "6061");
        },
        extractOffers: async (reader) => {
          seenCapabilities.push(Object.keys(reader).sort());
          expect((reader as unknown as { evaluate?: unknown }).evaluate).toBeUndefined();
          expect((reader as unknown as { request?: unknown }).request).toBeUndefined();
          expect((reader as unknown as { goto?: unknown }).goto).toBeUndefined();
          return [candidate()];
        },
      },
    });

    await expect(runProviderPortalKernel(
      safeDefinition,
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).resolves.toMatchObject({ state: "offers_extracted" });
    expect(seenCapabilities).toEqual([
      ["click", "fill", "select"],
      ["count", "readAttribute", "readText", "readTexts"],
    ]);
    expect(fake.selectOption).toHaveBeenCalledWith("6061");
    expect(fake.click).not.toHaveBeenCalled();
  });

  // OVD-677: a click is a declared configuration rule like fill and select,
  // matched on exact element text, and never aims at checkout-like text.
  it("clicks only a declared click rule, filtered on exact text", async () => {
    const fake = fakeBrowser();
    const results: boolean[] = [];
    const clickDefinition = definition({
      selectors: {
        ...definition().selectors,
        configuration: { materialFilter: { selector: ".Slideover .filterItem", operation: "click" } },
      },
      hooks: {
        ...definition().hooks,
        configure: async (configuration) => {
          results.push(await configuration.click("materialFilter", "6061 T6 Aluminum"));
        },
        extractOffers: async () => [candidate()],
      },
    });

    await expect(runProviderPortalKernel(clickDefinition, config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    })).resolves.toMatchObject({ state: "offers_extracted" });
    expect(results).toEqual([true]);
    expect(fake.click).toHaveBeenCalledTimes(1);
    const [{ hasText }] = fake.filter.mock.calls[0] as unknown as [{ hasText: RegExp }];
    expect(hasText.test(" 6061 T6 Aluminum ")).toBe(true);
    expect(hasText.test("6061 T6 Aluminum Tread")).toBe(false);
  });

  it.each([
    ["an undeclared field", "material", "6061 T6 Aluminum"],
    ["a select rule", "materialSelect", "6061 T6 Aluminum"],
    ["checkout-like text", "materialFilter", "Proceed to checkout"],
  ])("refuses a click on %s without clicking", async (_name, field, text) => {
    const fake = fakeBrowser();
    const clickDefinition = definition({
      selectors: {
        ...definition().selectors,
        configuration: {
          materialFilter: { selector: ".Slideover .filterItem", operation: "click" },
          materialSelect: { selector: "select[name='material']", operation: "select" },
        },
      },
      hooks: {
        ...definition().hooks,
        configure: async (configuration) => { await configuration.click(field, text); },
      },
    });

    await expect(runProviderPortalKernel(clickDefinition, config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    })).rejects.toMatchObject({
      payload: { terminalState: "configuration_required", reason: "undeclared_configuration_operation" },
    });
    expect(fake.click).not.toHaveBeenCalled();
  });

  it("fails closed on a hook-triggered popup and performs no later extraction work", async () => {
    const fake = fakeBrowser({ popupDuringRead: true });
    let continuedAfterRead = false;
    const captureEvidence = vi.fn(async () => []);
    const popupDefinition = definition({
      hooks: {
        ...definition().hooks,
        extractOffers: async (reader) => {
          await reader.readText("[data-offer]");
          continuedAfterRead = true;
          return [candidate()];
        },
      },
    });

    await expect(runProviderPortalKernel(
      popupDefinition,
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence,
      },
    )).rejects.toMatchObject({
      payload: {
        terminalState: "unexpected_origin",
        providerMutationPossible: true,
      },
    });
    expect(continuedAfterRead).toBe(false);
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(fake.popup.close).toHaveBeenCalled();
  });

  it("rechecks origin after extraction and rejects hook-observed navigation", async () => {
    const fake = fakeBrowser({ navigateDuringRead: "https://malicious.example/collect" });
    const unsafeDefinition = definition({
      hooks: {
        ...definition().hooks,
        extractOffers: async (reader) => {
          await reader.readAttribute("[data-offer]", "data-option-id");
          return [candidate()];
        },
      },
    });
    await expect(runProviderPortalKernel(
      unsafeDefinition,
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).rejects.toMatchObject({
      payload: { terminalState: "unexpected_origin" },
    });
  });

  it("rejects purchasing selectors in declared configuration operations", async () => {
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(
      definition({
        selectors: {
          ...definition().selectors,
          configuration: {
            unsafe: { selector: "button[data-checkout]", operation: "select" },
          },
        },
      }),
      config(),
      await input(),
      { launchBrowser },
    )).rejects.toThrow(/prohibited configuration selector/i);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("bounds retries to safe pre-mutation reads and never retries ambiguous mutations", async () => {
    const safeRead = vi.fn()
      .mockRejectedValueOnce(new Error("transient navigation"))
      .mockResolvedValue("ready");
    await expect(runIntentionalPortalRetry({
      operation: safeRead,
      maxAttempts: 10,
      providerMutationPossible: false,
    })).resolves.toBe("ready");
    expect(safeRead).toHaveBeenCalledTimes(2);

    const ambiguousMutation = vi.fn().mockRejectedValue(new Error("ambiguous upload"));
    await expect(runIntentionalPortalRetry({
      operation: ambiguousMutation,
      maxAttempts: 2,
      providerMutationPossible: true,
    })).rejects.toThrow("ambiguous upload");
    expect(ambiguousMutation).toHaveBeenCalledOnce();
  });

  it.each([
    ["https://quickquote.quickparts.com/login", "", 0, "login_required"],
    ["https://quickquote.quickparts.com/", "CAPTCHA", 0, "captcha"],
    ["https://quickquote.quickparts.com/", "manual review", 0, "manual_review"],
    ["https://quickquote.quickparts.com/", "select material", 0, "configuration_required"],
    ["https://quickquote.quickparts.com/", "temporarily unavailable", 0, "unavailable"],
    ["https://quickquote.quickparts.com/", "quote ready", 0, "ready"],
  ])("classifies %s / %s as %s", (url, bodyText, passwordInputCount, state) => {
    expect(classifyProviderPortalSnapshot({ url, bodyText, passwordInputCount })).toBe(state);
  });

  it("preserves anchored multi-option identity, quantity, validity, provenance, and unknowns", () => {
    const offers = normalizeAnchoredProviderOffers([
      candidate(),
      candidate({
        providerOptionId: "expedite-3d",
        providerLabel: "Expedite",
        totalPriceUsd: { value: 150, source: "selector", selector: "[data-total-price]" },
        unitPriceUsd: { value: 30, source: "selector", selector: "[data-unit-price]" },
        leadTimeBusinessDays: { value: 3, source: "selector", selector: "[data-lead-days]" },
        validUntil: "2026-09-30T23:59:59.000Z",
        validitySource: "vendor_date",
        validityTerms: "Valid through September 30",
      }),
    ], {
      expectedQuantity: 5,
      allowedHosts: ["quickquote.quickparts.com"],
      artifacts: [{
        kind: "json",
        label: "scrubbed evidence",
        localPath: "/private/evidence/quickparts-result.json",
        contentType: "application/json",
      }],
    });

    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      providerOptionId: "economy-7d",
      quantity: 5,
      geographicOrigin: "unknown",
      validUntil: null,
      validitySource: null,
      artifactRefs: ["quickparts-result.json"],
      provenance: {
        priceSource: "selector",
        leadTimeSource: "selector",
        geographicOriginSource: "none",
      },
    });
    expect(offers[1]).toMatchObject({
      providerOptionId: "expedite-3d",
      validUntil: "2026-09-30T23:59:59.000Z",
      validitySource: "vendor_date",
    });
  });

  it("never promotes unanchored values or duplicate provider identifiers", () => {
    expect(normalizeAnchoredProviderOffers([
      candidate({ totalPriceUsd: { value: 99, source: "body_text", selector: null } }),
    ], {
      expectedQuantity: 5,
      allowedHosts: ["quickquote.quickparts.com"],
    })).toEqual([]);
    expect(normalizeAnchoredProviderOffers([
      candidate(),
      candidate({ providerLabel: "Duplicate" }),
    ], {
      expectedQuantity: 5,
      allowedHosts: ["quickquote.quickparts.com"],
    })).toHaveLength(1);
  });

  it("rejects candidate quantity mismatch and external per-offer URLs", () => {
    expect(normalizeAnchoredProviderOffers([
      candidate({ quantity: 4 }),
      candidate({
        providerOptionId: "external-option",
        quoteUrl: "https://malicious.example/quote",
      }),
    ], {
      expectedQuantity: 5,
      allowedHosts: ["quickquote.quickparts.com"],
    })).toEqual([]);
  });

  it("rechecks origin after CAD count before uploading", async () => {
    const fake = fakeBrowser({ navigateDuringCountAt: 1 });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      { launchBrowser: vi.fn(async () => fake.browser), captureEvidence: async () => [] },
    )).rejects.toMatchObject({ payload: { terminalState: "unexpected_origin" } });
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(fake.fill).not.toHaveBeenCalled();
  });

  it("rechecks popup boundary after quantity count before filling", async () => {
    const fake = fakeBrowser({ popupDuringCountAt: 2 });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      { launchBrowser: vi.fn(async () => fake.browser), captureEvidence: async () => [] },
    )).rejects.toMatchObject({ payload: { terminalState: "unexpected_origin" } });
    expect(fake.setInputFiles).toHaveBeenCalledOnce();
    expect(fake.fill).not.toHaveBeenCalled();
  });

  it("reports the first off-host navigation when a fill times out on Chromium's error page (OVD-826)", async () => {
    const fake = fakeBrowser({
      navigateDuringFill: ["https://login.example-sso.com/authorize", "chrome-error://chromewebdata/"],
      fillFailure: new Error("locator.fill: Timeout 5000ms exceeded."),
    });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      { launchBrowser: vi.fn(async () => fake.browser), captureEvidence: async () => [] },
    )).rejects.toMatchObject({
      payload: {
        terminalState: "unexpected_origin",
        reason: "unexpected_navigation:login.example-sso.com",
        providerMutationPossible: true,
      },
    });
  });

  it("marks an ambiguous upload failure as mutation-possible and closes the isolated context", async () => {
    const fake = fakeBrowser({ uploadFailure: new Error("target closed") });
    await expect(runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    )).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        terminalState: "selector_drift",
        reason: "ambiguous_provider_mutation",
        providerMutationPossible: true,
      },
    });
    expect(fake.context.close).toHaveBeenCalledOnce();
    expect(fake.browser.close).toHaveBeenCalledOnce();
  });

  it("attaches optional advisory triage without weakening uncertain-upload failure", async () => {
    const fake = fakeBrowser({ uploadFailure: new Error("Session expired; sign in again") });
    const audit = vi.fn(async () => undefined);
    await expect(runProviderPortalKernel(definition(), config(), await input(), {
      launchBrowser: async () => fake.browser,
      failureTriage: {
        decide: async (question) => ({
          model: "jev-1.13.0", choice: "expired_session", confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "expired_session" ? 1 : 0])),
          inputTokens: 10, outputTokens: 10,
        }), audit,
      },
    })).rejects.toMatchObject({ code: "selector_failure", payload: {
      reason: "ambiguous_provider_mutation", providerMutationPossible: true,
      failureTriage: { category: "expired_session", advisoryOnly: true },
    } });
    expect(fake.setInputFiles).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
  });

  it("operational shadow observes the original failure without changing kernel error or DOM actions", async () => {
    const approved = await input();
    const scope: OperationalJevScope = { organizationId: approved.organizationId, quoteRunId: approved.quoteRunId,
      taskId: "task", provider: "quickparts", sourceRevision: "f9195d2f071159bd46873b0ad402b1b12de75601" };
    const audit = vi.fn(async () => true);
    const decide = vi.fn(async (question) => ({ model: "jev-1.13.0", choice: "expired_session", confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "expired_session" ? 1 : 0])),
      inputTokens: 10, outputTokens: 10 }));
    const session = new OperationalJevSession({ mode: "shadow", admission: { scope, expiresAt: Date.now() + 60_000,
      uses: ["exception_routing", "recovery"], evidenceProfiles: ["failure_words.v1"] }, capabilities: {
      authorize: async () => true, reserve: async () => ({ reservationId: "budget", estimatedUsd: 0.25 }),
      settle: async () => undefined, audit, decide,
    } });
    const outcomes = [];
    for (const binding of [undefined, { session, scope, observations: new OperationalJevObservations() }]) {
      const fake = fakeBrowser({ uploadFailure: new Error("Session expired; sign in again secret=123") });
      const error = await runProviderPortalKernel(definition(), config(), approved, {
        launchBrowser: async () => fake.browser, captureEvidence: async () => [], operationalJev: binding,
      }).catch((error) => error);
      outcomes.push({ message: error.message, code: error.code, payload: error.payload });
      expect(fake.setInputFiles).toHaveBeenCalledOnce();
      expect(fake.fill).not.toHaveBeenCalled(); expect(fake.selectOption).not.toHaveBeenCalled();
      expect(fake.context.close).toHaveBeenCalledOnce(); expect(fake.browser.close).toHaveBeenCalledOnce();
      expect(decide).not.toHaveBeenCalled();
      await binding?.observations.drain();
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[1].payload).not.toHaveProperty("failureTriage");
    expect(decide).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.mock.calls)).not.toContain("secret");
  });

  it.each(["declared", "quantity"])("fresh shadow preserves missing %s branch and finishes before close", async (kind) => {
    const approved = await input();
    const scope: OperationalJevScope = { organizationId: approved.organizationId, quoteRunId: approved.quoteRunId,
      taskId: "task", provider: "quickparts", sourceRevision: "a".repeat(40) };
    const missingSelector = kind === "quantity" ? "input[name='quantity']" : "select[name='material']";
    const branchResults: boolean[] = [];
    const portal = definition(kind === "declared" ? { selectors: { ...definition().selectors,
      configuration: { material: { selector: missingSelector, operation: "select" } } },
      hooks: { ...definition().hooks, configure: async (capability) => { branchResults.push(await capability.select("material", "6061")); } } } : {});
    const run = async (shadow: boolean) => {
      const fake = fakeBrowser({ missingSelector });
      const session = new OperationalJevSession({ mode: "off" });
      const recovery = vi.spyOn(session, "recovery").mockImplementation(async (_scope, observation) => {
        expect(fake.context.close).not.toHaveBeenCalled(); expect(fake.browser.close).not.toHaveBeenCalled();
        observation.assertBoundary(); await observation.assertReady();
        expect(observation.field).toBe(kind === "quantity" ? "quantity" : "material");
        return { revision: "jev-operational-source.v1", use: "recovery", phase: "final", advisoryOnly: true,
          outcome: "observed", reason: "observed", recoveryOutcome: "proposed" };
      });
      vi.spyOn(session, "captureEnabled").mockReturnValue(shadow);
      const result = await runProviderPortalKernel(portal, config(), approved, { launchBrowser: async () => fake.browser,
        captureEvidence: async () => [], operationalJev: { session, scope, observations: new OperationalJevObservations(), freshBrowserRecovery: "bounded_observation" } });
      expect(recovery).toHaveBeenCalledTimes(shadow ? 1 : 0);
      expect(fake.context.close).toHaveBeenCalledOnce(); expect(fake.browser.close).toHaveBeenCalledOnce();
      expect(fake.fill).toHaveBeenCalledTimes(kind === "quantity" ? 0 : 1); expect(fake.selectOption).not.toHaveBeenCalled();
      return result;
    };
    expect(await run(true)).toEqual(await run(false));
    if (kind === "declared") expect(branchResults).toEqual([false, false]);
  });

  it("does not reuse a task recovery receipt for a different later missing generic field", async () => {
    const approved = await input();
    const scope: OperationalJevScope = { organizationId: approved.organizationId, quoteRunId: approved.quoteRunId,
      taskId: "task", provider: "quickparts", sourceRevision: "a".repeat(40) };
    const authorize = vi.fn(async () => true), decide = vi.fn();
    const session = new OperationalJevSession({ mode: "shadow", admission: { scope, expiresAt: Date.now() + 60000,
      uses: ["recovery"], evidenceProfiles: ["recovery_labels.v1"] }, capabilities: { authorize, decide,
      reserve: async () => ({ reservationId: "one", estimatedUsd: 0.1 }), settle: async () => undefined, audit: async () => true } });
    const observations = new OperationalJevObservations();
    const fake = fakeBrowser({ missingSelectors: ["input[name='quantity']", "select[name='material']"] });
    const portal = definition({ selectors: { ...definition().selectors,
      configuration: { material: { selector: "select[name='material']", operation: "select" } } },
      hooks: { ...definition().hooks, configure: async (capability) => {
        expect(observations.localReview().get("recovery")).toMatchObject({ reason: "no_evidence" });
        expect(await capability.select("material", "6061")).toBe(false);
        expect(observations.localReview().get("recovery")).toMatchObject({ reason: "recovery_observation_missing",
          recoveryOutcome: "unavailable", freshness: "historical_after_observation", targetAuthority: "none" });
      } } });
    await expect(runProviderPortalKernel(portal, config(), approved, { launchBrowser: async () => fake.browser,
      captureEvidence: async () => [], operationalJev: { session, scope, observations, freshBrowserRecovery: "bounded_observation" } }))
      .resolves.toMatchObject({ state: "offers_extracted" });
    expect(authorize).toHaveBeenCalledOnce(); expect(decide).not.toHaveBeenCalled();
    expect(fake.fill).not.toHaveBeenCalled(); expect(fake.selectOption).not.toHaveBeenCalled();
  });

  it("extracts anchored offers after one authorized upload", async () => {
    const fake = fakeBrowser();
    const result = await runProviderPortalKernel(
      definition(),
      config(),
      await input(),
      {
        launchBrowser: vi.fn(async () => fake.browser),
        captureEvidence: async () => [],
      },
    );
    expect(result.state).toBe("offers_extracted");
    expect(result.offers).toHaveLength(1);
    expect(fake.setInputFiles).toHaveBeenCalledOnce();
    expect(fake.fill).toHaveBeenCalledWith("5");
    expect(fake.context.close).toHaveBeenCalledOnce();
  });

  it("marks the task mutation phase at the CAD upload and not before it", async () => {
    const approved = await input();
    const uploadedPhase = createProviderMutationPhase();
    const uploaded = fakeBrowser();
    await runInProviderMutationPhase(uploadedPhase, () => runProviderPortalKernel(definition(), config(), approved, {
      launchBrowser: async () => uploaded.browser,
      captureEvidence: async () => [],
    }));
    expect(uploaded.setInputFiles).toHaveBeenCalledOnce();
    // A later plain failure in the same task (for example artifact persistence)
    // is therefore not retried.
    expect(uploadedPhase.started).toBe(true);

    const redirectedPhase = createProviderMutationPhase();
    const redirected = fakeBrowser({ navigateDuringCountAt: 1 });
    await runInProviderMutationPhase(redirectedPhase, () => runProviderPortalKernel(definition(), config(), approved, {
      launchBrowser: async () => redirected.browser,
      captureEvidence: async () => [],
    })).catch(() => undefined);
    expect(redirected.setInputFiles).not.toHaveBeenCalled();
    expect(redirectedPhase.started).toBe(false);
  });

  it.each([
    { playwrightDisableSandbox: false, chromiumSandbox: true, args: [] as string[] },
    { playwrightDisableSandbox: true, chromiumSandbox: false, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  ])("passes the Chromium sandbox decision explicitly (disable=$playwrightDisableSandbox)", async (
    { playwrightDisableSandbox, chromiumSandbox, args },
  ) => {
    const fake = fakeBrowser();
    const launchBrowser = vi.fn(async () => fake.browser);
    await runProviderPortalKernel(definition(), { ...config(), playwrightDisableSandbox }, await input(), {
      launchBrowser,
      captureEvidence: async () => [],
    });
    expect(launchBrowser).toHaveBeenCalledWith({ headless: true, timeout: 100, chromiumSandbox, args });
  });

  it("scrubs account identifiers and bounds portal evidence text", () => {
    const safe = scrubProviderEvidenceText(
      `Contact customer@example.com token=abc123 session:secret quote id:QP-123 ${"a".repeat(64)} ${"x".repeat(3_000)}`,
    );
    expect(safe).not.toContain("customer@example.com");
    expect(safe).not.toContain("abc123");
    expect(safe).not.toContain("QP-123");
    expect(safe).not.toContain("a".repeat(64));
    expect(safe.length).toBeLessThanOrEqual(2_000);
  });

  it("persists only scrubbed minimal provider-state evidence by default", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-evidence-test-"));
    tempDirs.push(tempDir);
    const fake = fakeBrowser({ bodyText: "customer@example.com token=secret quote ready" });
    await fake.page.goto("https://quickquote.quickparts.com/quotes/customer-123?customer=123#account");
    const artifacts = await captureScrubbedProviderEvidence(
      definition(),
      { ...config(), workerTempDir: tempDir },
      "selector_drift",
      {
        url: fake.page.url(),
        bodyText: "customer@example.com token=secret quote ready",
        passwordInputCount: 0,
      },
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "json", contentType: "application/json" });
    const persisted = await fs.readFile(artifacts[0]!.localPath, "utf8");
    expect(persisted).not.toContain("customer@example.com");
    expect(persisted).not.toContain("secret");
    expect(persisted).not.toContain("customer=123");
    expect(persisted).not.toContain("customer-123");
    expect(persisted).not.toContain("/quotes/");
    expect(persisted).not.toContain("#account");
    expect(JSON.parse(persisted)).toMatchObject({
      url: "https://quickquote.quickparts.com/",
      textSummary: { present: true },
    });
  });
});

describe("provider portal session capability (OVD-1056)", () => {
  afterEach(() => vi.useRealTimers());

  async function startCheck(
    evaluate: (fn: () => Promise<unknown>) => Promise<unknown>,
    beforeUpload?: ProviderPortalDefinition["hooks"]["beforeUpload"],
    overrides: Partial<ProviderPortalDefinition> = {},
  ) {
    const fake = fakeBrowser();
    let evaluationStarted!: () => void;
    const started = new Promise<void>((resolve) => { evaluationStarted = resolve; });
    const evaluator = vi.fn((fn: () => Promise<unknown>) => {
      evaluationStarted();
      return evaluate(fn);
    });
    Object.assign(fake.page, { evaluate: evaluator });
    const results: unknown[] = [];
    const checked = definition({
      provider: "sendcutsend",
      routes: {
        publicUrl: "https://app.sendcutsend.com/",
        loginUrl: "https://app.sendcutsend.com/",
        uploadUrl: "https://app.sendcutsend.com/",
      },
      allowedHosts: ["app.sendcutsend.com"],
      hooks: {
        ...definition().hooks,
        beforeUpload: beforeUpload ?? (async (_reader, session) => { results.push(await session.confirmSignedIn()); }),
      },
      ...overrides,
    });
    const approved = await input();
    approved.providerPortalApproval = buildExpectedProviderPortalApproval(checked, approved)!;
    const settings = config();
    settings.vendorStorageStateJson = { [checked.provider]: JSON.stringify({ cookies: [], origins: [] }) };
    const done = runProviderPortalKernel(checked, settings, approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    }).catch((error: unknown) => error);
    return { results, evaluate: evaluator, fake, done, started };
  }

  it("runs only the kernel's fixed evaluator and returns only the yes/no and a short detail", async () => {
    const { results, evaluate, done } = await startCheck(async () => ({ signedIn: true, detail: "status 200", body: { email: "x" } }));
    await done;
    // The kernel checks before classification and again immediately before upload.
    expect(evaluate.mock.calls).toEqual([[checkSendCutSendCurrentUser], [checkSendCutSendCurrentUser]]);
    expect(results[0]).toEqual({ signedIn: true, detail: "status 200" });
  });

  it.each([
    ["a truthy non-boolean", async () => ({ signedIn: "yes", detail: "status 200" }), { signedIn: false, detail: "status 200" }],
    ["a malformed result", async () => null, { signedIn: false, detail: "malformed session check" }],
    ["a thrown check", async () => { throw new Error("evaluate failed"); }, { signedIn: false, detail: "page check failed" }],
  ])("reports not signed in for %s", async (_label, evaluate, expected) => {
    const { results, done } = await startCheck(evaluate);
    await done;
    expect(results[0]).toEqual(expected);
  });

  it.each(["checkout click", "same-origin POST"])("rejects an adapter callback attempting a %s before evaluation or upload", async (operation) => {
    const click = vi.fn();
    const fetch = vi.fn();
    const injected = async () => {
      if (operation === "checkout click") click();
      else await fetch("/orders", { method: "POST" });
      return { signedIn: true, detail: "injected" };
    };
    const { done, evaluate, fake } = await startCheck((fn) => fn(), async (_reader, session) => {
      // @ts-expect-error Adapters cannot supply page code, including legacy callbacks.
      await session.confirmSignedIn(injected);
    });
    await expect(done).resolves.toMatchObject({
      payload: { reason: "session_check_arguments_forbidden", providerMutationPossible: false },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.setInputFiles).not.toHaveBeenCalled();
  });

  it.each([
    ["an unsupported provider", { provider: "quickparts" }],
    ["another allowed host", {
      routes: { publicUrl: "https://main.realtime.ably.net/", loginUrl: "https://main.realtime.ably.net/", uploadUrl: "https://main.realtime.ably.net/" },
      allowedHosts: ["main.realtime.ably.net"],
    }],
  ] as const)("does not evaluate a session probe for %s", async (_label, overrides) => {
    const { results, evaluate, done } = await startCheck(async () => ({ signedIn: true }), undefined, overrides);
    await done;
    expect(results).toEqual(Array(2).fill({ signedIn: false, detail: "unsupported session check" }));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("bounds a never-resolving evaluator and the SendCutSend guard prevents upload at the deadline", async () => {
    const guard = buildSendCutSendSheetPortalDefinition({ sessionSettleMs: 0 }).hooks.beforeUpload!;
    vi.useFakeTimers();
    const { done, started, fake } = await startCheck(() => new Promise(() => undefined), (reader, session) => guard({
      ...reader,
      count: async (selector) => selector === SENDCUTSEND_SHEET_LOCATORS.navbar || selector === SENDCUTSEND_SHEET_LOCATORS.uploadInput ? 1 : 0,
    }, session));
    let settled = false;
    void done.then(() => { settled = true; });
    await started;
    await vi.advanceTimersByTimeAsync(PROVIDER_PORTAL_SESSION_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(done).resolves.toMatchObject({
      payload: { terminalState: "login_required", reason: "sendcutsend_session_unconfirmed", providerMutationPossible: false },
      message: expect.stringContaining("timed out"),
    });
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(fake.context.close).toHaveBeenCalledOnce();
    expect(fake.browser.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("provider kill switch checkpoints inside the portal kernel (OVD-722)", () => {
  it("refuses before navigation when the switch is engaged: the page is never loaded", async () => {
    const fake = fakeBrowser();
    const checkpoints: string[] = [];
    // Authorized by identity, so the checkpoint is attached to the same object.
    const approved = Object.assign(await input(), {
      providerKillSwitchCheckpoint: async (checkpoint: "before_navigation" | "before_upload" | "before_configure") => {
        checkpoints.push(checkpoint);
        throw new ProviderKillSwitchError("provider_kill_switch_engaged", "quickparts", checkpoint);
      },
    });
    const error = await runProviderPortalKernel(definition(), config(), approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderKillSwitchError);
    expect(checkpoints).toEqual(["before_navigation"]);
    expect(fake.page.goto).not.toHaveBeenCalled();
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(fake.context.close).toHaveBeenCalledOnce();
  });

  it("a running task flipped off mid-flight stops at the next checkpoint before any upload or configuration", async () => {
    const fake = fakeBrowser();
    const phase = createProviderMutationPhase();
    let engaged = false;
    // Authorized by identity, so the checkpoint is attached to the same object.
    const approved = Object.assign(await input(), {
      providerKillSwitchCheckpoint: async (checkpoint: "before_navigation" | "before_upload" | "before_configure") => {
        if (engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "quickparts", checkpoint);
        engaged = true; // the admin flips the switch right after navigation is allowed
      },
    });
    const error = await runInProviderMutationPhase(phase, () => runProviderPortalKernel(definition(), config(), approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    })).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderKillSwitchError", reasonCode: "provider_kill_switch_engaged", checkpoint: "before_upload" });
    expect(fake.page.goto).toHaveBeenCalledOnce();
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(fake.fill).not.toHaveBeenCalled();
    expect(phase.started).toBe(false);
  });
  type Checkpoint = Parameters<NonNullable<VendorQuoteAdapterInput["providerKillSwitchCheckpoint"]>>[0];

  /** Fails closed only after `engaged` is flipped; records every read. */
  async function switchableInput() {
    const state = { engaged: false, reads: [] as Checkpoint[] };
    const approved = Object.assign(await input(), {
      providerKillSwitchCheckpoint: async (checkpoint: Checkpoint) => {
        state.reads.push(checkpoint);
        if (state.engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "quickparts", checkpoint);
      },
    });
    return { state, approved };
  }

  it("engaged between the before_upload read and the upload step: the CAD upload never starts", async () => {
    const fake = fakeBrowser();
    const phase = createProviderMutationPhase();
    const { state, approved } = await switchableInput();
    // The admin flips the switch while the kernel awaits the upload locator lookup,
    // after the phase-level before_upload read already passed.
    const uploadLocator = fake.page.locator("input[type='file']").first();
    vi.mocked(uploadLocator.count).mockImplementationOnce(async () => {
      state.engaged = true;
      return 1;
    });
    const error = await runInProviderMutationPhase(phase, () => runProviderPortalKernel(definition(), config(), approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    })).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderKillSwitchError", reasonCode: "provider_kill_switch_engaged", checkpoint: "before_upload" });
    expect(state.reads).toEqual(["before_navigation", "before_upload", "before_upload"]);
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(fake.fill).not.toHaveBeenCalled();
    expect(phase.started).toBe(false);
  });

  it("engaged while the pre-upload guard waits: the switch is re-read after the guard and the CAD upload never starts", async () => {
    const fake = fakeBrowser();
    const phase = createProviderMutationPhase();
    const { state, approved } = await switchableInput();
    let guardCalls = 0;
    const guarded = definition({
      hooks: {
        ...definition().hooks,
        // The second call is the one right before upload; the admin flips the switch while it waits.
        beforeUpload: async () => {
          guardCalls += 1;
          if (guardCalls === 2) state.engaged = true;
        },
      },
    });
    const error = await runInProviderMutationPhase(phase, () => runProviderPortalKernel(guarded, config(), approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    })).catch((e: unknown) => e);
    expect(guardCalls).toBe(2);
    expect(error).toMatchObject({ name: "ProviderKillSwitchError", reasonCode: "provider_kill_switch_engaged", checkpoint: "before_upload" });
    expect(state.reads).toEqual(["before_navigation", "before_upload", "before_upload"]);
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(phase.started).toBe(false);
  });

  it("engaged while the CAD upload is awaiting: no configuration is written afterwards", async () => {
    const fake = fakeBrowser();
    const phase = createProviderMutationPhase();
    const { state, approved } = await switchableInput();
    fake.setInputFiles.mockImplementationOnce(async () => {
      state.engaged = true;
    });
    const error = await runInProviderMutationPhase(phase, () => runProviderPortalKernel(definition(), config(), approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    })).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
    expect(fake.setInputFiles).toHaveBeenCalledOnce();
    expect(fake.fill).not.toHaveBeenCalled();
    // The upload already reached the provider; the record says so truthfully.
    expect(phase.started).toBe(true);
  });

  it("engaged during the quantity fill: the configure hook cannot select any option", async () => {
    const fake = fakeBrowser();
    const { state, approved } = await switchableInput();
    fake.fill.mockImplementationOnce(async () => {
      state.engaged = true;
    });
    const configured = definition({
      selectors: {
        ...definition().selectors,
        configuration: { material: { selector: "select[name='material']", operation: "select" } },
      },
      hooks: {
        ...definition().hooks,
        configure: async (configuration) => {
          await configuration.select("material", "6061");
        },
      },
    });
    const error = await runProviderPortalKernel(configured, config(), approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
    expect(fake.fill).toHaveBeenCalledOnce();
    expect(fake.selectOption).not.toHaveBeenCalled();
  });

  it("engaged during a failed navigation attempt: the retry re-reads the switch and never navigates again", async () => {
    const fake = fakeBrowser();
    const { state, approved } = await switchableInput();
    vi.mocked(fake.page.goto).mockImplementationOnce(async () => {
      state.engaged = true;
      throw new Error("net::ERR_CONNECTION_RESET");
    });
    const error = await runProviderPortalKernel(definition(), config(), approved, {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_navigation" });
    expect(state.reads).toEqual(["before_navigation", "before_navigation"]);
    expect(fake.page.goto).toHaveBeenCalledOnce();
    expect(fake.setInputFiles).not.toHaveBeenCalled();
  });

  it("runIntentionalPortalRetry never retries past a kill-switch refusal", async () => {
    const refusal = new ProviderKillSwitchError("provider_kill_switch_engaged", "quickparts", "before_navigation");
    const operation = vi.fn(async () => {
      throw refusal;
    });
    await expect(runIntentionalPortalRetry({ operation, maxAttempts: 2, providerMutationPossible: false }))
      .rejects.toBe(refusal);
    expect(operation).toHaveBeenCalledOnce();
  });
});

// Blaine's standing rule (2026-10-15): an attempt that uploaded a test part
// removes it once everything is captured, best-effort and never at the cost
// of the attempt's own result or error.
describe("provider portal post-capture cleanup", () => {
  const cleanupSelectors = {
    partRow: { selector: ".row" },
    removePart: { selector: "button.remove", scope: ".row" },
    confirmRemove: { selector: "button.confirm" },
  };

  function cleanupDefinition(
    cleanup: NonNullable<ProviderPortalDefinition["hooks"]["cleanup"]>,
    hooks: Partial<ProviderPortalDefinition["hooks"]> = {},
  ): ProviderPortalDefinition {
    return definition({
      selectors: { ...definition().selectors, cleanup: cleanupSelectors },
      hooks: { ...definition().hooks, extractOffers: async () => [candidate()], ...hooks, cleanup },
    });
  }

  it("removes the uploaded part after the offers are read and reports it", async () => {
    const fixture = confirmationFixture();
    const order: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await fixture.run(async (cleanup) => {
      order.push("cleanup");
      expect(await cleanup.click("confirmRemove", "part.step")).toBe(true);
      return { removed: 1, remaining: 0 };
    }, true, undefined, {}, { extractOffers: async () => { order.push("extract"); return [candidate()]; } });
    expect(result).toMatchObject({
      state: "offers_extracted",
      cartCleanup: { status: "removed", removed: 1, remaining: 0, reason: null },
    });
    expect(order).toEqual(["extract", "cleanup"]);
    expect(fixture.selected.isConnected).toBe(false);
    expect(fixture.other.isConnected).toBe(true);
    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toMatchObject({
      source: "providerPortalCleanup", provider: "quickparts", status: "removed",
    });
  });

  // Real DOM identity and selectors; no filename-filtering count stub.
  function cartFixture(names: string[], frame?: ReturnType<Page["mainFrame"]>) {
    const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
    const cart = dom.window.document.querySelector("main")!;
    const removeClicks = vi.fn();
    let modalOpen = false;
    let afterClick: ((node: Element) => Promise<void>) | undefined;
    let afterFileNameRead: ((node: Element) => void) | undefined;
    const append = (name: string, removable = true) => {
      const row = dom.window.document.createElement("div");
      const information = dom.window.document.createElement("div");
      information.className = "cartInformationArea";
      information.textContent = name;
      row.append(information);
      if (removable) {
        const button = dom.window.document.createElement("button");
        button.className = "removeButton";
        button.addEventListener("click", () => { removeClicks(name); row.remove(); });
        row.append(button);
      }
      cart.append(row);
      return row;
    };
    names.forEach((name) => append(name));
    const nodes = new Map<object, Element>();
    const handle = (node: Element): ElementHandle<HTMLElement> => {
      const result = {
        ownerFrame: async () => frame,
        evaluate: async (fn: (element: Element, arg: unknown) => unknown, arg: unknown = []) => {
          if (modalOpen) throw new Error("DOM evaluation is paused by a native modal");
          const unwrap = (value: unknown): unknown => {
            if (value && typeof value === "object") {
              if (nodes.has(value)) return nodes.get(value);
              if (Array.isArray(value)) return value.map(unwrap);
              return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
            }
            return value;
          };
          const value = fn(node, unwrap(arg));
          if (node.classList.contains("cartInformationArea")) afterFileNameRead?.(node);
          return value;
        },
        $$: async (selector: string) => {
          if (modalOpen) throw new Error("DOM lookup is paused by a native modal");
          // jsdom's :scope query includes nested same-tag parents; match the
          // direct-child semantics Chromium uses for these fixture selectors.
          if (selector.startsWith(":scope > ")) {
            return [...node.children].filter((child) => child.matches(selector.slice(9))).map(handle);
          }
          return [...node.querySelectorAll(selector)].map(handle);
        },
        click: async () => {
          (node as HTMLElement).click();
          await afterClick?.(node);
        },
      } as unknown as ElementHandle<HTMLElement>;
      nodes.set(result, node);
      return result;
    };
    const locator = {
      count: async () => cart.querySelectorAll(OSHCUT_CART_ROW).length,
      elementHandles: async () => [...cart.querySelectorAll(OSHCUT_CART_ROW)].map(handle),
    } as unknown as Locator;
    const locate = (read: () => Element[]): Locator => ({
      count: async () => read().length,
      elementHandles: async () => read().map(handle),
      filter: ({ hasText }: { hasText: string }) => locate(() => read().filter((node) => node.textContent?.includes(hasText))),
      locator: (selector: string) => locate(() => read().flatMap((node) => [...node.querySelectorAll(selector)])),
    }) as unknown as Locator;
    return { cart, append, locator, removeClicks,
      runInitScript: (script: unknown) => {
        if (typeof script !== "function") throw new Error("Expected an init function");
        dom.window.eval(`(${script.toString()})()`);
      },
      locate: (selector: string) => locate(() => [...cart.querySelectorAll(selector)]),
      onClick: (fn: (node: Element) => Promise<void>) => { afterClick = fn; },
      onFileNameRead: (fn: (node: Element) => void) => { afterFileNameRead = fn; },
      setModalOpen: (open: boolean) => { modalOpen = open; },
      root: { elementHandle: async () => handle(dom.window.document.documentElement) } as unknown as Locator };
  }

  function confirmationFixture() {
    const fake = fakeBrowser();
    const cart = cartFixture([], fake.page.mainFrame());
    vi.mocked(fake.page.addInitScript).mockImplementation(async (script) => { cart.runInitScript(script); });
    const selected = cart.append("part.step", false);
    const other = cart.append("customer-part.step", false);
    for (const row of [selected, other]) {
      row.className = "row";
      for (const kind of ["remove", "confirm"]) {
        const button = row.ownerDocument.createElement("button");
        button.className = kind;
        button.textContent = kind;
        if (kind === "confirm") button.addEventListener("click", () => row.remove());
        row.append(button);
      }
    }
    selected.remove();
    fake.setInputFiles.mockImplementation(async () => { cart.cart.append(selected); });
    const original = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => selector === "html" ? cart.root
      : [".row", "button.confirm"].includes(selector) ? cart.locate(selector) : original(selector));
    const run = async (hook: NonNullable<ProviderPortalDefinition["hooks"]["cleanup"]>, scoped = true,
      checkpoint?: VendorQuoteAdapterInput["providerKillSwitchCheckpoint"],
      selectors: Partial<ProviderPortalDefinition["selectors"]> = {},
      hooks: Partial<ProviderPortalDefinition["hooks"]> = {},
      dependencies: RunProviderPortalKernelDependencies = {}) => {
      const def = cleanupDefinition(hook, hooks);
      def.selectors = { ...def.selectors, cleanupRow: ".row", cleanupRowFileName: ".cartInformationArea", cleanup: {
        ...cleanupSelectors, confirmRemove: { selector: "button.confirm", ...(scoped ? { scope: ".row" } : {}) },
      }, ...selectors };
      return runProviderPortalKernel(def, config(), Object.assign(await input(), {
        providerKillSwitchCheckpoint: checkpoint,
      }), { launchBrowser: async () => fake.browser, captureEvidence: async () => [], ...dependencies });
    };
    other.querySelector(".cartInformationArea")!.textContent = "other.step";
    return { fake, cart, selected, other, run };
  }

  it.each(["current URL", "recorded navigation"])("keeps failure diagnostics when cleanup encounters an off-host %s", async (boundary) => {
    const fixture = confirmationFixture();
    const observations = new OperationalJevObservations();
    const operational = new OperationalJevSession({ mode: "off" });
    const failure = vi.spyOn(operational, "failure");
    const audit = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => ({ removed: 0, remaining: 1 }));
    const reason = boundary === "current URL" ? "unexpected_origin" : "unexpected_navigation:login.example-sso.com";
    const error = await fixture.run(cleanup, true, undefined, {}, {
      configure: async () => {
        vi.mocked(fixture.fake.page.url).mockReturnValue("https://login.example-sso.com/authorize");
        if (boundary === "recorded navigation") {
          vi.mocked(fixture.fake.page.mainFrame().url).mockReturnValue("https://login.example-sso.com/authorize");
          for (const [event, listener] of vi.mocked(fixture.fake.page.on).mock.calls) {
            if (event === "framenavigated") listener(fixture.fake.page.mainFrame());
          }
        }
        throw new Error("Session expired; sign in again");
      },
    }, {
      operationalJev: { session: operational, observations, scope: {
        organizationId: "org-1", quoteRunId: "run-1", taskId: "cleanup-boundary", provider: "quickparts", sourceRevision: "e4aec109",
      } },
      failureTriage: { decide: async () => ({ model: "jev-1.13.0", choice: "expired_session", confidence: 1,
        probabilities: { expired_session: 1, unsupported_part: 0, transient_vendor_issue: 0, engineering_review: 0, unknown: 0 },
        inputTokens: 10, outputTokens: 10 }), audit },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "unexpected_ui_state", payload: {
      terminalState: "unexpected_origin", reason, providerMutationPossible: true,
      cartCleanup: { status: "failed", removed: 0, remaining: null, reason },
      portalBoundary: { blockedOffhostCount: 0 },
      failureTriage: { category: "expired_session", advisoryOnly: true },
    } });
    expect(cleanup).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledOnce();
    await observations.drain();
    expect(failure).toHaveBeenCalledOnce();
    expect(supplierCartCleanupFromPayload((error as { payload: unknown }).payload).manualRemovalRequired).toBe(true);
    expect(fixture.fake.context.close).toHaveBeenCalledOnce();
  });

  it("keeps extracted offers when the origin changes before cleanup construction", async () => {
    const fixture = confirmationFixture();
    const cleanup = vi.fn(async () => ({ removed: 0, remaining: 1 }));
    const result = await fixture.run(cleanup, true, undefined, {}, {}, {
      captureEvidence: async () => {
        vi.mocked(fixture.fake.page.url).mockReturnValue("https://login.example-sso.com/authorize");
        return [];
      },
    });
    expect(result).toMatchObject({ state: "offers_extracted",
      offers: [expect.objectContaining({ providerOptionId: "economy-7d" })],
      portalBoundary: { blockedOffhostCount: 0 },
      cartCleanup: { status: "failed", removed: 0, remaining: null, reason: "unexpected_origin" },
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(supplierCartCleanupFromPayload(result).manualRemovalRequired).toBe(true);
  });

  it.each([0, 1, 2, Number.NaN])("preserves the hook's remaining count %s after verified removal", async (remaining) => {
    const fixture = confirmationFixture();
    const result = await fixture.run(async (cleanup) => {
      expect(await cleanup.click("confirmRemove", "part.step")).toBe(true);
      return { removed: 1, remaining };
    });
    expect(result.cartCleanup).toEqual({ status: remaining === 0 ? "removed" : "incomplete",
      removed: 1, remaining: Number.isNaN(remaining) ? null : remaining, reason: null });
    expect(supplierCartCleanupFromPayload(result).manualRemovalRequired).toBe(remaining !== 0);
    expect(fixture.selected.isConnected).toBe(false);
    expect(fixture.other.isConnected).toBe(true);
  });

  it("refuses a filename swapped between ownership proof and the first confirmation bind", async () => {
    const fixture = confirmationFixture();
    const clicked = vi.fn();
    fixture.cart.cart.addEventListener("click", clicked);
    let swapped = false;
    const result = await fixture.run(async (cleanup) => {
      fixture.cart.onFileNameRead((field) => {
        if (swapped || field.parentElement !== fixture.selected) return;
        // Return the original name to targets(), then reuse the same DOM rows.
        swapped = true;
        field.textContent = "other.step";
        fixture.other.querySelector(".cartInformationArea")!.textContent = "part.step";
      });
      await cleanup.click("confirmRemove", "part.step");
      return { removed: 1, remaining: 0 };
    });
    expect(swapped).toBe(true);
    expect(result.cartCleanup).toEqual({ status: "incomplete", removed: 0, remaining: null, reason: "manual_cleanup_required" });
    expect(clicked).not.toHaveBeenCalled();
    expect(fixture.selected.isConnected).toBe(true);
    expect(fixture.other.isConnected).toBe(true);
  });

  it("refuses the owned row's own remove control when another cleanup row is nested inside", async () => {
    const fixture = confirmationFixture();
    const clicked = vi.fn();
    fixture.selected.addEventListener("click", clicked);
    const result = await fixture.run(async (cleanup) => {
      fixture.selected.append(fixture.other);
      await cleanup.click("confirmRemove", "part.step");
      return { removed: 1, remaining: 0 };
    }, true, undefined, { cleanupRowFileName: ":scope > .cartInformationArea", cleanup: {
      confirmRemove: { selector: ":scope > button.confirm", scope: ".row" },
    } });
    expect(result.cartCleanup).toEqual({ status: "incomplete", removed: 0, remaining: null, reason: "manual_cleanup_required" });
    expect(clicked).not.toHaveBeenCalled();
    expect(fixture.selected.isConnected).toBe(true);
    expect(fixture.other.isConnected).toBe(true);
  });

  it.each([1, 2])("refuses %i page-global confirmations, leaving the other row intact", async (count) => {
    const fixture = confirmationFixture();
    if (count === 1) fixture.selected.querySelector("button.confirm")!.remove();
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("removePart", "part.step");
      await cleanup.click("confirmRemove");
      return { removed: 1, remaining: 0 };
    }, false);
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", reason: "manual_cleanup_required" });
    expect(fixture.selected.isConnected).toBe(true);
    expect(fixture.other.isConnected).toBe(true);
  });

  it("keeps a row-bound confirmation working when a second row's confirmation is present", async () => {
    const fixture = confirmationFixture();
    const result = await fixture.run(async (cleanup) => {
      expect(await cleanup.click("removePart", "part.step")).toBe(true);
      expect(await cleanup.click("confirmRemove", "part.step")).toBe(true);
      return { removed: 1, remaining: 0 };
    });
    expect(result.cartCleanup).toMatchObject({ status: "removed" });
    expect(fixture.selected.isConnected).toBe(false);
    expect(fixture.other.isConnected).toBe(true);
  });

  it.each(["other row", "replacement row", "reused row", "duplicate control", "ambiguous rows"])(
    "requires manual cleanup for %s", async (change) => {
      const fixture = confirmationFixture();
      const result = await fixture.run(async (cleanup) => {
        await cleanup.click("removePart", "part.step");
        if (change === "replacement row") fixture.selected.replaceWith(fixture.selected.cloneNode(true));
        if (change === "reused row") fixture.selected.querySelector(".cartInformationArea")!.textContent = "customer.step";
        if (change === "duplicate control") fixture.selected.append(fixture.selected.querySelector("button.confirm")!.cloneNode(true));
        await cleanup.click("confirmRemove", change === "other row" ? "other.step"
          : change === "reused row" ? "customer.step" : change === "ambiguous rows" ? undefined : "part.step");
        return { removed: 1, remaining: 0 };
      });
      expect(result.cartCleanup).toMatchObject({ status: "incomplete", reason: "manual_cleanup_required" });
      expect(fixture.cart.cart.children).toHaveLength(2);
      expect(fixture.other.isConnected).toBe(true);
    },
  );

  it.each(["renamed upload", "existing row targeted"])("rejects scope-only cleanup ownership: %s", async (change) => {
    const fixture = confirmationFixture();
    const customerName = change === "renamed upload" ? "part.step" : "other.step";
    fixture.other.querySelector(".cartInformationArea")!.textContent = customerName;
    if (change === "renamed upload") fixture.selected.querySelector(".cartInformationArea")!.textContent = "part (1).step";
    const click = vi.fn();
    fixture.other.addEventListener("click", click);
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("confirmRemove", customerName);
      return { removed: 1, remaining: 0 };
    });
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", reason: "manual_cleanup_required" });
    expect(click).not.toHaveBeenCalled();
    expect(fixture.other.isConnected).toBe(true);
    expect(fixture.selected.isConnected).toBe(true);
  });

  it("rejects a foreign control nested inside the owned row", async () => {
    const fixture = confirmationFixture();
    fixture.selected.querySelector("button.confirm")!.remove();
    const click = vi.fn();
    fixture.other.addEventListener("click", click);
    const result = await fixture.run(async (cleanup) => {
      fixture.selected.append(fixture.other);
      await cleanup.click("confirmRemove", "part.step");
      return { removed: 1, remaining: 0 };
    }, true, undefined, { cleanupRowFileName: ":scope > .cartInformationArea" });
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", reason: "manual_cleanup_required" });
    expect(click).not.toHaveBeenCalled();
    expect(fixture.other.isConnected).toBe(true);
    expect(fixture.selected.isConnected).toBe(true);
  });

  it.each(["missing field", "duplicate fields", "empty filename", "no filename selector", "no row selector"])(
    "refuses an in-page click with %s", async (condition) => {
      const fixture = confirmationFixture();
      const field = fixture.selected.querySelector(".cartInformationArea")!;
      if (condition === "missing field") field.className = "unknown";
      if (condition === "duplicate fields") fixture.selected.append(field.cloneNode(true));
      if (condition === "empty filename") field.textContent = "";
      const click = vi.fn();
      fixture.selected.addEventListener("click", click);
      const result = await fixture.run(async (cleanup) => {
        await cleanup.click("confirmRemove", condition === "empty filename" ? "confirm" : "part.step");
        return { removed: 1, remaining: 0 };
      }, true, undefined, condition === "no filename selector" ? { cleanupRowFileName: undefined }
        : condition === "no row selector" ? { cleanupRow: undefined } : {});
      expect(result.cartCleanup).toMatchObject({ status: "incomplete", reason: "manual_cleanup_required" });
      expect(click).not.toHaveBeenCalled();
      expect(fixture.selected.isConnected).toBe(true);
      expect(fixture.other.isConnected).toBe(true);
    },
  );

  it.each(["wrong row removed", "no removal", "other row replaced", "other row renamed", "selected row replaced", "ambiguous replacement filename", "both rows removed"])(
    "verifies the DOM after cleanup despite a successful hook count: %s", async (change) => {
      const fixture = confirmationFixture();
      const button = fixture.selected.querySelector("button.confirm")!;
      const replacement = button.cloneNode(true);
      button.replaceWith(replacement);
      replacement.addEventListener("click", () => {
        if (change === "wrong row removed" || change === "both rows removed") fixture.other.remove();
        if (change === "other row replaced") fixture.other.replaceWith(fixture.other.cloneNode(true));
        if (change === "other row renamed") fixture.other.querySelector(".cartInformationArea")!.textContent = "changed.step";
        if (change === "selected row replaced") fixture.selected.replaceWith(fixture.selected.cloneNode(true));
        if (change === "ambiguous replacement filename") {
          const row = fixture.selected.cloneNode(true) as Element;
          row.append(row.querySelector(".cartInformationArea")!.cloneNode(true));
          fixture.selected.replaceWith(row);
        }
        if (["other row replaced", "other row renamed", "both rows removed"].includes(change)) fixture.selected.remove();
      });
      const result = await fixture.run(async (cleanup) => {
        await cleanup.click("removePart", "part.step");
        await cleanup.click("confirmRemove", "part.step");
        return { removed: 1, remaining: 0 };
      });
      expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
    },
  );

  it("checks again after the hook returns, before reporting removal", async () => {
    const fixture = confirmationFixture();
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("confirmRemove", "part.step");
      fixture.other.remove();
      return { removed: 1, remaining: 0 };
    });
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
  });

  it("does not accept a claimed removal without a verified click", async () => {
    const fixture = confirmationFixture();
    const result = await fixture.run(async () => ({ removed: 1, remaining: 0 }));
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
    expect(fixture.selected.isConnected).toBe(true);
    expect(fixture.other.isConnected).toBe(true);
    expect(fixture.fake.context.newCDPSession).not.toHaveBeenCalled();
  });

  it.each([
    ['Delete "part.step"?', true],
    ['Remove part.step?', true],
    ['Are you sure you want to delete \'part.step\'?', true],
    ['Delete "other.step"?', false],
    ['Delete "customer-part.step"?', false],
    ['Delete "part.step.bak"?', false],
    ['Delete part.step and other.step?', false],
    ['Delete this part?', false],
  ])("binds native confirmation %s to the selected row (accept: %s)", async (message, accepted) => {
    const fixture = confirmationFixture();
    const dialog = {
      type: () => "confirm", message: () => message,
      accept: vi.fn(async () => { fixture.selected.remove(); }),
      dismiss: vi.fn(async () => undefined),
    };
    fixture.cart.onClick(async () => {
      fixture.cart.setModalOpen(true);
      const handler = vi.mocked(fixture.fake.page.on).mock.calls.find(([event]) => event === "dialog")?.[1];
      await handler?.(dialog);
      fixture.cart.setModalOpen(false);
    });
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("removePart", "part.step");
      return { removed: 1, remaining: 0 };
    });
    expect(dialog.accept).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(dialog.dismiss).toHaveBeenCalledTimes(accepted ? 0 : 1);
    expect(result.cartCleanup).toMatchObject(accepted ? { status: "removed" }
      : { status: "incomplete", reason: "manual_cleanup_required" });
    expect(fixture.other.isConnected).toBe(true);
  });

  it.each(["open", "closed"] as const)("refuses cleanup of a row containing a %s shadow host", async (mode) => {
    const fixture = confirmationFixture();
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("confirmRemove", "part.step");
      return { removed: 1, remaining: 0 };
    }, true, undefined, {}, { extractOffers: async () => {
      const host = fixture.selected.appendChild(fixture.selected.ownerDocument.createElement("div"));
      host.attachShadow({ mode }).append(fixture.other);
      return [candidate()];
    } });
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
    expect(fixture.selected.isConnected).toBe(true);
    expect(fixture.other.isConnected).toBe(true);
  });

  it("refuses cleanup when the owned row is inside a customer row", async () => {
    const fixture = confirmationFixture();
    const result = await fixture.run(async (cleanup) => {
      fixture.other.append(fixture.selected);
      await cleanup.click("confirmRemove", "part.step");
      return { removed: 1, remaining: 0 };
    }, true, undefined, { cleanupRowFileName: ":scope > .cartInformationArea",
      cleanup: { confirmRemove: { selector: "button.confirm", scope: ".row", uploadedRows: true } } });
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
    expect(fixture.selected.isConnected).toBe(true);
    expect(fixture.other.isConnected).toBe(true);
  });

  it("accepts only one native dialog per click, dismissing and reporting the extra", async () => {
    const fixture = confirmationFixture();
    const dialogs = [fixture.selected, fixture.other].map((row) => ({
      type: () => "confirm", message: () => "Delete part.step?",
      accept: vi.fn(async () => { row.remove(); }), dismiss: vi.fn(async () => undefined),
    }));
    fixture.cart.onClick(async () => {
      fixture.cart.setModalOpen(true);
      const handler = vi.mocked(fixture.fake.page.on).mock.calls.find(([event]) => event === "dialog")?.[1];
      for (const dialog of dialogs) await handler?.(dialog);
      fixture.cart.setModalOpen(false);
    });
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("removePart", "part.step");
      return { removed: 1, remaining: 0 };
    });
    expect(dialogs[0].accept).toHaveBeenCalledTimes(1);
    expect(dialogs[1].accept).not.toHaveBeenCalled();
    expect(dialogs[1].dismiss).toHaveBeenCalledTimes(1);
    expect(fixture.other.isConnected).toBe(true);
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
  });

  it.each(["open", "closed", "unavailable", "creation failed", "detach failed", "user-agent"])("requires browser shadow visibility evidence: %s", async (evidence) => {
    const fixture = confirmationFixture();
    const detach = vi.fn(async () => {
      if (evidence === "detach failed") throw new Error("Detach failed");
    });
    const send = vi.fn(async () => {
      if (evidence === "unavailable") throw new Error("Protocol unavailable");
      return { root: { children: [{ shadowRoots: [{ shadowRootType: evidence }] }] } };
    });
    vi.mocked(fixture.fake.context.newCDPSession).mockResolvedValue({
      send, detach,
    } as unknown as CDPSession);
    if (evidence === "creation failed") {
      vi.mocked(fixture.fake.context.newCDPSession).mockRejectedValue(new Error("CDP unsupported"));
    }
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("confirmRemove", "part.step");
      return { removed: 1, remaining: 0 };
    });
    expect(result.cartCleanup).toMatchObject(evidence === "user-agent" ? { status: "removed", removed: 1 }
      : { status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
    expect(fixture.selected.isConnected).toBe(evidence !== "user-agent");
    expect(fixture.other.isConnected).toBe(true);
    const checks = evidence === "user-agent" ? 2 : 1;
    expect(fixture.fake.context.newCDPSession).toHaveBeenCalledTimes(checks);
    expect(detach).toHaveBeenCalledTimes(evidence === "creation failed" ? 0 : checks);
    if (evidence !== "creation failed") {
      expect(send).toHaveBeenCalledTimes(checks);
      expect(send).toHaveBeenCalledWith("DOM.getDocument", { depth: -1, pierce: true });
    }
  });

  it("does not open CDP for a report-only cleanup hook", async () => {
    const fixture = confirmationFixture();
    await fixture.run(async () => ({ removed: 0, remaining: 1 }));
    expect(fixture.fake.context.newCDPSession).not.toHaveBeenCalled();
  });

  it.each(["'", '"'])("does not interpret another row's literal %s quotes as prompt formatting", async (quote) => {
    const fixture = confirmationFixture();
    fixture.other.querySelector(".cartInformationArea")!.textContent = `${quote}part.step${quote}`;
    const dialog = {
      type: () => "confirm", message: () => `Delete ${quote}part.step${quote}?`,
      accept: vi.fn(async () => { fixture.other.remove(); }), dismiss: vi.fn(async () => undefined),
    };
    fixture.cart.onClick(async () => {
      const handler = vi.mocked(fixture.fake.page.on).mock.calls.find(([event]) => event === "dialog")?.[1];
      await handler?.(dialog);
    });
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("removePart", "part.step");
      return { removed: 1, remaining: 0 };
    }, true, undefined, { cleanup: { removePart: { selector: "button.remove", scope: ".row", uploadedRows: true } } });
    expect(dialog.accept).not.toHaveBeenCalled();
    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(fixture.other.isConnected).toBe(true);
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, reason: "manual_cleanup_required" });
  });

  it.each(["missing filename", "duplicate filename field", "no active click", "alert"])(
    "dismisses a native dialog with %s", async (condition) => {
      const fixture = confirmationFixture();
      const field = fixture.selected.querySelector(".cartInformationArea")!;
      if (condition === "missing filename") field.className = "unknown-file-field";
      if (condition === "duplicate filename field") fixture.selected.append(field.cloneNode(true));
      const dialog = {
        type: () => condition === "alert" ? "alert" : "confirm", message: () => 'Delete "part.step"?',
        accept: vi.fn(async () => { fixture.other.remove(); }),
        dismiss: vi.fn(async () => undefined),
      };
      const emitDialog = async () => {
        const handler = vi.mocked(fixture.fake.page.on).mock.calls.find(([event]) => event === "dialog")?.[1];
        await handler?.(dialog);
      };
      if (condition !== "no active click") fixture.cart.onClick(emitDialog);
      const result = await fixture.run(async (cleanup) => {
        await cleanup.click("removePart", "part.step");
        if (condition === "no active click") await emitDialog();
        return { removed: 1, remaining: 0 };
      });
      expect(dialog.accept).not.toHaveBeenCalled();
      expect(dialog.dismiss).toHaveBeenCalledTimes(
        condition === "missing filename" || condition === "duplicate filename field" ? 0 : 1,
      );
      expect(result.cartCleanup).toMatchObject({ status: "incomplete", reason: "manual_cleanup_required" });
      expect(fixture.other.isConnected).toBe(true);
    },
  );

  it.each([
    [0, false], [1, false], [2, false], [0, true],
  ])("OSH Cut checks %i initial rows (late row: %s) before any mutation", async (rowCount, lateRow) => {
    const fake = fakeBrowser({ bodyText: rowCount ? "Select material" : "Upload parts" });
    const cart = cartFixture(Array.from({ length: rowCount }, () => "existing.step"));
    const quantity = cart.cart.ownerDocument.createElement("input");
    quantity.value = "12";
    cart.cart.firstElementChild?.append(quantity);
    let before = cart.cart.innerHTML;
    const originalLocator = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => {
      if (selector === OSHCUT_CART_ROW) return cart.locator;
      if (selector === "html") return cart.root;
      if (selector === OSHCUT_PRODUCTION_LOCATORS.singlePrice) return { allInnerTexts: async () => ["$20.00"] } as unknown as Locator;
      if (selector === OSHCUT_PRODUCTION_LOCATORS.extendedPrice) return { allInnerTexts: async () => ["$100.00"] } as unknown as Locator;
      return originalLocator(selector);
    });
    fake.setInputFiles.mockImplementation(async () => { cart.append("part.step"); });
    fake.fill.mockImplementation(async (value: string) => { quantity.value = value; });
    const def = buildOshcutProductionPortalDefinition({ controlWaitMs: 0, priceWaitMs: 0 });
    const quoteInput = await input();
    quoteInput.requirement = {
      ...quoteInput.requirement, material: "Aluminum 6061-T6",
      spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet", sheetThicknessInch: 0.125 },
    };
    quoteInput.providerPortalApproval = buildExpectedProviderPortalApproval(def, quoteInput)!;
    if (lateRow) quoteInput.beforeProviderDisclosure = async () => {
      cart.append("late-existing.step").append(quantity);
      before = cart.cart.innerHTML;
    };
    const run = runProviderPortalKernel(def, {
      ...config(), vendorStorageStateJson: { oshcut: JSON.stringify({ cookies: [], origins: [] }) },
    }, quoteInput, { launchBrowser: async () => fake.browser, captureEvidence: async () => [] });
    await expect(run).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    expect(fake.page.goto).not.toHaveBeenCalled();
    expect(fake.setInputFiles).not.toHaveBeenCalled();
    expect(fake.fill).not.toHaveBeenCalled();
    expect(fake.click).not.toHaveBeenCalled();
    expect(fake.selectOption).not.toHaveBeenCalled();
    expect(cart.cart.innerHTML).toBe(before);
    expect(quantity.value).toBe("12");
    expect(cart.removeClicks).not.toHaveBeenCalled();
  });

  it.each([
    ["filename collisions", ["part.step", "customer-part.step"], true, false, false, "incomplete", 0, 1],
    ["unrelated rows", ["customer-bracket.dxf"], true, false, false, "incomplete", 0, 1],
    ["missing remove control", ["customer-bracket.dxf"], false, false, false, "incomplete", 0, 1],
    ["no uploaded row", ["customer-bracket.dxf"], true, false, true, "not_found", 0, 0],
    ["replaced pre-existing rows", ["part.step", "customer-part.step"], true, true, false, "failed", 0, null],
  ] as const)("reports candidates without deleting any row: %s", async (_name, names, removable, rerender, noUpload, status, removed, remaining) => {
    const fake = fakeBrowser();
    const cart = cartFixture([...names]);
    const originalLocator = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => selector === OSHCUT_CART_ROW
      ? cart.locator : selector === "html" ? cart.root : originalLocator(selector));
    fake.setInputFiles.mockImplementation(async () => {
      if (rerender) cart.cart.replaceChildren(...[...cart.cart.children].map((row) => row.cloneNode(true)));
      if (!noUpload) cart.append("part.step", removable);
    });
    const def = cleanupDefinition(async (cleanup) => reportOshcutCartCleanup(await cleanup.count("partRow")));
    def.selectors = { ...def.selectors, cleanupRow: OSHCUT_CART_ROW, cleanupRowFileName: OSHCUT_CART_FILE_NAME, cleanup: OSHCUT_CART_CLEANUP_SELECTORS };
    const result = await runProviderPortalKernel(def, config(), await input(), {
      launchBrowser: async () => fake.browser, captureEvidence: async () => [],
    });
    expect(result.cartCleanup).toMatchObject({ status, removed, remaining });
    expect(cart.removeClicks).not.toHaveBeenCalled();
    expect(fake.click).not.toHaveBeenCalled();
    expect(vi.mocked(fake.page.on).mock.calls.some(([event]) => event === "dialog")).toBe(false);
    expect([...cart.cart.children].map((row) => row.querySelector(".cartInformationArea")!.textContent))
      .toEqual([...names, ...(!noUpload ? ["part.step"] : [])]);
  });

  it.each([
    ["late unrelated row", ["part.step", "customer-bracket.dxf"]],
    ["two similar names", ["part.step", "customer-part.step"]],
    ["duplicate exact names", ["part.step", "part.step"]],
    ["substring prefix", ["customer-part.step"]],
    ["substring suffix", ["part.step.backup"]],
    ["case mismatch", ["PART.step"]],
    ["leading whitespace mismatch", [" part.step"]],
    ["trailing whitespace mismatch", ["part.step "]],
    ["single exact name", ["part.step"]],
  ])("reports all new rows for manual cleanup: %s", async (_case, names) => {
    const fake = fakeBrowser();
    const cart = cartFixture(["existing-customer.step"]);
    const originalLocator = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => selector === OSHCUT_CART_ROW
      ? cart.locator : selector === "html" ? cart.root : originalLocator(selector));
    fake.setInputFiles.mockImplementation(async () => { if (names[0]) cart.append(names[0]); });
    const def = cleanupDefinition(async (cleanup) => reportOshcutCartCleanup(await cleanup.count("partRow")), {
      // Arrives after upload, before cleanup's first lookup: either a delayed
      // pre-existing customer row or a concurrent session's new part.
      extractOffers: async () => { names.slice(1).forEach((name) => cart.append(name)); return [candidate()]; },
    });
    def.selectors = { ...def.selectors, cleanupRow: OSHCUT_CART_ROW, cleanupRowFileName: OSHCUT_CART_FILE_NAME, cleanup: OSHCUT_CART_CLEANUP_SELECTORS };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runProviderPortalKernel(def, config(), await input(), {
      launchBrowser: async () => fake.browser, captureEvidence: async () => [],
    });
    const report = {
      status: "incomplete", removed: 0, remaining: names.length,
      reason: "manual_cleanup_required", manualCleanupRows: names.map((fileName) => ({ fileName })),
    };
    expect(result.cartCleanup).toEqual(report);
    expect(supplierCartCleanupFromPayload({ cartCleanup: result.cartCleanup })).toMatchObject({
      manualRemovalRequired: true, remaining: names.length,
    });
    expect(fake.click).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject(report);
    expect(cart.removeClicks).not.toHaveBeenCalled();
    expect([...cart.cart.children].map((row) => row.querySelector(".cartInformationArea")!.textContent))
      .toEqual(["existing-customer.step", ...names]);
  });

  it.each(["nested suffix", "mixed control text", "missing filename field"])("refuses an unproven filename field: %s", async (change) => {
    const fake = fakeBrowser();
    const cart = cartFixture([]);
    const originalLocator = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => selector === OSHCUT_CART_ROW
      ? cart.locator : selector === "html" ? cart.root : originalLocator(selector));
    fake.setInputFiles.mockImplementation(async () => {
      const row = cart.append("part.step");
      row.querySelector(".cartInformationArea")!.insertAdjacentHTML("beforeend",
        change === "nested suffix" ? "<span>.backup</span>" : "<span>Select material</span>");
    });
    const def = cleanupDefinition(async (cleanup) => reportOshcutCartCleanup(await cleanup.count("partRow")));
    def.selectors = { ...def.selectors, cleanupRow: OSHCUT_CART_ROW,
      cleanupRowFileName: change === "missing filename field" ? ".missing" : OSHCUT_CART_FILE_NAME,
      cleanup: OSHCUT_CART_CLEANUP_SELECTORS };
    const result = await runProviderPortalKernel(def, config(), await input(), {
      launchBrowser: async () => fake.browser, captureEvidence: async () => [],
    });
    expect(result.cartCleanup).toMatchObject({ status: "incomplete", removed: 0, remaining: 1, reason: "manual_cleanup_required" });
    expect(cart.removeClicks).not.toHaveBeenCalled();
  });

  it("reports a late customer filename match after upload fails without creating a row", async () => {
    const fake = fakeBrowser();
    const cart = cartFixture([]);
    const originalLocator = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => selector === OSHCUT_CART_ROW
      ? cart.locator : selector === "html" ? cart.root : originalLocator(selector));
    fake.setInputFiles.mockImplementation(async () => {
      cart.append("part.step"); // A delayed customer row, not this failed upload.
      throw new Error("Upload failed");
    });
    const def = cleanupDefinition(async (cleanup) => reportOshcutCartCleanup(await cleanup.count("partRow")));
    def.selectors = { ...def.selectors, cleanupRow: OSHCUT_CART_ROW,
      cleanupRowFileName: OSHCUT_CART_FILE_NAME, cleanup: OSHCUT_CART_CLEANUP_SELECTORS };
    await expect(runProviderPortalKernel(def, config(), await input(), {
      launchBrowser: async () => fake.browser, captureEvidence: async () => [],
    })).rejects.toMatchObject({ payload: { cartCleanup: {
      status: "incomplete", removed: 0, remaining: 1, reason: "manual_cleanup_required",
      manualCleanupRows: [{ fileName: "part.step" }],
    } } });
    expect(cart.cart.children).toHaveLength(1);
    expect(cart.removeClicks).not.toHaveBeenCalled();
    expect(fake.click).not.toHaveBeenCalled();
    expect(vi.mocked(fake.page.on).mock.calls.some(([event]) => event === "dialog")).toBe(false);
  });

  it.each(["partRow", "removePart", "confirmRemove"])("blocks an accidental OSH Cut cleanup click on %s", async (field) => {
    const fake = fakeBrowser();
    const cart = cartFixture([]);
    const originalLocator = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => selector === OSHCUT_CART_ROW
      ? cart.locator : selector === "html" ? cart.root : originalLocator(selector));
    const def = cleanupDefinition(async (cleanup) => {
      await cleanup.click(field);
      return { removed: 1, remaining: 0 };
    });
    def.selectors = { ...def.selectors, cleanupRow: OSHCUT_CART_ROW,
      cleanupRowFileName: OSHCUT_CART_FILE_NAME, cleanup: OSHCUT_CART_CLEANUP_SELECTORS };
    const result = await runProviderPortalKernel(def, config(), await input(), {
      launchBrowser: async () => fake.browser, captureEvidence: async () => [],
    });
    expect(result.cartCleanup).toMatchObject({ status: "failed", removed: 0 });
    expect(fake.click).not.toHaveBeenCalled();
    expect(vi.mocked(fake.page.on).mock.calls.some(([event]) => event === "dialog")).toBe(false);
  });

  it.each(["document replacement", "candidate row replacement"])("fails closed after an empty snapshot and %s", async (change) => {
    const fake = fakeBrowser();
    const cart = cartFixture([]);
    const originalLocator = vi.mocked(fake.page.locator).getMockImplementation()!;
    vi.mocked(fake.page.locator).mockImplementation((selector) => selector === OSHCUT_CART_ROW
      ? cart.locator : selector === "html" ? cart.root : originalLocator(selector));
    fake.setInputFiles.mockImplementation(async () => {
      if (change === "document replacement") cart.cart.ownerDocument.documentElement.remove();
      const row = cart.append("part.step");
      // Simulate a framework rerender without any provider-side deletion.
      if (change === "candidate row replacement") row.replaceWith(row.cloneNode(true));
    });
    const def = cleanupDefinition(async (cleanup) => reportOshcutCartCleanup(await cleanup.count("partRow")));
    def.selectors = { ...def.selectors, cleanupRow: OSHCUT_CART_ROW, cleanupRowFileName: OSHCUT_CART_FILE_NAME, cleanup: OSHCUT_CART_CLEANUP_SELECTORS };
    const result = await runProviderPortalKernel(def, config(), await input(), {
      launchBrowser: async () => fake.browser, captureEvidence: async () => [],
    });
    expect(result.cartCleanup).toMatchObject(change === "document replacement"
      ? { status: "failed", remaining: null }
      : { status: "incomplete", remaining: 1, reason: "manual_cleanup_required" });
    expect(cart.cart.querySelector(".cartInformationArea")!.textContent).toBe("part.step");
  });

  it("applies scopeText to a rule without scope", async () => {
    const fake = fakeBrowser();
    await runProviderPortalKernel(cleanupDefinition(async (cleanup) => {
      await cleanup.count("partRow", "part.step");
      return { removed: 0, remaining: 0 };
    }), config(), await input(), { launchBrowser: async () => fake.browser, captureEvidence: async () => [] });
    expect(fake.filter).toHaveBeenCalledWith({ hasText: "part.step" });
  });

  it.each(["removePart", "confirmRemove"])("stops before the next %s when killed after removal", async (next) => {
    const fixture = confirmationFixture();
    let engaged = false;
    const click = vi.fn(async () => { engaged = true; });
    fixture.cart.onClick(click);
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("removePart", "part.step");
      await cleanup.click(next, "part.step");
      return { removed: 1, remaining: 0 };
    }, true, async (checkpoint) => {
      if (engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "quickparts", checkpoint);
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(result.cartCleanup).toMatchObject({ status: "skipped_kill_switch" });
  });

  it("checks the kill switch again before accepting a native confirmation", async () => {
    const fixture = confirmationFixture();
    let engaged = false;
    const dialog = { accept: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
    fixture.cart.onClick(async () => {
      engaged = true;
      const handler = vi.mocked(fixture.fake.page.on).mock.calls.find(([event]) => event === "dialog")?.[1];
      await handler?.(dialog);
    });
    const result = await fixture.run(async (cleanup) => {
      await cleanup.click("removePart", "part.step");
      return { removed: 1, remaining: 0 };
    }, true, async (checkpoint) => {
      if (engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "quickparts", checkpoint);
    });
    expect(dialog.accept).not.toHaveBeenCalled();
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(result.cartCleanup).toMatchObject({ status: "skipped_kill_switch" });
  });

  it("also cleans up after a failure that followed upload, keeping the original error", async () => {
    const fixture = confirmationFixture();
    const cleanup = vi.fn(async (capability: Parameters<NonNullable<ProviderPortalDefinition["hooks"]["cleanup"]>>[0]) => {
      await capability.click("confirmRemove", "part.step");
      return { removed: 1, remaining: 0 };
    });
    await expect(fixture.run(cleanup, true, undefined, {}, {
      configure: async () => { throw new Error("portal broke"); },
    })).rejects.toMatchObject({
      payload: {
        terminalState: "selector_drift",
        reason: "ambiguous_provider_mutation",
        cartCleanup: { status: "removed", removed: 1 },
      },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.other.isConnected).toBe(true);
  });

  it("logs a cleanup failure without changing the result", async () => {
    const fake = fakeBrowser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runProviderPortalKernel(cleanupDefinition(async () => {
      throw new Error("remove control vanished");
    }), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    });
    expect(result).toMatchObject({
      state: "offers_extracted",
      offers: [expect.objectContaining({ providerOptionId: "economy-7d" })],
      cartCleanup: { status: "failed", reason: "Error" },
    });
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({ level: "warn", status: "failed" });
  });

  it("bounds a hanging cleanup and reports it as failed", async () => {
    const fake = fakeBrowser();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runProviderPortalKernel(cleanupDefinition(() => new Promise(() => undefined)), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
      cleanupTimeoutMs: 20,
    });
    expect(result).toMatchObject({ state: "offers_extracted", cartCleanup: { status: "failed", reason: "Error" } });
  });

  it("reports parts left behind as incomplete", async () => {
    const fake = fakeBrowser();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runProviderPortalKernel(cleanupDefinition(async () => ({ removed: 0, remaining: 1 })), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    });
    expect(result.cartCleanup).toEqual({ status: "incomplete", removed: 0, remaining: 1, reason: null });
  });

  it("does not run when nothing was uploaded", async () => {
    const fake = fakeBrowser({ uploadCount: 0 });
    const cleanup = vi.fn(async () => ({ removed: 0, remaining: 0 }));
    const result = await runProviderPortalKernel(cleanupDefinition(cleanup), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    });
    expect(result).toMatchObject({ state: "selector_drift", reason: "cad_upload_selector_missing" });
    expect(result.cartCleanup).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("skips cleanup while the kill switch is engaged", async () => {
    const fake = fakeBrowser();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cleanup = vi.fn(async () => ({ removed: 1, remaining: 0 }));
    let engaged = false;
    const engagedAfterExtract = Object.assign(await input(), {
      providerKillSwitchCheckpoint: async (checkpoint: "before_navigation" | "before_upload" | "before_configure") => {
        if (engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "quickparts", checkpoint);
      },
    });
    const result = await runProviderPortalKernel(cleanupDefinition(cleanup, {
      extractOffers: async () => { engaged = true; return [candidate()]; },
    }), config(), engagedAfterExtract, {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    });
    expect(result.cartCleanup).toMatchObject({ status: "skipped_kill_switch" });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["an undeclared field", "checkoutButton", undefined],
    ["checkout-like scope text", "removePart", "Proceed to checkout"],
  ])("refuses a cleanup click on %s", async (_name, field, scopeText) => {
    const fake = fakeBrowser();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runProviderPortalKernel(cleanupDefinition(async (cleanup) => {
      await cleanup.click(field, scopeText);
      return { removed: 1, remaining: 0 };
    }), config(), await input(), {
      launchBrowser: vi.fn(async () => fake.browser),
      captureEvidence: async () => [],
    });
    expect(result.cartCleanup).toMatchObject({ status: "failed", reason: "undeclared_cleanup_operation" });
    expect(fake.click).not.toHaveBeenCalled();
  });

  it("refuses a definition whose cleanup selector aims at checkout", async () => {
    const unsafe = definition({
      selectors: { ...definition().selectors, cleanup: { removePart: { selector: "button.checkout" } } },
    });
    await expect(runProviderPortalKernel(unsafe, config(), await input(), { launchBrowser: vi.fn() }))
      .rejects.toThrow(/prohibited cleanup selector/);
  });
});

describe("provider portal pre-upload classification (OVD-1056)", () => {
  it("classifies the page as the beforeUpload hook left it, not the pre-hook snapshot", async () => {
    // The fake page reads its body text lazily, so the hook can change what the page shows.
    const options = { bodyText: "LOGIN" };
    const fake = fakeBrowser(options);
    const classify = vi.fn((snapshot: Parameters<typeof classifyProviderPortalSnapshot>[0]) =>
      classifyProviderPortalSnapshot(snapshot));
    const settled = definition({
      hooks: {
        ...definition().hooks,
        // A session guard that waits for the header to hydrate: the login link disappears.
        beforeUpload: async () => { options.bodyText = "quote portal"; },
        classifyPortalState: classify,
      },
    });
    const result = await runProviderPortalKernel(settled, config(), await input(), {
      launchBrowser: async () => fake.browser,
      captureEvidence: async () => [],
    });
    expect(classify.mock.calls[0]?.[0]?.bodyText).toBe("quote portal");
    expect(classify.mock.calls.map(([snapshot]) => snapshot.bodyText)).not.toContain("LOGIN");
    expect(result.state).toBe("offers_extracted");
  });
});
