// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  createLocalPortalBrowser,
  expectOnlyHostContacted,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  sandboxedChromiumLaunchOptions,
  type LocalPortalObserved,
} from "../../test-support/localPortalBrowserFixture";
import { weergDispatchAuthorization, weergDispatchEnvelope } from "../../test-support/weergDispatchFixture";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow";
import {
  buildWeergProductionPortalDefinition,
  WEERG_PRODUCTION_LOCATORS,
  WEERG_PRODUCTION_MATERIAL_OPTION,
} from "./weergPortal";

/**
 * OVD-675 browser fixture: drives the production Weerg definition through the
 * real portal kernel and a real Chromium against synthetic pages served for
 * https://www.weerg.com/. Every request is answered locally or aborted;
 * nothing reaches the network. The pages encode the reviewed locator table,
 * not an observation of the live portal.
 */

const launchChromium = chromium.launch.bind(chromium);
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium(sandboxedChromiumLaunchOptions());
}, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
afterAll(async () => { await browser?.close(); });

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const CAD_BYTES = "synthetic weerg cad bytes for the browser fixture";
const UPLOAD_PATH = "/en/global/quotation-tool/upload";

type Option = { id: string; label: string; quantity: string; unit: string; total: string; currency: string; lead?: string };

function optionCard(option: Option): string {
  const { fields } = WEERG_PRODUCTION_LOCATORS;
  const attr = (selector: string) => selector.slice(1, -1);
  return `<section ${WEERG_PRODUCTION_LOCATORS.optionIdAttribute}="${option.id}">
    <h3 ${attr(fields.label)}>${option.label}</h3>
    <span ${attr(fields.quantity)}>${option.quantity}</span>
    <span ${attr(fields.unitPrice)}>${option.unit}</span>
    <span ${attr(fields.totalPrice)}>${option.total}</span>
    <span ${attr(fields.currency)}>${option.currency}</span>
    <span ${attr(fields.leadBusinessDays)}>${option.lead ?? ""}</span>
  </section>`;
}

/**
 * A quotation-tool-shaped page. `afterUpload` is rendered once the CAD file
 * input changes, after the page posts the selected bytes to the provider host
 * and the reviewed material option has been chosen.
 */
