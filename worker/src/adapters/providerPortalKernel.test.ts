// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  captureScrubbedProviderEvidence,
  buildExpectedProviderPortalApproval,
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
} from "./providerPortalKernel";

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

function fakeBrowser(options: {
  redirectedUrl?: string;
  bodyText?: string;
  uploadCount?: number;
  uploadFailure?: Error;
  popupDuringRead?: boolean;
  navigateDuringRead?: string;
  popupDuringCountAt?: number;
  navigateDuringCountAt?: number;
  requestDuringUpload?: string;
  webSocketDuringUpload?: string;
} = {}) {
  let currentUrl = "about:blank";
  const pageListeners = new Map<string, Array<(value: unknown) => void>>();
  const contextListeners = new Map<string, Array<(value: unknown) => void>>();
  const emit = (listeners: Map<string, Array<(value: unknown) => void>>, event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(value);
    }
  };
  let requestRouteHandler: ((route: {
    request: () => { url: () => string };
    abort: (reason: string) => Promise<void>;
    continue: () => Promise<void>;
  }) => Promise<void>) | null = null;
  let webSocketRouteHandler: ((route: {
    url: () => string;
    close: (options: { code: number; reason: string }) => Promise<void>;
    connectToServer: () => unknown;
  }) => Promise<void>) | null = null;
  const requestRoute = {
    request: () => ({ url: () => options.requestDuringUpload ?? "https://quickquote.quickparts.com/upload" }),
    abort: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined),
  };
  const webSocketRoute = {
    url: () => options.webSocketDuringUpload ?? "wss://quickquote.quickparts.com/socket",
    close: vi.fn(async () => undefined),
    connectToServer: vi.fn(() => undefined),
  };
  const setInputFiles = vi.fn(async () => {
    if (options.uploadFailure) {
      throw options.uploadFailure;
    }
    if (options.requestDuringUpload && requestRouteHandler) {
      await requestRouteHandler(requestRoute);
    }
    if (options.webSocketDuringUpload && webSocketRouteHandler) {
      await webSocketRouteHandler(webSocketRoute);
    }
  });
  const fill = vi.fn(async () => undefined);
  const selectOption = vi.fn(async () => undefined);
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
  const mainFrame = { url: vi.fn(() => currentUrl) };
  const page = {
    goto: vi.fn(async (url: string) => {
      currentUrl = options.redirectedUrl ?? url;
      return null;
    }),
    url: vi.fn(() => currentUrl),
    locator: vi.fn((selector: string) => {
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
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      pageListeners.set(event, [...(pageListeners.get(event) ?? []), listener]);
      return page;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  const context = {
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
    webSocketRoute,
    setInputFiles,
    fill,
    selectOption,
  };
}

describe("provider portal kernel admission", () => {
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
    const fake = fakeBrowser({ requestDuringUpload: "https://malicious.example/collect" });
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
    )).resolves.toMatchObject({ state: "offers_extracted" });
    expect(fake.requestRoute.continue).toHaveBeenCalledOnce();
    expect(fake.requestRoute.abort).not.toHaveBeenCalled();
    expect(fake.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({
      serviceWorkers: "block",
    }));
  });

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
          expect((configuration as unknown as { click?: unknown }).click).toBeUndefined();
          expect((configuration as unknown as { goto?: unknown }).goto).toBeUndefined();
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
      ["fill", "select"],
      ["count", "readAttribute", "readText", "readTexts"],
    ]);
    expect(fake.selectOption).toHaveBeenCalledWith("6061");
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
