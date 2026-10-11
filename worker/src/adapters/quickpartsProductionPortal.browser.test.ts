// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow";
import {
  buildQuickpartsProductionPortalDefinition,
  QUICKPARTS_PRODUCTION_LOCATORS,
} from "./quickpartsPortal";

/**
 * OVD-674 browser fixture: drives the production Quickparts definition through
 * the real portal kernel and a real Chromium against synthetic pages served for
 * https://quickquote.quickparts.com/. Every request is answered locally or
 * aborted; nothing reaches the network. The pages encode the reviewed locator
 * table, not an observation of the live portal.
 */

const launchChromium = chromium.launch.bind(chromium);
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium({
    chromiumSandbox: true,
    channel: process.env.CI === "true" && !process.env.OVD_TEST_CHROMIUM_EXECUTABLE_PATH ? "chrome" : undefined,
    executablePath: process.env.OVD_TEST_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
}, 60_000);
afterAll(async () => { await browser?.close(); });

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// Real-Chromium attempts include the kernel's bounded settle wait.
const BROWSER_TEST_TIMEOUT = 60_000;
const CAD_BYTES = "synthetic quickparts cad bytes for the browser fixture";

type Option = { id: string; label: string; quantity: string; unit: string; total: string; currency?: string; lead?: string };

function optionCard(option: Option): string {
  const { fields } = QUICKPARTS_PRODUCTION_LOCATORS;
  const attr = (selector: string) => selector.slice(1, -1);
  return `<section ${QUICKPARTS_PRODUCTION_LOCATORS.optionIdAttribute}="${option.id}">
    <h3 ${attr(fields.label)}>${option.label}</h3>
    <span ${attr(fields.quantity)}>${option.quantity}</span>
    <span ${attr(fields.unitPrice)}>${option.unit}</span>
    <span ${attr(fields.totalPrice)}>${option.total}</span>
    <span ${attr(fields.currency)}>${option.currency ?? "USD"}</span>
    <span ${attr(fields.leadBusinessDays)}>${option.lead ?? ""}</span>
  </section>`;
}

/**
 * A QuickQuote-shaped page. `afterUpload` is rendered once the CAD file input
 * changes, after the page posts the selected bytes to the provider host.
 */
function quotePage(options: { before?: string; afterUpload?: string; fileInput?: boolean; extraHead?: string } = {}): string {
  const fileInput = options.fileInput === false ? "" : `<input type="file" id="cad">`;
  return `<!doctype html><html><head><title>QuickQuote</title>${options.extraHead ?? ""}</head><body>
    <main>${options.before ?? "<p>Upload a part to get an instant quote.</p>"}
    ${fileInput}<label>Quantity <input name="quantity" type="number" value="1"></label>
    <div id="result"></div></main>
    <script>
      const cad = document.getElementById("cad");
      if (cad) cad.addEventListener("change", async () => {
        await fetch("/api/upload", { method: "POST", body: cad.files[0] });
        document.getElementById("result").innerHTML = ${JSON.stringify(options.afterUpload ?? "")};
      });
    </script></body></html>`;
}

type Served = { pages: Record<string, string> };
type Observed = { requests: string[]; uploads: Buffer[] };

/**
 * Wraps the shared browser so the kernel's own route guard still decides every
 * request: its abort stays an abort, and its `continue` is answered locally.
 */
