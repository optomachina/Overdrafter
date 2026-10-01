// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLiveEvaluationInput, stageLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput, WorkerConfig } from "../types.js";
import { formatRow, parseSmokeArgs, runQuote, writeEvaluationResults } from "../tools/vendorWorkflowSmoke.js";
import { buildAdapterRegistry, buildLiveEvaluationAdapterRegistry } from "./index.js";
import { assertProviderAdapterContract } from "./providerAdapterContract.js";
import {
  buildExpectedProviderPortalApproval,
  normalizeAnchoredNativeOffers,
  normalizeAnchoredProviderOffers,
  type ProviderPortalNativeOfferCandidate,
  type ProviderPortalOfferCandidate,
} from "./providerPortalKernel.js";
import { assertLocalNativeCurrencyResult, type LocalNativeCurrencyEvaluationResult } from "./localEvaluationResult.js";
import * as weergPortal from "./weergPortal.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function candidate(): ProviderPortalNativeOfferCandidate {
  return {
    providerOptionId: "synthetic-standard-option",
    providerLabel: "Synthetic standard",
    quoteRef: null,
    quoteUrl: null,
    quantity: 5,
    money: {
      unitAmount: { value: 12.34, source: "selector", selector: "[data-synthetic-unit]" },
      totalAmount: { value: 61.70, source: "selector", selector: "[data-synthetic-total]" },
      unitCurrency: { value: "EUR", source: "selector", selector: "[data-synthetic-unit-currency]" },
      totalCurrency: { value: "EUR", source: "selector", selector: "[data-synthetic-total-currency]" },
    },
    leadTimeBusinessDays: { value: null, source: "none", selector: null },
    shipReceiveBy: null,
    tier: null,
    sourcing: null,
    geographicOrigin: null,
    geographicOriginSource: "none",
    containerSelector: "[data-synthetic-option]",
    providerOptionIdSource: "attribute",
    validUntil: null,
    validityDurationDays: null,
    validitySource: null,
    validityTerms: null,
    rawPayload: { ignored: "untrusted candidate payload" },
  };
}

const normalization = { expectedQuantity: 5, allowedHosts: ["www.weerg.com"] };

