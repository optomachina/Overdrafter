// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles.js";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import {
  createLocalPortalBrowser,
  expectOnlyHostContacted,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  sandboxedChromiumLaunchOptions,
  type LocalPortalObserved,
} from "../../test-support/localPortalBrowserFixture.js";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows.js";
import { buildGeomiqProductionPortalDefinition } from "./geomiqProductionPortal.js";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow.js";
import { buildExpectedProviderPortalApproval } from "./providerPortalKernel.js";

/**
 * OVD-1058: the Geomiq definition against a synthetic page shaped like the
 * public buyer-app markup (test ids, the hidden upload input, the searchable
 * material dropdown, the selected part row with label/value paragraphs). The
 * page, prices and part name are invented; every request is answered locally,
 * so nothing reaches Geomiq. It proves the selectors and terminal states, not
 * live Geomiq behaviour.
 */

const CAD_BYTES = "synthetic geomiq cad bytes for the browser fixture";
const STEM = "synthetic-geomiq-part";
const timeout = PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS;

type PageOptions = {
  signedIn?: boolean;
  otherPartSelected?: boolean;
  materials?: Array<[label: string, enNumber: string]>;
  price?: { unit: string; subtotal: string } | { status: string };
  uploadUrl?: string;
};

function quotePage(options: PageOptions = {}): string {
  const materials = options.materials ?? [["Aluminium 6061", "3.3211"], ["Aluminium 6061 T3", "3.3214"], ["Aluminium 6061 T6", "3.3216"]];
  const price = options.price ?? { unit: "US$42.50", subtotal: "US$42.50" };
  const priced = "status" in price
    ? `<p class="quote-status-field">${price.status}</p>`
    : `<div><p>Price per unit:</p><p> ${price.unit} </p><p>Subtotal:</p><p> ${price.subtotal} </p></div>`;
  const nav = options.signedIn === false
    ? `<button data-testid="login-button">Login</button>`
    : `<div data-testid="menu-dropdown">Account</div>`;
  const otherPart = options.otherPartSelected
    ? `<div data-testid="single-part-row" class="part-row is-selected">previous-draft</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Geomiq</title></head><body>
    <nav>${nav}</nav>
    <div data-testid="main-upload" class="field file-upload">
      <input type="file" class="hidden-input" style="display:none" data-testid="main-upload-hidden-input" accept=".stp,.step">
    </div>
    <section id="rows">${otherPart}</section>
    <section id="configurator"></section>
    <script>
      const materials = ${JSON.stringify(materials)};
      const input = document.querySelector("[data-testid='main-upload-hidden-input']");
      input.addEventListener("change", async () => {
        await fetch(${JSON.stringify(options.uploadUrl ?? "/api/upload")}, { method: "PUT", body: input.files[0] });
        document.getElementById("rows").insertAdjacentHTML("beforeend", \`
          <div data-testid="single-part-row" class="part-row is-selected">
            <p>${STEM}</p>
            <div><p>Service:</p><p>CNC</p></div>
            <div><p>Material:</p><p id="row-material"> Aluminium 6061 </p></div>
            <div><p>Shipping in:</p><p> 10 business days </p></div>
            <div class="number-input-wrapper"><input type="number" id="quantity_initial" value="1"></div>
            <div id="row-price"><span class="quote-status-field">Pricing part</span></div>
          </div>\`);
        document.getElementById("configurator").innerHTML = \`
          <div class="number-input-wrapper"><input type="number" id="quantity_initial" value="1"></div>
          <div class="g-input-dropdown">
            <div class="selected"><button id="material-label">Aluminium 6061</button></div>
            <div class="dropdown" style="display:none"><input type="text"></div>
            <div class="options" id="options-material-input-dropdown" style="display:none"></div>
          </div>
          <button class="select-target" entity="primary-finish"><p data-testid="configurator-preselected"><span title="As Machined">As Machined</span></p></button>\`;
        const search = document.querySelector(".g-input-dropdown .dropdown");
        const options = document.getElementById("options-material-input-dropdown");
        document.getElementById("material-label").addEventListener("click", () => {
          search.style.display = "flex";
          options.style.display = "block";
        });
        search.querySelector("input").addEventListener("input", (event) => {
          options.innerHTML = materials
            .filter(([label]) => label.toLowerCase().includes(event.target.value.toLowerCase().slice(0, 9)))
            .map(([label, number]) => '<button class="dont-close option"><div> ' + label + ' <p>' + number + ' / Al-Mg1SiCu</p></div><span>££</span></button>')
            .join("");
          for (const button of options.querySelectorAll("button.option")) {
            button.addEventListener("click", () => {
              search.style.display = "none";
              options.style.display = "none";
              const label = button.querySelector("div").firstChild.textContent.trim();
              document.getElementById("row-material").textContent = " " + label + " ";
              document.getElementById("row-price").innerHTML = '<span class="quote-status-field">Updating part</span>';
              setTimeout(() => { document.getElementById("row-price").innerHTML = ${JSON.stringify(priced)}; }, 500);
            });
          }
        });
      });
    </script></body></html>`;
}

