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
import type { Locator, Page } from "playwright";
import {
  FictivAdapter,
  advanceFictivSettle,
  clickFictivControl,
  detectBlockingStateSignal,
  fictivCurrencyContext,
  isFictivSettled,
  startFictivSettle,
  type FictivSettlePoll,
  isManualReviewText,
  parseFirstCurrency,
  parseLeadTime,
  parseQuantityDisplay,
  setFilesOnUpload,
} from "./fictiv";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  FICTIV_FORBIDDEN_CLICK_TARGET,
  FICTIV_LOCATORS,
  FICTIV_URLS,
  finishReadbackMatches,
  materialReadbackMatches,
  processReadbackMatches,
} from "./fictivConstraints";
import { evaluateProviderAdapterContract, evaluateProviderAdapterFailureContract } from "./providerAdapterContract";
import { fictivDispatchAuthorization, fictivDispatchEnvelope } from "../../test-support/fictivDispatchFixture";
import {
  activateRadioCard,
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
  /** An input's value; a fill overwrites it unless the test supplies a function. */
  value?: string | (() => string);
  setInputFiles?: (files: unknown) => Promise<void> | void;
  click?: () => Promise<void> | void;
  fill?: (value: string) => Promise<void> | void;
  press?: (value: string) => Promise<void> | void;
  waitFor?: () => Promise<void> | void;
};

/** The quote page Fictiv opens for the quote an upload created (synthetic path, no quote id). */
const CREATED_QUOTE_URL = "https://app.fictiv.com/pages/quotes/created-from-upload";
/**
 * The upload page as the fake pages model it: no quote, price, review or
 * progress state yet. Since OVD-1053 round 4 a run only uploads, configures and
 * prices after landing on such a page; the page states after it follow the
 * upload.
 */
const FRESH_UPLOAD_PAGE = "Select process to continue";
/**
 * A link to some quote on the page, as the adapter read it before OVD-1053
 * round 5 (F13). The adapter never reads it now: the only quote URL it
 * publishes is the one its upload created.
 */
const PAGE_QUOTE_LINK = 'a[href*="/quotes/"]';
/**
 * Fictiv's part configuration cell on a priced quote (synthetic labels), for
 * makeInput's requirement: CNC, 6061 aluminum, Type II black anodize.
 */
const PRICED_CONFIGURATION_TEXT = "CNC\n6061 Aluminum (T6)\nAnodize Type II Black\nEdit configuration";
const pricedConfiguration = (text = PRICED_CONFIGURATION_TEXT): Record<string, LocatorBehavior> => ({
  [FICTIV_LOCATORS.partConfigurationSummaries[0]]: { count: 1, text },
});