describe("native local money normalization", () => {
  it("preserves explicitly anchored EUR amounts, identity and unknown commercial facts", () => {
    const [offer] = normalizeAnchoredNativeOffers([candidate()], normalization);
    expect(offer).toMatchObject({
      providerOptionId: "synthetic-standard-option", quantity: 5,
      money: { currency: "EUR", unitAmount: 12.34, totalAmount: 61.70,
        provenance: { unitCurrency: { source: "selector", selector: "[data-synthetic-unit-currency]" },
          totalAmount: { source: "selector", selector: "[data-synthetic-total]" } } },
      leadTimeBusinessDays: null, geographicOrigin: "unknown", validUntil: null,
      validityDurationDays: null, validitySource: null,
    });
    expect(offer).not.toHaveProperty("unitPriceUsd");
    expect(offer).not.toHaveProperty("totalPriceUsd");
    expect(offer).not.toHaveProperty("rawPayload");
  });

  it.each([
    ["missing currency", (c: ProviderPortalNativeOfferCandidate) => { c.money.unitCurrency.value = null; }],
    ["unsupported currency", (c: ProviderPortalNativeOfferCandidate) => { c.money.unitCurrency.value = "GBP"; c.money.totalCurrency.value = "GBP"; }],
    ["currency symbol without ISO code", (c: ProviderPortalNativeOfferCandidate) => { c.money.unitCurrency.value = "€"; }],
    ["mixed currency", (c: ProviderPortalNativeOfferCandidate) => { c.money.totalCurrency.value = "USD"; }],
    ["whole-page currency", (c: ProviderPortalNativeOfferCandidate) => { c.money.unitCurrency.source = "body_text"; }],
    ["missing currency selector", (c: ProviderPortalNativeOfferCandidate) => { c.money.totalCurrency.selector = null; }],
    ["whole-page amount", (c: ProviderPortalNativeOfferCandidate) => { c.money.totalAmount.source = "body_text"; }],
    ["missing amount selector", (c: ProviderPortalNativeOfferCandidate) => { c.money.unitAmount.selector = " "; }],
    ["nonfinite amount", (c: ProviderPortalNativeOfferCandidate) => { c.money.unitAmount.value = Infinity; }],
    ["zero amount", (c: ProviderPortalNativeOfferCandidate) => { c.money.totalAmount.value = 0; }],
    ["wrong quantity", (c: ProviderPortalNativeOfferCandidate) => { c.quantity = 10; }],
    ["missing identity", (c: ProviderPortalNativeOfferCandidate) => { c.providerOptionId = null; }],
    ["missing container", (c: ProviderPortalNativeOfferCandidate) => { c.containerSelector = null; }],
  ])("fails closed for %s", (_label, mutate) => {
    const invalid = candidate();
    invalid.providerOptionId = "synthetic-second";
    mutate(invalid);
    expect(normalizeAnchoredNativeOffers([invalid], normalization)).toEqual([]);
    expect(normalizeAnchoredNativeOffers([candidate(), invalid], normalization)).toEqual([]);
  });

  it.each(["2030-01-01", "2030-01-01T12:30:45Z", "2030-01-01T12:30:45.123Z", "2030-01-01T12:30:45+02:00"])("preserves valid ISO evidence date %s", (validUntil) => {
    const option = { ...candidate(), validUntil, validitySource: "vendor_date" as const };
    expect(normalizeAnchoredNativeOffers([option], normalization)[0]?.validUntil).toBe(validUntil);
  });

  it.each(["2030-02-30", "2030-01-01T12:30:45ZZ", "2030-01-01T12:30:45", "2030-01-01T12:30:45.1234Z", "2030-01-01T12:30:45+99:00", "2030-01-01\n"])("rejects invalid ISO evidence date %j", (validUntil) => {
    const option = { ...candidate(), validUntil, validitySource: "vendor_date" as const };
    expect(normalizeAnchoredNativeOffers([option], normalization)).toEqual([]);
  });

  it("rejects duplicate identities, cross-option currencies and USD-shaped contamination", () => {
    expect(normalizeAnchoredNativeOffers([candidate(), candidate()], normalization)).toEqual([]);
    const usd = candidate();
    usd.providerOptionId = "synthetic-usd";
    usd.money.unitCurrency.value = "USD";
    usd.money.totalCurrency.value = "USD";
    expect(normalizeAnchoredNativeOffers([candidate(), usd], normalization)).toEqual([]);
    const contaminated = { ...candidate(), unitPriceUsd: 12.34, totalPriceUsd: 61.7 };
    expect(normalizeAnchoredNativeOffers([contaminated], normalization)).toEqual([]);
    expect(normalizeAnchoredProviderOffers([contaminated as unknown as ProviderPortalOfferCandidate], normalization)).toEqual([]);
  });
});

function fakeBrowser() {
  let url = "about:blank";
  const locator = {
    first: () => locator, count: vi.fn(async () => 1), fill: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    innerText: vi.fn(async () => "synthetic quote option"),
  };
  const page = {
    goto: vi.fn(async (next: string) => { url = next; }), url: () => url,
    locator: (selector: string) => selector === "input[type='password']" ? { count: async () => 0 } : locator,
    mainFrame: () => ({ url: () => url }), on: vi.fn(), close: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined), waitForTimeout: vi.fn(async () => undefined),
  } as unknown as Page;
  const context = {
    newPage: async () => page, route: vi.fn(), routeWebSocket: vi.fn(), on: vi.fn(),
    setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), close: vi.fn(async () => undefined),
  };
  return { browser: { newContext: async () => context, close: vi.fn(async () => undefined) } as unknown as Browser, locator };
}

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "native-money-evidence-")));
  directories.push(dir);
  const cadPath = path.join(dir, "synthetic.step");
  await fs.writeFile(cadPath, "synthetic local fixture only");
  const staged = await stageLiveEvaluationFiles({ cadPath, drawingPath: null, confirmedNonExportControlled: true });
  const definition = weergPortal.createWeergPortalDefinition();
  definition.selectors = { cadUpload: "[data-synthetic-upload]" };
  definition.hooks = {
    assessEligibility: () => ({ state: "eligible", reason: "synthetic_only" }),
    configure: () => undefined, classifyPortalState: () => "ready", extractOffers: () => [candidate()],
  };
  vi.spyOn(weergPortal, "createWeergPortalDefinition").mockReturnValue(definition);
  const fake = fakeBrowser();
  const launch = vi.spyOn(chromium, "launch").mockResolvedValue(fake.browser);
  const config = {
    workerMode: "live", workerLiveAdapters: ["weerg"], workerTempDir: dir,
    browserTimeoutMs: 1, playwrightHeadless: true,
    vendorStorageStateJson: { weerg: JSON.stringify({ cookies: [], origins: [] }) },
    vendorStorageStatePaths: {}, vendorStorageStateDir: null,
  } as WorkerConfig;
  const args = parseSmokeArgs(["--vendor", "weerg", "--cad", cadPath, "--quantities", "5", "--confirm-non-export-controlled"]);
  const approval = buildExpectedProviderPortalApproval(definition, {
    requestedQuantity: 5, liveEvaluationAuthorization: staged.authorization,
    providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [5] },
  } as VendorQuoteAdapterInput)!;
  return { dir, cadPath, staged, definition, fake, launch, config, args, approval };
}

