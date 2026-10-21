// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createLocalPortalBrowserSession,
  registerSharedPortalBrowserRefusals,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
} from "../../test-support/localPortalBrowserFixture";
import { oshcutDispatchAuthorization, oshcutDispatchEnvelope } from "../../test-support/oshcutDispatchFixture";
import { buildOshcutProductionPortalDefinition, OSHCUT_PRODUCTION_MATERIAL_LABEL } from "./oshcutProductionPortal";

/**
 * OVD-677 browser fixture: drives the production OSH Cut definition through
 * the real portal kernel and a real Chromium against a synthetic cart served
 * for https://app.oshcut.com/cart. Every request is answered locally or
 * aborted; nothing reaches the network. The page mirrors the authenticated
 * capture of 2026-10-15 (cart row, material slideover with filter
 * checkboxes, price cells that read `-` until material and thickness are set);
 * it is not the live portal.
 */

const session = createLocalPortalBrowserSession({
  vendor: "oshcut",
  host: "app.oshcut.com",
  pagePath: "/cart",
  cadBytes: "synthetic oshcut cad bytes for the browser fixture",
  cookieDomain: "app.oshcut.com",
  tempPrefix: "oshcut-browser-",
  buildDefinition: () => buildOshcutProductionPortalDefinition({ controlWaitMs: 3_000, priceWaitMs: 1_500 }),
  bindAuthorization: (binding) => {
    const envelope = oshcutDispatchEnvelope(binding);
    return { envelope, authorization: oshcutDispatchAuthorization(envelope) };
  },
  extraInput: {
    requirement: {
      material: "Aluminum 6061-T6",
      spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet", sheetThicknessInch: 0.125 },
    },
  } as never,
});

type CartPageOptions = {
  header?: string;
  before?: string;
  afterUpload?: string;
  fileInput?: boolean;
  materials?: string[];
  thicknesses?: string[];
  /** Fixed cell texts once priced; by default extended = unit × quantity input. */
  single?: string;
  extended?: string;
  /** Leaves both cells at `-` even after configuration. */
  neverPriced?: boolean;
  /** Omits the price cells entirely. */
  noPriceCells?: boolean;
  extraHead?: string;
  /** How the part row's remove control behaves; `none` renders no control. */
  remove?: "immediate" | "native_confirm" | "modal_confirm" | "none";
};