type FakePageOptions = {
  bodyText?: string;
  bodyTextSequence?: string[];
  url?: string;
  selectorBehaviors?: Record<string, LocatorBehavior>;
  optionTexts?: string[];
  redirectUrl?: string;
  onWaitForTimeout?: (waitCount: number) => void;
  /** Where the page goes once files are set (default CREATED_QUOTE_URL); null stays put. */
  urlAfterUpload?: string | null;
  /**
   * OVD-1052 round 8 (H1): Fictiv reprices after the run's configuration.
   * The selected price hook reads "$ --" from the quantity fill until the
   * page's next wait, so the price shows an update after the last
   * configuration action. A price that never changes after it stops the run
   * as quantity_reprice_unsettled.
   */
  repricesAfterConfiguration?: boolean;
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
      if (typeof behavior.value !== "function") behavior.value = value;
    },
    async inputValue() {
      return resolve(behavior.value, "");
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
  let repricePending = false;

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

      const behavior = selectorBehaviors[selector];
      const locator = makeLocator(
        repricePending && selector === FICTIV_LOCATORS.selectedPriceText[0] ? { ...behavior, text: "$ --" } : behavior,
      );
      return {
        ...locator,
        async fill(value: string) {
          await locator.fill(value);
          if (options.repricesAfterConfiguration) repricePending = true;
        },
        async setInputFiles(files: unknown) {
          await locator.setInputFiles(files);
          // Fictiv creates a quote from the upload and opens it.
          if (options.urlAfterUpload !== null) currentUrl = options.urlAfterUpload ?? CREATED_QUOTE_URL;
        },
      };
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
      repricePending = false;
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

  // OVD-1053 round 5 (F15): the quantity display shape a price is published
  // on. Every rejected case below is accepted by some loosened variant of
  // QUANTITY_DISPLAY_PATTERN (no anchors, any label, any unit, loose digit
  // grouping, decimals, trailing text), so loosening it fails this test.
  it.each([
    ["5", 5],
    ["Qty 5", 5],
    ["QTY: 5", 5],
    ["Qty5", 5],
    ["Quantity: 12", 12],
    ["quantity 12 units", 12],
    ["5 pc", 5],
    ["5 pcs", 5],
    ["5 piece", 5],
    ["5 pieces", 5],
    ["5 part", 5],
    ["Qty 2 parts", 2],
    ["5 unit", 5],
    ["1,000 parts", 1000],
    ["Qty 12,345,678 pcs", 12345678],
    // F21: the abbreviated label, with its period.
    ["Qty. 5", 5],
    ["QTY. 5", 5],
    ["Qty.: 5", 5],
    ["qty. 12 pcs", 12],
  ])("reads the quantity display %j as %i", (text, quantity) => {
    expect(parseQuantityDisplay(text)).toBe(quantity);
  });

  it.each([
    "",
    "Qty",
    "Part 2 · Qty 5",
    "Qty 5 (min 10)",
    "Qty 5 of 10",
    "Qty 5-10",
    "Qty 5 / 10",
    "Qty 5 5",
    "Qty Qty 5",
    "Total 5",
    "Items: 5",
    "Min qty 5",
    "5 sets",
    "5 each",
    "5 kits",
    "5x",
    "Qty 5.",
    "Qty 5 pcs each",
    "5 pcs pcs",
    "5.0",
    "Qty 1.000",
    "1,00",
    "1,0000",
    "10,00,000",
    ",500",
    "Qty -5",
    "$5",
    // F21: "Qty.5" could be 0.5; a stray period is not a label.
    "Qty.5",
    "Qty..5",
    "Qty.. 5",
    "Qty . 5",
    "Qty .5",
    "Qty. 5.",
    "Quantity. 5",
  ])("reads no quantity from the display %j", (text) => {
    expect(parseQuantityDisplay(text)).toBeNull();
  });

  // OVD-1052 (G3): the currency a quote page establishes for the bare "$"
  // amounts in Fictiv's lead-time price spans.
  it.each([
    // The 02:46Z captures: no currency selector, label or account currency.
    { label: "the 02:46Z quote page text", body: "Select regional preference\nBelow is the price for part production.\n$ --\nUSA only", hooks: [], currency: null, source: null, conflict: false },
    { label: "a bare dollar amount alone", body: "$ 412.30", hooks: [], currency: null, source: null, conflict: false },
    { label: "a currency selector reading USD", body: "", hooks: ["USD"], currency: "USD", source: "currency_hook", conflict: false },
    { label: "a currency label", body: "", hooks: ["Currency: USD"], currency: "USD", source: "currency_hook", conflict: false },
    { label: "a statement", body: "All prices shown in USD.", hooks: [], currency: "USD", source: "page_text", conflict: false },
    { label: "a labeled total", body: "Subtotal (USD)", hooks: [], currency: "USD", source: "page_text", conflict: false },
    { label: "an amount written as USD", body: "Total USD $9.00", hooks: [], currency: "USD", source: "page_text", conflict: false },
    { label: "an amount written as US$", body: "US$ 9.00", hooks: [], currency: "USD", source: "page_text", conflict: false },
    // "CAD" alone is the design files Fictiv asks for, not a currency.
    { label: "CAD files next to a USD selector", body: "Drag and drop your CAD models and drawings", hooks: ["USD"], currency: "USD", source: "currency_hook", conflict: false },
    { label: "another currency next to an amount", body: "Shipping CAD $25.00", hooks: ["USD"], currency: null, source: null, conflict: true },
    { label: "an amount with another currency after it", body: "25.00 EUR", hooks: ["USD"], currency: null, source: null, conflict: true },
    { label: "a euro sign", body: "€ 12.00", hooks: ["USD"], currency: null, source: null, conflict: true },
    { label: "a Canadian dollar sign", body: "C$ 12.00", hooks: ["USD"], currency: null, source: null, conflict: true },
    { label: "another currency's label", body: "Currency: GBP", hooks: [], currency: null, source: null, conflict: true },
    { label: "a selector reading another currency", body: "", hooks: ["CAD"], currency: null, source: null, conflict: true },
    { label: "a hook naming no currency", body: "", hooks: ["Change currency"], currency: null, source: null, conflict: false },
  ])("reads the page currency context from $label", ({ body, hooks, currency, source, conflict }) => {
    expect(fictivCurrencyContext(body, hooks)).toEqual({ currency, source, conflict });
  });

  it("accepts only Fictiv's CNC process label as the priced process", () => {
    for (const label of ["CNC", "CNC Machining", "cnc machining", " CNC "]) {
      expect(processReadbackMatches(label), label).toBe(true);
    }
    for (const label of ["3D Printing", "Sheet Metal", "Urethane Casting", "CNC and Sheet Metal", "Not CNC", "CNC Machining Mill | Lathe", ""]) {
      expect(processReadbackMatches(label), label).toBe(false);
    }
  });

  it.each([
    ["6061 aluminum", "6061 Aluminum (T6 / T651)", true],
    ["6061-T6 aluminum", "6061-T6 Aluminum", true],
    ["6061 aluminum", "7075-T6 Aluminum", false],
    ["6061 aluminum", "6061-T6 / 7075-T6 Aluminum", false],
    ["6061 aluminum", "16061 Aluminum", false],
    ["6061 aluminum", "Aluminum", false],
    ["6061 aluminum", "", false],
    ["304 stainless", "304 Stainless Steel", true],
    ["304 stainless", "304L Stainless Steel", false],
    ["303 stainless", "304 Stainless Steel", false],
    // F18: the requirement's own grade, never the search mapping's (Grade 5).
    ["titanium", "Titanium Grade 5 (Ti-6Al-4V)", false],
    ["Ti-6Al-4V", "Titanium Grade 5 (Ti-6Al-4V)", true],
    ["titanium grade 5", "Titanium Grade 5 (Ti-6Al-4V)", true],
    ["titanium grade 2", "Titanium Grade 5 (Ti-6Al-4V)", false],
    ["titanium", "Titanium Grade 2", false],
    ["Delrin", "Acetal (Delrin)", true],
    ["mystery alloy", "6061 Aluminum", false],
    // F18: the live 6061 label lists the T6 tempers Fictiv may supply.
    ["6061-T6 aluminum", "6061 Aluminum (T6 / T651 / T6511)", true],
    ["6061 aluminum", "6061 Aluminum (T6 / T651 / T6511)", true],
    ["6061-T651", "6061 Aluminum (T6 / T651 / T6511)", true],
    ["Aluminum 6061-T6511", "6061 Aluminum (T6 / T651 / T6511)", true],
    ["AL 6061-T6", "6061 Aluminum (T6 / T651 / T6511)", true],
    ["6061-O aluminum", "6061 Aluminum (T6 / T651 / T6511)", false],
    ["6061-T6 aluminum", "6061-O Aluminum", false],
    ["6061 aluminum", "6061-O Aluminum", false],
    ["6061-T6 aluminum", "6061 Aluminum", false],
    ["6061-T6 aluminum", "6061 Aluminum (T4 / T6)", false],
    ["6061-T6 aluminum", "6061-T6 Stainless Steel", false],
    ["6061-T6 aluminum", "6061-T6 Aluminum, anodized", false],
    ["7075-T6 aluminum", "7075 Aluminum (T6 / T651 / T7351)", false],
    ["7075-T73 aluminum", "7075-T6 Aluminum", false],
    ["7075-T73 aluminum", "7075 Aluminum (T73 / T7351)", true],
    ["304L stainless", "304L Stainless Steel", true],
    ["304L stainless", "304 Stainless Steel", false],
    ["304 stainless", "304/304L Stainless Steel", false],
    ["17-4 PH stainless", "17-4 PH Stainless Steel", true],
    ["17-4 PH stainless", "17-4 PH Stainless Steel (H900)", false],
    ["Brass 360", "Brass C360", true],
    ["brass", "Brass C360", false],
    ["Nylon 6/6", "Nylon 6/6", true],
    ["Delrin", "Delrin (Acetal) Black", false],
    ["constructor", "constructor", false],
  ])("matches the requested material %j against the priced label %j: %s", (requested, label, matches) => {
    expect(materialReadbackMatches(requested, label)).toBe(matches);
  });

  it.each([
    [null, "No finish (As machined)", true],
    ["as machined", "As machined", true],
    ["as machined", "As machined + Bead blast", false],
    ["as machined", "Anodize Type II Black", false],
    ["as machined", "Standard", false],
    ["Type II black anodize", "Anodize Type II Black", true],
    ["Type II black anodize", "Anodize Type II Clear", false],
    ["Type II black anodize", "Anodize Type III Black", false],
    ["Type II black anodize", "Anodize Type II Black / Clear", false],
    ["Type II black anodize", "Anodize Type II Black, Bead blast", false],
    ["Type II black anodize", "No finish (As machined)", false],
    // F17: exact, not partial: a color the requirement does not name is not confirmed.
    ["Type II anodize", "Anodize Type II Clear", false],
    ["Type II anodize", "Anodize Type II", true],
    ["Type III hard anodize", "Hardcoat Anodize Type III", true],
    ["Type III hard anodize", "Anodize Type II", false],
    ["bead blast", "Bead Blast", true],
    ["bead blast", "Bead Blast + Anodize Type II", false],
    ["custom dipped coating", "Custom dipped coating", false],
    // F17: chem film per MIL-DTL-5541 Type II is not Type II anodize, either way round.
    ["Type II black anodize", "Chem film per MIL-DTL-5541 Type II Class 3", false],
    ["Type II anodize", "Chem film per MIL-DTL-5541 Type II Class 3", false],
    ["Chem film per MIL-DTL-5541 Type II Class 3", "Anodize Type II", false],
    ["Chem film per MIL-DTL-5541 Type II Class 3", "Chem Film MIL-DTL-5541, Type II, Class 3", true],
    ["Chem film per MIL-DTL-5541 Type II Class 3", "Chem Film", false],
    ["Chem film per MIL-DTL-5541 Type II Class 3", "Chem Film MIL-DTL-5541 Type I Class 3", false],
    ["Chem film", "Chem Film (Clear)", false],
    // F17: every treatment of a compound finish, and no other.
    ["Bead blast + Type II black anodize", "Anodize Type II Black", false],
    ["Bead blast + Type II black anodize", "Bead Blast", false],
    ["Bead blast + Type II black anodize", "Bead Blast, Anodize Type II Black", true],
    ["Bead blast + Type II black anodize", "Bead Blast, Anodize Type II Black, Passivation", false],
    // F17: "none", "no finish" or "as machined" in a note never makes a treatment read as machined.
    ["Type II black anodize, no finish on threads", "No finish (As machined)", false],
    ["Type II black anodize (no finish)", "No finish (As machined)", false],
    ["Type II black anodize (no finish)", "Anodize Type II Black", true],
    ["As machined; Type II black anodize", "No finish (As machined)", false],
    ["Type II black anodize, none", "As machined", false],
    ["none", "No finish (As machined)", true],
    ["No finish", "As machined", true],
    // F17: unknown or partial page labels fail closed.
    ["Type II black anodize", "Anodize Type II Black (see notes)", false],
    ["Type II black anodize", "Type II Black", false],
    ["Type II black anodize", "Anodize Type II Black, Type III", false],
    ["Type II black anodize", "", false],
  ])("matches the requested finish %j against the priced label %j: %s", (requested, label, matches) => {
    expect(finishReadbackMatches(requested, label)).toBe(matches);
  });

  // F17: the finish configured is read the way the readback reads it, so a
  // chem film requirement never selects a Type II anodize option, and a note
  // never turns a treatment into no finish at all.
  it.each([
    ["Chem film per MIL-DTL-5541 Type II Class 3", ["Chromate", "Chem Film"]],
    ["Type II black anodize (no finish)", ["Type II", "Black"]],
    ["Bead blast + Type II black anodize", ["Type II", "Black"]],
    ["Type III hard anodize", ["Type III", "Hard Anodize"]],
    ["none", []],
    [null, []],
    ["Type II black anodize, none on threads", null],
    ["Type II black", null],
    ["black anodize", null],
  ])("maps the requested finish %j to the search terms %j", (finish, terms) => {
    expect(buildFinishSearchTerms(finish)).toEqual(terms);
  });

  // F20: click fallbacks match whole, exact text only. A substring "Edit"
  // matched "Credit" and "Add credit" (payment controls); "Finish" and
  // "Process" are substrings of checkout and payment labels too.
  it("never resolves a click locator to a credit, checkout or payment control", async () => {
    const page = new FictivFixturePage({
      html: "<html><body>"
        + '<button type="button">Credit</button><button type="button">Add credit</button>'
        + '<button type="button">Apply store credit</button><button type="button">Edit payment method</button>'
        + '<a href="">Credit card</a><button type="button"><span>Edit</span></button>'
        + '<button type="button">Finish checkout</button><button type="button">Process payment</button>'
        + '<button type="button">Material certification add-on</button><button type="button">End use declaration</button>'
        + "</body></html>",
      clock: { now: 0 },
    });
    // The fixture's has-text emulation is Playwright's substring match: the
    // old fallbacks would have clicked these.
    expect(await page.locator('button:has-text("Edit")').count()).toBe(5);
    expect(await page.locator('button:has-text("Finish")').count()).toBe(1);
    expect(await page.locator('button:has-text("Process")').count()).toBe(1);
    const clickLocators = [
      ...FICTIV_LOCATORS.configurationDrawerButtons,
      ...FICTIV_LOCATORS.processButtons,
      ...FICTIV_LOCATORS.endUseButtons,
      ...FICTIV_LOCATORS.materialButtons,
      ...FICTIV_LOCATORS.finishButtons,
    ];
    for (const selector of clickLocators) {
      expect(await page.locator(selector).count(), selector).toBe(0);
    }
    expect(clickLocators.filter((selector) => selector.includes(":has-text("))).toEqual([]);
  });

  it("puts Fictiv's own Edit configuration link first among the configuration drawer controls", async () => {
    const page = new FictivFixturePage({
      html: "<html><body><table><tr><td><div><div>CNC</div><span>No finish (As machined)</span>"
        + '<a href="" class="guide-details-table-row-edit-config-drawer" data-test-target="edit-config-link"'
        + ' data-name="edit-config-drawer" data-placement="details-table-row">Edit configuration</a>'
        + '</div></td></tr></table><button type="button">Add credit</button></body></html>',
      clock: { now: 0 },
    });
    const matching: string[] = [];
    for (const selector of FICTIV_LOCATORS.configurationDrawerButtons) {
      if (await page.locator(selector).count()) matching.push(selector);
    }
    expect(matching).toEqual(['a[data-test-target="edit-config-link"]']);
    expect(FICTIV_LOCATORS.configurationDrawerButtons[0]).toBe('a[data-test-target="edit-config-link"]');
  });

  // F16: only Fictiv's own quantity control is read back, and no quantity
  // selector is a generic number input.
  it("keeps the quantity hooks on Fictiv's select-quantity control and off generic number inputs", async () => {
    const quantitySelectors = [
      ...FICTIV_LOCATORS.quantityControls,
      ...FICTIV_LOCATORS.quantityInputs,
      ...FICTIV_LOCATORS.quantityDisplays,
    ];
    for (const selector of quantitySelectors) {
      expect(selector, selector).not.toMatch(/^input\[type="number"\]$/);
      expect(selector, selector).toMatch(/quantity/);
    }
    expect(FICTIV_LOCATORS.quantityControls).toEqual(['input[data-test-target="select-quantity"]']);
    const page = new FictivFixturePage({
      html: "<html><body>"
        + '<div data-test-target="thread-count"><input type="number" value="0"></div>'
        + '<div class="ant-input-number"><div class="ant-input-number-input-wrap">'
        + '<input autocomplete="off" role="spinbutton" aria-valuenow="1" step="1" type="number"'
        + ' data-test-target="select-quantity" class="ant-input-number-input" value="1"></div></div>'
        + "</body></html>",
      clock: { now: 0 },
    });
    expect(await page.locator(FICTIV_LOCATORS.quantityControls[0]).count()).toBe(1);
    expect(await page.locator(FICTIV_LOCATORS.quantityControls[0]).getAttribute("aria-valuenow")).toBe("1");
    // Neither the other quantity inputs nor the displays resolve to the
    // control or to the thread count.
    for (const selector of [...FICTIV_LOCATORS.quantityInputs, ...FICTIV_LOCATORS.quantityDisplays]) {
      expect(await page.locator(selector).count(), selector).toBe(0);
    }
  });

  // OVD-1052 round 8 (H1, H4): the settle is anchored on the run's last
  // configuration action. Polls after it are fed through the same state
  // machine the adapter runs (advanceFictivSettle), as timelines.
  describe("the settle after the last configuration action (OVD-1052 round 8, H1 and H4)", () => {
    const OLD = "Total USD $398.10";
    const NEW = "Total USD $412.30";
    const poll = (priceText: string | null, overrides: Partial<FictivSettlePoll> = {}): FictivSettlePoll => ({
      repriceIndicator: null,
      pricePanelRepriceIndicator: null,
      priceText,
      ready: true,
      stateKey: "quantity 5/5",
      ...overrides,
    });
    const PANEL_SPIN = { repriceIndicator: ".ant-spin-spinning", pricePanelRepriceIndicator: ".ant-spin-spinning" };
    const PAGE_SPIN = { repriceIndicator: ".ant-spin-spinning", pricePanelRepriceIndicator: null };
    /** Runs the polls after an action that was preceded by `anchor`; returns the poll index it settled at, or null. */
    const settleAt = (anchor: string | null, polls: FictivSettlePoll[]) => {
      let state = startFictivSettle(anchor);
      for (const [index, next] of polls.entries()) {
        state = advanceFictivSettle(state, next);
        if (isFictivSettled(state)) return { index, state };
      }
      return { index: null, state };
    };
    const repeat = (count: number, next: FictivSettlePoll) => Array.from({ length: count }, () => next);

    it("never counts a poll on $ -- or on no price at all, however long it holds (H4)", () => {
      for (const blank of ["$ --", "$--", null, "Please request a quote"]) {
        const { index, state } = settleAt(OLD, repeat(60, poll(blank)));
        expect(index, String(blank)).toBeNull();
        expect(state).toMatchObject({ updatingSignal: "unpriced", heldPolls: 0 });
      }
    });

    it("restarts the count on a $ -- poll between real amounts (H4)", () => {
      // Three polls on the new total, a blank, then four more: it settles on
      // the fourth after the blank, never across it.
      const polls = [...repeat(3, poll(NEW)), poll("$ --"), ...repeat(4, poll(NEW))];
      expect(settleAt(OLD, polls).index).toBe(7);
      expect(settleAt(OLD, polls.slice(0, 7)).index).toBeNull();
    });

    it("never settles on the old total held after the last action with no updating signal (the reviewer's repro)", () => {
      // 600 ms polls: 398.10 for 3 s after the Prototype click, quantity
      // already confirmed, then 412.30.
      const { index, state } = settleAt(OLD, [...repeat(5, poll(OLD)), ...repeat(4, poll(NEW))]);
      expect(index).toBe(8);
      expect(state).toMatchObject({ updatingSignal: "price_changed", heldKey: JSON.stringify([NEW, "quantity 5/5"]) });
      expect(settleAt(OLD, repeat(60, poll(OLD))).index).toBeNull();
    });

    it("settles on a total that changed after an action taken on an unpriced quote", () => {
      expect(settleAt("$ --", repeat(4, poll(OLD))).index).toBe(3);
      expect(settleAt(null, repeat(4, poll(OLD))).index).toBe(3);
    });

    it("re-confirms the same total only after a price panel spinner or a blank, and then only after the full settle", () => {
      expect(settleAt(OLD, [poll(OLD), poll(OLD, PANEL_SPIN), ...repeat(4, poll(OLD))]))
        .toMatchObject({ index: 5, state: { updatingSignal: "price_panel_reprice_indicator" } });
      expect(settleAt(OLD, [poll(OLD), poll("$ --"), ...repeat(3, poll(OLD))]).index).toBeNull();
      expect(settleAt(OLD, [poll(OLD), poll("$ --"), ...repeat(4, poll(OLD))]).index).toBe(5);
    });

    it("never takes a spinner outside the price and summary panels as re-confirming the same total", () => {
      const { index, state } = settleAt(OLD, [poll(OLD), ...repeat(3, poll(OLD, PAGE_SPIN)), ...repeat(40, poll(OLD))]);
      expect(index).toBeNull();
      expect(state.updatingSignal).toBeNull();
    });

    it("counts no poll under any reprice indicator, nor one that is not ready or reads another state", () => {
      const ready = [...repeat(3, poll(NEW)), poll(NEW, PAGE_SPIN), ...repeat(3, poll(NEW))];
      expect(settleAt(OLD, ready).index).toBeNull();
      expect(settleAt(OLD, [...ready, poll(NEW)]).index).toBe(7);
      expect(settleAt(OLD, [...repeat(3, poll(NEW)), poll(NEW, { ready: false }), ...repeat(3, poll(NEW))]).index).toBeNull();
      expect(settleAt(OLD, [...repeat(3, poll(NEW)), poll(NEW, { stateKey: "quantity 1/5" }), ...repeat(3, poll(NEW))]).index).toBeNull();
    });
  });

  // OVD-1052 round 8 (H2): every click, key press and fill goes through one
  // guard that reads the target and refuses a forbidden control, whatever
  // selector resolved to it.
  describe("the action guard (OVD-1052 round 8, H2)", () => {
    const FORBIDDEN_CONTROLS = [
      "Checkout", "Check out", "Place order", "Order now", "Pay now", "Payment method", "Add credit",
      "Purchase", "Buy now", "Add to cart", "Request quote", "Request a quote", "Submit order",
    ];
    const slug = (label: string) => label.toLowerCase().replaceAll(" ", "-");
    const camel = (label: string) => label.replace(/ (\w)/g, (_match, letter: string) => letter.toUpperCase());
    const FIELDS: Array<{ field: string; markup: (label: string) => string }> = [
      { field: "text", markup: (label) => `<button type="button" id="target">${label}</button>` },
      { field: "text", markup: (label) => `<button type="button" id="target"><span>${label.split(" ")[0]}</span>\n<span>${label.split(" ").slice(1).join(" ")}</span></button>` },
      { field: "aria-label", markup: (label) => `<button type="button" id="target" aria-label="${label}"><span class="anticon"></span></button>` },
      { field: "title", markup: (label) => `<span role="button" id="target" title="${label}"></span>` },
      { field: "value", markup: (label) => `<input type="submit" id="target" value="${label}">` },
      { field: "href", markup: (label) => `<a id="target" href="/pages/${slug(label)}">Continue</a>` },
      { field: "data-test-target", markup: (label) => `<button type="button" id="target" data-test-target="quote-${slug(label)}-button">Continue</button>` },
      { field: "data-test-target", markup: (label) => `<button type="button" id="target" data-test-target="${camel(label)}">Continue</button>` },
    ];
    const guardPage = (body: string) => new FictivFixturePage({ html: `<html><body>${body}</body></html>`, clock: { now: 0 } });
    const clickTarget = (page: FictivFixturePage, action = "test_action") =>
      clickFictivControl(page as unknown as Page, page.locator("#target") as unknown as Locator, action);

    it("names every forbidden control in its pattern", () => {
      for (const label of FORBIDDEN_CONTROLS) expect(FICTIV_FORBIDDEN_CLICK_TARGET.test(label), label).toBe(true);
    });

    for (const label of FORBIDDEN_CONTROLS) {
      it.each(FIELDS)(`never clicks "${label}" named in its $field`, async ({ field, markup }) => {
        const page = guardPage(markup(label));
        const error = await clickTarget(page).then(() => null, (refusal: unknown) => refusal);

        expect(error).toBeInstanceOf(VendorAutomationError);
        expect(error).toMatchObject({
          code: "unexpected_ui_state",
          payload: { terminalState: "selector_drift", reason: "unsafe_click", action: "test_action", actionKind: "click", matchedField: field },
        });
        expect(evaluateProviderAdapterFailureContract(error as VendorAutomationError))
          .toMatchObject({ ok: true, terminalState: "selector_drift" });
        expect(page.events).toEqual([]);
      });
    }

    it.each([
      '<a id="target" href="" data-test-target="edit-config-link">Edit configuration</a>',
      '<button type="button" id="target" class="guide-auto-config-loading-modal-auto-config-loading-modal-continue">Continue</button>',
      '<button type="button" id="target" aria-label="Close" class="ant-modal-close"><span class="ant-modal-close-x"></span></button>',
      '<label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" id="target" class="ant-radio-input" data-test-target="quote-classification-selection-import-classification-radio-button-prototype" value="fixture-prototype"></span><span>Prototype</span></label>',
      '<label id="target" class="ant-radio-wrapper"><span>CNC Machining</span><ul><li>Mill | Lathe | EDM | Gear Hobbing | 3-axis | 5-axis</li></ul></label>',
      '<div role="option" id="target" title="6061-T6 Aluminum">6061-T6 Aluminum</div>',
    ])("still clicks the controls the adapter means to: %s", async (markup) => {
      const page = guardPage(markup);
      await clickTarget(page);
      expect(page.events.map((event) => event.kind)).toEqual(["click"]);
    });

    it("leaves no substring aria-label or data-test-target match among the click, press and fill hooks", () => {
      const actionHooks = [
        ...FICTIV_LOCATORS.processButtons,
        ...FICTIV_LOCATORS.processOptions,
        ...FICTIV_LOCATORS.endUseButtons,
        ...FICTIV_LOCATORS.endUseOptions,
        ...FICTIV_LOCATORS.configurationDrawerButtons,
        ...FICTIV_LOCATORS.materialButtons,
        ...FICTIV_LOCATORS.materialOptions,
        ...FICTIV_LOCATORS.finishButtons,
        ...FICTIV_LOCATORS.finishOptions,
        ...FICTIV_LOCATORS.quantityControls,
        ...FICTIV_LOCATORS.quantityInputs,
        ...FICTIV_LOCATORS.modalCloseButtons,
        ...FICTIV_LOCATORS.autoConfigModalContinue,
        ...FICTIV_LOCATORS.autoConfigModalHideCheckbox,
      ];
      expect(actionHooks.filter((selector) => /\[(?:aria-label|data-test-target|name|id)\s*[*^$~|]=/.test(selector))).toEqual([]);
    });

    it("keeps the guard on every action path: no raw click, press or fill outside it", async () => {
      const source = await fs.readFile(fileURLToPath(new URL("./fictiv.ts", import.meta.url)), "utf8");
      const raw = [...source.matchAll(/\.(click|press|fill|dblclick|tap|check|selectOption|dispatchEvent)\(/g)]
        .map((match) => source.slice(source.lastIndexOf("\n", match.index) + 1, source.indexOf("\n", match.index)).trim());
      expect(raw).toEqual(["await locator.click(options);", "await locator.fill(value);", "await locator.press(key);"]);
    });
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
      repricesAfterConfiguration: true,
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
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 1,000" },
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
        [PAGE_QUOTE_LINK]: {
          count: 1,
          href: "/quotes/another-quote",
        },
        ...pricedConfiguration(),
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
    // F13: the created quote's URL, never a quote link found on the page.
    expect(result.quoteUrl).toBe(CREATED_QUOTE_URL);
    expect(result.offers?.map((offer) => offer.quoteUrl)).toEqual([CREATED_QUOTE_URL, CREATED_QUOTE_URL, CREATED_QUOTE_URL]);
    expect(result.rawPayload).toMatchObject({
      detectedFlow: "instant_quote",
      uploadSelector: FICTIV_LOCATORS.uploadInputs[1],
      url: CREATED_QUOTE_URL,
      // F12: what the priced quote page shows, not what the adapter clicked.
      selectedProcess: "CNC",
      selectedMaterial: "6061 Aluminum (T6)",
      selectedFinish: "Anodize Type II Black",
      materialOptionChosen: "6061",
      finishOptionChosen: "Type II",
      configurationReadback: {
        source: "priced_quote_page",
        selector: FICTIV_LOCATORS.partConfigurationSummaries[0],
        summaryCount: 1,
        lineCount: 3,
        process: "CNC",
        material: "6061 Aluminum (T6)",
        finish: "Anodize Type II Black",
        quantities: [1000],
        quantitySelector: FICTIV_LOCATORS.quantityDisplays[0],
      },
      selectedEndUse: "Prototype",
      selectedEndUseSource: "selector",
      openedConfigurationDrawer: true,
      resultClassification: "instant_quote",
      priceSource: "selector",
      priceCurrency: "USD",
      leadTimeSource: "selector",
      quantityReadbackSource: "display",
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
        ...pricedConfiguration(),
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
    expect(result.quoteUrl).toBe(CREATED_QUOTE_URL);
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
      repricesAfterConfiguration: true,
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "Active quotes Total price USD $120.00 Lead time 5 business days"],
      selectorBehaviors: {
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
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
        ...pricedConfiguration(),
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
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "Active quotes Total price USD $90.00 Lead time 5 business days"],
      selectorBehaviors: {
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
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
      payload: { terminalState: "selector_drift", reason: "price_currency_unverified" },
    });
  });

  // OVD-1053 round 5 (F13): before, the first a[href*="/quotes/"] on the page
  // was published as the quote URL. Now only the created quote's URL is.
  it.each([
    ["an off-origin quote link", "https://untrusted.invalid/quotes/other"],
    ["a link to another Fictiv quote", "/pages/quotes/another-quote"],
  ])("publishes the created quote's URL, never %s found on the page", async (_label, href) => {
    const page = createFakePage({
      repricesAfterConfiguration: true,
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "Active quotes Total price USD $120.00 Lead time 5 business days"],
      selectorBehaviors: {
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
        [FICTIV_LOCATORS.endUseButtons[0]]: { count: 1, text: "Prototype" },
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
        [FICTIV_LOCATORS.materialButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.finishButtons[0]]: { count: 1, click: vi.fn() },
        [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "Total USD $120.00" },
        [FICTIV_LOCATORS.leadTimeText[0]]: { count: 1, text: "5 business days" },
        [FICTIV_LOCATORS.leadTimeOptionTargets[0].selector]: { count: 1, text: "Domestic fastest 3 days Total USD $150.00" },
        [PAGE_QUOTE_LINK]: { count: 1, href },
        ...pricedConfiguration(),
      },
      optionTexts: ["CNC", "6061", "Type II", "Prototype"],
    });
    launchMock.mockResolvedValue(createFakeBrowser(page));
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerTempDir: await makeTempDir() }));
    const result = await adapter.quote(makeInput());
    expect(result).toMatchObject({
      status: "instant_quote_received",
      totalPriceUsd: 120,
      quoteUrl: CREATED_QUOTE_URL,
      rawPayload: { url: CREATED_QUOTE_URL },
    });
    expect(result.offers?.map((offer) => [offer.providerOptionId, offer.quoteUrl])).toEqual([
      ["selected-option", CREATED_QUOTE_URL],
      ["domestic:fastest", CREATED_QUOTE_URL],
    ]);
  });

  it("rejects a selected dollar amount without verified USD currency as a finite failure", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "Active quotes Total price $88.00 Lead time 4 business days"],
      selectorBehaviors: {
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
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
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "Complete configuration to continue. Select material to price this part."],
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
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
      repricesAfterConfiguration: true,
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
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
        [FICTIV_LOCATORS.priceText[0]]: {
          count: 1,
          text: "Total USD $88.00",
        },
        [FICTIV_LOCATORS.leadTimeText[0]]: {
          count: 1,
          text: "4 business days",
        },
        ...pricedConfiguration(),
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
      // Read back from the priced page (pricedConfiguration), not the process button.
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
          ...pricedConfiguration(),
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
        bodyTextSequence: [FRESH_UPLOAD_PAGE, "Active quotes Total price USD $88.00 Lead time 4 business days"],
        selectorBehaviors: {
          [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: vi.fn() },
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
      // The click checks the CNC card; the quote page that replaces the upload
      // page after the upload shows no checked process card.
      let cncChecked = false;
      const radio = vi.fn(() => { cncChecked = true; });
      const page = flowPage({ upload: () => { cncChecked = false; } }, {
        [FICTIV_LOCATORS.configurationDrawerButtons[0]]: { count: 1, click: vi.fn(() => { state.engaged = true; }) },
        [FICTIV_LOCATORS.processRadioCards[0]]: { count: 1, text: "CNC Machining", click: radio },
        [FICTIV_LOCATORS.selectedProcessRadios[0]]: { count: () => (cncChecked ? 1 : 0), text: "CNC Machining" },
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

  // OVD-1053 round 4 (F7): a landing page that already showed a quote skipped
  // the upload, was configured, and its price was published with no process
  // check. Now nothing is uploaded, clicked, typed or priced on such a page.
  it.each([
    {
      label: "a priced quote on the upload URL",
      redirectUrl: undefined,
      bodyText: "Active quotes Total price USD $120.00 Lead time 5 business days",
      portalState: "quote_ready",
      onUploadPage: true,
    },
    {
      // No price text and a part row reading CNC: before round 4 the process
      // check passed and the files went into this quote's Add parts input.
      label: "an existing quote page whose part row reads CNC and offers Add parts",
      redirectUrl: "https://app.fictiv.com/pages/quotes/existing-quote",
      bodyText: "Part 1 CNC Machining Add parts",
      portalState: "unknown",
      onUploadPage: false,
    },
  ])("never uploads, configures or prices $label", async ({ redirectUrl, bodyText, portalState, onUploadPage }) => {
    const workerTempDir = await makeTempDir();
    const upload = vi.fn();
    const fillQuantity = vi.fn();
    const clicks = vi.fn();
    const page = createFakePage({
      redirectUrl,
      bodyText,
      selectorBehaviors: {
        [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: upload },
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC Machining", click: clicks },
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: fillQuantity, press: vi.fn() },
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
        [FICTIV_LOCATORS.materialButtons[0]]: { count: 1, click: clicks },
        [FICTIV_LOCATORS.endUseButtons[0]]: { count: 1, text: "Commercial", click: clicks },
        [FICTIV_LOCATORS.priceText[0]]: { count: 1, text: "Total USD $120.00" },
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
    const phase = createProviderMutationPhase();

    const failure = await runInProviderMutationPhase(phase, () => adapter.quote(makeInput()))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VendorAutomationError);
    expect(failure).toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        terminalState: "selector_drift",
        reason: "upload_surface_not_fresh",
        stage: "before_process_selection",
        onUploadPage,
        portalState,
      },
    });
    expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
    expect((failure as VendorAutomationError).artifacts.map((artifact) => artifact.label))
      .toEqual(["landing-dom", "upload-surface-not-fresh-dom"]);
    expect(upload).not.toHaveBeenCalled();
    expect(fillQuantity).not.toHaveBeenCalled();
    expect(clicks).not.toHaveBeenCalled();
    expect(phase.started).toBe(false);
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
    let cncSelected = false;
    const page = createFakePage({
      repricesAfterConfiguration: true,
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "Active quotes Total price USD $88.00 Lead time 4 business days"],
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: {
          count: 1,
          text: () => (cncSelected ? "CNC" : "Process"),
          click: vi.fn(() => {
            cncSelected = true;
          }),
        },
        [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
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
        [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
        [FICTIV_LOCATORS.priceText[0]]: {
          count: 1,
          text: "Total USD $88.00",
        },
        [FICTIV_LOCATORS.leadTimeText[0]]: {
          count: 1,
          text: "4 business days",
        },
        ...pricedConfiguration(),
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
        repricesAfterConfiguration: true,
        bodyTextSequence,
        selectorBehaviors: {
          [FICTIV_LOCATORS.selectedProcessRadios[0]]: { count: 1, text: "CNC Machining" },
          [FICTIV_LOCATORS.uploadInputs[0]]: { count: 1, setInputFiles: uploadSpy },
          [FICTIV_LOCATORS.quantityInputs[0]]: { count: 1, fill: vi.fn(), press: vi.fn() },
          [FICTIV_LOCATORS.quantityDisplays[0]]: { count: 1, text: "Qty 2" },
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
          ...pricedConfiguration(),
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
    // Modeled, not observed: where the quote page shows the part quantity. The
    // scenario fills this slot with an editable input (the default), a
    // read-only quantity, or nothing.
    const QUANTITY_SLOT = "<!--fixture-quantity-->";
    const quotePage = (main: string) => `<html><body><main>${main}${QUANTITY_SLOT}${GUARD_BUTTONS}</main></body></html>`;
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
    const pricedSelection = (total = "$412.30") =>
      '<div data-test-target="quote-level-lead-time-selected-option">Fastest<br>4 production days (USA or Mexico)</div>'
      + `<div data-test-target="quote-level-lead-time-price-selected">Total USD ${total}</div>`;
    const PRICED_SELECTION = pricedSelection();
    // OVD-1053 round 5: the part table of a priced quote, modeled on the
    // structure of the 2026-10-23 live quote page (labels synthetic). The
    // configuration cell lists process, material and finish, one per line,
    // then Fictiv's Edit configuration link; the run's requirement below is
    // CNC, 6061-T6 aluminum, as machined.
    type PartConfiguration = { process: string; material: string; finish: string };
    const REQUESTED_CONFIGURATION: PartConfiguration = {
      process: "CNC",
      material: "6061-T6 Aluminum",
      finish: "No finish (As machined)",
    };
    const configurationCell = ({ process, material, finish }: PartConfiguration) =>
      `<td class="ant-table-cell"><div><div><div>${process}</div><div><span>${material}</span></div></div>`
      + `<span>${finish}</span><a href="" data-test-target="edit-config-link">Edit configuration</a></div></td>`;
    const partTable = (...cells: string[]) =>
      '<table class="ant-table"><tbody class="ant-table-tbody">'
      + cells.map((cell) => `<tr class="ant-table-row fileRow"><td class="ant-table-cell"><a href="">synthetic-part.step</a></td>${cell}</tr>`).join("")
      + "</tbody></table>";
    const pricedPage = (options: { total?: string; parts?: string; extra?: string; selection?: string } = {}) => quotePage(
      `<div>Select regional preference</div><div>Prototype</div>${options.selection ?? pricedSelection(options.total)}`
      + `${options.parts ?? partTable(configurationCell(REQUESTED_CONFIGURATION))}${options.extra ?? ""}`,
    );
    const PRICED_PAGE = pricedPage();
    const UNRECOGNIZED_PAGE = quotePage("<div>synthetic-part.step</div>");
    // Modeled, not observed: a priced quote page as a landing page. Its
    // Prototype / Commercial classification radios are Ant Design radio cards,
    // just like the process cards on the upload page.
    const classificationRadios = (extraCard = "") =>
      '<div class="ant-radio-group">'
      + '<label class="ant-radio-wrapper ant-radio-wrapper-checked" data-test-target="quote-classification-selection-import-classification-radio-button-prototype">'
      + '<span class="ant-radio ant-radio-checked"><input type="radio" class="ant-radio-input" value="fixture-prototype" checked></span><span>Prototype</span></label>'
      + '<label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input" value="fixture-commercial"></span>'
      + `<span>Commercial</span>${extraCard}</label>`
      + "</div>";
    const PRICED_LANDING_PAGE = quotePage(`${classificationRadios()}${PRICED_SELECTION}`);
    // The same page with both step titles repeated (no process card hook) ...
    const PRICED_LANDING_WITH_STEP_TITLES = quotePage(
      `<div>Select a process</div><div>Upload your files</div>${classificationRadios()}${PRICED_SELECTION}`,
    );
    // ... and with a process hook inside a radio card (no step titles).
    const PRICED_LANDING_WITH_PROCESS_HOOK = quotePage(
      `${classificationRadios('<span role="img" aria-label="lock" data-test-target="process-lock-icon"></span>')}${PRICED_SELECTION}`,
    );
    // ... and with that hook next to only one of the two step titles.
    const PRICED_LANDING_WITH_ONE_TITLE_AND_HOOK = quotePage(
      `<div>Select a process</div>${classificationRadios('<span role="img" aria-label="lock" data-test-target="process-lock-icon"></span>')}${PRICED_SELECTION}`,
    );
    // Modeled, not observed (OVD-1053 round 4): an existing, priced quote as
    // the landing page, with Prototype / Commercial radio cards, the
    // part-quantity input (quantity slot), an "Add parts" file input and a
    // Total USD price.
    const ADD_PARTS = '<button type="button">Add parts</button><input type="file" multiple style="display: none">';
    const PRICED_EXISTING_QUOTE = quotePage(`${classificationRadios()}${ADD_PARTS}${PRICED_SELECTION}`);
    const EXISTING_QUOTE_URL = "https://app.fictiv.com/pages/quotes/existing-quote";
    type QuantityControl =
      | "input"
      | "display"
      | "thread_count"
      | "none"
      | "select_quantity"
      | "select_quantity_and_display"
      | "select_quantity_and_thread_count";
    // Modeled, not observed: Fictiv's own quantity summary, reading the
    // quantity Fictiv holds (its default until a re-render keeps a typed value).
    const quantitySummary = (quantity: string) => `<div data-test-target="quote-summary-quantity">Qty ${quantity}</div>`;
    // OVD-1053 round 6 (F16): hand-built on the structure of the live quote
    // page's only quantity control (2026-10-23): an Ant Design number input
    // with Fictiv's select-quantity hook. `value` is the text in the box;
    // aria-valuenow is the quantity the control holds. A typed value Fictiv did
    // not take stays in the box while aria-valuenow keeps Fictiv's quantity.
    const liveQuantityControl = (boxText: string, held: string | null) =>
      '<div class="ant-input-number"><div class="ant-input-number-handler-wrap">'
      + '<span unselectable="on" role="button" aria-label="Increase Value" aria-disabled="false" class="ant-input-number-handler ant-input-number-handler-up"></span>'
      + '<span unselectable="on" role="button" aria-label="Decrease Value" aria-disabled="false" class="ant-input-number-handler ant-input-number-handler-down"></span>'
      + '</div><div class="ant-input-number-input-wrap">'
      + `<input autocomplete="off" role="spinbutton"${held === null ? "" : ` aria-valuenow="${held}"`} step="1" type="number" data-test-target="select-quantity" class="ant-input-number-input" value="${boxText}">`
      + "</div></div>";
    const THREAD_COUNT = '<div data-test-target="thread-count"><label>Threads</label><input type="number" value="0"></div>';
    type QuantityRender = { held: string; boxText: string; summary: string; valueNow: string | null };
    const QUANTITY_CONTROLS: Record<QuantityControl, (render: QuantityRender) => string> = {
      // The labeled wrapper matches the display hook too; it holds the typed
      // input, so it must never be read back as Fictiv's display.
      input: ({ held, summary }) =>
        `<div data-test-target="part-quantity"><label>Quantity</label><input type="number" value="${held}"></div>${summary}`,
      display: ({ summary }) => summary,
      // A numeric field that is not the quantity: no quantity hook at all.
      thread_count: ({ summary }) => `${THREAD_COUNT}${summary}`,
      none: () => "",
      // The live page: Fictiv's quantity control and no quantity display.
      select_quantity: ({ boxText, valueNow }) => liveQuantityControl(boxText, valueNow),
      select_quantity_and_display: ({ boxText, valueNow, summary }) => `${liveQuantityControl(boxText, valueNow)}${summary}`,
      select_quantity_and_thread_count: ({ boxText, valueNow }) => `${THREAD_COUNT}${liveQuantityControl(boxText, valueNow)}`,
    };
    const quantityMarkup = (control: QuantityControl, held: string, options: Partial<QuantityRender> = {}) =>
      QUANTITY_CONTROLS[control]({
        held,
        boxText: held,
        summary: quantitySummary(held),
        valueNow: held,
        ...options,
      });
    // OVD-1053 round 6 (F19): a lead-time panel hand-built on the structure of
    // the live quote page (2026-10-23): one list item per option with
    // Fictiv's per-option hook, the selected one carrying the selected-option
    // hook instead, each an Ant Design radio card. Live prices read "$ --"
    // before pricing; the priced text here is modeled.
    type LeadTimeKey =
      | "domesticFastest" | "domesticStandard" | "domesticCostEffective"
      | "overseasFastest" | "overseasStandard" | "overseasCostEffective";
    type LeadTimeFixtureOption = {
      key: LeadTimeKey;
      days: string;
      price: string;
      tier: string;
      selected?: boolean;
      unavailable?: "aria" | "antd" | "input" | "text";
    };
    const leadTimeItem = ({ key, days, price, tier, selected, unavailable }: LeadTimeFixtureOption) =>
      `<li data-test-target="${selected ? "quote-level-lead-time-selected-option" : `quote-level-lead-time-${key}`}"`
      + ` data-name="quote-level-lead-time-${key}" class="ant-list-item"${unavailable === "aria" ? ' aria-disabled="true"' : ""}>`
      + `<label class="ant-radio-wrapper${selected ? " ant-radio-wrapper-checked" : ""}${unavailable === "antd" ? " ant-radio-wrapper-disabled" : ""}">`
      + `<span class="ant-radio${selected ? " ant-radio-checked" : ""}${unavailable === "antd" ? " ant-radio-disabled" : ""}">`
      + `<input type="radio" class="ant-radio-input" value="fixture-${key}"${selected ? " checked" : ""}${unavailable === "input" ? " disabled" : ""}></span>`
      + `<span><span>${days}</span><span data-test-target="quote-level-lead-time-price">${price}</span><span>${tier}</span>`
      + `${unavailable === "text" ? "<span>Unavailable</span>" : ""}</span></label></li>`;
    const leadTimePanel = (options: LeadTimeFixtureOption[], selectedTotal = "$412.30") =>
      `<ul>${options.map(leadTimeItem).join("")}</ul>`
      + `<div data-test-target="quote-level-lead-time-price-selected">Total USD ${selectedTotal}</div>`;
    const DOMESTIC_FASTEST: LeadTimeFixtureOption = {
      key: "domesticFastest",
      days: "4 production days (USA or Mexico)",
      price: "Total USD $412.30",
      tier: "Fastest",
      selected: true,
    };
    const DOMESTIC_STANDARD: LeadTimeFixtureOption = {
      key: "domesticStandard",
      days: "6 production days (USA or Mexico)",
      price: "Total USD $398.10",
      tier: "Standard",
    };
    const OVERSEAS_STANDARD: LeadTimeFixtureOption = {
      key: "overseasStandard",
      days: "9 production days",
      price: "Total USD $301.25",
      tier: "Standard",
    };

    type Scenario = {
      /** Simulated live cost of one poll beyond its 500 ms wait. */
      pollOverheadMs?: number;
      uploadingMs?: number;
      analyzingMs?: number;
      /** Show the prompt this long after analysis while auto configuration is still pending. */
      autoConfiguringMs?: number;
      /** Reprice this long after the adapter's first configuration click; null never reprices. */
      repriceAfterMs?: number | null;
      /**
       * Which configuration click starts the reprice (default: the first).
       * Live, the quote is priced only after the Prototype classification click.
       */
      repriceOnClick?: (target: string) => boolean;
      /** The quote page Fictiv shows once Enter is pressed in the quantity control, with the typed quantity taken. */
      pageOnEnter?: string;
      /** The page Fictiv shows once analysis ends. */
      afterAnalysisPage?: string;
      failFirstCncClick?: boolean;
      /** The page navigation lands on instead of the process-first upload page. */
      landingPage?: string;
      /** The URL that landing page shows (default: the upload URL navigated to). */
      landingUrl?: string;
      /** A process card (data-fixture-process) already checked on landing, with its dropzone shown. */
      preselectedProcess?: string;
      /** False: the CNC card click resolves but the card is not checked. */
      cncClickTakes?: boolean;
      /** A broken render: this card stays checked next to CNC after the CNC click. */
      alsoCheckedProcess?: string;
      /** False: the quote created from the upload opens without leaving the upload URL. */
      opensCreatedQuote?: boolean;
      /** The URL the repriced quote shows (default: the created quote's). */
      repricedUrl?: string;
      /** The priced page the reprice lands on (default PRICED_PAGE). */
      pricedPage?: string;
      /** Pages Fictiv shows once the reprice lands, before the priced page, each for its time. */
      postRepriceFrames?: Array<{ page: string; ms: number }>;
      /**
       * Changes the page while the adapter waits for the priced selection to
       * extract the price, after the quote settled; no time passes. The second
       * argument re-renders the quote keeping the quantity Fictiv holds.
       */
      atPriceExtraction?: (page: FictivFixturePage, renderQuote: (pageHtml: string) => void) => void;
      /** Changes the upload page as the CNC card is clicked, before the upload. */
      onCncClick?: (page: FictivFixturePage) => void;
      /** The URL the page moves to on the configuration click. */
      configureClickUrl?: string;
      requestedQuantity?: number;
      /** How the quote pages show the quantity (default: an editable input and Fictiv's summary). */
      quantityControl?: QuantityControl;
      /** Fictiv's quantity summary markup for the quantity Fictiv holds (default quantitySummary). */
      summary?: (fictivQuantity: string) => string;
      /** The quantity Fictiv shows before anything is typed (default 1). */
      initialQuantity?: number;
      /** The reprice re-renders the quantity input with Fictiv's default, dropping the typed value. */
      repriceResetsQuantity?: boolean;
      /**
       * Fictiv's quantity control: Fictiv does not take the typed value. The
       * text stays in the box while aria-valuenow keeps Fictiv's quantity.
       */
      controlIgnoresTypedQuantity?: boolean;
      /** Fictiv's quantity control renders without aria-valuenow. */
      controlOmitsValueNow?: boolean;
    };
    type Stage =
      | "loading" | "upload" | "uploading" | "analyzing" | "auto_configuring" | "awaiting" | "repricing" | "settling" | "done";
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
      let postRepriceFrame = 0;
      const requestedQuantity = scenario.requestedQuantity ?? 1;
      /** The quantity Fictiv holds: its default until a typed value survives a re-render. */
      let fictivQuantity = String(scenario.initialQuantity ?? 1);
      /** The text in Fictiv's quantity control when Fictiv did not take it. */
      let controlText: string | null = null;
      const withQuantity = (pageHtml: string) => pageHtml.replace(
        QUANTITY_SLOT,
        quantityMarkup(scenario.quantityControl ?? "input", fictivQuantity, {
          boxText: controlText ?? fictivQuantity,
          summary: (scenario.summary ?? quantitySummary)(fictivQuantity),
          valueNow: scenario.controlOmitsValueNow ? null : fictivQuantity,
        }),
      );
      const renderQuotePage = (fixturePage: FictivFixturePage, pageHtml: string, url?: string) => {
        const typed = fixturePage.document.querySelector<HTMLInputElement>('[data-test-target="part-quantity"] input')?.value;
        if (typed) fictivQuantity = typed;
        const typedInControl = fixturePage.document
          .querySelector<HTMLInputElement>('input[data-test-target="select-quantity"]')?.value;
        if (typedInControl && scenario.controlIgnoresTypedQuantity) controlText = typedInControl;
        else if (typedInControl) fictivQuantity = typedInControl;
        fixturePage.render(withQuantity(pageHtml), url);
      };

      const page = new FictivFixturePage({
        html: LOADING_SHELL,
        url: "about:blank",
        clock,
        pollOverheadMs: scenario.pollOverheadMs ?? 100,
        events,
        onClick(element, fixturePage) {
          const target = describeFixtureElement(element);
          clickLog.push({ target, stage, at: clock.now });
          const card = element.closest("label.ant-radio-wrapper")?.getAttribute("data-fixture-process");
          if (card === "cnc") {
            cncClicks += 1;
            if (scenario.failFirstCncClick && cncClicks === 1) {
              throw new Error("element click intercepted");
            }
            if (scenario.cncClickTakes === false) return false;
          }
          if (stage === "upload" && card) {
            // Choosing a process completes step 1 and shows the upload panel.
            const panel = fixturePage.document.querySelector('[data-fixture-panel="upload"]')!;
            if (!panel.querySelector('input[type="file"]')) fixturePage.showTemplate("dropzone", panel);
            if (card === "cnc") scenario.onCncClick?.(fixturePage);
          }
          if (card === "cnc" && scenario.alsoCheckedProcess) {
            activateRadioCard(element);
            fixturePage.document
              .querySelector(`label.ant-radio-wrapper[data-fixture-process="${scenario.alsoCheckedProcess}"]`)!
              .classList.add("ant-radio-wrapper-checked");
            return false;
          }
          if (stage === "awaiting" && scenario.configureClickUrl) {
            fixturePage.setUrl(scenario.configureClickUrl);
          }
          if (stage === "awaiting" && scenario.repriceAfterMs !== null && (scenario.repriceOnClick?.(target) ?? true)) {
            stage = "repricing";
            stageEndsAt = clock.now + (scenario.repriceAfterMs ?? 6_000);
          }
        },
        onPress(_element, key, fixturePage) {
          if (key === "Enter" && scenario.pageOnEnter) renderQuotePage(fixturePage, scenario.pageOnEnter);
        },
        onWaitFor(label, fixturePage) {
          if (stage === "done" && label.includes("quote-level-lead-time-price-selected")) {
            scenario.atPriceExtraction?.(fixturePage, (pageHtml) => renderQuotePage(fixturePage, pageHtml));
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
            fixturePage.render(scenario.landingPage ? withQuantity(scenario.landingPage) : html, scenario.landingUrl);
            stage = "upload";
            if (scenario.preselectedProcess) {
              activateRadioCard(fixturePage.document.querySelector(
                `label.ant-radio-wrapper[data-fixture-process="${scenario.preselectedProcess}"]`,
              )!);
              fixturePage.showTemplate("dropzone", fixturePage.document.querySelector('[data-fixture-panel="upload"]')!);
            }
          } else if (stage === "uploading" && clock.now >= stageEndsAt) {
            renderQuotePage(fixturePage, ANALYZING_PAGE, scenario.opensCreatedQuote === false ? undefined : QUOTE_URL);
            stage = "analyzing";
            stageEndsAt = clock.now + (scenario.analyzingMs ?? 15_000);
          } else if (stage === "analyzing" && clock.now >= stageEndsAt && scenario.autoConfiguringMs) {
            renderQuotePage(fixturePage, AUTO_CONFIGURING_PAGE);
            stage = "auto_configuring";
            stageEndsAt = clock.now + scenario.autoConfiguringMs;
          } else if (
            (stage === "analyzing" || stage === "auto_configuring") && clock.now >= stageEndsAt
          ) {
            // Auto configuration landing re-renders the quote, dropping anything set meanwhile.
            renderQuotePage(fixturePage, scenario.afterAnalysisPage ?? AWAITING_PAGE);
            stage = "awaiting";
          } else if (stage === "repricing" && clock.now >= stageEndsAt && scenario.postRepriceFrames?.length) {
            renderQuotePage(fixturePage, scenario.postRepriceFrames[0].page);
            postRepriceFrame = 0;
            stage = "settling";
            stageEndsAt = clock.now + scenario.postRepriceFrames[0].ms;
          } else if (stage === "settling" && clock.now >= stageEndsAt) {
            postRepriceFrame += 1;
            const frame = scenario.postRepriceFrames![postRepriceFrame];
            if (frame) {
              renderQuotePage(fixturePage, frame.page);
              stageEndsAt = clock.now + frame.ms;
            } else {
              renderQuotePage(fixturePage, scenario.pricedPage ?? PRICED_PAGE, scenario.repricedUrl);
              stage = "done";
            }
          } else if (stage === "repricing" && clock.now >= stageEndsAt) {
            if (scenario.repriceResetsQuantity) {
              fixturePage.render(PRICED_PAGE.replace(QUANTITY_SLOT, quantityMarkup(scenario.quantityControl ?? "input", "1")));
            } else {
              renderQuotePage(fixturePage, scenario.pricedPage ?? PRICED_PAGE, scenario.repricedUrl);
            }
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
        requestedQuantity,
        stagedDrawingFile,
        part: { ...makeUnauthorizedInput().part, quantity: requestedQuantity },
        requirement: {
          ...makeUnauthorizedInput().requirement,
          material: "6061-T6 aluminum",
          finish: "as machined",
          quantity: requestedQuantity,
          quote_quantities: [requestedQuantity],
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
          url: QUOTE_URL,
          // F12: the priced quote page's own process label; the pre-upload
          // card ("CNC Machining Mill | Lathe") is kept only as upload evidence.
          selectedProcess: "CNC",
          selectedMaterial: "6061-T6 Aluminum",
          selectedFinish: "No finish (As machined)",
          configurationReadback: {
            source: "priced_quote_page",
            summaryCount: 1,
            lineCount: 3,
            process: "CNC",
            material: "6061-T6 Aluminum",
            finish: "No finish (As machined)",
            quantities: [1],
          },
          observedProcessBeforeUpload: "CNC Machining Mill | Lathe",
          // The live dropzone's input lists .step among its accepted types.
          uploadSelector: FICTIV_LOCATORS.uploadInputs[2],
          quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
          quantityReadbackSource: "display",
          quantityReadbackSelector: FICTIV_LOCATORS.quantityDisplays[0],
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

    // Round 2 counted any radio card as the upload surface, so a priced quote
    // page skipped the upload and returned its own price.
    it.each([
      ["a priced quote page with Prototype / Commercial radio cards", PRICED_LANDING_PAGE],
      ["that page repeating both step titles, with no process card hook", PRICED_LANDING_WITH_STEP_TITLES],
      ["that page with a process hook in a radio card, without the step titles", PRICED_LANDING_WITH_PROCESS_HOOK],
      // Both step titles are required next to the hook, not either one.
      ["that page with a process hook in a radio card and only one step title", PRICED_LANDING_WITH_ONE_TITLE_AND_HOOK],
    ])("does not take %s for the upload page", async (_label, landingPage) => {
      const { result, error, events } = await runProcessFirstQuote({ landingPage });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure.message).toBe("Fictiv upload surface did not finish rendering.");
      expect(failure).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift" } });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(events.filter((event) => MUTATIONS.has(event.kind))).toEqual([]);
    });

    // OVD-1053 round 4 (F7) repro: navigation lands on an existing, priced
    // quote. Its Add parts input satisfied the upload surface wait and its
    // price read as quote ready, so the run skipped the upload, configured
    // that quote and published its price with no process check.
    it.each([
      { label: "at its own quote URL", landingUrl: EXISTING_QUOTE_URL, onUploadPage: false },
      { label: "rendered at the upload URL", landingUrl: undefined, onUploadPage: true },
    ])("never uploads into, configures or prices an existing priced quote $label", async ({ landingUrl, onUploadPage }) => {
      const { result, error, events } = await runProcessFirstQuote({ landingPage: PRICED_EXISTING_QUOTE, landingUrl });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "upload_surface_not_fresh",
          stage: "before_process_selection",
          onUploadPage,
          portalState: "quote_ready",
          existingQuoteMarker: FICTIV_LOCATORS.existingQuoteMarkers[0],
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toEqual(["landing-dom", "upload-surface-not-fresh-dom"]);
      expect(events.filter((event) => MUTATIONS.has(event.kind))).toEqual([]);
    });

    it("configures and prices nothing when the upload never opens the quote it created", async () => {
      const { result, error, events } = await runProcessFirstQuote({ opensCreatedQuote: false });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "created_quote_unobserved",
          onUploadPage: true,
          url: FICTIV_URLS.upload,
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label))
        .toEqual(["landing-dom", "uploaded-dom", "created-quote-unobserved-dom"]);
      expect(clicked(events)).toEqual(["process-card:cnc"]);
      expect(events.some((event) => event.kind === "fill")).toBe(false);
    });

    it("publishes no price read from a quote other than the one the upload created", async () => {
      const { result, error } = await runProcessFirstQuote({
        repricedUrl: "https://app.fictiv.com/pages/quotes/another-quote",
      });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "price_page_not_created_quote",
          observedProcessBeforeUpload: "CNC Machining Mill | Lathe",
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("price-provenance-unconfirmed-dom");
    });

    it("never uploads when the CNC card click resolves but 3D Printing stays selected", async () => {
      const { result, error, events, page } = await runProcessFirstQuote({
        preselectedProcess: "printing",
        cncClickTakes: false,
      });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "process_selection_unconfirmed",
          expectedProcess: "CNC Machining",
          observedProcess: "3D Printing",
          observedProcesses: ["3D Printing"],
          processReadbackSource: "process_card",
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(events.some((event) => event.kind === "set_input_files")).toBe(false);
      expect(clicked(events)).toEqual(["process-card:cnc"]);
      expect(page.document.querySelector("label.ant-radio-wrapper-checked")?.getAttribute("data-fixture-process"))
        .toBe("printing");
      expect(failure.artifacts.map((artifact) => artifact.label)).toEqual(["landing-dom", "process-unconfirmed-dom"]);
    });

    it("never uploads when a second process card stays checked next to CNC", async () => {
      const { result, error, events } = await runProcessFirstQuote({ alsoCheckedProcess: "printing" });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      expect(error).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "process_selection_unconfirmed",
          observedProcesses: ["CNC Machining Mill | Lathe", "3D Printing"],
          processReadbackSource: "process_card",
        },
      });
      expect(events.some((event) => event.kind === "set_input_files")).toBe(false);
      expect(clicked(events)).toEqual(["process-card:cnc"]);
    });

    it("never uploads when no process card is checked, even next to a process control reading CNC Machining", async () => {
      const uploadPage = await fixtureHtml();
      const withDropzoneAndControl = uploadPage.replace(
        '<div class="fixture-upload-panel" data-fixture-panel="upload"></div>',
        '<div class="fixture-upload-panel" data-fixture-panel="upload"><input type="file" multiple style="display: none"></div>'
          + '<div data-test-target="process-selection-summary">CNC Machining</div>',
      );
      expect(withDropzoneAndControl).not.toBe(uploadPage);
      const { result, error, events } = await runProcessFirstQuote({
        landingPage: withDropzoneAndControl,
        cncClickTakes: false,
      });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      expect(error).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "process_selection_unconfirmed",
          observedProcesses: [],
          processReadbackSource: "process_card",
        },
      });
      expect(events.some((event) => event.kind === "set_input_files")).toBe(false);
      expect(clicked(events)).toEqual(["process-card:cnc"]);
    });

    /** Another quantity display on the quote page, such as a second part row. */
    const partRowQuantity = (quantity: string) => `<div data-test-target="part-row-quantity">Qty ${quantity}</div>`;
    const summaryReading = (text: string) => `<div data-test-target="quote-summary-quantity">${text}</div>`;

    it.each([
      {
        label: "5 requested and no quantity control",
        scenario: { requestedQuantity: 5, quantityControl: "none" },
        reason: "quantity_input_missing",
        observedQuantities: [],
        quantitySelector: null,
      },
      {
        label: "1 requested and no quantity shown anywhere",
        scenario: { quantityControl: "none" },
        reason: "quantity_input_missing",
        observedQuantities: [],
        quantitySelector: null,
      },
      {
        label: "5 requested, no quantity input and a read-only Qty 5",
        scenario: { requestedQuantity: 5, quantityControl: "display", initialQuantity: 5 },
        reason: "quantity_input_missing",
        observedQuantities: [5],
        quantitySelector: null,
      },
      {
        // Round 3 let this through; the run never set the quantity.
        label: "1 requested, no quantity input and a read-only Qty 1",
        scenario: { quantityControl: "display" },
        reason: "quantity_input_missing",
        observedQuantities: [1],
        quantitySelector: null,
      },
      {
        // F8: a thread count is never typed into as the quantity.
        label: "5 requested on a page whose only number input is a thread count",
        scenario: { requestedQuantity: 5, quantityControl: "thread_count" },
        reason: "quantity_input_missing",
        observedQuantities: [1],
        quantitySelector: null,
      },
      {
        label: "1 requested on a page whose only number input is a thread count, next to Qty 1",
        scenario: { quantityControl: "thread_count" },
        reason: "quantity_input_missing",
        observedQuantities: [1],
        quantitySelector: null,
      },
      {
        label: "5 typed but the reprice re-renders Fictiv's default of 1",
        scenario: { requestedQuantity: 5, repriceResetsQuantity: true },
        reason: "quantity_mismatch",
        observedQuantities: [1],
        quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
      },
      {
        // F8 repro: round 3 read back the typed input (5) and published the
        // price Fictiv still showed for its default quantity.
        label: "5 typed while Fictiv's summary still reads Qty 1",
        scenario: { requestedQuantity: 5, summary: () => quantitySummary("1") },
        reason: "quantity_mismatch",
        observedQuantities: [1],
        quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
      },
      {
        // Every display counts, not only the first.
        label: "Qty 5 in the summary and a second display still reading Qty 1",
        scenario: { requestedQuantity: 5, summary: (quantity: string) => `${quantitySummary(quantity)}${partRowQuantity("1")}` },
        reason: "quantity_mismatch",
        observedQuantities: [5, 1],
        quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
      },
      {
        // A display that is not a quantity confirms nothing.
        label: "Qty 5 in the summary and a second display that is not a quantity",
        scenario: { requestedQuantity: 5, summary: (quantity: string) => `${quantitySummary(quantity)}${partRowQuantity("—")}` },
        reason: "quantity_unconfirmed",
        observedQuantities: [5, null],
        quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
      },
      {
        // The display must read a quantity and nothing else.
        label: "a summary with another label ahead of the quantity",
        scenario: { requestedQuantity: 5, summary: (quantity: string) => summaryReading(`Part 2 · Qty ${quantity}`) },
        reason: "quantity_unconfirmed",
        observedQuantities: [null],
        quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
      },
      {
        label: "a summary with text after the quantity",
        scenario: { requestedQuantity: 5, summary: (quantity: string) => summaryReading(`Qty ${quantity} (min 10)`) },
        reason: "quantity_unconfirmed",
        observedQuantities: [null],
        quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
      },
    ] satisfies Array<{
      label: string;
      scenario: Scenario;
      reason: string;
      observedQuantities: Array<number | null>;
      quantitySelector: string | null;
    }>)("publishes no price or offer with $label", async ({ scenario, reason, observedQuantities, quantitySelector }) => {
      const { result, error, events } = await runProcessFirstQuote(scenario);

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "configuration_required",
          reason,
          requestedQuantity: scenario.requestedQuantity ?? 1,
          observedQuantities,
          quantitySelector,
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({
        ok: true,
        terminalState: "configuration_required",
      });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("quantity-unconfirmed-dom");
      // The run got as far as the priced page: only the quantity stopped it.
      expect(clicked(events)).toEqual(["process-card:cnc", "button:Edit configuration"]);
      // Nothing but a quantity-specific input is ever typed into.
      expect(events.some((event) => event.kind === "fill")).toBe(quantitySelector !== null);
      expectCheckpointBeforeEveryMutation(events);
    });

    it.each([
      { label: "1 requested and Fictiv's summary reads Qty 1", scenario: {}, quantity: 1 },
      { label: "5 requested and Fictiv's summary reads Qty 5 after the reprice", scenario: { requestedQuantity: 5 }, quantity: 5 },
      {
        // A hidden, stale summary is not what Fictiv shows.
        label: "5 requested with a hidden, stale Qty 1 summary next to the visible Qty 5",
        scenario: {
          requestedQuantity: 5,
          summary: (quantity: string) => `${quantitySummary(quantity)}<div data-test-target="quote-summary-quantity" hidden>Qty 1</div>`,
        },
        quantity: 5,
      },
    ] satisfies Array<{ label: string; scenario: Scenario; quantity: number }>)(
      "prices the quote once Fictiv's own display reads the requested quantity: $label",
      async ({ scenario, quantity }) => {
        const { result, error, events } = await runProcessFirstQuote(scenario);

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 412.3,
          rawPayload: {
            quantitySelector: FICTIV_LOCATORS.quantityInputs[0],
            quantityReadbackSource: "display",
            quantityReadbackSelector: FICTIV_LOCATORS.quantityDisplays[0],
          },
        });
        expect(result!.offers).toEqual([expect.objectContaining({ quantity, totalPriceUsd: 412.3 })]);
        expect(events.filter((event) => event.kind === "fill")).toEqual([{ kind: "fill", detail: String(quantity) }]);
      },
    );

    // OVD-1053 round 5 (F11): before any price is published, the priced quote
    // page itself must show CNC, the requested material and the requested
    // finish. Nothing the adapter clicked or chose counts.
    const cellWithLines = (...lines: string[]) =>
      `<td class="ant-table-cell"><div>${lines.map((line) => `<div>${line}</div>`).join("")}`
      + '<a href="" data-test-target="edit-config-link">Edit configuration</a></div></td>';
    it.each([
      {
        label: "3D Printing as the process",
        parts: partTable(configurationCell({ ...REQUESTED_CONFIGURATION, process: "3D Printing" })),
        mismatchedFields: ["process"],
        readback: { process: "3D Printing", material: "6061-T6 Aluminum", finish: "No finish (As machined)" },
      },
      {
        label: "7075 aluminum as the material",
        parts: partTable(configurationCell({ ...REQUESTED_CONFIGURATION, material: "7075-T6 Aluminum" })),
        mismatchedFields: ["material"],
        readback: { process: "CNC", material: "7075-T6 Aluminum", finish: "No finish (As machined)" },
      },
      {
        label: "two materials on the material line",
        parts: partTable(configurationCell({ ...REQUESTED_CONFIGURATION, material: "6061-T6 / 7075-T6 Aluminum" })),
        mismatchedFields: ["material"],
        readback: { material: "6061-T6 / 7075-T6 Aluminum" },
      },
      {
        label: "an anodized finish where as machined was requested",
        parts: partTable(configurationCell({ ...REQUESTED_CONFIGURATION, finish: "Anodize Type II Black" })),
        mismatchedFields: ["finish"],
        readback: { finish: "Anodize Type II Black" },
      },
      {
        label: "another process, material and finish",
        parts: partTable(configurationCell({ process: "Sheet Metal", material: "5052 Aluminum", finish: "Powder Coat" })),
        mismatchedFields: ["process", "material", "finish"],
        readback: { process: "Sheet Metal", material: "5052 Aluminum", finish: "Powder Coat" },
      },
    ])("publishes no price or offer when the priced quote shows $label", async ({ parts, mismatchedFields, readback }) => {
      const { result, error, events } = await runProcessFirstQuote({ pricedPage: pricedPage({ parts }) });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "configuration_required",
          reason: "configuration_readback_mismatch",
          mismatchedFields,
          url: QUOTE_URL,
          configurationReadback: { source: "priced_quote_page", summaryCount: 1, lineCount: 3, ...readback },
        },
      });
      expect(failure.payload).not.toHaveProperty("totalPriceUsd");
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "configuration_required" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("configuration-readback-mismatch-dom");
      expect(clicked(events)).toEqual(["process-card:cnc", "button:Edit configuration"]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it.each([
      { label: "no part configuration at all", parts: "", summaryCount: 0, lineCount: null },
      {
        label: "a second part row",
        parts: partTable(configurationCell(REQUESTED_CONFIGURATION), configurationCell(REQUESTED_CONFIGURATION)),
        summaryCount: 2,
        lineCount: null,
      },
      { label: "no finish line", parts: partTable(cellWithLines("CNC", "6061-T6 Aluminum")), summaryCount: 1, lineCount: 2 },
      {
        label: "an extra configuration line",
        parts: partTable(cellWithLines("CNC", "6061-T6 Aluminum", "No finish (As machined)", "Inspection: Standard")),
        summaryCount: 1,
        lineCount: 4,
      },
    ])("publishes no price or offer when the priced quote shows $label", async ({ parts, summaryCount, lineCount }) => {
      const { result, error } = await runProcessFirstQuote({ pricedPage: pricedPage({ parts }) });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "configuration_readback_unreadable",
          // Unreadable keeps counts only, no page text.
          configurationReadback: { summaryCount, lineCount, process: null, material: null, finish: null },
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("configuration-readback-unreadable-dom");
    });

    it.each([
      { label: "Fictiv's CNC Machining process label", configuration: { ...REQUESTED_CONFIGURATION, process: "CNC Machining" } },
      { label: "a 6061 label listing its tempers", configuration: { ...REQUESTED_CONFIGURATION, material: "6061 Aluminum (T6 / T651)" } },
      { label: "an As machined finish label", configuration: { ...REQUESTED_CONFIGURATION, finish: "As machined" } },
    ])("prices the quote when it reads back the requested configuration as $label", async ({ configuration }) => {
      const { result, error } = await runProcessFirstQuote({
        pricedPage: pricedPage({ parts: partTable(configurationCell(configuration)) }),
      });

      expect(error).toBeNull();
      expect(result).toMatchObject({
        status: "instant_quote_received",
        totalPriceUsd: 412.3,
        rawPayload: {
          selectedProcess: configuration.process,
          selectedMaterial: configuration.material,
          selectedFinish: configuration.finish,
        },
      });
    });

    // F13: the published quote URL is the created quote's, never a quote link
    // the priced page shows, on Fictiv's origin or off it.
    it("publishes the created quote's URL, never a quote link on the priced page", async () => {
      const links = '<nav><a href="/pages/quotes/another-quote">Another quote</a>'
        + '<a href="https://untrusted.invalid/quotes/other">Elsewhere</a></nav>';
      const { result, error } = await runProcessFirstQuote({ pricedPage: pricedPage({ extra: links }) });

      expect(error).toBeNull();
      expect(result).toMatchObject({ status: "instant_quote_received", quoteUrl: QUOTE_URL, rawPayload: { url: QUOTE_URL } });
      expect(result!.offers!.map((offer) => offer.quoteUrl)).toEqual([QUOTE_URL]);
    });

    it("publishes no unpriced result read from a quote other than the one the upload created", async () => {
      const manualReviewPage = quotePage('<div>RFQ required for this part.</div><button type="button">Edit configuration</button>');
      const { result, error } = await runProcessFirstQuote({
        afterAnalysisPage: manualReviewPage,
        repriceAfterMs: null,
        configureClickUrl: "https://app.fictiv.com/pages/quotes/another-quote",
      });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "result_page_not_created_quote",
          resultClassification: "manual_review",
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("result-provenance-unconfirmed-dom");
    });

    // F14: a $0.00 selected total is not a quote.
    it("publishes no price or offer for a $0.00 selected total", async () => {
      const { result, error } = await runProcessFirstQuote({ pricedPage: pricedPage({ total: "$0.00" }) });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: { terminalState: "selector_drift", reason: "selected_price_not_positive", detectedFlow: "instant_quote" },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("non-positive-price-dom");
    });

    // F15: the freshness check runs again right before the files are set
    // (stage before_upload), so an upload page that turns into a quote between
    // the CNC click and the upload receives nothing.
    it.each([
      {
        label: "an existing quote's lead-time hook appears",
        change: (fixturePage: FictivFixturePage) => fixturePage.document.body.insertAdjacentHTML(
          "beforeend",
          '<div data-test-target="quote-level-lead-time-selected-option"></div>',
        ),
        onUploadPage: true,
        portalState: "unknown",
        existingQuoteMarker: FICTIV_LOCATORS.existingQuoteMarkers[0],
      },
      {
        label: "a price appears",
        change: (fixturePage: FictivFixturePage) => fixturePage.document.body.insertAdjacentHTML(
          "beforeend",
          "<div>Total USD $5.00</div>",
        ),
        onUploadPage: true,
        portalState: "quote_ready",
        existingQuoteMarker: null,
      },
      {
        label: "the page moves to a quote URL",
        change: (fixturePage: FictivFixturePage) => fixturePage.setUrl(EXISTING_QUOTE_URL),
        onUploadPage: false,
        portalState: "unknown",
        existingQuoteMarker: null,
      },
    ])("never uploads when, after the CNC click, $label", async ({ change, onUploadPage, portalState, existingQuoteMarker }) => {
      const { result, error, events } = await runProcessFirstQuote({ onCncClick: change });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "selector_drift",
          reason: "upload_surface_not_fresh",
          stage: "before_upload",
          onUploadPage,
          portalState,
          existingQuoteMarker,
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toEqual(["landing-dom", "upload-surface-not-fresh-dom"]);
      expect(events.some((event) => event.kind === "set_input_files")).toBe(false);
      expect(clicked(events)).toEqual(["process-card:cnc"]);
    });

    // F15: the price published is the one the priced quote held still on with
    // the requested quantity, re-read at publish time. A stale price must
    // never be the one published.
    const STALE_TOTAL = "$398.10";
    const STALE_PRICED_PAGE = pricedPage({ total: STALE_TOTAL });
    const CALCULATING_STALE_PAGE = pricedPage({ total: STALE_TOTAL, extra: "<div>Calculating quote...</div>" });

    it("publishes the settled price, never a stale total shown for one poll short of the settle", async () => {
      // 600 ms polls: the stale total shows for three polls after the reprice
      // lands, one short of the 4-poll settle, then the final total.
      const { result, error } = await runProcessFirstQuote({ postRepriceFrames: [{ page: STALE_PRICED_PAGE, ms: 1_800 }] });

      expect(error).toBeNull();
      expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 412.3 });
      expect(result!.offers).toEqual([expect.objectContaining({ totalPriceUsd: 412.3 })]);
    });

    it("never counts polls while Fictiv is still calculating toward the settle, even with the stale total held", async () => {
      // The stale total stays on screen, unchanged, under "Calculating quote"
      // for longer than the settle: only quote_ready polls count.
      const { result, error } = await runProcessFirstQuote({
        postRepriceFrames: [{ page: STALE_PRICED_PAGE, ms: 600 }, { page: CALCULATING_STALE_PAGE, ms: 3_000 }],
      });

      expect(error).toBeNull();
      expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 412.3 });
      expect(result!.offers).toEqual([expect.objectContaining({ totalPriceUsd: 412.3 })]);
    });

    it("publishes nothing when Fictiv's quantity changes after the quote settled", async () => {
      const { result, error } = await runProcessFirstQuote({
        requestedQuantity: 5,
        // A late re-render drops the typed quantity back to Fictiv's default.
        atPriceExtraction: (fixturePage) => fixturePage.render(
          PRICED_PAGE.replace(QUANTITY_SLOT, quantityMarkup("input", "1")),
        ),
      });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "configuration_required",
          reason: "quantity_mismatch",
          requestedQuantity: 5,
          observedQuantities: [1],
        },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "configuration_required" });
    });

    it("publishes nothing when the selected price changes after the quote settled", async () => {
      const { result, error } = await runProcessFirstQuote({
        atPriceExtraction: (_fixturePage, renderQuote) => renderQuote(pricedPage({ total: "$405.70" })),
      });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: { terminalState: "configuration_required", reason: "price_changed_after_settle" },
      });
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "configuration_required" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("price-unsettled-dom");
    });

    // OVD-1053 round 6 (F16): the live quote page's only quantity control is
    // Fictiv's select-quantity number input, with no quantity display, so
    // round 4 stopped every live run as quantity_input_missing. The control is
    // read back (its value and aria-valuenow) on the settled, priced quote.
    it.each([
      { label: "5 requested", requestedQuantity: 5 },
      { label: "1 requested, Fictiv's default", requestedQuantity: 1 },
    ])("prices the quote once Fictiv's own quantity control holds the requested quantity: $label", async ({ requestedQuantity }) => {
      const { result, error, events } = await runProcessFirstQuote({ requestedQuantity, quantityControl: "select_quantity" });

      expect(error).toBeNull();
      const reading = { value: requestedQuantity, valueNow: requestedQuantity };
      expect(result).toMatchObject({
        status: "instant_quote_received",
        totalPriceUsd: 412.3,
        rawPayload: {
          quantitySelector: FICTIV_LOCATORS.quantityControls[0],
          quantityReadbackSource: "quantity_control",
          quantityReadbackSelector: null,
          quantityControlSelector: FICTIV_LOCATORS.quantityControls[0],
          quantityControlReadings: [reading],
          configurationReadback: { quantities: [], quantityControls: [reading] },
        },
      });
      expect(result!.offers).toEqual([expect.objectContaining({ quantity: requestedQuantity, totalPriceUsd: 412.3 })]);
      expect(events.filter((event) => event.kind === "fill")).toEqual([{ kind: "fill", detail: String(requestedQuantity) }]);
      expect(clicked(events)).toEqual(["process-card:cnc", "button:Edit configuration"]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("prices the quote when Fictiv's quantity control and a Qty. display agree", async () => {
      const { result, error } = await runProcessFirstQuote({
        requestedQuantity: 5,
        quantityControl: "select_quantity_and_display",
        summary: (quantity) => `<div data-test-target="quote-summary-quantity">Qty. ${quantity}</div>`,
      });

      expect(error).toBeNull();
      expect(result).toMatchObject({
        status: "instant_quote_received",
        rawPayload: {
          quantityReadbackSource: "quantity_control_and_display",
          quantityReadbackSelector: FICTIV_LOCATORS.quantityDisplays[0],
          quantityControlReadings: [{ value: 5, valueNow: 5 }],
          configurationReadback: { quantities: [5] },
        },
      });
    });

    it("types only into Fictiv's quantity control, never a generic number input next to it", async () => {
      // Had the 5 gone into the thread count, the control would still hold 1
      // and the run would stop as a quantity mismatch.
      const { result, error, events, page } = await runProcessFirstQuote({
        requestedQuantity: 5,
        quantityControl: "select_quantity_and_thread_count",
      });

      expect(error).toBeNull();
      expect(result).toMatchObject({
        status: "instant_quote_received",
        rawPayload: { quantitySelector: FICTIV_LOCATORS.quantityControls[0], quantityControlReadings: [{ value: 5, valueNow: 5 }] },
      });
      expect(events.filter((event) => event.kind === "fill")).toEqual([{ kind: "fill", detail: "5" }]);
      expect(page.document.querySelector<HTMLInputElement>('[data-test-target="thread-count"] input')?.value).toBe("0");
    });

    it("publishes the settled price, never a stale total, while Fictiv's quantity control already reads the request", async () => {
      const { result, error } = await runProcessFirstQuote({
        requestedQuantity: 5,
        quantityControl: "select_quantity",
        postRepriceFrames: [{ page: STALE_PRICED_PAGE, ms: 1_800 }],
      });

      expect(error).toBeNull();
      expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 412.3 });
      expect(result!.offers).toEqual([expect.objectContaining({ quantity: 5, totalPriceUsd: 412.3 })]);
    });

    it.each([
      {
        // The typed text stays in the box; aria-valuenow keeps Fictiv's 1.
        label: "Fictiv keeps the typed 5 in its control but holds 1",
        scenario: { requestedQuantity: 5, quantityControl: "select_quantity", controlIgnoresTypedQuantity: true },
        reason: "quantity_mismatch",
        controls: [{ value: 5, valueNow: 1 }],
        observedQuantities: [],
      },
      {
        label: "the reprice re-renders Fictiv's control with its default of 1",
        scenario: { requestedQuantity: 5, quantityControl: "select_quantity", repriceResetsQuantity: true },
        reason: "quantity_mismatch",
        controls: [{ value: 1, valueNow: 1 }],
        observedQuantities: [],
      },
      {
        // Both render, so both must agree.
        label: "Fictiv's control holding 5 while its summary still reads Qty 1",
        scenario: { requestedQuantity: 5, quantityControl: "select_quantity_and_display", summary: () => quantitySummary("1") },
        reason: "quantity_mismatch",
        controls: [{ value: 5, valueNow: 5 }],
        observedQuantities: [1],
      },
      {
        label: "Fictiv's control rendered without aria-valuenow",
        scenario: { requestedQuantity: 5, quantityControl: "select_quantity", controlOmitsValueNow: true },
        reason: "quantity_unconfirmed",
        controls: [{ value: 5, valueNow: null }],
        observedQuantities: [],
      },
    ] satisfies Array<{
      label: string;
      scenario: Scenario;
      reason: string;
      controls: Array<{ value: number | null; valueNow: number | null }>;
      observedQuantities: number[];
    }>)("publishes no price or offer with $label", async ({ scenario, reason, controls, observedQuantities }) => {
      const { result, error, events } = await runProcessFirstQuote(scenario);

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "configuration_required",
          reason,
          requestedQuantity: 5,
          observedQuantities,
          observedQuantityControls: controls,
          quantityControlSelector: FICTIV_LOCATORS.quantityControls[0],
          quantitySelector: FICTIV_LOCATORS.quantityControls[0],
        },
      });
      expect(failure.payload).not.toHaveProperty("totalPriceUsd");
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "configuration_required" });
      expect(failure.artifacts.map((artifact) => artifact.label)).toContain("quantity-unconfirmed-dom");
      expect(events.filter((event) => event.kind === "fill")).toEqual([{ kind: "fill", detail: "5" }]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("publishes nothing when Fictiv's quantity control changes after the quote settled", async () => {
      const { result, error } = await runProcessFirstQuote({
        requestedQuantity: 5,
        quantityControl: "select_quantity",
        atPriceExtraction: (fixturePage) => fixturePage.render(
          PRICED_PAGE.replace(QUANTITY_SLOT, quantityMarkup("select_quantity", "1")),
        ),
      });

      expect(result).toBeNull();
      expect(error).toMatchObject({
        code: "unexpected_ui_state",
        payload: {
          terminalState: "configuration_required",
          reason: "quantity_mismatch",
          observedQuantityControls: [{ value: 1, valueNow: 1 }],
        },
      });
    });

    // OVD-1053 round 6 (F20): the configuration control is Fictiv's own Edit
    // configuration link or an exact label, never a substring "Edit", which
    // also matched "Credit" and "Add credit".
    const CREDIT_CONTROLS = '<button type="button">Add credit</button><button type="button">Credit</button>';

    it("opens the configuration through Fictiv's Edit configuration link and never clicks a credit control", async () => {
      const awaitingWithLiveLink = quotePage(
        `<div>Parts have been configured based on your drawings!</div>${partTable(configurationCell(REQUESTED_CONFIGURATION))}`
        + `${CREDIT_CONTROLS}<div>${AWAITING_CLASSIFICATION}</div>`,
      );
      const { result, error, events } = await runProcessFirstQuote({
        afterAnalysisPage: awaitingWithLiveLink,
        pricedPage: pricedPage({ extra: CREDIT_CONTROLS }),
      });

      expect(error).toBeNull();
      expect(result).toMatchObject({ status: "instant_quote_received", rawPayload: { openedConfigurationDrawer: true } });
      expect(clicked(events)).toEqual(["process-card:cnc", "test-target:edit-config-link"]);
      expectCheckpointBeforeEveryMutation(events);
    });

    it("clicks no credit control when the page offers no configuration control", async () => {
      const awaitingWithOnlyCredit = quotePage(
        `<div>Parts have been configured based on your drawings!</div><div>CNC 6061 Aluminum</div>${CREDIT_CONTROLS}`
        + `<div>${AWAITING_CLASSIFICATION}</div>`,
      );
      const { result, error, events } = await runProcessFirstQuote({ afterAnalysisPage: awaitingWithOnlyCredit });

      expect(error).toBeNull();
      expect(result).toMatchObject({
        status: "manual_review_pending",
        totalPriceUsd: null,
        offers: [],
        rawPayload: { resultClassification: "configuration_required", openedConfigurationDrawer: false },
      });
      expect(clicked(events)).toEqual(["process-card:cnc"]);
    });

    // OVD-1053 round 6 (F21): the URL published is the created quote's,
    // canonical: Fictiv's origin and /pages/quotes/<quote>, whatever route,
    // query, fragment, case or default port the priced page shows.
    it.each([
      `${QUOTE_URL}/part/synthetic-part/configuration`,
      `${QUOTE_URL}/part/synthetic-part/configuration?tab=material#drawer`,
      `${QUOTE_URL}/?step=configure`,
      "https://APP.FICTIV.COM/pages/quotes/synthetic-quote#parts",
      "https://app.fictiv.com:443/pages/quotes/synthetic-quote",
    ])("publishes the created quote's canonical URL when the priced page shows %s", async (pricedUrl) => {
      const { result, error } = await runProcessFirstQuote({ configureClickUrl: pricedUrl });

      expect(error).toBeNull();
      expect(result).toMatchObject({ status: "instant_quote_received", quoteUrl: QUOTE_URL, rawPayload: { url: QUOTE_URL } });
      expect(result!.offers!.map((offer) => offer.quoteUrl)).toEqual([QUOTE_URL]);
    });

    it.each([
      { pricedUrl: "https://app.fictiv.com/pages/quotes/synthetic-quote-copy", terminalState: "selector_drift" },
      { pricedUrl: "https://app.fictiv.com/quotes/synthetic-quote", terminalState: "selector_drift" },
      { pricedUrl: "http://app.fictiv.com/pages/quotes/synthetic-quote", terminalState: "unexpected_origin" },
      { pricedUrl: "https://app.fictiv.com:8443/pages/quotes/synthetic-quote", terminalState: "unexpected_origin" },
      { pricedUrl: "https://app.fictiv.com.untrusted.invalid/pages/quotes/synthetic-quote", terminalState: "unexpected_origin" },
    ])("publishes no price when the priced page shows $pricedUrl", async ({ pricedUrl, terminalState }) => {
      const { result, error } = await runProcessFirstQuote({ configureClickUrl: pricedUrl });

      expect(result).toBeNull();
      expect(error).toBeInstanceOf(VendorAutomationError);
      const failure = error as VendorAutomationError;
      expect(failure.payload).toMatchObject({ terminalState });
      expect(failure.payload).not.toHaveProperty("totalPriceUsd");
      expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState });
    });

    // OVD-1053 round 6 (F19, F21): only lead-time options read the same way
    // at the settle, at extraction and at publish time, and offered, are
    // published; the selected option stops the run instead.
    const ALL_OFFERED = leadTimePanel([DOMESTIC_FASTEST, DOMESTIC_STANDARD, OVERSEAS_STANDARD]);

    it("publishes every lead-time option confirmed after the settle, the selected one first", async () => {
      const { result, error } = await runProcessFirstQuote({ pricedPage: pricedPage({ selection: ALL_OFFERED }) });

      expect(error).toBeNull();
      expect(result!.offers!.map((offer) => [offer.providerOptionId, offer.totalPriceUsd, offer.leadTimeBusinessDays])).toEqual([
        ["domestic:fastest", 412.3, 4],
        ["domestic:standard", 398.1, 6],
        ["overseas:standard", 301.25, 9],
      ]);
      expect(result!.offers![0].provenance.containerSelector).toBe('[data-test-target="quote-level-lead-time-selected-option"]');
      expect(result!.rawPayload).toMatchObject({ withheldLeadTimeOptions: [] });
    });

    it.each(["aria", "antd", "input", "text"] as const)(
      "never publishes a lead-time option the page marks unavailable (%s)",
      async (unavailable) => {
        const { result, error } = await runProcessFirstQuote({
          pricedPage: pricedPage({ selection: leadTimePanel([DOMESTIC_FASTEST, { ...DOMESTIC_STANDARD, unavailable }, OVERSEAS_STANDARD]) }),
        });

        expect(error).toBeNull();
        expect(result!.offers!.map((offer) => offer.providerOptionId)).toEqual(["domestic:fastest", "overseas:standard"]);
        expect(result!.offers!.map((offer) => offer.totalPriceUsd)).not.toContain(398.1);
        expect(result!.rawPayload).toMatchObject({
          withheldLeadTimeOptions: [{ region: "domestic", tier: "standard", reason: "unavailable" }],
          leadTimeOptions: expect.arrayContaining([
            expect.objectContaining({ region: "domestic", tier: "standard", selectable: false }),
          ]),
        });
      },
    );

    it.each([
      {
        label: "its price changes",
        after: leadTimePanel([DOMESTIC_FASTEST, { ...DOMESTIC_STANDARD, price: "Total USD $389.95" }, OVERSEAS_STANDARD]),
        withheld: [{ region: "domestic", tier: "standard", reason: "changed_after_settle" }],
        published: ["domestic:fastest", "overseas:standard"],
      },
      {
        label: "it first appears",
        before: leadTimePanel([DOMESTIC_FASTEST, DOMESTIC_STANDARD]),
        after: ALL_OFFERED,
        withheld: [{ region: "overseas", tier: "standard", reason: "changed_after_settle" }],
        published: ["domestic:fastest", "domestic:standard"],
      },
    ])("withholds a lead-time option when, after the settle, $label", async ({ before, after, withheld, published }) => {
      const { result, error } = await runProcessFirstQuote({
        pricedPage: pricedPage({ selection: before ?? ALL_OFFERED }),
        atPriceExtraction: (_fixturePage, renderQuote) => renderQuote(pricedPage({ selection: after })),
      });

      expect(error).toBeNull();
      expect(result!.offers!.map((offer) => offer.providerOptionId)).toEqual(published);
      expect(result!.offers!.map((offer) => offer.totalPriceUsd)).not.toContain(389.95);
      expect(result!.rawPayload).toMatchObject({ withheldLeadTimeOptions: withheld });
    });

    it.each([
      ...(["aria", "antd", "input", "text"] as const).map((unavailable) => ({
        label: `the selected option is marked unavailable (${unavailable})`,
        scenario: {
          pricedPage: pricedPage({ selection: leadTimePanel([{ ...DOMESTIC_FASTEST, unavailable }, DOMESTIC_STANDARD]) }),
        },
        reason: "selected_option_unavailable",
        terminalState: "configuration_required",
      })),
      {
        label: "the selected option's price changes after the settle",
        scenario: {
          pricedPage: pricedPage({ selection: ALL_OFFERED }),
          atPriceExtraction: (_fixturePage: FictivFixturePage, renderQuote: (pageHtml: string) => void) => renderQuote(
            pricedPage({ selection: leadTimePanel([{ ...DOMESTIC_FASTEST, price: "Total USD $405.00" }, DOMESTIC_STANDARD, OVERSEAS_STANDARD]) }),
          ),
        },
        reason: "selected_option_changed_after_settle",
        terminalState: "configuration_required",
      },
      {
        // The selected price hook still reads the settled $412.30.
        label: "the selection moves to another option after the settle",
        scenario: {
          pricedPage: pricedPage({ selection: ALL_OFFERED }),
          atPriceExtraction: (_fixturePage: FictivFixturePage, renderQuote: (pageHtml: string) => void) => renderQuote(
            pricedPage({ selection: leadTimePanel([{ ...DOMESTIC_FASTEST, selected: false }, { ...DOMESTIC_STANDARD, selected: true }]) }),
          ),
        },
        reason: "selected_option_changed",
        terminalState: "configuration_required",
      },
      {
        label: "the selected option shows its own total, other than the selected price",
        scenario: {
          pricedPage: pricedPage({ selection: leadTimePanel([{ ...DOMESTIC_FASTEST, price: "Total USD $405.00" }, DOMESTIC_STANDARD]) }),
        },
        reason: "selected_offer_mismatch",
        terminalState: "selector_drift",
      },
    ] satisfies Array<{ label: string; scenario: Scenario; reason: string; terminalState: string }>)(
      "publishes no price or offer when $label",
      async ({ scenario, reason, terminalState }) => {
        const { result, error } = await runProcessFirstQuote(scenario);

        expect(result).toBeNull();
        expect(error).toBeInstanceOf(VendorAutomationError);
        const failure = error as VendorAutomationError;
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: { terminalState, reason, url: QUOTE_URL },
        });
        expect(failure.payload).not.toHaveProperty("totalPriceUsd");
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState });
        expect(failure.artifacts.map((artifact) => artifact.label)).toContain("offers-unpublishable-dom");
      },
    );

    // OVD-1052 (G1): the live upload page's export-control notice sits in the
    // dropzone (02:46Z capture) and begins "Uploading parts". Round 4 read it
    // as an upload in progress and refused every real upload page as
    // upload_surface_not_fresh. Both directions are pinned on the hand-built
    // live dropzone (the fixture's "dropzone" template).
    describe("the live upload page's standing helper text (OVD-1052 G1)", () => {
      const EXPORT_NOTICE = /Uploading parts subject to any export control regulations/;

      it("reads the standing export-control notice as no progress, and uploads on the live dropzone", async () => {
        const document = new JSDOM(await fixtureHtml(), { url: "https://fixture.invalid/" }).window.document;
        const dropzone = document.querySelector<HTMLTemplateElement>('template[data-fixture-template="dropzone"]')!;
        const dropzoneText = fixtureText(dropzone.content.firstElementChild!);
        // The collision itself: the notice matches an in-progress signal.
        expect(dropzoneText).toMatch(EXPORT_NOTICE);
        expect(FICTIV_LOCATORS.inProgressSignals.some((signal) => signal.test(dropzoneText))).toBe(true);

        let noticeShownAtUpload = false;
        const { result, error, events, checkedAtUpload } = await runProcessFirstQuote({
          onCncClick: (fixturePage) => {
            noticeShownAtUpload = EXPORT_NOTICE.test(fixtureText(fixturePage.document.body));
          },
        });

        expect(error).toBeNull();
        expect(noticeShownAtUpload).toBe(true);
        expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 412.3 });
        expect(checkedAtUpload()).toBe("cnc");
        expect(events.filter((event) => event.kind === "set_input_files")).toHaveLength(1);
        expectCheckpointBeforeEveryMutation(events);
      });

      it("uploads when the live dropzone, notice and all, is already shown on landing with CNC selected", async () => {
        // Both freshness checks (before the process click and before the
        // upload) see the notice here.
        const { result, error, events } = await runProcessFirstQuote({ preselectedProcess: "cnc" });

        expect(error).toBeNull();
        expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 412.3 });
        expect(clicked(events).filter((target) => target.startsWith("process-card:"))).toEqual([]);
        expect(events.filter((event) => event.kind === "set_input_files")).toHaveLength(1);
      });

      it("still uploads with a progress bar that is hidden", async () => {
        const { result, error } = await runProcessFirstQuote({
          onCncClick: (fixturePage) => fixturePage.document.querySelector('[data-fixture-panel="upload"]')!
            .insertAdjacentHTML("beforeend", '<div hidden><div class="ant-progress ant-progress-line" role="progressbar"></div></div>'),
        });

        expect(error).toBeNull();
        expect(result).toMatchObject({ status: "instant_quote_received" });
      });

      const addToUploadPanel = (html: string) => (fixturePage: FictivFixturePage) =>
        fixturePage.document.querySelector('[data-fixture-panel="upload"]')!.insertAdjacentHTML("beforeend", html);
      it.each([
        {
          label: "the live upload progress panel shows next to the notice",
          html: '<div><span>Uploading files (0/0)</span><div class="ant-progress ant-progress-line"><span class="ant-progress-text">0%</span></div><span>Creating new quote...</span></div>',
          portalState: "in_progress",
          portalStateSignal: "uploading files",
          progressIndicator: ".ant-progress",
        },
        {
          label: "a textless progress bar shows",
          html: '<div class="ant-progress ant-progress-line"><div class="ant-progress-outer"></div></div>',
          portalState: "unknown",
          portalStateSignal: null,
          progressIndicator: ".ant-progress",
        },
        {
          label: "a textless ARIA progress bar shows",
          html: '<div role="progressbar" aria-valuenow="10"></div>',
          portalState: "unknown",
          portalStateSignal: null,
          progressIndicator: '[role="progressbar"]',
        },
        {
          label: "Fictiv analyzes parts",
          html: "<div>Analyzing parts (0/1)</div>",
          portalState: "in_progress",
          portalStateSignal: "analyzing (?:your )?(?:parts?|geometry)",
          progressIndicator: null,
        },
        {
          // Only the notice is taken out; real "Uploading parts" progress is still read.
          label: "Fictiv shows parts uploading",
          html: "<div>Uploading parts (1/2)</div>",
          portalState: "in_progress",
          portalStateSignal: "uploading part",
          progressIndicator: null,
        },
        {
          label: "an existing quote's lead-time hook appears",
          html: '<div data-test-target="quote-level-lead-time-domesticFastest"></div>',
          portalState: "unknown",
          portalStateSignal: null,
          progressIndicator: null,
          existingQuoteMarker: FICTIV_LOCATORS.existingQuoteMarkers[0],
        },
      ])("never uploads when, next to the notice, $label", async ({ html, portalState, portalStateSignal, progressIndicator, existingQuoteMarker }) => {
        const { result, error, events } = await runProcessFirstQuote({ onCncClick: addToUploadPanel(html) });

        expect(result).toBeNull();
        expect(error).toBeInstanceOf(VendorAutomationError);
        const failure = error as VendorAutomationError;
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: {
            terminalState: "selector_drift",
            reason: "upload_surface_not_fresh",
            stage: "before_upload",
            onUploadPage: true,
            portalState,
            portalStateSignal,
            progressIndicator,
            existingQuoteMarker: existingQuoteMarker ?? null,
          },
        });
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
        const notFresh = failure.artifacts.find((artifact) => artifact.label === "upload-surface-not-fresh-dom");
        expect(await fs.readFile(notFresh!.localPath, "utf8")).toMatch(EXPORT_NOTICE);
        expect(events.some((event) => event.kind === "set_input_files")).toBe(false);
        expect(clicked(events)).toEqual(["process-card:cnc"]);
      });
    });

    // OVD-1052 (G2): Fictiv reprices under a textless spinner with the stale
    // total still on screen beneath it (02:46Z configured capture: Ant Design
    // spinners, no reprice text). Round 6 counted those polls toward the
    // 4-poll settle and published the stale total for the new quantity.
    // Round 8 (H1): the settle is anchored on the run's last configuration
    // action, and only a spinner in the price or summary panel shows the
    // price updating.
    describe("the textless reprice spinner and the last configuration action (OVD-1052 G2, H1)", () => {
      // Hand-built on the live spinners: a nested spin over its content, and
      // a standalone spin laid over the summary card, next to it. The card
      // holds Fictiv's own summary-card hook (live: its add-shipping-address
      // link, a checkout control the adapter never clicks).
      const nestedSpin = (content: string) =>
        '<div class="ant-spin-nested-loading"><div><div class="ant-spin ant-spin-spinning"><span class="ant-spin-dot ant-spin-dot-spin">'
        + '<i class="ant-spin-dot-item"></i><i class="ant-spin-dot-item"></i><i class="ant-spin-dot-item"></i><i class="ant-spin-dot-item"></i>'
        + `</span></div></div><div class="ant-spin-container ant-spin-blur">${content}</div></div>`;
      const SUMMARY_CARD = '<div class="blur"><span>Summary</span><span>Shipping address</span>'
        + '<a href="" data-test-target="add-new-address-shipping-section-quote-detail-checkout-summary-card">Add shipping address</a></div>';
      const SUMMARY_OVERLAY_SPIN = '<div><div style="opacity: 0.7"><div class="ant-spin ant-spin-spinning"><span class="ant-spin-dot ant-spin-dot-spin">'
        + `<i class="ant-spin-dot-item"></i></span></div></div>${SUMMARY_CARD}</div>`;
      // The live classification card (02:46Z analysis-complete capture): the
      // Prototype hook sits on the radio input, which has no text of its own.
      const liveClassification = (checked: "prototype" | "commercial" | null = null) =>
        '<div class="ant-card ant-card-bordered"><div class="ant-card-body"><div>Required: Are these parts for prototype or commercial use?</div>'
        + '<div class="ant-spin-nested-loading"><div class="ant-spin-container">'
        + '<div class="ant-radio-group" data-test-target="quote-classification-selection-radio-group">'
        + (["prototype", "commercial"] as const).map((use) =>
          `<label class="ant-radio-wrapper${checked === use ? " ant-radio-wrapper-checked" : ""}"><span class="ant-radio${checked === use ? " ant-radio-checked" : ""}">`
          + `<input type="radio" class="ant-radio-input" data-test-target="quote-classification-selection-import-classification-radio-button-${use}" value="fixture-${use}"${checked === use ? " checked" : ""}>`
          + `</span><span>${use === "prototype" ? "Prototype" : "Commercial"}</span></label>`).join("")
        + "</div></div></div></div></div>";
      // The classification card under its own nested spin, as live right after the Prototype click.
      const CLASSIFICATION_SPIN = '<div class="ant-card ant-card-bordered"><div class="ant-card-body">'
        + nestedSpin('<div class="ant-radio-group" data-test-target="quote-classification-selection-radio-group">'
          + '<label class="ant-radio-wrapper ant-radio-wrapper-checked"><span class="ant-radio ant-radio-checked">'
          + '<input type="radio" class="ant-radio-input" data-test-target="quote-classification-selection-import-classification-radio-button-prototype" value="fixture-prototype" checked>'
          + "</span><span>Prototype</span></label></div>")
        + "</div></div>";
      const STALE_TOTAL_ = "$398.10";
      const stalePricedPage = (extra = "") => pricedPage({ total: STALE_TOTAL_, extra });
      const SPINNER_FRAMES = [
        {
          label: "a nested spin over the selected price",
          page: pricedPage({ selection: nestedSpin(pricedSelection(STALE_TOTAL_)) }),
          indicator: ".ant-spin-spinning",
          pricePanel: ".ant-spin-spinning",
        },
        {
          label: "a standalone spin over the summary card",
          page: stalePricedPage(SUMMARY_OVERLAY_SPIN),
          indicator: ".ant-spin-spinning",
          pricePanel: ".ant-spin-spinning",
        },
        // Modeled, not observed: Ant Design's other loading states.
        {
          label: "an aria-busy panel",
          page: pricedPage({ selection: `<div aria-busy="true">${pricedSelection(STALE_TOTAL_)}</div>` }),
          indicator: '[aria-busy="true"]',
          pricePanel: '[aria-busy="true"]',
        },
        // Page level, outside the price and summary panels: it holds every
        // poll back but never shows the price updating.
        {
          label: "a page-level skeleton placeholder",
          page: stalePricedPage('<div class="ant-skeleton ant-skeleton-active"></div>'),
          indicator: ".ant-skeleton",
          pricePanel: null,
        },
      ];

      it.each(SPINNER_FRAMES)(
        "never publishes the stale total held for 2 s under $label, only the new total after it",
        async ({ page: spinnerFrame, indicator, pricePanel }) => {
          // 600 ms polls: the stale total shows for four polls (0, 0.6, 1.2,
          // 1.8 s), a full settle had the spinner not been read.
          const { result, error } = await runProcessFirstQuote({
            requestedQuantity: 5,
            quantityControl: "select_quantity",
            postRepriceFrames: [{ page: spinnerFrame, ms: 2_000 }],
          });

          expect(error).toBeNull();
          expect(result).toMatchObject({
            status: "instant_quote_received",
            totalPriceUsd: 412.3,
            rawPayload: {
              quantityControlReadings: [{ value: 5, valueNow: 5 }],
              // The quote was unpriced when the quantity, the last action
              // here, was typed: the configure-all-parts prompt.
              repriceSettle: {
                actionCount: 2,
                lastAction: "quantity_fill",
                beforeLastAction: { priceText: null, quantityControls: [{ value: 1, valueNow: 1 }] },
                updatingSignal: "unpriced",
                pricePanelRepriceIndicator: pricePanel,
                lastRepriceIndicator: indicator,
              },
            },
          });
          expect(result!.offers!.map((offer) => offer.totalPriceUsd)).toEqual([412.3]);
        },
      );

      it("never counts the configure-all-parts prompt toward its settle while spinners show over it", async () => {
        // The 02:46Z configured state, hand-built: the prompt with a nested
        // spin over the classification card and a standalone spin over the
        // summary, for 25 s (about 42 polls, past the 40-poll settle).
        const configuredUnderSpinners = quotePage(
          `${nestedSpin(classificationRadios())}<div>${AWAITING_CLASSIFICATION}</div>${SUMMARY_OVERLAY_SPIN}`,
        );
        const { result, error } = await runProcessFirstQuote({
          repriceAfterMs: 1_000,
          postRepriceFrames: [{ page: configuredUnderSpinners, ms: 25_000 }],
        });

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 412.3,
          rawPayload: { repriceSettle: { lastRepriceIndicator: ".ant-spin-spinning", pricePanelRepriceIndicator: ".ant-spin-spinning" } },
        });
      });

      it("reads the live page's standing nested-loading wrappers as no reprice", async () => {
        const { result, error } = await runProcessFirstQuote({
          pricedPage: pricedPage({ selection: '<div class="ant-spin-nested-loading"><div class="ant-spin-container">'
            + `${pricedSelection()}</div></div>` }),
        });

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 412.3,
          rawPayload: { repriceSettle: { lastRepriceIndicator: null, pricePanelRepriceIndicator: null } },
        });
      });

      it("publishes nothing when a reprice spinner shows again at publish time", async () => {
        const { result, error } = await runProcessFirstQuote({
          atPriceExtraction: (_fixturePage, renderQuote) => renderQuote(pricedPage({ extra: SUMMARY_OVERLAY_SPIN })),
        });

        expect(result).toBeNull();
        expect(error).toBeInstanceOf(VendorAutomationError);
        const failure = error as VendorAutomationError;
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: { terminalState: "configuration_required", reason: "reprice_indicator_at_publish", repriceIndicator: ".ant-spin-spinning" },
        });
        expect(failure.payload).not.toHaveProperty("totalPriceUsd");
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "configuration_required" });
      });

      // The quote is already priced at Fictiv's default quantity of 1 when
      // the run types the requested quantity.
      const PRICED_AT_ONE = stalePricedPage();
      const unsettledFailure = (error: unknown) => {
        expect(error).toBeInstanceOf(VendorAutomationError);
        const failure = error as VendorAutomationError;
        expect(failure.payload).not.toHaveProperty("totalPriceUsd");
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "configuration_required" });
        return failure;
      };

      it("never publishes the old total, unchanged after the last action (the fill), for a new quantity", async () => {
        // Fictiv's control reads 5 while the old total stays, with no spinner,
        // for 3 s (five polls); then the new total.
        const { result, error } = await runProcessFirstQuote({
          requestedQuantity: 5,
          quantityControl: "select_quantity",
          afterAnalysisPage: PRICED_AT_ONE,
          postRepriceFrames: [{ page: PRICED_AT_ONE, ms: 3_000 }],
        });

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 412.3,
          rawPayload: {
            repriceSettle: {
              lastAction: "quantity_fill",
              beforeLastAction: { priceText: `Total USD ${STALE_TOTAL_}`, quantityControls: [{ value: 1, valueNow: 1 }] },
              updatingSignal: "price_changed",
              lastRepriceIndicator: null,
            },
          },
        });
        expect(result!.offers!.map((offer) => offer.totalPriceUsd)).toEqual([412.3]);
      });

      it("publishes nothing when the old total never refreshes after the last action", async () => {
        const { result, error } = await runProcessFirstQuote({
          requestedQuantity: 5,
          quantityControl: "select_quantity",
          afterAnalysisPage: PRICED_AT_ONE,
          postRepriceFrames: [{ page: PRICED_AT_ONE, ms: 120_000 }],
        });

        expect(result).toBeNull();
        expect(unsettledFailure(error)).toMatchObject({
          code: "unexpected_ui_state",
          payload: {
            terminalState: "configuration_required",
            reason: "quantity_reprice_unsettled",
            requestedQuantity: 5,
            observedQuantityControls: [{ value: 5, valueNow: 5 }],
            repriceSettle: {
              lastAction: "quantity_fill",
              beforeLastAction: { priceText: `Total USD ${STALE_TOTAL_}` },
              updatingSignal: null,
              lastRepriceIndicator: null,
            },
          },
        });
      });

      it("publishes the same total once a spinner in the summary panel re-confirmed it after the last action", async () => {
        const { result, error } = await runProcessFirstQuote({
          requestedQuantity: 5,
          quantityControl: "select_quantity",
          afterAnalysisPage: PRICED_AT_ONE,
          postRepriceFrames: [{ page: stalePricedPage(SUMMARY_OVERLAY_SPIN), ms: 1_200 }],
          pricedPage: PRICED_AT_ONE,
        });

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 398.1,
          rawPayload: {
            repriceSettle: {
              updatingSignal: "price_panel_reprice_indicator",
              pricePanelRepriceIndicator: ".ant-spin-spinning",
              lastRepriceIndicator: ".ant-spin-spinning",
            },
          },
        });
      });

      it.each([
        { label: "the classification card's spinner (live, after the Prototype click)", extra: CLASSIFICATION_SPIN, indicator: ".ant-spin-spinning" },
        { label: "a page-level skeleton", extra: '<div class="ant-skeleton ant-skeleton-active"></div>', indicator: ".ant-skeleton" },
        {
          label: "a summary-like overlay with no summary-card hook",
          extra: '<div><div><div class="ant-spin ant-spin-spinning"></div></div><div class="blur"><span>Summary</span></div></div>',
          indicator: ".ant-spin-spinning",
        },
      ])("never takes $label as re-confirming an unchanged total", async ({ extra, indicator }) => {
        const { result, error } = await runProcessFirstQuote({
          requestedQuantity: 5,
          quantityControl: "select_quantity",
          afterAnalysisPage: PRICED_AT_ONE,
          postRepriceFrames: [{ page: stalePricedPage(extra), ms: 1_200 }],
          pricedPage: PRICED_AT_ONE,
        });

        expect(result).toBeNull();
        expect(unsettledFailure(error)).toMatchObject({
          payload: {
            reason: "quantity_reprice_unsettled",
            repriceSettle: { updatingSignal: null, pricePanelRepriceIndicator: null, lastRepriceIndicator: indicator },
          },
        });
      });

      it("publishes nothing when the last action, a fill that kept the page's quantity, leaves the total unchanged", async () => {
        // Nothing shows the price updating after the last action, so the
        // unchanged total is not known to be current: it fails closed.
        const { result, error } = await runProcessFirstQuote({
          requestedQuantity: 1,
          quantityControl: "select_quantity",
          afterAnalysisPage: PRICED_AT_ONE,
          pricedPage: PRICED_AT_ONE,
        });

        expect(result).toBeNull();
        expect(unsettledFailure(error)).toMatchObject({
          payload: {
            reason: "quantity_reprice_unsettled",
            observedQuantityControls: [{ value: 1, valueNow: 1 }],
            repriceSettle: { lastAction: "quantity_fill", beforeLastAction: { priceText: `Total USD ${STALE_TOTAL_}` }, updatingSignal: null },
          },
        });
      });

      // The live order (02:46Z): the quote is unpriced when the quantity is
      // typed and is priced only after later configuration actions. Here
      // Fictiv shows an old total once Enter takes the quantity, and the
      // Prototype classification click, the run's last action, reprices it.
      // A settle anchored on the fill took any total as refreshed.
      const AWAITING_WITH_CLASSIFICATION = quotePage(
        `<div>Parts have been configured based on your drawings!</div>${partTable(configurationCell(REQUESTED_CONFIGURATION))}`
        + `${liveClassification()}<div>${AWAITING_CLASSIFICATION}</div>`,
      );
      const OLD_TOTAL_BEFORE_CLASSIFICATION = stalePricedPage(liveClassification("commercial"));
      const PROTOTYPE_CLICK = (target: string) => target.endsWith("radio-button-prototype");
      const classificationScenario = (overrides: Partial<Scenario> = {}): Scenario => ({
        requestedQuantity: 5,
        quantityControl: "select_quantity",
        afterAnalysisPage: AWAITING_WITH_CLASSIFICATION,
        pageOnEnter: OLD_TOTAL_BEFORE_CLASSIFICATION,
        repriceOnClick: PROTOTYPE_CLICK,
        ...overrides,
      });

      it("never publishes the old total 398.10 shown for 3 s after the Prototype click, with the quantity control already reading 5", async () => {
        const { result, error, events, clickLog } = await runProcessFirstQuote(classificationScenario({ repriceAfterMs: 3_000 }));

        expect(error).toBeNull();
        expect(clicked(events)).toEqual([
          "process-card:cnc",
          "test-target:edit-config-link",
          "test-target:quote-classification-selection-import-classification-radio-button-prototype",
        ]);
        expect(clickLog.at(-1)).toMatchObject({ stage: "awaiting" });
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 412.3,
          rawPayload: {
            quantityControlReadings: [{ value: 5, valueNow: 5 }],
            repriceSettle: {
              actionCount: 3,
              lastAction: "end_use",
              beforeLastAction: { priceText: `Total USD ${STALE_TOTAL_}`, quantityControls: [{ value: 5, valueNow: 5 }] },
              updatingSignal: "price_changed",
              lastRepriceIndicator: null,
            },
          },
        });
        expect(result!.offers!.map((offer) => offer.totalPriceUsd)).toEqual([412.3]);
        expectCheckpointBeforeEveryMutation(events);
      });

      it("publishes nothing when the old total never changes after the Prototype click", async () => {
        const { result, error } = await runProcessFirstQuote(classificationScenario({ repriceAfterMs: null }));

        expect(result).toBeNull();
        expect(unsettledFailure(error)).toMatchObject({
          payload: {
            reason: "quantity_reprice_unsettled",
            observedQuantityControls: [{ value: 5, valueNow: 5 }],
            repriceSettle: {
              lastAction: "end_use",
              beforeLastAction: { priceText: `Total USD ${STALE_TOTAL_}` },
              updatingSignal: null,
              lastRepriceIndicator: null,
            },
          },
        });
      });

      it.each([
        { label: "goes unpriced ($ --)", frame: stalePricedPage().replace(`Total USD ${STALE_TOTAL_}`, "$ --"), signal: "unpriced" },
        { label: "shows a spinner over the summary card", frame: stalePricedPage(SUMMARY_OVERLAY_SPIN), signal: "price_panel_reprice_indicator" },
      ])("publishes the old total once it $label after the Prototype click and holds for the full settle", async ({ frame, signal }) => {
        const { result, error } = await runProcessFirstQuote(classificationScenario({
          repriceAfterMs: 600,
          postRepriceFrames: [{ page: frame, ms: 1_200 }],
          pricedPage: PRICED_AT_ONE,
        }));

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 398.1,
          rawPayload: { repriceSettle: { lastAction: "end_use", updatingSignal: signal } },
        });
      });

      it("never takes the classification card's own spinner after the Prototype click as re-confirming the old total", async () => {
        const { result, error } = await runProcessFirstQuote(classificationScenario({
          repriceAfterMs: 600,
          postRepriceFrames: [{ page: stalePricedPage(CLASSIFICATION_SPIN), ms: 1_800 }],
          pricedPage: PRICED_AT_ONE,
        }));

        expect(result).toBeNull();
        expect(unsettledFailure(error)).toMatchObject({
          payload: {
            reason: "quantity_reprice_unsettled",
            repriceSettle: { lastAction: "end_use", updatingSignal: null, lastRepriceIndicator: ".ant-spin-spinning" },
          },
        });
      });

      it("re-anchors on the auto configuration Continue clicked during the settle, and publishes only the total after it", async () => {
        // The settle on 398.10 is under way when Fictiv's auto configuration
        // modal shows; its Continue is the run's last action, so 398.10 has
        // to change (or be re-confirmed) after it before anything counts.
        const continueModal = '<div class="ant-modal"><button type="button" class="guide-auto-config-loading-modal-auto-config-loading-modal-continue">Continue</button></div>';
        const { result, error, events } = await runProcessFirstQuote(classificationScenario({
          repriceAfterMs: 600,
          postRepriceFrames: [
            { page: stalePricedPage().replace(`Total USD ${STALE_TOTAL_}`, "$ --"), ms: 600 },
            { page: stalePricedPage(continueModal), ms: 1_200 },
            { page: PRICED_AT_ONE, ms: 3_000 },
          ],
        }));

        expect(error).toBeNull();
        expect(clicked(events).at(-1)).toBe("button:Continue");
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 412.3,
          rawPayload: { repriceSettle: { lastAction: "auto_config_continue", updatingSignal: "price_changed" } },
        });
        expectCheckpointBeforeEveryMutation(events);
      });

      it("publishes nothing when a configuration action is made after the quote settled", async () => {
        const continueModal = '<div class="ant-modal"><button type="button" class="guide-auto-config-loading-modal-auto-config-loading-modal-continue">Continue</button></div>';
        const { result, error, events } = await runProcessFirstQuote({
          atPriceExtraction: (_fixturePage, renderQuote) => renderQuote(pricedPage({ extra: continueModal })),
        });

        expect(result).toBeNull();
        expect(clicked(events).at(-1)).toBe("button:Continue");
        expect(unsettledFailure(error)).toMatchObject({
          code: "unexpected_ui_state",
          payload: { terminalState: "configuration_required", reason: "configuration_action_after_settle" },
        });
      });
    });

    // OVD-1052 round 8 (H2): on each of the adapter's click paths a selector
    // resolves to a forbidden control. The guard refuses it before anything
    // is done on it, and the run stops as selector drift.
    describe("the action guard on each click path (OVD-1052 round 8, H2)", () => {
      const awaitingWith = (extra: string, cell = configurationCell(REQUESTED_CONFIGURATION)) => quotePage(
        `<div>Parts have been configured based on your drawings!</div>${partTable(cell)}${extra}<div>${AWAITING_CLASSIFICATION}</div>`,
      );
      const CHECKOUT_CONFIG_CELL = configurationCell(REQUESTED_CONFIGURATION)
        .replace(">Edit configuration</a>", ">Checkout</a>");
      const QUOTE_REQUEST_CLASSIFICATION = '<label class="ant-radio-wrapper"><span class="ant-radio">'
        + '<input type="radio" class="ant-radio-input" data-test-target="quote-classification-selection-import-classification-radio-button-prototype" title="Request a quote" value="fixture-prototype">'
        + "</span><span>Prototype</span></label>";
      const CREDIT_QUANTITY = '<input type="number" role="spinbutton" data-test-target="select-quantity" aria-label="Store credit amount" aria-valuenow="1" value="1">';
      const ORDER_CONTINUE = '<div class="ant-modal"><button type="button" class="guide-auto-config-loading-modal-auto-config-loading-modal-continue">Place order</button></div>';
      const PAY_MODAL_CLOSE = '<div class="ant-modal"><button type="button" class="ant-modal-close" aria-label="Pay now"><span class="ant-modal-close-x"></span></button></div>';
      const CART_MATERIAL = '<button type="button" data-test-target="material">Add to cart</button>';
      const cncCardWith = async (extra: string) =>
        (await fixtureHtml()).replace("<span>CNC Machining</span>", `<span>CNC Machining</span>${extra}`);

      it.each([
        { label: "the configuration drawer link reads Checkout", action: "configuration_drawer", scenario: () => ({ afterAnalysisPage: awaitingWith("", CHECKOUT_CONFIG_CELL) }), field: "text", term: "checkout" },
        { label: "the Prototype radio is titled Request a quote", action: "end_use", scenario: () => ({ afterAnalysisPage: awaitingWith(QUOTE_REQUEST_CLASSIFICATION) }), field: "title", term: "request a quote" },
        { label: "Fictiv's quantity control is a store credit field", action: "quantity_fill", scenario: () => ({ quantityControl: "none" as const, afterAnalysisPage: awaitingWith(CREDIT_QUANTITY) }), field: "aria-label", term: "credit" },
        { label: "the auto configuration Continue reads Place order", action: "auto_config_continue", scenario: () => ({ afterAnalysisPage: awaitingWith(ORDER_CONTINUE) }), field: "text", term: "place order" },
        { label: "a modal close button is labeled Pay now", action: "modal_close", scenario: () => ({ afterAnalysisPage: awaitingWith(PAY_MODAL_CLOSE) }), field: "aria-label", term: "pay" },
        { label: "the material control reads Add to cart", action: "material_dropdown", scenario: () => ({ afterAnalysisPage: awaitingWith(CART_MATERIAL) }), field: "text", term: "add to cart" },
      ] satisfies Array<{ label: string; action: string; scenario: () => Scenario; field: string; term: string }>)(
        "never acts when $label",
        async ({ action, scenario, field, term }) => {
          const { result, error, events } = await runProcessFirstQuote(scenario());

          expect(result).toBeNull();
          expect(error).toBeInstanceOf(VendorAutomationError);
          const failure = error as VendorAutomationError;
          expect(failure).toMatchObject({
            code: "unexpected_ui_state",
            payload: { terminalState: "selector_drift", reason: "unsafe_click", action, matchedField: field, matchedTerm: term },
          });
          expect(failure.payload).not.toHaveProperty("totalPriceUsd");
          expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
          // Only the clicks before the refused one were made, none on it, and nothing after it.
          const actions = events.filter((event) => MUTATIONS.has(event.kind));
          expect(actions.filter((event) => /checkout|credit|place order|pay now|add to cart|request a quote/i.test(event.detail))).toEqual([]);
          if (action === "quantity_fill") expect(events.filter((event) => event.kind === "fill" || event.kind === "press")).toEqual([]);
          expect(actions.at(-1)).toEqual(
            action === "configuration_drawer" || action === "auto_config_continue" || action === "modal_close"
              ? { kind: "set_input_files", detail: "part.step,part.pdf" }
              : expect.anything(),
          );
        },
      );

      it("never clicks a CNC card that also offers Buy now, and uploads nothing", async () => {
        const { result, error, events } = await runProcessFirstQuote({ landingPage: await cncCardWith("<span>Buy now</span>") });

        expect(result).toBeNull();
        expect(error).toMatchObject({
          payload: { terminalState: "selector_drift", reason: "unsafe_click", action: "cnc_process_card", matchedTerm: "buy" },
        });
        expect(events.filter((event) => MUTATIONS.has(event.kind))).toEqual([]);
      });
    });

    // OVD-1052 round 8 (H3): the headline published is the selected
    // option's own single price; a selected option that shows more than one
    // never has its first amount taken.
    describe("the selected option's own single price (OVD-1052 round 8, H3)", () => {
      const USD = '<div data-test-target="quote-currency-selector"><span>USD</span></div>';
      const liveSelected = (inner: string) =>
        '<ul><li class="ant-list-item" data-test-target="quote-level-lead-time-selected-option" data-name="quote-level-lead-time-domesticFastest">'
        + `<label class="ant-radio-wrapper ant-radio-wrapper-checked"><span><span>4 production days (USA or Mexico)</span>${inner}<span>Fastest</span></span></label></li></ul>`
        + '<div data-test-target="qllt-header-wrapper"><span>Below is the price for part production.</span></div>';
      const SPAN = (amount: string) => `<span data-test-target="quote-level-lead-time-price">${amount}</span>`;

      it.each([
        { label: "a struck-through amount next to its price span", selection: liveSelected(`<s>$ 450.00</s>${SPAN("$ 412.30")}`), counts: { selectedOptionCount: 1, selectedOptionPriceSpanCount: 1, selectedOptionAmountCount: 2 } },
        { label: "two price spans", selection: liveSelected(`${SPAN("$ 412.30")}${SPAN("$ 450.00")}`), counts: { selectedOptionCount: 1, selectedOptionPriceSpanCount: 2, selectedOptionAmountCount: 2 } },
        { label: "a price span and a placeholder span", selection: liveSelected(`${SPAN("$ 412.30")}${SPAN("$ --")}`), counts: { selectedOptionCount: 1, selectedOptionPriceSpanCount: 2, selectedOptionAmountCount: 1 } },
        {
          label: "two options both marked selected",
          selection: `${liveSelected(SPAN("$ 412.30"))}${liveSelected(SPAN("$ 301.25")).replace("domesticFastest", "overseasStandard")}`,
          counts: { selectedOptionCount: 2, selectedOptionPriceSpanCount: 2, selectedOptionAmountCount: 1 },
        },
      ])("publishes nothing when the selected option shows $label", async ({ selection, counts }) => {
        const { result, error } = await runProcessFirstQuote({ pricedPage: pricedPage({ selection, extra: USD }) });

        expect(result).toBeNull();
        expect(error).toBeInstanceOf(VendorAutomationError);
        const failure = error as VendorAutomationError;
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: { terminalState: "selector_drift", reason: "selected_offer_ambiguous", ...counts },
        });
        expect(failure.payload).not.toHaveProperty("totalPriceUsd");
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
        expect(failure.artifacts.map((artifact) => artifact.label)).toContain("selected-offer-ambiguous-dom");
      });

      it("publishes the selected option's one price from its own span", async () => {
        const { result, error } = await runProcessFirstQuote({ pricedPage: pricedPage({ selection: liveSelected(SPAN("$ 412.30")), extra: USD }) });

        expect(error).toBeNull();
        expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 412.3 });
      });

      it("publishes nothing when the selected option's one amount, unverified, differs from the selected price", async () => {
        const selection = '<div data-test-target="quote-level-lead-time-selected-option" data-name="quote-level-lead-time-domesticFastest">'
          + "Fastest 4 production days (USA or Mexico) $ 405.00</div>"
          + '<div data-test-target="quote-level-lead-time-price-selected">Total USD $412.30</div>';
        const { result, error } = await runProcessFirstQuote({ pricedPage: pricedPage({ selection }) });

        expect(result).toBeNull();
        expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "selected_offer_mismatch" } });
      });
    });

    // OVD-1052 (G3): the 02:46Z result capture's lead-time panel, hand-built:
    // the qllt header with its "price for part production" statement, one li
    // per option with Fictiv's per-option hook and data-name (the selected
    // one's hook swapped to selected-option), a price span reading a bare
    // "$ ..." ("$ --" unpriced), and no selected-price hook. The capture
    // names no currency anywhere. Prices filled in here are synthetic.
    describe("the live lead-time panel's bare dollar prices (OVD-1052 G3)", () => {
      const LIVE_HEADER = '<div data-test-target="qllt-header-wrapper"><div><span>Select regional preference</span></div>'
        + "<span>Below is the price for part production. See the summary card for total cost with shipping, duties, and tariffs.</span>"
        + '<div class="ant-spin-nested-loading"><div class="ant-spin-container"><div><div>Prototype</div></div></div></div></div>';
      const liveOption = ({ key, days, price, tier, selected }: LeadTimeFixtureOption) =>
        `<li class="ant-list-item" data-test-target="${selected ? "quote-level-lead-time-selected-option" : `quote-level-lead-time-${key}`}"`
        + ` data-name="quote-level-lead-time-${key}"><label class="ant-radio-wrapper${selected ? " ant-radio-wrapper-checked" : ""}">`
        + `<span class="ant-radio${selected ? " ant-radio-checked" : ""}"><input type="radio" class="ant-radio-input" value="fixture-${key}"${selected ? " checked" : ""}></span>`
        + `<span><div><div><div></div><span>${days}</span></div><div><div><span data-test-target="quote-level-lead-time-price">${price}</span></div>`
        + `<span>${tier}</span></div></div></span></label></li>`;
      const liveList = (options: LeadTimeFixtureOption[]) =>
        '<div class="ant-radio-group"><div class="ant-list"><div class="ant-spin-nested-loading"><div class="ant-spin-container">'
        + `<ul class="ant-list-items">${options.map(liveOption).join("")}</ul></div></div></div></div>`;
      const LIVE_OPTIONS: LeadTimeFixtureOption[] = [
        { key: "domesticFastest", days: "4 production days (USA or Mexico)", price: "$ 412.30", tier: "Fastest", selected: true },
        { key: "domesticStandard", days: "6 production days (USA or Mexico)", price: "$ 398.10", tier: "Standard" },
        { key: "domesticCostEffective", days: "8 production days (USA or Mexico)", price: "$ 377.00", tier: "Cost-effective" },
        { key: "overseasFastest", days: "6 production days", price: "$ 350.00", tier: "Fastest" },
        { key: "overseasStandard", days: "9 production days", price: "$ 301.25", tier: "Standard" },
        { key: "overseasCostEffective", days: "13 production days", price: "$ 280.40", tier: "Cost-effective" },
      ];
      const livePanel = (options = LIVE_OPTIONS, header = LIVE_HEADER) =>
        `${header}<div><span>North America</span><label class="ant-checkbox-wrapper"><span class="ant-checkbox">`
        + '<input type="checkbox" class="ant-checkbox-input"></span><span>USA only</span></label></div>'
        + `${liveList(options.filter((option) => option.key.startsWith("domestic")))}`
        + `<div><span>Overseas</span></div>${liveList(options.filter((option) => option.key.startsWith("overseas")))}`;
      // Modeled, not observed: a currency selector reading USD.
      const USD_SELECTOR = '<div data-test-target="quote-currency-selector"><span>USD</span></div>';
      const livePricedPage = (options: { panel?: string; extra?: string } = {}) =>
        quotePage(`${options.panel ?? livePanel()}${partTable(configurationCell(REQUESTED_CONFIGURATION))}${options.extra ?? ""}`);

      it("fails closed as price_currency_unverified on the 02:46Z structure, which names no currency", async () => {
        const { result, error } = await runProcessFirstQuote({ pricedPage: livePricedPage() });

        expect(result).toBeNull();
        expect(error).toBeInstanceOf(VendorAutomationError);
        const failure = error as VendorAutomationError;
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: {
            terminalState: "selector_drift",
            reason: "price_currency_unverified",
            priceSelector: FICTIV_LOCATORS.selectedPriceText[1],
            priceCurrency: null,
            pricingContext: { currency: null, currencySource: null, currencyConflict: false, productionPriceStatement: true },
          },
        });
        expect(failure.payload).not.toHaveProperty("totalPriceUsd");
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
        expect(failure.artifacts.map((artifact) => artifact.label)).toContain("missing-price-dom");
      });

      it("returns configuration_required, unpriced, on the 02:46Z result page as captured ($ -- and the configure prompt)", async () => {
        const unpriced = LIVE_OPTIONS.map((option) => ({ ...option, price: "$ --" }));
        const { result, error } = await runProcessFirstQuote({
          pricedPage: livePricedPage({
            panel: livePanel(unpriced),
            extra: "<div>Please configure all parts in order to receive a quote and lead time options.</div>",
          }),
        });

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "manual_review_pending",
          totalPriceUsd: null,
          offers: [],
          rawPayload: { resultClassification: "configuration_required" },
        });
      });

      it("fails closed as selected_price_missing when the selected option still reads $ --", async () => {
        const unpriced = LIVE_OPTIONS.map((option) => ({ ...option, price: "$ --" }));
        const { result, error } = await runProcessFirstQuote({ pricedPage: livePricedPage({ panel: livePanel(unpriced), extra: USD_SELECTOR }) });

        expect(result).toBeNull();
        expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "selected_price_missing" } });
      });

      it.each([
        { label: "a currency selector reading USD", extra: USD_SELECTOR, currencySource: "currency_hook" },
        { label: "a currency label", extra: '<div aria-label="Account currency">Currency: USD</div>', currencySource: "currency_hook" },
        { label: "a statement that prices are in USD", extra: "<div>All prices shown in USD.</div>", currencySource: "page_text" },
        { label: "a summary total labeled (USD)", extra: "<div>Subtotal (USD)</div>", currencySource: "page_text" },
      ])("prices a quantity of 1 from the live price spans once the page names USD: $label", async ({ extra, currencySource }) => {
        const { result, error } = await runProcessFirstQuote({ pricedPage: livePricedPage({ extra }) });

        expect(error).toBeNull();
        expect(result).toMatchObject({
          status: "instant_quote_received",
          totalPriceUsd: 412.3,
          unitPriceUsd: 412.3,
          leadTimeBusinessDays: 4,
          quoteUrl: QUOTE_URL,
          rawPayload: {
            priceCurrency: "USD",
            priceCurrencySource: "page_context",
            priceBasis: "total",
            pricingContext: { currency: "USD", currencySource, currencyConflict: false, productionPriceStatement: true },
          },
        });
        expect(result!.offers!.map((offer) => [offer.providerOptionId, offer.totalPriceUsd, offer.leadTimeBusinessDays])).toEqual([
          ["domestic:fastest", 412.3, 4],
          ["domestic:standard", 398.1, 6],
          ["domestic:cost_effective", 377, 8],
          ["overseas:fastest", 350, 6],
          ["overseas:standard", 301.25, 9],
          ["overseas:cost_effective", 280.4, 13],
        ]);
        expect(result!.offers![0].provenance.containerSelector).toBe('[data-test-target="quote-level-lead-time-selected-option"]');
      });

      it("reads the selected overseas option's region from its data-name, which its text never names", async () => {
        const options = LIVE_OPTIONS.map((option) => ({ ...option, selected: option.key === "overseasStandard" }));
        const { result, error } = await runProcessFirstQuote({ pricedPage: livePricedPage({ panel: livePanel(options), extra: USD_SELECTOR }) });

        expect(error).toBeNull();
        expect(result).toMatchObject({ status: "instant_quote_received", totalPriceUsd: 301.25, leadTimeBusinessDays: 9 });
        expect(result!.offers![0]).toMatchObject({ providerOptionId: "overseas:standard", totalPriceUsd: 301.25, sourcing: "overseas" });
      });

      it.each([
        {
          label: "another currency shows next to an amount",
          scenario: { requestedQuantity: 1, extra: `${USD_SELECTOR}<div>Shipping estimate CAD $25.00</div>` },
          reason: "price_currency_unverified",
          pricingContext: { currency: null, currencyConflict: true },
        },
        {
          label: "a euro sign shows",
          scenario: { requestedQuantity: 1, extra: `${USD_SELECTOR}<div>€ 12.00</div>` },
          reason: "price_currency_unverified",
          pricingContext: { currency: null, currencyConflict: true },
        },
        {
          label: "the currency selector reads another currency",
          scenario: { requestedQuantity: 1, extra: '<div data-test-target="quote-currency-selector"><span>CAD</span></div>' },
          reason: "price_currency_unverified",
          pricingContext: { currency: null, currencyConflict: true },
        },
        {
          // A unit price and a total are the same amount only for one part.
          label: "a quantity of 5 is requested",
          scenario: { requestedQuantity: 5, extra: USD_SELECTOR },
          reason: "price_basis_unverified",
          pricingContext: { currency: "USD", productionPriceStatement: true },
        },
        {
          label: "the panel does not say what its prices are",
          scenario: { requestedQuantity: 1, extra: USD_SELECTOR, header: "<div><span>Select regional preference</span></div>" },
          reason: "price_basis_unverified",
          pricingContext: { currency: "USD", productionPriceStatement: false },
        },
      ])("fails closed on the live price spans when $label", async ({ scenario, reason, pricingContext }) => {
        const { result, error } = await runProcessFirstQuote({
          requestedQuantity: scenario.requestedQuantity,
          quantityControl: "select_quantity",
          pricedPage: livePricedPage({ panel: livePanel(LIVE_OPTIONS, scenario.header), extra: scenario.extra }),
        });

        expect(result).toBeNull();
        expect(error).toBeInstanceOf(VendorAutomationError);
        const failure = error as VendorAutomationError;
        expect(failure).toMatchObject({
          code: "unexpected_ui_state",
          payload: { terminalState: "selector_drift", reason, pricingContext },
        });
        expect(failure.payload).not.toHaveProperty("totalPriceUsd");
        expect(evaluateProviderAdapterFailureContract(failure)).toMatchObject({ ok: true, terminalState: "selector_drift" });
      });

      it("never reads a bare dollar amount as USD outside Fictiv's lead-time price span", async () => {
        const { result, error } = await runProcessFirstQuote({
          pricedPage: pricedPage({
            selection: '<div data-test-target="quote-level-lead-time-price-selected">$412.30</div>',
            extra: USD_SELECTOR,
          }),
        });

        expect(result).toBeNull();
        expect(error).toMatchObject({
          payload: { reason: "price_currency_unverified", priceSelector: FICTIV_LOCATORS.selectedPriceText[0] },
        });
      });
    });
  });

  it("maps account capability limitations to manual_review_pending with explicit classification", async () => {
    const workerTempDir = await makeTempDir();
    const page = createFakePage({
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "CNC machining is not available for your account. Contact your account manager."],
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
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
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "RFQ required for this part."],
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
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
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "CNC machining is not available for your account. Contact your account manager."],
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
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
      bodyTextSequence: [FRESH_UPLOAD_PAGE, "CNC machining is not available for your account. Contact your account manager."],
      selectorBehaviors: {
        [FICTIV_LOCATORS.processButtons[0]]: { count: 1, text: "CNC" },
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

    await setFilesOnUpload({ page: page as never }, ["/tmp/part.step"], gate);

    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["gate", "upload"]);
  });

  it("stops the upload when a hold lands while the locator loop waits", async () => {
    const { page, setInputFiles } = fakeUploadPage({ appearsAfterWaits: 1 });
    const hold = new Error("export_review_pending");
    const gate = vi.fn(async () => {
      throw hold;
    });

    await expect(setFilesOnUpload({ page: page as never }, ["/tmp/part.step"], gate)).rejects.toBe(hold);
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it("runs the read-only confirmation before the gate on each attempt, and never uploads when it refuses", async () => {
    const { page, setInputFiles } = fakeUploadPage({ appearsAfterWaits: 0 });
    const order: string[] = [];
    const gate = vi.fn(async () => {
      order.push("gate");
    });
    setInputFiles.mockImplementation(async () => {
      order.push("upload");
    });

    const result = await setFilesOnUpload({
      page: page as never,
      confirmBeforeAttempt: async () => {
        order.push("confirm");
        return { observedProcessBeforeUpload: "CNC Machining" };
      },
    }, ["/tmp/part.step"], gate);

    expect(order).toEqual(["confirm", "gate", "upload"]);
    expect(result.confirmation).toEqual({ observedProcessBeforeUpload: "CNC Machining" });

    const refusal = new Error("upload_surface_not_fresh");
    setInputFiles.mockClear();
    gate.mockClear();
    await expect(setFilesOnUpload({
      page: page as never,
      confirmBeforeAttempt: async () => {
        throw refusal;
      },
    }, ["/tmp/part.step"], gate)).rejects.toBe(refusal);
    expect(gate).not.toHaveBeenCalled();
    expect(setInputFiles).not.toHaveBeenCalled();
  });
});