function fixtureBrowser(served: Served, observed: Observed): Browser {
  return {
    newContext: async (options?: Parameters<Browser["newContext"]>[0]) => {
      const context: BrowserContext = await browser.newContext(options);
      const route = context.route.bind(context);
      context.route = (async (url: string, handler: (route: Route) => Promise<void>) =>
        route(url, async (real: Route) => {
          observed.requests.push(`${real.request().method()} ${real.request().url()}`);
          const local = new Proxy(real, {
            get(target, property) {
              if (property === "continue") {
                return async () => {
                  const requestUrl = new URL(target.request().url());
                  if (requestUrl.pathname === "/api/upload") {
                    observed.uploads.push(target.request().postDataBuffer() ?? Buffer.alloc(0));
                    return target.fulfill({ status: 200, body: "{}" });
                  }
                  const body = served.pages[`${requestUrl.host}${requestUrl.pathname}`];
                  return body === undefined
                    ? target.fulfill({ status: 404, body: "" })
                    : target.fulfill({ status: 200, contentType: "text/html", body });
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          await handler(local);
        })) as BrowserContext["route"];
      return context;
    },
    close: async () => undefined,
  } as unknown as Browser;
}

function config(): WorkerConfig {
  return {
    workerMode: "live",
    workerLiveAdapters: ["quickparts"],
    workerTempDir: os.tmpdir(),
    browserTimeoutMs: 5_000,
    playwrightHeadless: true,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: false,
    vendorStorageStateJson: {
      quickparts: JSON.stringify({
        cookies: [{ name: "synthetic", value: "session", domain: ".quickquote.quickparts.com", path: "/" }],
        origins: [],
      }),
    },
    vendorStorageStatePaths: {},
    vendorStorageStateDir: null,
  } as unknown as WorkerConfig;
}

async function authorizedInput(quantity = 3): Promise<VendorQuoteAdapterInput> {
  // realpath: the kernel refuses symlinked path components (macOS /var -> /private/var).
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "quickparts-browser-")));
  tempDirs.push(dir);
  const localPath = path.join(dir, "part.step");
  await fs.writeFile(localPath, CAD_BYTES);
  const sha = await sha256File(localPath);
  const envelope = quickpartsDispatchEnvelope({ cadSha256: sha, requestedQuantity: quantity });
  return {
    organizationId: envelope.subject.organizationId,
    quoteRunId: envelope.task.quoteRunId,
    requestedQuantity: quantity,
    executionContext: "production_dispatch",
    stagedCadFile: { originalName: "part.step", localPath, storageBucket: "job-files", storagePath: "cad/part.step", trustedContentSha256: sha },
    stagedDrawingFile: null,
    providerDispatchAuthorization: quickpartsDispatchAuthorization(envelope),
  } as unknown as VendorQuoteAdapterInput;
}

async function quoteAgainst(page: string, quantity = 3) {
  const observed: Observed = { requests: [], uploads: [] };
  vi.spyOn(chromium, "launch").mockImplementation(async () =>
    fixtureBrowser({ pages: { "quickquote.quickparts.com/": page } }, observed));
  const adapter = new PortalQuoteWorkflowAdapter(
    "quickparts",
    config(),
    getExtendedVendorWorkflow("quickparts")!,
    buildQuickpartsProductionPortalDefinition(),
  );
  const outcome = await adapter.quote(await authorizedInput(quantity)).then(
    (output) => ({ output, error: null }),
    (error: unknown) => ({ output: null, error: error as { code: string; payload: Record<string, unknown> } }),
  );
  return { ...outcome, observed };
}

function expectOnlyProviderHostContacted(observed: Observed) {
  expect(observed.requests.length).toBeGreaterThan(0);
  for (const request of observed.requests) {
    expect(new URL(request.split(" ")[1]).host).toBe("quickquote.quickparts.com");
  }
}

describe("Quickparts production portal definition in a browser fixture (OVD-674)", () => {
  it("uploads exactly the authorized bytes and returns normalized USD offers", async () => {
    const { output, error, observed } = await quoteAgainst(quotePage({
      afterUpload: [
        optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "$411.50", total: "$1,234.50", lead: "10" }),
        optionCard({ id: "expedite-5", label: "Expedited", quantity: "3", unit: "616.67", total: "1850.00", lead: "5" }),
      ].join(""),
    }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      vendor: "quickparts",
      status: "instant_quote_received",
      unitPriceUsd: 411.5,
      totalPriceUsd: 1234.5,
      leadTimeBusinessDays: 10,
      rawPayload: {
        executionContext: "production_dispatch",
        adapterRevision: "quickparts-production-adapter.v1",
        terminalState: "offers_extracted",
        providerMutationPossible: true,
        quoteOnly: true,
        orderProhibited: true,
      },
    });
    expect(output!.offers.map((offer) => [offer.providerOptionId, offer.unitPriceUsd, offer.totalPriceUsd, offer.leadTimeBusinessDays]))
      .toEqual([["standard-10", 411.5, 1234.5, 10], ["expedite-5", 616.67, 1850, 5]]);
    expect(output!.offers.every((offer) => offer.provenance?.priceSource === "selector")).toBe(true);
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([CAD_BYTES]);
    expectOnlyProviderHostContacted(observed);
  }, BROWSER_TEST_TIMEOUT);

  it.each([
    ["a non-USD option", { currency: "EUR" }],
    ["a total that disagrees with unit times quantity", { total: "$1,300.00" }],
    ["another quantity", { quantity: "2" }],
    ["an unpriced option", { unit: "Request quote" }],
  ])("withholds every offer when one card carries %s", async (_name, change) => {
    const valid: Option = { id: "standard-10", label: "Standard", quantity: "3", unit: "10.00", total: "30.00" };
    const { output, error } = await quoteAgainst(quotePage({
      afterUpload: optionCard(valid) + optionCard({ ...valid, id: "malformed", ...change }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, BROWSER_TEST_TIMEOUT);

  it("ends in selector drift, never an inferred price, when the cards are missing", async () => {
    const { output, error } = await quoteAgainst(quotePage({ afterUpload: "<p>Your price: $25.00 in 7 days</p>" }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, BROWSER_TEST_TIMEOUT);

  it("stops before upload when the CAD input is missing", async () => {
    const { error, observed } = await quoteAgainst(quotePage({ fileInput: false }));
    expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "cad_upload_selector_missing", providerMutationPossible: false } });
    expect(observed.uploads).toEqual([]);
  }, BROWSER_TEST_TIMEOUT);

  it.each([
    ["an expired session", quotePage({ before: "<h1>Sign in</h1><input type=\"password\">" }), "login_required", "login_required"],
    ["a bot challenge", quotePage({ before: "<p>Please verify you are human</p>" }), "captcha", "captcha"],
    ["maintenance", quotePage({ before: "<p>QuickQuote is down for maintenance</p>" }), "unavailable", "unexpected_ui_state"],
  ])("ends %s in a finite terminal state without uploading", async (_name, page, terminalState, code) => {
    const { output, error, observed } = await quoteAgainst(page);
    expect(output).toBeNull();
    expect(error).toMatchObject({ code, payload: { terminalState, providerMutationPossible: false } });
    expect(observed.uploads).toEqual([]);
  }, BROWSER_TEST_TIMEOUT);

  it("routes a post-upload engineering review to manual review", async () => {
    const { output, observed } = await quoteAgainst(quotePage({ afterUpload: "<p>Quote request received. Our engineering review team will follow up.</p>" }));
    expect(output).toMatchObject({ status: "manual_review_pending", offers: [], rawPayload: { terminalState: "manual_review", providerMutationPossible: true } });
    expect(observed.uploads).toHaveLength(1);
  }, BROWSER_TEST_TIMEOUT);

  it("routes a post-upload configuration prompt to manual follow-up", async () => {
    const { output } = await quoteAgainst(quotePage({ afterUpload: "<p>Select material to continue.</p>" }));
    expect(output).toMatchObject({ status: "manual_vendor_followup", offers: [], rawPayload: { terminalState: "configuration_required" } });
  }, BROWSER_TEST_TIMEOUT);

  it("blocks a third-party request and stops without disclosing the file", async () => {
    const { output, error, observed } = await quoteAgainst(quotePage({
      extraHead: "<script src=\"https://cdn.example.com/tracker.js\"></script>",
      afterUpload: optionCard({ id: "standard-10", label: "Standard", quantity: "3", unit: "10.00", total: "30.00" }),
    }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "unexpected_origin", providerMutationPossible: false } });
    expect(observed.requests).toContain("GET https://cdn.example.com/tracker.js");
    expect(observed.uploads).toEqual([]);
  }, BROWSER_TEST_TIMEOUT);
});