function quotePage(options: { before?: string; afterUpload?: string; fileInput?: boolean; material?: boolean; extraHead?: string } = {}): string {
  const fileInput = options.fileInput === false ? "" : `<input type="file" id="cad">`;
  const material = options.material === false ? "" : `<label>Material <select name="material">
      <option value="">Choose</option>
      <option value="aluminium-7075">Aluminium 7075</option>
      <option value="${WEERG_PRODUCTION_MATERIAL_OPTION}">Aluminium 6082</option>
    </select></label>`;
  // Without a declared charset Chromium decodes "€" as mojibake, which the
  // amount parser (correctly) refuses.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Weerg quotation tool</title>${options.extraHead ?? ""}</head><body>
    <main>${options.before ?? "<p>Upload your 3D file to get an instant quote.</p>"}
    ${fileInput}${material}<label>Quantity <input name="quantity" type="number" value="1"></label>
    <div id="result"></div></main>
    <script>
      const cad = document.getElementById("cad");
      const render = () => {
        const select = document.querySelector("select[name='material']");
        if (select && select.value !== ${JSON.stringify(WEERG_PRODUCTION_MATERIAL_OPTION)}) return;
        document.getElementById("result").innerHTML = ${JSON.stringify(options.afterUpload ?? "")};
      };
      document.querySelector("select[name='material']")?.addEventListener("change", render);
      if (cad) cad.addEventListener("change", async () => {
        await fetch("/api/upload", { method: "POST", body: cad.files[0] });
        if (!document.querySelector("select[name='material']")) render();
      });
    </script></body></html>`;
}

function config(): WorkerConfig {
  return {
    workerMode: "live",
    workerLiveAdapters: ["weerg"],
    workerTempDir: os.tmpdir(),
    browserTimeoutMs: 5_000,
    playwrightHeadless: true,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: false,
    vendorStorageStateJson: {
      weerg: JSON.stringify({
        cookies: [{ name: "synthetic", value: "session", domain: "www.weerg.com", path: "/" }],
        origins: [],
      }),
    },
    vendorStorageStatePaths: {},
    vendorStorageStateDir: null,
  } as unknown as WorkerConfig;
}

async function authorizedInput(quantity = 3): Promise<VendorQuoteAdapterInput> {
  // realpath: the kernel refuses symlinked path components (macOS /var -> /private/var).
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "weerg-browser-")));
  tempDirs.push(dir);
  const localPath = path.join(dir, "part.step");
  await fs.writeFile(localPath, CAD_BYTES);
  const sha = await sha256File(localPath);
  const envelope = weergDispatchEnvelope({ cadSha256: sha, requestedQuantity: quantity });
  return {
    organizationId: envelope.subject.organizationId,
    quoteRunId: envelope.task.quoteRunId,
    requestedQuantity: quantity,
    requirement: { material: "EN AW-6082 T6" },
    executionContext: "production_dispatch",
    stagedCadFile: { originalName: "part.step", localPath, storageBucket: "job-files", storagePath: "cad/part.step", trustedContentSha256: sha },
    stagedDrawingFile: null,
    providerDispatchAuthorization: weergDispatchAuthorization(envelope),
  } as unknown as VendorQuoteAdapterInput;
}

async function quoteAgainst(page: string, quantity = 3) {
  const observed: LocalPortalObserved = { requests: [], uploads: [] };
  vi.spyOn(chromium, "launch").mockImplementation(async () =>
    createLocalPortalBrowser(browser, { pages: { [`www.weerg.com${UPLOAD_PATH}`]: page } }, observed));
  const adapter = new PortalQuoteWorkflowAdapter(
    "weerg",
    config(),
    getExtendedVendorWorkflow("weerg")!,
    buildWeergProductionPortalDefinition(),
  );
  const outcome = await adapter.quote(await authorizedInput(quantity)).then(
    (output) => ({ output, error: null }),
    (error: unknown) => ({ output: null, error: error as { code: string; payload: Record<string, unknown> } }),
  );
  return { ...outcome, observed };
}

function expectOnlyProviderHostContacted(observed: LocalPortalObserved) {
  expectOnlyHostContacted(observed, "www.weerg.com");
}

describe("Weerg production portal definition in a browser fixture (OVD-675)", () => {
  it("records an EUR quote as non-comparable native evidence with every USD field null", async () => {
    const { output, error, observed } = await quoteAgainst(quotePage({
      afterUpload: [
        optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "€ 411,50", total: "€ 1.234,50", currency: "EUR", lead: "10" }),
        optionCard({ id: "fast-5", label: "Fast", quantity: "3", unit: "616,67", total: "1850,00", currency: "EUR", lead: "5" }),
      ].join(""),
    }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      vendor: "weerg",
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      offers: [],
      rawPayload: {
        executionContext: "production_dispatch",
        adapterRevision: "weerg-production-adapter.v1",
        terminalState: "native_offers_extracted",
        reason: "native_currency_not_comparable",
        providerMutationPossible: true,
        quoteOnly: true,
        orderProhibited: true,
        nativeCurrencyQuote: { comparable: false, currency: "EUR", currencyConversion: "none" },
      },
    });
    expect(output!.notes.join(" ")).toMatch(/quoted in EUR.*not converted to USD/);
    const native = (output!.rawPayload.nativeCurrencyQuote as { offers: Array<{ providerOptionId: string; money: Record<string, unknown> }> }).offers;
    expect(native.map((offer) => [offer.providerOptionId, offer.money.currency, offer.money.unitAmount, offer.money.totalAmount]))
      .toEqual([["standard-10", "EUR", 411.5, 1234.5], ["fast-5", "EUR", 616.67, 1850]]);
    expect(JSON.stringify(output!.rawPayload.nativeCurrencyQuote)).not.toMatch(/PriceUsd/);
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([CAD_BYTES]);
    expectOnlyProviderHostContacted(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("returns comparable offers only when Weerg itself anchors USD", async () => {
    const { output, error } = await quoteAgainst(quotePage({
      afterUpload: optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "$411.50", total: "$1,234.50", currency: "USD", lead: "10" }),
    }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      status: "instant_quote_received",
      unitPriceUsd: 411.5,
      totalPriceUsd: 1234.5,
      leadTimeBusinessDays: 10,
      rawPayload: { terminalState: "offers_extracted" },
    });
    expect(output!.offers[0]).toMatchObject({ providerOptionId: "standard-10", rawPayload: { anchoredCurrency: "USD", currencyConversion: "none" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["mixed EUR and USD options", { currency: "USD", unit: "10.00", total: "30.00" }],
    ["a currency symbol without an ISO code", { currency: "€" }],
    ["an ambiguous amount", { unit: "1.000", total: "3.000" }],
    ["a total that disagrees with unit times quantity", { total: "31,00" }],
    ["another quantity", { quantity: "2" }],
  ])("withholds every offer when one card carries %s", async (_name, change) => {
    const valid: Option = { id: "standard-10", label: "Standard", quantity: "3", unit: "10,00", total: "30,00", currency: "EUR" };
    const { output, error } = await quoteAgainst(quotePage({
      afterUpload: optionCard(valid) + optionCard({ ...valid, id: "malformed", ...change }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("ends in selector drift, never an inferred price, when the cards are missing", async () => {
    const { output, error } = await quoteAgainst(quotePage({ afterUpload: "<p>Total: € 25,00 in 7 days</p>" }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops rather than quote a portal-default material when the material control is missing", async () => {
    const { output, error, observed } = await quoteAgainst(quotePage({
      material: false,
      afterUpload: optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "10,00", total: "30,00", currency: "EUR" }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "weerg_material_control_missing", providerMutationPossible: true } });
    expect(observed.uploads).toHaveLength(1);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops before upload when the CAD input is missing", async () => {
    const { error, observed } = await quoteAgainst(quotePage({ fileInput: false }));
    expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "cad_upload_selector_missing", providerMutationPossible: false } });
    expect(observed.uploads).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["an expired session", quotePage({ before: "<h1>Session expired</h1><p>Please log in again.</p>" }), "login_required", "login_required"],
    ["a bot challenge", quotePage({ before: "<p>Please verify you are human</p>" }), "captcha", "captcha"],
    ["maintenance", quotePage({ before: "<p>The quotation tool is under maintenance</p>" }), "unavailable", "unexpected_ui_state"],
  ])("ends %s in a finite terminal state without uploading", async (_name, page, terminalState, code) => {
    const { output, error, observed } = await quoteAgainst(page);
    expect(output).toBeNull();
    expect(error).toMatchObject({ code, payload: { terminalState, providerMutationPossible: false } });
    expect(observed.uploads).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("routes a post-upload engineering review to manual review", async () => {
    const { output, observed } = await quoteAgainst(quotePage({ afterUpload: "<p>Your part needs a manual review by our engineers.</p>" }));
    expect(output).toMatchObject({ status: "manual_review_pending", offers: [], rawPayload: { terminalState: "manual_review", providerMutationPossible: true } });
    expect(observed.uploads).toHaveLength(1);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("blocks a third-party request and stops without disclosing the file", async () => {
    const { output, error, observed } = await quoteAgainst(quotePage({
      extraHead: "<script src=\"https://cdn.example.com/tracker.js\"></script>",
      afterUpload: optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "10,00", total: "30,00", currency: "EUR" }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "unexpected_origin", providerMutationPossible: false } });
    expect(observed.requests).toContain("GET https://cdn.example.com/tracker.js");
    expect(observed.uploads).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
});
