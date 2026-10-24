// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideProviderUploadCapability } from "../providerUploadCapability.js";
import { createXometryUploadCapabilityCheckpoint } from "../xometryUploadAdmission.js";
import type { ProviderUploadCapabilityDecision, ProviderUploadCapabilityObserved } from "../providerUploadCapabilityTypes.js";

const {
  camoufoxMock,
  camoufoxLaunchOptionsMock,
  launchMock,
  launchPersistentContextMock,
  persistSnapshotMock,
  restoreSnapshotMock,
  playwrightLaunchMock,
  playwrightLaunchPersistentContextMock,
  loadCamoufoxIdentityMock,
} =
  vi.hoisted(() => ({
    camoufoxMock: vi.fn(),
    camoufoxLaunchOptionsMock: vi.fn(),
    launchMock: vi.fn(),
    launchPersistentContextMock: vi.fn(),
    persistSnapshotMock: vi.fn(),
    restoreSnapshotMock: vi.fn(),
    playwrightLaunchMock: vi.fn(),
    playwrightLaunchPersistentContextMock: vi.fn(),
    loadCamoufoxIdentityMock: vi.fn(),
  }));

vi.mock("../camoufoxAssets.js", () => ({ assertCamoufoxAssetsPresent: vi.fn() }));
vi.mock("camoufox-js", () => ({
  Camoufox: camoufoxMock,
  launchOptions: camoufoxLaunchOptionsMock,
}));

vi.mock("../camoufoxPersistentContext.js", () => ({
  launchPersistentCamoufox: async (input: Record<string, unknown>) => ({
    context: await camoufoxMock(input),
    identityConfig: input.identityConfig,
  }),
}));

vi.mock("../xometryProfileSnapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../xometryProfileSnapshot.js")>()),
  persistXometryProfileSnapshot: persistSnapshotMock,
  restoreXometryProfileSnapshot: restoreSnapshotMock,
}));

vi.mock("../camoufoxProfileIdentity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../camoufoxProfileIdentity.js")>()),
  loadCamoufoxLaunchIdentity: loadCamoufoxIdentityMock,
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

import {
  VendorAutomationError,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
  type WorkerConfig,
} from "../types";
import { sha256File } from "../liveEvaluationFiles";
import {
  createProviderMutationPhase,
  runInProviderMutationPhase,
} from "../providerMutationPhase";
import { isRetryableVendorTaskError } from "../vendorTaskRetry";
import { XometryDispatchAuthorizationError } from "../xometryDispatchPreflight";
import { ExportControlLookupError } from "../exportControl";
import { ProviderKillSwitchError } from "../providerKillSwitch";
import { OperationalJevSession, OperationalJevObservations } from "../jev/operationalSession";
import { JEV_MODEL } from "../jev/choice";
import { buildAdapterRegistry, buildLiveEvaluationAdapterRegistry } from "./index";
import { XOMETRY_PROFILE_LOCK_SIDECAR_SUFFIX } from "./persistentProfileLock";
import {
  evaluateProviderAdapterContract,
  evaluateProviderAdapterFailureContract,
} from "./providerAdapterContract";
import anonymousQuoteHome from "./fixtures/xometry-anonymous-quote-home.json";
import {
  XometryAdapter,
  chooseOptionByTerms,
  detectBlockingStateSignal,
  hasVisibleFilename,
  isManualReviewText,
  isXometryPricingInProgress,
  parseFirstCurrency,
  parseLeadTime,
  resolveXometryCompatibilityLeadTime,
  selectToleranceTier,
  setQuantity,
  toleranceSummaryMatches,
  uploadInputAcceptsFile,
  xometryPriceTiersSettled,
} from "./xometry";
import {
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  buildMaterialSummaryTerms,
} from "./xometryConstraints";
import { collectXometryOffers, parseXometryOfferSnapshots } from "./xometryOffers";

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

async function passingUploadCapabilityCheckpoint(): Promise<ProviderUploadCapabilityDecision> {
  return {
    contractVersion: "provider-upload-capability.v1",
    classification: "matches_policy",
    allowedExtensions: ["step", "stp", "sldprt", "igs", "iges"],
    reportedAddedExtensions: [],
    reportedRemovedExtensions: [],
    evidenceRefs: [],
    normalizedObservedMimeTypes: [],
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
    // Adapter-level stub of the injected dependency. Production supplies the
    // real one in quoteWithRoutedDispatchPreflight (see dispatchRouting tests).
    uploadCapabilityCheckpoint: passingUploadCapabilityCheckpoint,
    ...overrides,
  };
}

async function makeLiveEvaluationInput(
  overrides: Partial<VendorQuoteAdapterInput> = {},
): Promise<VendorQuoteAdapterInput> {
  const baseInput = makeInput();
  const tempDir = await makeTempDir();
  const localPath = path.join(tempDir, "part.step");
  await fs.writeFile(localPath, "evaluation-cad-bytes");
  const cadFileSha256 = await sha256File(localPath);
  return makeInput({
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: {
      nonExportControlled: true,
      cadFileSha256,
      drawingFileSha256: null,
    },
    stagedCadFile: baseInput.stagedCadFile
      ? {
          ...baseInput.stagedCadFile,
          localPath,
          trustedContentSha256: cadFileSha256,
        }
      : null,
    xometryDispatchAuthorization: undefined,
    ...overrides,
  });
}