let browser: Browser;
const launchChromium = chromium.launch.bind(chromium);
const tempDirs: string[] = [];
beforeAll(async () => { browser = await launchChromium(sandboxedChromiumLaunchOptions()); }, timeout);
afterAll(async () => { await browser?.close(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function evaluationInput(): Promise<VendorQuoteAdapterInput> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geomiq-browser-")));
  tempDirs.push(dir);
  const cadPath = path.join(dir, `${STEM}.step`);
  await fs.writeFile(cadPath, CAD_BYTES);
  const digest = await sha256File(cadPath);
  const input = await authorizeLiveEvaluationInput({
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: digest, drawingFileSha256: null },
    providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [1] },
    stagedCadFile: { originalName: `${STEM}.step`, localPath: cadPath, trustedContentSha256: digest },
    stagedDrawingFile: null,
    requestedQuantity: 1,
    requirement: { material: "6061 aluminum", finish: "as machined" },
  } as VendorQuoteAdapterInput);
  if (!input) throw new Error("Synthetic input authorization failed");
  input.providerPortalApproval = buildExpectedProviderPortalApproval(buildGeomiqProductionPortalDefinition(), input)!;
  return input;
}

function config(): WorkerConfig {
  return {
    workerMode: "live",
    workerLiveAdapters: ["geomiq"],
    workerTempDir: os.tmpdir(),
    browserTimeoutMs: 5_000,
    playwrightHeadless: true,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: false,
    vendorStorageStateJson: {
      geomiq: JSON.stringify({ cookies: [{ name: "synthetic", value: "session", domain: ".geomiq.com", path: "/" }], origins: [] }),
    },
    vendorStorageStatePaths: {},
    vendorStorageStateDir: null,
  } as unknown as WorkerConfig;
}

async function quoteAgainst(page: string) {
  const observed: LocalPortalObserved = { requests: [], uploads: [] };
  vi.spyOn(chromium, "launch").mockImplementation(async () =>
    createLocalPortalBrowser(browser, { pages: { "app.geomiq.com/quotes": page } }, observed));
  const adapter = new PortalQuoteWorkflowAdapter("geomiq", config(), getExtendedVendorWorkflow("geomiq")!, buildGeomiqProductionPortalDefinition());
  const outcome = await adapter.evaluateLocally(await evaluationInput()).then(
    (output) => ({ output, error: null }),
    (error: unknown) => ({ output: null, error: error as { code: string; payload: Record<string, unknown> } }),
  );
  return { ...outcome, observed };
}

describe("Geomiq production portal definition in a browser fixture (OVD-1058)", () => {
  it("uploads to the app host, selects Aluminium 6061 T6 and reads the settled USD row", async () => {
    const { output, error, observed } = await quoteAgainst(quotePage());
    expect(error).toBeNull();
    expect(output).toMatchObject({
      status: "instant_quote_received", unitPriceUsd: 42.5, totalPriceUsd: 42.5, leadTimeBusinessDays: 10,
      offers: [expect.objectContaining({ providerOptionId: "subtotal", quantity: 1 })],
      rawPayload: { terminalState: "offers_extracted", providerMutationPossible: true },
    });
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([CAD_BYTES]);
    expectOnlyHostContacted(observed, "app.geomiq.com");
  }, timeout);

  it("records a GBP quote as native local evidence, never as USD", async () => {
    const { output, error } = await quoteAgainst(quotePage({ price: { unit: "£42.50", subtotal: "£42.50" } }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      kind: "local_native_currency_evaluation", status: "native_offers_extracted", localOnly: true, customerOfferPersistence: false,
      nativeOffers: [expect.objectContaining({ quantity: 1, money: expect.objectContaining({ currency: "GBP", unitAmount: 42.5, totalAmount: 42.5 }) })],
    });
    expect(JSON.stringify(output)).not.toContain("PriceUsd");
  }, timeout);

  it("routes a manual quote to manual review", async () => {
    const { error } = await quoteAgainst(quotePage({ price: { status: "Manual quote needed" } }));
    expect(error).toMatchObject({ payload: { terminalState: "manual_review", reason: "geomiq_manual_quote_needed" } });
  }, timeout);

  it("ends in configuration_required, never another material, when 6061 T6 is not offered", async () => {
    const { error, observed } = await quoteAgainst(quotePage({ materials: [["Aluminium 6061", "3.3211"], ["Aluminium 6082", "3.2315"]] }));
    expect(error).toMatchObject({
      payload: { terminalState: "configuration_required", reason: "geomiq_material_6061_t6_not_offered", providerMutationPossible: true },
    });
    expect(observed.uploads).toHaveLength(1);
  }, timeout);

  it.each([
    ["an anonymous session", { signedIn: false }, "login_required", "geomiq_session_anonymous"],
    ["another selected draft part", { otherPartSelected: true }, "configuration_required", "geomiq_other_part_selected"],
  ] as const)("stops on %s before uploading", async (_name, options, terminalState, reason) => {
    const { error, observed } = await quoteAgainst(quotePage(options));
    expect(error).toMatchObject({ payload: { terminalState, reason, providerMutationPossible: false } });
    expect(observed.uploads).toEqual([]);
  }, timeout);

  // The kernel reports the blocked request after the bounded configurator wait (quantityAwaitMs).
  it("stops at an undeclared upload host instead of sending the file there", async () => {
    const { error, observed } = await quoteAgainst(quotePage({ uploadUrl: "https://uploads.example.com/signed" }));
    expect(error).toMatchObject({ payload: { terminalState: "unexpected_origin", reason: "unexpected_request:uploads.example.com" } });
    expect(observed.uploads).toEqual([]);
  }, 2 * timeout);
});
