// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  createLocalPortalBrowserSession,
  localQuotePage,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
} from "../../test-support/localPortalBrowserFixture";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { buildQuickpartsProductionPortalDefinition, QUICKPARTS_PRODUCTION_LOCATORS } from "./quickpartsPortal";

// Real Chromium, synthetic dispatch authorization and locally answered requests.
// The production Quickparts definition itself still has no cleanup hook.
let cleanupRow = ".row";
let uploadedRows = false;
beforeEach(() => { cleanupRow = ".row"; uploadedRows = false; });
const session = createLocalPortalBrowserSession({
  vendor: "quickparts",
  host: "quickquote.quickparts.com",
  pagePath: "/",
  cadBytes: "synthetic OVD-1022 cleanup regression bytes",
  cookieDomain: ".quickquote.quickparts.com",
  tempPrefix: "portal-cleanup-browser-",
  locators: QUICKPARTS_PRODUCTION_LOCATORS,
  buildDefinition: () => {
    const definition = buildQuickpartsProductionPortalDefinition();
    return {
      ...definition,
      selectors: { ...definition.selectors, cleanupRow, cleanupRowFileName: ":scope > .fname",
        cleanup: { removePart: { selector: ":scope > button.remove", scope: ".row", uploadedRows } } },
      hooks: { ...definition.hooks, cleanup: async (cleanup) => {
        await cleanup.click("removePart", "part.step");
        // Deliberately untrustworthy: DOM evidence must override these counts.
        return { removed: 1, remaining: 0 };
      } },
    };
  },
  bindAuthorization: (binding) => {
    const envelope = quickpartsDispatchEnvelope(binding);
    return { envelope, authorization: quickpartsDispatchAuthorization(envelope) };
  },
});

function row(name: string): string {
  return `<div class="row"><span class="fname">${name}</span><button class="remove">Remove</button></div>`;
}

function page(customerName: string, uploadName: string, captureRerender = false, nestCustomer = false): string {
  return localQuotePage({
    title: "QuickQuote",
    before: row(customerName),
    afterUpload: row(uploadName) + session.optionCard({
      id: "standard", label: "Standard", quantity: "3", unit: "10.00", total: "30.00", lead: "5",
    }),
    extraHead: `<script>
      document.addEventListener('click', (event) => {
        const button = event.target.closest('button.remove');
        if (!button) return;
        const selected = button.closest('.row');
        const name = selected.querySelector('.fname').textContent;
        fetch('/clicked?name=' + encodeURIComponent(name));
        if (confirm('Delete ' + name + '?')) {
          for (const removed of [selected, ...selected.querySelectorAll('.row')]) {
            fetch('/deleted?name=' + encodeURIComponent(removed.querySelector('.fname').textContent));
          }
          selected.remove();
        }
      });
      ${nestCustomer ? `new MutationObserver(() => {
        const rows = [...document.querySelectorAll('.row')];
        const uploaded = rows.find(row => row.querySelector('.fname').textContent === 'part.step');
        const customer = rows.find(row => row.querySelector('.fname').textContent === 'other.step');
        if (uploaded && customer && !uploaded.contains(customer)) uploaded.append(customer);
      }).observe(document.documentElement, { childList: true, subtree: true });` : ''}
      ${captureRerender ? `document.addEventListener('click', (event) => {
        if (!event.target.closest('button.remove')) return;
        const rows = [...document.querySelectorAll('.row')];
        // Model a capture-phase/index-keyed rerender: the old target is detached,
        // the wrong item disappears, and the selected filename survives.
        const replacement = rows.find(row => row.querySelector('.fname').textContent === 'part.step').cloneNode(true);
        rows.forEach(row => row.remove());
        document.querySelector('main').append(replacement);
      }, { capture: true, once: true });` : ''}
    </script>`,
  });
}

