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
  /** `unit` is per part; the fixture renders the subtotal from the configurator's quantity. */
  price?: { symbol: string; unit: number } | { status: string };
  uploadUrl?: string;
  /** After upload the app restores a previous draft's selection instead of selecting the new part. */
  restoredSelection?: boolean;
  /** After upload the header turns anonymous while the rows stay on screen. */
  sessionExpiresAfterUpload?: boolean;
};

/** Each configurator write is saved as `PATCH /api/drafts/<selected part>/<field>`, so tests see which draft changed. */
const draftWrites = (observed: LocalPortalObserved) => observed.requests.filter((request) => request.includes("/api/drafts/"));

function quotePage(options: PageOptions = {}): string {
  const materials = options.materials
    ?? [["Aluminium 6061 T651", "3.3216"], ["Aluminium 6061", "3.3211"], ["Aluminium 6061 T3", "3.3214"], ["Aluminium 6061 T6", "3.3216"]];
  const price = options.price ?? { symbol: "US$", unit: 42.5 };
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
      const price = ${JSON.stringify(price)};
      const configuredQuantity = () => Number(document.querySelector("#configurator input#quantity_initial").value);
      const money = (amount) => (price.symbol ?? "US$") + amount.toFixed(2);
      const showPrice = (unit) => {
        document.getElementById("row-price").innerHTML = '<div><p>Price per unit:</p><p> ' + money(unit) + ' </p><p>Subtotal:</p><p> ' + money(unit * configuredQuantity()) + ' </p></div>';
      };
      let selected = ${JSON.stringify(STEM)};
      const saveDraft = (field) => fetch("/api/drafts/" + selected + "/" + field, { method: "PATCH", body: "{}" });
      input.addEventListener("change", async () => {
        await fetch(${JSON.stringify(options.uploadUrl ?? "/api/upload")}, { method: "PUT", body: input.files[0] });
        if (${JSON.stringify(options.sessionExpiresAfterUpload === true)}) {
          document.querySelector("nav").innerHTML = '<button data-testid="login-button">Login</button>';
        }
        if (${JSON.stringify(options.restoredSelection === true)}) {
          selected = "previous-draft";
          document.getElementById("rows").insertAdjacentHTML("beforeend", '<div data-testid="single-part-row" class="part-row is-selected"><p>previous-draft</p></div>');
        }
        document.getElementById("rows").insertAdjacentHTML("beforeend", \`
          <div data-testid="single-part-row" class="part-row \${selected === ${JSON.stringify(STEM)} ? "is-selected" : ""}">
            <p>${STEM}</p>
            <div><p>Service:</p><p>CNC</p></div>
            <div><p>Material:</p><p id="row-material"> Aluminium 6061 </p></div>
            <div><p>Shipping in:</p><p> 10 business days </p></div>
            <div class="number-input-wrapper"><input type="number" id="quantity_initial" value="7"></div>
            <div id="row-price"><span class="quote-status-field">Pricing part</span></div>
          </div>\`);
        document.getElementById("configurator").innerHTML = \`
          <div class="number-input-wrapper"><input type="number" id="quantity_initial" value="5"></div>
          <div class="g-input-dropdown">
            <div class="selected"><button id="material-label">Aluminium 6061</button></div>
            <div class="dropdown" style="display:none"><input type="text"></div>
            <div class="options" id="options-material-input-dropdown" style="display:none"></div>
          </div>
          <button class="select-target" entity="primary-finish"><p data-testid="configurator-preselected"><span title="As Machined">As Machined</span></p></button>\`;
        // The new part first prices with the default material, as the app does once analysis ends.
        setTimeout(() => showPrice(30), 300);
        document.querySelector("#configurator input#quantity_initial").addEventListener("input", () => {
          saveDraft("quantity");
          document.getElementById("row-price").innerHTML = '<span class="quote-status-field">Updating part</span>';
          setTimeout(() => showPrice(30), 500);
        });
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
              saveDraft("material");
              setTimeout(() => {
                if ("status" in price) document.getElementById("row-price").innerHTML = '<p class="quote-status-field">' + price.status + '</p>';
                else showPrice(price.unit);
              }, 500);
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
  // The page first prices the default material, then requotes on the material click; the requote is seen in
  // configure, so three equal reads settle the price. The page prices the part from the configurator's quantity (default 5) and lists "6061 T651" with the
  // same EN number first, so this passes only if the configurator, not the row (default 7), was set to 1
  // and the exact 6061 T6 option was chosen.
  it("uploads to the app host, selects Aluminium 6061 T6 and reads the settled USD row", async () => {
    const { output, error, observed } = await quoteAgainst(quotePage());
    expect(error).toBeNull();
    expect(output).toMatchObject({
      status: "instant_quote_received", unitPriceUsd: 42.5, totalPriceUsd: 42.5, leadTimeBusinessDays: 10,
      offers: [expect.objectContaining({ providerOptionId: "subtotal", quantity: 1 })],
      rawPayload: { terminalState: "offers_extracted", providerMutationPossible: true },
    });
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([CAD_BYTES]);
    expect(draftWrites(observed)).toEqual([
      `PATCH https://app.geomiq.com/api/drafts/${STEM}/quantity`, `PATCH https://app.geomiq.com/api/drafts/${STEM}/material`,
    ]);
    expectOnlyHostContacted(observed, "app.geomiq.com");
  }, 2 * timeout);

  // OVD-1058 review: the uploaded row's identity and the session are verified before any configuration write.
  it.each([
    ["a previous draft's selection restored during upload", { restoredSelection: true }, "selector_drift", "geomiq_selected_part_not_uploaded_file"],
    ["a session that expires after upload", { sessionExpiresAfterUpload: true }, "login_required", "geomiq_session_anonymous"],
  ] as const)("leaves every draft unchanged on %s", async (_name, options, terminalState, reason) => {
    const { error, observed } = await quoteAgainst(quotePage(options));
    expect(error).toMatchObject({ payload: { terminalState, reason, providerMutationPossible: true } });
    expect(observed.uploads).toHaveLength(1);
    expect(draftWrites(observed)).toEqual([]);
  }, timeout);

  it("records a GBP quote as native local evidence, never as USD", async () => {
    const { output, error } = await quoteAgainst(quotePage({ price: { symbol: "£", unit: 42.5 } }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      kind: "local_native_currency_evaluation", status: "native_offers_extracted", localOnly: true, customerOfferPersistence: false,
      nativeOffers: [expect.objectContaining({ quantity: 1, money: expect.objectContaining({ currency: "GBP", unitAmount: 42.5, totalAmount: 42.5 }) })],
    });
    expect(JSON.stringify(output)).not.toContain("PriceUsd");
  }, 2 * timeout);

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

  // Configure's first post-upload read reports the blocked request.
  it("stops at an undeclared upload host instead of sending the file there", async () => {
    const { error, observed } = await quoteAgainst(quotePage({ uploadUrl: "https://uploads.example.com/signed" }));
    expect(error).toMatchObject({ payload: { terminalState: "unexpected_origin", reason: "unexpected_request:uploads.example.com" } });
    expect(observed.uploads).toEqual([]);
  }, 2 * timeout);
});
