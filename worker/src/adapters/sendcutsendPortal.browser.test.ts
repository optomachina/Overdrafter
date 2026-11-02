// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLocalPortalBrowser,
  expectOnlyHostContacted,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  sandboxedChromiumLaunchOptions,
  type LocalPortalObserved,
} from "../../test-support/localPortalBrowserFixture";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { buildExpectedProviderPortalApproval, runProviderPortalKernel } from "./providerPortalKernel";
import { buildSendCutSendSheetPortalDefinition, filterSendCutSendStorageState } from "./sendcutsendPortal";

/**
 * OVD-1056 browser fixture: drives the SendCutSend sheet definition through
 * the real portal kernel and a real Chromium against a synthetic page served
 * for https://app.sendcutsend.com/customer. Every request is answered
 * locally or aborted; nothing reaches the network. The page encodes the
 * reviewed locator table (tile view, b-radio thickness tiles whose value is
 * a DOM property, side summary), not a copy of the live portal.
 */

const launchChromium = chromium.launch.bind(chromium);
let browser: Browser;
const tempDirs: string[] = [];
beforeAll(async () => { browser = await launchChromium(sandboxedChromiumLaunchOptions()); }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
afterAll(async () => { await browser?.close(); }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type WizardPageOptions = {
  header?: string;
  thicknesses?: string[];
  disabled?: string[];
  start?: "format" | "group";
  unitPrice?: string;
  /** Extra head markup, for example CDN stylesheets and images. */
  head?: string;
};

/** A minimal tile-view wizard: one step at a time, footer buttons that would reach the cart. */
function wizardPage(options: WizardPageOptions = {}): string {
  const config = JSON.stringify({
    start: options.start ?? "format",
    thicknesses: options.thicknesses ?? [".063", ".100", ".125", ".187"],
    disabled: options.disabled ?? [],
    unitPrice: options.unitPrice ?? "31.40",
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>SendCutSend fixture</title>${options.head ?? ""}</head><body>
    <nav><a class="navbar-item">Quote</a> ${options.header ?? "<span>Account</span>"}</nav>
    <main><p>Drop up to 10 files here to get started</p><input type="file" id="cad">
    <p>Custom quote</p><p>Have something complex? We'll quote it for you.</p>
    <div id="dialog"></div></main>
    <script>
      const cfg = ${config};
      const dialog = document.getElementById("dialog");
      const tiles = (container, tileClass, names) => '<div class="' + container + '">' + names.map((name) =>
        '<div class="quote-tile level-1 ' + tileClass + '"><div class="tile-info"><p class="title is-5">' + name + '</p><p class="subtitle is-7">about ' + name + '</p></div></div>').join("") + '</div>';
      const footer = '<footer class="quote-footer"><button class="button is-light">Close</button>' +
        '<button class="button is-sale" id="next">Add to Cart</button></footer>';
      const steps = {
        format: () => '<div class="select-tile level-1 group" data-next="group"><p class="has-text-weight-bold">Sheet Cutting</p><p>Best for flat and bent sheet metal parts.</p></div>' +
          '<div class="select-tile level-1 group"><p class="has-text-weight-bold">CNC Machining</p></div>',
        group: () => tiles("select-material-group", "group", ["Metals", "Plastics"]),
        category: () => tiles("select-material-category", "category", ["Steel", "Aluminum"]),
        type: () => tiles("select-material-type", "type", ["5052 H32 Aluminum", "6061 T6 Aluminum", "6061 Aluminum"]),
        sku: () => '<div class="material_breadcrumbs"><span><a class="is-standalone editable">Categories</a></span><span><a class="is-standalone editable">Metals</a></span>' +
          '<span><a class="is-standalone editable">Aluminum</a></span><span><a class="is-standalone disabled">6061 T6 Aluminum</a></span></div>' +
          '<div class="material-skus"><div class="tile-container">' + cfg.thicknesses.map((t) =>
          '<div class="tile-sku quote-tile level-1 thickness' + (cfg.disabled.includes(t) ? ' is-disabled' : '') + '">' +
          '<label class="b-radio radio"><input type="radio" name="sku"' + (cfg.disabled.includes(t) ? ' disabled' : '') + '>' +
          '<span class="check"></span><span class="control-label"><p class="title is-5 mb-0">' + t + '</p></span></label></div>').join("") +
          '</div></div><div id="summary"></div>',
      };
      const next = { format: "group", group: "category", category: "type", type: "sku" };
      let step = cfg.start;
      const render = () => {
        dialog.innerHTML = '<div class="modal-card"><section class="modal-card-body">' + steps[step]() + '</section>' + footer + '</div>';
        dialog.querySelectorAll("input[type=radio]").forEach((input, index) => { input.value = "SKU-" + cfg.thicknesses[index]; });
      };
      let repriced = false;
      const summary = (qty, priced) => {
        const unit = repriced ? Number(cfg.unitPrice) : 12;
        const money = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById("summary").innerHTML = '<div class="post-processing-summary-container">' +
          '<span class="quantity__input"><input type="number" class="input" min="1" value="' + qty + '"></span>' +
          '<div class="price__each"><span class="currency"><span class="cash">' + (priced ? money(unit) : "$--") + '</span></span> <p class="caption is-inline">/ea</p></div>' +
          '<div class="subtotal__summary"><h4>Subtotal:</h4><span class="subtotal"><h3><span class="currency"><span class="cash">' + (priced ? money(unit * qty) : "$0.00") + '</span></span></h3></span></div>' +
          '<section class="est-ship-date"><p>Ships as soon as: <strong>Oct 28</strong></p></section></div>';
        document.querySelector(".quantity__input input").addEventListener("input", (event) => summary(Number(event.target.value) || 1, true));
      };
      dialog.addEventListener("click", (event) => {
        if (event.target.closest("#next")) { fetch("/api/cart", { method: "POST", body: "{}" }); return; }
        const tile = event.target.closest(".select-tile, .quote-tile:not(.thickness)");
        if (tile && next[step]) { step = next[step]; render(); }
      });
      dialog.addEventListener("change", (event) => {
        const input = event.target.closest("input[type=radio]");
        if (!input) return;
        dialog.querySelectorAll(".tile-sku").forEach((tile) => tile.classList.toggle("selected", tile.contains(input)));
        // An old-looking price stays up under Buefy's loading overlay while the quote reprices.
        summary(1, true);
        const overlay = document.createElement("div");
        overlay.className = "loading-overlay is-active";
        dialog.querySelector(".modal-card").appendChild(overlay);
        setTimeout(() => {
          repriced = true;
          overlay.remove();
          summary(Number(document.querySelector(".quantity__input input").value) || 1, true);
        }, 4500);
      });
      document.getElementById("cad").addEventListener("change", async (event) => {
        await fetch("/api/upload", { method: "POST", body: event.target.files[0] });
        setTimeout(render, 200);
      });
    </script></body></html>`;
}

async function approvedInput(): Promise<VendorQuoteAdapterInput> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-browser-")));
  tempDirs.push(dir);
  const cadPath = path.join(dir, "plate.step");
  await fs.copyFile(new URL("./fixtures/sendcutsend-sheet-plate-0125.step", import.meta.url), cadPath);
  const cadSha256 = await sha256File(cadPath);
  const input = {
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: cadSha256, drawingFileSha256: null },
    providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [1] },
    organizationId: "org-sendcutsend-browser",
    quoteRunId: "run-sendcutsend-browser",
    requestedQuantity: 1,
    cadFile: null,
    drawingFile: null,
    stagedCadFile: {
      originalName: "plate.step", localPath: cadPath, storageBucket: "evaluation-only",
      storagePath: "cad/plate.step", trustedContentSha256: cadSha256,
    },
    stagedDrawingFile: null,
    requirement: {
      material: "6061-T6 aluminum",
      spec_snapshot: { process: "sheet_laser_cutting", geometryFamily: "flat_sheet", sheetThicknessInch: 0.125 },
    },
  } as unknown as VendorQuoteAdapterInput;
  input.providerPortalApproval = buildExpectedProviderPortalApproval(buildSendCutSendSheetPortalDefinition(), input) ?? undefined;
  const authorized = await authorizeLiveEvaluationInput(input);
  if (!authorized) throw new Error("fixture authorization failed");
  return authorized;
}

const SYNTHETIC_SESSION = { cookies: [{ name: "synthetic", value: "session", domain: "app.sendcutsend.com", path: "/" }], origins: [] };

function config(storageState: unknown = SYNTHETIC_SESSION): WorkerConfig {
  return {
    workerMode: "live",
    workerLiveAdapters: ["sendcutsend"],
    workerTempDir: os.tmpdir(),
    browserTimeoutMs: 5_000,
    playwrightHeadless: true,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: false,
    vendorStorageStateJson: {
      sendcutsend: JSON.stringify(storageState),
    },
    vendorStorageStatePaths: {},
    vendorStorageStateDir: null,
  } as unknown as WorkerConfig;
}

type QuoteOptions = {
  /** The /users/current body; null serves no such endpoint (a 404). */
  currentUser?: string | null;
  storageState?: unknown;
};

async function quoteAgainst(page: string, options: QuoteOptions = {}) {
  const observed: LocalPortalObserved = { requests: [], uploads: [] };
  const currentUser = options.currentUser === undefined ? JSON.stringify({ id: 7, guest: false }) : options.currentUser;
  const pages: Record<string, string> = { "app.sendcutsend.com/customer": page };
  if (currentUser !== null) pages["app.sendcutsend.com/users/current"] = currentUser;
  vi.spyOn(chromium, "launch").mockImplementation(async () => createLocalPortalBrowser(browser, { pages }, observed));
  const definition = buildSendCutSendSheetPortalDefinition({
    processingWaitMs: 8_000, controlWaitMs: 3_000, priceWaitMs: 5_000, pollIntervalMs: 100,
    reclickAfterMs: 1_000, priceStableMs: 600, sessionSettleMs: 300, sessionWaitMs: 3_000,
  });
  const input = await approvedInput();
  const outcome = await runProviderPortalKernel(definition, config(options.storageState), input).then(
    (result) => ({ result, error: null }),
    (error: unknown) => ({ result: null, error: error as { payload: Record<string, unknown> } }),
  );
  return { ...outcome, observed, cad: await fs.readFile(input.stagedCadFile!.localPath) };
}

const timeout = PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS;

describe("SendCutSend sheet definition in a browser fixture (OVD-1056)", () => {
  it("walks the wizard to 6061-T6 at .125 and reads the summary price without touching the cart", async () => {
    const { result, error, observed, cad } = await quoteAgainst(wizardPage());
    expect(error).toBeNull();
    expect(result).toMatchObject({
      state: "offers_extracted",
      offers: [{
        providerOptionId: "ALU6061-125",
        quantity: 1,
        unitPriceUsd: 31.4,
        totalPriceUsd: 31.4,
        leadTimeBusinessDays: null,
        shipReceiveBy: "Oct 28",
        provenance: { priceSource: "selector", containerSelector: ".post-processing-summary-container" },
      }],
    });
    expect(observed.uploads).toEqual([cad]);
    expect(observed.requests.some((request) => request.includes("/api/cart"))).toBe(false);
    expectOnlyHostContacted(observed, "app.sendcutsend.com");
  }, timeout);

  it("starts from the material group when the wizard skips the production method", async () => {
    const { result, error } = await quoteAgainst(wizardPage({ start: "group", unitPrice: "1204.10" }));
    expect(error).toBeNull();
    expect(result).toMatchObject({ state: "offers_extracted", offers: [{ unitPriceUsd: 1204.1, totalPriceUsd: 1204.1 }] });
  }, timeout);

  it("stops in configuration_required when .125 is not offered, without picking another thickness", async () => {
    const { result, error, observed } = await quoteAgainst(wizardPage({ thicknesses: [".100", ".187"] }));
    expect(result).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "configuration_required", reason: "sendcutsend_thickness_not_offered" } });
    expect(observed.uploads).toHaveLength(1);
    expect(observed.requests.some((request) => request.includes("/api/cart"))).toBe(false);
  }, timeout);

  it("stops in configuration_required when .125 is disabled for the part", async () => {
    const { error } = await quoteAgainst(wizardPage({ disabled: [".125"] }));
    expect(error).toMatchObject({ payload: { terminalState: "configuration_required", reason: "sendcutsend_thickness_unavailable" } });
  }, timeout);

  it("proceeds when the signed-in header keeps a hidden sign-in link in the DOM", async () => {
    const { result, error } = await quoteAgainst(wizardPage({
      header: `<span>Account</span><a href="#" class="login link" style="display:none">LOGIN</a>`,
    }));
    expect(error).toBeNull();
    expect(result).toMatchObject({ state: "offers_extracted" });
  }, timeout);

  it.each([
    ["on its own line", `<div><a href="#" class="login link">LOGIN</a></div>`],
    ["inline with other header items", `<a href="#" class="login link">LOGIN</a>`],
  ])("stops before upload when the logged-out LOGIN link shows %s", async (_label, header) => {
    const { result, error, observed } = await quoteAgainst(wizardPage({ header }));
    const stop = result ?? error?.payload;
    expect(stop).toMatchObject({ providerMutationPossible: false });
    expect(result?.state ?? error?.payload.terminalState).toBe("login_required");
    expect(result?.reason ?? error?.payload.reason).toBe("sendcutsend_signed_out");
    expect(observed.uploads).toEqual([]);
  }, timeout);
  // OVD-1056 review: a rendered header without a LOGIN link is not proof of a session.
  it.each([
    ["a guest user", JSON.stringify({ id: 7, guest: true })],
    ["a user without an explicit guest flag", JSON.stringify({ id: 1 })],
    ["no current user", "null"],
    ["a failed lookup", null],
  ])("stops before upload when the app reports %s", async (_label, currentUser) => {
    const { result, error, observed } = await quoteAgainst(wizardPage(), { currentUser });
    expect(result?.state ?? error?.payload.terminalState).toBe("login_required");
    expect(result?.reason ?? error?.payload.reason).toBe("sendcutsend_session_unconfirmed");
    expect(result ?? error?.payload).toMatchObject({ providerMutationPossible: false });
    expect(observed.uploads).toEqual([]);
  }, timeout);

  it("keeps CDN requests credential-free when the saved session had a parent-domain cookie", async () => {
    const saved = filterSendCutSendStorageState({
      cookies: [{ name: "_scs_session", value: "session", domain: ".sendcutsend.com", path: "/" }],
      origins: [],
    });
    const { result, error, observed } = await quoteAgainst(wizardPage({
      head: `<link rel="stylesheet" href="https://cdn.sendcutsend.com/app.css"><link rel="preload" as="image" href="https://cdn.sendcutsend.com/logo.png">`,
    }), { storageState: saved.state });
    expect(error).toBeNull();
    expect(result).toMatchObject({ state: "offers_extracted" });
    expect(observed.requests.some((request) => request.startsWith("GET https://cdn.sendcutsend.com/"))).toBe(true);
  }, timeout);

  it("refuses an unfiltered saved session that still holds a parent-domain cookie, before any upload", async () => {
    const { result, error, observed } = await quoteAgainst(wizardPage(), {
      storageState: { cookies: [{ name: "_scs_session", value: "session", domain: ".sendcutsend.com", path: "/" }], origins: [] },
    });
    expect(result).toBeNull();
    expect(error?.payload).toMatchObject({
      terminalState: "missing_session", reason: "missing_storage_state", providerInteractionAttempted: false,
    });
    expect(observed.requests).toEqual([]);
    expect(observed.uploads).toEqual([]);
  }, timeout);
});
