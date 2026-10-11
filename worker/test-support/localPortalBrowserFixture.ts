import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sha256File } from "../src/liveEvaluationFiles.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchTypes.js";
import type { ProviderDispatchEnvelope } from "../src/providerDispatchEnvelope.js";
import type { VendorName, VendorQuoteAdapterInput, VendorQuoteAdapterOutput, WorkerConfig } from "../src/types.js";
import { getExtendedVendorWorkflow } from "../src/adapters/extendedVendorWorkflows.js";
import type { ProviderPortalDefinition } from "../src/adapters/providerPortalKernel.js";
import { PortalQuoteWorkflowAdapter } from "../src/adapters/portalWorkflow.js";

export type LocalPortalServed = { pages: Record<string, string> };
export type LocalPortalObserved = { requests: string[]; uploads: Buffer[] };

export type PortalOfferLocators = {
  optionIdAttribute: string;
  fields: {
    label: string;
    quantity: string;
    unitPrice: string;
    totalPrice: string;
    currency: string;
    leadBusinessDays: string;
  };
};

export type PortalOptionCard = {
  id: string;
  label: string;
  quantity: string;
  unit: string;
  total: string;
  currency?: string;
  lead?: string;
};

export type LocalQuotePageOptions = {
  title: string;
  charset?: boolean;
  before?: string;
  afterUpload?: string;
  fileInput?: boolean;
  extraHead?: string;
  extraControls?: string;
  /** When set, after-upload HTML is applied only after this JS expression is true. */
  afterUploadWhen?: string;
};

export type LocalPortalQuoteOutcome = {
  output: VendorQuoteAdapterOutput | null;
  error: { code: string; payload: Record<string, unknown> } | null;
  observed: LocalPortalObserved;
};

/**
 * Answers kernel `continue` locally and records every request. Shared by the
 * stacked production-portal browser fixtures so each provider file keeps only
 * its locator table, hosts, and assertions.
 */
export function createLocalPortalBrowser(browser: Browser, served: LocalPortalServed, observed: LocalPortalObserved): Browser {
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

export function expectOnlyHostContacted(observed: LocalPortalObserved, host: string) {
  expect(observed.requests.length).toBeGreaterThan(0);
  for (const request of observed.requests) {
    expect(new URL(request.split(" ")[1]).host).toBe(host);
  }
}

export const PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS = 60_000;

export function sandboxedChromiumLaunchOptions() {
  return {
    chromiumSandbox: true as const,
    channel: process.env.CI === "true" && !process.env.OVD_TEST_CHROMIUM_EXECUTABLE_PATH ? "chrome" as const : undefined,
    executablePath: process.env.OVD_TEST_CHROMIUM_EXECUTABLE_PATH || undefined,
  };
}

export function productionOptionCard(locators: PortalOfferLocators, option: PortalOptionCard): string {
  const attr = (selector: string) => selector.slice(1, -1);
  return `<section ${locators.optionIdAttribute}="${option.id}">
    <h3 ${attr(locators.fields.label)}>${option.label}</h3>
    <span ${attr(locators.fields.quantity)}>${option.quantity}</span>
    <span ${attr(locators.fields.unitPrice)}>${option.unit}</span>
    <span ${attr(locators.fields.totalPrice)}>${option.total}</span>
    <span ${attr(locators.fields.currency)}>${option.currency ?? "USD"}</span>
    <span ${attr(locators.fields.leadBusinessDays)}>${option.lead ?? ""}</span>
  </section>`;
}

export function localQuotePage(options: LocalQuotePageOptions): string {
  const fileInput = options.fileInput === false ? "" : `<input type="file" id="cad">`;
  const charset = options.charset ? `<meta charset="utf-8">` : "";
  const afterUpload = JSON.stringify(options.afterUpload ?? "");
  const render = options.afterUploadWhen
    ? `const render = () => {
        const select = document.querySelector("select[name='material']");
        if (!(${options.afterUploadWhen})) return;
        document.getElementById("result").innerHTML = ${afterUpload};
      };
      document.querySelector("select[name='material']")?.addEventListener("change", render);
      if (cad) cad.addEventListener("change", async () => {
        await fetch("/api/upload", { method: "POST", body: cad.files[0] });
        if (!document.querySelector("select[name='material']")) render();
      });`
    : `if (cad) cad.addEventListener("change", async () => {
        await fetch("/api/upload", { method: "POST", body: cad.files[0] });
        document.getElementById("result").innerHTML = ${afterUpload};
      });`;
  return `<!doctype html><html><head>${charset}<title>${options.title}</title>${options.extraHead ?? ""}</head><body>
    <main>${options.before ?? ""}
    ${fileInput}${options.extraControls ?? ""}<label>Quantity <input name="quantity" type="number" value="1"></label>
    <div id="result"></div></main>
    <script>
      const cad = document.getElementById("cad");
      ${render}
    </script></body></html>`;
}

export type LocalPortalBrowserSessionSpec = {
  vendor: VendorName;
  host: string;
  pagePath: string;
  cadBytes: string;
  cookieDomain: string;
  tempPrefix: string;
  locators: PortalOfferLocators;
  buildDefinition: () => ProviderPortalDefinition;
  bindAuthorization: (binding: { cadSha256: string; requestedQuantity: number }) => {
    envelope: ProviderDispatchEnvelope;
    authorization: ProviderDispatchAuthorization;
  };
  extraInput?: Partial<VendorQuoteAdapterInput>;
};

export type LocalPortalBrowserSession = {
  cadBytes: string;
  optionCard: (option: PortalOptionCard) => string;
  quoteAgainst: (page: string, quantity?: number) => Promise<LocalPortalQuoteOutcome>;
  expectOnlyProviderHost: (observed: LocalPortalObserved) => void;
};

/**
 * Shared Chromium session, authorization staging, and quote driver. Cases stay
 * a mutation table so stacked provider PRs do not reintroduce the same fixture.
 */
export function createLocalPortalBrowserSession(spec: LocalPortalBrowserSessionSpec): LocalPortalBrowserSession {
  const launchChromium = chromium.launch.bind(chromium);
  let browser: Browser;
  const tempDirs: string[] = [];
  beforeAll(async () => {
    browser = await launchChromium(sandboxedChromiumLaunchOptions());
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function authorizedInput(quantity = 3): Promise<VendorQuoteAdapterInput> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), spec.tempPrefix)));
    tempDirs.push(dir);
    const localPath = path.join(dir, "part.step");
    await fs.writeFile(localPath, spec.cadBytes);
    const sha = await sha256File(localPath);
    const { envelope, authorization } = spec.bindAuthorization({
      cadSha256: sha,
      requestedQuantity: quantity,
    });
    return {
      organizationId: envelope.subject.organizationId,
      quoteRunId: envelope.task.quoteRunId,
      requestedQuantity: quantity,
      executionContext: "production_dispatch",
      stagedCadFile: {
        originalName: "part.step",
        localPath,
        storageBucket: "job-files",
        storagePath: "cad/part.step",
        trustedContentSha256: sha,
      },
      stagedDrawingFile: null,
      providerDispatchAuthorization: authorization,
      ...spec.extraInput,
    } as unknown as VendorQuoteAdapterInput;
  }

  function config(): WorkerConfig {
    return {
      workerMode: "live",
      workerLiveAdapters: [spec.vendor],
      workerTempDir: os.tmpdir(),
      browserTimeoutMs: 5_000,
      playwrightHeadless: true,
      playwrightDisableSandbox: false,
      playwrightDisableDevShmUsage: false,
      vendorStorageStateJson: {
        [spec.vendor]: JSON.stringify({
          cookies: [{ name: "synthetic", value: "session", domain: spec.cookieDomain, path: "/" }],
          origins: [],
        }),
      },
      vendorStorageStatePaths: {},
      vendorStorageStateDir: null,
    } as unknown as WorkerConfig;
  }

  return {
    cadBytes: spec.cadBytes,
    optionCard: (option) => productionOptionCard(spec.locators, option),
    quoteAgainst: async (page, quantity = 3) => {
      const observed: LocalPortalObserved = { requests: [], uploads: [] };
      vi.spyOn(chromium, "launch").mockImplementation(async () =>
        createLocalPortalBrowser(browser, { pages: { [`${spec.host}${spec.pagePath}`]: page } }, observed));
      const adapter = new PortalQuoteWorkflowAdapter(
        spec.vendor,
        config(),
        getExtendedVendorWorkflow(spec.vendor)!,
        spec.buildDefinition(),
      );
      const outcome = await adapter.quote(await authorizedInput(quantity)).then(
        (output) => ({ output, error: null }),
        (error: unknown) => ({ output: null, error: error as { code: string; payload: Record<string, unknown> } }),
      );
      return { ...outcome, observed };
    },
    expectOnlyProviderHost: (observed) => expectOnlyHostContacted(observed, spec.host),
  };
}