function adversarialPage(mutation: string, click: string, customerName = "other.step", cart = false): string {
  return localQuotePage({
    title: "QuickQuote", before: cart ? `<div id="cart">${row(customerName)}</div>` : row(customerName),
    afterUpload: row("part.step") + session.optionCard({
      id: "standard", label: "Standard", quantity: "3", unit: "10.00", total: "30.00", lead: "5",
    }),
    extraHead: `<script>
      let prepared = false;
      new MutationObserver(() => {
        const rows = [...document.querySelectorAll('.row')];
        const uploaded = rows.find(row => row.querySelector('.fname').textContent === 'part.step');
        const customer = rows.find(row => row !== uploaded);
        if (prepared || !uploaded || !customer) return;
        prepared = true;
        ${mutation}
      }).observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener('click', (event) => {
        if (!event.target.closest('button.remove')) return;
        fetch('/clicked?name=part.step');
        ${click}
      });
    </script>`,
  });
}

describe("row ownership and post-click evidence in Chromium (OVD-1022)", () => {
  it.each([false, true])("refuses a customer row hidden in an owned iframe (uploadedRows: %s)", async (owned) => {
    uploadedRows = owned;
    const html = adversarialPage(`
      const frame = uploaded.appendChild(document.createElement('iframe'));
      frame.contentDocument.body.append(customer);
      navigator.sendBeacon('/prepared?connected=' + customer.isConnected + '&framed=' +
        (customer.ownerDocument === frame.contentDocument));
    `, `
      const selected = event.target.closest('.row');
      if (confirm('Delete part.step?')) {
        for (const frame of selected.querySelectorAll('iframe')) {
          for (const row of frame.contentDocument.querySelectorAll('.row')) {
            navigator.sendBeacon('/deleted?name=' + row.querySelector('.fname').textContent);
          }
        }
        selected.remove();
      }
    `);
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(observed.uploads).toHaveLength(1);
    expect(observed.requests.some((request) => request.includes('/prepared?connected=true&framed=true'))).toBe(true);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([false, true])("rejects a nested pre-upload identity that no longer matches a structural selector (uploadedRows: %s)", async (owned) => {
    cleanupRow = "#cart > .row";
    uploadedRows = owned;
    const html = adversarialPage(`
      document.querySelector('#cart').append(uploaded);
      uploaded.append(customer);
      navigator.sendBeacon('/prepared?matches=' + customer.matches('#cart > .row'));
    `, `
      const selected = event.target.closest('.row');
      if (confirm('Delete part.step?')) {
        for (const row of [selected, ...selected.querySelectorAll('.row')]) {
          navigator.sendBeacon('/deleted?name=' + row.querySelector('.fname').textContent);
        }
        selected.remove();
      }
    `, "other.step", true);
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(observed.uploads).toHaveLength(1);
    expect(observed.requests.some((request) => request.includes('/prepared?matches=false'))).toBe(true);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([false, true])("names a pre-upload row lost during the click (in a frame: %s)", async (framed) => {
    const html = adversarialPage(framed ? `
      const frame = document.querySelector('main').appendChild(document.createElement('iframe'));
      frame.id = 'customer-frame';
      frame.contentDocument.body.append(customer);
    ` : "", `
      if (confirm('Delete part.step?')) {
        ${framed ? "document.querySelector('#customer-frame').remove();" : "document.querySelector('.row').remove();"}
        event.target.closest('.row').remove();
        navigator.sendBeacon('/deleted?name=other.step');
      }
    `);
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(observed.requests.some((request) => request.includes('/clicked?'))).toBe(true);
    expect(observed.requests.some((request) => request.includes('/deleted?name=other.step'))).toBe(true);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
      lostPreUploadRows: [{ fileName: "other.step" }],
    });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["open", false, true], ["closed", false, true],
    ["open", true, true], ["closed", true, true],
    ["open", false, false], ["closed", false, false],
  ])("refuses %s shadow roots (descendant host: %s, nested customer: %s)", async (mode, descendant, nested) => {
    const html = adversarialPage(`
      const host = ${descendant ? "uploaded.appendChild(document.createElement('div'))" : "uploaded"};
      const shadow = host.attachShadow({ mode: '${mode}' });
      shadow.append(document.createElement('slot'));
      ${nested ? "shadow.append(customer);" : ""}
      uploaded.querySelector('button').addEventListener('click', () => {
        fetch('/deleted?name=part.step');
        ${nested ? "fetch('/deleted?name=other.step');" : ""}
        uploaded.remove();
      });`, "");
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(observed.uploads).toHaveLength(1);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each(["none", "same-name", "quoted-name"])("refuses an owned row inside a customer row (%s dialog)", async (dialog) => {
    uploadedRows = true;
    const html = adversarialPage(`
      customer.append(uploaded);
      for (const row of [customer, uploaded]) row.addEventListener('click', () => {
        const name = row.querySelector(':scope > .fname').textContent;
        fetch('/clicked?name=' + encodeURIComponent(name));
        if (${dialog === "none" ? "true" : dialog === "same-name" ? "confirm('Delete part.step?')" : "confirm('Delete ' + name + '?')"}) {
          fetch('/deleted?name=' + encodeURIComponent(name));
          row.remove();
        }
      });`, "", dialog === "quoted-name" ? "'part.step'" : "other.step");
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each(["open", "closed"])("refuses a declarative %s root that bypasses attachShadow", async (mode) => {
    // Element.setHTMLUnsafe does not attach declarative roots in the pinned Chromium, so parse the row in
    // its own document (the HTML parser attaches the root) and adopt it, shadow root included.
    const html = adversarialPage(`
      const parsed = Document.parseHTMLUnsafe('<div class="row"><span class="fname">part.step</span>' +
        '<button class="remove">Remove</button><template shadowrootmode="${mode}"><slot></slot>' +
        '<div class="row"><span class="fname">hidden.step</span></div></template></div>');
      uploaded.replaceWith(document.adoptNode(parsed.body.firstElementChild));
    `, "fetch('/deleted?name=hidden.step'); event.target.closest('.row').remove();");
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("dismisses a second matching native dialog during the same click", async () => {
    const html = adversarialPage("", `
      // A fetch issued just before the next blocking confirm() can be lost when the page is torn down; a
      // beacon is queued for delivery either way, so the accepted first dialog is always observable.
      if (confirm('Delete part.step?')) navigator.sendBeacon('/accepted?dialog=first');
      if (confirm('Delete part.step?')) {
        fetch('/deleted?name=other.step');
        document.querySelector('.row').remove();
      }
    `);
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => request.includes('/accepted?'))).toHaveLength(1);
    expect(observed.requests.filter((request) => request.includes('/deleted?'))).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each(["'", '"'])("rejects a prompt naming another row whose filename contains %s quotes", async (quote) => {
    uploadedRows = true;
    const customerName = `${quote}part.step${quote}`;
    const html = adversarialPage("", `
      if (confirm(${JSON.stringify(`Delete ${customerName}?`)})) {
        fetch('/deleted?name=customer');
        document.querySelector('.row').remove();
      }
    `, customerName);
    const { output, error, observed } = await session.quoteAgainst(html);
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => request.includes('/deleted?'))).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([
    ["main >> .row", false], ["main >> .row", true],
    ["css=.row", false], ["css=.row", true],
    ["xpath=//main//div[@class='row']", false],
  ])("preserves row-bound removal with Playwright selector %s (uploadedRows: %s)", async (selector, owned) => {
    cleanupRow = selector;
    uploadedRows = owned;
    const { output, error, observed } = await session.quoteAgainst(page("other.step", "part.step"));
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({ status: "removed", removed: 1, remaining: 0 });
    expect(observed.requests.filter((request) => request.includes('/deleted?')))
      .toEqual(["GET https://quickquote.quickparts.com/deleted?name=part.step"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("never clicks the owned row when it contains a pre-existing customer row", async () => {
    const { output, error, observed } = await session.quoteAgainst(page("other.step", "part.step", false, true));
    expect(error).toBeNull();
    expect(observed.uploads).toHaveLength(1);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("never clicks the customer's part.step when upload creates part (1).step", async () => {
    const { output, error, observed } = await session.quoteAgainst(page("part.step", "part (1).step"));
    expect(error).toBeNull();
    expect(observed.uploads).toHaveLength(1);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
      manualCleanupRows: [{ fileName: "part (1).step" }],
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("removes only the uniquely owned row through its filename-bound native dialog", async () => {
    const { output, error, observed } = await session.quoteAgainst(page("other.step", "part.step"));
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({ status: "removed", removed: 1, remaining: 0 });
    expect(observed.requests.filter((request) => request.includes("/deleted?")))
      .toEqual(["GET https://quickquote.quickparts.com/deleted?name=part.step"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("does not claim removal after a capture-phase rerender deletes the wrong row", async () => {
    const { output, error } = await session.quoteAgainst(page("other.step", "part.step", true));
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
});