function makeLiveEvaluationAdapter(config: WorkerConfig) {
  const adapter = buildLiveEvaluationAdapterRegistry({
    ...config,
    workerLiveAdapters: ["xometry"],
  }).xometry;
  if (!adapter) {
    throw new Error("Xometry evaluation adapter is not enabled.");
  }
  return adapter;
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

/** The selector the collector reads a tier card's part card with (the child of #draggable-parts around it). */
const PART_CARD_XPATH = 'xpath=ancestor::*[parent::*[@id="draggable-parts"]]';
/** The selector the collector reads a tier card's enclosing elements with, up to and including its part card. */
const PART_CARD_ANCESTORS_XPATH = 'xpath=ancestor::*[ancestor-or-self::*[parent::*[@id="draggable-parts"]]]';

type LocatorBehavior = {
  count?: number | (() => number);
  text?: string | (() => string);
  setInputFiles?: (files: unknown) => Promise<void> | void;
  click?: () => Promise<void> | void;
  fill?: (value: string) => Promise<void> | void;
  press?: (value: string) => Promise<void> | void;
  inputValue?: () => Promise<string> | string;
  waitFor?: () => Promise<void> | void;
  getAttribute?: (name: string) => Promise<string | null> | string | null;
  dataTestId?: string | null;
  isChecked?: () => Promise<boolean> | boolean;
  isEnabled?: () => Promise<boolean> | boolean;
  /** Runs a locator.evaluate page function against this element. */
  evaluate?: (pageFunction: (element: Element) => unknown) => unknown;
  /** Distinct matches returned by nth(index); count follows their length. */
  items?: LocatorBehavior[];
  /** Behaviors for selectors scoped under this locator; undefined keeps the default part card. */
  children?: Record<string, LocatorBehavior> | ((selector: string) => LocatorBehavior | undefined);
};

type FakePageOptions = {
  bodyText: string | (() => string);
  postSaveBodyText?: string | (() => string);
  url?: string;
  selectorBehaviors?: Record<string, LocatorBehavior>;
  optionTexts?: string[] | (() => string[]);
  onOptionWait?: (name?: RegExp) => Promise<void> | void;
  onOptionClick?: (text: string) => void;
  dashboardRedirectUrl?: string;
  dashboardNavigationFails?: boolean;
  gotoRedirectUrl?: string;
  routeChangeAfterAcceptUrl?: string;
  uploadRedirectUrl?: string;
  delayedUploadRedirectUrl?: string;
  delayedUploadRedirectAfterTimeouts?: number;
  modalSubmitRedirectUrl?: string;
  saveRedirectUrl?: string;
  quoteNavigationFails?: boolean;
  saveNavigationFails?: boolean;
  reloadFails?: boolean;
  screenshotFails?: boolean;
  contentFails?: boolean;
  waitForFunctionAttempts?: number;
  responseWaitDelayMs?: number;
  visibleFilenames?: string[];
  responses?: Array<{
    method: string;
    url: string;
    status: number;
    body?: unknown;
  }>;
};

function makeLocator(behavior: LocatorBehavior = {}): ReturnType<typeof makeSingleLocator> {
  const items = behavior.items;
  if (!items) return makeSingleLocator(behavior);
  return {
    ...makeSingleLocator({ ...items[0], count: items.length }),
    first: () => makeLocator(items[0] ?? { count: 0 }),
    nth: (index: number) => makeLocator(items[index] ?? { count: 0 }),
  };
}

function makeSingleLocator(behavior: LocatorBehavior = {}) {
  const currentCount = () =>
    typeof behavior.count === "function" ? behavior.count() : (behavior.count ?? 0);
  const currentText = () =>
    typeof behavior.text === "function" ? behavior.text() : (behavior.text ?? "");

  return {
    first() {
      return this;
    },
    nth(_index?: number) {
      return this;
    },
    async count() {
      return currentCount();
    },
    async isVisible() {
      return currentCount() > 0;
    },
    async isEnabled() {
      return (await behavior.isEnabled?.()) ?? currentCount() > 0;
    },
    async isChecked() {
      return (await behavior.isChecked?.()) ?? currentCount() > 0;
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
    async setInputFiles(files: unknown) {
      await behavior.setInputFiles?.(files);
    },
    async click() {
      await behavior.click?.();
    },
    async evaluate(pageFunction?: (element: Element) => unknown) {
      if (behavior.evaluate && pageFunction) return behavior.evaluate(pageFunction);
      await behavior.click?.();
    },
    async evaluateAll() {
      return behavior.dataTestId ?? null;
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
    locator(selector: string) {
      const scoped = typeof behavior.children === "function"
        ? behavior.children(selector)
        : behavior.children?.[selector];
      // A fake element sits in a document: unless a test says otherwise, its
      // one enclosing element is a markerless part card that holds just this
      // element under the price panel's heading (and so shows just that).
      if (scoped === undefined && (selector === PART_CARD_ANCESTORS_XPATH || selector === PART_CARD_XPATH)) {
        return makeLocator({
          count: 1,
          text: () => `Price and Lead Time\n${currentText()}`,
          children: (inner) => ({ count: inner === XOMETRY_LOCATORS.priceTierCard ? currentCount() : 0 }),
        });
      }
      return makeLocator(scoped ?? { count: 0 });
    },
  };
}

function createFakePage(options: FakePageOptions) {
  const selectorBehaviors = options.selectorBehaviors ?? {};
  const responseQueue = [...(options.responses ?? [])];
  let currentUrl = options.url ?? XOMETRY_URLS.quoteHome;
  let saved = false;
  let saveRequested = false;
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
      options.dashboardNavigationFails
    ) {
      throw new Error("dashboard navigation timed out");
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
    if (typeof target === "function" && !saveRequested) {
      if ((target as (url: URL) => boolean)(new URL(currentUrl))) {
        return undefined;
      }
      throw new Error("navigation timed out");
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
      if (options.screenshotFails) {
        throw new Error("screenshot timed out");
      }
      await fs.writeFile(input.path, "");
    },
    async content() {
      if (options.contentFails) {
        throw new Error("DOM capture timed out");
      }
      return `<html><body>${currentBodyText()}</body></html>`;
    },
    locator(selector: string) {
      if (selector === "body") {
        return makeLocator({
          count: 1,
          text: currentBodyText(),
        });
      }

      if (selector === XOMETRY_LOCATORS.uploadInputs.join(", ")) {
        return makeLocator({
          count: () => XOMETRY_LOCATORS.uploadInputs.reduce(
            (total, candidate) => {
              const candidateCount = selectorBehaviors[candidate]?.count;
              if (typeof candidateCount === "function") {
                return total + candidateCount();
              }
              return total + (candidateCount ?? 0);
            },
            0,
          ),
        });
      }

      const visibleLegacyStartButtonUnion = XOMETRY_LOCATORS.startNewQuoteButtons
        .map((candidate) => `${candidate}:visible`)
        .join(", ");
      if (selector === visibleLegacyStartButtonUnion) {
        return makeLocator({
          count: () => XOMETRY_LOCATORS.startNewQuoteButtons.some((candidate) => {
            const candidateCount = selectorBehaviors[candidate]?.count;
            if (typeof candidateCount === "function") {
              return candidateCount() > 0;
            }
            return (candidateCount ?? 0) > 0;
          }) ? 1 : 0,
        });
      }

      const accountQuoteListButtonUnion =
        XOMETRY_LOCATORS.accountQuoteListStartButtons
          .map((candidate) => `${candidate}:visible`)
          .join(", ");
      if (selector === accountQuoteListButtonUnion) {
        const matchingBehaviors = XOMETRY_LOCATORS.accountQuoteListStartButtons
          .map((candidate) => selectorBehaviors[candidate])
          .filter((candidate): candidate is LocatorBehavior => candidate !== undefined);
        return makeLocator({
          count: () => matchingBehaviors.reduce((total, candidate) => {
            const candidateCount = candidate.count;
            const count = typeof candidateCount === "function"
              ? candidateCount()
              : (candidateCount ?? 0);
            return total + count;
          }, 0),
          text: XOMETRY_LOCATORS.accountQuoteListStartButtonText,
          click: async () => {
            const candidate = matchingBehaviors.find((behavior) => {
              const candidateCount = behavior.count;
              return typeof candidateCount === "function"
                ? candidateCount() > 0
                : (candidateCount ?? 0) > 0;
            });
            await candidate?.click?.();
            if (options.dashboardRedirectUrl) {
              currentUrl = options.dashboardRedirectUrl;
            }
          },
        });
      }

      const normalizedSelector = selector.endsWith(":visible")
        ? selector.slice(0, -":visible".length)
        : selector;
      const behavior =
        selectorBehaviors[selector] ?? selectorBehaviors[normalizedSelector];
      if (selector === XOMETRY_LOCATORS.priceTierCard && behavior === undefined) {
        const summaryBehavior = selectorBehaviors[XOMETRY_LOCATORS.priceText[0]];
        return makeLocator({
          ...summaryBehavior,
          getAttribute: (name) => name === "data-option-id" ? "test-option" : null,
        });
      }
      const approvedUploadSelectors = [
        ...XOMETRY_LOCATORS.uploadInputs,
        ...XOMETRY_LOCATORS.standaloneUploadInputs,
        ...XOMETRY_LOCATORS.accountQuoteModalInputs,
      ];
      let approvedUploadBehavior = behavior;
      if (
        approvedUploadSelectors.includes(selector) &&
        behavior?.getAttribute === undefined
      ) {
        approvedUploadBehavior = {
          ...behavior,
          getAttribute: async (name) => {
            if (name === "accept") {
              return ".step,.stp,.sldprt";
            }
            return null;
          },
        };
      }
      if (
        normalizedSelector === XOMETRY_LOCATORS.exportControlNo[0] &&
        behavior?.getAttribute === undefined
      ) {
        approvedUploadBehavior = {
          ...approvedUploadBehavior,
          getAttribute: (name) => {
            if (name === "type") return "radio";
            if (name === "value") return "confirmed-not-itar";
            return null;
          },
        };
      }
      if (
        normalizedSelector === XOMETRY_LOCATORS.exportControlContinue[0] &&
        behavior?.dataTestId === undefined
      ) {
        approvedUploadBehavior = {
          ...approvedUploadBehavior,
          dataTestId: "ItarView-itar-continue",
        };
      }
      if (
        [
          ...XOMETRY_LOCATORS.startNewQuoteButtons,
          ...XOMETRY_LOCATORS.accountQuoteListStartButtons,
        ].includes(normalizedSelector) &&
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
        XOMETRY_LOCATORS.accountQuoteModalSubmitButtons.includes(
          normalizedSelector,
        ) &&
        options.modalSubmitRedirectUrl
      ) {
        return makeLocator({
          ...behavior,
          click: async () => {
            await behavior?.click?.();
            currentUrl = options.modalSubmitRedirectUrl ?? currentUrl;
          },
        });
      }
      if (XOMETRY_LOCATORS.saveConfigurationButtons.includes(selector)) {
        return makeLocator({
          ...behavior,
          click: async () => {
            await behavior?.click?.();
            saveRequested = true;
          },
        });
      }
      if (
        approvedUploadSelectors.includes(selector) &&
        options.uploadRedirectUrl
      ) {
        return makeLocator({
          ...approvedUploadBehavior,
          setInputFiles: async (files) => {
            await approvedUploadBehavior?.setInputFiles?.(files);
            currentUrl = options.uploadRedirectUrl ?? currentUrl;
          },
        });
      }
      if (
        XOMETRY_LOCATORS.standaloneUploadInputs.includes(selector) &&
        options.routeChangeAfterAcceptUrl
      ) {
        return makeLocator({
          ...approvedUploadBehavior,
          getAttribute: async (name) => {
            const value = await approvedUploadBehavior?.getAttribute?.(name);
            if (name === "accept") {
              currentUrl = options.routeChangeAfterAcceptUrl ?? currentUrl;
            }
            return value ?? null;
          },
        });
      }
      return makeLocator(approvedUploadBehavior);
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
        click: () => options.onOptionClick?.(findOptionText()),
      });
    },
    async waitForFunction(callback: unknown, argument?: unknown) {
      if (typeof callback !== "function") {
        throw new Error("expected a wait predicate");
      }

      const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
      const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
      try {
        const attempts = Math.max(1, options.waitForFunctionAttempts ?? 1);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
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

          const result = (callback as (value?: unknown) => unknown)(argument);
          if (result) {
            return undefined;
          }
        }
        throw new Error("wait predicate did not match");
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
      currentUrl = options.gotoRedirectUrl ?? url;
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
}

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-xometry-"));
  tempDirs.push(dir);
  return dir;
}

/** Runs one storage-state quote inside a tracked task phase and returns its failure. */
async function quoteInTrackedMutationPhase(page: ReturnType<typeof createFakePage>) {
  const workerTempDir = await makeTempDir();
  launchMock.mockResolvedValue(createFakeBrowser(page));
  const adapter = new XometryAdapter(
    "xometry",
    makeConfig({
      workerTempDir,
      xometryStorageStatePath: path.join(workerTempDir, "state.json"),
    }),
  );
  const phase = createProviderMutationPhase();
  const failure = await runInProviderMutationPhase(phase, () => adapter.quote(makeInput()))
    .catch((error: unknown) => error);
  return { failure, phase };
}

beforeEach(() => {
  camoufoxMock.mockReset();
  camoufoxLaunchOptionsMock.mockReset();
  launchMock.mockReset();
  launchPersistentContextMock.mockReset();
  playwrightLaunchMock.mockReset();
  playwrightLaunchPersistentContextMock.mockReset();
  loadCamoufoxIdentityMock.mockReset();
  loadCamoufoxIdentityMock.mockResolvedValue({
    schema: "overdrafter-camoufox-launch-identity.v1",
    config: { "navigator.userAgent": "stable-firefox" },
  });
  persistSnapshotMock.mockReset();
  persistSnapshotMock.mockImplementation(async (config: WorkerConfig) => config);
  restoreSnapshotMock.mockReset();
  restoreSnapshotMock.mockImplementation(async (config: WorkerConfig) => config);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * The reviewed live evaluation flow: dashboard upload, quote redirect, then
 * quantity, material, finish, tolerance and Save Configuration.
 */
function createLiveConfigureFlow(input: VendorQuoteAdapterInput) {
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
  // Live Xometry comboboxes show "No options" until a search term is typed.
  let materialSearch = "";
  let finishSearch = "";
  const searchMaterial = vi.fn((value: string) => {
    materialSearch = value;
  });
  const searchFinish = vi.fn((value: string) => {
    finishSearch = value;
  });
  const clickMaterialControl = vi.fn();
  const clickFinishControl = vi.fn();
  const hiddenMaterialControl = vi.fn();
  const hiddenFinishControl = vi.fn();
  const startNewQuote = vi.fn();
  const instantQuoteUpload = vi.fn();
  const toolLibraryUpload = vi.fn();
  let instantQuoteUploadReady = false;
  let lineItemQuantity = "";
  startNewQuote.mockImplementation(async () => {
    await fs.writeFile(
      input.stagedCadFile!.localPath,
      "replacement-after-browser-launch",
    );
    instantQuoteUploadReady = true;
  });
  const page = createFakePage({
    bodyText: "Upload a CAD File Start from Recent Configure part",
    postSaveBodyText: [
      "Quantity 2",
      "Material: Aluminum 6061-T6x",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive USD $60.00 ea. USD $120.00 Lead time 5 business days",
    ].join(" "),
    uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0001/part-1",
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
        fill: (value: string) => {
          lineItemQuantity = value;
        },
        press: vi.fn(),
        inputValue: () => lineItemQuantity,
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
        fill: searchMaterial,
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
        fill: searchFinish,
        click: clickFinishControl,
      },
      [XOMETRY_LOCATORS.priceText[0]]: {
        count: 1,
        text: "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
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
      if (finishOptionsOpen && finishOptionsRendered && finishSearch) return ["Black Anodize"];
      if (materialOptionsOpen && materialOptionsRendered && materialSearch === "6061-T6") {
        return ["Aluminum 6061-T6x (Best Available)", "Aluminum 6061-T651, Plate"];
      }
      return [];
    },
    onOptionWait: (name) => {
      if (name?.test("6061-T6")) materialOptionsRendered = true;
      if (name?.test("Black Anodize")) finishOptionsRendered = true;
    },
  });
  return {
    page, saveConfiguration, setTolerance, openMaterialOptions, openFinishOptions, searchMaterial, searchFinish, clickMaterialControl,
    clickFinishControl, hiddenMaterialControl, hiddenFinishControl, startNewQuote, instantQuoteUpload, toolLibraryUpload,
  };
}

type XometryAutoSelection = { process: string; material: string; finish: string };

/**
 * OVD-777 fixtures from the T1 overnight Xometry run. The summary layout and
 * the 1093-05589-02 values follow the saved quote summary text; the plate's
 * auto-selected Sheet Cutting / Aluminum 5052-H32 come from the T1 run log.
 * Quote ids are placeholders.
 */
function createAutoSelectionFlow(options: {
  partFileName: string;
  measurement?: string;
  uploaded: XometryAutoSelection;
  offered: { process: string[]; material: Record<string, string[]>; finish: string[] };
  drawing?: { name: string; derived: Partial<XometryAutoSelection> };
}) {
  const selection = { ...options.uploaded };
  let drawingAttached = false;
  const saveConfiguration = vi.fn();
  const quoteSummary = () =>
    [
      "1 Part Uploaded",
      options.partFileName,
      drawingAttached ? options.drawing?.name : "",
      "Quantity",
      "Edit Configuration",
      `Process: ${selection.process}`,
      `Material: ${selection.material}`,
      options.measurement ? `Measurement: ${options.measurement}` : "",
      "Preferred Subprocess: No Preference",
      `Finish: ${selection.finish}`,
      "Threads and Tapped Holes: 0",
      "Inserts: 0",
      "Precision Tolerance: ±.005″ (±0.13mm)",
      "Inspection: Standard Inspection",
      "Price and Lead Time",
      "Least Expensive Arrives by Nov 6 $41.41 ea. $414.15",
    ].join("\n");
  const offeredOptions = () => [
    ...options.offered.process,
    ...(options.offered.material[selection.process] ?? []),
    ...options.offered.finish,
  ];
  const page = createFakePage({
    bodyText: quoteSummary,
    postSaveBodyText: quoteSummary,
    uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-AUTO-0001/part-1",
    saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-AUTO-0001#part-part-1",
    visibleFilenames: options.drawing ? [options.drawing.name] : [],
    responseWaitDelayMs: options.drawing ? 20 : undefined,
    selectorBehaviors: {
      [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
      [XOMETRY_LOCATORS.quantityInputs[0]]: {
        count: 1,
        inputValue: () => "10",
        fill: vi.fn(),
        press: vi.fn(),
      },
      [XOMETRY_LOCATORS.processButtons[0]]: { count: 1 },
      [XOMETRY_LOCATORS.materialButtons[0]]: { count: 1 },
      [XOMETRY_LOCATORS.finishButtons[0]]: { count: 1 },
      [XOMETRY_LOCATORS.toleranceOptions.standard]: { count: 1, click: vi.fn() },
      [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: { count: 1, click: saveConfiguration },
      [XOMETRY_LOCATORS.drawingInputs[0]]: {
        count: options.drawing ? 1 : 0,
        setInputFiles: () => {
          // Xometry re-derives requirements from the drawing ("Matches your drawing").
          drawingAttached = true;
          Object.assign(selection, options.drawing?.derived);
        },
      },
      [XOMETRY_LOCATORS.priceText[0]]: {
        count: 1,
        // Real Xometry price-card markup (ovd774 r6 q11): bare "$", USD registry currency.
        text: "Least Expensive Arrives by Nov 6 $41.41 ea. $414.15",
      },
    },
    optionTexts: offeredOptions,
    onOptionClick: (text) => {
      if (options.offered.process.includes(text)) selection.process = text;
      else if (options.offered.finish.includes(text)) selection.finish = text;
      else if (text) selection.material = text;
    },
  });
  return { page, selection, saveConfiguration };
}

function makeT1Input(overrides: Partial<VendorQuoteAdapterInput["requirement"]>, withDrawing: boolean) {
  const baseInput = withDrawing ? makeInputWithDrawing() : makeInput();
  return {
    ...baseInput,
    requestedQuantity: 10,
    requirement: { ...baseInput.requirement, quantity: 10, quote_quantities: [10], ...overrides },
  };
}

const T1_PART_WITH_DRAWING = {
  partFileName: "1093-05589-02.STEP",
  measurement: "46.99 mm × 33.39 mm × 33.39 mm, 12161.69 mm³ ｜ 1.850 in × 1.314 in × 1.314 in, 0.742 in³",
  uploaded: { process: "CNC Machining", material: "Aluminum 6061-T6x (Best Available)", finish: "Standard" },
  drawing: { name: "part.pdf", derived: { finish: "Black Anodize" } },
};

const T1_SAMPLE_PLATE = {
  partFileName: "sample-plate.STEP",
  uploaded: { process: "Sheet Cutting", material: "Aluminum 5052-H32", finish: "Standard" },
};

describe("Xometry helpers", () => {
  it("types each search term into a searchable combobox and fails as finite selector drift", async () => {
    const typed: string[] = [];
    const searchInput = { fill: vi.fn(async (value: string) => { typed.push(value); }) };
    const page = {
      getByRole: () => ({
        first: () => ({ waitFor: () => Promise.reject(new Error("No options")) }),
      }),
      locator: () => ({
        filter: () => ({ first: () => ({ count: async () => 0 }) }),
        innerText: async () => "No options",
      }),
      url: () => "https://www.xometry.com/quoting/quote/Q00-TEST-0001/part-1",
    };

    const failure = await chooseOptionByTerms(
      page as never,
      ["6061-T6", "6061"],
      XOMETRY_LOCATORS.materialOptions,
      "material",
      XOMETRY_LOCATORS.materialButtons[0],
      undefined,
      searchInput as never,
    ).catch((error: unknown) => error);

    expect(typed).toEqual(["6061-T6", "6061"]);
    expect(failure).toBeInstanceOf(VendorAutomationError);
    expect(failure).toMatchObject({
      code: "selector_failure",
      payload: { terminalState: "selector_drift", requestedTerms: ["6061-T6", "6061"] },
    });
    expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
      ok: true,
      terminalState: "selector_drift",
    });
  });

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
    expect(XOMETRY_LOCATORS.accountQuoteListStartButtons).toEqual([
      '[data-testid="DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary"]',
    ]);
    expect(XOMETRY_LOCATORS.accountQuoteListStartButtonText).toBe(
      "Get an Instant Quote",
    );
    expect(XOMETRY_URLS.quoteCreation).toBe(
      "https://www.xometry.com/quoting/new",
    );
    expect(XOMETRY_LOCATORS.materialButtons[0]).toBe(
      'input[role="combobox"][placeholder="Search Material"]',
    );
    expect(XOMETRY_LOCATORS.finishButtons[0]).toBe(
      'input[role="combobox"][placeholder="Search Finish"]',
    );
  });

  it("deduplicates the global action in real DOM structure and excludes Part Library controls", () => {
    const dom = new JSDOM(`
      <main>
        <button
          id="global-action"
          data-testid="DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary"
        >Get an Instant Quote</button>
        <section aria-label="Part Library">
          <button id="labeled-file" aria-label="Get an Instant Quote for a saved part">
            Get an Instant Quote
          </button>
          <button
            id="unlabeled-file"
            data-testid="PartsTableRowActions-parts-table-quote-0A135E2"
          >Get an Instant Quote</button>
        </section>
      </main>
    `);
    const candidates = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        XOMETRY_LOCATORS.accountQuoteListStartButtons.join(", "),
      ),
    ].filter(
      (button) => button.textContent?.trim() ===
        XOMETRY_LOCATORS.accountQuoteListStartButtonText,
    );

    expect(candidates.map((button) => button.id)).toEqual(["global-action"]);
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
    expect(
      resolveXometryCompatibilityLeadTime(
        {
          leadTimeBusinessDays: null,
          rawPayload: { providerText: "Standard\nArrives by Sep 2" },
        } as VendorQuoteAdapterOffer,
        new Date("2026-08-22T00:00:00Z"),
      ),
    ).toBe(8);
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
    ).toBe("login_required");
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
  it.each([
    ["", "login_required"],
    [anonymousQuoteHome.errorBanner, "login_required"],
    ["My Account", "login_required"],
    ["Welcome back. Recent quotes", null],
    ["My Account Part Library", null],
    ["Sign in", "login_required"],
    ["Sign in Verify you are human", "captcha"],
    [`Welcome back ${anonymousQuoteHome.errorBanner}`, "anti_detection_block"],
    ["Welcome back Already have an account?", "login_required"],
  ])("classifies the upload prompt with %s as %s", (extra, expected) => {
    expect(detectBlockingStateSignal({
      url: XOMETRY_URLS.quoteHome,
      text: `${anonymousQuoteHome.uploadPrompt} ${anonymousQuoteHome.uploadButton} ${extra}`,
    })).toBe(expected);
  });

  it("does not block the upload prompt away from quote home", () => {
    expect(detectBlockingStateSignal({
      url: "https://www.xometry.com/resources/",
      text: anonymousQuoteHome.uploadPrompt,
    })).toBeNull();
  });

  it.each(["", anonymousQuoteHome.errorBanner])(
    "ends an expired-session evaluation before upload with a login_required terminal state: %s",
    async (banner) => {
      const workerTempDir = await makeTempDir();
      const page = createFakePage({
        bodyText: `${anonymousQuoteHome.uploadPrompt} ${anonymousQuoteHome.uploadButton} ${banner}`,
      });
      const hydration = vi.spyOn(page, "waitForFunction");
      const context = createFakeContext(page);
      const close = vi.spyOn(context, "close");
      playwrightLaunchPersistentContextMock.mockResolvedValue(context);
      const config = makeConfig({
        workerTempDir,
        xometryStorageStatePath: null,
        xometryUserDataDir: path.join(workerTempDir, "profile"),
        xometryProfileSnapshotBucket: "synthetic-profile-bucket",
        xometryProfileSnapshotObject: "xometry/profile.tgz",
        xometryProfileSnapshotGeneration: "41",
        xometryBrowserEngine: "playwright",
      });
      const uploadCheckpoint = vi.fn(passingUploadCapabilityCheckpoint);
      const input = await makeLiveEvaluationInput({ uploadCapabilityCheckpoint: uploadCheckpoint });
      const adapter = makeLiveEvaluationAdapter(config);
      const failure = await adapter.quote(input).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "login_required",
        payload: { terminalState: "login_required", reason: "session_authentication_required" },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toEqual({
        ok: true, terminalState: "login_required", violations: [],
      });
      expect(hydration).toHaveBeenCalledTimes(1);
      // The dashboard never hydrates, so the bounded wait runs out before the session is declared expired.
      await expect(hydration.mock.results[0].value).rejects.toThrow("wait predicate did not match");
      expect(uploadCheckpoint).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(persistSnapshotMock).not.toHaveBeenCalled();
      const retryFailure = await adapter.quote(input).catch((error: unknown) => error);
      expect(retryFailure).toMatchObject({
        code: "login_required", payload: { reason: "profile_snapshot_unavailable" },
      });
      expect(evaluateProviderAdapterFailureContract(retryFailure)).toEqual({
        ok: true, terminalState: "login_required", violations: [],
      });
      expect(playwrightLaunchPersistentContextMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps waiting for dashboard copy that hydrates after the upload prompt", async () => {
    const workerTempDir = await makeTempDir();
    let reads = 0;
    const page = createFakePage({
      bodyText: () => {
        reads += 1;
        const prompt = `${anonymousQuoteHome.uploadPrompt} ${anonymousQuoteHome.uploadButton}`;
        return reads <= 3 ? prompt : `Welcome back. Recent quotes ${prompt}`;
      },
      waitForFunctionAttempts: 5,
    });
    playwrightLaunchPersistentContextMock.mockResolvedValue(createFakeContext(page));
    const config = makeConfig({
      workerTempDir,
      xometryStorageStatePath: null,
      xometryUserDataDir: path.join(workerTempDir, "profile"),
      xometryProfileSnapshotBucket: "synthetic-profile-bucket",
      xometryProfileSnapshotObject: "xometry/profile.tgz",
      xometryProfileSnapshotGeneration: "41",
      xometryBrowserEngine: "playwright",
    });
    const input = await makeLiveEvaluationInput({ uploadCapabilityCheckpoint: vi.fn(passingUploadCapabilityCheckpoint) });
    const adapter = makeLiveEvaluationAdapter(config);
    const failure = await adapter.quote(input).catch((error: unknown) => error);

    // The fake page has no real uploader, so the run fails later; it must not fail as an expired session.
    expect(failure).not.toMatchObject({ code: "login_required" });
    expect(reads).toBeGreaterThan(3);
    // The adapter keeps its own config copy: a quarantined snapshot would make the next quote refuse
    // with profile_snapshot_unavailable before launching a browser.
    const retry = await adapter.quote(input).catch((error: unknown) => error);
    expect(retry).not.toMatchObject({ payload: { reason: "profile_snapshot_unavailable" } });
    expect(playwrightLaunchPersistentContextMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "production_dispatch", "live_evaluation"] as const)(
    "refuses direct live browser launch without authorization for context %s",
    async (executionContext) => {
    const adapter = new XometryAdapter("xometry", makeConfig());

    await expect(
      adapter.quote(makeInput({
        executionContext,
        xometryDispatchAuthorization: undefined,
      })),
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
    },
  );

  describe("upload capability gate before file selection (OVD-414)", () => {
    const decisionOf = (
      classification: ProviderUploadCapabilityDecision["classification"],
      allowedExtensions: string[] = ["step", "stp"],
    ): ProviderUploadCapabilityDecision => ({
      contractVersion: "provider-upload-capability.v1",
      classification,
      allowedExtensions,
      reportedAddedExtensions: [],
      reportedRemovedExtensions: [],
      evidenceRefs: [],
      normalizedObservedMimeTypes: [],
    });

    async function quoteOnStandaloneUploader(
      uploadCapabilityCheckpoint: VendorQuoteAdapterInput["uploadCapabilityCheckpoint"],
      events: string[] = [],
      acceptAfterDisclosure?: string,
      options: { accept?: string; stagedPath?: string } = {},
    ) {
      let currentAccept = options.accept ?? ".step,.stp";
      const stagedPath = options.stagedPath ?? "/tmp/part.step";
      const workerTempDir = await makeTempDir();
      const standaloneUpload = vi.fn(() => {
        events.push("setInputFiles");
      });
      const summaryText = [
        "Quantity: 2",
        "Material: Aluminum 6061-T6x (Best Available)",
        "Finish: Black Anodize",
        "Precision Tolerance: ±.005",
        "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
      ].join(" ");
      const page = createFakePage({
        bodyText: summaryText,
        dashboardRedirectUrl: "https://www.xometry.com/quoting/new",
        uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-GATE-0414",
        selectorBehaviors: {
          [XOMETRY_LOCATORS.startNewQuoteButtons[0]]: { count: 1 },
          [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 0 },
          [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
            count: 1,
            getAttribute: (name) => name === "accept" ? currentAccept : null,
            setInputFiles: standaloneUpload,
          },
          [XOMETRY_LOCATORS.quantityInputs[0]]: { count: 1, inputValue: () => "2" },
          [XOMETRY_LOCATORS.priceText[0]]: { count: 1, text: summaryText },
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
      const error = await adapter
        .quote(makeInput({
          uploadCapabilityCheckpoint,
          stagedCadFile: {
            originalName: path.basename(stagedPath),
            localPath: stagedPath,
            storageBucket: "job-files",
            storagePath: `cad/${path.basename(stagedPath)}`,
          },
          beforeProviderDisclosure: async () => {
            events.push("beforeProviderDisclosure");
            if (acceptAfterDisclosure !== undefined) currentAccept = acceptAfterDisclosure;
          },
        }))
        .then(() => null, (caught: unknown) => caught);
      return { error, standaloneUpload };
    }

    it("re-resolves the decision after the disclosure recheck and right before setInputFiles", async () => {
      const events: string[] = [];
      const checkpoint = vi.fn(async (observation: ProviderUploadCapabilityObserved) => {
        events.push("checkpoint");
        expect(observation).toMatchObject({
          state: "fresh",
          provider: "xometry",
          route: "quote_creation",
          acceptAttributePresent: true,
          extensions: ["step", "stp"],
        });
        return decisionOf("matches_policy");
      });

      const { error, standaloneUpload } = await quoteOnStandaloneUploader(checkpoint, events);

      expect(error).toBeNull();
      expect(standaloneUpload).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["beforeProviderDisclosure", "checkpoint", "setInputFiles"]);
    });

    it("reads the accept list again after the disclosure recheck and refuses a changed value", async () => {
      const checkpoint = vi.fn(async () => decisionOf("matches_policy"));
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(checkpoint, [], ".pdf");
      expect(error).toMatchObject({
        payload: { reason: "upload_capability_denied", classification: "accept_changed" },
      });
      expect(checkpoint).not.toHaveBeenCalled();
      expect(standaloneUpload).not.toHaveBeenCalled();
    });

    it("lets the exact reviewed missing accept classification through", async () => {
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(
        async () => decisionOf("reviewed_missing_accept_xometry"),
      );
      expect(error).toBeNull();
      expect(standaloneUpload).toHaveBeenCalledTimes(1);
    });

    describe("live accept-list format drift (OVD-863)", () => {
      afterEach(() => {
        if (vi.isMockFunction(console.warn)) vi.mocked(console.warn).mockRestore();
      });
      const admittedCheckpoint = () => createXometryUploadCapabilityCheckpoint(async () => ({
        schema: "xometry-admission-read.v1",
        policy_present: true,
        provider_admitted: true,
        generically_dispatchable: false,
        provider: "xometry",
        admission_state: "controlled_beta_only",
        policy_revision: "xometry-beta-v1",
        evidence_reference: "OVD-379",
        permission_basis: "existing_controlled_beta_path",
        supported_processes: ["cnc_milling"],
        accepted_file_extensions: ["step", "stp"],
        session_owner: "overdrafter_managed",
        reviewed_at: "2026-01-01T00:00:00.000Z",
        expires_at: null,
        reason_code: "controlled_beta_only",
      }));
      const driftLogs = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls
        .map(([line]) => (typeof line === "string" ? line : ""))
        .filter((line) => line.includes("vendor.upload_capability_format_drift"));

      it("selects a staged STEP when Xometry adds a format beyond admission", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          admittedCheckpoint(), [], undefined, { accept: ".step,.stp,.sldprt" },
        );
        expect(error).toBeNull();
        expect(standaloneUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
        expect(driftLogs(warn)).toHaveLength(1);
        expect(JSON.parse(driftLogs(warn)[0])).toMatchObject({
          context: { classification: "format_added", reportedAddedExtensions: ["sldprt"] },
        });
      });

      it("compares the staged extension case-insensitively", async () => {
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          admittedCheckpoint(), [], undefined, { accept: ".step,.stp", stagedPath: "/tmp/PART.STP" },
        );
        expect(error).toBeNull();
        expect(standaloneUpload).toHaveBeenCalledWith(["/tmp/PART.STP"]);
      });

      it("refuses a staged STEP once Xometry stops accepting .step", async () => {
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          admittedCheckpoint(), [], undefined, { accept: ".stp" },
        );
        expect(error).toMatchObject({ code: "upload_failure" });
        expect(standaloneUpload).not.toHaveBeenCalled();
      });

      it("refuses .step at the capability gate even when readiness would pass", async () => {
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          async (observed) => admittedCheckpoint()({ ...observed, extensions: ["stp"] }),
        );
        expect(error).toMatchObject({
          payload: { reason: "upload_capability_denied", classification: "extension_not_allowed" },
        });
        expect(standaloneUpload).not.toHaveBeenCalled();
      });

      it("selects a staged STP when only .stp remains and logs the drift", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          admittedCheckpoint(), [], undefined, { accept: ".stp", stagedPath: "/tmp/part.stp" },
        );
        expect(error).toBeNull();
        expect(standaloneUpload).toHaveBeenCalledWith(["/tmp/part.stp"]);
        expect(JSON.parse(driftLogs(warn)[0])).toMatchObject({
          context: { classification: "format_removed", reportedRemovedExtensions: ["step"] },
        });
      });

      it("refuses selection when the live accept list carries no extension", async () => {
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          admittedCheckpoint(), [], undefined, { accept: "*/*" },
        );
        expect(error).toMatchObject({ payload: { reason: "upload_capability_denied" } });
        expect(standaloneUpload).not.toHaveBeenCalled();
      });

      it("refuses selection when the live accept list is missing on a generic surface", async () => {
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          async (observed) => admittedCheckpoint()({ ...observed, acceptAttributePresent: false, extensions: undefined, mimeTypes: undefined }),
        );
        expect(error).toMatchObject({ payload: { reason: "upload_capability_denied", classification: "accept_missing" } });
        expect(standaloneUpload).not.toHaveBeenCalled();
      });

      it("refuses a staged .sldprt even when Xometry advertises it", async () => {
        const { error, standaloneUpload } = await quoteOnStandaloneUploader(
          admittedCheckpoint(), [], undefined, { accept: ".step,.stp,.sldprt", stagedPath: "/tmp/part.sldprt" },
        );
        expect(error).toMatchObject({
          payload: { reason: "upload_capability_denied", classification: "extension_not_allowed" },
        });
        expect(standaloneUpload).not.toHaveBeenCalled();
      });
    });

    it.each([
      "accept_missing",
      "unsupported",
      "denied",
      "observation_missing",
      "observation_stale",
      "formats_loading",
      "ambiguous_input",
      "route_or_selector_drift",
      "authentication_required",
      "anti_bot_or_challenge",
      "provider_error",
      "unclassified_response",
    ] as const)("%s: no file is selected and only the classification is recorded", async (classification) => {
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(
        async () => decisionOf(classification),
      );
      expect(error).toMatchObject({
        name: "VendorAutomationError",
        code: "upload_failure",
        payload: { reason: "upload_capability_denied", classification },
      });
      expect(standaloneUpload).not.toHaveBeenCalled();
    });

    it("a passing decision that does not cover the staged extension selects nothing", async () => {
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(
        async () => decisionOf("matches_policy", ["stl"]),
      );
      expect(error).toMatchObject({ payload: { reason: "upload_capability_denied", classification: "extension_not_allowed" } });
      expect(standaloneUpload).not.toHaveBeenCalled();
    });

    it("a malformed decision selects nothing", async () => {
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(
        async () => undefined as unknown as ProviderUploadCapabilityDecision,
      );
      expect(error).toMatchObject({ payload: { reason: "upload_capability_denied", classification: "decision_malformed" } });
      expect(standaloneUpload).not.toHaveBeenCalled();
    });

    it("a throwing checkpoint selects nothing", async () => {
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(async () => {
        throw new Error("ledger unreachable: secret-detail");
      });
      expect(error).toMatchObject({ payload: { reason: "upload_capability_denied", classification: "decision_unavailable" } });
      expect(JSON.stringify((error as { payload: unknown }).payload)).not.toContain("secret-detail");
      expect(standaloneUpload).not.toHaveBeenCalled();
    });

    it("no checkpoint at all selects nothing", async () => {
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(undefined);
      expect(error).toMatchObject({ payload: { reason: "upload_capability_denied", classification: "decision_missing" } });
      expect(standaloneUpload).not.toHaveBeenCalled();
    });

    it("the real shared contract denies a generic observation without a current admission", async () => {
      const { error, standaloneUpload } = await quoteOnStandaloneUploader(async (observed) =>
        decideProviderUploadCapability({
          releaseEnvelope: {
            provider: observed.provider,
            route: observed.route,
            surface: observed.surface,
            revision: observed.revision,
            extensions: ["step", "stp"],
            policyRevision: "xometry-controlled-beta-2026-08-17.v1",
            evidenceReference: "OVD-373",
          },
          admissionResolver: {
            policy_present: false,
            provider_admitted: false,
            generically_dispatchable: false,
            provider: null,
            admission_state: "none",
            policy_revision: null,
            evidence_reference: null,
            permission_basis: null,
            supported_processes: [],
            accepted_file_extensions: [],
            session_owner: null,
            reviewed_at: null,
            expires_at: null,
            reason_code: "provider_unknown",
          },
          observed,
        }),
      );
      expect(error).toMatchObject({ payload: { reason: "upload_capability_denied", classification: "observation_missing" } });
      expect(standaloneUpload).not.toHaveBeenCalled();
    });
  });

  it("keeps evaluation context out of normal production adapter payloads", async () => {
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerMode: "simulate" }),
    );

    const result = await adapter.quote(makeInput({
      executionContext: "live_evaluation",
    }));

    expect(result.rawPayload).not.toHaveProperty("executionContext");
  });

  it("disables GeoIP in the nonpersistent Camoufox launch", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({ bodyText: "Configure part" });
    const options = { headless: true };
    camoufoxLaunchOptionsMock.mockResolvedValue(options);
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = makeLiveEvaluationAdapter(makeConfig({
      workerTempDir,
      xometryBrowserEngine: "camoufox",
      xometryUserDataDir: null,
      xometryStorageStatePath: path.join(workerTempDir, "state.json"),
    }));

    await expect(adapter.quote(await makeLiveEvaluationInput()))
      .rejects.toMatchObject({ code: "selector_failure" });
    expect(camoufoxLaunchOptionsMock).toHaveBeenCalledWith({
      headless: true, window: [1366, 900], humanize: true, geoip: false,
    });
    expect(launchMock).toHaveBeenCalledWith(options);
  });

  it("allows an explicit live evaluation to launch without production dispatch authorization", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({ bodyText: "Configure part" });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = makeLiveEvaluationAdapter(
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(
      adapter.quote(await makeLiveEvaluationInput()),
    ).rejects.toMatchObject({ code: "selector_failure" });

    expect(playwrightLaunchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses live evaluation without file-bound export-control confirmation", async () => {
    const adapter = makeLiveEvaluationAdapter(makeConfig());

    await expect(
      adapter.quote(makeInput({
        executionContext: "live_evaluation",
        xometryDispatchAuthorization: undefined,
      })),
    ).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        reason: "evaluation_export_control_authorization_missing",
      },
    });
    expect(playwrightLaunchMock).not.toHaveBeenCalled();
  });

  it("refuses live evaluation when staged bytes change after authorization", async () => {
    const adapter = makeLiveEvaluationAdapter(makeConfig());
    const input = await makeLiveEvaluationInput();
    await fs.writeFile(input.stagedCadFile!.localPath, "replacement-cad-bytes");

    await expect(adapter.quote(input)).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        reason: "evaluation_export_control_authorization_missing",
      },
    });
    expect(playwrightLaunchMock).not.toHaveBeenCalled();
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

  it.each([
    { playwrightDisableSandbox: false, chromiumSandbox: true, args: ["--disable-dev-shm-usage"] },
    {
      playwrightDisableSandbox: true,
      chromiumSandbox: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  ])("passes the Chromium sandbox decision explicitly on both launch paths (disable=$playwrightDisableSandbox)", async (
    { playwrightDisableSandbox, chromiumSandbox, args },
  ) => {
    const workerTempDir = await makeTempDir();
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(createFakePage({ bodyText: "Configure part" })));
    playwrightLaunchPersistentContextMock.mockResolvedValue(
      createFakeContext(createFakePage({ bodyText: "Configure part" })),
    );
    const shared = { workerTempDir, xometryBrowserEngine: "playwright" as const, playwrightDisableSandbox };

    await new XometryAdapter("xometry", makeConfig({
      ...shared,
      xometryStorageStatePath: path.join(workerTempDir, "state.json"),
    })).quote(makeInput()).catch(() => undefined);
    await new XometryAdapter("xometry", makeConfig({
      ...shared,
      xometryUserDataDir: path.join(workerTempDir, "profile"),
    })).quote(makeInput()).catch(() => undefined);

    expect(playwrightLaunchMock).toHaveBeenCalledWith({ headless: true, chromiumSandbox, args });
    expect(playwrightLaunchPersistentContextMock).toHaveBeenCalledWith(
      path.join(workerTempDir, "profile"),
      { headless: true, chromiumSandbox, args },
    );
  });

  it.each([false, true])("captures a live evaluation upload and instant quote without production authorization (trace capture: %s)", async (captureTrace) => {
    const workerTempDir = await makeTempDir();
    const input = await makeLiveEvaluationInput();
    const {
      page, saveConfiguration, setTolerance, openMaterialOptions, openFinishOptions, searchMaterial, searchFinish,
      clickMaterialControl, clickFinishControl, hiddenMaterialControl, hiddenFinishControl, startNewQuote, instantQuoteUpload, toolLibraryUpload,
    } = createLiveConfigureFlow(input);
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const screenshot = vi.spyOn(page, "screenshot");

    const adapter = makeLiveEvaluationAdapter(
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
        playwrightCaptureTrace: captureTrace,
      }),
    );

    const result = await adapter.quote(input);
    // OVD-779: without an injected harness hook the adapter never screenshots.
    expect(screenshot).not.toHaveBeenCalled();

    expect(result.status).toBe("instant_quote_received");
    expect(result.totalPriceUsd).toBe(120);
    expect(result.leadTimeBusinessDays).toBe(5);
    expect(result.rawPayload).toMatchObject({
      executionContext: "live_evaluation",
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
    const uploadedFiles = instantQuoteUpload.mock.calls[0]?.[0] as unknown as Array<{
      buffer: Buffer;
    }>;
    expect(uploadedFiles[0]?.buffer.toString()).toBe("evaluation-cad-bytes");
    expect(toolLibraryUpload).not.toHaveBeenCalled();
    expect(setTolerance).toHaveBeenCalledTimes(1);
    expect(openMaterialOptions).toHaveBeenCalledTimes(1);
    expect(openFinishOptions).toHaveBeenCalledTimes(1);
    expect(openMaterialOptions).toHaveBeenCalledWith("ArrowDown");
    expect(openFinishOptions).toHaveBeenCalledWith("ArrowDown");
    expect(searchMaterial).toHaveBeenCalledWith("6061-T6");
    expect(searchFinish).toHaveBeenCalledWith("Black Anodize");
    expect(playwrightLaunchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).not.toHaveBeenCalled();
    expect(clickMaterialControl).not.toHaveBeenCalled();
    expect(clickFinishControl).not.toHaveBeenCalled();
    expect(hiddenMaterialControl).not.toHaveBeenCalled();
    expect(hiddenFinishControl).not.toHaveBeenCalled();
    expect(page.waitForURL).toHaveBeenCalled();
    // OVD-611: screenshots are not captured; OVD-779 adds the redacted price-capture DOM.
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(
      Array(6).fill("html_snapshot"),
    );
    expect(result.artifacts.map((artifact) => artifact.label)).toContain("price-capture-dom");

    // OVD-611: a trace may be recorded, but it is never uploaded or left on disk.
    const browser = await playwrightLaunchMock.mock.results[0]?.value;
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
    const runDir = path.dirname(result.artifacts[0]!.localPath);
    await expect(fs.access(path.join(runDir, "trace.zip"))).rejects.toThrow();
  });

  it("calls an injected harness capture hook once at price capture on the live-evaluation path", async () => {
    const workerTempDir = await makeTempDir();
    const harnessPriceCaptureHook = vi.fn(async () => [{
      kind: "screenshot" as const,
      label: "price-capture-screenshot",
      localPath: path.join(workerTempDir, "harness.png"),
      contentType: "image/png",
    }]);
    const input = { ...(await makeLiveEvaluationInput()), harnessPriceCaptureHook };
    const { page } = createLiveConfigureFlow(input);
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = makeLiveEvaluationAdapter(
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(input);

    expect(harnessPriceCaptureHook).toHaveBeenCalledOnce();
    expect(harnessPriceCaptureHook).toHaveBeenCalledWith(expect.objectContaining({ label: "price-capture" }));
    expect(result.artifacts.filter((artifact) => artifact.kind === "screenshot")).toHaveLength(1);
  });
  it("engaged during the last configuration step: Save Configuration is never clicked (OVD-722)", async () => {
    const workerTempDir = await makeTempDir();
    const reads: string[] = [];
    let engaged = false;
    // Authorized by identity, so the checkpoint is attached to the same object.
    const input = Object.assign(await makeLiveEvaluationInput(), {
      providerKillSwitchCheckpoint: async (checkpoint: "before_navigation" | "before_upload" | "before_configure" | "before_save") => {
        reads.push(checkpoint);
        if (engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "xometry", checkpoint);
      },
    });
    const flow = createLiveConfigureFlow(input);
    // The admin flips the switch while the tolerance selection is awaiting.
    flow.setTolerance.mockImplementation(() => {
      engaged = true;
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(flow.page));
    const adapter = makeLiveEvaluationAdapter(makeConfig({
      workerTempDir,
      xometryStorageStatePath: path.join(workerTempDir, "state.json"),
      xometryBrowserEngine: "playwright",
    }));

    const error = await adapter.quote(input).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "ProviderKillSwitchError", reasonCode: "provider_kill_switch_engaged", checkpoint: "before_save" });
    expect(flow.setTolerance).toHaveBeenCalledTimes(1);
    expect(flow.saveConfiguration).not.toHaveBeenCalled();
    expect(reads.at(-1)).toBe("before_save");
    expect(reads.filter((read) => read === "before_configure").length).toBeGreaterThanOrEqual(4);
  });

  describe("OVD-722 kill switch checkpoints right before each provider mutation", () => {
    const summaryText = [
      "My Account",
      "Part Library",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const switchState = () => {
      const state = { engaged: false, reads: [] as string[] };
      const providerKillSwitchCheckpoint = async (checkpoint: "before_navigation" | "before_upload" | "before_configure" | "before_save") => {
        state.reads.push(checkpoint);
        if (state.engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "xometry", checkpoint);
      };
      return { state, providerKillSwitchCheckpoint };
    };
    const adapterFor = async () => {
      const workerTempDir = await makeTempDir();
      return new XometryAdapter("xometry", makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }));
    };

    it("engaged after the reviewed negative export control answer: Continue is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const reviewedContinue = vi.fn();
      const page = createFakePage({
        bodyText: "Are any parts subject to export control?",
        uploadRedirectUrl: XOMETRY_URLS.quoteHome,
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: {
            count: 1,
            getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
            setInputFiles: vi.fn(),
          },
          [XOMETRY_LOCATORS.exportControlContinue[0]]: { count: 1, click: reviewedContinue },
          // The admin flips the switch while the negative answer is being clicked.
          [XOMETRY_LOCATORS.exportControlNo[0]]: { count: 1, click: () => { state.engaged = true; } },
        },
      });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint }))
        .catch((caught: unknown) => caught);

      // Not relabelled as an ambiguous export control state.
      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
      expect(reviewedContinue).not.toHaveBeenCalled();
    });

    it("engaged after the fallback negative export control answer: the fallback Continue is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const fallbackContinue = vi.fn();
      const page = createFakePage({
        bodyText: "Are any parts subject to export control?",
        uploadRedirectUrl: XOMETRY_URLS.quoteHome,
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: {
            count: 1,
            getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
            setInputFiles: vi.fn(),
          },
          [XOMETRY_LOCATORS.exportControlContinue[1]]: { count: 1, click: fallbackContinue },
          [XOMETRY_LOCATORS.exportControlNo[1]]: { count: 1, click: () => { state.engaged = true; } },
        },
      });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint }))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
      expect(fallbackContinue).not.toHaveBeenCalled();
    });

    it("engaged as the reviewed export control modal appears: the reviewed negative answer is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const reviewedNo = vi.fn();
      const reviewedContinue = vi.fn();
      const page = createFakePage({
        bodyText: "Are any parts subject to export control?",
        uploadRedirectUrl: XOMETRY_URLS.quoteHome,
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: {
            count: 1,
            getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
            setInputFiles: vi.fn(),
          },
          // The admin flips the switch while the modal poll is looking at the reviewed Continue.
          [XOMETRY_LOCATORS.exportControlContinue[0]]: { count: () => { state.engaged = true; return 1; }, click: reviewedContinue },
          [XOMETRY_LOCATORS.exportControlNo[0]]: { count: 1, click: reviewedNo },
        },
      });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint }))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
      expect(reviewedNo).not.toHaveBeenCalled();
      expect(reviewedContinue).not.toHaveBeenCalled();
    });

    it("engaged as the fallback export control modal appears: the fallback negative answer is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const fallbackNo = vi.fn();
      const fallbackContinue = vi.fn();
      const page = createFakePage({
        bodyText: "Are any parts subject to export control?",
        uploadRedirectUrl: XOMETRY_URLS.quoteHome,
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: {
            count: 1,
            getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
            setInputFiles: vi.fn(),
          },
          [XOMETRY_LOCATORS.exportControlContinue[1]]: { count: () => { state.engaged = true; return 1; }, click: fallbackContinue },
          [XOMETRY_LOCATORS.exportControlNo[1]]: { count: 1, click: fallbackNo },
        },
      });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint }))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
      expect(fallbackNo).not.toHaveBeenCalled();
      expect(fallbackContinue).not.toHaveBeenCalled();
    });

    it("engaged between the quantity fill and Enter: Enter is never pressed", async () => {
      let engaged = false;
      const press = vi.fn();
      const page = createFakePage({
        bodyText: "Configure part",
        selectorBehaviors: {
          [XOMETRY_LOCATORS.quantityInputs[0]]: { count: 1, fill: () => { engaged = true; }, press },
        },
      });
      const beforeSubmit = async () => {
        if (engaged) throw new ProviderKillSwitchError("provider_kill_switch_engaged", "xometry", "before_configure");
      };

      const error = await setQuantity(page as never, 2, undefined, beforeSubmit).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_configure" });
      expect(press).not.toHaveBeenCalled();
    });

    it("engaged while the uploader readiness is polled: the CAD file is never selected", async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const dashboardCadUpload = vi.fn();
      let dashboardInputReady = false;
      let acceptReads = 0;
      const page = createFakePage({
        bodyText: "Pick Up Where You Left Off",
        uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-READY-0722",
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: {
            count: () => (dashboardInputReady ? 1 : 0),
            getAttribute: (name) => {
              if (name !== "accept") return null;
              acceptReads += 1;
              // The admin flips the switch while readiness is still polling.
              if (acceptReads === 2) state.engaged = true;
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
        },
      });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint }))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_upload" });
      expect(acceptReads).toBe(4);
      expect(dashboardCadUpload).not.toHaveBeenCalled();
    });

    it("engaged while the quote modal submit action is polled: Submit is never clicked", async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const modalUpload = vi.fn();
      const startInstantQuote = vi.fn();
      let modalOpened = false;
      let submitCountChecks = 0;
      const page = createFakePage({
        bodyText: summaryText,
        modalSubmitRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-DELAYED-MODAL-0722",
        selectorBehaviors: {
          [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
            count: 1,
            click: () => {
              modalOpened = true;
            },
          },
          [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
            count: () => modalOpened ? 1 : 0,
            getAttribute: () => "",
            setInputFiles: modalUpload,
          },
          [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
            count: () => modalOpened ? 1 : 0,
            text: () => modalUpload.mock.calls.length > 0
              ? "Start a New Quote part.step"
              : "Start a New Quote Upload a 3D model",
          },
          [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
            count: () => {
              submitCountChecks += 1;
              // The admin flips the switch while the submit action is still loading.
              if (submitCountChecks === 2) state.engaged = true;
              return submitCountChecks >= 3 ? 1 : 0;
            },
            click: startInstantQuote,
          },
        },
      });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint }))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_upload" });
      expect(modalUpload).toHaveBeenCalledTimes(1);
      expect(startInstantQuote).not.toHaveBeenCalled();
    });

    it("auto redirect with a matching summary: a switch engaged after the upload refuses before a result is returned", async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const uploadCad = vi.fn(() => {
        state.engaged = true;
      });
      // The same page shape as "uses a verified auto-configured quote summary".
      const autoSummaryText = summaryText.replace("My Account Part Library ", "");
      const page = createFakePage({
        bodyText: autoSummaryText,
        uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-SUMMARY-0722",
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: uploadCad },
          [XOMETRY_LOCATORS.quantityInputs[0]]: { count: 1, inputValue: () => "2" },
          [XOMETRY_LOCATORS.priceText[0]]: { count: 1, text: autoSummaryText },
        },
      });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));

      const error = await (await adapterFor()).quote(makeInput({ providerKillSwitchCheckpoint }))
        .catch((caught: unknown) => caught);

      expect(uploadCad).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_save" });
      expect(state.reads.at(-1)).toBe("before_save");
    });

    it("engaged during a failed drawing fallback attempt: the next drawing input is never tried", { timeout: 30_000 }, async () => {
      const { state, providerKillSwitchCheckpoint } = switchState();
      const firstDrawingInput = vi.fn(async () => {
        state.engaged = true;
        throw new Error("input detached");
      });
      const secondDrawingInput = vi.fn();
      const page = createFakePage({
        bodyText: "Manual review required. Drawing required for this quote.",
        postSaveBodyText: () => [
          "Quantity 2",
          "Material: Aluminum 7075-T6",
          "Finish: Standard",
          "Precision Tolerance: ±.005",
          "Manual review required. Drawing required for this quote.",
        ].join(" "),
        uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0722/part-1",
        saveRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0722#part-part-1",
        responseWaitDelayMs: 20,
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
          [XOMETRY_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
          [XOMETRY_LOCATORS.materialButtons[0]]: { count: 1, click: vi.fn() },
          [XOMETRY_LOCATORS.toleranceOptions.standard]: { count: 1, click: vi.fn() },
          [XOMETRY_LOCATORS.saveConfigurationButtons[0]]: { count: 1, click: vi.fn() },
          [XOMETRY_LOCATORS.drawingInputs[0]]: { count: 1, setInputFiles: firstDrawingInput },
          [XOMETRY_LOCATORS.drawingInputs[1]]: { count: 1, setInputFiles: secondDrawingInput },
          [XOMETRY_LOCATORS.manualReviewText[0]]: { count: 1, text: "Manual review required" },
        },
        optionTexts: ["7075-T6"],
      });
      launchMock.mockResolvedValue(createFakeBrowser(page));
      const workerTempDir = await makeTempDir();
      const adapter = new XometryAdapter("xometry", makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        browserTimeoutMs: 200,
      }));

      const error = await adapter.quote(makeInput({
        providerKillSwitchCheckpoint,
        requirement: { ...makeInput().requirement, material: "7075 aluminum", finish: null },
        part: { ...makeInput().part, drawing_file_id: "drawing-1" },
        drawingFile: {
          id: "drawing-1", job_id: "job-1", storage_bucket: "job-files", storage_path: "drawings/part.pdf",
          original_name: "part.pdf", file_kind: "drawing",
        },
        stagedDrawingFile: {
          originalName: "part.pdf", localPath: "/tmp/part.pdf", storageBucket: "job-files", storagePath: "drawings/part.pdf",
        },
      })).catch((caught: unknown) => caught);

      expect(firstDrawingInput).toHaveBeenCalledTimes(1);
      expect(secondDrawingInput).not.toHaveBeenCalled();
      expect(error).toMatchObject({ name: "ProviderKillSwitchError", checkpoint: "before_upload" });
    });
  });

  it("uses a verified auto-configured quote summary without reopening material options", async () => {
    const workerTempDir = await makeTempDir();
    const uploadCad = vi.fn();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-SUMMARY-0001",
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

  it("unmodified custom quote flow sends original collector evidence through the admitted registry consumer", async () => {
    const workerTempDir = await makeTempDir();
    const input = makeInput();
    input.requirement = { ...input.requirement, updated_at: "2026-10-02T00:00:00Z", spec_snapshot: { process: "CNC" } };
    const summary = "Quantity: 2 Material: Aluminum 6061-T6x Finish: Black Anodize Precision Tolerance: ±.005 Least Expensive 5 business days USD $60.00 ea. USD $120.00";
    const source = "Least Expensive\nUSD $120.00\n5 business days\nFirm total USD 120.00 quantity: 2 revision: A\nReference: secret-full-source";
    const config = makeConfig({ workerTempDir, workerLiveAdapters: ["xometry"],
      xometryStorageStatePath: path.join(workerTempDir, "state.json"), xometryBrowserEngine: "playwright" });
    const scope = { organizationId: input.organizationId, quoteRunId: input.quoteRunId, taskId: "task", provider: "xometry" as const, sourceRevision: "a".repeat(40) };
    const decide = vi.fn(async (q) => ({ model: JEV_MODEL, choice: "span_0", confidence: 1, inputTokens: 5, outputTokens: 5,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === "span_0" ? 1 : 0])) }));
    const authorize = vi.fn(async () => true);
    const session = new OperationalJevSession({ mode: "shadow", admission: { scope, expiresAt: Date.now() + 60000,
      uses: ["quote_evidence"], evidenceProfiles: ["quote_facts.v1"] }, capabilities: { authorize,
      reserve: async () => ({ reservationId: "one", estimatedUsd: 0.1 }), settle: async () => undefined, audit: async () => true, decide } });
    const observations = new OperationalJevObservations(); const results = [];
    for (const binding of [undefined, { session, scope, observations }]) {
      const page = createFakePage({ bodyText: summary, uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-SOURCE-0001",
        selectorBehaviors: { [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
          [XOMETRY_LOCATORS.quantityInputs[0]]: { count: 1, inputValue: () => "2" },
          [XOMETRY_LOCATORS.priceText[0]]: { count: 1, text: summary },
          [XOMETRY_LOCATORS.priceTierCard]: { count: 1, text: source } } });
      playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
      const result = await buildAdapterRegistry(config, binding).xometry!.quote(input);
      results.push({ ...result, artifacts: result.artifacts.map(({ kind, label }) => ({ kind, label })) });
    }
    expect(results[1]).toEqual(results[0]); expect(authorize).not.toHaveBeenCalled();
    await observations.drain();
    expect(observations.localReview().get("quote_evidence")).toMatchObject({ receipt: { proposal: "span_0" },
      result: { selected: { document: { text: source } }, publicationAllowed: false } });
    expect(decide).toHaveBeenCalledOnce(); expect(JSON.stringify(decide.mock.calls)).not.toContain("secret");
  });

  it("captures original unstructured custom-adapter error before navigation translation", async () => {
    const workerTempDir = await makeTempDir(); const input = makeInput();
    const config = makeConfig({ workerTempDir, workerLiveAdapters: ["xometry"],
      xometryStorageStatePath: path.join(workerTempDir, "state.json"), xometryBrowserEngine: "playwright" });
    const scope = { organizationId: input.organizationId, quoteRunId: input.quoteRunId, taskId: "task", provider: "xometry" as const, sourceRevision: "a".repeat(40) };
    const decide = vi.fn(async (q) => ({ model: JEV_MODEL, choice: "expired_session", confidence: 1, inputTokens: 5, outputTokens: 5,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === "expired_session" ? 1 : 0])) }));
    const session = new OperationalJevSession({ mode: "shadow", admission: { scope, expiresAt: Date.now() + 60000,
      uses: ["exception_routing"], evidenceProfiles: ["failure_words.v1"] }, capabilities: { authorize: async () => true,
      reserve: async () => ({ reservationId: "one", estimatedUsd: 0.1 }), settle: async () => undefined, audit: async () => true, decide } });
    const observations = new OperationalJevObservations(); const errors = [];
    for (const binding of [undefined, { session, scope, observations }]) {
      playwrightLaunchMock.mockRejectedValue(new Error("session expired secret-provider-error"));
      const error = await buildAdapterRegistry(config, binding).xometry!.quote(input).catch((error) => error);
      errors.push({ message: error.message, code: error.code, payload: error.payload });
    }
    expect(errors[1]).toEqual(errors[0]); expect(errors[0].code).toBe("navigation_failure");
    expect(decide).not.toHaveBeenCalled(); await observations.drain();
    expect(decide).toHaveBeenCalledOnce(); expect(JSON.stringify(decide.mock.calls)).not.toContain("secret-provider-error");
  });

  // OVD-723 review round 6: a dispatch decision raised right before the
  // upload is a hold, not an operational failure, so it never reaches Jev and
  // is rethrown unchanged, with no file sent.
  it.each([
    ["an export gate denial", () => new XometryDispatchAuthorizationError("export_review_pending")],
    ["a failed export lookup", () => new ExportControlLookupError("dispatch")],
  ])("does not report %s to Jev as an operational failure", async (_label, makeDecision) => {
    const workerTempDir = await makeTempDir(); const input = makeInput();
    const config = makeConfig({ workerTempDir, workerLiveAdapters: ["xometry"],
      xometryStorageStatePath: path.join(workerTempDir, "state.json"), xometryBrowserEngine: "playwright" });
    const scope = { organizationId: input.organizationId, quoteRunId: input.quoteRunId, taskId: "task", provider: "xometry" as const, sourceRevision: "a".repeat(40) };
    const decide = vi.fn(async (q) => ({ model: JEV_MODEL, choice: "expired_session", confidence: 1, inputTokens: 5, outputTokens: 5,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === "expired_session" ? 1 : 0])) }));
    const session = new OperationalJevSession({ mode: "shadow", admission: { scope, expiresAt: Date.now() + 60000,
      uses: ["exception_routing"], evidenceProfiles: ["failure_words.v1"] }, capabilities: { authorize: async () => true,
      reserve: async () => ({ reservationId: "one", estimatedUsd: 0.1 }), settle: async () => undefined, audit: async () => true, decide } });
    const observations = new OperationalJevObservations();
    const setInputFiles = vi.fn();
    const page = createFakePage({ bodyText: "Quantity: 2", uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-HOLD-0001",
      selectorBehaviors: { [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles } } });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const decision = makeDecision();
    const error = await buildAdapterRegistry(config, { session, scope, observations }).xometry!
      .quote({ ...input, beforeProviderDisclosure: async () => { throw decision; } })
      .catch((caught: unknown) => caught);
    expect(error).toBe(decision);
    expect(setInputFiles).not.toHaveBeenCalled();
    await observations.drain();
    expect(decide).not.toHaveBeenCalled();
  });

  it("fails closed when a trusted summary has no tier card", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-NO-OPTIONS-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          inputValue: () => "2",
        },
        // A fallback price anchor that is not itself a tier card.
        '[data-testid*="price" i]': {
          count: 1,
          text: summaryText,
        },
        [XOMETRY_LOCATORS.priceTierCard]: {
          count: 0,
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

    expect(XOMETRY_LOCATORS.priceText).toContain('[data-testid*="price" i]');
    expect(XOMETRY_LOCATORS.priceTierCard).not.toBe('[data-testid*="price" i]');
    const failure = await adapter.quote(makeInput()).catch((error: unknown) => error);

    // OVD-1052: no tier card means no option set, whatever a fallback anchor reads.
    expect(failure).toMatchObject({
      code: "unexpected_ui_state",
      payload: expect.objectContaining({ reason: "xometry_price_tier_cards_missing" }),
    });
    // OVD-1052: a finite selector-drift stop (not finite_terminal_state_missing).
    expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
      ok: true,
      terminalState: "selector_drift",
      violations: [],
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
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
          getAttribute: (name) => name === "accept" ? ".step,.stp" : null,
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

  it("uses the approved standalone uploader after a reviewed initial redirect", async () => {
    const workerTempDir = await makeTempDir();
    const standaloneUpload = vi.fn();
    const genericUpload = vi.fn();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      gotoRedirectUrl: XOMETRY_URLS.quoteCreation,
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-DIRECT-STANDALONE-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => name === "accept" ? ".step,.stp" : null,
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

  it("routes the authenticated account quote list through the global instant-quote action", async () => {
    const workerTempDir = await makeTempDir();
    const openInstantQuote = vi.fn();
    const standaloneUpload = vi.fn();
    let quoteSurfaceOpened = false;
    const summaryText = [
      "My Account",
      "Part Library",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      dashboardRedirectUrl: "https://www.xometry.com/quoting/new",
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-ACCOUNT-DASHBOARD-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: async () => {
            quoteSurfaceOpened = true;
            openInstantQuote();
          },
        },
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 0,
        },
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: () => quoteSurfaceOpened ? 1 : 0,
          getAttribute: (name) => name === "accept" ? ".step,.stp" : null,
          setInputFiles: standaloneUpload,
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
    expect(openInstantQuote).toHaveBeenCalledTimes(1);
    expect(standaloneUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
  });

  it("uses the reviewed same-route quote modal opened by the authenticated dashboard action", async () => {
    const workerTempDir = await makeTempDir();
    const openInstantQuote = vi.fn();
    const modalUpload = vi.fn();
    const startInstantQuote = vi.fn();
    const genericUpload = vi.fn();
    let modalOpened = false;
    const summaryText = [
      "My Account",
      "Part Library",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      modalSubmitRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-ACCOUNT-MODAL-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: async () => {
            modalOpened = true;
            openInstantQuote();
          },
        },
        [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
          count: () => modalOpened ? 1 : 0,
          getAttribute: () => "",
          setInputFiles: modalUpload,
        },
        [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
          count: () => modalOpened ? 1 : 0,
          text: () => modalUpload.mock.calls.length > 0
            ? "Start a New Quote part.step"
            : "Start a New Quote Upload a 3D model",
        },
        [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
          count: () => modalOpened ? 1 : 0,
          click: startInstantQuote,
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
      uploadSelector: XOMETRY_LOCATORS.accountQuoteModalInputs[0],
      requirementsVerified: true,
    });
    expect(openInstantQuote).toHaveBeenCalledTimes(1);
    expect(modalUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
    expect(startInstantQuote).toHaveBeenCalledTimes(1);
    expect(genericUpload).not.toHaveBeenCalled();
  });

  it("waits for the reviewed quote-modal submit action to appear", async () => {
    const workerTempDir = await makeTempDir();
    const modalUpload = vi.fn();
    const startInstantQuote = vi.fn();
    let modalOpened = false;
    let submitCountChecks = 0;
    const summaryText = [
      "My Account",
      "Part Library",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      modalSubmitRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-DELAYED-MODAL-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: () => {
            modalOpened = true;
          },
        },
        [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
          count: () => modalOpened ? 1 : 0,
          getAttribute: () => "",
          setInputFiles: modalUpload,
        },
        [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
          count: () => modalOpened ? 1 : 0,
          text: () => modalUpload.mock.calls.length > 0
            ? "Start a New Quote part.step"
            : "Start a New Quote Upload a 3D model",
        },
        [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
          count: () => {
            submitCountChecks += 1;
            return submitCountChecks >= 3 ? 1 : 0;
          },
          click: startInstantQuote,
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

    await expect(adapter.quote(makeInput())).resolves.toMatchObject({
      status: "instant_quote_received",
    });
    expect(submitCountChecks).toBeGreaterThanOrEqual(3);
    expect(startInstantQuote).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the reviewed quote-modal submit action stays disabled", async () => {
    const workerTempDir = await makeTempDir();
    const modalUpload = vi.fn();
    const startInstantQuote = vi.fn();
    let modalOpened = false;
    const page = createFakePage({
      bodyText: "My Account Part Library",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: () => {
            modalOpened = true;
          },
        },
        [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
          count: () => modalOpened ? 1 : 0,
          getAttribute: () => "",
          setInputFiles: modalUpload,
        },
        [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
          count: () => modalOpened ? 1 : 0,
          text: () => modalUpload.mock.calls.length > 0
            ? "Start a New Quote part.step"
            : "Start a New Quote Upload a 3D model",
        },
        [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
          count: () => modalOpened ? 1 : 0,
          click: startInstantQuote,
          isEnabled: () => false,
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
        reason: "quote_modal_submit_action_disabled",
        stateId: "authenticated_account_dashboard",
      },
    });
    expect(modalUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
    expect(startInstantQuote).not.toHaveBeenCalled();
  });

  it("rejects an unsupported CAD extension before interacting with the reviewed modal uploader", async () => {
    const workerTempDir = await makeTempDir();
    const modalUpload = vi.fn();
    const startInstantQuote = vi.fn();
    let modalOpened = false;
    const page = createFakePage({
      bodyText: "My Account Part Library",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: () => {
            modalOpened = true;
          },
        },
        [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
          count: () => modalOpened ? 1 : 0,
          getAttribute: () => "",
          setInputFiles: modalUpload,
        },
        [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
          count: () => modalOpened ? 1 : 0,
          text: "Start a New Quote Upload a 3D model",
        },
        [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
          count: () => modalOpened ? 1 : 0,
          click: startInstantQuote,
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

    await expect(adapter.quote(makeInput({
      stagedCadFile: {
        ...input.stagedCadFile!,
        originalName: "part.iges",
        localPath: "/tmp/part.iges",
      },
    }))).rejects.toMatchObject({
      code: "upload_failure",
      payload: {
        reason: "unsupported_file_type",
        accept: null,
        requestedExtensions: [".iges"],
        localAllowedExtensions: [".step", ".stp"],
      },
    });
    expect(modalUpload).not.toHaveBeenCalled();
    expect(startInstantQuote).not.toHaveBeenCalled();
  });

  it("does not submit the reviewed quote modal when upload progress is never confirmed", async () => {
    const workerTempDir = await makeTempDir();
    const modalUpload = vi.fn();
    const startInstantQuote = vi.fn();
    let modalOpened = false;
    const page = createFakePage({
      bodyText: "My Account Part Library",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: () => {
            modalOpened = true;
          },
        },
        [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
          count: () => modalOpened ? 1 : 0,
          getAttribute: () => "",
          setInputFiles: modalUpload,
        },
        [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
          count: () => modalOpened ? 1 : 0,
          text: "Start a New Quote Upload a 3D model",
        },
        [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
          count: () => modalOpened ? 1 : 0,
          click: startInstantQuote,
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
      code: "upload_failure",
      payload: {
        reason: "upload_progress_not_confirmed",
        filenames: ["part.step"],
      },
    });
    expect(modalUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
    expect(startInstantQuote).not.toHaveBeenCalled();
  });

  it("waits for the authenticated account dashboard to replace a transient login shell", async () => {
    const workerTempDir = await makeTempDir();
    const modalUpload = vi.fn();
    let bodyReads = 0;
    let modalOpened = false;
    const summaryText = [
      "My Account",
      "Part Library",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: () => {
        bodyReads += 1;
        return bodyReads === 1 ? "Log In Register" : summaryText;
      },
      waitForFunctionAttempts: 2,
      modalSubmitRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-HYDRATED-MODAL-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: () => {
            modalOpened = true;
          },
        },
        [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
          count: () => modalOpened ? 1 : 0,
          getAttribute: () => "",
          setInputFiles: modalUpload,
        },
        [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
          count: () => modalOpened ? 1 : 0,
          text: () => modalUpload.mock.calls.length > 0
            ? "Start a New Quote part.step"
            : "Start a New Quote Upload a 3D model",
        },
        [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
          count: () => modalOpened ? 1 : 0,
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

    await expect(adapter.quote(makeInput())).resolves.toMatchObject({
      status: "instant_quote_received",
    });
    expect(bodyReads).toBeGreaterThan(1);
    expect(modalUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
  });

  it("retries the reviewed dashboard action once when the first hydrated click is lost", async () => {
    const workerTempDir = await makeTempDir();
    const modalUpload = vi.fn();
    let actionClicks = 0;
    let modalOpened = false;
    const summaryText = [
      "My Account",
      "Part Library",
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      modalSubmitRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-RETRIED-MODAL-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: () => {
            actionClicks += 1;
            modalOpened = actionClicks === 2;
          },
        },
        [XOMETRY_LOCATORS.accountQuoteModalInputs[0]]: {
          count: () => modalOpened ? 1 : 0,
          getAttribute: () => "",
          setInputFiles: modalUpload,
        },
        [XOMETRY_LOCATORS.accountQuoteModalPanels[0]]: {
          count: () => modalOpened ? 1 : 0,
          text: () => modalUpload.mock.calls.length > 0
            ? "Start a New Quote part.step"
            : "Start a New Quote Upload a 3D model",
        },
        [XOMETRY_LOCATORS.accountQuoteModalSubmitButtons[0]]: {
          count: () => modalOpened ? 1 : 0,
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

    await expect(adapter.quote(makeInput())).resolves.toMatchObject({
      status: "instant_quote_received",
    });
    expect(actionClicks).toBe(2);
    expect(modalUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
  });

  it("requires both account quote-list signals before activating the global action", async () => {
    const workerTempDir = await makeTempDir();
    const openInstantQuote = vi.fn();
    const page = createFakePage({
      bodyText: "My Account",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: openInstantQuote,
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
    });
    expect(openInstantQuote).not.toHaveBeenCalled();
  });

  it("fails closed when the account quote list has ambiguous global actions", async () => {
    const workerTempDir = await makeTempDir();
    const openInstantQuote = vi.fn();
    const competingUpload = vi.fn();
    const page = createFakePage({
      bodyText: "My Account Part Library",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 2,
          click: openInstantQuote,
        },
        [XOMETRY_LOCATORS.dashboardUploadButtons[0]]: {
          count: 1,
        },
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: 1,
          setInputFiles: competingUpload,
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
    });
    expect(openInstantQuote).not.toHaveBeenCalled();
    expect(competingUpload).not.toHaveBeenCalled();
  });

  it("does not activate login or labeled or unlabeled Part Library per-file actions", async () => {
    const workerTempDir = await makeTempDir();
    const loginAction = vi.fn();
    const perFileAction = vi.fn();
    const unlabeledPerFileAction = vi.fn();
    const page = createFakePage({
      bodyText: "My Account Part Library",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 0,
        },
        'a[href="/login/"]:has-text("Start a quote")': {
          count: 1,
          click: loginAction,
        },
        'button[aria-label^="Get an Instant Quote for"]': {
          count: 1,
          click: perFileAction,
        },
        'button:text-is("Get an Instant Quote"):not([aria-label])': {
          count: 1,
          click: unlabeledPerFileAction,
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
    });
    expect(loginAction).not.toHaveBeenCalled();
    expect(perFileAction).not.toHaveBeenCalled();
    expect(unlabeledPerFileAction).not.toHaveBeenCalled();
  });

  it("rechecks authentication after the account quote-list action", async () => {
    const workerTempDir = await makeTempDir();
    let redirectedToLogin = false;
    const uploadCad = vi.fn();
    const page = createFakePage({
      bodyText: () => redirectedToLogin
        ? "Sign in to continue"
        : "My Account Part Library",
      dashboardRedirectUrl: "https://www.xometry.com/login/",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: async () => {
            redirectedToLogin = true;
          },
        },
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: 1,
          setInputFiles: uploadCad,
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
      code: "login_required",
    });
    expect(uploadCad).not.toHaveBeenCalled();
  });

  it("rejects an off-route destination even when an approved uploader is present", async () => {
    const workerTempDir = await makeTempDir();
    const uploadCad = vi.fn();
    const page = createFakePage({
      bodyText: "My Account Part Library",
      dashboardRedirectUrl: "https://www.xometry.com/account/part-library",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
        },
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: 1,
          setInputFiles: uploadCad,
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
    });
    expect(uploadCad).not.toHaveBeenCalled();
  });

  it("rejects a late-mounted account input without approved navigation", async () => {
    const workerTempDir = await makeTempDir();
    let accountInputMounted = false;
    const uploadCad = vi.fn();
    const page = createFakePage({
      bodyText: "My Account Part Library",
      dashboardNavigationFails: true,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: async () => {
            accountInputMounted = true;
          },
        },
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: () => accountInputMounted ? 1 : 0,
          setInputFiles: uploadCad,
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
    });
    expect(uploadCad).not.toHaveBeenCalled();
  });

  it("revalidates the approved route immediately before account file selection", async () => {
    const workerTempDir = await makeTempDir();
    let quoteSurfaceOpened = false;
    const uploadCad = vi.fn();
    const page = createFakePage({
      bodyText: "My Account Part Library",
      dashboardRedirectUrl: XOMETRY_URLS.quoteCreation,
      routeChangeAfterAcceptUrl:
        "https://www.xometry.com/account/part-library",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.accountQuoteListStartButtons[0]]: {
          count: 1,
          click: async () => {
            quoteSurfaceOpened = true;
          },
        },
        [XOMETRY_LOCATORS.standaloneUploadInputs[0]]: {
          count: () => quoteSurfaceOpened ? 1 : 0,
          getAttribute: (name) => name === "accept" ? ".step,.stp" : null,
          setInputFiles: uploadCad,
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
      code: "navigation_failure",
    });
    expect(uploadCad).not.toHaveBeenCalled();
  });

  it("revalidates target uniqueness immediately before dashboard file selection", async () => {
    const workerTempDir = await makeTempDir();
    let secondTargetMounted = false;
    const firstUpload = vi.fn();
    const secondUpload = vi.fn();
    const page = createFakePage({
      bodyText: "Pick Up Where You Left Off",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => {
            if (name === "accept") {
              secondTargetMounted = true;
              return ".step,.stp";
            }
            return null;
          },
          setInputFiles: firstUpload,
        },
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: () => secondTargetMounted ? 1 : 0,
          setInputFiles: secondUpload,
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
      code: "navigation_failure",
      payload: {
        reason: "approved_upload_target_changed",
      },
    });
    expect(firstUpload).not.toHaveBeenCalled();
    expect(secondUpload).not.toHaveBeenCalled();
  });

  it("distinguishes an invalid target before readiness from a later target change", async () => {
    const workerTempDir = await makeTempDir();
    let targetCountReads = 0;
    const uploadCad = vi.fn();
    const page = createFakePage({
      bodyText: "Pick Up Where You Left Off",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: () => {
            targetCountReads += 1;
            return targetCountReads <= 3 ? 1 : 0;
          },
          setInputFiles: uploadCad,
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
        reason: "approved_upload_target_invalid",
      },
    });
    expect(uploadCad).not.toHaveBeenCalled();
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
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
            "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
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
    expect(acceptReads).toBe(4);
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
    expect(acceptReads).toBe(4);
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
      code: "upload_failure",
      payload: {
        reason: "upload_progress_not_confirmed",
        url: XOMETRY_URLS.quoteHome,
      },
    });
    expect(dashboardCadUpload).toHaveBeenCalledWith(["/tmp/part.step"]);
  });

  it("tracks live evaluation upload progress by the original uploaded filename", async () => {
    const workerTempDir = await makeTempDir();
    const input = await makeLiveEvaluationInput();
    input.stagedCadFile = {
      ...input.stagedCadFile!,
      originalName: "original-design.step",
    };
    input.cadFile = {
      ...input.cadFile!,
      original_name: "original-design.step",
    };
    let uploadPanelReads = 0;
    const page = createFakePage({
      bodyText: "Upload at least 1 CAD file to get started.",
      delayedUploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-EVALUATION-0001",
      delayedUploadRedirectAfterTimeouts: 25,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.dashboardUploadPanels[0]]: {
          count: 1,
          text: () => {
            uploadPanelReads += 1;
            return "original-design.step";
          },
        },
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: vi.fn(),
        },
      },
    });
    playwrightLaunchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = makeLiveEvaluationAdapter(
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    await expect(adapter.quote(input)).rejects.toMatchObject({
      code: "selector_failure",
      payload: {
        url: "https://www.xometry.com/quoting/quote/Q00-EVALUATION-0001",
      },
    });
    expect(uploadPanelReads).toBe(1);
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
      code: "upload_failure",
      payload: {
        reason: "upload_progress_not_confirmed",
        url: XOMETRY_URLS.quoteHome,
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
        reason: "entry_state_transition_failed",
        matchedStates: ["direct_quote_home_uploader"],
        evidence: {
          route: "quote_home",
          dashboardUploadButtonCount: 1,
          dashboardInputCount: 0,
        },
      },
    });
    expect(dashboardUploadClick).toHaveBeenCalledTimes(1);
    expect(toolLibraryUpload).not.toHaveBeenCalled();
  });

  it("fails closed when two approved dashboard upload targets are mounted", async () => {
    const workerTempDir = await makeTempDir();
    const firstUpload = vi.fn();
    const secondUpload = vi.fn();
    const page = createFakePage({
      bodyText: "Pick Up Where You Left Off",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: firstUpload,
        },
        [XOMETRY_LOCATORS.uploadInputs[1]]: {
          count: 1,
          setInputFiles: secondUpload,
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
        reason: "entry_state_transition_failed",
        matchedStates: ["direct_quote_home_uploader"],
        evidence: {
          dashboardInputCount: 2,
        },
      },
    });
    expect(firstUpload).not.toHaveBeenCalled();
    expect(secondUpload).not.toHaveBeenCalled();
  });

  it("does not let a visible quantity input override a contradictory summary", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 1",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-QUANTITY-0001",
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

  describe("OVD-776 line-item quantity guard before price capture", () => {
    // Saved T1 quote page text (/workspace/ovd774-evidence/xometry-explore-r6-q11.txt)
    // with a placeholder quote id. The summary "Quantity" row is a bare label.
    // Prices carry a USD marker because bare "$" amounts are untrusted on main
    // (OVD-778); the amounts are the T1 page's ten-piece prices.
    const t1QuotePageText = (each: string, total: string, summaryQuantity: string) => [
      "Dashboard / Quotes / Q00-TEST-0901",
      "Q00-TEST-0901",
      "1 Part Uploaded",
      "1",
      "part.step",
      "Revise CAD",
      "Remove Part",
      "Repeat Part",
      summaryQuantity,
      " Edit Configuration",
      "Process: CNC Machining",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Measurement: 46.99 mm × 33.39 mm × 33.39 mm",
      "Preferred Subprocess: No Preference",
      "Finish: Black Anodize",
      "Threads and Tapped Holes: 0",
      "Inserts: 0",
      "Precision Tolerance: ±.005″ (±0.13mm)",
      "Inspection: Standard Inspection",
      "Price and Lead Time",
      " Least Expensive",
      "Arrives by Nov 6",
      `USD $${each} ea.`,
      `USD $${total}`,
      "Continue to CheckoutForward to Purchaser",
    ].join("\n");

    async function quoteT1Page(input: {
      each: string;
      total: string;
      lineItemQuantity?: string;
      strayQuantity?: string;
      summaryQuantity?: string;
    }) {
      const workerTempDir = await makeTempDir();
      const bodyText = t1QuotePageText(input.each, input.total, input.summaryQuantity ?? "Quantity");
      const selectorBehaviors: Record<string, LocatorBehavior> = {
        [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
        [XOMETRY_LOCATORS.priceText[0]]: {
          count: 1,
          text: `Least Expensive\nArrives by Nov 6\nUSD $${input.each} ea.\nUSD $${input.total}`,
        },
      };
      if (input.lineItemQuantity !== undefined) {
        selectorBehaviors[XOMETRY_LOCATORS.lineItemQuantityInputs[0]] = {
          count: 1,
          inputValue: () => input.lineItemQuantity ?? "",
        };
      }
      if (input.strayQuantity !== undefined) {
        // A generic number input elsewhere on the page. The pre-OVD-776
        // summary fallback read the first visible input of this kind.
        selectorBehaviors['input[type="number"]'] = {
          count: 1,
          inputValue: () => input.strayQuantity ?? "",
          fill: vi.fn(),
          press: vi.fn(),
        };
      }
      const page = createFakePage({
        bodyText,
        uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0901",
        selectorBehaviors,
      });
      launchMock.mockResolvedValue(createFakeBrowser(page));
      const adapter = new XometryAdapter(
        "xometry",
        makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
      );
      return adapter.quote(makeInput({ requestedQuantity: 1 }));
    }

    it("captures a qty-1 price when the line-item input reads back 1 under a blank summary row", async () => {
      const result = await quoteT1Page({ each: "41.41", total: "41.41", lineItemQuantity: "1", strayQuantity: "10" });

      expect(result.status).toBe("instant_quote_received");
      expect(result.totalPriceUsd).toBe(41.41);
      expect(result.unitPriceUsd).toBe(41.41);
    });

    it("refuses the T1 ten-piece price for a qty-1 run even when the line item reads 1", async () => {
      const failure = await quoteT1Page({ each: "41.41", total: "414.15", lineItemQuantity: "1" })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(VendorAutomationError);
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: { reason: "quantity_mismatch", requestedQuantity: 1, observedQuantity: 10 },
      });
    });

    it("trusts the line-item input over a summary label that claims the requested quantity", async () => {
      const failure = await quoteT1Page({
        each: "41.41",
        total: "414.15",
        lineItemQuantity: "10",
        strayQuantity: "1",
        summaryQuantity: "Quantity: 1",
      })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(VendorAutomationError);
      expect(failure).toMatchObject({
        payload: { reason: "quantity_mismatch", observedLineItemQuantities: [10] },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "configuration_required",
      });
      expect((failure as VendorAutomationError).artifacts.map((artifact) => artifact.label))
        .toContain("quantity-unverified-dom");
    });

    it("fails closed with no price when no line-item quantity input can be read", async () => {
      const failure = await quoteT1Page({ each: "41.41", total: "41.41", strayQuantity: "1", summaryQuantity: "Quantity: 1" })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(VendorAutomationError);
      expect(failure).toMatchObject({
        payload: { reason: "quantity_unverified", observedLineItemQuantities: [] },
      });
      // OVD-1052: the refusal is a finite selector-drift stop, not an
      // unclassified failure (finite_terminal_state_missing).
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "selector_drift",
      });
    });
  });

  describe("OVD-1052 current quote-page price panel", () => {
    // Hand-built structural fixture of the 2026-10-23 quote page; every value
    // in it is synthetic. Never replace it with a captured page.
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "xometry-quote-page-price-panel-2026-10.html",
    );
    const lineBreakingTags = new Set(["BODY", "DIV", "P", "LABEL", "SECTION", "MAIN", "DIALOG", "UL", "LI"]);

    /** Whether an element's inline style removes it and its subtree from rendering (the fixture's main hiding). */
    const displayNone = (element: Element) => /display:\s*none/i.test(element.getAttribute("style") ?? "");
    /** Whether an element's inline style hides it and its subtree (display:none or visibility:hidden). */
    const hiddenByStyle = (element: Element) =>
      displayNone(element) || /visibility:\s*hidden/i.test(element.getAttribute("style") ?? "");

    /**
     * Approximates Playwright's innerText for the fixture: hidden subtrees are
     * skipped, block boxes break lines, source indentation collapses, and the
     * no-break space Xometry renders after a tier icon is kept. As in a
     * browser, an element that is not rendered at all (display:none on it or
     * an ancestor) returns its full text content instead.
     */
    function renderedText(root: Element) {
      for (let node: Element | null = root; node; node = node.parentElement) {
        if (displayNone(node)) return root.textContent ?? "";
      }
      const parts: string[] = [];
      const visit = (node: Node) => {
        if (node.nodeType === node.TEXT_NODE) {
          parts.push((node.textContent ?? "").replaceAll(/[ \t\r\n]+/g, " "));
          return;
        }
        if (node.nodeType !== node.ELEMENT_NODE) return;
        const element = node as Element;
        if (hiddenByStyle(element)) return;
        const breaksLine = lineBreakingTags.has(element.tagName);
        if (breaksLine) parts.push("\n");
        element.childNodes.forEach(visit);
        if (breaksLine) parts.push("\n");
      };
      visit(root);
      return parts
        .join("")
        .split("\n")
        .map((line) => line.replaceAll(/^ +| +$/g, ""))
        .filter(Boolean)
        .join("\n");
    }

    /**
     * Approximates Playwright's :visible (a non-empty bounding box, not
     * hidden) for the fixture: neither the element nor an ancestor is
     * hidden by its inline style, and it renders some text,
     * since nothing in the fixture is sized without text (an empty
     * <span data-testid="tierAndLeadTime"></span> has a zero-width box).
     */
    function isRendered(element: Element) {
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (hiddenByStyle(node)) return false;
      }
      return renderedText(element) !== "";
    }

    /**
     * Locator behavior backed by fixture elements: every scoped selector the
     * collector asks for (tier label, list price, nested cards, disabled
     * descendants, enclosing elements) resolves against the element itself
     * (see resolveSelector).
     *
     * Test hook: an element with data-test-unreadable="text" (or "attributes")
     * rejects every innerText (or getAttribute) read, as a detached element
     * would; "nested-attributes" rejects only when the element is reached
     * through another element's scoped locator (as an enclosing element is).
     */
    function domBehavior(elements: Iterable<Element>, nested = false): LocatorBehavior {
      const detached = () => {
        throw new Error("element was detached");
      };
      return {
        items: [...elements].map((element) => {
          const unreadable = element.getAttribute("data-test-unreadable");
          const textUnreadable = unreadable === "text";
          const attributesUnreadable = unreadable === "attributes" || (nested && unreadable === "nested-attributes");
          return {
            count: 1,
            text: textUnreadable ? detached : renderedText(element),
            getAttribute: attributesUnreadable ? detached : (name: string) => element.getAttribute(name),
            evaluate: (pageFunction: (element: Element) => unknown) => pageFunction(element),
            children: (selector: string) => resolveSelector(element, selector, true),
          };
        }),
      };
    }

    /**
     * Resolves a Playwright selector from a fixture document or element. A
     * trailing `:visible` keeps only rendered matches, and an `xpath=`
     * selector (the ancestor axis) is evaluated from the root in document
     * order, as Playwright's XPath engine does.
     */
    function resolveSelector(root: Document | Element, selector: string, nested = false): LocatorBehavior {
      if (selector.startsWith("xpath=")) {
        const owner = root.ownerDocument ?? (root as Document);
        // 7 is XPathResult.ORDERED_NODE_SNAPSHOT_TYPE.
        const result = owner.evaluate(selector.slice("xpath=".length), root, null, 7, null);
        const matches = Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index))
          .filter((node): node is Element => node !== null && node.nodeType === node.ELEMENT_NODE);
        return domBehavior(matches, nested);
      }
      const visibleOnly = selector.endsWith(":visible");
      const matches = [...root.querySelectorAll(visibleOnly ? selector.slice(0, -":visible".length) : selector)];
      return domBehavior(visibleOnly ? matches.filter(isRendered) : matches, nested);
    }

    /**
     * DOM behaviors for every fallback price/lead/review selector jsdom can
     * parse (Playwright-only ones such as :has-text stay unmatched), so the
     * adapter's fallback reads see what the fixture page would show.
     */
    function fallbackSelectorBehaviors(document: Document) {
      const selectors = [
        ...XOMETRY_LOCATORS.priceText,
        ...XOMETRY_LOCATORS.leadTimeText,
        ...XOMETRY_LOCATORS.manualReviewText,
      ];
      return Object.fromEntries(selectors.flatMap((selector) => {
        try {
          return [[selector, domBehavior(document.querySelectorAll(selector))]];
        } catch {
          return [];
        }
      }));
    }

    const tierCardSelector = XOMETRY_LOCATORS.priceTierCard;
    /** The page-level selectors the collector reads: the cards, and every rendered tier label on and in them. */
    const collectorPageSelectors = [
      tierCardSelector,
      '[data-testid="tierAndLeadTime"]:visible',
      `${tierCardSelector} [data-testid="tierAndLeadTime"]:visible`,
    ];

    async function loadCurrentQuotePage(mutate?: (document: Document) => void) {
      const { document } = new JSDOM(await fs.readFile(fixturePath, "utf8")).window;
      mutate?.(document);
      const cards = [...document.querySelectorAll(tierCardSelector)].map((card) => {
        const timing = card.querySelector('[data-testid="tierAndLeadTime"]');
        // Only a blank card (a skeleton still loading) may lack its timing label.
        if (!timing && renderedText(card) !== "") throw new Error("fixture tier card lost its tierAndLeadTime hook");
        return { text: renderedText(card), tierText: timing ? renderedText(timing) : "" };
      });
      // Mirrors div:has(> span:text-is("Quantity")) > div > input[type="number"].
      const quantityInputs = [...document.querySelectorAll('div > div > input[type="number"]')].filter((input) =>
        [...(input.parentElement?.parentElement?.children ?? [])].some((sibling) =>
          sibling.tagName === "SPAN" && sibling.textContent?.trim() === "Quantity"));
      return {
        document,
        bodyText: renderedText(document.body),
        hiddenTemplates: [...document.querySelectorAll("dialog span")]
          .map((span) => span.textContent?.trim() ?? "")
          .filter(Boolean),
        cards,
        quantityInputs,
        collectorBehaviors: Object.fromEntries(collectorPageSelectors.map((selector) =>
          [selector, resolveSelector(document, selector)])),
      };
    }

    /** A page whose every selector resolves against the fixture DOM. */
    function fixturePage(fixture: Awaited<ReturnType<typeof loadCurrentQuotePage>>) {
      return {
        url: () => "https://www.xometry.com/quoting/quote/Q00-TEST-1052",
        locator: (selector: string) => makeLocator(resolveSelector(fixture.document, selector)),
      } as unknown as Parameters<typeof collectXometryOffers>[0];
    }

    /**
     * Runs the page-side settle predicate against a fixture document. jsdom
     * has no innerText, so renderedText (the collector harness's innerText)
     * stands in for it: the predicate and the collector read the same lines.
     */
    function settledOnDocument(document: Document, fileNames: string[] = []) {
      const view = document.defaultView;
      if (!view) throw new Error("fixture document has no window");
      Object.defineProperty(view.HTMLElement.prototype, "innerText", {
        configurable: true,
        get(this: HTMLElement) {
          return renderedText(this);
        },
      });
      const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
      Object.defineProperty(globalThis, "document", { configurable: true, value: document });
      try {
        return xometryPriceTiersSettled(fileNames);
      } finally {
        if (previous) {
          Object.defineProperty(globalThis, "document", previous);
        } else {
          Reflect.deleteProperty(globalThis, "document");
        }
      }
    }

    /**
     * Quotes the fixture page through adapter.quote. The price-tier settle
     * wait runs the real predicate against the fixture DOM and times out when
     * it does not settle, as page.waitForFunction would.
     */
    async function quoteCurrentPage(options: {
      mutate?: (document: Document) => void;
      cadFileName?: string;
      /** The staged CAD file's local basename, when it differs from cadFileName (its originalName). */
      cadLocalFileName?: string;
      /** Also resolve the fallback price/lead/review selectors against the fixture DOM. */
      resolveFallbackSelectors?: boolean;
      /** The body text the page shows from the price-tier settle wait onward. */
      pricingBodyText?: (bodyText: string) => string;
      /** The price-tier settle wait times out whatever the predicate says. */
      priceTiersTimeOut?: boolean;
    } = {}) {
      const fixture = await loadCurrentQuotePage(options.mutate);
      const labelledQuantitySelector = XOMETRY_LOCATORS.lineItemQuantityInputs.find((selector) =>
        selector.includes('span:text-is("Quantity")'));
      expect(labelledQuantitySelector).toBeDefined();
      const workerTempDir = await makeTempDir();
      let bodyText = fixture.bodyText;
      const page = createFakePage({
        bodyText: () => bodyText,
        uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-1052",
        selectorBehaviors: {
          [XOMETRY_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
          [labelledQuantitySelector ?? "missing"]: {
            count: fixture.quantityInputs.length,
            inputValue: () => fixture.quantityInputs[0]?.getAttribute("value") ?? "",
          },
          ...(options.resolveFallbackSelectors ? fallbackSelectorBehaviors(fixture.document) : {}),
          // The tier cards and the page's tier labels resolve against the fixture DOM.
          ...fixture.collectorBehaviors,
        },
      });
      const requestedSelectors: string[] = [];
      const locate = page.locator.bind(page);
      page.locator = (selector: string) => {
        requestedSelectors.push(selector);
        return locate(selector);
      };
      const { pricingBodyText, priceTiersTimeOut } = options;
      const waitForFunction = page.waitForFunction.bind(page);
      page.waitForFunction = async (callback: unknown, argument?: unknown) => {
        if (callback !== xometryPriceTiersSettled) return waitForFunction(callback, argument);
        if (pricingBodyText) bodyText = pricingBodyText(fixture.bodyText);
        if (priceTiersTimeOut || !settledOnDocument(fixture.document, argument as string[] | undefined)) {
          throw new Error("Timeout exceeded while waiting for the price tiers");
        }
        return undefined;
      };
      launchMock.mockResolvedValue(createFakeBrowser(page));
      const baseInput = makeInput();
      const input = makeInput({
        requestedQuantity: 1,
        ...(options.cadFileName ? { stagedCadFile: {
          ...baseInput.stagedCadFile!,
          originalName: options.cadFileName,
          localPath: path.join(workerTempDir, options.cadLocalFileName ?? options.cadFileName),
        } } : {}),
        requirement: { ...baseInput.requirement, finish: "as machined", quantity: 1, quote_quantities: [1] },
      });
      const adapter = new XometryAdapter(
        "xometry",
        makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
      );
      return { fixture, input, requestedSelectors, result: await adapter.quote(input) };
    }

    const expectedTierOffers = [
      { id: "least-expensive", total: 101.25, arrives: "Nov 3" },
      { id: "standard", total: 106.4, arrives: "Nov 6" },
      { id: "fastest", total: 117.1, arrives: "Oct 30" },
    ];
    const offerSummary = (offers: Awaited<ReturnType<typeof collectXometryOffers>>) => offers.map((offer) => ({
      id: offer.providerOptionId,
      total: offer.totalPriceUsd,
      arrives: offer.shipReceiveBy,
    }));
    const tierCards = (document: Document) => [...document.querySelectorAll(tierCardSelector)];
    const nthCard = (document: Document, index: number) => {
      const card = tierCards(document)[index];
      if (!card) throw new Error(`fixture lost tier card ${index}`);
      return card;
    };
    const firstCard = (document: Document) => nthCard(document, 0);
    const dragHandleSelector = '#draggable-parts > [role="button"]';
    const dragHandle = (document: Document) => {
      const handle = document.querySelector(dragHandleSelector);
      if (!handle) throw new Error("fixture lost its drag handle");
      return handle;
    };
    const keepFirstCardOnly = (document: Document) => {
      for (const card of tierCards(document).slice(1)) card.remove();
    };
    const addToPartCard = (document: Document, html: string) => {
      const partCard = document.querySelector(".part-card");
      if (!partCard) throw new Error("fixture lost its part card");
      partCard.insertAdjacentHTML("afterbegin", html);
    };
    /** The innermost element that holds every tier card: the fixture's price panel. */
    const pricePanel = (document: Document) => {
      const panel = firstCard(document).parentElement;
      if (!panel || panel.querySelectorAll(tierCardSelector).length !== tierCards(document).length) {
        throw new Error("fixture lost its price panel");
      }
      return panel;
    };
    /** Adds markup inside the price panel, after its last tier card. */
    const addToPanel = (html: string) => (document: Document) => {
      pricePanel(document).insertAdjacentHTML("beforeend", html);
    };
    /** Adds markup to the order summary, beside the parts list and outside every part card. */
    const addToOrderSummary = (document: Document, html: string) => {
      const summary = document.querySelector(".order-summary");
      if (!summary) throw new Error("fixture lost its order summary");
      summary.insertAdjacentHTML("afterbegin", html);
    };
    /** Adds markup inside a tier card, after its price block. */
    const addToCard = (index: number, html: string) => (document: Document) => {
      const block = nthCard(document, index).querySelector('[kind="outlineWhite"]');
      if (!block) throw new Error("fixture tier card lost its outlineWhite block");
      block.insertAdjacentHTML("beforeend", html);
    };
    /** Adds markup inside the first tier card, after its price block. */
    const addToFirstCard = (html: string) => addToCard(0, html);
    /** Removes a card's price block, as a tier the page shows without a price. */
    const unpriceCard = (index: number) => (document: Document) => {
      const amounts = nthCard(document, index).querySelector('[kind="discount"]');
      if (!amounts) throw new Error("fixture tier card lost its price block");
      amounts.replaceChildren();
    };
    /** Wraps a card in a new element of its own, between it and the drag handle. */
    const wrapCard = (card: Element) => {
      const wrapper = card.ownerDocument.createElement("div");
      card.before(wrapper);
      wrapper.append(card);
      return wrapper;
    };

    /** Ways the page can hide a tier card's copy: they hide it from innerText too. */
    const hiddenCopies: Array<[string, (copy: Element) => void]> = [
      ["display:none on the copy", (copy) => copy.setAttribute("style", "display: none;")],
      ["display:none on an element around the copy", (copy) => wrapCard(copy).setAttribute("style", "display: none;")],
      ["visibility:hidden on the copy", (copy) => copy.setAttribute("style", "visibility: hidden;")],
    ];
    /** Adds a copy of the first tier card right after it, hidden by the page. */
    const addHiddenCopy = (hide: (copy: Element) => void) => (document: Document) => {
      const copy = firstCard(document).cloneNode(true) as Element;
      firstCard(document).after(copy);
      hide(copy);
    };
    /** The part card's Finish requirement, which reads "Finish: Standard". */
    const finishRequirement = (document: Document) => {
      const finish = document.querySelector('[data-testid="requirement-Finish"]');
      if (!finish) throw new Error("fixture lost its Finish requirement");
      return finish;
    };
    /** Adds markup right after the Finish requirement, beside the part's configuration. */
    const addBesideFinish = (html: string) => (document: Document) => {
      finishRequirement(document).insertAdjacentHTML("afterend", html);
    };
    /**
     * Hidden copies the page can keep in the part card outside the price
     * panel. Neither is on screen, so neither may widen the price panel to
     * the part card around the configuration.
     */
    const hiddenCopiesOutsidePanel: Array<[string, (document: Document) => void]> = [
      ...hiddenCopies.map(([how, hide]): [string, (document: Document) => void] => [
        `a copy of a tier card after the Finish requirement (${how})`,
        (document) => {
          const copy = firstCard(document).cloneNode(true) as Element;
          finishRequirement(document).after(copy);
          hide(copy);
        },
      ]),
      ["a copy of the whole price panel at the top of the part card (display:none on the copy)", (document) => {
        const copy = pricePanel(document).cloneNode(true) as Element;
        copy.setAttribute("style", "display: none;");
        const partCard = document.querySelector(".part-card");
        if (!partCard) throw new Error("fixture lost its part card");
        partCard.prepend(copy);
      }],
    ];
    const finishNotice = "<div>Standard is not available for this material.</div>";

    async function failureOf(
      fixture: Awaited<ReturnType<typeof loadCurrentQuotePage>>,
      requestedQuantity = 1,
    ) {
      const failure = await collectXometryOffers(fixturePage(fixture), requestedQuantity)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(VendorAutomationError);
      return failure as VendorAutomationError;
    }

    /** The payload of a finite selector_drift stop. */
    async function driftOf(fixture: Awaited<ReturnType<typeof loadCurrentQuotePage>>, requestedQuantity = 1) {
      const failure = await failureOf(fixture, requestedQuantity);
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "selector_drift",
        violations: [],
      });
      return failure.payload;
    }

    /** The payload of a finite, retryable pending stop. */
    async function pendingOf(fixture: Awaited<ReturnType<typeof loadCurrentQuotePage>>) {
      const failure = await failureOf(fixture);
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "unavailable",
        violations: [],
      });
      return failure.payload;
    }

    it("pins the drift: the tier name left the timing label and the quantity input lost its aria-label", async () => {
      const fixture = await loadCurrentQuotePage();

      expect(fixture.cards.map((card) => card.tierText)).toEqual([
        "Arrives by Nov 3",
        "Arrives by Nov 6",
        "Arrives by Oct 30",
      ]);
      expect(fixture.cards.map((card) => card.text.split("\n")[0])).toEqual([
        " Least Expensive",
        " Standard",
        " Fastest",
      ]);
      expect(fixture.quantityInputs).toHaveLength(1);
      expect(fixture.quantityInputs[0]?.hasAttribute("aria-label")).toBe(false);
      // Hidden dialog templates are not visible text, so none of them reaches
      // the body text the adapter classifies. This pins only that exclusion,
      // not how a visible dialog with the same copy would be classified.
      expect(fixture.hiddenTemplates).toEqual(expect.arrayContaining([
        "Quote limit exceeded",
        "Your Quote Was Not Automatically Saved",
        "Delete Drawing",
      ]));
      for (const template of fixture.hiddenTemplates) {
        expect(fixture.bodyText).not.toContain(template);
      }
    });

    it("collects exactly the three tier cards, never the drag handle around them", async () => {
      // As captured (decrement disabled at quantity 1) and with the stepper
      // enabled: the stepper sits beside the cards, never around them.
      for (const enableStepper of [false, true]) {
        const fixture = await loadCurrentQuotePage((document) => {
          if (enableStepper) {
            for (const button of document.querySelectorAll("button[disabled]")) button.removeAttribute("disabled");
          }
        });
        const handles = [...fixture.document.querySelectorAll('#draggable-parts > div[role="button"][tabindex="0"]')];
        expect(handles).toHaveLength(1);
        expect(handles[0]?.querySelectorAll(tierCardSelector)).toHaveLength(3);
        expect(fixture.document.querySelectorAll("button[disabled]")).toHaveLength(enableStepper ? 0 : 1);

        const offers = await collectXometryOffers(fixturePage(fixture), 1);

        expect(offerSummary(offers)).toEqual(expectedTierOffers);
        expect(offers.map((offer) => offer.provenance.containerSelector)).toEqual(Array(3).fill(tierCardSelector));
      }
    });

    it("takes the list total from the card's part-discount slot when the amounts alone are ambiguous", async () => {
      const captured = await loadCurrentQuotePage();
      // Captured structure: <span>$list</span> (Save $x) inside part-discount.
      expect([...captured.document.querySelectorAll('[data-testid="part-discount"]')].map((slot) => ({
        list: [...slot.children].filter((child) => child.tagName === "SPAN").map((span) => span.textContent),
        text: slot.textContent,
      }))).toEqual([
        { list: ["$146.80"], text: "$146.80 (Save $45.55)" },
        { list: ["$139.95"], text: "$139.95 (Save $33.55)" },
        { list: ["$171.85"], text: "$171.85 (Save $54.75)" },
      ]);

      // $150.00 - $50.00 = $100.00 and $100.00 - $50.00 = $50.00, so only the
      // DOM slot can say that $150.00 is the struck-through list total.
      const fixture = await loadCurrentQuotePage((document) => {
        keepFirstCardOnly(document);
        const amounts = firstCard(document).querySelector('[kind="discount"]');
        if (!amounts) throw new Error("fixture tier card lost its price block");
        amounts.innerHTML = '<span kind="body-sm">$50.00 ea.</span><div>$100.00</div>'
          + '<div data-testid="part-discount"><span>$150.00</span> (Save $50.00)</div>';
      });
      const offers = await collectXometryOffers(fixturePage(fixture), 2);

      expect(offers).toEqual([expect.objectContaining({
        providerOptionId: "least-expensive",
        unitPriceUsd: 50,
        totalPriceUsd: 100,
      })]);
      // The same card text without the DOM slot fails closed.
      expect(() => parseXometryOfferSnapshots({
        requestedQuantity: 2,
        quoteUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-1052",
        snapshots: fixture.cards.map((card) => ({ selector: ".price-tier", ...card, attributes: {} })),
      })).toThrow(expect.objectContaining({
        payload: expect.objectContaining({
          reason: "xometry_offer_discount_unreconciled",
          discountFailure: "list_price_ambiguous",
          terminalState: "selector_drift",
        }),
      }));
    });

    it("captures all three tier cards as offers and ends offers_extracted", async () => {
      const { input, requestedSelectors, result } = await quoteCurrentPage();

      expect(result.status).toBe("instant_quote_received");
      expect(result.offers?.map((offer) => ({
        id: offer.providerOptionId,
        label: offer.providerLabel,
        unit: offer.unitPriceUsd,
        total: offer.totalPriceUsd,
        arrives: offer.shipReceiveBy,
      }))).toEqual([
        { id: "least-expensive", label: "Least Expensive", unit: 101.25, total: 101.25, arrives: "Nov 3" },
        { id: "standard", label: "Standard", unit: 106.4, total: 106.4, arrives: "Nov 6" },
        { id: "fastest", label: "Fastest", unit: 117.1, total: 117.1, arrives: "Oct 30" },
      ]);
      // The customer pays the discounted total; the struck-through list totals
      // ($146.80 / $139.95 / $171.85) are never anchored.
      expect(result.totalPriceUsd).toBe(101.25);
      expect(result.unitPriceUsd).toBe(101.25);
      const now = new Date("2026-10-23T00:00:00Z");
      expect(result.offers?.map((offer) => resolveXometryCompatibilityLeadTime(offer, now))).toEqual([7, 10, 5]);
      expect(evaluateProviderAdapterContract({
        definition: {
          provider: "xometry",
          allowedHosts: ["www.xometry.com"],
          selectors: { cadUpload: "input[type='file']" },
          requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
        },
        adapterInput: input,
        output: result,
      })).toMatchObject({ ok: true, terminalState: "offers_extracted", violations: [] });
      // Quote only: no checkout, purchaser hand-off or configuration save is targeted.
      expect(requestedSelectors.filter((selector) =>
        /continue to checkout|forward to purchaser|save configuration/i.test(selector))).toEqual([]);
    });

    const firstCardLabelSelector = `${tierCardSelector} [data-testid="tierAndLeadTime"]`;

    describe("the offer set is exactly the page's tier cards", () => {
      it("keeps a tier card whose hidden duplicate timing label is not a second tier", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          const labelSlot = document.querySelector(firstCardLabelSelector)?.parentElement;
          if (!labelSlot) throw new Error("fixture tier card lost its tierAndLeadTime hook");
          // Hidden duplicate ahead of the visible label, so it is also the
          // card's first label in document order.
          const hidden = document.createElement("div");
          hidden.setAttribute("style", "display: none;");
          hidden.innerHTML = '<label scale="small" data-testid="tierAndLeadTime"><div>Arrives by Nov 9</div></label>';
          labelSlot.before(hidden);
        });
        expect(firstCard(fixture.document).querySelectorAll('[data-testid="tierAndLeadTime"]')).toHaveLength(2);

        const offers = await collectXometryOffers(fixturePage(fixture), 1);

        // The cheapest option is neither dropped nor named from the hidden label.
        expect(offerSummary(offers)).toEqual(expectedTierOffers);
      });

      it("treats buttons nested in a card as part of that card", async () => {
        for (const keepHandle of [true, false]) {
          const fixture = await loadCurrentQuotePage((document) => {
            // Each card's content moves into one button, as a selectable tier would render.
            for (const card of tierCards(document)) {
              const block = card.querySelector('[kind="outlineWhite"]');
              if (!block) throw new Error("fixture tier card lost its outlineWhite block");
              const button = document.createElement("button");
              button.type = "button";
              button.append(...block.childNodes);
              block.append(button);
            }
            if (!keepHandle) dragHandle(document).removeAttribute("role");
          });

          const offers = await collectXometryOffers(fixturePage(fixture), 1);

          expect(offerSummary(offers)).toEqual(expectedTierOffers);
          expect(offers.map((offer) => offer.provenance.containerSelector)).toEqual(Array(3).fill(tierCardSelector));
        }
      });

      it.each([
        ["an empty", '<button type="button"><span data-testid="tierAndLeadTime"></span></button>'],
        [
          "a hidden",
          '<button type="button"><span data-testid="tierAndLeadTime" style="display: none;">Arrives by Nov 9</span></button>',
        ],
      ])("keeps a tier card whose nested button holds only %s timing label", async (_kind, button) => {
        const fixture = await loadCurrentQuotePage(addToFirstCard(button));
        expect(firstCard(fixture.document).querySelectorAll('[data-testid="tierAndLeadTime"]')).toHaveLength(2);

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it("ignores amounts and text outside the part card", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          addToOrderSummary(document, "<div>Handling $12.00</div><div>Expedited shipping not available</div>");
        });

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it.each([
        ["a nested button", '<button type="button"><span data-testid="tierAndLeadTime">Arrives by Nov 9</span></button>'],
        ["a second label slot", '<div><label data-testid="tierAndLeadTime"><div>Arrives by Nov 9</div></label></div>'],
      ])("fails closed on a card whose %s renders a second visible timing label", async (_where, html) => {
        const fixture = await loadCurrentQuotePage(addToFirstCard(html));

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "multiple_visible_tier_labels",
          containerSelector: tierCardSelector,
          containerIndex: 0,
          nestedTierCards: 0,
          visibleTierLabels: 2,
        });
      });

      it("fails closed on a tier card nested in another", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          const [, second] = tierCards(document);
          if (!second) throw new Error("fixture lost its second tier card");
          firstCard(document).append(second);
        });

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "nested_tier_cards",
          containerIndex: 0,
          nestedTierCards: 1,
        });
      });

      it("fails closed on a card whose text cannot be read instead of publishing the others", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          nthCard(document, 1).setAttribute("data-test-unreadable", "text");
        });

        expect(await driftOf(fixture)).toMatchObject({
          ambiguity: "shape_unreadable",
          containerSelector: tierCardSelector,
          containerIndex: 1,
          nestedTierCards: null,
          visibleTierLabels: null,
        });
      });

      it("fails closed when a card's timing labels cannot be counted", async () => {
        const page = {
          url: () => "https://www.xometry.com/quoting/quote/Q00-TEST-1052",
          locator: (selector: string) => makeLocator(selector === tierCardSelector
            ? {
              items: [{
                count: 1,
                text: "Standard\nArrives by Nov 6\n$50.00 ea.\n$50.00",
                // The card sits in its part card, but every read inside the card fails.
                children: (selector) => selector.startsWith("xpath=")
                  ? undefined
                  : { count: () => { throw new Error("card was detached"); } },
              }],
            }
            : { count: 0 }),
        } as unknown as Parameters<typeof collectXometryOffers>[0];

        const failure = await collectXometryOffers(page, 1).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          payload: {
            reason: "xometry_offer_container_ambiguous",
            terminalState: "selector_drift",
            ambiguity: "shape_unreadable",
            nestedTierCards: null,
            visibleTierLabels: null,
          },
        });
      });
    });

    describe("every rendered tier label belongs to a tier card", () => {
      it.each([
        ["a third tier card the selector no longer matches", (document: Document) => {
          nthCard(document, 2).className = "price-tier-legacy";
        }],
        ["a third visible tier label in the part card", (document: Document) => {
          nthCard(document, 2).remove();
          addToPartCard(document, '<div><label data-testid="tierAndLeadTime"><div>Arrives by Nov 9</div></label></div>');
        }],
      ])("fails closed instead of publishing two tiers when the page shows %s", async (_extra, mutate) => {
        const fixture = await loadCurrentQuotePage(mutate);
        expect(fixture.cards).toHaveLength(2);

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "wrapper_uncovered_content",
          containerSelector: tierCardSelector,
          visibleTierLabels: 3,
          coveredTierLabels: 2,
        });
      });

      it("fails closed with one card when another tier label sits outside it", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          keepFirstCardOnly(document);
          addToPartCard(document, '<div><label data-testid="tierAndLeadTime"><div>Arrives by Nov 9</div></label></div>');
        });

        expect(await driftOf(fixture)).toMatchObject({
          ambiguity: "wrapper_uncovered_content",
          visibleTierLabels: 2,
          coveredTierLabels: 1,
        });
      });

      it("counts the label of a card it excludes as covered, and ignores a hidden label outside the cards", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          unpriceCard(0)(document);
          addToFirstCard("<div>Not available</div>")(document);
          addToPartCard(
            document,
            '<div style="display: none;"><label data-testid="tierAndLeadTime"><div>Arrives by Nov 9</div></label></div>',
          );
        });

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers.slice(1));
      });

      it("never lets the adapter publish two of three tiers", async () => {
        const failure = await quoteCurrentPage({
          mutate: (document) => {
            nthCard(document, 2).className = "price-tier-legacy";
          },
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(VendorAutomationError);
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({
            reason: "xometry_offer_container_ambiguous",
            ambiguity: "wrapper_uncovered_content",
          }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "selector_drift",
          violations: [],
        });
      });
    });

    describe("the part card around the tier cards", () => {
      /** Renames a card's class and its timing label's hook, so neither selector finds that tier. */
      const renameTierHooks = (card: Element) => {
        card.className = "price-tier-v2";
        const label = card.querySelector('[data-testid="tierAndLeadTime"]');
        if (!label) throw new Error("fixture tier card lost its tierAndLeadTime hook");
        label.setAttribute("data-testid", "tierAndLeadTimeV2");
      };
      const renameThirdCardAndLabel = (document: Document) => renameTierHooks(nthCard(document, 2));
      /** A tier block with neither hook: no .price-tier class and no tierAndLeadTime label. */
      const hooklessTier = "<div><div>Economy</div><div>Arrives by Nov 20</div><div>$90.00 ea.</div><div>$90.00</div></div>";
      const repeatPartNote = "Mark as a Repeat Part if you have previously ordered this part with your personal Xometry account,"
        + " even if the geometry has been slightly revised. Pricing and lead time for Repeat Parts may vary.";
      /** Where a line can sit in the part card outside every card. */
      const partCardPlacements: Array<[string, (html: string) => (document: Document) => void]> = [
        ["the price panel", addToPanel],
        ["the part card outside the price panel", (html) => (document) => addToPartCard(document, html)],
      ];

      it("shows timing outside the cards only in its static lines, and the order summary's arrival date is never read", async () => {
        const fixture = await loadCurrentQuotePage();
        const cardLines = new Set(fixture.cards.flatMap((card) => card.text.split("\n")));
        const outsideLines = renderedText(dragHandle(fixture.document)).split("\n").filter((line) => !cardLines.has(line));
        expect(outsideLines.filter((line) => /lead\s+time|arriv|deliver|business\s+days|\$/i.test(line)))
          .toEqual([repeatPartNote, "Price and Lead Time"]);
        // Arrival text beside the part card, outside it.
        expect(fixture.bodyText).toMatch(/to arrive by Nov 6/);

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it("exempts only the Repeat Part note's sentence, not timing beside it on its line", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          const note = [...document.querySelectorAll("div")].find((element) => element.textContent === repeatPartNote);
          if (!note) throw new Error("fixture lost its Repeat Part note");
          note.textContent = `${repeatPartNote} Arrives by Nov 9`;
        });

        expect(await driftOf(fixture)).toMatchObject({ ambiguity: "wrapper_uncovered_content", uncoveredPartCardLines: 1 });
      });

      it("fails closed on a tier card whose class and label hook were both renamed", async () => {
        const fixture = await loadCurrentQuotePage(renameThirdCardAndLabel);
        expect(fixture.cards).toHaveLength(2);
        // Every rendered tier label still sits in a card, so only the part card shows the third tier.
        expect(fixture.document.querySelectorAll('[data-testid="tierAndLeadTime"]')).toHaveLength(2);

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "wrapper_uncovered_content",
          containerSelector: tierCardSelector,
          partCardLines: 20,
          uncoveredPartCardLines: 4,
        });
      });

      it.each([
        ["a hookless tier block in the part card, outside the price panel", (document: Document) => {
          addToPartCard(document, hooklessTier);
        }, 3],
        ["the third card, both hooks renamed, moved out of the price panel into the part card", (document: Document) => {
          const third = nthCard(document, 2);
          renameTierHooks(third);
          const partCard = document.querySelector(".part-card");
          if (!partCard) throw new Error("fixture lost its part card");
          partCard.prepend(third);
        }, 4],
        ["the third card renamed beside a new wrapper around the first two cards", (document: Document) => {
          const [first, second, third] = tierCards(document);
          const wrapper = wrapCard(first);
          wrapper.append(second);
          renameTierHooks(third);
        }, 4],
        ["the second and third cards renamed, each card in a wrapper of its own", (document: Document) => {
          const cards = tierCards(document);
          for (const card of cards) wrapCard(card);
          renameTierHooks(cards[1]);
          renameTierHooks(cards[2]);
        }, 8],
      ])("fails closed on %s, wherever the part card shows it", async (_shape, mutate, uncoveredPartCardLines) => {
        const fixture = await loadCurrentQuotePage(mutate);
        expect(fixture.document.querySelectorAll(`.part-card ${tierCardSelector}`).length).toBeLessThan(4);

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "wrapper_uncovered_content",
          uncoveredPartCardLines,
        });
      });

      it("never lets the adapter publish two of three tiers when the third card and label were renamed", async () => {
        for (const mutate of [renameThirdCardAndLabel, (document: Document) => addToPartCard(document, hooklessTier)]) {
          const failure = await quoteCurrentPage({ mutate }).catch((error: unknown) => error);

          expect(failure).toBeInstanceOf(VendorAutomationError);
          expect(failure).toMatchObject({
            code: "unexpected_ui_state",
            payload: expect.objectContaining({ ambiguity: "wrapper_uncovered_content" }),
          });
          expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
            ok: true,
            terminalState: "selector_drift",
            violations: [],
          });
        }
      });

      it.each([
        ["a part-level subtotal", "<div>Subtotal $324.75</div>"],
        ["a USD amount", "<div>USD 90.00</div>"],
        ["an arrival date", "<div>Arrives by Nov 9</div>"],
        ["a delivery date", "<div>Delivery on Nov 9</div>"],
        ["a lead time", "<div>Lead time: 12</div>"],
        ["business days", "<div>Ships in 7 business days</div>"],
        ["the heading with a timing after it", "<div>Price and Lead Time: 5 business days</div>"],
      ])("fails closed on %s outside every card, in the panel or elsewhere in the part card", async (_text, html) => {
        for (const [, add] of partCardPlacements) {
          for (const oneCard of [false, true]) {
            const fixture = await loadCurrentQuotePage((document) => {
              if (oneCard) keepFirstCardOnly(document);
              add(html)(document);
            });

            expect(await driftOf(fixture)).toMatchObject({
              ambiguity: "wrapper_uncovered_content",
              uncoveredPartCardLines: 1,
            });
          }
        }
      });

      it("fails closed on timing text sitting directly between two cards", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          nthCard(document, 1).before(document.createTextNode("Arrives by Nov 9"));
        });

        expect(await driftOf(fixture)).toMatchObject({ ambiguity: "wrapper_uncovered_content", uncoveredPartCardLines: 1 });
      });

      it("publishes beside other part-card text, hidden amounts or timing, and timing or amounts outside the part card", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          addToPanel('<div style="display: none;">Subtotal $324.75</div><div style="display: none;"></div>')(document);
          addToPartCard(document, '<div>Finish: Standard</div><div style="display: none;">Arrives by Nov 9</div>');
          addToOrderSummary(document, "<div>Arrives by Nov 9</div><div>Subtotal $324.75</div>");
        });

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it.each([
        ["the order summary", (document: Document) => document.querySelector(".order-summary")],
        ["the <body>", (document: Document) => document.body],
        ["a second part card", (document: Document) => {
          const parts = document.querySelector("#draggable-parts");
          if (!parts) throw new Error("fixture lost its parts list");
          parts.insertAdjacentHTML("beforeend", '<div role="button" tabindex="0"><div class="part-card"></div></div>');
          return parts.lastElementChild?.firstElementChild ?? null;
        }],
      ])("fails closed when a card sits in %s, so no one part card holds every card", async (_where, target) => {
        const fixture = await loadCurrentQuotePage((document) => {
          const container = target(document);
          if (!container) throw new Error("fixture lost a container");
          container.append(nthCard(document, 2));
        });
        expect(fixture.cards).toHaveLength(3);

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "part_card_unbounded",
          tierCards: 3,
        });
      });

      it("fails closed when the part card's text cannot be read", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          dragHandle(document).setAttribute("data-test-unreadable", "text");
        });

        expect(await driftOf(fixture)).toMatchObject({ ambiguity: "shape_unreadable", tierCards: 3, partCardLines: null });
      });

      it("fails closed when the part card's text does not hold a card's text", async () => {
        const cardText = "Standard\nArrives by Nov 6\n$50.00";
        // The part card shows a different arrival date than the card did.
        const partCard: LocatorBehavior = {
          count: 1,
          text: `Price and Lead Time\n${cardText.replace("Nov 6", "Nov 7")}`,
          children: (inner) => ({ count: inner === tierCardSelector ? 1 : 0 }),
        };
        const card: LocatorBehavior = {
          count: 1,
          text: cardText,
          children: (selector) => {
            if (selector === PART_CARD_ANCESTORS_XPATH || selector === PART_CARD_XPATH) return { items: [partCard] };
            return selector === '[data-testid="tierAndLeadTime"]:visible'
              ? { count: 1, text: "Arrives by Nov 6" }
              : { count: 0 };
          },
        };
        const page = {
          url: () => "https://www.xometry.com/quoting/quote/Q00-TEST-1052",
          locator: (selector: string) => makeLocator(selector === tierCardSelector
            ? { items: [card] }
            : { count: selector.endsWith('[data-testid="tierAndLeadTime"]:visible') ? 1 : 0 }),
        } as unknown as Parameters<typeof collectXometryOffers>[0];

        const failure = await collectXometryOffers(page, 1).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          payload: { reason: "xometry_offer_container_ambiguous", ambiguity: "shape_unreadable", partCardLines: null },
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      });

      it.each([
        ["Least Expensive", 0, [1, 2]],
        ["Standard", 1, [0, 2]],
        ["Fastest", 2, [0, 1]],
      ])("excludes the one unpriced tier a line in the price panel calls unavailable (%s)", async (tier, card, kept) => {
        for (const line of [`${tier} is not available for this part.`, `The ${tier.toLowerCase()} tier is unavailable.`]) {
          const fixture = await loadCurrentQuotePage((document) => {
            unpriceCard(card)(document);
            addToPanel(`<div>${line}</div>`)(document);
          });

          expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1)))
            .toEqual(kept.map((index) => expectedTierOffers[index]));
        }
      });

      it("ends the quote on the remaining tiers when a line in the price panel withdraws an unpriced one", async () => {
        const { result } = await quoteCurrentPage({
          mutate: (document) => {
            unpriceCard(2)(document);
            addToPanel("<div>The Fastest tier is not available for this part.</div>")(document);
          },
        });

        expect(result.status).toBe("instant_quote_received");
        expect(result.offers?.map((offer) => offer.providerOptionId)).toEqual(["least-expensive", "standard"]);
        expect(result.totalPriceUsd).toBe(101.25);
      });

      it.each(["Least Expensive", "Standard", "Fastest"])(
        "fails closed instead of excluding %s when the line sits in the part card outside the price panel",
        async (tier) => {
          for (const line of [`${tier} is not available for this part.`, `The ${tier.toLowerCase()} tier is unavailable.`]) {
            const fixture = await loadCurrentQuotePage((document) => addToPartCard(document, `<div>${line}</div>`));

            expect(await driftOf(fixture)).toMatchObject({
              reason: "xometry_offer_container_ambiguous",
              ambiguity: "availability_ambiguous",
              partCardUnavailableLines: 1,
              unavailableLinesOutsidePricePanel: 1,
              namedTierCards: 1,
            });
          }
        },
      );

      // The part card's Finish requirement reads "Finish: Standard", so a
      // finish notice beside it names the Standard tier without meaning it.
      it.each([
        "Standard is not available for this material.",
        "The Standard option is not available for this material.",
      ])("never drops the Standard tier on the finish notice %j beside the Finish requirement", async (line) => {
        const besideFinish = addBesideFinish(`<div>${line}</div>`);
        const fixture = await loadCurrentQuotePage(besideFinish);
        expect(fixture.bodyText.split("\n")).toEqual(expect.arrayContaining(["Finish: Standard", line]));

        expect(await driftOf(fixture)).toMatchObject({
          ambiguity: "availability_ambiguous",
          unavailableLinesOutsidePricePanel: 1,
          namedTierCards: 1,
        });
        const failure = await quoteCurrentPage({ mutate: besideFinish }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(VendorAutomationError);
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({ ambiguity: "availability_ambiguous" }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "selector_drift",
          violations: [],
        });
      });

      // A hidden copy is not on screen, so the price panel is still the
      // element around the cards the page shows, and the finish notice stays
      // outside it. Counting the copy widened the panel to the part card, and
      // the notice then withdrew the Standard tier.
      it.each(hiddenCopiesOutsidePanel)("never drops the Standard tier on the finish notice beside %s", async (_copy, addCopy) => {
        const mutate = (document: Document) => {
          addBesideFinish(finishNotice)(document);
          addCopy(document);
        };
        const fixture = await loadCurrentQuotePage(mutate);
        expect(fixture.document.querySelectorAll(tierCardSelector).length).toBeGreaterThan(3);

        expect(await driftOf(fixture)).toMatchObject({
          ambiguity: "availability_ambiguous",
          unavailableLinesOutsidePricePanel: 1,
          namedTierCards: 1,
        });
        const failure = await quoteCurrentPage({ mutate }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(VendorAutomationError);
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({ ambiguity: "availability_ambiguous" }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "selector_drift",
          violations: [],
        });
      });

      it.each(hiddenCopiesOutsidePanel)(
        "publishes the three tiers beside %s, and still withdraws a tier a price-panel line names",
        async (_copy, addCopy) => {
          expect(offerSummary(await collectXometryOffers(fixturePage(await loadCurrentQuotePage(addCopy)), 1)))
            .toEqual(expectedTierOffers);
          const withdrawn = await loadCurrentQuotePage((document) => {
            unpriceCard(2)(document);
            addToPanel("<div>Fastest is not available for this part.</div>")(document);
            addCopy(document);
          });
          expect(offerSummary(await collectXometryOffers(fixturePage(withdrawn), 1))).toEqual(expectedTierOffers.slice(0, 2));
        },
      );

      it.each([
        ["names no tier", "Some options are not available.", 0],
        ["names two tiers", "Standard and Fastest are not available.", 2],
        ["withdraws one tier and names another", "Fastest is not available and Standard is not offered.", 2],
        ["only mentions a tier's name", "Standard finish not available for this material.", 1],
        ["names a tier as part of a longer name", "Standard Inspection is not available.", 1],
        ["holds a tier's name inside a longer word", "Standardized finish is not available.", 0],
        ["holds a tier's name inside a longer word", "Fastestest is unavailable.", 0],
      ])("fails closed as availability_ambiguous when a part-card line %s: %s", async (_case, line, namedTierCards) => {
        for (const [, add] of partCardPlacements) {
          const fixture = await loadCurrentQuotePage(add(`<div>${line}</div>`));

          expect(await driftOf(fixture)).toMatchObject({
            reason: "xometry_offer_container_ambiguous",
            ambiguity: "availability_ambiguous",
            partCardUnavailableLines: 1,
            namedTierCards,
          });
        }
      });

      it("names a tier only as a whole word, so a longer word holding another tier's name names no second tier", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          unpriceCard(2)(document);
          addToPanel("<div>Fastest is not available for Standardized parts.</div>")(document);
        });

        // One tier named; the line's condition still keeps it from withdrawing the card.
        expect(await driftOf(fixture)).toMatchObject({
          ambiguity: "availability_ambiguous",
          namedTierCards: 1,
          namedPricedTierCards: 0,
        });
      });

      // A condition ("for quantities over 50") need not apply to the requested
      // quantity, so it never withdraws even an unpriced card: Fastest is then
      // a tier still being priced, never a tier the page withdrew.
      it.each([
        "Fastest is not available for quantities over 50.",
        "The Fastest tier is not available to ship internationally.",
      ])("never withdraws the unpriced Fastest card on %j at quantity 1, so two tiers are never published", async (line) => {
        const mutate = (document: Document) => {
          unpriceCard(2)(document);
          addToPanel(`<div>${line}</div>`)(document);
        };
        const fixture = await loadCurrentQuotePage(mutate);

        await expect(collectXometryOffers(fixturePage(fixture), 1)).rejects.toBeInstanceOf(VendorAutomationError);
        const failure = await quoteCurrentPage({ mutate }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(VendorAutomationError);
      });

      it("still withdraws the unpriced Fastest card on an unconditional panel line at quantity 1", async () => {
        for (const line of ["Fastest is not available.", "Fastest is unavailable at this time.", "The Fastest option is not offered for this quote."]) {
          const fixture = await loadCurrentQuotePage((document) => {
            unpriceCard(2)(document);
            addToPanel(`<div>${line}</div>`)(document);
          });

          expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers.slice(0, 2));
        }
      });

      it("fails an unavailability line that also shows timing as uncovered content", async () => {
        for (const [, add] of partCardPlacements) {
          const fixture = await loadCurrentQuotePage(add("<div>Fastest is not available: arrives by Nov 9</div>"));

          expect(await driftOf(fixture)).toMatchObject({ ambiguity: "wrapper_uncovered_content", uncoveredPartCardLines: 1 });
        }
      });

      it.each([
        ["Fastest is not available for quantities over 50.", 2],
        ["The Least Expensive option is not available to ship internationally.", 0],
      ])("refuses %j while that tier's card still shows its price and timing", async (line) => {
        const mutate = addToPanel(`<div>${line}</div>`);

        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "availability_ambiguous",
          unavailableLinesOutsidePricePanel: 0,
          namedTierCards: 1,
          namedPricedTierCards: 1,
        });
        // Never two tiers, and never the next tier's price as the headline price.
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "availability_ambiguous" });
      });

      it("refuses a priced card a panel line names and the page marks itself, while the other cards are published", async () => {
        const mutate = (document: Document) => {
          nthCard(document, 2).setAttribute("aria-disabled", "true");
          addToPanel("<div>Fastest is not available for this part.</div>")(document);
        };

        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "availability_ambiguous",
          containerIndex: 2,
          markedPricedTierCards: 1,
          availableTierCards: 2,
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "availability_ambiguous" });
      });

      it("never reads an unavailability line outside the part card", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          addToOrderSummary(document, "<div>Fastest is not available for this part.</div>");
        });

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });
    });

    describe("availability of each tier card", () => {
      const markers: Array<[string, (element: Element) => void]> = [
        ["aria-disabled", (element) => element.setAttribute("aria-disabled", "true")],
        ["a disabled attribute", (element) => element.setAttribute("disabled", "")],
        ["data-disabled", (element) => element.setAttribute("data-disabled", "true")],
        ["data-available=false", (element) => element.setAttribute("data-available", "false")],
        ["unavailable styling", (element) => element.classList.add("tier--unavailable")],
        ["disabled styling", (element) => element.classList.add("is-disabled")],
      ];

      /** The quote stops, finitely, as selector drift on an availability it cannot settle. */
      const expectAvailabilityRefused = async (mutate: (document: Document) => void, containerIndex: number) => {
        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "availability_ambiguous",
          containerIndex,
          markedPricedTierCards: 1,
          availableTierCards: 2,
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "availability_ambiguous" });
      };

      // A priced card that marks itself unavailable can be the selected tier
      // (a checked radio rendered aria-disabled), so the other two are not
      // published as the complete set.
      it.each(markers)("refuses, never withdraws, a priced card that carries %s itself", async (_marker, mark) => {
        for (const index of [0, 1]) await expectAvailabilityRefused((document) => mark(nthCard(document, index)), index);
      });

      it("refuses a priced Standard card marked as the selected, disabled radio", async () => {
        await expectAvailabilityRefused((document) => {
          const standard = nthCard(document, 1);
          standard.setAttribute("role", "radio");
          standard.setAttribute("aria-checked", "true");
          standard.setAttribute("aria-disabled", "true");
        }, 1);
      });

      it("never publishes a card without a price that says it is not available", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          unpriceCard(0)(document);
          addToFirstCard("<div>Not available</div>")(document);
        });

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers.slice(1));
      });

      // A tier still loading can render its static name and arrival date
      // before its price, on a design-system card disabled until it is priced.
      it.each([
        ["its price surface marked aria-disabled", (document: Document) => {
          nthCard(document, 2).querySelector('[kind="outlineWhite"]')?.setAttribute("aria-disabled", "true");
        }],
        ["a disabled Select button", addToCard(2, '<button type="button" disabled="">Select</button>')],
        ["a disabled radio", addToCard(2, '<input type="radio" disabled="">')],
        ["aria-disabled on the card itself", (document: Document) => nthCard(document, 2).setAttribute("aria-disabled", "true")],
        ["disabled styling on the card itself", (document: Document) => nthCard(document, 2).classList.add("price-tier--disabled")],
        ["a disabled wrapper of its own", (document: Document) => wrapCard(nthCard(document, 2)).setAttribute("aria-disabled", "true")],
      ])("keeps a tier without a price pending, never withdrawn, beside %s", async (_mark, mark) => {
        const mutate = (document: Document) => {
          unpriceCard(2)(document);
          mark(document);
        };
        const fixture = await loadCurrentQuotePage(mutate);
        // The card shows its name and arrival date, but no price yet.
        expect(fixture.cards[2]?.text.split("\n").map((line) => line.trim()).slice(0, 2)).toEqual(["Fastest", "Arrives by Oct 30"]);
        expect(fixture.cards[2]?.text).not.toContain("$");

        const failure = await collectXometryOffers(fixturePage(fixture), 1, undefined, {
          priceTiersSettled: false,
          pricingInProgress: false,
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({ payload: { reason: "xometry_price_pending", pendingCause: "price_tiers_unsettled" } });
        expect(await expectAdapterPending(mutate)).toMatchObject({
          reason: "xometry_price_pending",
          pendingCause: "price_tiers_unsettled",
        });
      });

      it.each([
        ["a note that some delivery is not available", addToCard(1, "<div>Weekend delivery not available.</div>")],
        ["a disabled button marking the selected tier", addToCard(1, '<button type="button" disabled="">Selected</button>')],
        ["a checked, disabled radio", addToCard(1, '<span role="radio" aria-checked="true" aria-disabled="true"></span>')],
      ])("refuses, never withdraws, a card that shows its price and timing beside %s", async (_what, mutate) => {
        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "availability_ambiguous",
          containerIndex: 1,
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "availability_ambiguous" });
      });

      it.each(markers)("refuses, never withdraws, a priced card when an element around it alone carries %s", async (_marker, mark) => {
        for (const keepHandle of [true, false]) {
          await expectAvailabilityRefused((document) => {
            mark(wrapCard(firstCard(document)));
            if (!keepHandle) dragHandle(document).removeAttribute("role");
          }, 0);
        }
      });

      it("refuses a priced Standard card wrapped in a disabled button", async () => {
        await expectAvailabilityRefused((document) => {
          const standard = nthCard(document, 1);
          const button = document.createElement("button");
          button.setAttribute("disabled", "");
          standard.before(button);
          button.append(standard);
        }, 1);
      });

      it.each(markers)("publishes nothing when an element around every card carries %s", async (_marker, mark) => {
        for (const enclosing of [
          (document: Document) => dragHandle(document),
          (document: Document) => document.querySelector(".part-card"),
          (document: Document) => firstCard(document).parentElement,
        ]) {
          for (const oneCard of [false, true]) {
            const fixture = await loadCurrentQuotePage((document) => {
              if (oneCard) keepFirstCardOnly(document);
              const element = enclosing(document);
              if (!element) throw new Error("fixture lost an enclosing element");
              mark(element);
            });
            // The part card's disabled quantity stepper is still beside the cards.
            expect(fixture.document.querySelectorAll("button[disabled]")).toHaveLength(1);

            expect(await collectXometryOffers(fixturePage(fixture), 1)).toEqual([]);
          }
        }
      });

      it.each([
        ["the parts list", (document: Document) => document.querySelector("#draggable-parts")],
        ["<body>", (document: Document) => document.body],
        ["<html>", (document: Document) => document.documentElement],
      ])("publishes every card when a mark sits above the part card, on %s", async (_where, target) => {
        const aboveMarks: Array<[string, (element: Element) => void]> = [
          ...markers,
          ["a scroll-disabled class", (element) => element.classList.add("scroll-disabled")],
        ];
        for (const [, mark] of aboveMarks) {
          const fixture = await loadCurrentQuotePage((document) => {
            const element = target(document);
            if (!element) throw new Error("fixture lost an element above the part card");
            mark(element);
          });

          expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
        }
      });

      it("ends the quote without a price when the page withdraws every card", async () => {
        const failure = await quoteCurrentPage({
          resolveFallbackSelectors: true,
          mutate: (document) => dragHandle(document).setAttribute("aria-disabled", "true"),
        }).catch((error: unknown) => error);

        // A fallback locator still reads a withdrawn card's amount, but no
        // option set exists, so the quote stops instead of publishing it.
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({ reason: "xometry_offer_containers_missing" }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "selector_drift",
          violations: [],
        });
      });

      it("ignores disabled controls and markers beside the cards", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          addToPartCard(
            document,
            '<div aria-disabled="true" class="stepper--disabled"><button type="button" disabled=""><i class="fal fa-minus"></i></button></div>',
          );
        });

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it.each([
        ["a card's own", (document: Document) => nthCard(document, 1).setAttribute("data-test-unreadable", "attributes"), 1],
        ["an enclosing element's", (document: Document) => {
          wrapCard(nthCard(document, 2)).setAttribute("data-test-unreadable", "nested-attributes");
        }, 2],
        ["the drag handle's", (document: Document) => {
          dragHandle(document).setAttribute("data-test-unreadable", "nested-attributes");
        }, 0],
      ])("fails closed when %s availability cannot be read", async (_element, mutate, containerIndex) => {
        const fixture = await loadCurrentQuotePage(mutate);

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "availability_ambiguous",
          containerSelector: tierCardSelector,
          containerIndex,
        });
      });

      it("fails closed when a card's enclosing elements cannot be listed", async () => {
        const page = {
          url: () => "https://www.xometry.com/quoting/quote/Q00-TEST-1052",
          locator: (selector: string) => makeLocator(selector === tierCardSelector
            ? {
              items: [{
                count: 1,
                text: "Standard\n$50.00 ea.\n$50.00\n5 business days",
                // The card's part card is found, but every other scoped read,
                // the enclosing elements up to it included, finds nothing,
                // although a card in a part card always has one.
                children: (selector) => selector === PART_CARD_XPATH ? undefined : { count: 0 },
              }],
            }
            : { count: 0 }),
        } as unknown as Parameters<typeof collectXometryOffers>[0];

        const failure = await collectXometryOffers(page, 1).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          payload: { reason: "xometry_offer_container_ambiguous", ambiguity: "availability_ambiguous", containerIndex: 0 },
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      });
    });

    describe("a tier card that has not rendered", () => {
      /** Empties the third tier card, as a skeleton still loading its price. */
      const blankThirdCard = (inner = '<div kind="outlineWhite"><div></div></div>') => (document: Document) => {
        nthCard(document, 2).innerHTML = inner;
      };

      it("fails closed as pending instead of publishing two of three tiers", async () => {
        for (const keepHandle of [true, false]) {
          const fixture = await loadCurrentQuotePage((document) => {
            blankThirdCard()(document);
            if (!keepHandle) dragHandle(document).removeAttribute("role");
          });
          expect(fixture.document.querySelectorAll(tierCardSelector)).toHaveLength(3);

          expect(await pendingOf(fixture)).toMatchObject({
            reason: "xometry_price_pending",
            pendingCause: "tier_card_blank",
            containerSelector: tierCardSelector,
            containerIndex: 2,
          });
        }
      });

      it("keeps an empty tier card the page does not hide pending, as a card whose content has not mounted", async () => {
        const fixture = await loadCurrentQuotePage(addToPanel('<div class="price-tier"></div>'));
        expect(fixture.document.querySelectorAll(tierCardSelector)).toHaveLength(4);

        expect(await pendingOf(fixture)).toMatchObject({ pendingCause: "tier_card_blank", containerIndex: 3 });
      });

      it.each(hiddenCopies)("skips a hidden copy of a tier card (%s) and publishes the three tiers", async (_how, hide) => {
        const fixture = await loadCurrentQuotePage(addHiddenCopy(hide));
        expect(fixture.document.querySelectorAll(tierCardSelector)).toHaveLength(4);

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it("is pending, not empty, when the page hides every tier card", async () => {
        const hidePanel = (document: Document) => pricePanel(document).setAttribute("style", "display: none;");
        const fixture = await loadCurrentQuotePage(hidePanel);

        expect(await pendingOf(fixture)).toMatchObject({
          reason: "xometry_price_pending",
          pendingCause: "price_tier_cards_absent",
        });
        const failure = await quoteCurrentPage({ mutate: hidePanel, priceTiersTimeOut: true })
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({
          payload: expect.objectContaining({ reason: "xometry_price_pending", terminalState: "unavailable" }),
        });
      });

      it("treats a blank card that shows only a disabled control as pending, not unavailable", async () => {
        const fixture = await loadCurrentQuotePage(
          blankThirdCard('<div kind="outlineWhite"><button type="button" disabled=""></button></div>'),
        );

        expect(await pendingOf(fixture)).toMatchObject({ reason: "xometry_price_pending", containerIndex: 2 });
      });

      // A design-system card can render disabled until it is priced, so a mark
      // never turns a blank card into a withdrawn tier.
      it.each([
        ["itself", (document: Document) => nthCard(document, 2)],
        ["through an enclosing element", (document: Document) => wrapCard(nthCard(document, 2))],
      ])("keeps a blank card pending, never withdrawn, when the page marks it unavailable %s", async (_where, target) => {
        for (const [, mark] of [
          ["aria-disabled", (element: Element) => element.setAttribute("aria-disabled", "true")],
          ["data-available=false", (element: Element) => element.setAttribute("data-available", "false")],
          ["unavailable styling", (element: Element) => element.classList.add("price-tier--unavailable")],
          ["disabled styling", (element: Element) => element.classList.add("price-tier--disabled")],
          ["attributes that cannot be read", (element: Element) => element.setAttribute("data-test-unreadable", "attributes")],
        ] as const) {
          const mutate = (document: Document) => {
            blankThirdCard()(document);
            mark(target(document));
          };

          expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({
            reason: "xometry_price_pending",
            pendingCause: "tier_card_blank",
            containerIndex: 2,
          });
          expect(await expectAdapterPending(mutate)).toMatchObject({ pendingCause: "tier_card_blank" });
        }
      });

      it("ends the quote unavailable with no price when a tier card is blank", async () => {
        const failure = await quoteCurrentPage({ mutate: blankThirdCard() }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(VendorAutomationError);
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({ reason: "xometry_price_pending", terminalState: "unavailable" }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "unavailable",
          violations: [],
        });
      });
    });

    /** The quote stops in a finite selector_drift state and publishes nothing. */
    async function expectAdapterDrift(mutate: (document: Document) => void) {
      const failure = await quoteCurrentPage({ mutate }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(VendorAutomationError);
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "selector_drift",
        violations: [],
      });
      return (failure as VendorAutomationError).payload;
    }

    /** The quote stops as retryable pending (unavailable) and publishes nothing. */
    async function expectAdapterPending(mutate: (document: Document) => void) {
      const failure = await quoteCurrentPage({ mutate }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(VendorAutomationError);
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "unavailable",
        violations: [],
      });
      return (failure as VendorAutomationError).payload;
    }

    /** Replaces the third tier card with markup that lacks the card's class, as a per-tier placeholder would render. */
    const replaceThirdCard = (html: string) => (document: Document) => {
      nthCard(document, 2).outerHTML = html;
    };
    /** An empty slot for a tier, with no class that says it is loading. */
    const emptyTierPlaceholder = '<div class="tier-slot"><div></div></div>';
    /** An empty placeholder whose class says it is a loading skeleton. */
    const tierSkeleton = '<div class="tier-skeleton"><div></div></div>';
    /** Wraps every tier card in a grid cell of its own, then replaces the Standard and Fastest cards with the given markup. */
    const onlyLeastExpensiveRendered = (html: string) => (document: Document) => {
      const cards = tierCards(document);
      for (const card of cards) wrapCard(card);
      for (const card of cards.slice(1)) card.outerHTML = html;
    };
    /** The price panel's "Price and Lead Time" heading. */
    const panelHeading = (document: Document) => {
      const heading = pricePanel(document).querySelector(":scope > label");
      if (!heading) throw new Error("fixture lost its price panel heading");
      return heading;
    };

    describe("a tier the price panel shows outside a .price-tier card", () => {
      it("refuses an empty placeholder in place of a card instead of publishing two of three tiers", async () => {
        const mutate = replaceThirdCard(emptyTierPlaceholder);
        const fixture = await loadCurrentQuotePage(mutate);
        expect(fixture.cards).toHaveLength(2);

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "price_panel_unrecognized",
          pricePanelPlaceholders: 1,
          unrecognizedPricePanelLines: 0,
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "price_panel_unrecognized" });
      });

      it.each([
        ["in a wrapper of its own, as every card is", (document: Document) => {
          for (const card of tierCards(document)) wrapCard(card);
          replaceThirdCard(emptyTierPlaceholder)(document);
        }],
        ["beside a card in that card's wrapper", (document: Document) => {
          wrapCard(firstCard(document)).insertAdjacentHTML("beforeend", emptyTierPlaceholder);
        }],
        ["after the cards", addToPanel(emptyTierPlaceholder)],
      ])("refuses an empty placeholder %s", async (_where, mutate) => {
        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          ambiguity: "price_panel_unrecognized",
          pricePanelPlaceholders: 1,
        });
      });

      // With one card rendered, the innermost element around the shown cards
      // is that card's own wrapper; the panel is the element that also shows
      // the "Price and Lead Time" heading, so the other tiers' slots are in it.
      it.each([
        ["each card in a grid cell of its own", onlyLeastExpensiveRendered(emptyTierPlaceholder), 2],
        ["the first card in a tooltip <span>", (document: Document) => {
          const first = firstCard(document);
          const tooltip = document.createElement("span");
          first.before(tooltip);
          tooltip.append(first);
          for (const card of tierCards(document).slice(1)) card.outerHTML = emptyTierPlaceholder;
        }, 2],
        ["two rows, the second holding only a placeholder", (document: Document) => {
          const [first, second, third] = tierCards(document);
          wrapCard(first).append(second);
          wrapCard(third);
          third.outerHTML = emptyTierPlaceholder;
        }, 1],
      ])("refuses placeholders for the tiers still loading beside %s, never publishing the rendered ones", async (_layout, mutate, placeholders) => {
        const fixture = await loadCurrentQuotePage(mutate);
        expect(fixture.cards.length).toBeLessThan(3);

        expect(await driftOf(fixture)).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "price_panel_unrecognized",
          pricePanelPlaceholders: placeholders,
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "price_panel_unrecognized" });
      });

      it.each([
        ["skeletons", tierSkeleton],
        ["Loading...", '<div class="tier-slot"><div>Loading...</div></div>'],
      ])("is pending, never one of three tiers, when %s stand in for the tiers beside one rendered card", async (_what, html) => {
        const mutate = onlyLeastExpensiveRendered(html);

        expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_price_pending",
          pendingCause: "pricing_in_progress",
        });
        expect(await expectAdapterPending(mutate)).toMatchObject({ reason: "xometry_price_pending" });
      });

      it.each([
        ["with the Fastest card removed", (document: Document) => {
          panelHeading(document).remove();
          nthCard(document, 2).remove();
        }],
        ["beside all three cards", (document: Document) => panelHeading(document).remove()],
        ["and the cards in grid cells, one rendered", (document: Document) => {
          panelHeading(document).remove();
          onlyLeastExpensiveRendered(emptyTierPlaceholder)(document);
        }],
      ])("refuses a price panel without its heading %s", async (_case, mutate) => {
        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "price_panel_unlocated",
          pricePanelHeadings: 0,
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "price_panel_unlocated" });
      });

      it.each(["Loading...", "Loading prices...", "Refreshing prices"])(
        "is pending, not two of three tiers, when a placeholder in place of a card shows %j",
        async (text) => {
          const mutate = replaceThirdCard(`<div class="tier-slot"><div></div><div>${text}</div></div>`);

          expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({
            reason: "xometry_price_pending",
            pendingCause: "pricing_in_progress",
          });
          expect(await expectAdapterPending(mutate)).toMatchObject({ reason: "xometry_price_pending" });
        },
      );

      it.each([
        ["a control that shows more tiers", '<button type="button">Show more options</button>'],
        ["an instruction", "<div>Choose a tier</div>"],
        ["a badge of its own", "<span>Popular</span>"],
      ])("refuses %s in the price panel beside the cards", async (_what, html) => {
        expect(await driftOf(await loadCurrentQuotePage(addToPanel(html)))).toMatchObject({
          ambiguity: "price_panel_unrecognized",
          unrecognizedPricePanelLines: 1,
          pricePanelPlaceholders: 0,
        });
      });

      it("publishes the three tiers beside an empty element the page hides in the panel", async () => {
        const fixture = await loadCurrentQuotePage(addToPanel('<div style="display: none;"><div class="tier-skeleton"></div></div>'));

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });
    });

    describe("a tier card the page hides", () => {
      const hideCards = (...indexes: number[]) => (document: Document) => {
        for (const index of indexes) nthCard(document, index).setAttribute("style", "display: none;");
      };

      it.each([
        ["the Fastest card", [2]],
        ["the Standard and Fastest cards, as a tabbed or carousel layout would", [1, 2]],
      ])("refuses %s, which no shown card copies, instead of publishing the rest", async (_cards, hidden) => {
        const mutate = hideCards(...hidden);

        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_offer_container_ambiguous",
          ambiguity: "availability_ambiguous",
          hiddenTierCards: hidden.length,
          unmatchedHiddenTierCards: hidden.length,
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ ambiguity: "availability_ambiguous" });
      });

      it.each(hiddenCopies)("refuses a fourth priced tier the page keeps off screen (%s)", async (_how, hide) => {
        for (const showMore of [false, true]) {
          const mutate = (document: Document) => {
            const economy = nthCard(document, 2).cloneNode(true) as Element;
            economy.innerHTML = economy.innerHTML.replace("Fastest", "Economy").replace("Arrives by Oct 30", "Arrives by Nov 12");
            nthCard(document, 2).after(economy);
            hide(economy);
            if (showMore) addToPanel('<button type="button">Show more options</button>')(document);
          };

          expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
            ambiguity: "availability_ambiguous",
            hiddenTierCards: 1,
            unmatchedHiddenTierCards: 1,
          });
        }
      });

      it("refuses a hidden card whose price differs from the shown card it otherwise copies", async () => {
        const mutate = addHiddenCopy((copy) => {
          copy.setAttribute("style", "display: none;");
          copy.innerHTML = copy.innerHTML.replaceAll("101.25", "99.00");
        });

        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          ambiguity: "availability_ambiguous",
          unmatchedHiddenTierCards: 1,
        });
      });
    });

    describe("a tier name with an inline badge beside it", () => {
      /** Places a badge in a card's header slot, beside the tier name. */
      const badge = (index: number, position: InsertPosition, html: string) => (document: Document) => {
        const name = nthCard(document, index).querySelector('[scale="small"] > span');
        if (!name) throw new Error("fixture tier card lost its header slot");
        name.insertAdjacentHTML(position, html);
      };

      it.each([
        ["right after Standard, with no space", 1, badge(1, "beforeend", "<span>Popular</span>"), "StandardPopular"],
        ["after Fastest", 2, badge(2, "beforeend", " <span>Recommended</span>"), "Fastest Recommended"],
        ["before Least Expensive", 0, badge(0, "afterbegin", "<span>Best Value</span> "), "Best Value Least Expensive"],
      ])("refuses a badge %s instead of publishing it as the tier's label and id", async (_where, index, mutate, line) => {
        const fixture = await loadCurrentQuotePage(mutate);
        // The badge renders on the tier name's line.
        expect(fixture.cards[index]?.text.split("\n")[0]?.replaceAll(/\s+/g, " ").trim()).toBe(line);

        const failure = await failureOf(fixture);
        expect(failure).toMatchObject({
          code: "selector_failure",
          payload: { reason: "xometry_offer_tier_missing", terminalState: "selector_drift", optionIndex: index },
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ reason: "xometry_offer_tier_missing" });
      });
    });

    describe("a tier card with a line beside its tier name, timing and prices", () => {
      /** Places block markup in a card's header slot, before or after the tier name. */
      const headerBlock = (index: number, position: InsertPosition, html: string) => (document: Document) => {
        const slot = nthCard(document, index).querySelector('[scale="small"]');
        if (!slot) throw new Error("fixture tier card lost its header slot");
        slot.insertAdjacentHTML(position, html);
      };
      /** Places markup in a card's price block, after its amounts. */
      const priceBlockLine = (index: number, html: string) => (document: Document) => {
        const block = nthCard(document, index).querySelector('[kind="discount"]');
        if (!block) throw new Error("fixture tier card lost its price block");
        block.insertAdjacentHTML("beforeend", html);
      };

      it.each([
        ["a Rush block badge above the Fastest name", 2, headerBlock(2, "afterbegin", "<div>Rush</div>")],
        ["a Priority line under the Fastest name", 2, headerBlock(2, "beforeend", "<div>Priority</div>")],
        ["a Recommended badge and an Expedited shipping line on Standard", 1, (document: Document) => {
          headerBlock(1, "afterbegin", "<div>Recommended</div>")(document);
          priceBlockLine(1, "<div>Expedited shipping included</div>")(document);
        }],
        ["a Best Value badge and an Economy production subtitle on Least Expensive", 0, (document: Document) => {
          headerBlock(0, "afterbegin", "<div>Best Value</div>")(document);
          headerBlock(0, "beforeend", "<div>Economy production</div>")(document);
        }],
      ])("refuses %s instead of taking another word as the tier", async (_case, index, mutate) => {
        const failure = await failureOf(await loadCurrentQuotePage(mutate));
        expect(failure).toMatchObject({
          code: "selector_failure",
          payload: { reason: "xometry_offer_tier_missing", terminalState: "selector_drift", optionIndex: index },
        });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ reason: "xometry_offer_tier_missing" });
      });

      it.each([
        ["a Ground shipping - Arrives by line", priceBlockLine(0, "<div>Ground shipping - Arrives by Nov 3</div>")],
        ["an Expedited shipping line", priceBlockLine(1, "<div>Expedited shipping included</div>")],
        ["a note the parser does not read", priceBlockLine(2, "<div>Ships from a partner facility</div>")],
      ])("refuses a card whose price block shows %s", async (_case, mutate) => {
        const failure = await failureOf(await loadCurrentQuotePage(mutate));
        expect(failure).toMatchObject({
          code: "selector_failure",
          payload: { reason: "xometry_offer_line_unrecognized", terminalState: "selector_drift", unrecognizedCardLines: 1 },
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
        expect(await expectAdapterDrift(mutate)).toMatchObject({ reason: "xometry_offer_line_unrecognized" });
      });
    });

    describe("a part card the page marks busy or loading", () => {
      it.each([
        ["aria-busy on the price panel", (document: Document) => pricePanel(document).setAttribute("aria-busy", "true")],
        ["aria-busy on the drag handle", (document: Document) => dragHandle(document).setAttribute("aria-busy", "TRUE")],
        ["aria-busy on the parts list", (document: Document) => {
          document.querySelector("#draggable-parts")?.setAttribute("aria-busy", "true");
        }],
        ["a busy region in a tier card", addToCard(1, '<div aria-busy="true"></div>')],
        ["a progress bar in the price panel", addToPanel('<div role="progressbar" aria-label="Loading"></div>')],
        ["a <progress> element in the part card", (document: Document) => addToPartCard(document, "<progress></progress>")],
      ])("is pending, never a publish of possibly stale cards, with %s", async (_signal, mutate) => {
        expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_price_pending",
          pendingCause: "pricing_in_progress",
        });
        expect(await expectAdapterPending(mutate)).toMatchObject({ reason: "xometry_price_pending" });
      });

      it.each(["Loading prices...", "Refreshing prices", "Updating", "Recalculating"])(
        "is pending with %j in the price panel",
        async (text) => {
          const mutate = addToPanel(`<div>${text}</div>`);

          expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({ pendingCause: "pricing_in_progress" });
          expect(await expectAdapterPending(mutate)).toMatchObject({ reason: "xometry_price_pending" });
        },
      );

      /** Adds markup right after the price panel, inside the part card. */
      const addAfterPanel = (html: string) => (document: Document) => {
        pricePanel(document).insertAdjacentHTML("afterend", html);
      };
      /** Adds markup right after the quantity stepper. */
      const addBesideQuantity = (html: string) => (document: Document) => {
        const input = document.querySelector("#synthetic-quantity-input");
        if (!input?.parentElement) throw new Error("fixture lost its quantity input");
        input.parentElement.insertAdjacentHTML("afterend", html);
      };
      const removeFastest = (document: Document) => nthCard(document, 2).remove();

      it.each([
        ["Loading... elsewhere in the part card", (document: Document) => addToPartCard(document, "<div>Loading...</div>")],
        ["Loading more options... right after the price panel", addAfterPanel("<div>Loading more options...</div>")],
        ["an empty skeleton right after the price panel", addAfterPanel(tierSkeleton)],
      ])("is pending, never two of three tiers, with the Fastest card missing and %s", async (_signal, add) => {
        const mutate = (document: Document) => {
          removeFastest(document);
          add(document);
        };

        expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_price_pending",
          pendingCause: "pricing_in_progress",
        });
        expect(await expectAdapterPending(mutate)).toMatchObject({ reason: "xometry_price_pending" });
      });

      it.each([
        ["Updating... beside the quantity input", addBesideQuantity("<span>Updating...</span>")],
        ["Saving... beside the configuration", addBesideFinish("<div>Saving...</div>")],
        ["Fetching new price... in a card", addToCard(1, "<div>Fetching new price...</div>")],
        ["Please wait in a card", addToCard(0, "<div>Please wait</div>")],
        ["a spinning Font Awesome icon in every card", (document: Document) => {
          for (const index of [0, 1, 2]) addToCard(index, '<i class="fas fa-spinner fa-spin"></i>')(document);
        }],
        ["an empty skeleton-shimmer overlay in every card", (document: Document) => {
          for (const index of [0, 1, 2]) addToCard(index, '<div class="skeleton-shimmer"></div>')(document);
        }],
        ["Ant Design's active spinner in the price panel", addToPanel('<div class="ant-spin ant-spin-spinning"></div>')],
      ])("is pending, never a publish of possibly stale cards, with %s", async (_signal, mutate) => {
        expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          reason: "xometry_price_pending",
          pendingCause: "pricing_in_progress",
        });
        expect(await expectAdapterPending(mutate)).toMatchObject({ reason: "xometry_price_pending" });
      });

      // A file name is cut out of its line, not taken as the whole line's
      // exemption: the status beside it still says the price is changing.
      it.each([
        "Fetching new price for bracket.step...",
        "Loading loading-dock-bracket.step",
        "Recalculating part.v2.STEP",
      ])("is pending, never a publish of possibly stale cards, when the loading line %j also names a file", async (line) => {
        for (const mutate of [
          (document: Document) => addToPartCard(document, `<div>${line}</div>`),
          addToCard(1, `<div>${line}</div>`),
        ]) {
          expect(await pendingOf(await loadCurrentQuotePage(mutate))).toMatchObject({
            reason: "xometry_price_pending",
            pendingCause: "pricing_in_progress",
          });
          expect(await expectAdapterPending(mutate)).toMatchObject({ reason: "xometry_price_pending" });
        }
      });

      it("is pending while the order summary says it is updating the quote", async () => {
        const mutate = (document: Document) => addToOrderSummary(document, "<div>Updating your quote...</div>");

        expect(await expectAdapterPending(mutate)).toMatchObject({
          reason: "xometry_price_pending",
          pendingCause: "pricing_in_progress",
        });
      });

      it.each(["loading-dock-bracket.step", "loading dock bracket.step", "loading dock bracket.v2.STEP"])("publishes the three tiers when only the known file name %j holds a loading word", async (fileName) => {
        const mutate = (document: Document) => {
          const title = document.querySelector('[data-testid="part-card-title"] > span');
          if (!title) throw new Error("fixture lost its part title");
          title.textContent = fileName;
        };
        const fixture = await loadCurrentQuotePage(mutate);
        expect(fixture.bodyText).toContain(fileName);

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1, undefined, {
          priceTiersSettled: true, pricingInProgress: false, fileNames: [fileName],
        }))).toEqual(expectedTierOffers);
        const { result } = await quoteCurrentPage({ mutate, cadFileName: fileName });
        expect(result.offers?.map((offer) => offer.providerOptionId)).toEqual(expectedTierOffers.map(({ id }) => id));
      });

      it("publishes the three tiers when the staged originalName, unlike the sanitized local basename, holds a calculating word", async () => {
        const originalName = "Calculating Fixture Plate (rev B).step";
        const localFileName = "calculating-fixture-plate-rev-b.step";
        const mutate = (document: Document) => {
          const title = document.querySelector('[data-testid="part-card-title"] > span');
          if (!title) throw new Error("fixture lost its part title");
          title.textContent = originalName;
        };
        const fixture = await loadCurrentQuotePage(mutate);
        // Cutting out only the local basename leaves "Calculating" behind: the wait would stay pending.
        expect(settledOnDocument(fixture.document, [localFileName])).toBe(false);
        expect(settledOnDocument(fixture.document, [localFileName, originalName])).toBe(true);
        // The original name is cut out exactly, so status text around it still holds the wait.
        const busy = await loadCurrentQuotePage((document) => {
          mutate(document);
          addToPartCard(document, "<div>Calculating price...</div>");
        });
        expect(settledOnDocument(busy.document, [localFileName, originalName])).toBe(false);

        const { result } = await quoteCurrentPage({ mutate, cadFileName: originalName, cadLocalFileName: localFileName });
        expect(result.offers?.map((offer) => offer.providerOptionId)).toEqual(expectedTierOffers.map(({ id }) => id));
      });

      it.each([
        "Loading loading dock bracket.step",
        "Fetching new price for loading dock bracket.step...",
        "loading dock bracket.step — Saving...",
      ])("preserves surrounding status in %j after removing the known spaced filename", async (line) => {
        const fileName = "loading dock bracket.step";
        const mutate = (document: Document) => {
          const title = document.querySelector('[data-testid="part-card-title"] > span');
          if (!title) throw new Error("fixture lost its part title");
          title.textContent = line;
        };
        const fixture = await loadCurrentQuotePage(mutate);
        expect(settledOnDocument(fixture.document, [fileName])).toBe(false);
        const failure = await collectXometryOffers(fixturePage(fixture), 1, undefined, {
          priceTiersSettled: true, pricingInProgress: false, fileNames: [fileName],
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({ payload: { pendingCause: "pricing_in_progress" } });
      });

      it("publishes the three tiers beside a progress bar the page hides, aria-busy=false, or a progress bar outside the part card", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          addToPartCard(document, '<div style="display: none;"><div role="progressbar"></div></div>');
          pricePanel(document).setAttribute("aria-busy", "false");
          addToOrderSummary(document, '<div role="progressbar" aria-busy="true"></div>');
        });

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it.each(["Loading prices...", "Refreshing prices"])("counts %j anywhere on the quote page as pricing in progress", (text) => {
        expect(isXometryPricingInProgress({
          url: "https://www.xometry.com/quoting/quote/Q00-TEST-1052",
          bodyText: `Price and Lead Time\n${text}`,
        })).toBe(true);
      });
    });

    describe("a price-tier settle wait that timed out", () => {
      it("is pending whenever any card is available", async () => {
        const fixture = await loadCurrentQuotePage();
        const failure = await collectXometryOffers(fixturePage(fixture), 1, undefined, {
          priceTiersSettled: false,
          pricingInProgress: false,
        }).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          payload: { reason: "xometry_price_pending", terminalState: "unavailable", pendingCause: "price_tiers_unsettled" },
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "unavailable" });
      });

      it("publishes nothing when every card is unavailable, as the wait can never settle then", async () => {
        const fixture = await loadCurrentQuotePage((document) => dragHandle(document).setAttribute("aria-disabled", "true"));

        expect(await collectXometryOffers(fixturePage(fixture), 1, undefined, {
          priceTiersSettled: false,
          pricingInProgress: false,
        })).toEqual([]);
      });

      it("ends the quote unavailable, whatever the cards show", async () => {
        for (const mutate of [undefined, (document: Document) => { nthCard(document, 2).innerHTML = ""; }]) {
          const failure = await quoteCurrentPage({ mutate, priceTiersTimeOut: true }).catch((error: unknown) => error);

          expect(failure).toBeInstanceOf(VendorAutomationError);
          expect(failure).toMatchObject({
            code: "unexpected_ui_state",
            payload: expect.objectContaining({ reason: "xometry_price_pending", terminalState: "unavailable" }),
          });
          expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
            ok: true,
            terminalState: "unavailable",
            violations: [],
          });
        }
      });

      it("stays selector drift when no tier card is on screen", async () => {
        const failure = await quoteCurrentPage({
          resolveFallbackSelectors: true,
          priceTiersTimeOut: true,
          mutate: (document) => {
            for (const card of tierCards(document)) card.remove();
          },
        }).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          payload: expect.objectContaining({ reason: "xometry_price_tier_cards_missing", terminalState: "selector_drift" }),
        });
      });
    });

    describe("each card's stated quantity", () => {
      it.each(["synthetic-bracket-2pcs.step", "synthetic bracket 2 pcs.step", "Qty: 2 bracket.step"])(
        "never reads the part's file name %s as a tier quantity",
        async (fileName) => {
          const fixture = await loadCurrentQuotePage((document) => {
            const title = document.querySelector('[data-testid="part-card-title"] > span');
            if (!title) throw new Error("fixture lost its part title");
            title.textContent = fileName;
          });
          expect(fixture.bodyText).toContain(fileName);

          expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
        },
      );

      it.each(["Qty: 2", "2 pcs", "Quantity 2"])("never reads '%s' in the part card as a tier quantity", async (statement) => {
        const fixture = await loadCurrentQuotePage((document) => addToPartCard(document, `<div>${statement}</div>`));

        expect(offerSummary(await collectXometryOffers(fixturePage(fixture), 1))).toEqual(expectedTierOffers);
      });

      it("never takes a quantity outside a lone card as proof that its lone amount covers it", async () => {
        const fixture = await loadCurrentQuotePage((document) => {
          keepFirstCardOnly(document);
          const amounts = firstCard(document).querySelector('[kind="discount"]');
          if (!amounts) throw new Error("fixture tier card lost its price block");
          // A lone amount: no per-piece price and no list slot.
          amounts.innerHTML = "<div>$300.00</div>";
          addToPartCard(document, "<div>Qty: 3</div>");
        });
        expect(fixture.bodyText).toContain("Qty: 3");

        expect(await driftOf(fixture, 3)).toMatchObject({
          reason: "quantity_unverified",
          requestedQuantity: 3,
          observedQuantity: null,
          observedTotalPriceUsd: 300,
        });
      });

      it("fails closed on a quantity a card states itself", async () => {
        const fixture = await loadCurrentQuotePage(addToFirstCard("<div>2 pcs</div>"));
        const failure = await failureOf(fixture);

        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "configuration_required",
          violations: [],
        });
        expect(failure.payload).toMatchObject({ reason: "quantity_mismatch", requestedQuantity: 1, observedQuantity: 2 });
      });
    });

    describe("a quote page without tier cards", () => {
      const removeTierCards = (document: Document) => {
        for (const card of tierCards(document)) card.remove();
      };

      it("fails closed as selector drift, never falling back to another container", async () => {
        for (const mutate of [
          removeTierCards,
          // Renamed cards inside the role=button drag handle and a <label>
          // around each timing label: neither is ever read as an option.
          (document: Document) => {
            for (const card of tierCards(document)) card.className = "price-tier-card";
          },
        ]) {
          const fixture = await loadCurrentQuotePage(mutate);

          expect(await driftOf(fixture)).toMatchObject({
            reason: "xometry_price_tier_cards_missing",
            containerSelector: tierCardSelector,
          });
        }
      });

      it("is pending while the page still shows in-progress pricing text", async () => {
        const fixture = await loadCurrentQuotePage(removeTierCards);
        const failure = await collectXometryOffers(fixturePage(fixture), 1, undefined, {
          priceTiersSettled: true,
          pricingInProgress: true,
        }).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          payload: { reason: "xometry_price_pending", terminalState: "unavailable", pendingCause: "price_tier_cards_absent" },
        });
      });
    });

    describe("in-progress pricing text beside rendered tier cards", () => {
      it("is pending whatever the cards show", async () => {
        for (const mutate of [undefined, (document: Document) => dragHandle(document).setAttribute("aria-disabled", "true")]) {
          const fixture = await loadCurrentQuotePage(mutate);
          const failure = await collectXometryOffers(fixturePage(fixture), 1, undefined, {
            priceTiersSettled: true,
            pricingInProgress: true,
          }).catch((error: unknown) => error);

          expect(failure).toMatchObject({
            payload: { reason: "xometry_price_pending", terminalState: "unavailable", pendingCause: "pricing_in_progress" },
          });
          expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "unavailable" });
        }
      });

      it.each(["Updating prices", "Calculating your price"])(
        "ends the quote unavailable with no price while the page shows '%s'",
        async (signal) => {
          const failure = await quoteCurrentPage({
            pricingBodyText: (bodyText) => `${bodyText}\n${signal}`,
          }).catch((error: unknown) => error);

          expect(failure).toBeInstanceOf(VendorAutomationError);
          expect(failure).toMatchObject({
            code: "unexpected_ui_state",
            payload: expect.objectContaining({
              reason: "xometry_price_pending",
              terminalState: "unavailable",
              pendingCause: "pricing_in_progress",
            }),
          });
          expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
            ok: true,
            terminalState: "unavailable",
            violations: [],
          });
        },
      );
    });

    it("never anchors a fallback price on the struck-through list total", async () => {
      const fixture = await loadCurrentQuotePage();
      const listTotals = [...fixture.document.querySelectorAll('[data-testid="part-discount"] > span')]
        .map((span) => parseFirstCurrency(span.textContent ?? ""));
      expect(listTotals).toEqual([146.8, 139.95, 171.85]);

      let resolvedSelectors = 0;
      for (const selector of XOMETRY_LOCATORS.priceText) {
        let first: Element | null;
        try {
          first = fixture.document.querySelector(selector);
        } catch {
          continue; // Playwright-only syntax such as :has-text.
        }
        resolvedSelectors += 1;
        if (!first) continue;
        // Booleans only: a failing expect on a jsdom Element makes the
        // reporter walk the jsdom window and throw a SecurityError instead.
        expect(first.closest('[data-testid="part-discount"]') !== null, `${selector} anchors inside part-discount`)
          .toBe(false);
        expect(listTotals.includes(parseFirstCurrency(renderedText(first))), `${selector} reads a list total`)
          .toBe(false);
      }
      expect(resolvedSelectors).toBeGreaterThan(0);
    });

    it("publishes no price, and never the list total, when the quote page asks for review", async () => {
      const { input, result } = await quoteCurrentPage({
        resolveFallbackSelectors: true,
        mutate: (document) => {
          const notice = document.createElement("div");
          notice.textContent = "This part requires review before ordering.";
          document.querySelector(".part-card")?.prepend(notice);
        },
      });

      expect(result.status).toBe("manual_review_pending");
      expect(result.offers).toEqual([]);
      expect(result.totalPriceUsd).toBeNull();
      expect(result.unitPriceUsd).toBeNull();
      // The fallback did anchor an amount on the review page; it is withheld.
      expect(result.rawPayload).toMatchObject({ detectedFlow: "manual_review", priceSource: "selector" });
      expect(evaluateProviderAdapterContract({
        definition: {
          provider: "xometry",
          allowedHosts: ["www.xometry.com"],
          selectors: { cadUpload: "input[type='file']" },
          requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
        },
        adapterInput: input,
        output: result,
      })).toMatchObject({ ok: true, terminalState: "manual_review", violations: [] });
    });

    it("withholds the fallback lead time with the price when the quote page asks for review", async () => {
      const { result } = await quoteCurrentPage({
        resolveFallbackSelectors: true,
        mutate: (document) => {
          const notice = document.createElement("div");
          notice.textContent = "This part requires review before ordering.";
          document.querySelector(".part-card")?.prepend(notice);
          const label = document.querySelector('[data-testid="tierAndLeadTime"]');
          if (!label) throw new Error("fixture lost its tierAndLeadTime hook");
          label.textContent = "Lead time: 9 business days";
        },
      });

      expect(result.status).toBe("manual_review_pending");
      expect(result.totalPriceUsd).toBeNull();
      // The fallback anchored a lead time on the review page; it is withheld
      // with the price rather than published on its own.
      expect(result.rawPayload).toMatchObject({ detectedFlow: "manual_review", leadTimeSource: "selector" });
      expect(result.leadTimeBusinessDays).toBeNull();
    });

    describe("a configured quote page without a recognizable price", () => {
      const removeTierCards = (document: Document) => {
        for (const card of document.querySelectorAll(".price-tier")) card.remove();
      };

      it("stops as selector_drift when the page shows no tier card and no loading signal", async () => {
        const failure = await quoteCurrentPage({ resolveFallbackSelectors: true, mutate: removeTierCards })
          .catch((error: unknown) => error);

        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({ reason: "xometry_price_tier_cards_missing", terminalState: "selector_drift" }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "selector_drift",
          violations: [],
        });
      });

      it("stays selector_drift when the page shows only the uploader's loading text", async () => {
        const uploaderText = "Analyzing geometry\nLoading supported file extensions";
        // Still the uploader's reviewed loading signals, but not pricing text.
        expect(XOMETRY_LOCATORS.quoteLoadingSignals.filter((pattern) => pattern.test(uploaderText))).toHaveLength(2);
        const failure = await quoteCurrentPage({
          resolveFallbackSelectors: true,
          mutate: removeTierCards,
          pricingBodyText: (bodyText) => `${bodyText}\n${uploaderText}`,
        }).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({ reason: "xometry_price_tier_cards_missing", terminalState: "selector_drift" }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "selector_drift",
          violations: [],
        });
      });

      it("stops as unavailable while the quote page shows in-progress pricing text", async () => {
        const failure = await quoteCurrentPage({
          resolveFallbackSelectors: true,
          mutate: removeTierCards,
          pricingBodyText: (bodyText) => `${bodyText}\nCalculating your price`,
        }).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: expect.objectContaining({
            reason: "xometry_price_pending",
            terminalState: "unavailable",
            pendingCause: "price_tier_cards_absent",
          }),
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
          ok: true,
          terminalState: "unavailable",
          violations: [],
        });
      });

      it("counts only in-progress pricing text on the quote page as pricing in progress", () => {
        const quotePage = "https://www.xometry.com/quoting/quote/Q00-TEST-1052";
        expect(isXometryPricingInProgress({ url: quotePage, bodyText: "Calculating your price" })).toBe(true);
        expect(isXometryPricingInProgress({ url: quotePage, bodyText: "Updating prices" })).toBe(true);
        // Uploader and geometry-analysis text says nothing about pricing.
        expect(isXometryPricingInProgress({ url: quotePage, bodyText: "Analyzing geometry" })).toBe(false);
        expect(isXometryPricingInProgress({
          url: quotePage,
          bodyText: "Loading supported file extensions",
        })).toBe(false);
        // Pricing text off the quote page (the uploader's home, say) does not count.
        expect(isXometryPricingInProgress({ url: XOMETRY_URLS.quoteHome, bodyText: "Calculating your price" })).toBe(false);
      });
    });

    describe("a renamed .price-tier card", () => {
      const renameTierCards = (document: Document) => {
        for (const card of document.querySelectorAll(".price-tier")) card.className = "price-tier-card";
      };

      it("ends in selector_drift and never reads the drag handle or another element as an option", async () => {
        for (const keepHandle of [true, false]) {
          const failure = await quoteCurrentPage({
            resolveFallbackSelectors: true,
            mutate: (document) => {
              renameTierCards(document);
              if (!keepHandle) document.querySelector('#draggable-parts > [role="button"]')?.removeAttribute("role");
            },
          }).catch((error: unknown) => error);

          expect(failure).toMatchObject({
            code: "unexpected_ui_state",
            payload: expect.objectContaining({
              reason: "xometry_price_tier_cards_missing",
              containerSelector: XOMETRY_LOCATORS.priceTierCard,
            }),
          });
          expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
            ok: true,
            terminalState: "selector_drift",
            violations: [],
          });
        }
      });
    });

    describe("price-tier readiness predicate", () => {
      function settledOn(html: string) {
        return settledOnDocument(new JSDOM(html).window.document);
      }

      const stripWhitespace = (html: string) => html.replaceAll(/>\s+</g, "><");

      it("settles on tier cards whose markup has no whitespace between elements", async () => {
        const html = await fs.readFile(fixturePath, "utf8");
        const stripped = stripWhitespace(html);
        // The drift: textContent runs the tier header into the timing label.
        const strippedCard = new JSDOM(stripped).window.document.querySelector(".price-tier");
        expect(strippedCard?.textContent?.replaceAll(/\s+/g, " ").toLowerCase())
          .toContain("least expensivearrives by nov 3");

        expect(settledOn(html)).toBe(true);
        expect(settledOn(stripped)).toBe(true);
      });

      it("keeps waiting while a whitespace-free card lacks its timing or its price", async () => {
        const stripped = stripWhitespace(await fs.readFile(fixturePath, "utf8"));
        const dom = new JSDOM(stripped);
        dom.window.document.querySelectorAll('[kind="discount"]')[1]?.replaceChildren();

        expect(settledOn(stripped.replace("Arrives by Nov 6", ""))).toBe(false);
        expect(settledOn(dom.serialize())).toBe(false);
      });

      /** The fixture page after a mutation, as HTML the predicate can run against. */
      async function mutatedFixture(mutate: (document: Document) => void) {
        const dom = new JSDOM(await fs.readFile(fixturePath, "utf8"));
        mutate(dom.window.document);
        return dom.serialize();
      }
      /**
       * The fixture document after a mutation, unserialized, so adjacent text
       * nodes stay separate (serializing would merge them).
       */
      async function mutatedDocument(mutate: (document: Document) => void) {
        const { document } = new JSDOM(await fs.readFile(fixturePath, "utf8")).window;
        mutate(document);
        return document;
      }
      /** What the collector publishes once the settle wait has passed. */
      const settledOffers = async (mutate: (document: Document) => void) => offerSummary(
        await collectXometryOffers(fixturePage(await loadCurrentQuotePage(mutate)), 1, undefined, {
          priceTiersSettled: true,
          pricingInProgress: false,
        }),
      );
      /** Removes the third card's price block, as a tier the page has not priced. */
      const unpriceThirdCard = (document: Document) => {
        const amounts = nthCard(document, 2).querySelector('[kind="discount"]');
        if (!amounts) throw new Error("fixture tier card lost its price block");
        amounts.replaceChildren();
      };
      const withdrawalMarks: Array<[string, (element: Element) => void]> = [
        ["aria-disabled=TRUE", (element) => element.setAttribute("aria-disabled", "TRUE")],
        ["a disabled attribute", (element) => element.setAttribute("disabled", "")],
        ["data-disabled", (element) => element.setAttribute("data-disabled", "true")],
        ["data-available=False", (element) => element.setAttribute("data-available", "False")],
        ["unavailable styling", (element) => element.classList.add("tier--unavailable")],
        ["disabled styling", (element) => element.classList.add("is-disabled")],
      ];

      // A tier still loading can render its name and date on a card disabled
      // until it is priced, so a mark never withdraws an unpriced card.
      it.each(withdrawalMarks)(
        "keeps waiting, as the collector never withdraws it, on an unpriced card that carries %s itself, around it or in it",
        async (_mark, mark) => {
          for (const target of [
            (card: Element) => card,
            wrapCard,
            (card: Element) => card.querySelector('[kind="outlineWhite"]') ?? card,
          ]) {
            const mutate = (document: Document) => {
              unpriceThirdCard(document);
              mark(target(nthCard(document, 2)));
            };

            expect(settledOn(await mutatedFixture(mutate))).toBe(false);
            expect(await expectAdapterPending(mutate)).toMatchObject({ pendingCause: "price_tiers_unsettled" });
          }
        },
      );

      it.each(withdrawalMarks)(
        "keeps waiting on a blank card that carries %s itself or through an enclosing element",
        async (_mark, mark) => {
          for (const target of [(card: Element) => card, wrapCard]) {
            const mutate = (document: Document) => {
              nthCard(document, 2).innerHTML = '<div kind="outlineWhite"><div></div></div>';
              mark(target(nthCard(document, 2)));
            };

            expect(settledOn(await mutatedFixture(mutate))).toBe(false);
            expect(await expectAdapterPending(mutate)).toMatchObject({ pendingCause: "tier_card_blank" });
          }
        },
      );

      it.each(withdrawalMarks)(
        "settles on a priced card that carries %s while the others are priced, which the collector refuses",
        async (_mark, mark) => {
          const mutate = (document: Document) => mark(nthCard(document, 1));

          expect(settledOn(await mutatedFixture(mutate))).toBe(true);
          expect(await expectAdapterDrift(mutate)).toMatchObject({
            ambiguity: "availability_ambiguous",
            markedPricedTierCards: 1,
          });
        },
      );

      it("settles, as the collector withdraws it, when a line in the price panel says the unpriced card's tier is not available", async () => {
        for (const line of ["Fastest is not available for this part.", "The Fastest tier is not available for this part."]) {
          const mutate = (document: Document) => {
            unpriceThirdCard(document);
            addToPanel(`<div>${line}</div>`)(document);
          };

          expect(settledOn(await mutatedFixture(mutate))).toBe(true);
          expect(await settledOffers(mutate)).toEqual(expectedTierOffers.slice(0, 2));
        }
      });

      it("keeps waiting when the line sits in the part card outside the price panel, which the collector refuses", async () => {
        const mutate = (document: Document) => {
          unpriceThirdCard(document);
          addToPartCard(document, "<div>Fastest is not available for this part.</div>");
        };

        expect(settledOn(await mutatedFixture(mutate))).toBe(false);
        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({ ambiguity: "availability_ambiguous" });
      });

      it("keeps waiting on an unpriced card that only mentions the tier a panel line withdraws", async () => {
        const mutate = (document: Document) => {
          const leastExpensive = firstCard(document);
          const amounts = leastExpensive.querySelector('[kind="discount"]');
          const header = leastExpensive.querySelector('[scale="small"]');
          if (!amounts || !header) throw new Error("fixture tier card lost its price block or header");
          amounts.replaceChildren();
          header.insertAdjacentHTML("afterend", "<div>Slower than Fastest</div>");
          unpriceCard(2)(document);
          addToPanel("<p>Fastest is not available for this part.</p>")(document);
        };

        expect(settledOnDocument(await mutatedDocument(mutate))).toBe(false);
        // Once the wait times out, the page is refused as pending, which a retry can clear.
        const failure = await collectXometryOffers(fixturePage(await loadCurrentQuotePage(mutate)), 1, undefined, {
          priceTiersSettled: false,
          pricingInProgress: false,
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          payload: { reason: "xometry_price_pending", pendingCause: "price_tiers_unsettled" },
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "unavailable" });
      });

      it("reads no panel line when a card's text is not where the panel shows it, as the collector refuses it", async () => {
        const document = await mutatedDocument((document) => {
          unpriceThirdCard(document);
          pricePanel(document).insertAdjacentHTML("afterbegin", "<p>Fastest is not available for this part.</p>");
        });
        // The second card reads differently on its own than inside the panel.
        Object.defineProperty(nthCard(document, 1), "innerText", {
          configurable: true,
          get: () => "Standard\nArrives by Nov 7\n$106.40",
        });

        expect(settledOnDocument(document)).toBe(false);
      });

      it.each(hiddenCopies)("settles, as the collector skips it, beside a hidden copy of a tier card (%s)", async (_how, hide) => {
        expect(settledOnDocument(await mutatedDocument(addHiddenCopy(hide)))).toBe(true);
        expect(await settledOffers(addHiddenCopy(hide))).toEqual(expectedTierOffers);
      });

      it("still withdraws a card on a panel line beside a hidden copy of a tier card", async () => {
        const mutate = (document: Document) => {
          unpriceThirdCard(document);
          addToPanel("<p>Fastest is not available for this part.</p>")(document);
          addHiddenCopy((copy) => copy.setAttribute("style", "display: none;"))(document);
        };

        expect(settledOnDocument(await mutatedDocument(mutate))).toBe(true);
        expect(await settledOffers(mutate)).toEqual(expectedTierOffers.slice(0, 2));
      });

      it.each(hiddenCopiesOutsidePanel)(
        "keeps waiting on an unpriced Standard card when the finish notice sits beside %s, as the collector refuses it",
        async (_copy, addCopy) => {
          const mutate = (document: Document) => {
            const amounts = nthCard(document, 1).querySelector('[kind="discount"]');
            if (!amounts) throw new Error("fixture tier card lost its price block");
            amounts.replaceChildren();
            addBesideFinish(finishNotice)(document);
            addCopy(document);
          };

          expect(settledOnDocument(await mutatedDocument(mutate))).toBe(false);
          expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({ ambiguity: "availability_ambiguous" });
        },
      );

      it.each(hiddenCopiesOutsidePanel)(
        "still settles, as the collector withdraws it, on a price-panel line beside %s",
        async (_copy, addCopy) => {
          const mutate = (document: Document) => {
            unpriceThirdCard(document);
            addToPanel("<p>Fastest is not available for this part.</p>")(document);
            addCopy(document);
          };

          expect(settledOnDocument(await mutatedDocument(mutate))).toBe(true);
          expect(await settledOffers(mutate)).toEqual(expectedTierOffers.slice(0, 2));
        },
      );

      it("keeps waiting while the page hides every tier card", async () => {
        expect(settledOnDocument(await mutatedDocument((document) => {
          pricePanel(document).setAttribute("style", "display: none;");
        }))).toBe(false);
      });

      it("keeps waiting on an empty tier card the page does not hide, as the collector calls it pending", async () => {
        expect(settledOnDocument(await mutatedDocument(addToPanel('<div class="price-tier"></div>')))).toBe(false);
      });

      it("settles, as the collector publishes them, when every card holds hidden unavailability text", async () => {
        const mutate = (document: Document) => {
          for (const card of tierCards(document)) {
            card.insertAdjacentHTML("beforeend", '<span style="display: none;">Not available for international shipping.</span>');
          }
        };

        expect(settledOnDocument(await mutatedDocument(mutate))).toBe(true);
        expect(await settledOffers(mutate)).toEqual(expectedTierOffers);
      });

      it.each([
        ["<body>", (document: Document) => document.body.classList.add("scroll-disabled")],
        ["<html>", (document: Document) => document.documentElement.setAttribute("aria-disabled", "true")],
        ["the parts list", (document: Document) => document.querySelector("#draggable-parts")?.classList.add("is-disabled")],
      ])("settles on priced cards, as the collector publishes them, when a mark sits above the part card on %s", async (_where, mutate) => {
        expect(settledOnDocument(await mutatedDocument(mutate))).toBe(true);
        expect(await settledOffers(mutate)).toEqual(expectedTierOffers);
      });

      it.each([
        ["an element around the tier name", (document: Document) => {
          addToPanel("<p><strong>Fastest</strong> is not available for this part.</p>")(document);
        }],
        ["two text nodes", (document: Document) => {
          const line = document.createElement("p");
          line.append("Fastest", " is not available for this part.");
          pricePanel(document).append(line);
        }],
      ])("settles, as the collector withdraws it, on an unavailability line split across %s", async (_split, addLine) => {
        const mutate = (document: Document) => {
          unpriceThirdCard(document);
          addLine(document);
        };

        expect(settledOnDocument(await mutatedDocument(mutate))).toBe(true);
        expect(await settledOffers(mutate)).toEqual(expectedTierOffers.slice(0, 2));
      });

      // A header slot with a badge line above the name names no tier, so no
      // panel line can withdraw that card: the collector refuses the page.
      it("settles on an unpriced card whose header shows a badge line above its tier name, which the collector refuses", async () => {
        const mutate = (document: Document) => {
          const standard = nthCard(document, 1);
          const amounts = standard.querySelector('[kind="discount"]');
          const header = standard.querySelector('[scale="small"]');
          if (!amounts || !header) throw new Error("fixture tier card lost its price block or header");
          amounts.replaceChildren();
          header.insertAdjacentHTML("beforebegin", "<div>Popular</div>");
          addToPanel("<p>Standard is not available for this part.</p>")(document);
        };

        expect(settledOnDocument(await mutatedDocument(mutate))).toBe(true);
        expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
          ambiguity: "availability_ambiguous",
          namedTierCards: 0,
        });
      });

      it.each([
        ["a lead time in days", (document: Document) => {
          for (const [index, label] of document.querySelectorAll('[data-testid="tierAndLeadTime"]').entries()) {
            label.textContent = `Lead Time: ${[7, 5, 2][index]} Days`;
          }
        }],
        ["a receive-by date", (document: Document) => {
          const label = nthCard(document, 1).querySelector('[data-testid="tierAndLeadTime"]');
          if (!label) throw new Error("fixture tier card lost its tierAndLeadTime hook");
          label.textContent = "Receive by Nov 6";
        }],
        ["USD amounts", (document: Document) => {
          for (const card of tierCards(document)) {
            // 4 is NodeFilter.SHOW_TEXT.
            const walker = document.createTreeWalker(card, 4);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              node.nodeValue = (node.nodeValue ?? "").replaceAll("$", "USD ");
            }
          }
        }],
      ])("settles on cards whose price and timing the collector reads, shown as %s", async (_evidence, mutate) => {
        expect(settledOn(await mutatedFixture(mutate))).toBe(true);
        expect((await settledOffers(mutate)).map(({ id, total }) => ({ id, total })))
          .toEqual(expectedTierOffers.map(({ id, total }) => ({ id, total })));
      });

      it.each([
        ["sits outside the part card", (document: Document) => {
          addToOrderSummary(document, "<div>Fastest is not available for this part.</div>");
        }],
        ["sits in the part card outside the price panel, even split across an element", (document: Document) => {
          addToPartCard(document, "<div><strong>Fastest</strong> is not available.</div>");
        }],
        // The collector reads rendered lines, so it never withdraws a card on a hidden one.
        ["is hidden", addToPanel('<div style="display: none">Fastest is not available for this part.</div>')],
        ["names a longer word", addToPanel("<div>Fastestest is unavailable.</div>")],
        ["names a shorter word", addToPanel("<div>Fast is unavailable.</div>")],
        ["only mentions the tier", addToPanel("<div>Fastest finish not available for this material.</div>")],
      ])("keeps waiting on an unpriced card when the unavailability line %s", async (_case, mutate) => {
        expect(settledOn(await mutatedFixture((document) => {
          unpriceThirdCard(document);
          mutate(document);
        }))).toBe(false);
      });

      it("keeps waiting on an unpriced card that is not withdrawn, or whose mark sits beside it", async () => {
        expect(settledOn(await mutatedFixture(unpriceThirdCard))).toBe(false);
        expect(settledOn(await mutatedFixture((document) => {
          unpriceThirdCard(document);
          // A disabled stepper beside the cards withdraws none of them.
          addToPartCard(document, '<div aria-disabled="true" class="stepper--disabled"></div>');
        }))).toBe(false);
      });

      it("keeps waiting on a blank card that shows only a disabled control, as the collector calls it pending", async () => {
        const blankWithDisabledControl = (document: Document) => {
          nthCard(document, 2).innerHTML = '<div kind="outlineWhite"><button type="button" disabled=""></button></div>';
        };

        expect(settledOn(await mutatedFixture(blankWithDisabledControl))).toBe(false);
        expect(await pendingOf(await loadCurrentQuotePage(blankWithDisabledControl))).toMatchObject({
          pendingCause: "tier_card_blank",
        });
      });

      it.each([
        ["an empty placeholder in place of the third card", replaceThirdCard(emptyTierPlaceholder)],
        ["a placeholder that says Loading...", replaceThirdCard('<div class="tier-skeleton"><div>Loading...</div></div>')],
        ["a Show more options control in the panel", addToPanel('<button type="button">Show more options</button>')],
        ["the Fastest card hidden with no shown copy", (document: Document) => {
          nthCard(document, 2).setAttribute("style", "display: none;");
        }],
        ["aria-busy on the price panel", (document: Document) => pricePanel(document).setAttribute("aria-busy", "true")],
        ["aria-busy on the drag handle", (document: Document) => dragHandle(document).setAttribute("aria-busy", "true")],
        ["a progress bar in the price panel", addToPanel('<div role="progressbar" aria-label="Loading"></div>')],
        ["Refreshing prices in the price panel", addToPanel("<div>Refreshing prices</div>")],
        ["Loading... elsewhere in the part card", (document: Document) => addToPartCard(document, "<div>Loading...</div>")],
        ["Saving... beside the configuration", addBesideFinish("<div>Saving...</div>")],
        ["Fetching new price... in a card", addToCard(1, "<div>Fetching new price...</div>")],
        ["a spinning icon in a card", addToCard(0, '<i class="fas fa-spinner fa-spin"></i>')],
        ["a shimmer overlay in a card", addToCard(2, '<div class="skeleton-shimmer"></div>')],
        ["empty slots for the other tiers beside one rendered card in a grid cell", onlyLeastExpensiveRendered(emptyTierPlaceholder)],
        ["a price panel without its heading", (document: Document) => panelHeading(document).remove()],
      ])("keeps waiting, as the collector refuses it, on priced cards beside %s", async (_case, mutate) => {
        expect(settledOnDocument(await mutatedDocument(mutate))).toBe(false);
      });

      it.each([
        "Fetching new price for bracket.step...",
        "Loading loading-dock-bracket.step",
      ])("keeps waiting, as the collector refuses it, when the loading line %j also names a file", async (line) => {
        expect(settledOnDocument(await mutatedDocument((document) => addToPartCard(document, `<div>${line}</div>`)))).toBe(false);
        expect(settledOnDocument(await mutatedDocument((document) => {
          const title = document.querySelector('[data-testid="part-card-title"] > span');
          if (!title) throw new Error("fixture lost its part title");
          title.textContent = line;
        }))).toBe(false);
      });

      it("keeps waiting at quantity 1 on an unpriced card a panel line withdraws only on a condition", async () => {
        for (const line of ["Fastest is not available for quantities over 50.", "The Fastest tier is not available to ship internationally."]) {
          const mutate = (document: Document) => {
            unpriceCard(2)(document);
            addToPanel(`<div>${line}</div>`)(document);
          };

          expect(settledOnDocument(await mutatedDocument(mutate))).toBe(false);
          expect(await driftOf(await loadCurrentQuotePage(mutate))).toMatchObject({
            ambiguity: "availability_ambiguous",
            namedPricedTierCards: 0,
          });
        }
      });

      it.each(["loading-dock-bracket.step", "loading dock bracket.step", "loading dock bracket.v2.STEP"])("settles on priced cards when only the known file name %j holds a loading word", async (fileName) => {
        expect(settledOnDocument(await mutatedDocument((document) => {
          const title = document.querySelector('[data-testid="part-card-title"] > span');
          if (!title) throw new Error("fixture lost its part title");
          title.textContent = fileName;
        }), [fileName])).toBe(true);
      });

      it.each([
        ["a note that some delivery is not available", addToCard(1, "<div>Weekend delivery not available.</div>")],
        ["a disabled button marking the selected tier", addToCard(1, '<button type="button" disabled="">Selected</button>')],
        ["a panel line with a condition about its tier", addToPanel("<div>Standard is not available for quantities over 50.</div>")],
      ])("settles on a priced card beside %s, which the collector refuses rather than withdraws", async (_case, mutate) => {
        for (const keepOnlyStandard of [false, true]) {
          const onPage = (document: Document) => {
            mutate(document);
            if (keepOnlyStandard) {
              nthCard(document, 2).remove();
              firstCard(document).remove();
            }
          };

          expect(settledOnDocument(await mutatedDocument(onPage))).toBe(true);
          expect(await driftOf(await loadCurrentQuotePage(onPage))).toMatchObject({ ambiguity: "availability_ambiguous" });
        }
      });
    });
  });

  it("fails closed when an upload never reaches the new quote URL", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Upload a CAD File",
      uploadRedirectUrl: XOMETRY_URLS.quoteHome,
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
        // OVD-611: Screenshot capture disabled, only DOM artifacts remain
        "landing-dom",
        "post-modal-poll-dom",
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
          : `Welcome back. ${anonymousQuoteHome.uploadPrompt}`,
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
      expect(evaluateProviderAdapterFailureContract(error)).toEqual({
        ok: true, terminalState: "login_required", violations: [],
      });
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
        // OVD-611: Screenshot capture disabled, only DOM artifacts remain
        "landing-dom",
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
      bodyText: "Instant quoting",
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

    // The original quote failure surfaces first; the teardown failure stays
    // attached as diagnostic evidence and keeps the error non-retryable.
    const failure = await adapter.quote(makeInput()).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "selector_failure",
      payload: {
        reason: "entry_state_unknown",
        providerMutationPossible: true,
        snapshotTeardownFailure: {
          code: "persistence_failure",
          reason: "browser_close_failed",
        },
      },
    });
    expect((failure as Error).cause).toMatchObject({
      code: "persistence_failure",
      payload: { reason: "browser_close_failed" },
    });
    expect(isRetryableVendorTaskError(failure)).toBe(false);
    expect(config.xometryProfileSnapshotGeneration).toBeNull();
    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "login_required",
      payload: { reason: "profile_snapshot_unavailable" },
    });
    expect(playwrightLaunchPersistentContextMock).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent Camoufox snapshot lifecycles through close and persist", async () => {
    const workerTempDir = await makeTempDir();
    const userDataDir = path.join(workerTempDir, "profile");
    const lifecycleSidecar = `${userDataDir}${XOMETRY_PROFILE_LOCK_SIDECAR_SUFFIX}`;
    let releaseFirstClose: () => void = () => undefined;
    const firstClose = new Promise<void>((resolve) => {
      releaseFirstClose = resolve;
    });
    let releaseFirstPersist: () => void = () => undefined;
    const firstPersist = new Promise<void>((resolve) => {
      releaseFirstPersist = resolve;
    });
    // The waiting lifecycle polls the sidecar on a real 1 s interval, so await the
    // lifecycle milestones the mocks report instead of fixed vi.waitFor windows.
    let markFirstLaunched: () => void = () => undefined;
    const firstLaunched = new Promise<void>((resolve) => {
      markFirstLaunched = resolve;
    });
    let markFirstPersistStarted: () => void = () => undefined;
    const firstPersistStarted = new Promise<void>((resolve) => {
      markFirstPersistStarted = resolve;
    });
    let firstPersistFinished = false;
    const firstContext = createFakeContext(createFakePage({ bodyText: "Upload a 3D model." }));
    firstContext.close = vi.fn(async () => firstClose);
    const secondContext = createFakeContext(createFakePage({ bodyText: "Upload a 3D model." }));
    camoufoxMock
      .mockImplementationOnce(async () => {
        await expect(fs.stat(lifecycleSidecar)).resolves.toBeDefined();
        markFirstLaunched();
        return firstContext;
      })
      .mockImplementationOnce(async () => {
        await expect(fs.stat(lifecycleSidecar)).resolves.toBeDefined();
        expect(firstPersistFinished).toBe(true);
        return secondContext;
      });
    const config = makeConfig({
      workerTempDir,
      xometryStorageStatePath: null,
      xometryUserDataDir: userDataDir,
      xometryProfileSnapshotBucket: "private-profile-bucket",
      xometryProfileSnapshotObject: "xometry/profile.tgz",
      xometryProfileSnapshotGeneration: "41",
      xometryBrowserEngine: "camoufox",
      xometryProfileLockWaitMs: 5_000,
    });
    restoreSnapshotMock.mockImplementation(async (currentConfig: WorkerConfig) => {
      await expect(fs.stat(lifecycleSidecar)).resolves.toBeDefined();
      return currentConfig;
    });
    persistSnapshotMock
      .mockImplementationOnce(async (currentConfig: WorkerConfig) => {
        await expect(fs.stat(lifecycleSidecar)).resolves.toBeDefined();
        markFirstPersistStarted();
        await firstPersist;
        firstPersistFinished = true;
        return { ...currentConfig, xometryProfileSnapshotGeneration: "42" };
      })
      .mockImplementationOnce(async (currentConfig: WorkerConfig) => {
        await expect(fs.stat(lifecycleSidecar)).resolves.toBeDefined();
        return {
          ...currentConfig,
          xometryProfileSnapshotGeneration: "43",
        };
      });
    const firstResult = new XometryAdapter("xometry", config)
      .quote(makeInput())
      .catch((error) => error as VendorAutomationError);
    const secondResult = new XometryAdapter("xometry", config)
      .quote(makeInput())
      .catch((error) => error as VendorAutomationError);

    await firstLaunched;
    expect(camoufoxMock).toHaveBeenCalledTimes(1);
    releaseFirstClose();
    await firstPersistStarted;
    expect(persistSnapshotMock).toHaveBeenCalledTimes(1);
    expect(camoufoxMock).toHaveBeenCalledTimes(1);
    releaseFirstPersist();
    const [firstError, secondError] = await Promise.all([firstResult, secondResult]);
    expect(camoufoxMock).toHaveBeenCalledTimes(2);
    expect(persistSnapshotMock).toHaveBeenCalledTimes(2);

    expect(firstError.code).toBe("selector_failure");
    expect(secondError.code).toBe("selector_failure");
    expect(config.xometryProfileSnapshotGeneration).toBe("43");
    expect(restoreSnapshotMock).toHaveBeenCalledTimes(2);
    await expect(fs.stat(lifecycleSidecar)).rejects.toThrow();
    expect(camoufoxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        identityConfig: { "navigator.userAgent": "stable-firefox" },
        headless: true,
      }),
    );
  });

  it("fails closed when Xometry asks about export control without an explicit No option", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Are any parts subject to export control?",
      uploadRedirectUrl: XOMETRY_URLS.quoteHome,
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

    try {
      await adapter.quote(makeInput());
      throw new Error("expected ambiguous export-control state");
    } catch (error) {
      expect(error).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          reason: "export_control_state_ambiguous",
        },
      });
      expect(
        (error as VendorAutomationError).artifacts.map((artifact) => artifact.label),
      ).toEqual([
        // OVD-611: Screenshot capture disabled, only DOM artifacts remain
        "landing-dom",
        "export-control-ambiguous-dom",
      ]);
    }
  });

  it("does not fall back to legacy export-control controls when the reviewed shape is invalid", async () => {
    const workerTempDir = await makeTempDir();
    const legacyNoClick = vi.fn();
    const legacyContinueClick = vi.fn();
    const page = createFakePage({
      bodyText: "Are any parts subject to export control?",
      uploadRedirectUrl: XOMETRY_URLS.quoteHome,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.exportControlContinue[0]]: {
          count: 1,
          dataTestId: "ItarView-itar-continue",
        },
        [XOMETRY_LOCATORS.exportControlNo[0]]: {
          count: 1,
          getAttribute: (name) => {
            if (name === "type") return "checkbox";
            if (name === "value") return "confirmed-not-itar";
            return null;
          },
        },
        [XOMETRY_LOCATORS.exportControlContinue[1]]: {
          count: 1,
          click: legacyContinueClick,
        },
        [XOMETRY_LOCATORS.exportControlNo[1]]: {
          count: 1,
          click: legacyNoClick,
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
        reviewedNoType: "checkbox",
      },
    });
    expect(legacyNoClick).not.toHaveBeenCalled();
    expect(legacyContinueClick).not.toHaveBeenCalled();
  });

  it("does not accept lookalike values outside their exact summary fields", async () => {
    const workerTempDir = await makeTempDir();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Type III Hard Anodize",
      "Precision Tolerance: ±.005",
      "Unrelated note: Black Anodize",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-FIELD-0001",
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-FIELD-0002",
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEMPER-0001",
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
    const input = await makeLiveEvaluationInput();
    const drawingPath = path.join(
      path.dirname(input.stagedCadFile!.localPath),
      "part.pdf",
    );
    await fs.writeFile(drawingPath, "authorized-drawing-bytes");
    const drawingFileSha256 = await sha256File(drawingPath);
    input.part = { ...input.part, drawing_file_id: "drawing-1" };
    input.drawingFile = {
      id: "drawing-1",
      job_id: "job-1",
      storage_bucket: "job-files",
      storage_path: "drawings/part.pdf",
      original_name: "part.pdf",
      file_kind: "drawing",
    };
    input.stagedDrawingFile = {
      originalName: "part.pdf",
      localPath: drawingPath,
      storageBucket: "job-files",
      storagePath: "drawings/part.pdf",
      trustedContentSha256: drawingFileSha256,
    };
    input.liveEvaluationAuthorization = {
      ...input.liveEvaluationAuthorization!,
      drawingFileSha256,
    };
    const uploadDrawing = vi.fn();
    const summaryText = [
      "Quantity: 2",
      "Material: Aluminum 6061-T6x (Best Available)",
      "Finish: Black Anodize",
      "Precision Tolerance: ±.005",
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-0001",
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
          setInputFiles: vi.fn(async () => {
            await fs.writeFile(drawingPath, "replacement-after-cad-upload");
          }),
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

    const adapter = makeLiveEvaluationAdapter(
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
        xometryBrowserEngine: "playwright",
      }),
    );

    const result = await adapter.quote(input);

    expect(uploadDrawing).toHaveBeenCalledTimes(1);
    const uploadedDrawing = uploadDrawing.mock.calls[0]?.[0] as unknown as {
      buffer: Buffer;
    };
    expect(uploadedDrawing.buffer.toString()).toBe("authorized-drawing-bytes");
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-ASYNC",
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-FAILED",
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-RELOAD",
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
      "Least Expensive 5 business days USD $60.00 ea. USD $120.00",
    ].join(" ");
    const page = createFakePage({
      bodyText: summaryText,
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-DRAWING-0002",
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

  it("fails closed when duplicate reviewed export-control submit actions are present", async () => {
    const workerTempDir = await makeTempDir();
    const reviewedNoClick = vi.fn();
    const reviewedContinueClick = vi.fn();
    const page = createFakePage({
      bodyText: "Are any parts subject to export control?",
      uploadRedirectUrl: XOMETRY_URLS.quoteHome,
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          getAttribute: (name) => (name === "accept" ? ".step,.stp" : null),
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.exportControlContinue[0]]: {
          count: 2,
          click: reviewedContinueClick,
        },
        [XOMETRY_LOCATORS.exportControlNo[0]]: {
          count: 1,
          click: reviewedNoClick,
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
        reviewedContinueCount: 2,
      },
    });
    expect(reviewedNoClick).not.toHaveBeenCalled();
    expect(reviewedContinueClick).not.toHaveBeenCalled();
  });

  it.each([
    ["withholds a price in manual review when every tier card is unavailable", true],
    ["fails closed as selector drift when no tier card renders", false],
  ])("%s and every declared price locator misses", async (_case, unavailableCard) => {
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
        "Least Expensive Spring sale! Orders over USD $19.99 ship free. Lead time 5 business days",
      ].join(" "),
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002/part-1",
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
          inputValue: () => "2",
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
        // OVD-1052: one tier card the page withdrew, or none at all.
        [XOMETRY_LOCATORS.priceTierCard]: unavailableCard
          ? { count: 1, text: "Least Expensive\nNot available" }
          : { count: 0 },
      },
      optionTexts: ["6061-T6", "Black Anodize"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
    );

    if (!unavailableCard) {
      // No option set exists to read, so nothing (the banner price included) is published.
      const failure = await adapter.quote(makeInput()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ payload: expect.objectContaining({ reason: "xometry_price_tier_cards_missing" }) });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "selector_drift",
        violations: [],
      });
      return;
    }
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
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0002/part-1",
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
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003/part-1",
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
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0004/part-1",
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

  it("waits for geometry analysis to finish before configuring quantity", async () => {
    const workerTempDir = await makeTempDir();
    const fillQuantity = vi.fn();
    const page = createFakePage({
      bodyText: "Analyzing Geometry... Loading supported file extensions...",
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-ANALYZING-0001",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: vi.fn(),
        },
        [XOMETRY_LOCATORS.quantityInputs[0]]: {
          count: 1,
          fill: fillQuantity,
        },
      },
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
      code: "navigation_failure",
    });
    expect(fillQuantity).not.toHaveBeenCalled();
  });

  it("makes a post-upload navigation failure non-retryable for the task", async () => {
    const uploadCad = vi.fn();
    const { failure, phase } = await quoteInTrackedMutationPhase(createFakePage({
      bodyText: "Analyzing Geometry... Loading supported file extensions...",
      uploadRedirectUrl:
        "https://www.xometry.com/quoting/quote/Q00-ANALYZING-0002",
      selectorBehaviors: {
        [XOMETRY_LOCATORS.uploadInputs[0]]: {
          count: 1,
          setInputFiles: uploadCad,
        },
      },
    }));

    expect(uploadCad).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({ code: "navigation_failure" });
    // Without the phase the transport-flavored code alone would be retried.
    expect(isRetryableVendorTaskError(failure, createProviderMutationPhase())).toBe(true);
    expect(phase.started).toBe(true);
    expect(isRetryableVendorTaskError(failure, phase)).toBe(false);
  });

  it("keeps a pre-upload navigation failure retryable", async () => {
    const page = createFakePage({ bodyText: "Pick Up Where You Left Off", selectorBehaviors: {} });
    page.goto = async () => {
      throw new Error("page.goto: net::ERR_CONNECTION_RESET at https://www.xometry.com/quoting/home/");
    };
    const { failure, phase } = await quoteInTrackedMutationPhase(page);

    expect(failure).toMatchObject({ code: "navigation_failure" });
    expect(phase.started).toBe(false);
    expect((failure as VendorAutomationError).payload.providerMutationPossible).not.toBe(true);
    expect(isRetryableVendorTaskError(failure, phase)).toBe(true);
  });

  it("redacts logged-in DOM captures before they are written", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part jane@customer.example token=xometry-session-secret",
      selectorBehaviors: {},
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
      }),
    );

    const failure = await adapter.quote(makeInput()).catch((error: unknown) => error);

    const htmlArtifacts = (failure as VendorAutomationError).artifacts
      .filter((artifact) => artifact.kind === "html_snapshot");
    expect(htmlArtifacts.length).toBeGreaterThan(0);
    for (const artifact of htmlArtifacts) {
      const html = await fs.readFile(artifact.localPath, "utf8");
      expect(html).toContain("<body>");
      expect(html).not.toContain("jane@customer.example");
      expect(html).not.toContain("xometry-session-secret");
      expect((await fs.stat(artifact.localPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed when Save Configuration is absent", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003/part-1",
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
        "Least Expensive USD $25.00 Lead time 5 business days",
      ].join(" "),
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0004/part-1",
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

  describe("OVD-777 overwrites Xometry's auto-selected requirements", () => {
    async function quoteT1(
      flow: ReturnType<typeof createAutoSelectionFlow>,
      input: VendorQuoteAdapterInput,
    ) {
      const workerTempDir = await makeTempDir();
      launchMock.mockResolvedValue(createFakeBrowser(flow.page));
      const adapter = new XometryAdapter(
        "xometry",
        makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
      );
      return adapter.quote(input);
    }

    const cncCatalog = {
      process: ["CNC Machining", "Sheet Cutting"],
      material: {
        "CNC Machining": ["Aluminum 6061-T6x (Best Available)"],
        "Sheet Cutting": ["Aluminum 5052-H32"],
      },
      finish: ["As Machined", "Black Anodize"],
    };

    it("clears a drawing-applied Black Anodize when the saved finish is as machined", async () => {
      const flow = createAutoSelectionFlow({ ...T1_PART_WITH_DRAWING, offered: cncCatalog });

      const result = await quoteT1(flow, makeT1Input({ finish: "as machined" }, true));

      expect(flow.selection).toEqual({
        process: "CNC Machining",
        material: "Aluminum 6061-T6x (Best Available)",
        finish: "As Machined",
      });
      expect(flow.saveConfiguration).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("instant_quote_received");
      expect(result.totalPriceUsd).toBe(414.15);
      expect(result.rawPayload).toMatchObject({
        drawingUploadMode: "fallback",
        selectedFinish: "As Machined",
        requirementsVerified: true,
      });
    });

    it("clears an auto-applied Black Anodize read back after upload", async () => {
      const flow = createAutoSelectionFlow({
        ...T1_PART_WITH_DRAWING,
        drawing: undefined,
        uploaded: { ...T1_PART_WITH_DRAWING.uploaded, finish: "Black Anodize" },
        offered: cncCatalog,
      });

      const result = await quoteT1(flow, makeT1Input({ finish: "as machined" }, false));

      expect(flow.selection.finish).toBe("As Machined");
      expect(result.status).toBe("instant_quote_received");
      expect(result.rawPayload).toMatchObject({ selectedFinish: "As Machined", requirementsVerified: true });
    });

    it("moves an auto-selected Sheet Cutting / 5052-H32 plate to CNC Machining and 6061", async () => {
      const flow = createAutoSelectionFlow({ ...T1_SAMPLE_PLATE, offered: cncCatalog });

      const result = await quoteT1(flow, makeT1Input({ material: "6061 aluminum", finish: null }, false));

      expect(flow.selection).toEqual({
        process: "CNC Machining",
        material: "Aluminum 6061-T6x (Best Available)",
        finish: "Standard",
      });
      expect(result.status).toBe("instant_quote_received");
      expect(result.rawPayload).toMatchObject({ selectedMaterial: "6061-T6", requirementsVerified: true });
    });

    it("still fails closed when Xometry offers no As Machined finish to select", async () => {
      const flow = createAutoSelectionFlow({
        ...T1_PART_WITH_DRAWING,
        offered: { ...cncCatalog, finish: ["Black Anodize"] },
      });

      await expect(quoteT1(flow, makeT1Input({ finish: "as machined" }, true))).rejects.toMatchObject({
        code: "unexpected_ui_state",
        payload: { reason: "saved_requirement_mismatch", requirementMismatches: ["finish"] },
      });
      expect(flow.selection.finish).toBe("Black Anodize");
    });

    it("still fails closed when Xometry offers no CNC Machining process to select", async () => {
      const flow = createAutoSelectionFlow({
        ...T1_SAMPLE_PLATE,
        offered: {
          ...cncCatalog,
          process: ["Sheet Cutting"],
          material: { "Sheet Cutting": ["Aluminum 5052-H32", "Aluminum 6061-T6"] },
        },
      });

      await expect(
        quoteT1(flow, makeT1Input({ material: "6061 aluminum", finish: null }, false)),
      ).rejects.toMatchObject({
        code: "unexpected_ui_state",
        payload: { reason: "saved_requirement_mismatch", requirementMismatches: ["process"] },
      });
      expect(flow.selection.process).toBe("Sheet Cutting");
    });
  });

  it("returns contract-valid failures on login, captcha and generic-error barriers", async () => {
    const workerTempDir = await makeTempDir();

    for (const [bodyText, gotoRedirectUrl, expectedCode, terminalState] of [
      ["Sign in to continue", XOMETRY_URLS.login, "login_required", "login_required"],
      ["Verify you are human", XOMETRY_URLS.quoteHome, "captcha", "captcha"],
      [anonymousQuoteHome.errorBanner, XOMETRY_URLS.quoteHome, "anti_detection_block", "unavailable"],
    ] as const) {
      const page = createFakePage({
        bodyText,
        gotoRedirectUrl,
      });
      launchMock.mockResolvedValue(createFakeBrowser(page));

      const adapter = new XometryAdapter(
        "xometry",
        makeConfig({ workerTempDir, xometryStorageStatePath: path.join(workerTempDir, "state.json") }),
      );

      const failure = await adapter.quote(makeInput()).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "VendorAutomationError",
        code: expectedCode,
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toEqual({
        ok: true, terminalState, violations: [],
      });
    }
  });

  it("raises selector failures when the upload input is missing", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part Total price USD $120.00 5 business days",
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
        reason: "entry_state_unknown",
        matchedStates: [],
        evidence: {
          route: "quote_home",
          dashboardInputCount: 0,
          dashboardUploadButtonCount: 0,
        },
      },
    });
  });

  it("does not attempt screenshot capture even when page.screenshot would fail", async () => {
    const workerTempDir = await makeTempDir();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = createFakePage({
      bodyText: "Configure part Total price USD $120.00 5 business days",
      screenshotFails: true, // Would fail, but we don't capture screenshots anymore
      selectorBehaviors: {},
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
      }),
    );

    try {
      await adapter.quote(makeInput());
      throw new Error("expected selector failure");
    } catch (error) {
      expect(error).toMatchObject({
        name: "VendorAutomationError",
        code: "selector_failure",
        payload: { reason: "entry_state_unknown" },
      });
      // OVD-611: Only HTML snapshot captured now, no screenshot attempt
      expect(
        (error as VendorAutomationError).artifacts.map((artifact) =>
          artifact.label
        ),
      ).toEqual(["landing-dom"]);
      // OVD-611: No warning about missing screenshots since we don't capture them
      expect(warning).not.toHaveBeenCalledWith(
        expect.stringContaining('"source":"vendor.artifact_capture_degraded"'),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves the workflow error and records diagnostics when all evidence capture fails", async () => {
    const workerTempDir = await makeTempDir();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = createFakePage({
      bodyText: "Configure part Total price USD $120.00 5 business days",
      screenshotFails: true, // Would fail, but not attempted per OVD-611
      contentFails: true,
      selectorBehaviors: {},
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
      }),
    );

    try {
      await adapter.quote(makeInput());
      throw new Error("expected selector failure");
    } catch (error) {
      expect(error).toMatchObject({
        name: "VendorAutomationError",
        code: "selector_failure",
        payload: { reason: "entry_state_unknown" },
        artifacts: [],
      });
      // OVD-611: Only HTML capture is attempted now, so only that can fail
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('"missingArtifactKinds":["html_snapshot"]'),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("fails closed when the requested quantity cannot be configured", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part",
      uploadRedirectUrl: "https://www.xometry.com/quoting/quote/Q00-TEST-0003",
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

  // OVD-611: Verify no screenshots or traces are captured
  it("does not capture screenshots per OVD-611 evidence masking policy", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part Total price USD $120.00 5 business days",
      selectorBehaviors: {},
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
      }),
    );

    try {
      await adapter.quote(makeInput());
      throw new Error("expected selector failure");
    } catch (error) {
      expect(error).toBeInstanceOf(VendorAutomationError);
      const artifacts = (error as VendorAutomationError).artifacts;
      
      // Verify no screenshot artifacts
      const screenshotArtifacts = artifacts.filter(a => a.kind === "screenshot");
      expect(screenshotArtifacts).toHaveLength(0);
      
      // Verify HTML snapshots are still captured
      const htmlArtifacts = artifacts.filter(a => a.kind === "html_snapshot");
      expect(htmlArtifacts.length).toBeGreaterThan(0);
    }
  });

  it("discards the trace on failure instead of writing or uploading it (OVD-611)", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyText: "Configure part Total price USD $120.00 5 business days",
      contentFails: true,
      selectorBehaviors: {},
    });
    const browser = createFakeBrowser(page);
    launchMock.mockResolvedValue(browser);

    const adapter = new XometryAdapter(
      "xometry",
      makeConfig({
        workerTempDir,
        playwrightCaptureTrace: true,
        xometryStorageStatePath: path.join(workerTempDir, "state.json"),
      }),
    );

    const error = await adapter.quote(makeInput()).catch((caught) => caught);

    expect(error).toBeInstanceOf(VendorAutomationError);
    expect((error as VendorAutomationError).artifacts.map((a) => a.kind)).not.toContain("trace");
    const context = await browser.newContext();
    expect(context.tracing.start).toHaveBeenCalledTimes(1);
    expect(context.tracing.stop).toHaveBeenCalledTimes(1);
    expect(context.tracing.stop).toHaveBeenCalledWith();
  });
});