export function registerSharedPortalBrowserRefusals(
  session: LocalPortalBrowserSession,
  pages: {
    missingCards: string;
    missingCad: string;
    login: string;
    captcha: string;
    maintenance: string;
    engineeringReview: string;
    thirdParty: string;
  },
) {
  const timeout = PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS;
  const cases: Array<{
    name: string;
    page: string;
    check: (outcome: LocalPortalQuoteOutcome) => void;
  }> = [
    {
      name: "ends in selector drift, never an inferred price, when the cards are missing",
      page: pages.missingCards,
      check: ({ output, error }) => {
        expect(output).toBeNull();
        expect(error).toMatchObject({
          code: "selector_failure",
          payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" },
        });
      },
    },
    {
      name: "stops before upload when the CAD input is missing",
      page: pages.missingCad,
      check: ({ error, observed }) => {
        expect(error).toMatchObject({
          payload: { terminalState: "selector_drift", reason: "cad_upload_selector_missing", providerMutationPossible: false },
        });
        expect(observed.uploads).toEqual([]);
      },
    },
    {
      name: "routes a post-upload engineering review to manual review",
      page: pages.engineeringReview,
      check: ({ output, observed }) => {
        expect(output).toMatchObject({
          status: "manual_review_pending",
          offers: [],
          rawPayload: { terminalState: "manual_review", providerMutationPossible: true },
        });
        expect(observed.uploads).toHaveLength(1);
      },
    },
    {
      name: "blocks a third-party request and stops without disclosing the file",
      page: pages.thirdParty,
      check: ({ output, error, observed }) => {
        expect(output).toBeNull();
        expect(error).toMatchObject({ payload: { terminalState: "unexpected_origin", providerMutationPossible: false } });
        expect(observed.requests).toContain("GET https://cdn.example.com/tracker.js");
        expect(observed.uploads).toEqual([]);
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      testCase.check(await session.quoteAgainst(testCase.page));
    }, timeout);
  }

  it.each([
    ["an expired session", pages.login, "login_required", "login_required"],
    ["a bot challenge", pages.captcha, "captcha", "captcha"],
    ["maintenance", pages.maintenance, "unavailable", "unexpected_ui_state"],
  ] as const)("ends %s in a finite terminal state without uploading", async (_name, page, terminalState, code) => {
    const { output, error, observed } = await session.quoteAgainst(page);
    expect(output).toBeNull();
    expect(error).toMatchObject({ code, payload: { terminalState, providerMutationPossible: false } });
    expect(observed.uploads).toEqual([]);
  }, timeout);
}