describe("native currency kernel to standalone CLI boundary", () => {
  it("keeps the unmodified default Weerg path at zero session, browser and provider calls", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "weerg-no-interaction-")));
    directories.push(dir);
    const cadPath = path.join(dir, "synthetic.step");
    await fs.writeFile(cadPath, "synthetic local bytes");
    const staged = await stageLiveEvaluationFiles({ cadPath, drawingPath: null, confirmedNonExportControlled: true });
    const definition = weergPortal.createWeergPortalDefinition();
    const raw = { executionContext: "live_evaluation", requestedQuantity: 5,
      stagedCadFile: { localPath: staged.cadPath, originalName: "synthetic.step", trustedContentSha256: staged.authorization.cadFileSha256 },
      liveEvaluationAuthorization: staged.authorization,
      requirement: { material: "6061 aluminum" }, part: { quantity: 5 },
      providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [5] },
    } as VendorQuoteAdapterInput;
    raw.providerPortalApproval = buildExpectedProviderPortalApproval(definition, raw)!;
    const sessionRead = vi.fn(() => { throw new Error("Unexpected session read"); });
    const config = { workerMode: "live", workerLiveAdapters: ["weerg"], workerTempDir: dir,
      get vendorStorageStateJson() { return sessionRead(); }, get vendorStorageStatePaths() { return sessionRead(); },
    } as unknown as WorkerConfig;
    const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new Error("Unexpected browser launch"));
    const provider = vi.spyOn(definition.hooks, "extractOffers");
    vi.spyOn(weergPortal, "createWeergPortalDefinition").mockReturnValue(definition);
    try {
      const adapter = buildLiveEvaluationAdapterRegistry(config).weerg!;
      const result = await adapter.evaluateLocally!(raw);
      expect(result).toMatchObject({ status: "manual_vendor_followup", offers: [],
        rawPayload: { reason: expect.stringMatching(/^weerg_envelope_unknown:/), providerMutationPossible: false } });
      expect(sessionRead).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      const authorized = await authorizeLiveEvaluationInput(raw);
      expect(authorized).not.toBeNull();
    } finally { await staged.cleanup(); }
  });

  it("serializes native EUR through the real kernel, portal adapter, local registry and CLI writer", async () => {
    const f = await fixture();
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).toBeNull();
      expect(row.offers).toEqual([]);
      expect(row.totalPriceUsd).toBeNull();
      expect(row.unitPriceUsd).toBeNull();
      expect(row.rawPayload).toBeNull();
      expect(row.evidence.normalizedOffers).toEqual([]);
      expect(row.evidence.nativeCurrencyOffers).toMatchObject([{ providerOptionId: "synthetic-standard-option", quantity: 5,
        money: { currency: "EUR", unitAmount: 12.34, totalAmount: 61.70 },
        leadTimeBusinessDays: null, validUntil: null, validitySource: null, geographicOrigin: "unknown" }]);
      expect(formatRow(row)).toContain("total EUR 61.70 | unit EUR 12.34 | lead -");
      expect(formatRow(row)).not.toContain("$");
      expect(row.evidence.persistence).toEqual({ localOnly: true, customerOfferPersistence: false, providerAdmission: false });
      const outPath = path.join(f.dir, "cli-results.json");
      await writeEvaluationResults([row], outPath);
      const json = await fs.readFile(outPath, "utf8");
      expect(JSON.parse(json)[0].evidence.nativeCurrencyOffers).toEqual(row.evidence.nativeCurrencyOffers);
      expect(json).not.toContain(f.cadPath);
      expect(json).not.toContain("untrusted candidate payload");
      expect(json).not.toMatch(/"(?:unit|total)PriceUsd":\s*\d/);
      expect(f.fake.locator.setInputFiles).toHaveBeenCalledTimes(1);
    } finally { await f.staged.cleanup(); }
  });

  it.each(["missing", "mixed", "unanchored", "USD-lane mixture"])("withholds invalid %s currency through the complete CLI path", async (failure) => {
    const f = await fixture();
    const invalid = candidate();
    if (failure === "missing") invalid.money.totalCurrency.value = null;
    if (failure === "mixed") invalid.money.totalCurrency.value = "USD";
    if (failure === "unanchored") invalid.money.unitCurrency.source = "body_text";
    f.definition.hooks.extractOffers = () => failure === "USD-lane mixture"
      ? [candidate(), { ...candidate(), unitPriceUsd: { value: 1, source: "selector", selector: "[data-unit]" } } as unknown as ProviderPortalOfferCandidate]
      : [invalid];
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).not.toBeNull();
      expect(row.evidence.terminalState).toBe("selector_drift");
      expect(row.offers).toEqual([]);
      expect(row.evidence.nativeCurrencyOffers).toBeUndefined();
      expect(row.totalPriceUsd).toBeNull();
      expect(JSON.stringify(row)).not.toContain('"currency":"EUR"');
    } finally { await f.staged.cleanup(); }
  });

  it("keeps existing selector-anchored USD adapter and CLI serialization compatible", async () => {
    const f = await fixture();
    const { money: _money, ...common } = candidate();
    const usd: ProviderPortalOfferCandidate = { ...common,
      unitPriceUsd: { value: 20, source: "selector", selector: "[data-usd-unit]" },
      totalPriceUsd: { value: 100, source: "selector", selector: "[data-usd-total]" },
    };
    f.definition.hooks.extractOffers = () => [usd];
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).toBeNull();
      expect(row).toMatchObject({ status: "instant_quote_received", unitPriceUsd: 20, totalPriceUsd: 100 });
      expect(row.evidence.normalizedOffers).toMatchObject([{ unitPriceUsd: 20, totalPriceUsd: 100, quantity: 5 }]);
      expect(row.evidence.nativeCurrencyOffers).toBeUndefined();
      expect(formatRow(row)).toContain("total $100.00 | unit $20.00");
      const outPath = path.join(f.dir, "usd-cli-results.json");
      await writeEvaluationResults([row], outPath);
      expect(JSON.parse(await fs.readFile(outPath, "utf8"))[0]).toEqual(row);
    } finally { await f.staged.cleanup(); }
  });

  it("preserves numeric identities, valid dates, reviewed selectors and known commercial facts in written JSON", async () => {
    const f = await fixture();
    const options = ["1234567890", "9876543210"].map((providerOptionId) => ({ ...candidate(),
      providerOptionId, validUntil: "2030-01-01", validitySource: "vendor_date" as const,
      geographicOrigin: "domestic" as const, geographicOriginSource: "provider_text" as const,
      shipReceiveBy: "2029-12-15", leadTimeBusinessDays: { value: 7, source: "selector" as const, selector: "[data-lead]" },
      containerSelector: `[data-quote-option="${providerOptionId}"]`,
      money: { ...candidate().money, unitAmount: { value: 12.34, source: "selector" as const,
        selector: '[data-quote-option="standard"] [data-unit]' } },
    }));
    f.definition.hooks.extractOffers = () => options;
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).toBeNull();
      const outPath = path.join(f.dir, "structured-results.json");
      await writeEvaluationResults([row], outPath);
      const saved = JSON.parse(await fs.readFile(outPath, "utf8"))[0].evidence.nativeCurrencyOffers;
      expect(saved.map((offer: { providerOptionId: string }) => offer.providerOptionId)).toEqual(["1234567890", "9876543210"]);
      expect(saved).toMatchObject(options.map((option) => ({ providerOptionId: option.providerOptionId,
        validUntil: "2030-01-01", validitySource: "vendor_date", geographicOrigin: "domestic", shipReceiveBy: "2029-12-15",
        leadTimeBusinessDays: 7, provenance: { containerSelector: option.containerSelector, geographicOriginSource: "provider_text" },
        money: { provenance: { unitAmount: { selector: '[data-quote-option="standard"] [data-unit]' } } } })));
    } finally { await f.staged.cleanup(); }
  });

  it("preserves a vendor duration and scrubs free text without changing structured anchors", async () => {
    const f = await fixture();
    f.definition.hooks.extractOffers = () => [{ ...candidate(), validityDurationDays: 14,
      validitySource: "vendor_duration", validityTerms: "Valid for 14 days; contact synthetic@example.invalid",
      providerLabel: `Standard for synthetic@example.invalid at ${f.cadPath}`,
    }];
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).toBeNull();
      expect(row.evidence.nativeCurrencyOffers).toMatchObject([{ validityDurationDays: 14,
        validitySource: "vendor_duration", validUntil: null, validityTerms: expect.stringContaining("Valid for 14 days") }]);
      const json = JSON.stringify(row);
      expect(json).not.toContain("synthetic@example.invalid");
      expect(json).not.toContain(f.cadPath);
    } finally { await f.staged.cleanup(); }
  });

  it.each(["email", "path", "credential selector", "API_KEY", "api-key", "accessToken", "customer_id", "data-quote-id"])("withholds sensitive structured %s instead of corrupting its provenance", async (shape) => {
    const f = await fixture();
    const option = candidate();
    if (shape === "email") option.providerOptionId = "synthetic@example.invalid";
    if (shape === "path") option.money.unitAmount.selector = `[data-file="${f.cadPath}"]`;
    if (shape === "credential selector") option.containerSelector = '[data-session-token="synthetic-value"]';
    if (!["email", "path", "credential selector"].includes(shape)) option.containerSelector = `[${shape}="synthetic-value"]`;
    f.definition.hooks.extractOffers = () => [option];
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).not.toBeNull();
      expect(row.evidence.nativeCurrencyOffers).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain("synthetic@example.invalid");
      expect(JSON.stringify(row)).not.toContain(f.cadPath);
      expect(JSON.stringify(row)).not.toContain("synthetic-value");
    } finally { await f.staged.cleanup(); }
  });

  const embeddedAddresses = [
    "@synthetic@example.invalid", "synthetic@example.invalid.", "@@synthetic@example.invalid..",
    "(synthetic@example.invalid)", "<synthetic@example.invalid>", '"synthetic@example.invalid",',
    '[data-label="synthetic@example.invalid"]', "first@nowhere;synthetic@example.invalid.",
    "prefix:synthetic@example.invalid;suffix", "prefix synthetic@example.invalid suffix",
    "prefix\t@synthetic@example.invalid.\tsuffix", "（synthetic+tag@example.invalid）",
    "a@b@synthetic@example.invalid.", "synthetic@example.invalid@@tail", ".synthetic@example.invalid",
    `${"@".repeat(900)}synthetic@example.invalid.`,
  ];
  const addressCases = embeddedAddresses.flatMap((value, index) => [
    { field: "identity", value, index }, { field: "container", value, index }, { field: "amount selector", value, index },
  ]);
  it.each(addressCases)("withholds embedded email case $index in $field through actual JSON serialization", async ({ field, value }) => {
    const f = await fixture();
    const option = candidate();
    if (field === "identity") option.providerOptionId = value;
    if (field === "container") option.containerSelector = value;
    if (field === "amount selector") option.money.unitAmount.selector = value;
    f.definition.hooks.extractOffers = () => [option];
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).not.toBeNull();
      const outPath = path.join(f.dir, "private-structured-result.json");
      await writeEvaluationResults([row], outPath);
      const json = await fs.readFile(outPath, "utf8");
      expect(JSON.parse(json)[0].evidence.nativeCurrencyOffers).toBeUndefined();
      expect(json).not.toContain("example.invalid");
    } finally { await f.staged.cleanup(); }
  });

  it.each(["1234567890", "synthetic@option", "@synthetic", "synthetic@example", "synthetic.example"])("retains safe non-address structured identity %s", async (providerOptionId) => {
    const f = await fixture();
    f.definition.hooks.extractOffers = () => [{ ...candidate(), providerOptionId,
      validUntil: "2030-01-01", validitySource: "vendor_date",
      containerSelector: '[data-quote-option="standard"] [data-unit]',
    }];
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).toBeNull();
      expect(row.evidence.nativeCurrencyOffers).toMatchObject([{ providerOptionId,
        validUntil: "2030-01-01", provenance: { containerSelector: '[data-quote-option="standard"] [data-unit]' } }]);
    } finally { await f.staged.cleanup(); }
  });

  it.each([
    ["object-valued geography", { geographicOrigin: { currency: "EUR", unitPriceUsd: 12.34, totalPriceUsd: 61.7 }, geographicOriginSource: "provider_text" }],
    ["known geography without source", { geographicOrigin: "domestic", geographicOriginSource: "none" }],
    ["unknown geography with source", { geographicOrigin: "unknown", geographicOriginSource: "provider_text" }],
    ["nonfinite duration", { validityDurationDays: Infinity, validitySource: "vendor_duration" }],
    ["negative duration", { validityDurationDays: -1, validitySource: "vendor_duration" }],
    ["fractional duration", { validityDurationDays: 1.5, validitySource: "vendor_duration" }],
    ["invalid date", { validUntil: "2030-02-30", validitySource: "vendor_date" }],
    ["date without source", { validUntil: "2030-01-01", validitySource: null }],
    ["duration without source", { validityDurationDays: 7, validitySource: null }],
    ["date source without date", { validUntil: null, validitySource: "vendor_date" }],
    ["object-valued tier", { tier: { rawPayload: { totalPriceUsd: 61.7 } } }],
  ])("rejects native candidate %s instead of silently changing facts", async (_label, fields) => {
    const f = await fixture();
    const malformed = { ...candidate(), ...fields } as unknown as ProviderPortalNativeOfferCandidate;
    expect(normalizeAnchoredNativeOffers([malformed], normalization)).toEqual([]);
    f.definition.hooks.extractOffers = () => [malformed];
    try {
      const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
      expect(row.error).not.toBeNull();
      expect(row.evidence.nativeCurrencyOffers).toBeUndefined();
      expect(row.rawPayload).toBeNull();
    } finally { await f.staged.cleanup(); }
  });

  it("rejects malformed native results before CLI serialization, including USD/raw-payload contamination", async () => {
    const f = await fixture();
    const row = await runQuote(f.config, f.args, "weerg", 5, f.staged, undefined, null, f.approval);
    const result: LocalNativeCurrencyEvaluationResult = {
      kind: "local_native_currency_evaluation", contractRevision: "local-native-currency-evidence.v1",
      executionContext: "live_evaluation", localOnly: true, customerOfferPersistence: false, providerAdmission: false,
      providerMutationPossible: true, vendor: "weerg", status: "native_offers_extracted",
      nativeOffers: row.evidence.nativeCurrencyOffers!, artifacts: [], manifestRevision: "synthetic.v1",
      envelopeRevision: "synthetic.v1", adapterRevision: "synthetic.v1",
    };
    const input = { requestedQuantity: 5, executionContext: "live_evaluation" } as VendorQuoteAdapterInput;
    const corruptions = [
      { ...result, rawPayload: { money: result.nativeOffers[0].money } },
      { ...result, unitPriceUsd: 12.34, totalPriceUsd: 61.7 },
      { ...result, artifacts: [{ kind: "json", label: "synthetic", localPath: "/tmp/synthetic", contentType: { totalPriceUsd: 61.7 } }] },
      { ...result, artifacts: [{ kind: "json", label: "synthetic", localPath: "/tmp/synthetic", contentType: "application/json", extra: { rawPayload: "secret" } }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], geographicOrigin: { rawPayload: { totalPriceUsd: 61.7 } } }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], geographicOrigin: "domestic" }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], validityDurationDays: Infinity, validitySource: "vendor_duration" }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], validUntil: "2030-01-01", validitySource: null }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], provenance: { ...result.nativeOffers[0].provenance, unchecked: { totalPriceUsd: 61.7 } } }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], money: { ...result.nativeOffers[0].money, provenance: {
        ...result.nativeOffers[0].money.provenance, unchecked: { rawPayload: "secret" } } } }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], artifactRefs: [{ rawPayload: "secret" }] }] },
      { ...result, localOnly: false },
      { ...result, customerOfferPersistence: true },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], quantity: 10 }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], money: { ...result.nativeOffers[0].money, currency: "GBP" } }] },
      { ...result, nativeOffers: [{ ...result.nativeOffers[0], money: { ...result.nativeOffers[0].money, provenance: {} } }] },
      { ...result, nativeOffers: [result.nativeOffers[0], { ...result.nativeOffers[0], providerOptionId: "synthetic-second",
        money: { ...result.nativeOffers[0].money, currency: "USD" } }] },
    ];
    try {
      for (const corrupt of corruptions) {
        const malformed = corrupt as unknown as LocalNativeCurrencyEvaluationResult;
        expect(() => assertLocalNativeCurrencyResult(malformed, input, "weerg")).toThrow();
        const injected = buildLiveEvaluationAdapterRegistry(f.config).weerg!;
        injected.evaluateLocally = async () => malformed;
        const rejected = await runQuote(f.config, f.args, "weerg", 5, f.staged, () => ({ weerg: injected }), null, f.approval);
        expect(rejected.error).not.toBeNull();
        expect(rejected.offers).toEqual([]);
        expect(rejected.evidence.nativeCurrencyOffers).toBeUndefined();
        expect(rejected.rawPayload).toBeNull();
      }
    } finally { await f.staged.cleanup(); }
  });

  it("refuses native results at quote() and the customer USD contract", async () => {
    const f = await fixture();
    const input = {
      executionContext: "live_evaluation", requestedQuantity: 5,
      stagedCadFile: { localPath: f.staged.cadPath, originalName: "synthetic.step", trustedContentSha256: f.staged.authorization.cadFileSha256 },
      liveEvaluationAuthorization: f.staged.authorization, providerPortalApproval: f.approval,
      providerPortalExecutionScope: { cadPath: f.cadPath, drawingPath: null, requestedQuantities: [5] },
    } as VendorQuoteAdapterInput;
    try {
      const adapter = buildLiveEvaluationAdapterRegistry(f.config).weerg!;
      const result = await adapter.evaluateLocally!(input);
      expect(result).toMatchObject({ kind: "local_native_currency_evaluation", localOnly: true });
      expect(() => assertProviderAdapterContract({ definition: f.definition, adapterInput: input,
        output: result as unknown as VendorQuoteAdapterOutput })).toThrow();
      const usdOutput = {
        vendor: "weerg", status: "manual_vendor_followup", unitPriceUsd: null, totalPriceUsd: null,
        leadTimeBusinessDays: null, quoteUrl: null, offers: [], dfmIssues: [], notes: [], artifacts: [],
        rawPayload: { nested: { result } },
      } as VendorQuoteAdapterOutput;
      expect(() => assertProviderAdapterContract({ definition: f.definition, adapterInput: input,
        output: usdOutput })).toThrow("native_currency_evidence_is_local_only");
      await expect(adapter.quote(input)).rejects.toMatchObject({ payload: { reason: "native_currency_requires_local_result" } });
      const productionInput = { ...input, executionContext: "production_dispatch" } as VendorQuoteAdapterInput;
      await expect(adapter.evaluateLocally!(productionInput)).rejects.toBeDefined();
      const before = f.launch.mock.calls.length;
      await expect(buildAdapterRegistry(f.config).weerg!.quote(productionInput)).rejects.toBeDefined();
      expect(f.launch).toHaveBeenCalledTimes(before);
    } finally { await f.staged.cleanup(); }
  });
});