function cartPage(options: CartPageOptions = {}): string {
  const config = JSON.stringify({
    afterUpload: options.afterUpload ?? "",
    materials: options.materials ?? ["5052 H32 Aluminum", OSHCUT_PRODUCTION_MATERIAL_LABEL],
    thicknesses: options.thicknesses ?? ['0.090"', '0.125"'],
    single: options.single ?? "$411.50",
    extended: options.extended ?? null,
    neverPriced: options.neverPriced === true,
    noPriceCells: options.noPriceCells === true,
    remove: options.remove ?? "immediate",
  });
  const fileInput = options.fileInput === false ? "" : `<input type="file" id="cad" accept=".dxf,.step">`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>OSH Cut</title>${options.extraHead ?? ""}</head><body>
    <header>${options.header ?? "<span>OSH Cut</span> <span>Account</span>"}</header>
    <main>${options.before ?? "<p>Drop parts here for instant pricing.</p>"}${fileInput}<div id="cart"></div><div id="note"></div></main>
    <script>
      const config = ${config};
      const cad = document.getElementById("cad");
      const selected = new Set();
      const cells = (text) => config.noPriceCells ? "" :
        '<span class="cartSinglePrice">' + text + '</span><span class="cartExtendedPrice">' + text + '</span>';
      const filter = (label) => '<label class="filterItem"><input type="checkbox"> ' + label + '</label>';
      const price = () => {
        const quantity = Number(document.querySelector(".cartQuantity input.input").value);
        const unit = Number(config.single.replace(/[^0-9.]/g, ""));
        document.querySelector(".cartSinglePrice").textContent = config.single;
        document.querySelector(".cartExtendedPrice").textContent = config.extended
          ?? "$" + (unit * quantity).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      };
      const maybeCommit = () => {
        if (!selected.has(${JSON.stringify(OSHCUT_PRODUCTION_MATERIAL_LABEL)}) || !selected.has('0.125"')) return;
        document.querySelector(".Slideover").remove();
        document.querySelector(".cartInformationArea .error.link").outerHTML = "<span>6061 T6 Aluminum 0.125&quot;</span>";
        if (!config.neverPriced && !config.noPriceCells) setTimeout(price, 400);
      };
      const openSlideover = () => {
        const panel = document.createElement("div");
        panel.className = "Slideover";
        panel.innerHTML = "<h1>Select Material - part.step</h1>"
          + config.materials.map(filter).join("") + config.thicknesses.map(filter).join("");
        panel.addEventListener("change", (event) => {
          const label = event.target.closest(".filterItem").textContent.trim();
          if (event.target.checked) selected.add(label); else selected.delete(label);
          maybeCommit();
        });
        document.body.appendChild(panel);
      };
      const removeRow = () => {
        document.querySelector(".cartRow").remove();
        fetch("/api/cart-part", { method: "DELETE" }).catch(() => undefined);
      };
      const onRemove = () => {
        if (config.remove === "native_confirm") { if (confirm("Remove this part?")) removeRow(); return; }
        if (config.remove === "modal_confirm") {
          setTimeout(() => {
            const modal = document.createElement("div");
            modal.setAttribute("role", "dialog");
            modal.innerHTML = "<p>Remove this part?</p><button>Cancel</button><button>Delete</button>";
            modal.querySelectorAll("button")[1].addEventListener("click", () => { modal.remove(); removeRow(); });
            document.body.appendChild(modal);
          }, 150);
          return;
        }
        removeRow();
      };
      if (cad) cad.addEventListener("change", async () => {
        await fetch("/api/upload", { method: "POST", body: cad.files[0] });
        history.pushState({}, "", "/cart/O-0b6c1f2e-1111-4a2b-8c3d-000000000001/P-0b6c1f2e-2222-4a2b-8c3d-000000000002");
        setTimeout(() => {
          document.getElementById("cart").innerHTML = '<div class="cartRow">'
            + '<div class="cartInformationArea">part.step <span class="error link">Select material</span></div>'
            + '<div class="cartQuantity"><input class="input" type="text" value="1"></div>'
            + cells("-")
            + (config.remove === "none" ? "" : '<button class="removeButton" aria-label="Remove part">&times;</button>')
            + "</div>";
          document.querySelector(".cartInformationArea .error.link").addEventListener("click", openSlideover);
          document.querySelector("#cart .removeButton")?.addEventListener("click", onRemove);
          document.getElementById("note").innerHTML = config.afterUpload;
        }, 300);
      });
    </script></body></html>`;
}

describe("OSH Cut production portal definition in a browser fixture (OVD-677)", () => {
  it("configures material and thickness, waits out '-', and returns the anchored USD cart price", async () => {
    const { output, error, observed } = await session.quoteAgainst(cartPage());
    expect(error).toBeNull();
    expect(output).toMatchObject({
      vendor: "oshcut",
      status: "instant_quote_received",
      unitPriceUsd: 411.5,
      totalPriceUsd: 1234.5,
      leadTimeBusinessDays: null,
      rawPayload: {
        executionContext: "production_dispatch",
        adapterRevision: "oshcut-production-adapter.v2",
        terminalState: "offers_extracted",
        quoteOnly: true,
        orderProhibited: true,
      },
    });
    expect(output!.offers!.map((offer) => [offer.providerOptionId, offer.unitPriceUsd, offer.totalPriceUsd]))
      .toEqual([["cart", 411.5, 1234.5]]);
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([session.cadBytes]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["a non-USD amount", { single: "€411.50", extended: "€1,234.50" }],
    ["an extended price that disagrees with single times quantity", { extended: "$1,300.00" }],
    ["an extended price for another quantity", { extended: "$411.50" }],
  ])("withholds the offer when the cart shows %s", async (_name, change) => {
    const { output, error } = await session.quoteAgainst(cartPage(change));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "selector_failure", payload: { terminalState: "selector_drift", reason: "anchored_offer_not_found" } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("never parses '-': a price still pending at the bound stops in selector drift", async () => {
    const { output, error } = await session.quoteAgainst(cartPage({ neverPriced: true }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason: "oshcut_price_pending", providerMutationPossible: true } });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["the 6061 T6 Aluminum filter", { materials: ["5052 H32 Aluminum"] }, "oshcut_material_option_missing"],
    ["the requested thickness filter", { thicknesses: ['0.090"', '0.1250" (custom)'] }, "oshcut_thickness_option_missing"],
  ])("stops rather than quote a portal default when %s is missing", async (_name, change, reason) => {
    const { output, error, observed } = await session.quoteAgainst(cartPage(change));
    expect(output).toBeNull();
    expect(error).toMatchObject({ payload: { terminalState: "selector_drift", reason, providerMutationPossible: true } });
    expect(observed.uploads).toHaveLength(1);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("ends a logged-out cart (header Sign In control) as login required without uploading", async () => {
    const { output, error, observed } = await session.quoteAgainst(cartPage({ header: "<span>OSH Cut</span><button>Sign In</button>" }));
    expect(output).toBeNull();
    expect(error).toMatchObject({ code: "login_required", payload: { terminalState: "login_required", providerMutationPossible: false } });
    expect(observed.uploads).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  // Standing rule (2026-10-15): the uploaded test part leaves the cart once
  // the price is read, and after a failure that followed upload.
  const removedFromCart = (requests: string[]) =>
    requests.filter((request) => request === "DELETE https://app.oshcut.com/api/cart-part").length;

  it.each(["immediate", "native_confirm", "modal_confirm"] as const)(
    "removes the uploaded part from the cart after reading the price (%s remove)",
    async (remove) => {
      const { output, error, observed } = await session.quoteAgainst(cartPage({ remove }));
      expect(error).toBeNull();
      expect(output).toMatchObject({
        totalPriceUsd: 1234.5,
        rawPayload: { cartCleanup: { status: "removed", removed: 1, remaining: 0 } },
      });
      expect(removedFromCart(observed.requests)).toBe(1);
    },
    PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  );

  it("preserves pre-existing exact and substring filename collisions", async () => {
    const before = ["part.step", "customer-part.step"].map((name) =>
      `<div><div class="cartInformationArea">${name}</div><button class="removeButton"
        onclick="fetch('/api/customer-part', {method: 'DELETE'}); this.parentElement.remove()">Remove</button></div>`,
    ).join("");
    const { output, error, observed } = await session.quoteAgainst(cartPage({ before }));
    expect(error).toBeNull();
    expect(output).toMatchObject({ rawPayload: { cartCleanup: { status: "removed", removed: 1, remaining: 0 } } });
    expect(removedFromCart(observed.requests)).toBe(1);
    expect(observed.requests).not.toContain("DELETE https://app.oshcut.com/api/customer-part");
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("still removes the uploaded part when the attempt fails after upload, keeping the failure", async () => {
    const { output, error, observed } = await session.quoteAgainst(cartPage({ neverPriced: true }));
    expect(output).toBeNull();
    expect(error).toMatchObject({
      payload: {
        terminalState: "selector_drift",
        reason: "oshcut_price_pending",
        cartCleanup: { status: "removed", removed: 1, remaining: 0 },
      },
    });
    expect(removedFromCart(observed.requests)).toBe(1);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("logs a cleanup that cannot find the remove control without changing the quote", async () => {
    const { output, error, observed } = await session.quoteAgainst(cartPage({ remove: "none" }));
    expect(error).toBeNull();
    expect(output).toMatchObject({
      status: "instant_quote_received",
      totalPriceUsd: 1234.5,
      rawPayload: { cartCleanup: { status: "incomplete", removed: 0, remaining: 1 } },
    });
    expect(removedFromCart(observed.requests)).toBe(0);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("does not attempt cleanup when nothing was uploaded", async () => {
    const { error, observed } = await session.quoteAgainst(cartPage({ header: "<span>OSH Cut</span><button>Sign In</button>" }));
    expect(error).toMatchObject({ payload: { terminalState: "login_required" } });
    expect((error!.payload as Record<string, unknown>).cartCleanup).toBeUndefined();
    expect(removedFromCart(observed.requests)).toBe(0);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  registerSharedPortalBrowserRefusals(session, {
    missingCards: cartPage({ noPriceCells: true, afterUpload: "<p>Total: $25.00 in 7 days</p>" }),
    missingCad: cartPage({ fileInput: false }),
    login: cartPage({ before: "<h1>Session expired</h1><p>Please log in again.</p>" }),
    captcha: cartPage({ before: "<p>Please verify you are human</p>" }),
    maintenance: cartPage({ before: "<p>The quoting app is under maintenance</p>" }),
    engineeringReview: cartPage({ afterUpload: "<p>Your part needs a manual review by our engineers.</p>" }),
    thirdParty: cartPage({ extraHead: "<script src=\"https://cdn.example.com/tracker.js\"></script>" }),
  });
});
